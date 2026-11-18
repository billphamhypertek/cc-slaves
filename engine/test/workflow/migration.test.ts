// spec v2.9 §6.1 / §10.1 / §12 migration v25 on a v24 DB holding specs in every v2.7 state and sessions of every role.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MIGRATIONS, migrate } from '../../src/db.ts';
import { MIGRATION_V25 } from '../../src/workflow/schema.ts';
import { DEFAULT_WORKFLOW } from '../../src/workflow/builtin/index.ts';
import { hashText, spawnPrompt, workflowOf } from '../../src/workflow/runtime.ts';

function v24(): Database {
  const db = new Database(':memory:', { strict: true });
  for (const m of MIGRATIONS.slice(0, 24)) db.exec(m);
  db.exec('PRAGMA user_version = 24');
  db.exec('PRAGMA foreign_keys = ON');
  db.run("INSERT INTO project (id, name, path, created_at) VALUES ('p1','one','/r/one',1)");
  const ses = (id: string, kind: string, orch: string, v: number | null) =>
    db.run(`INSERT INTO session (id, project_id, kind, orch_kind, prompt_version, created_at) VALUES ('${id}','p1','${kind}','${orch}',${v ?? 'NULL'},1)`);
  ses('d1', 'orchestrator', 'design', 1);
  ses('b1', 'orchestrator', 'build', 1);
  ses('g1', 'orchestrator', 'general', 6);
  ses('g0', 'orchestrator', 'general', 5);
  ses('gn', 'orchestrator', 'general', null);
  ses('l1', 'lane', 'general', 3);
  ses('l0', 'lane', 'general', 2);
  db.run("INSERT INTO lane (project_id, name, session_id, cwd, state, created_at) VALUES ('p1','D1','l1','/w/d1','idle',1)");
  for (const [n, state] of [[1, 'draft'], [2, 'approved'], [3, 'active'], [4, 'done']] as const) {
    db.run(`INSERT INTO spec (project_id, path, state, origin, design_session, created_at) VALUES ('p1','docs/specs/${n}.md','${state}','app','d1',1)`);
  }
  return db;
}

describe('§10.1 migration v24 → v25', () => {
  const db = v24();
  migrate(db);
  const po = workflowOf(DEFAULT_WORKFLOW);

  test('MIGRATIONS step 25 is v25 (v26 = v2.5 graph_index, v27 = hf-sp workflow_fallback); user_version = the last step', () => {
    expect(MIGRATIONS[24]).toBe(MIGRATION_V25);
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(MIGRATIONS.length);
  });
  test('hf-sp v27: an existing project keeps its workflow and has no fallback reason', () => {
    expect(db.query('SELECT workflow, workflow_fallback FROM project').all()).toEqual([{ workflow: 'builtin:po', workflow_fallback: null }]);
  });
  test('every project runs builtin:po; every spec / session / lane is pinned to the built-in rev', () => {
    expect(db.query('SELECT workflow FROM project').all()).toEqual([{ workflow: 'builtin:po' }]);
    for (const t of ['spec', 'session', 'lane']) {
      expect(db.query<{ r: string }, []>(`SELECT DISTINCT workflow_rev AS r FROM ${t}`).all()).toEqual([{ r: po.rev }]);
    }
  });
  test('§5.3 spec.step: draft / approved → design, active → build, done → NULL; design_session renamed step_session', () => {
    expect(db.query('SELECT state, step, step_session FROM spec ORDER BY id').all()).toEqual([
      { state: 'draft', step: 'design', step_session: 'd1' }, { state: 'approved', step: 'design', step_session: 'd1' },
      { state: 'active', step: 'build', step_session: 'd1' }, { state: 'done', step: null, step_session: 'd1' },
    ]);
  });
  test('§6.1 prompt_hash = the role text hash for the current v2.7 version, \'v27-older\' for an older one, NULL for unknown; prompt_version gone', () => {
    const h = (id: string) => hashText(po.steps.find((s) => s.id === id)!.appendix);
    expect(db.query('SELECT id, step, prompt_hash AS h FROM session ORDER BY id').all()).toEqual([
      { id: 'b1', step: 'build', h: h('build') }, { id: 'd1', step: 'design', h: h('design') },
      { id: 'g0', step: 'general', h: 'v27-older' }, { id: 'g1', step: 'general', h: h('general') }, { id: 'gn', step: 'general', h: null },
      { id: 'l0', step: 'lane', h: 'v27-older' }, { id: 'l1', step: 'lane', h: h('lane') },
    ]);
    expect(() => db.query('SELECT prompt_version FROM session').all()).toThrow(/no such column/);
  });
  test('§6.1 a resume of an older-version session sends the update once (as v2.7), then nothing; current / unknown send nothing', () => {
    const step = (id: string) => po.steps.find((s) => s.id === id)!;
    for (const [sid, role] of [['g0', 'general'], ['l0', 'lane']] as const) {
      expect(spawnPrompt(db, sid, true).update).toBe(`[cc-slaves] Cập nhật quy tắc điều phối: ${step(role).appendix}`);
      expect(spawnPrompt(db, sid, true).update).toBeNull();
      expect(db.query<{ h: string | null }, [string]>('SELECT prompt_hash AS h FROM session WHERE id = ?').get(sid)!.h).toBe(hashText(step(role).appendix));
    }
    for (const sid of ['g1', 'l1', 'gn']) expect(spawnPrompt(db, sid, true).update).toBeNull();
  });
});
