import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../src/cards/store.ts';
import { insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { createIssue, getSpecByPath, insertSpec, moveSpec, updateSpec } from '../../src/issues/store.ts';
import type { McpLanes } from '../../src/mcp/tool-kit.ts';
import { callTool, findTool } from '../../src/mcp/tools.ts';
import { compile } from '../../src/workflow/compile.ts';
import { registerWorkflow, workflowOf } from '../../src/workflow/runtime.ts';
import { validatePack } from '../../src/workflow/validate.ts';
import { fm, packWith } from '../workflow/_packs.ts';
import { issuePorts } from '../_fixtures/issue-ports.ts';

let db: Db;
let tmp: string;
let root: string;
let ports: ReturnType<typeof issuePorts>;
const SPEC = 'docs/specs/2026-11-16-x.md';

const orch = (id: string, kind: 'design' | 'build' | 'general') => {
  insertSession(db, { id, projectId: 'p1', kind: 'orchestrator', account: null });
  db.query('UPDATE session SET orch_kind = ? WHERE id = ?').run(kind, id);
};
const call = async (sid: string, tool: string, args: Record<string, unknown>) => {
  const deps = {
    lanes: {} as McpLanes, usage: () => [], notify: () => {}, issues: ports,
    cards: new CardStore({ db, sessions: { writeControl: () => true, askOpen: () => {}, askClose: () => {}, deliver: () => {} } }),
  };
  const r = await callTool(deps, { sessionId: sid, role: 'orchestrator', projectId: 'p1', cwd: '/w', graph: false }, findTool(tool)!, args);
  return { err: r.isError === true, text: r.content[0]!.text };
};
const active = (path = SPEC) => {
  const s = insertSpec(db, { projectId: 'p1', path, title: 'X', origin: 'app', designSession: 'des' });
  moveSpec(db, s.id, 'approved');
  moveSpec(db, s.id, 'active');
  return updateSpec(db, s.id, { buildSession: 'bld' });
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-spec-')));
  root = join(tmp, 'root');
  mkdirSync(join(root, 'docs/specs'), { recursive: true });
  writeFileSync(join(root, SPEC), 'Trạng thái: nháp\n\n# cc-slaves v2.9 — xuất CSV\n\nnội dung\n');
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'one', path: root });
  orch('des', 'design'); orch('des2', 'design'); orch('bld', 'build'); orch('gen', 'general');
  ports = issuePorts(db);
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('§5.2-1 / -2 spec_draft, spec_approve (D86)', () => {
  test('§5.2-1 Thiết kế drafts: row draft, title = first "# " line, session renamed; Build / Chung refused', async () => {
    expect((await call('bld', 'spec_draft', { path: SPEC })).err).toBe(true);
    expect((await call('gen', 'spec_draft', { path: SPEC })).err).toBe(true);
    expect((await call('des', 'spec_draft', { path: `${root}/${SPEC}` })).err).toBe(false);
    expect(getSpecByPath(db, 'p1', SPEC)).toMatchObject({ state: 'draft', title: 'cc-slaves v2.9 — xuất CSV', designSession: 'des', origin: 'app' });
    expect(ports.log.renamed).toEqual([['des', 'cc-slaves v2.9 — xuất CSV']]);
  });

  test('§5.2-1 a missing file / a second spec for the same session → refused', async () => {
    expect((await call('des', 'spec_draft', { path: 'docs/specs/none.md' })).text).toContain('viết file spec trước');
    await call('des', 'spec_draft', { path: SPEC });
    writeFileSync(join(root, 'docs/specs/y.md'), '# Y\n');
    expect((await call('des', 'spec_draft', { path: 'docs/specs/y.md' })).text).toContain(`đã gắn spec ${SPEC}`);
  });

  test('§5.2-2 spec_approve only from the design session that drafted it; after → after_id', async () => {
    await call('des', 'spec_draft', { path: SPEC });
    const before = insertSpec(db, { projectId: 'p1', path: 'docs/specs/v25.md', title: 'v25', origin: 'imported' });
    expect((await call('des2', 'spec_approve', { path: SPEC })).text).toContain('chỉ phiên Thiết kế đã viết / đang sửa spec này');
    expect((await call('des', 'spec_approve', { path: SPEC, after: 'docs/specs/v25.md' })).err).toBe(false);
    expect(getSpecByPath(db, 'p1', SPEC)).toMatchObject({ state: 'approved', afterId: before.id });
    expect((await call('des', 'spec_approve', { path: SPEC })).text).toContain('không phải bản nháp');
  });
});

describe('v2.9 §6.1 / §5.3 a spec runs its writer\'s workflow', () => {
  const SP = workflowOf('builtin:spec-plan');
  const pin = (sid: string, rev: string, step: string) => db.query('UPDATE session SET workflow_rev = ?, step = ? WHERE id = ?').run(rev, step, sid);
  test('v2.9 §6.1 spec_draft pins the new spec to the session\'s rev and doc step', async () => {
    pin('des', SP.rev, 'plan');
    await call('des', 'spec_draft', { path: SPEC });
    expect(getSpecByPath(db, 'p1', SPEC)).toMatchObject({ workflowRev: SP.rev, step: 'plan' });
  });
  test('v2.9 §5.3 `start: button` → approved, nothing opened (Bắt đầu does it)', async () => {
    pin('des', SP.rev, 'design');
    await call('des', 'spec_draft', { path: SPEC });
    expect(JSON.parse((await call('des', 'spec_approve', { path: SPEC })).text)).toEqual({ path: SPEC, state: 'approved', after: null });
    expect(ports.log.started).toEqual([]);
  });
  test('v2.9 §5.3 `start: auto` (a registered library pack) → approved, then the next step opens at once', async () => {
    const auto = compile(validatePack(packWith({ 'steps/design.md': fm('type: design\nname: Thiết kế\ndocs: docs/specs\nnext: { to: build, start: auto }', 'Viết spec.') })).workflow!);
    registerWorkflow(auto);
    pin('des', auto.rev, 'design');
    await call('des', 'spec_draft', { path: SPEC });
    expect(JSON.parse((await call('des', 'spec_approve', { path: SPEC })).text)).toMatchObject({ path: SPEC, state: 'approved' });
    expect(ports.log.started).toEqual([['p1', SPEC]]);
  });
  test('v29-fw MINOR-4 the refusals name the session\'s own step names', async () => {
    const w = compile(validatePack(packWith({ 'steps/design.md': fm('type: design\nname: Phân tích\ndocs: docs/specs\nnext: { to: build, start: button }', 'Viết spec.') })).workflow!);
    registerWorkflow(w);
    pin('des', w.rev, 'design');
    expect((await call('des', 'spec_approve', { path: 'docs/specs/none.md' })).text).toContain('phiên Phân tích gọi spec_draft');
    expect((await call('des', 'issues_list', { spec: 'docs/specs/none.md' })).text).toContain('đi qua phiên Phân tích');
    await call('des', 'spec_draft', { path: SPEC });
    writeFileSync(join(root, 'docs/specs/b.md'), '# B\n');
    expect((await call('des', 'spec_draft', { path: 'docs/specs/b.md' })).text).toContain('một phiên Phân tích viết một spec — spec khác dùng "+ Spec mới"');
  });
  test('v2.9 §5.3 approved at a step with no next doc / build step → done', async () => {
    const DIRECT = workflowOf('builtin:direct');
    const s = insertSpec(db, { projectId: 'p1', path: SPEC, title: 'X', origin: 'app', designSession: 'des', workflowRev: DIRECT.rev });
    expect(JSON.parse((await call('des', 'spec_approve', { path: SPEC })).text)).toMatchObject({ state: 'done' });
    expect(getSpecByPath(db, 'p1', SPEC)).toMatchObject({ id: s.id, state: 'done', step: null });
  });
});

describe('§5.2-9 spec_amend (D93)', () => {
  test('§5.2-9 only the design session editing the active spec; message to the Build session', async () => {
    const s = active();
    expect((await call('des2', 'spec_amend', { path: SPEC, summary: 'thêm cột' })).err).toBe(true);
    updateSpec(db, s.id, { editSession: 'des2' });
    expect((await call('des2', 'spec_amend', { path: SPEC, summary: 'thêm cột' })).text).toContain('"amend_rev":1');
    expect(ports.log.sent).toEqual([{ sid: 'bld', text: expect.stringContaining(`[cc-slaves] Spec ${SPEC} được bổ sung (lần 1): thêm cột · commit`) }]);
  });
});

describe('§5.2-3 / -5 Build: spec_set_branch, spec_close', () => {
  test('spec_set_branch: own spec accepted, another spec refused, a bad name refused', async () => {
    active();
    insertSpec(db, { projectId: 'p1', path: 'docs/specs/o.md', title: 'o', origin: 'app' });
    expect((await call('bld', 'spec_set_branch', { path: SPEC, branch: 'v29' })).err).toBe(false);
    expect(getSpecByPath(db, 'p1', SPEC)!.branch).toBe('v29');
    expect((await call('bld', 'spec_set_branch', { path: 'docs/specs/o.md', branch: 'v29' })).text).toContain('chỉ gọi spec_set_branch');
    expect((await call('bld', 'spec_set_branch', { path: SPEC, branch: 'a..b' })).text).toContain('không phải tên nhánh');
  });

  test('§5.2-5 spec_close: open issue refused; all closed → done + closeWhenIdle + handoff instruction', async () => {
    const s = active();
    const i = createIssue(db, { projectId: 'p1', kind: 'task', specId: s.id, source: 'spec', title: 'a' });
    expect((await call('bld', 'spec_close', { path: SPEC })).text).toContain(`còn mục mở: ${i.key}`);
    db.query("UPDATE issue SET state = 'done'").run();
    const r = await call('bld', 'spec_close', { path: SPEC });
    expect(r.text).toContain('Viết handoff');
    expect(getSpecByPath(db, 'p1', SPEC)!.state).toBe('done');
    expect(ports.log.closing).toEqual(['bld']);
  });
});

describe('§10.1 spec_output_add', () => {
  test('§10.1 outside the project / a non-http URL refused; file + URL accepted; Chung refused', async () => {
    active();
    expect((await call('bld', 'spec_output_add', { path: SPEC, ref: '/etc/hosts' })).text).toContain('nằm ngoài project');
    expect((await call('bld', 'spec_output_add', { path: SPEC, ref: 'ftp://x/y' })).text).toContain('nằm ngoài project');
    expect((await call('bld', 'spec_output_add', { path: SPEC, ref: SPEC, label: 'spec' })).err).toBe(false);
    expect((await call('des', 'spec_output_add', { path: SPEC, ref: 'http://localhost:5173/x', label: 'proto' })).err).toBe(false);
    expect(db.query('SELECT kind, ref, label, added_by FROM spec_output ORDER BY id').all()).toEqual([
      { kind: 'md', ref: SPEC, label: 'spec', added_by: 'session' },
      { kind: 'link', ref: 'http://localhost:5173/x', label: 'proto', added_by: 'session' },
    ]);
    expect((await call('gen', 'spec_output_add', { path: SPEC, ref: SPEC })).err).toBe(true);
  });
});
