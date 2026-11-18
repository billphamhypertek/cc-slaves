// v2.5 R1 migration v26 (`graph_index`) on a copy of a v25 state.db in a temp dir: every row of every old table is kept
// byte for byte, the old schema is unchanged, the new table takes `project` / `lane` rows and refuses any other origin.
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openDb } from '../../src/db.ts';
import { MIGRATION_V26 } from '../../src/graph/schema.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ccs-v26-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function v25File(): string {
  const path = join(tmp, 'v25.db');
  const db = new Database(path, { create: true, strict: true });
  for (const m of MIGRATIONS.slice(0, 25)) db.exec(m);
  db.exec('PRAGMA user_version = 25');
  db.run("INSERT INTO project (id, name, path, created_at) VALUES ('p1','one','/r/one',1)");
  db.run("INSERT INTO session (id, project_id, kind, created_at) VALUES ('s1','p1','lane',2)");
  db.run("INSERT INTO lane (project_id, name, session_id, cwd, state, created_at) VALUES ('p1','D1','s1','/r/one/.wt/d1','idle',3)");
  db.run("INSERT INTO meta (key, value) VALUES ('k','v')");
  db.close();
  return path;
}

const tables = (db: Database) =>
  db.query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
// openDb runs every step, so v27 (hf-sp) also adds `project.workflow_fallback`; strip it to compare with the v25 copy.
const noV27 = (t: { name: string; sql: string }) => (t.name === 'project' ? { ...t, sql: t.sql.replace(', workflow_fallback TEXT)', ')') } : t);
const dump = (db: Database) => Object.fromEntries(tables(db).map((t) => [t.name, db.query(`SELECT * FROM "${t.name}"`).all()]));

describe('R1 migration v25 → v26', () => {
  const src = v25File();
  const copy = join(tmp, 'copy.db');
  copyFileSync(src, copy);
  const before = new Database(src, { readonly: true, strict: true });
  const db = openDb(copy);

  test('v26 is the 26th step; user_version = the last step (v27 = hf-sp workflow_fallback)', () => {
    expect(MIGRATIONS[25]).toBe(MIGRATION_V26);
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(MIGRATIONS.length);
  });
  test('lossless: every old table keeps its schema and every row', () => {
    const old = tables(before);
    expect(tables(db).filter((t) => t.name !== 'graph_index').map(noV27)).toEqual(old);
    const now = dump(db);
    delete now.graph_index;
    now.project = (now.project as Record<string, unknown>[]).map(({ workflow_fallback: _, ...r }) => r);
    expect(now).toEqual(dump(before));
  });
  test('graph_index(root_path, project_id, origin): one row per root, origin project | lane only', () => {
    db.run("INSERT INTO graph_index (root_path, project_id, origin) VALUES ('/r/one','p1','project')");
    db.run("INSERT INTO graph_index (root_path, project_id, origin) VALUES ('/r/one/.wt/d1','p1','lane')");
    expect(() => db.run("INSERT INTO graph_index (root_path, project_id, origin) VALUES ('/r/one','p1','lane')")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.run("INSERT INTO graph_index (root_path, project_id, origin) VALUES ('/x','p1','user')")).toThrow(/CHECK/);
    expect(db.query('SELECT * FROM graph_index ORDER BY root_path').all()).toEqual([
      { root_path: '/r/one', project_id: 'p1', origin: 'project' }, { root_path: '/r/one/.wt/d1', project_id: 'p1', origin: 'lane' },
    ]);
  });
});
