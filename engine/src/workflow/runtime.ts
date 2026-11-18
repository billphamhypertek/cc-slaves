// spec v2.9 §6.1 the workflow the engine runs: compiled packs by rev (the three built-ins + what library.ts registers: the
// pinned copies of `<home>/workflow-revs/` and the library packs), a project's current workflow, the step a session / lane is pinned to, the prompt hash and the
// one-time update message on resume, and the texts rules.ts and the MCP tool list are parametrised with (§5.6).
import { createHash } from 'node:crypto';
import type { OrchKind, SpecRow } from '../../../shared/issues.ts';
import type { WfRef } from '../../../shared/workflows.ts';
import type { Db } from '../db.ts';
import { KeyedError } from '../errors.ts';
import type { WfText } from '../issues/rules.ts';
import { BUILTIN_SLUGS, builtinFiles, DEFAULT_WORKFLOW } from './builtin/index.ts';
import { compile, type Compiled, type CompiledStep } from './compile.ts';
import { validatePack } from './validate.ts';
import { BOOL_RULES, DONE_ID, type StartMode, type StepType } from './vocab.ts';

const byId = new Map<string, Compiled>();
const byRev = new Map<string, Compiled>();
/** §6.1 the pack name of every rev the engine has seen (a pinned copy that no longer loads still names its pack). */
const revNames = new Map<string, string>();
for (const slug of BUILTIN_SLUGS) {
  const w = validatePack(builtinFiles(slug)).workflow;
  if (!w) throw new Error(`built-in workflow ${slug} does not validate`);
  const c = compile(w);
  byId.set(`builtin:${slug}`, c);
  byRev.set(c.rev, c);
  revNames.set(c.rev, c.name);
}

/** Rulings 22:05: a pinned rev / a workflow id the engine cannot load fails closed (never silently Quy trình PO). */
export class WorkflowMissingError extends KeyedError {
  constructor(m: string) { super('workflow_missing', m); this.name = 'WorkflowMissingError'; }
}

/** library.ts: a compiled rev (a pinned copy, a library pack read now); `id` also makes it that workflow's current rev. A
 *  rev already held keeps its object. */
export function registerWorkflow(c: Compiled, id?: string): void {
  const held = byRev.get(c.rev) ?? c;
  byRev.set(c.rev, held);
  revNames.set(c.rev, c.name);
  if (id !== undefined) byId.set(id, held);
}
/** library.ts: the name of a rev whose copy does not load (index.json), for the fail-closed reason. */
export const nameRev = (rev: string, name: string): void => { if (!revNames.has(rev)) revNames.set(rev, name); };
/** library.ts: a deleted pack has no current rev (its pinned revs stay registered). */
export const dropWorkflow = (id: string): void => { byId.delete(id); };
/** Whether the engine holds a current rev for a workflow id. */
export const hasWorkflow = (id: string): boolean => byId.has(id);

/** The current compiled pack of a workflow id (`builtin:<slug>`, a library slug). */
export function workflowOf(id: string): Compiled {
  const c = byId.get(id);
  if (!c) throw new WorkflowMissingError(`Quy trình "${id}" không có trong thư viện: chọn quy trình khác cho project`);
  return c;
}
const missingRev = (rev: string): string => {
  const name = revNames.get(rev);
  return `Quy trình ${name === undefined ? '(không rõ tên)' : `"${name}"`} bản ${rev.slice(0, 12)} không còn trên máy: phiên ghim bản này không chạy được`;
};
/** §6.1 a pinned rev (registered at boot from `<home>/workflow-revs/`); a spawn reads it here and fails closed. */
export function workflowRev(rev: string): Compiled {
  const c = byRev.get(rev);
  if (c) return c;
  throw new WorkflowMissingError(missingRev(rev));
}
const told = new Set<string>();
let revLog: (line: string) => void = () => {};
/** engine.ts: where readRev logs a missing rev (the engine log). */
export const logMissingRevs = (log: (line: string) => void): void => { revLog = log; };
/** Ruling 22:36 a pinned rev read off the spawn path (an event, a view, a WS reply, an MCP list): null = the engine does
 *  not hold it, the workflow_missing reason logged once per rev; the caller degrades. */
export function readRev(rev: string): Compiled | null {
  const c = byRev.get(rev);
  if (c) return c;
  if (!told.has(rev)) { told.add(rev); revLog(missingRev(rev)); }
  return null;
}

/** §6.1 the project's workflow now (`project.workflow`). */
export function projectWorkflow(db: Db, projectId: string): Compiled {
  const r = db.query<{ workflow: string }, [string]>('SELECT workflow FROM project WHERE id = ?').get(projectId);
  return workflowOf(r?.workflow ?? DEFAULT_WORKFLOW);
}

/** §4.1 the project's workflow id (the Tasks chip). */
export const projectWorkflowId = (db: Db, projectId: string): string =>
  db.query<{ workflow: string }, [string]>('SELECT workflow FROM project WHERE id = ?').get(projectId)?.workflow ?? DEFAULT_WORKFLOW;

/** hf-sp the plugin whose absence gave the project Giao thẳng when it was added (the Tasks hint), null = not so. */
export const projectWorkflowFallback = (db: Db, projectId: string): string | null =>
  db.query<{ f: string | null }, [string]>('SELECT workflow_fallback AS f FROM project WHERE id = ?').get(projectId)?.f ?? null;

/** The first step of a type (chain order: the first doc step for `design`). */
export const stepOf = (c: Compiled, type: StepType): CompiledStep | undefined => c.steps.find((s) => s.type === type);
const mustStep = (c: Compiled, type: StepType): CompiledStep => {
  const s = stepOf(c, type);
  if (!s) throw new Error(`workflow ${c.name} has no ${type} step`);
  return s;
};
const byStepId = (c: Compiled, id: string | null): CompiledStep | undefined => (id === null ? undefined : c.steps.find((s) => s.id === id));

/** §5.3 the step after `id`: `null` = Xong. */
export function nextStep(c: Compiled, id: string): { step: CompiledStep | null; start: StartMode | null } {
  const n = byStepId(c, id)?.next ?? { to: DONE_ID, start: null };
  return { step: n.to === DONE_ID ? null : byStepId(c, n.to) ?? null, start: n.start };
}

/** v2.9 §8 the doc folders of a workflow, one per doc step (scan + Tài liệu), in step order. */
export const docDirs = (c: Compiled): { docs: string; step: string }[] =>
  c.steps.filter((s) => s.type === 'design' && s.docs !== null).map((s) => ({ docs: s.docs!, step: s.id }));

/** The `docs` folder a spec file lives under (its doc step's, else the workflow's first doc step's). */
export function specDocs(c: Compiled, path: string): string {
  const dirs = docDirs(c);
  return dirs.find((d) => path.startsWith(`${d.docs}/`))?.docs ?? dirs[0]?.docs ?? 'docs';
}

export const hashText = (s: string): string => createHash('sha256').update(s).digest('hex');

/** §6.1 the rev + step a new orchestrator session is pinned to: Chung = the project's workflow now; Thiết kế / Build = the
 *  spec's rev (a new spec: the project's), at `step` when given, else the spec's step (Bổ sung on a built spec = the first
 *  doc step), else the first doc step. */
export function newSessionPin(db: Db, projectId: string, kind: OrchKind, spec: SpecRow | null, step?: string): { rev: string; step: string; text: string } {
  const c = spec ? workflowRev(spec.workflowRev) : projectWorkflow(db, projectId);
  const s = kind === 'design' && step !== undefined ? byStepId(c, step)
    : kind === 'design' && spec && spec.state !== 'active' ? byStepId(c, spec.step) ?? stepOf(c, 'design')
      : stepOf(c, kind);
  if (!s) throw new Error(`workflow ${c.name} has no ${step ?? kind} step`);
  return { rev: c.rev, step: s.id, text: s.appendix };
}

interface PinRow {
  kind: 'orchestrator' | 'lane'; project_id: string; orch_kind: OrchKind; step: string | null; workflow_rev: string;
  prompt_hash: string | null; lane_rev: string | null;
}
const findPin = (db: Db, sessionId: string): PinRow | null => db.query<PinRow, [string]>(
  `SELECT s.kind, s.project_id, s.orch_kind, s.step, s.workflow_rev, s.prompt_hash, l.workflow_rev AS lane_rev
     FROM session s LEFT JOIN lane l ON l.session_id = s.id WHERE s.id = ?`,
).get(sessionId);
function pinRow(db: Db, sessionId: string): PinRow {
  const r = findPin(db, sessionId);
  if (!r) throw new Error(`no session ${sessionId}`);
  return r;
}
function pinnedOf(r: PinRow): { workflow: Compiled; step: CompiledStep } {
  if (r.kind === 'lane') { const w = workflowRev(r.lane_rev ?? r.workflow_rev); return { workflow: w, step: mustStep(w, 'lane') }; }
  const w = workflowRev(r.workflow_rev);
  return { workflow: w, step: byStepId(w, r.step) ?? mustStep(w, r.orch_kind) };
}

/** §4.7 the effective config of a step of a rev (null = the engine does not hold the rev, ruling 22:36: views never throw). */
function wfRef(rev: string, step: (c: Compiled) => CompiledStep | undefined): WfRef | null {
  const c = readRev(rev);
  const s = c ? step(c) : undefined;
  if (!c || !s) return null;
  return {
    rev, name: c.name, step: s.id, stepName: s.name, deny: s.deny.map((d) => d.slice('Skill('.length, -1)),
    rules: BOOL_RULES.filter((k) => c.rules[k]), maxDoc: c.rules.max_doc_sessions,
  };
}
/** §4.7 a session's effective config (lane session: its lane's rev); null = no such session / rev. */
export function sessionWf(db: Db, sessionId: string): WfRef | null {
  const r = findPin(db, sessionId);
  if (!r) return null;
  if (r.kind === 'lane') return wfRef(r.lane_rev ?? r.workflow_rev, (c) => stepOf(c, 'lane'));
  return wfRef(r.workflow_rev, (c) => byStepId(c, r.step) ?? stepOf(c, r.orch_kind));
}
/** §4.7 a lane's effective config (the Inspector head). */
export function laneWf(db: Db, projectId: string, name: string): WfRef | null {
  const r = db.query<{ rev: string }, [string, string]>('SELECT workflow_rev AS rev FROM lane WHERE project_id = ? AND name = ?').get(projectId, name);
  return r ? wfRef(r.rev, (c) => stepOf(c, 'lane')) : null;
}

/** §6.1 the workflow + step a session runs (lane: its lane's rev). */
export const sessionStep = (db: Db, sessionId: string): { workflow: Compiled; step: CompiledStep } => pinnedOf(pinRow(db, sessionId));
/** Ruling 22:36 the rev a session runs, read off the spawn path (null = missing, see readRev). */
export function sessionRev(db: Db, sessionId: string): Compiled | null {
  const r = pinRow(db, sessionId);
  return readRev(r.kind === 'lane' ? r.lane_rev ?? r.workflow_rev : r.workflow_rev);
}

/** §6.1 a new lane runs the rev of the session that started it (none / unknown: the project's workflow now). */
export function lanePin(db: Db, projectId: string, laneId: number, sessionId: string, owner: string | null): void {
  const rev = owner === null ? null : db.query<{ r: string }, [string]>('SELECT workflow_rev AS r FROM session WHERE id = ?').get(owner)?.r ?? null;
  const w = rev === null ? projectWorkflow(db, projectId) : workflowRev(rev);
  db.query('UPDATE lane SET workflow_rev = ? WHERE id = ?').run(w.rev, laneId);
  db.query('UPDATE session SET workflow_rev = ?, step = ? WHERE id = ?').run(w.rev, mustStep(w, 'lane').id, sessionId);
}

/** v29-fz the stored hash of a Chung re-pinned between spawns: unequal to every text, its next resume says `Quy trình đổi`. */
const MOVED = 'wf-moved';
/** §6.1 a project changed pack (Áp dụng, Lưu bản mới): its live Chung sessions run the new rev at once, so the lanes they
 *  start next take it; lanes already running keep theirs. */
export function repinChung(db: Db, projectId: string): void {
  const now = projectWorkflow(db, projectId);
  db.query(`UPDATE session SET workflow_rev = ?, step = ?, prompt_hash = ? WHERE project_id = ? AND kind = 'orchestrator'
    AND orch_kind = 'general' AND ended_at IS NULL AND workflow_rev <> ?`).run(now.rev, mustStep(now, 'general').id, MOVED, projectId, now.rev);
}

/**
 * §6.1 at every spawn: the step whose settings + appendix the process gets. A Chung session follows its project's workflow
 * (a change re-pins it, here or earlier in repinChung). On a resume whose stored prompt hash differs, `update` is the text
 * sent once (`Quy trình đổi` after a re-pin; a v2.7-older session's hash differs from every text, so it gets the update once;
 * a NULL hash = unknown, nothing sent unless re-pinned); the hash is stored on a fresh spawn and after an update.
 */
export function spawnPrompt(db: Db, sessionId: string, resume: boolean): { step: CompiledStep; text: string; update: string | null } {
  const r = pinRow(db, sessionId);
  let { step } = pinnedOf(r);
  let moved = r.prompt_hash === MOVED;
  if (r.kind === 'orchestrator' && step.type === 'general') {
    const now = projectWorkflow(db, r.project_id);
    if (now.rev !== r.workflow_rev) {
      step = mustStep(now, 'general');
      moved = true;
      db.query('UPDATE session SET workflow_rev = ?, step = ? WHERE id = ?').run(now.rev, step.id, sessionId);
    }
  }
  const text = step.appendix;
  const hash = hashText(text);
  const update = resume && hash !== r.prompt_hash && (moved || r.prompt_hash !== null)
    ? `[cc-slaves] ${moved ? 'Quy trình đổi' : 'Cập nhật quy tắc điều phối'}: ${text}` : null;
  if (!resume || update !== null) db.query('UPDATE session SET prompt_hash = ? WHERE id = ?').run(hash, sessionId);
  return { step, text, update };
}

const lower = (s: string) => s.toLocaleLowerCase('vi');

/** §5.6 the names rules.ts refusals carry: the document, the step names by type, the "start" label, the rules. */
export function wfText(c: Compiled): WfText {
  const doc = c.steps.filter((s) => s.type === 'design');
  const name = (t: StepType, d: string) => stepOf(c, t)?.name ?? d;
  return {
    doc: lower(c.docLabel), Doc: c.docLabel, rules: c.rules, start: doc.at(-1)?.labels.start ?? 'Bắt đầu',
    names: { design: name('design', 'Thiết kế'), build: name('build', 'Build'), general: name('general', 'Chung') },
  };
}

/** §5.6 / §6.1 the MCP tool texts of a workflow: `{doc}` / `{docs}` / `{design}` / `{build}` + the lane phases. */
export interface ToolText { doc: string; docs: string; phases: readonly string[]; design: string; build: string }
export function toolText(c: Compiled): ToolText {
  const { design, build } = wfText(c).names;
  return { doc: lower(c.docLabel) || 'tài liệu', docs: stepOf(c, 'design')?.docs ?? 'docs', phases: stepOf(c, 'lane')?.phases ?? [], design, build };
}

/** §6.1 the phases of a lane's own rev (null = no such lane, or its rev is missing: no phase check, ruling 22:36). */
export function lanePhases(db: Db, projectId: string, name: string): readonly string[] | null {
  const r = db.query<{ r: string }, [string, string]>('SELECT workflow_rev AS r FROM lane WHERE project_id = ? AND name = ?').get(projectId, name);
  const w = r ? readRev(r.r) : null;
  return w ? mustStep(w, 'lane').phases ?? [] : null;
}
