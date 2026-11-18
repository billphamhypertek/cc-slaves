import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LaneConflictError, MIGRATIONS, getLane, migrate, getQuota, insertLane, insertOutbox, insertProject, listUndelivered,
  markDelivered, openDb, updateLaneState, upsertQuota, insertEvent, sessionCost, costSince, type Db,
} from '../src/db.ts';

let tmp: string;
let db: Db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-db-'));
  db = openDb(join(tmp, 'state.db'));
  insertProject(db, { id: 'p1', name: 'one', path: '/r/one' });
  insertProject(db, { id: 'p2', name: 'two', path: '/r/two' });
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const lane = (o: Partial<Parameters<typeof insertLane>[1]> = {}) =>
  insertLane(db, { projectId: 'p1', name: 'D1', cwd: '/w/d1', ...o });

describe('db migrations', () => {
  test('§7.8 fresh db has every table and user_version = migration count', () => {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => r.name);
    for (const t of ['project', 'session', 'lane', 'run', 'event', 'card', 'outbox', 'quota', 'device']) {
      expect(tables).toContain(t);
    }
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(MIGRATIONS.length);
    expect(db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
  });

  test('§4.14 v16 session.opened_at: old rows get created_at in ms', () => {
    const old = new Database(':memory:', { strict: true });
    for (let i = 0; i < 15; i++) old.exec(MIGRATIONS[i]!);
    old.exec('PRAGMA user_version = 15');
    old.run("INSERT INTO session (id, project_id, kind, created_at) VALUES ('s1','p1','orchestrator',42)");
    migrate(old);
    expect(old.query('SELECT opened_at FROM session').get()).toEqual({ opened_at: 42_000 });
  });

  test('§5.3 v17 event.ts is one unit: old `line` rows (seconds) become ms, other rows untouched', () => {
    const old = new Database(':memory:', { strict: true });
    for (let i = 0; i < 16; i++) old.exec(MIGRATIONS[i]!);
    old.exec('PRAGMA user_version = 16');
    old.run("INSERT INTO event (session_id, ts, type, json) VALUES ('s1', 1763200000, 'line', '{}')");
    old.run("INSERT INTO event (session_id, ts, type, json) VALUES ('s1', 1763200000123, 'result', '{}')");
    migrate(old);
    expect(old.query('SELECT type, ts FROM event ORDER BY id').all()).toEqual([
      { type: 'line', ts: 1_763_200_000_000 }, { type: 'result', ts: 1_763_200_000_123 }]);
  });

  test('re-open is idempotent and keeps data', () => {
    lane();
    db.close();
    db = openDb(join(tmp, 'state.db'));
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(MIGRATIONS.length);
    expect(getLane(db, 'p1', 'D1')?.cwd).toBe('/w/d1');
  });

  test('§6.15 card migration v1 → v2 keeps old cards, adds system kinds + expired, ids never reused', () => {
    const old = new Database(':memory:', { strict: true });
    old.exec(MIGRATIONS[0]!);
    old.exec('PRAGMA user_version = 1');
    old.run("INSERT INTO session (id, project_id, kind, created_at) VALUES ('s1','p1','lane',0)");
    old.run("INSERT INTO card (id, session_id, kind, payload, status, created_at) VALUES (7,'s1','ask','{}','open',5)");
    migrate(old);
    migrate(old); // idempotent
    expect(old.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(MIGRATIONS.length);
    expect(old.query('SELECT id, project_id, session_id, kind, status FROM card').all())
      .toEqual([{ id: 7, project_id: 'p1', session_id: 's1', kind: 'ask', status: 'open' }]);
    old.run("INSERT INTO card (project_id, kind, payload, status, created_at) VALUES (NULL,'logged_out','{}','expired',6)");
    old.run('DELETE FROM card WHERE id = 8');
    const r = old.query<{ id: number }, []>("INSERT INTO card (kind, payload, created_at) VALUES ('cc_updated','{}',7) RETURNING id").get();
    expect(r?.id).toBe(9);
    expect(() => old.run("INSERT INTO card (kind, payload, created_at) VALUES ('bogus','{}',0)")).toThrow(/CHECK/);
    old.close();
  });

  test('IMPORTANT-2 §6 card migration v7 → v8: account_orphan accepted, old cards + AUTOINCREMENT kept', () => {
    const old = new Database(':memory:', { strict: true });
    for (const m of MIGRATIONS.slice(0, 7)) old.exec(m);
    old.exec('PRAGMA user_version = 7');
    old.run("INSERT INTO card (id, kind, payload, status, created_at, resolved_at) VALUES (4,'shared_cfg','{}','answered',1,2)");
    expect(() => old.run("INSERT INTO card (kind, payload, created_at) VALUES ('account_orphan','{}',0)")).toThrow(/CHECK/);
    migrate(old);
    expect(old.query('SELECT id, kind, status, resolved_at FROM card').all()).toEqual([{ id: 4, kind: 'shared_cfg', status: 'answered', resolved_at: 2 }]);
    expect(old.query<{ id: number }, []>("INSERT INTO card (kind, payload, created_at) VALUES ('account_orphan','{}',7) RETURNING id").get()?.id).toBe(5);
    expect(() => old.run("INSERT INTO card (kind, payload, created_at) VALUES ('bogus','{}',0)")).toThrow(/CHECK/);
    old.close();
  });

  test('v2.4 §10.2 outbox migration v19 → v20: attachments NULL + echoed 0 on old rows, rows kept', () => {
    const old = new Database(':memory:', { strict: true });
    for (const m of MIGRATIONS.slice(0, 19)) old.exec(m);
    old.exec('PRAGMA user_version = 19');
    old.run("INSERT INTO outbox (uuid, session_id, text, prefix, created_at) VALUES ('u1','s1','hi','[PO]',1)");
    migrate(old);
    expect(old.query('SELECT uuid, text, attachments, echoed FROM outbox').all()).toEqual([{ uuid: 'u1', text: 'hi', attachments: null, echoed: 0 }]);
    old.close();
  });

  test('v2.7.1 D103 quota migration v23 → v24: five_window NULL on old rows (unknown), rows kept', () => {
    const old = new Database(':memory:', { strict: true });
    for (const m of MIGRATIONS.slice(0, 23)) old.exec(m);
    old.exec('PRAGMA user_version = 23');
    old.run("INSERT INTO quota VALUES ('u@x', NULL, 40, NULL, 99, 'api', 5, 'ok')");
    migrate(old);
    expect(old.query('SELECT account, week_pct, five_window FROM quota').all()).toEqual([{ account: 'u@x', week_pct: 40, five_window: null }]);
    expect(getQuota(old, 'u@x')).toMatchObject({ weekPct: 40, fiveWindow: null });
    old.close();
  });

  test('hf1116 H5 project migration v20 → v21: closed_at NULL on old rows (every project open), rows kept', () => {
    const old = new Database(':memory:', { strict: true });
    for (const m of MIGRATIONS.slice(0, 20)) old.exec(m);
    old.exec('PRAGMA user_version = 20');
    old.run("INSERT INTO project (id, name, path, created_at) VALUES ('p1','one','/r/one',1)");
    migrate(old);
    expect(old.query('SELECT id, name, closed_at FROM project').all()).toEqual([{ id: 'p1', name: 'one', closed_at: null }]);
    old.close();
  });

  test('v2.2 §6 K13 card migration v17 → v18: mcp_login accepted, old cards + AUTOINCREMENT kept', () => {
    const old = new Database(':memory:', { strict: true });
    for (const m of MIGRATIONS.slice(0, 17)) old.exec(m);
    old.exec('PRAGMA user_version = 17');
    old.run("INSERT INTO card (id, kind, payload, status, created_at) VALUES (9,'cutover','{}','open',1)");
    expect(() => old.run("INSERT INTO card (kind, payload, created_at) VALUES ('mcp_login','{}',0)")).toThrow(/CHECK/);
    migrate(old);
    expect(old.query('SELECT id, kind, status FROM card').all()).toEqual([{ id: 9, kind: 'cutover', status: 'open' }]);
    expect(old.query<{ id: number }, []>("INSERT INTO card (kind, payload, created_at) VALUES ('mcp_login','{}',2) RETURNING id").get()?.id).toBe(10);
    old.close();
  });

  test('§7 D18/D24 migration v8 → v9: project.permission_mode and app_nonce dropped, project rows kept', () => {
    const old = new Database(':memory:', { strict: true });
    for (const m of MIGRATIONS.slice(0, 8)) old.exec(m);
    old.exec('PRAGMA user_version = 8');
    old.run("INSERT INTO project (id, name, path, permission_mode, orchestrator_account, created_at) VALUES ('p1','one','/r/one','bypassPermissions','o@x',1)");
    old.run("INSERT INTO app_nonce (nonce, ts) VALUES ('n1', 1)");
    migrate(old);
    const cols = old.prepare<{ name: string }, []>('PRAGMA table_info(project)').all().map((c) => c.name);
    expect(cols).not.toContain('permission_mode');
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'app_nonce'").all()).toEqual([]);
    expect(old.prepare('SELECT id, name, path, orchestrator_account FROM project').all()).toEqual([{ id: 'p1', name: 'one', path: '/r/one', orchestrator_account: 'o@x' }]);
    old.close();
  });

  test('v2 §5.5 A9 card migration v6 → v7: shared_cfg kinds accepted, old cards + resolved_at + AUTOINCREMENT kept', () => {
    const old = new Database(':memory:', { strict: true });
    for (const m of MIGRATIONS.slice(0, 6)) old.exec(m);
    old.exec('PRAGMA user_version = 6');
    old.run("INSERT INTO card (id, kind, payload, status, created_at, resolved_at) VALUES (4,'logged_out','{}','answered',1,2)");
    old.run("INSERT INTO card (id, kind, payload, created_at) VALUES (5,'cc_updated','{}',3)");
    old.run('DELETE FROM card WHERE id = 5');
    expect(() => old.run("INSERT INTO card (kind, payload, created_at) VALUES ('shared_cfg','{}',0)")).toThrow(/CHECK/);
    migrate(old);
    expect(old.query('SELECT id, kind, status, resolved_at FROM card').all()).toEqual([{ id: 4, kind: 'logged_out', status: 'answered', resolved_at: 2 }]);
    const r = old.query<{ id: number }, []>("INSERT INTO card (kind, payload, created_at) VALUES ('shared_cfg','{}',7) RETURNING id").get();
    expect(r?.id).toBe(6);
    old.run("INSERT INTO card (kind, payload, created_at) VALUES ('shared_cfg_new','{}',7)");
    expect(() => old.run("INSERT INTO card (kind, payload, created_at) VALUES ('bogus','{}',0)")).toThrow(/CHECK/);
    old.close();
  });

  test('§7.2 M18 state.db file is 0600', () => {
    expect(statSync(join(tmp, 'state.db')).mode & 0o777).toBe(0o600);
  });
});

describe('lane repo', () => {
  test('lane name is unique per project, free across projects', () => {
    lane();
    expect(() => lane({ cwd: '/w/other' })).toThrow(LaneConflictError);
    expect(() => db.run(
      "INSERT INTO lane (project_id, name, cwd, state, created_at) VALUES ('p1','D1','/w/z','idle',0)",
    )).toThrow(/UNIQUE/);
    expect(() => lane({ projectId: 'p2', cwd: '/w/p2' })).not.toThrow();
  });

  test('§7.4 one live lane per worktree: duplicate cwd refused while the first is not done', () => {
    const a = lane();
    expect(() => lane({ name: 'D2' })).toThrow(LaneConflictError);
    expect(() => lane({ name: 'D3', projectId: 'p2' })).toThrow(/cwd already used by live lane p1\/D1/);
    updateLaneState(db, a.id, 'done');
    expect(() => lane({ name: 'D2' })).not.toThrow();
  });

  test('cwd uniqueness is also enforced in SQL (direct insert bypassing the repo)', () => {
    lane();
    expect(() => db.run(
      "INSERT INTO lane (project_id, name, cwd, state, created_at) VALUES ('p1','X','/w/d1','idle',0)",
    )).toThrow(/UNIQUE/);
  });

  test('updateLaneState stores error and fail count', () => {
    const a = lane();
    updateLaneState(db, a.id, 'broken', { lastError: 'boom', failCount: 2 });
    const got = getLane(db, 'p1', 'D1');
    expect(got?.state).toBe('broken');
    expect(got?.lastError).toBe('boom');
    expect(got?.failCount).toBe(2);
  });
});

describe('outbox repo', () => {
  test('listUndelivered returns undelivered in seq order; markDelivered removes from the list', () => {
    db.run("INSERT INTO session (id, project_id, kind, created_at) VALUES ('s1','p1','orchestrator',0)");
    const a = insertOutbox(db, { sessionId: 's1', text: 'a', uuid: 'zz-first' });
    const b = insertOutbox(db, { sessionId: 's1', text: 'b', prefix: '[cc-slaves]', uuid: 'aa-second' });
    const c = insertOutbox(db, { sessionId: 's1', text: 'c', uuid: 'mm-third' });
    insertOutbox(db, { sessionId: 'other', text: 'z' });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(listUndelivered(db, 's1').map((m) => m.text)).toEqual(['a', 'b', 'c']);
    markDelivered(db, a.uuid);
    const rest = listUndelivered(db, 's1');
    expect(rest.map((m) => m.uuid)).toEqual([b.uuid, c.uuid]);
    expect(rest[0]?.prefix).toBe('[cc-slaves]');
  });
});

describe('quota repo', () => {
  test('upsert replaces the row for the account', () => {
    upsertQuota(db, { account: 'a@x', fivePct: 10, weekPct: 20, fiveResetsAt: 1, weekResetsAt: 2, source: 'api', fetchedAt: 100, status: 'ok' });
    upsertQuota(db, { account: 'a@x', fivePct: 11, weekPct: 21, fiveResetsAt: 3, weekResetsAt: 4, source: 'stream', fetchedAt: 200, status: 'ok' });
    expect(getQuota(db, 'a@x')).toEqual({ account: 'a@x', fivePct: 11, weekPct: 21, fiveResetsAt: 3, weekResetsAt: 4, source: 'stream', fetchedAt: 200, status: 'ok', fiveWindow: null });
    expect(getQuota(db, 'none')).toBeNull();
  });
  test('D103 five_window: written when given, kept when a later write leaves it out', () => {
    const base = { account: 'a@x', fivePct: null, weekPct: 20, fiveResetsAt: null, weekResetsAt: 2, source: 'api' as const, fetchedAt: 100, status: 'ok' };
    upsertQuota(db, { ...base, fiveWindow: false });
    upsertQuota(db, { ...base, source: 'stream', status: 'rejected' });
    expect(getQuota(db, 'a@x')?.fiveWindow).toBe(false);
    upsertQuota(db, { ...base, fiveWindow: true });
    expect(getQuota(db, 'a@x')?.fiveWindow).toBe(true);
  });
});

describe('result cost (§8.6, smoke g6 item 2)', () => {
  const res = (sessionId: string, turnCost: number | null, totalCostUsd: number | null) =>
    insertEvent(db, { sessionId, type: 'result', json: { run: 1, turnCost, totalCostUsd, isError: false, subtype: 'success' } });
  test('§8.6 session cost = largest cumulative total_cost_usd of that session (S4: cumulative across resume)', () => {
    res('o1', 0.009, 0.0089);
    res('o1', 0.0005, 0.0095);
    res('o1', null, null);
    res('x', 5, 5);
    expect(sessionCost(db, 'o1')).toBeCloseTo(0.0095);
    expect(sessionCost(db, 'none')).toBe(0);
  });
  test('§8.6 cost today sums turnCost of results at/after the cut (event.ts is epoch ms)', () => {
    res('a', 0.25, 0.25);
    db.query('UPDATE event SET ts = ?').run(Date.now() - 2 * 86_400_000); // two days ago
    res('b', 0.5, 0.5);
    res('c', null, 1);
    const midnightMs = new Date(new Date().toDateString()).getTime();
    expect(costSince(db, midnightMs)).toBeCloseTo(0.5);
  });
});
