import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MIGRATIONS, migrate } from '../../src/db.ts';

function v22(): Database {
  const db = new Database(':memory:', { strict: true });
  for (const m of MIGRATIONS.slice(0, 22)) db.exec(m);
  db.exec('PRAGMA user_version = 22');
  db.exec('PRAGMA foreign_keys = ON');
  db.run("INSERT INTO project (id, name, path, created_at) VALUES ('p1','one','/r/one',1)");
  db.run("INSERT INTO session (id, project_id, kind, created_at) VALUES ('s1','p1','orchestrator',1)");
  db.run("INSERT INTO session (id, project_id, kind, created_at) VALUES ('s2','p1','lane',2)");
  db.run("INSERT INTO card (id, project_id, session_id, kind, payload, status, created_at) VALUES (41,'p1','s1','mcp_login','{}','open',1)");
  db.run("INSERT INTO card (id, kind, payload, status, created_at) VALUES (40,'ask','{\"q\":1}','answered',1)");
  return db;
}

describe('§5.1 migration v22 → v23 (R-B1)', () => {
  test('§5.1 MIGRATIONS has v23 as a step (v24 = v2.7.1 quota.five_window, v25 = v2.9 workflows, v26 = v2.5 graph_index, v27 = hf-sp workflow_fallback)', () => {
    expect(MIGRATIONS.length).toBe(27);
  });

  test('§5.1 card rows + ids + AUTOINCREMENT kept; issues_new / superpowers_off / revert_conflict accepted; unknown kind refused', () => {
    const db = v22();
    expect(() => db.run("INSERT INTO card (kind, payload, created_at) VALUES ('issues_new','{}',0)")).toThrow(/CHECK/);
    migrate(db);
    expect(db.query('SELECT id, kind, status, payload FROM card ORDER BY id').all()).toEqual([
      { id: 40, kind: 'ask', status: 'answered', payload: '{"q":1}' },
      { id: 41, kind: 'mcp_login', status: 'open', payload: '{}' },
    ]);
    const ids = ['issues_new', 'superpowers_off', 'revert_conflict'].map((k) =>
      db.query<{ id: number }, [string]>("INSERT INTO card (kind, payload, created_at) VALUES (?, '{}', 2) RETURNING id").get(k)?.id);
    expect(ids).toEqual([42, 43, 44]);
    expect(() => db.run("INSERT INTO card (kind, payload, created_at) VALUES ('nope','{}',0)")).toThrow(/CHECK/);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'card_open'").all()).toEqual([{ name: 'card_open' }]);
    db.close();
  });

  test('§5.0 R25 old sessions read as general; orch_kind refuses an unknown kind', () => {
    const db = v22();
    migrate(db);
    expect(db.query('SELECT id, orch_kind FROM session ORDER BY id').all()).toEqual([
      { id: 's1', orch_kind: 'general' }, { id: 's2', orch_kind: 'general' },
    ]);
    db.run("UPDATE session SET orch_kind = 'design' WHERE id = 's1'");
    expect(() => db.run("UPDATE session SET orch_kind = 'plan' WHERE id = 's1'")).toThrow(/CHECK/);
    db.close();
  });

  test('§5.1 new tables: (project_id, path) unique on spec, (project_id, num) unique on issue, enum CHECKs, FKs', () => {
    const db = v22();
    migrate(db);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of ['spec', 'issue', 'issue_dep', 'issue_commit', 'issue_event', 'issue_file', 'spec_output']) expect(tables).toContain(t);
    db.run("INSERT INTO spec (project_id, path, origin, created_at) VALUES ('p1','docs/specs/a.md','app',1)");
    expect(() => db.run("INSERT INTO spec (project_id, path, origin, created_at) VALUES ('p1','docs/specs/a.md','imported',1)")).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO spec (project_id, path, origin, created_at) VALUES ('p1','b.md','web',1)")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO spec (project_id, path, state, origin, created_at) VALUES ('p1','b.md','building','app',1)")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO spec (project_id, path, origin, created_at) VALUES ('p9','b.md','app',1)")).toThrow(/FOREIGN KEY/);
    const ins = (num: number, extra = '', vals = '') =>
      db.run(`INSERT INTO issue (project_id, num, kind, source, title, created_at${extra}) VALUES ('p1', ${num}, 'task', 'spec', 'x', 1${vals})`);
    ins(1);
    expect(() => ins(1)).toThrow(/UNIQUE/);
    expect(() => ins(2, ', state', ", 'blocked'")).toThrow(/CHECK/);
    expect(() => ins(2, ', revert', ", 'half'")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO issue (project_id, num, kind, source, title, created_at) VALUES ('p1', 2, 'task', 'ai', 'x', 1)")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO issue (project_id, num, kind, source, title, created_at) VALUES ('p1', 2, 'epic', 'po', 'x', 1)")).toThrow(/CHECK/);
    expect(() => ins(2, ', state', ", 'doing'")).toThrow(/CHECK/); // doing without a lane
    expect(() => ins(2, ', done_when', ", '{}'")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO issue_dep (issue_id, blocked_by_id) VALUES (1, 1)")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO issue_event (issue_id, ts, type, json) VALUES (1, 1, 'x', 'prose')")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO spec_output (spec_id, kind, ref, added_by, at) VALUES (1, 'pdf', 'x', 'auto', 1)")).toThrow(/CHECK/);
    db.close();
  });
});
