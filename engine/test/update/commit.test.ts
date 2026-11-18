// v2.6 §5.4 (E1b) the update gate, the hold driving it, `update_ready` once per idle stretch, the VACUUM INTO backup.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateBusy } from '../../../shared/update.ts';
import { insertOutbox, openDb, type Db } from '../../src/db.ts';
import { backupState, UpdateGate } from '../../src/update/commit.ts';
import { sessionsBusy, UpdateHold } from '../../src/update/hold.ts';

const LANE: UpdateBusy = { projectId: 'p', kind: 'lane', name: 'l1', turnStartedAt: 500 };
const A = { id: 'app' };

test('§5.4-1/3 held: writes closed, a spawn is deferred; release runs deferred spawns in order, then `opened`', () => {
  const log: string[] = [];
  const gate = new UpdateGate(() => log.push('opened'));
  expect(gate.writes).toBe(true);
  expect(gate.defer('s1', () => log.push('never'))).toBe(false); // not held: the caller spawns now
  gate.hold(true);
  expect(gate.writes).toBe(false);
  expect(gate.defer('s1', () => log.push('spawn s1'))).toBe(true);
  expect(gate.defer('s2', () => log.push('spawn s2'))).toBe(true);
  expect(log).toEqual([]);
  gate.hold(false);
  expect(log).toEqual(['spawn s1', 'spawn s2', 'opened']);
  gate.hold(false); // not held: nothing runs twice
  expect(log).toEqual(['spawn s1', 'spawn s2', 'opened']);
  expect(gate.writes).toBe(true);
});

test('§5.4-9 seal: only while held; controls closed until the release', () => {
  const gate = new UpdateGate();
  gate.seal();
  expect(gate.controls).toBe(true);
  gate.hold(true);
  gate.seal();
  expect(gate.controls).toBe(false);
  gate.hold(false);
  expect(gate.controls).toBe(true);
});

test('§5.4-4 busy adds the running spawns once per session; a deferred spawn is not busy (R11)', () => {
  const gate = new UpdateGate();
  const k1 = {}; const k2 = {};
  gate.hold(true);
  gate.defer('later', () => {});
  gate.spawnBegan(k1, LANE);
  gate.spawnBegan(k2, { projectId: 'q', kind: 'orchestrator', name: 's9', turnStartedAt: 7 });
  const lanes = { listAll: () => [{ projectId: 'p', name: 'l1', turnStartedAt: 600 }] };
  const orchs = { all: () => [] };
  expect(sessionsBusy(lanes, orchs, gate.spawning())).toEqual([
    { projectId: 'p', kind: 'lane', name: 'l1', turnStartedAt: 600 },
    { projectId: 'q', kind: 'orchestrator', name: 's9', turnStartedAt: 7 },
  ]);
  gate.spawnEnded(k1); gate.spawnEnded(k2);
  expect(gate.spawning()).toEqual([]);
});

function world() {
  const st = { busy: [LANE] as UpdateBusy[], ready: [] as object[], ok: true, t: 0 };
  const gate = new UpdateGate();
  const hold = new UpdateHold<object>({
    gate, busy: () => st.busy, held: () => 0, changed: () => {}, tickMs: 0, now: () => st.t,
    ready: (c) => { st.ready.push(c); if (!st.ok) throw new Error('backup failed'); },
  });
  return { hold, gate, st };
}

test('§5.4 the hold drives the gate: on → held; holder WS closes → released', () => {
  const { hold, gate } = world();
  hold.on(A);
  expect(gate.writes).toBe(false);
  hold.closed(A);
  expect(gate.writes).toBe(true);
});

test('§5.4-5 update_ready once busy is empty, once per idle stretch; a turn starting again re-arms it; a failed backup retries after 30 s', () => {
  const { hold, st } = world();
  hold.on(A);
  expect(st.ready).toEqual([]);
  st.busy = [];
  hold.refresh();
  hold.refresh();
  expect(st.ready).toEqual([A]);
  st.busy = [LANE]; hold.refresh(); // a self-started turn after update_ready
  st.busy = []; st.ok = false; hold.refresh(); hold.refresh(); // backup failed → not again within 30 s
  expect(st.ready).toEqual([A, A]);
  st.ok = true; st.t += 30_000; hold.refresh(); hold.refresh();
  expect(st.ready).toEqual([A, A, A]);
});

test('§5.4-9 commit ok seals the gate; commit busy does not; the release unseals', () => {
  const { hold, gate, st } = world();
  hold.on(A);
  expect(hold.commit(A)).toEqual({ ok: false, busy: [LANE] });
  expect(gate.controls).toBe(true);
  st.busy = [];
  expect(hold.commit(A)).toEqual({ ok: true });
  expect(gate.controls).toBe(false);
  hold.off(A);
  expect(gate.controls).toBe(true);
});

let tmp: string; let db: Db;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'commit-')); db = openDb(join(tmp, 'state.db')); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

test('§5.4-5 VACUUM INTO backups/state-<version>-<yyyymmdd-hhmm>.db: a readable copy; the newest 3 stay', () => {
  insertOutbox(db, { sessionId: 's', text: 'giữ tôi', prefix: null });
  const dir = join(tmp, 'backups');
  const at = (min: number) => new Date(2026, 10, 18, 9, min);
  const first = backupState(db, { dir, version: '0.3.0', now: at(1) });
  expect(first).toBe(join(dir, 'state-0.3.0-20261118-0901.db'));
  const copy = openDb(first);
  expect(copy.query<{ text: string }, []>('SELECT text FROM outbox').all().map((r) => r.text)).toEqual(['giữ tôi']);
  copy.close();
  for (const m of [2, 3, 4]) backupState(db, { dir, version: '0.3.0', now: at(m) });
  expect(backupState(db, { dir, version: '0.3.0', now: at(4) })).toBe(join(dir, 'state-0.3.0-20261118-0904.db')); // same minute: replaced
  expect(readdirSync(dir).filter((f) => f.endsWith('.db')).sort()).toEqual([
    'state-0.3.0-20261118-0902.db', 'state-0.3.0-20261118-0903.db', 'state-0.3.0-20261118-0904.db',
  ]);
  expect(existsSync(first)).toBe(false);
});

test('§5.4-9 (A1 contract) a busy commit re-arms update_ready: the turn ends before any refresh saw it → ready again', () => {
  const { hold, st } = world();
  hold.on(A);
  st.busy = []; hold.refresh();
  expect(st.ready).toEqual([A]);
  st.busy = [LANE]; // a self-started turn after update_ready, between two ticks
  expect(hold.commit(A)).toEqual({ ok: false, busy: [LANE] });
  st.busy = []; hold.refresh();
  expect(st.ready).toEqual([A, A]);
});

test('§5.5-4 (R22) `committed` runs once on a commit ok (before the ack), never on a busy one', () => {
  const st = { busy: [LANE] as UpdateBusy[], committed: 0 };
  const hold = new UpdateHold<object>({ busy: () => st.busy, held: () => 0, changed: () => {}, tickMs: 0, committed: () => { st.committed++; } });
  hold.on(A);
  hold.commit(A);
  expect(st.committed).toBe(0);
  st.busy = [];
  expect(hold.commit(A)).toEqual({ ok: true });
  expect(st.committed).toBe(1);
});
