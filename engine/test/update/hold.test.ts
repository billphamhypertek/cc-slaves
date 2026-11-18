// v2.6 §5.4 the update hold (E1a): one holder connection, `busy`, release when that connection closes, `engine.update`.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateBusy } from '../../../shared/update.ts';
import { insertOutbox, openDb, type Db } from '../../src/db.ts';
import { UpdateGate } from '../../src/update/commit.ts';
import { heldSince, sessionsBusy, UpdateHold } from '../../src/update/hold.ts';

function world(busy: UpdateBusy[] = [], held = 0) {
  const st = { busy, held, changes: 0, t: 1_000 };
  const hold = new UpdateHold({ busy: () => st.busy, held: () => st.held, changed: () => { st.changes++; }, now: () => st.t, tickMs: 0 });
  return { hold, st };
}
const A = { id: 'app' };
const B = { id: 'web' };
const LANE: UpdateBusy = { projectId: 'p', kind: 'lane', name: 'l1', turnStartedAt: 500 };

test('§5.4 off: hold false, no since, no busy, held 0 — whatever is running', () => {
  const { hold } = world([LANE], 3);
  expect(hold.view()).toEqual({ hold: false, since: null, busy: [], held: 0 });
});

test('§5.4 update_hold on: hold, since = now, busy + held from the engine; one change', () => {
  const { hold, st } = world([LANE], 2);
  hold.on(A);
  expect(hold.view()).toEqual({ hold: true, since: 1_000, busy: [LANE], held: 2 });
  expect(st.changes).toBe(1);
});

test('§5.4 a second on keeps `since`; the newest connection holds (the app reconnected)', () => {
  const { hold, st } = world();
  hold.on(A); st.t = 2_000; hold.on(B);
  expect(hold.view().since).toBe(1_000);
  hold.closed(A); // the old socket closing no longer releases
  expect(hold.view().hold).toBe(true);
  hold.closed(B);
  expect(hold.view().hold).toBe(false);
});

test('§5.4-6 the holder connection closes → released, one change; another connection closing → nothing', () => {
  const { hold, st } = world();
  hold.on(A);
  hold.closed(B);
  expect(hold.view().hold).toBe(true);
  hold.closed(A);
  expect(hold.view()).toEqual({ hold: false, since: null, busy: [], held: 0 });
  expect(st.changes).toBe(2);
});

test('§5.4-6 update_hold off releases only from the holder (the webview cannot drop the app hold)', () => {
  const { hold } = world();
  hold.on(A);
  hold.off(B);
  expect(hold.view().hold).toBe(true);
  hold.off(A);
  expect(hold.view().hold).toBe(false);
});

test('§5.4-9 update_commit: busy → { ok: false, busy }; idle → { ok: true }; not the holder → null', () => {
  const { hold, st } = world([LANE]);
  expect(hold.commit(A)).toBeNull();
  hold.on(A);
  expect(hold.commit(B)).toBeNull();
  expect(hold.commit(A)).toEqual({ ok: false, busy: [LANE] });
  st.busy = [];
  expect(hold.commit(A)).toEqual({ ok: true });
});

test('§5.4-4 refresh emits a change only when the view moved (a turn ended, a message held)', () => {
  const { hold, st } = world([LANE]);
  hold.on(A);
  hold.refresh();
  expect(st.changes).toBe(1);
  st.busy = [];
  hold.refresh();
  expect(st.changes).toBe(2);
  st.held = 1;
  hold.refresh();
  expect(st.changes).toBe(3);
  hold.refresh();
  expect(st.changes).toBe(3);
});

test('§5.4 the tick refreshes while held and stops on release', async () => {
  const st = { busy: [LANE], changes: 0 };
  const hold = new UpdateHold({ busy: () => st.busy, held: () => 0, changed: () => { st.changes++; }, tickMs: 5 });
  hold.on(A);
  st.busy = [];
  await Bun.sleep(30);
  expect(st.changes).toBe(2);
  hold.off(A);
  st.busy = [LANE];
  await Bun.sleep(30);
  expect(st.changes).toBe(3);
  hold.stop();
});

test('§5.4-4 busy = lanes and orchestrator sessions with a turn running (turnStartedAt set), nothing else', () => {
  const lanes = { listAll: () => [
    { projectId: 'p', name: 'a', turnStartedAt: 10 }, { projectId: 'p', name: 'b', turnStartedAt: null },
  ] };
  const orchs = { all: () => [
    { projectId: 'q', currentSessionId: 's1', turnStartedAt: 20 }, { projectId: 'q', currentSessionId: 's2', turnStartedAt: null },
  ] };
  expect(sessionsBusy(lanes, orchs)).toEqual([
    { projectId: 'p', kind: 'lane', name: 'a', turnStartedAt: 10 },
    { projectId: 'q', kind: 'orchestrator', name: 's1', turnStartedAt: 20 },
  ]);
});

let tmp: string; let db: Db;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'hold-')); db = openDb(join(tmp, 'state.db')); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

test('§4.4 held = undelivered rows since the hold began, of sessions the gate kept back (older, delivered, other sessions do not count)', () => {
  const now = Math.floor(Date.now() / 1000);
  const gate = new UpdateGate();
  insertOutbox(db, { sessionId: 's', text: 'old', prefix: null });
  db.query('UPDATE outbox SET created_at = ?').run(now - 100);
  insertOutbox(db, { sessionId: 's', text: 'new1', prefix: null });
  insertOutbox(db, { sessionId: 'quota-wait', text: 'not the gate', prefix: null });
  const d = insertOutbox(db, { sessionId: 's', text: 'new2', prefix: null });
  db.query('UPDATE outbox SET delivered_at = ? WHERE uuid = ?').run(now, d.uuid);
  expect(heldSince(db, (now - 10) * 1000, gate)).toBe(0);
  gate.hold(true);
  gate.refused('s');
  expect(heldSince(db, (now - 10) * 1000, gate)).toBe(1);
  gate.defer('quota-wait', () => {});
  expect(heldSince(db, (now - 10) * 1000, gate)).toBe(2);
});

test('MINOR-1 a failing backup backs off (one try per 30 s) and reports once per failure streak', () => {
  const st = { t: 0, tries: 0, fail: true, reports: [] as string[] };
  const hold = new UpdateHold({
    busy: () => [], held: () => 0, changed: () => {}, now: () => st.t, tickMs: 0,
    ready: () => { st.tries++; if (st.fail) throw new Error('disk full'); },
    failed: (err) => { st.reports.push(err.message); },
  });
  hold.on(A);
  for (let i = 0; i < 60; i++) { st.t += 1_000; hold.refresh(); }
  expect(st.tries).toBeLessThanOrEqual(3);
  expect(st.tries).toBeGreaterThanOrEqual(2);
  expect(st.reports).toEqual(['disk full']);
  st.fail = false;
  st.t += 30_000; hold.refresh();
  const done = st.tries;
  st.t += 30_000; hold.refresh();
  expect(st.tries).toBe(done); // ready sent: no more backups this idle stretch
});

test('IMPORTANT-2 releasing a sealed hold calls `released` (the resume file goes); an unsealed release does not', () => {
  let released = 0;
  const hold = new UpdateHold({ busy: () => [], held: () => 0, changed: () => {}, tickMs: 0, released: () => { released++; } });
  hold.on(A); hold.off(A);
  expect(released).toBe(0);
  hold.on(A); expect(hold.commit(A)).toEqual({ ok: true }); hold.closed(A);
  expect(released).toBe(1);
  hold.on(A); hold.commit(A); hold.stop(); hold.closed(A); // the engine stop closes the holder's socket: the update restart
  expect(released).toBe(1);
});
