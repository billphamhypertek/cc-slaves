// v2.1 §4.15 / §5.3 engine views: every `*At` a client reads is epoch ms; a lane's `updatedAt` is its real done / last time.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertEvent, insertLane, insertProject, insertSession, openDb, updateLaneState, type Db } from '../../src/db.ts';
import { buildLaneView, cardViewOf, snapshotLaneKeys } from '../../src/engine/views.ts';
import { listSessions } from '../../src/server/session-views.ts';
import type { Engine } from '../../src/engine.ts';
import type { Card } from '../../src/cards/store.ts';

let tmp: string; let db: Db; let eng: Engine;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-views-'));
  db = openDb(join(tmp, 'state.db'));
  insertProject(db, { id: 'p', name: 'P', path: tmp });
  eng = { db, lanes: { get: () => null }, branches: { info: () => null } } as unknown as Engine;
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const nowS = () => Math.floor(Date.now() / 1000);
/** A done lane whose done_at is `agoS` seconds ago. */
function doneLane(name: string, agoS: number): void {
  const l = insertLane(db, { projectId: 'p', name, cwd: join(tmp, name) });
  updateLaneState(db, l.id, 'done');
  db.query('UPDATE lane SET done_at = ? WHERE id = ?').run(nowS() - agoS, l.id);
}

describe('§4.15 LaneView.updatedAt = the lane\'s real time, epoch ms', () => {
  test('§4.15 §3 41 done lanes created oldest-done-last: the newest 6 by done time are D01–D06', () => {
    // created D41 first … D01 last: creation order is the reverse of done order (the e2e seed's shape)
    const names = Array.from({ length: 41 }, (_, i) => `D${String(41 - i).padStart(2, '0')}`);
    for (const n of names) doneLane(n, Number(n.slice(1)) * 1800); // D01 30 min ago … D41 20.5 h ago
    const views = names.map((n) => buildLaneView(eng, 'p', n)!);
    const newest = [...views].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6).map((v) => v.name);
    expect(newest).toEqual(['D01', 'D02', 'D03', 'D04', 'D05', 'D06']);
  });

  test('§4.15 §3 a lane done 1 h ago reads as 1 h ago in ms (not "Cũ hơn 7 ngày")', () => {
    doneLane('D1', 3600);
    const age = Date.now() - buildLaneView(eng, 'p', 'D1')!.updatedAt;
    expect(age).toBeGreaterThanOrEqual(3_600_000 - 1000);
    expect(age).toBeLessThan(3_600_000 + 2000);
  });

  test('§4.15 a done lane from before v12 (no done_at) falls back to created_at, in ms', () => {
    const l = insertLane(db, { projectId: 'p', name: 'OLD', cwd: join(tmp, 'old') });
    updateLaneState(db, l.id, 'done');
    db.query('UPDATE lane SET done_at = NULL, created_at = ? WHERE id = ?').run(1_700_000_000, l.id);
    expect(buildLaneView(eng, 'p', 'OLD')!.updatedAt).toBe(1_700_000_000_000);
  });

  test('§5.3 a live lane: its last event time (ms), else its creation time (ms)', () => {
    insertSession(db, { id: 's-l1', projectId: 'p', kind: 'lane', account: null });
    const l = insertLane(db, { projectId: 'p', name: 'L1', cwd: join(tmp, 'l1'), sessionId: 's-l1' });
    db.query('UPDATE lane SET created_at = ? WHERE id = ?').run(1_700_000_000, l.id);
    expect(buildLaneView(eng, 'p', 'L1')!.updatedAt).toBe(1_700_000_000_000);
    insertEvent(db, { sessionId: 's-l1', type: 'assistant', json: {}, ts: 1_700_000_500_123 });
    insertEvent(db, { sessionId: 'other', type: 'assistant', json: {}, ts: 1_800_000_000_000 });
    expect(buildLaneView(eng, 'p', 'L1')!.updatedAt).toBe(1_700_000_500_123);
  });
});

describe('§5.3 other `*At` fields the clients read as epoch ms', () => {
  test('§4.14 session rows: startedAt / endedAt epoch ms', () => {
    insertSession(db, { id: 's1', projectId: 'p', kind: 'orchestrator', account: null });
    db.query('UPDATE session SET created_at = 1700000000, ended_at = 1700000600 WHERE id = ?').run('s1');
    const r = listSessions(db, 'p', new Map()).ended[0]!;
    expect(r).toMatchObject({ startedAt: 1_700_000_000_000, endedAt: 1_700_000_600_000 });
  });
  test('v2.9 §4.7 session rows and a lane view carry the effective config of their pinned rev (PO by default)', () => {
    insertSession(db, { id: 's1', projectId: 'p', kind: 'orchestrator', account: null });
    db.query("UPDATE session SET orch_kind = 'build', step = 'build', ended_at = 1700000600 WHERE id = 's1'").run();
    expect(listSessions(db, 'p', new Map()).ended[0]!.wf).toMatchObject({ name: 'Quy trình PO', step: 'build', stepName: 'Build' });
    insertLane(db, { projectId: 'p', name: 'L1', cwd: join(tmp, 'l1') });
    expect(buildLaneView(eng, 'p', 'L1')!.wf).toMatchObject({ name: 'Quy trình PO', step: 'lane' });
  });
});

describe('§4.15 snapshot done-lane window (7 days)', () => {
  test('§4.15 a lane created 8 days ago and done today is in the snapshot; one done 8 days ago is not', () => {
    const today = insertLane(db, { projectId: 'p', name: 'NEW', cwd: join(tmp, 'new') });
    updateLaneState(db, today.id, 'done');
    db.query('UPDATE lane SET created_at = ?, done_at = ? WHERE id = ?').run(nowS() - 8 * 86_400, nowS() - 60, today.id);
    doneLane('OLD', 8 * 86_400);
    db.query("UPDATE lane SET created_at = ? WHERE name = 'OLD'").run(nowS() - 9 * 86_400);
    insertLane(db, { projectId: 'p', name: 'LIVE', cwd: join(tmp, 'live') });
    db.query("UPDATE lane SET created_at = ? WHERE name = 'LIVE'").run(nowS() - 30 * 86_400);
    expect(snapshotLaneKeys(db, nowS()).map((r) => r.name)).toEqual(['NEW', 'LIVE']);
  });
});

describe('§4.14 I9 a lane card names its lane\'s owner session (#n)', () => {
  const ask = (sessionId: string | null, source: string): Card => ({ id: 1, kind: 'ask', projectId: 'p', sessionId, requestId: null, status: 'open', createdAt: 1,
    resolvedAt: null, answer: null, payload: { source, question: 'tách route?', options: [], recommended: null, context: null } });
  test('§4.14 the lane runs in a newer session than the card\'s: seq still = its owner\'s #n', () => {
    insertSession(db, { id: 'o3', projectId: 'p', kind: 'orchestrator', account: null });
    db.query("UPDATE session SET seq = 3 WHERE id = 'o3'").run();
    insertSession(db, { id: 'old', projectId: 'p', kind: 'lane', account: null });
    insertSession(db, { id: 'new', projectId: 'p', kind: 'lane', account: null });
    insertLane(db, { projectId: 'p', name: 'D3', cwd: join(tmp, 'd3'), sessionId: 'new', ownerSession: 'o3' });
    expect(cardViewOf(eng, ask('old', 'D3')).seq).toBe(3);
    expect(cardViewOf(eng, ask(null, 'D3')).seq).toBe(3);
  });
  test('§4.14 an orchestrator card keeps its own session #n', () => {
    insertSession(db, { id: 'o4', projectId: 'p', kind: 'orchestrator', account: null });
    db.query("UPDATE session SET seq = 4 WHERE id = 'o4'").run();
    expect(cardViewOf(eng, ask('o4', 'orchestrator')).seq).toBe(4);
  });
});
