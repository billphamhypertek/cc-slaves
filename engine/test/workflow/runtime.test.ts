// spec v2.9 §6.1 (pins: a session / lane / spec keeps its rev; Chung follows the project), §5.3 (next step), §8 (doc folders),
// §5.6 (texts a workflow gives refusals and MCP descriptions) — the engine's view of the packs (workflow/runtime.ts).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { insertLane, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { insertSpec } from '../../src/issues/store.ts';
import { listTools, sessionToolText } from '../../src/mcp/tools.ts';
import { compile } from '../../src/workflow/compile.ts';
import { validatePack } from '../../src/workflow/validate.ts';
import {
  docDirs, hashText, lanePhases, lanePin, logMissingRevs, nameRev, newSessionPin, nextStep, projectWorkflow, registerWorkflow, repinChung, sessionStep, spawnPrompt,
  readRev, specDocs, stepOf, toolText, wfText, WorkflowMissingError, workflowOf, workflowRev, sessionWf, laneWf, projectWorkflowId,
} from '../../src/workflow/runtime.ts';
import { PO } from '../_fixtures/po-pack.ts';
import { fm, packWith } from './_packs.ts';

const SP = workflowOf('builtin:spec-plan');
const DIRECT = workflowOf('builtin:direct');
let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'one', path: '/r/one' });
});
afterEach(() => db.close());

const useWorkflow = (id: string) => db.query("UPDATE project SET workflow = ? WHERE id = 'p1'").run(id);
const orch = (id: string, kind: 'design' | 'build' | 'general', pin: { rev: string; step: string }) => {
  insertSession(db, { id, projectId: 'p1', kind: 'orchestrator', account: null });
  db.query('UPDATE session SET orch_kind = ?, workflow_rev = ?, step = ? WHERE id = ?').run(kind, pin.rev, pin.step, id);
};
const hashOf = (sid: string) => db.query<{ h: string | null }, [string]>('SELECT prompt_hash AS h FROM session WHERE id = ?').get(sid)!.h;

describe('v2.9 §6.1 registry', () => {
  test('v2.9 the three builtins by id and by rev; an unknown id / rev fails closed (rulings 22:05), never Quy trình PO', () => {
    expect([PO.name, SP.name, DIRECT.name]).toEqual(['Quy trình PO', 'Spec + Plan', 'Giao thẳng']);
    expect(workflowRev(SP.rev)).toBe(SP);
    expect(() => workflowOf('builtin:nope')).toThrow('Quy trình "builtin:nope" không có trong thư viện');
    expect(() => workflowRev('f'.repeat(64))).toThrow(`Quy trình (không rõ tên) bản ${'f'.repeat(12)} không còn trên máy`);
  });
  test('v2.9 §6.1 a session pinned to a rev the engine does not hold refuses to spawn, naming the pack + rev', () => {
    const rev = 'e'.repeat(64);
    nameRev(rev, 'Gói đã mất');
    orch('d1', 'design', { rev, step: 'design' });
    expect(() => spawnPrompt(db, 'd1', false)).toThrow(new WorkflowMissingError(`Quy trình "Gói đã mất" bản ${'e'.repeat(12)} không còn trên máy: phiên ghim bản này không chạy được`));
  });
  test('v2.9 registerWorkflow: a rev by rev, with an id also its current rev; a rev already held keeps its object', () => {
    const c = compile(validatePack(packWith({ 'WORKFLOW.md': fm('name: Đăng ký\ndescription: x\ndoc_label: Spec\ndocs_done: done', 'reg') })).workflow!);
    registerWorkflow(c, 'reg-test');
    expect(workflowOf('reg-test')).toBe(c);
    registerWorkflow({ ...c }, 'reg-test-2');
    expect(workflowOf('reg-test-2')).toBe(c);
  });
  test('v2.9 §6.1 a project runs its project.workflow (default builtin:po)', () => {
    expect(projectWorkflow(db, 'p1')).toBe(PO);
    useWorkflow('builtin:direct');
    expect(projectWorkflow(db, 'p1')).toBe(DIRECT);
  });
});

describe('v2.9 §5.3 nextStep', () => {
  const custom = compile(validatePack(packWith({ 'steps/design.md': fm('type: design\nname: Ý tưởng\ndocs: docs/ideas\nnext: { to: done }', 'x'), 'steps/build.md': null })).workflow!);
  const auto = compile(validatePack(packWith({ 'steps/design.md': fm('type: design\nname: Thiết kế\ndocs: docs/specs\nnext: { to: build, start: auto }', 'x') })).workflow!);
  test('v2.9 §5.3 the edge of a step: the next step + its start mode; to Xong → null', () => {
    expect([nextStep(PO, 'design').step?.id, nextStep(PO, 'design').start]).toEqual(['build', 'button']);
    expect([nextStep(SP, 'design').step?.id, nextStep(SP, 'plan').step?.id]).toEqual(['plan', 'build']);
    expect(nextStep(PO, 'build').step).toBeNull();
    expect(nextStep(custom, 'design').step).toBeNull();
    expect(nextStep(auto, 'design').start).toBe('auto');
  });
});

describe('v2.9 §8 doc folders', () => {
  test('v2.9 §8 one folder per doc step; a spec\'s folder is the step folder it lives under', () => {
    expect(docDirs(SP)).toEqual([{ docs: 'docs/specs', step: 'design' }, { docs: 'docs/plans', step: 'plan' }]);
    expect(docDirs(DIRECT)).toEqual([]);
    expect(specDocs(SP, 'docs/plans/2026-x.md')).toBe('docs/plans');
    expect(specDocs(SP, 'elsewhere/x.md')).toBe('docs/specs');
    expect(specDocs(DIRECT, 'x.md')).toBe('docs');
  });
});

describe('v2.9 §5.6 texts', () => {
  test('v2.9 §5.6 PO: Spec / spec, its step names, "Bắt đầu build"; Giao thẳng: no doc label → "tài liệu", its own phases', () => {
    expect(wfText(PO)).toMatchObject({ doc: 'spec', Doc: 'Spec', start: 'Bắt đầu build', names: { design: 'Thiết kế', build: 'Build', general: 'Chung' } });
    expect(toolText(PO)).toEqual({ doc: 'spec', docs: 'docs/specs', phases: ['queue', 'spec', 'code', 'review', 'gate', 'merge', 'done'], design: 'Thiết kế', build: 'Build' });
    expect(toolText(DIRECT)).toEqual({ doc: 'tài liệu', docs: 'docs', phases: ['queue', 'code', 'review', 'done'], design: 'Thiết kế', build: 'Build' });
  });
  test('v29-fw MINOR-4 the MCP descriptions name the steps of the caller\'s workflow, never the v2.7 words', () => {
    const tools = listTools('orchestrator', { ...toolText(PO), design: 'Phân tích', build: 'Thi công' });
    const all = JSON.stringify(tools);
    expect(all).not.toMatch(/Thiết kế|phiên Build|Phiên Build/);
    expect(tools.find((t) => t.name === 'spec_draft')!.description).toStartWith('Phiên Phân tích:');
    expect(tools.find((t) => t.name === 'spec_close')!.description).toStartWith('Phiên Thi công:');
  });
});

describe('v2.9 §6.1 pins', () => {
  test('v2.9 §6.1 a new Chung = the project\'s workflow now; Thiết kế / Build = the spec\'s rev, at the spec\'s step', () => {
    useWorkflow('builtin:spec-plan');
    expect(newSessionPin(db, 'p1', 'general', null)).toEqual({ rev: SP.rev, step: 'general', text: stepOf(SP, 'general')!.appendix });
    expect(newSessionPin(db, 'p1', 'design', null).step).toBe('design');
    const s = insertSpec(db, { projectId: 'p1', path: 'docs/plans/a.md', title: 'A', origin: 'app', workflowRev: PO.rev, step: 'design' });
    expect(newSessionPin(db, 'p1', 'build', s)).toMatchObject({ rev: PO.rev, step: 'build', text: stepOf(PO, 'build')!.appendix });
    const p = insertSpec(db, { projectId: 'p1', path: 'docs/plans/b.md', title: 'B', origin: 'app', workflowRev: SP.rev, step: 'plan' });
    expect(newSessionPin(db, 'p1', 'design', p).step).toBe('plan');
    expect(newSessionPin(db, 'p1', 'design', p, 'design').step).toBe('design');
  });

  test('v2.9 §15 A2 a session spawns by its pinned rev, not the project\'s workflow now', () => {
    orch('b1', 'build', { rev: SP.rev, step: 'build' });
    useWorkflow('builtin:po');
    expect(sessionStep(db, 'b1').workflow).toBe(SP);
    const p = spawnPrompt(db, 'b1', false);
    expect([p.step.id, p.text, p.update]).toEqual(['build', stepOf(SP, 'build')!.appendix, null]);
    expect(hashOf('b1')).toBe(hashText(p.text));
  });

  test('v2.9 §6.1 a resume: same hash / unknown (NULL) hash → nothing sent; a changed text → "Cập nhật quy tắc điều phối" once', () => {
    orch('d1', 'design', { rev: PO.rev, step: 'design' });
    expect(spawnPrompt(db, 'd1', true).update).toBeNull(); // NULL hash = unknown
    expect(hashOf('d1')).toBeNull();
    spawnPrompt(db, 'd1', false);
    expect(spawnPrompt(db, 'd1', true).update).toBeNull();
    db.query("UPDATE session SET prompt_hash = 'old' WHERE id = 'd1'").run();
    expect(spawnPrompt(db, 'd1', true).update).toBe(`[cc-slaves] Cập nhật quy tắc điều phối: ${stepOf(PO, 'design')!.appendix}`);
    expect(spawnPrompt(db, 'd1', true).update).toBeNull();
  });

  test('v2.9 §6.1 Chung follows the project: a changed workflow re-pins it and says "Quy trình đổi" once, even with a NULL hash', () => {
    orch('g1', 'general', { rev: PO.rev, step: 'general' });
    useWorkflow('builtin:direct');
    expect(spawnPrompt(db, 'g1', true).update).toBe(`[cc-slaves] Quy trình đổi: ${stepOf(DIRECT, 'general')!.appendix}`);
    expect(sessionStep(db, 'g1').workflow).toBe(DIRECT);
    expect(spawnPrompt(db, 'g1', true).update).toBeNull();
  });

  test('v29-fz §6.1 repinChung: a live Chung (known hash) runs the project\'s rev at once, its next lane takes it, a running lane keeps its rev; "Quy trình đổi" once', () => {
    orch('g1', 'general', { rev: PO.rev, step: 'general' });
    spawnPrompt(db, 'g1', false); // the PO hash stored
    for (const sid of ['sl1', 'sl2']) insertSession(db, { id: sid, projectId: 'p1', kind: 'lane', account: null });
    const l1 = insertLane(db, { projectId: 'p1', name: 'L1', cwd: '/w/1', sessionId: 'sl1', briefPath: '/b', ownerSession: 'g1' }).id;
    lanePin(db, 'p1', l1, 'sl1', 'g1');
    useWorkflow('builtin:direct');
    repinChung(db, 'p1');
    expect(sessionStep(db, 'g1').workflow).toBe(DIRECT);
    const l2 = insertLane(db, { projectId: 'p1', name: 'L2', cwd: '/w/2', sessionId: 'sl2', briefPath: '/b', ownerSession: 'g1' }).id;
    lanePin(db, 'p1', l2, 'sl2', 'g1');
    expect([laneWf(db, 'p1', 'L1')!.rev, laneWf(db, 'p1', 'L2')!.rev]).toEqual([PO.rev, DIRECT.rev]);
    expect(spawnPrompt(db, 'g1', true).update).toBe(`[cc-slaves] Quy trình đổi: ${stepOf(DIRECT, 'general')!.appendix}`);
    expect(spawnPrompt(db, 'g1', true).update).toBeNull();
  });

  test('v2.9 §6.1 a design session never re-pins when the project changes workflow', () => {
    orch('d1', 'design', { rev: PO.rev, step: 'design' });
    useWorkflow('builtin:spec-plan');
    spawnPrompt(db, 'd1', true);
    expect(sessionStep(db, 'd1').workflow).toBe(PO);
  });

  test('v2.9 §6.1 a lane runs the rev of the session that started it (none: the project\'s), with that rev\'s phases', () => {
    orch('g1', 'general', { rev: DIRECT.rev, step: 'general' });
    for (const [n, sid] of [['L1', 'sl1'], ['L2', 'sl2']] as const) {
      insertSession(db, { id: sid, projectId: 'p1', kind: 'lane', account: null });
      insertLane(db, { projectId: 'p1', name: n, cwd: `/w/${n}`, sessionId: sid, briefPath: '/b.md', state: 'running' });
    }
    const id = (n: string) => db.query<{ id: number }, [string]>('SELECT id FROM lane WHERE name = ?').get(n)!.id;
    lanePin(db, 'p1', id('L1'), 'sl1', 'g1');
    lanePin(db, 'p1', id('L2'), 'sl2', null);
    expect(sessionStep(db, 'sl1')).toMatchObject({ workflow: DIRECT, step: { id: 'lane' } });
    expect(lanePhases(db, 'p1', 'L1')).toEqual(['queue', 'code', 'review', 'done']);
    expect(lanePhases(db, 'p1', 'L2')).toEqual(toolText(PO).phases);
    expect(lanePhases(db, 'p1', 'none')).toBeNull();
  });
});

describe('ruling 22:36 a missing pinned rev off the spawn path degrades, never throws', () => {
  const lost = (c: string) => { const rev = c.repeat(64); nameRev(rev, 'Gói mất'); return rev; };
  test('readRev: null + the workflow_missing reason logged once per rev', () => {
    const lines: string[] = [];
    logMissingRevs((l) => lines.push(l));
    try {
      const rev = lost('1');
      expect(readRev(SP.rev)).toBe(SP);
      expect(readRev(rev)).toBeNull();
      expect(readRev(rev)).toBeNull();
      expect(lines).toEqual([`Quy trình "Gói mất" bản ${'1'.repeat(12)} không còn trên máy: phiên ghim bản này không chạy được`]);
    } finally { logMissingRevs(() => {}); }
  });
  test('lanePhases of a lane pinned to a missing rev: null (no phase check), never throws', () => {
    insertSession(db, { id: 'sl', projectId: 'p1', kind: 'lane', account: null });
    insertLane(db, { projectId: 'p1', name: 'L', cwd: '/w/L', sessionId: 'sl', briefPath: '/b.md', state: 'running' });
    db.query("UPDATE lane SET workflow_rev = ? WHERE name = 'L'").run(lost('2'));
    expect(lanePhases(db, 'p1', 'L')).toBeNull();
  });
  test('MCP tools/list of a session pinned to a missing rev: the default texts, a free-text phase, never throws', () => {
    insertSession(db, { id: 'sl', projectId: 'p1', kind: 'lane', account: null });
    insertLane(db, { projectId: 'p1', name: 'L', cwd: '/w/L', sessionId: 'sl', briefPath: '/b.md', state: 'running' });
    db.query("UPDATE lane SET workflow_rev = ? WHERE name = 'L'").run(lost('3'));
    const x = sessionToolText(db, 'sl');
    expect(x).toEqual({ doc: 'tài liệu', docs: 'docs', phases: [], design: 'Thiết kế', build: 'Build' });
    const set = listTools('lane', x).find((t) => t.name === 'lane_set_phase')!;
    expect(set.inputSchema).toMatchObject({ properties: { phase: { type: 'string' } } });
    expect(JSON.stringify(set.inputSchema)).not.toContain('enum');
  });
});

describe('v2.9 §4.7 effective config on the wire (WfRef)', () => {
  test('v2.9 §4.7 a session names its pack, step, rev, blocked skills and the rules on (PO Build)', () => {
    const build = stepOf(PO, 'build')!;
    orch('b1', 'build', { rev: PO.rev, step: build.id });
    const r = sessionWf(db, 'b1')!;
    expect(r).toMatchObject({ rev: PO.rev, name: 'Quy trình PO', step: 'build', stepName: build.name, maxDoc: 3 });
    expect(r.deny).toEqual(build.deny.map((d) => d.slice('Skill('.length, -1)));
    expect(r.deny.length).toBeGreaterThan(0);
    expect(r.rules).toEqual(['priority_first', 'one_item_per_lane', 'outside_item_new_lane', 'no_recreate_cancelled']);
  });
  test('v2.9 §4.7 Giao thẳng leaves priority_first off; a rev the engine lost gives null (ruling 22:36, never throws)', () => {
    orch('g1', 'general', { rev: DIRECT.rev, step: stepOf(DIRECT, 'general')!.id });
    expect(sessionWf(db, 'g1')!.rules).not.toContain('priority_first');
    orch('x1', 'general', { rev: 'c'.repeat(64), step: 'general' });
    expect(sessionWf(db, 'x1')).toBeNull();
    expect(sessionWf(db, 'nope')).toBeNull();
  });
  test('v2.9 §4.7 a lane names its lane step of its own rev', () => {
    insertSession(db, { id: 'sl', projectId: 'p1', kind: 'lane', account: null });
    const l = insertLane(db, { projectId: 'p1', name: 'L', cwd: '/w/L', sessionId: 'sl', briefPath: '/b.md', state: 'running' });
    db.query('UPDATE lane SET workflow_rev = ? WHERE id = ?').run(DIRECT.rev, l.id);
    expect(laneWf(db, 'p1', 'L')).toMatchObject({ rev: DIRECT.rev, name: 'Giao thẳng', step: 'lane', stepName: stepOf(DIRECT, 'lane')!.name });
    expect(laneWf(db, 'p1', 'none')).toBeNull();
  });
  test('v2.9 §4.1 the project workflow id (the chip)', () => {
    expect(projectWorkflowId(db, 'p1')).toBe('builtin:po');
    useWorkflow('builtin:direct');
    expect(projectWorkflowId(db, 'p1')).toBe('builtin:direct');
  });
});
