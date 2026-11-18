// spec v2.9 §4.2–§4.7 the Quy trình screen's pure part: the pack read back by `workflow_edit` → a model (chain, Chung, Lane,
// rules), the node / edge texts, the default layout, and every canvas change as `workflow_edit` edits (insert a step on an
// edge, remove, connect, rename a new step) with the §5.3 shape rules checked before the change (WF3d), never after.
import type { Tr } from '../../../shared/i18n/core.ts';
import {
  BOOL_RULES, DONE_ID, MAX_DOC_SESSIONS, MAX_DOCS, STEP_ID_RE, STEP_TYPES, type BoolRule, type StartMode, type StepType, type WorkflowDocView,
  type WorkflowEdit, type WorkflowEditResult, type WorkflowRow,
} from '../../../shared/workflows.ts';
import { isObj } from '../../../shared/json.ts';
import type { ProjectIssues } from '../../../shared/issues.ts';
import type { Key } from '../../../shared/i18n/core.ts';

export type WfIssue = WorkflowEditResult['errors'][number];
interface WfDeny { skill: string; reason: string | null }
export interface WfStep {
  id: string; path: string; type: StepType | null; name: string; body: string; fm: Record<string, unknown> | null; readOnly: string[];
  deny: WfDeny[]; next: { to: string; start: StartMode | null } | null; phases: string[] | null; docs: string | null;
  labels: { group?: string; waiting?: string; start?: string };
}
interface WfRules { flags: Record<BoolRule, boolean>; max: number }
export interface WfModel {
  name: string; description: string; docLabel: string; plugins: string[]; rules: WfRules; body: string;
  /** WORKFLOW.md read back (null = its YAML does not parse) and the keys the canvas may not rewrite. */
  wfFm: Record<string, unknown> | null; wfReadOnly: string[];
  steps: WfStep[];
  /** §5.3 the doc / build ids from the head to the last before Xong (a broken chain: what can be followed, then the rest). */
  chain: string[];
  general: WfStep | null; lane: WfStep | null;
}

export const WF_FILE = 'WORKFLOW.md';
export const LAYOUT_FILE = '.layout.json';
const stepPath = (id: string) => `steps/${id}.md`;
const STEP_FILE = /^steps\/([^/]+)\.md$/;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isType = (v: unknown): v is StepType => typeof v === 'string' && (STEP_TYPES as readonly string[]).includes(v);

function denyOf(v: unknown): WfDeny[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): WfDeny[] => (typeof x === 'string' ? [{ skill: x, reason: null }]
    : isObj(x) && typeof x.skill === 'string' ? [{ skill: x.skill, reason: str(x.reason) }] : []));
}
function nextOf(v: unknown): WfStep['next'] {
  if (!isObj(v) || typeof v.to !== 'string') return null;
  return { to: v.to, start: v.start === 'button' || v.start === 'auto' ? v.start : null };
}
function rulesOf(v: unknown): WfRules {
  const r = isObj(v) ? v : {};
  const flags = Object.fromEntries(BOOL_RULES.map(k => [k, r[k] !== false])) as Record<BoolRule, boolean>;
  return { flags, max: typeof r.max_doc_sessions === 'number' ? r.max_doc_sessions : MAX_DOC_SESSIONS.def };
}

function stepOf(path: string, id: string, d: WorkflowDocView): WfStep {
  const f = d.fm ?? {};
  const labels = isObj(f.labels) ? f.labels : {};
  return {
    id, path, type: isType(f.type) ? f.type : null, name: str(f.name) ?? '', body: d.body, fm: d.fm, readOnly: d.readOnly,
    deny: denyOf(f.skills_deny), next: nextOf(f.next), phases: Array.isArray(f.phases) ? f.phases.map(String) : null, docs: str(f.docs),
    labels: { group: str(labels.group) ?? undefined, waiting: str(labels.waiting) ?? undefined, start: str(labels.start) ?? undefined },
  };
}

/** §5.3 follow `next` from the doc / build step nobody points at; whatever is not reached is appended (V7 shows on it). */
function chainOf(steps: readonly WfStep[]): string[] {
  const inChain = steps.filter(s => s.type === 'design' || s.type === 'build');
  const byId = new Map(inChain.map(s => [s.id, s]));
  const targets = new Set(inChain.map(s => s.next?.to));
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = inChain.find(s => !targets.has(s.id));
  while (cur && !seen.has(cur.id)) {
    out.push(cur.id); seen.add(cur.id);
    cur = cur.next ? byId.get(cur.next.to) : undefined;
  }
  for (const s of inChain) if (!seen.has(s.id)) out.push(s.id);
  return out;
}

export function wfModel(docs: Readonly<Record<string, WorkflowDocView>>): WfModel {
  const steps = Object.keys(docs).sort().flatMap(p => { const m = STEP_FILE.exec(p); return m ? [stepOf(p, m[1]!, docs[p]!)] : []; });
  const wf = docs[WF_FILE] ?? { fm: null, body: '', readOnly: [] };
  const f = wf.fm ?? {};
  return {
    name: str(f.name) ?? '', description: str(f.description) ?? '', docLabel: str(f.doc_label) ?? '',
    plugins: Array.isArray(f.require_plugins) ? f.require_plugins.map(String) : [], rules: rulesOf(f.rules), body: wf.body,
    wfFm: wf.fm, wfReadOnly: wf.readOnly, steps, chain: chainOf(steps),
    general: steps.find(s => s.type === 'general') ?? null, lane: steps.find(s => s.type === 'lane') ?? null,
  };
}

export const stepById = (m: WfModel, id: string): WfStep | undefined => m.steps.find(s => s.id === id);
export const docCount = (m: WfModel): number => m.steps.filter(s => s.type === 'design').length;
export const hasBuild = (m: WfModel): boolean => m.steps.some(s => s.type === 'build');
/** §4.2 the name shown for a step: its own, else the type's UI name. */
export const stepName = (tr: Tr, s: WfStep): string => s.name || (s.type ? tr(`workflow.type.${s.type}`) : s.id);

/** §4.9 a check finding in the UI's words: never a file name, a frontmatter key or an internal step type (those stay in the
 *  engine text, shown on hover). V5 names the step type by its UI name; a warning keeps its sentence without the code marks. */
export function issueText(tr: Tr, i: { code: string; msg: string }): string {
  if (i.code === 'W') return i.msg.replace(/`/g, '');
  if (i.code === 'V5') {
    const m = /bước (design|build|general|lane) \(đang có (\d+)\)/.exec(i.msg);
    return m ? tr('workflow.check.V5', { type: tr(`workflow.type.${m[1] as StepType}`), n: Number(m[2]) }) : tr('workflow.check.V5any');
  }
  const k = `workflow.check.${i.code}`;
  const v = tr(k as Key);
  return v === k ? i.msg.replace(/`/g, '') : v;
}

/** §4.2 / NC §1 lines and a rough token count of a body (≈ 4 chars per token, the size line of a node). */
export function bodySize(body: string): { lines: number; tokens: number } {
  const t = body.trim();
  return { lines: t === '' ? 0 : t.split('\n').length, tokens: Math.round(t.length / 4 / 10) * 10 };
}

/** §4.2 "what the step enforces": "chặn 5 skill · không mở lane", Lane "7 pha · chặn 5 skill". */
export function enforceLine(tr: Tr, s: WfStep): string {
  const deny = s.deny.length ? tr('workflow.node.deny', { n: s.deny.length }) : tr('workflow.node.denyNone');
  if (s.type === 'lane') return `${tr('workflow.node.phases', { n: s.phases?.length ?? 0 })} · ${deny}`;
  const lanes = s.type === 'design' ? 'workflow.node.noLane' : s.type === 'general' ? 'workflow.node.ownLane' : 'workflow.node.lanes';
  return `${deny} · ${tr(lanes)}`;
}
export function sizeLine(tr: Tr, s: WfStep): string {
  const z = bodySize(s.body);
  return z.lines === 0 ? tr('workflow.node.empty') : tr('workflow.node.size', { n: z.lines, tok: z.tokens });
}

/** §4.9 the label of the edge leaving `s` (canvas: "duyệt rồi bấm Bắt đầu"; mini map: "bấm Bắt đầu"). */
export function edgeLabel(tr: Tr, s: WfStep, mini = false): string {
  if (s.type === 'build') return tr('workflow.edge.drained');
  if (s.next?.to === DONE_ID) return tr('workflow.edge.approved');
  return tr(s.next?.start === 'auto' ? (mini ? 'workflow.edge.autoMini' : 'workflow.edge.auto') : (mini ? 'workflow.edge.buttonMini' : 'workflow.edge.button'));
}

// ---------- layout (§13 the builder's call: the chain left → right, Chung + Lane below) ----------
export const NODE_W = 200;
export const NODE_H = 64;
export const DONE_H = 40;
const GAP_X = 150;
const ROW_Y = 220;
const LOW_Y = 440;
export type XY = { x: number; y: number };

/** `.layout.json` read leniently: `{ "<id>": { x, y } }`; anything else = no saved place. */
export function parseLayout(text: string | undefined): Record<string, XY> {
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (!isObj(v)) return {};
    return Object.fromEntries(Object.entries(v).flatMap(([k, p]) => (isObj(p) && typeof p.x === 'number' && typeof p.y === 'number' ? [[k, { x: p.x, y: p.y }]] : [])));
  } catch { return {}; }
}

/** Default places, then the saved ones over them. Xong follows the chain; Chung under the head, Lane under Build. A chain step
 *  with no saved place (just dropped on an edge, WF3b) re-flows the chain, Xong and Lane so the new step gets its own slot. */
export function layoutOf(m: WfModel, savedAll: Readonly<Record<string, XY>>): Record<string, XY> {
  const reflow = m.chain.some(id => !savedAll[id]);
  const flow = new Set<string>([...m.chain, DONE_ID, ...(m.lane ? [m.lane.id] : [])]);
  const saved = reflow ? Object.fromEntries(Object.entries(savedAll).filter(([k]) => !flow.has(k))) : savedAll;
  const at: Record<string, XY> = {};
  m.chain.forEach((id, i) => { at[id] = { x: 40 + i * (NODE_W + GAP_X), y: ROW_Y }; });
  at[DONE_ID] = { x: 40 + m.chain.length * (NODE_W + GAP_X), y: ROW_Y + (NODE_H - DONE_H) / 2 }; // centred on the row: a level arrow
  const build = m.chain.find(id => stepById(m, id)?.type === 'build');
  if (m.general) at[m.general.id] = { x: 40, y: LOW_Y };
  if (m.lane) at[m.lane.id] = { x: build ? at[build]!.x : 40 + NODE_W + GAP_X, y: LOW_Y };
  // no doc steps: Xong ends the lane row (Chung → Lane → Xong)
  if (m.lane && !m.chain.length) at[DONE_ID] = { x: at[m.lane.id]!.x + NODE_W + GAP_X, y: LOW_Y + (NODE_H - DONE_H) / 2 };
  m.steps.forEach((s, i) => { at[s.id] ??= { x: 40 + i * 40, y: LOW_Y + 160 }; });
  for (const [k, p] of Object.entries(saved)) if (at[k]) at[k] = p;
  return at;
}

// ---------- edits ----------
const set = (path: string, key: string, value?: unknown): WorkflowEdit => (value === undefined ? { path, key } : { path, key, value });

/** A free step id from a name: Vietnamese marks dropped, `[a-z0-9-]{1,24}`, `-2`… when taken (never `done`). */
export function freeId(m: WfModel, name: string, except?: string): string {
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '') || 'buoc';
  const taken = new Set(m.steps.map(s => s.id).filter(id => id !== except));
  taken.add(DONE_ID);
  if (!taken.has(base) && STEP_ID_RE.test(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** §4.7 "Chèn / xoá / đổi tên bước sau S": S's waiting / start labels named the old next step → back to auto (group stays). */
function resetLabels(s: WfStep): WorkflowEdit[] {
  if (!s.labels.waiting && !s.labels.start) return [];
  const keep = s.labels.group ? { group: s.labels.group } : undefined;
  return [set(s.path, 'labels', keep)];
}
/** §5.3 `start` only on doc → doc / doc → build. */
const startFor = (m: WfModel, to: string, want: StartMode | null): StartMode | null => {
  const t = stepById(m, to);
  return t && (t.type === 'design' || t.type === 'build') ? want ?? 'button' : null;
};
const nextValue = (to: string, start: StartMode | null) => (start ? { to, start } : { to });

export interface WfChange { edits: WorkflowEdit[]; select: string | null; reset: string | null }

/** §5.3 where a dragged block may land: a doc on an edge leaving a doc (or, with no chain yet, on the canvas); Build on the
 *  edge into Xong when there is none. `null` = allowed, else the catalog key of the reason (WF3d). */
export function dropReason(m: WfModel, type: StepType, from: string | null): Key | null {
  if (type === 'general' || type === 'lane') return 'workflow.why.onlyOne';
  if (type === 'design' && docCount(m) >= MAX_DOCS) return 'workflow.why.maxDocs';
  if (type === 'build' && hasBuild(m)) return 'workflow.why.oneBuild';
  if (from === null) return m.chain.length === 0 ? null : 'workflow.why.onEdge';
  const s = stepById(m, from);
  if (!s?.next) return 'workflow.why.onEdge';
  if (s.type === 'build') return 'workflow.why.buildEnd';
  if (type === 'build' && s.next.to !== DONE_ID) return 'workflow.why.buildLast';
  return null;
}

/** v29-ux M10 the keyboard path: Enter on a palette block inserts it into the selected edge (`from`; null = none selected, which
 *  only an empty chain takes); else the reason — with no edge selected, how to pick one. */
export function keyInsertReason(m: WfModel, type: StepType, from: string | null): Key | null {
  const r = dropReason(m, type, from);
  return r === 'workflow.why.onEdge' && from === null ? 'workflow.why.pickEdge' : r;
}

/** WF3a drop a new step on the edge leaving `from` (or, `from` null, as the first doc of an empty chain). */
export function insertStep(tr: Tr, m: WfModel, type: 'design' | 'build', from: string | null): WfChange {
  const name = tr(type === 'design' ? 'workflow.type.design' : 'workflow.type.build');
  const id = freeId(m, type === 'design' ? 'doc' : 'build');
  const path = stepPath(id);
  const src = from ? stepById(m, from) : undefined;
  const to = src?.next?.to ?? DONE_ID;
  const edits: WorkflowEdit[] = [{ path, text: '' }, set(path, 'type', type), set(path, 'name', name)];
  if (type === 'design') edits.push(set(path, 'docs', `docs/${id}`));
  edits.push(set(path, 'next', nextValue(to, type === 'design' ? startFor(m, to, src?.next?.start ?? null) : null)));
  if (src) edits.push(...resetLabels(src), set(src.path, 'next', nextValue(id, src.type === 'design' ? src.next?.start ?? 'button' : null)));
  if (!src && !m.docLabel && type === 'design') edits.push(set(WF_FILE, 'doc_label', tr('workflow.defaultDocLabel')));
  return { edits, select: id, reset: src && resetLabels(src).length ? src.id : null };
}

/** Remove a doc / build step; the step before it points at what came after (start kept only where §5.3 allows it). */
export function removeStep(m: WfModel, id: string): WfChange {
  const s = stepById(m, id);
  if (!s || (s.type !== 'design' && s.type !== 'build')) return { edits: [], select: null, reset: null };
  const prev = m.steps.find(x => x.next?.to === id);
  const edits: WorkflowEdit[] = [{ path: s.path, text: null }];
  const after = s.next?.to ?? DONE_ID;
  if (prev) edits.push(...resetLabels(prev), set(prev.path, 'next', nextValue(after, prev.type === 'design' ? startFor(m, after, prev.next?.start ?? null) : null)));
  return { edits, select: null, reset: prev && resetLabels(prev).length ? prev.id : null };
}

/** WF3d a dragged connection `from → to`: null = allowed, else the catalog key of the reason. The result must stay one
 *  straight chain (no branch, no loop), Build only into Xong, Chung / Lane never in it. */
export function connectReason(m: WfModel, from: string, to: string): Key | null {
  const s = stepById(m, from);
  if (!s || s.type === 'general' || s.type === 'lane') return 'workflow.why.outside';
  if (s.type === 'build' && to !== DONE_ID) return 'workflow.why.buildEnd';
  if (to === from) return 'workflow.why.loop';
  const t = to === DONE_ID ? null : stepById(m, to);
  if (to !== DONE_ID && (!t || t.type === 'general' || t.type === 'lane')) return 'workflow.why.outside';
  if (t?.type === 'design' && m.steps.some(x => x.type === 'build' && m.chain.indexOf(x.id) < m.chain.indexOf(to))) return 'workflow.why.afterBuild';
  if (m.steps.some(x => x.id !== from && x.next?.to === to && to !== DONE_ID)) return 'workflow.why.oneIn';
  let cur = t;
  for (let i = 0; cur && i < m.steps.length + 1; i++) {
    if (cur.id === from) return 'workflow.why.loop';
    cur = cur.next ? stepById(m, cur.next.to) : undefined;
  }
  return null;
}
export function connect(m: WfModel, from: string, to: string): WfChange {
  const s = stepById(m, from)!;
  return { edits: [...resetLabels(s), set(s.path, 'next', nextValue(to, s.type === 'design' ? startFor(m, to, s.next?.start ?? null) : null))], select: null, reset: resetLabels(s).length ? s.id : null };
}

/** §4.3 a step still only on the canvas takes its file name from its first name (WF3b "Plan" → steps/plan.md). */
export function renameNew(m: WfModel, files: Readonly<Record<string, string>>, id: string, name: string): WfChange | null {
  const s = stepById(m, id);
  const want = freeId(m, name, id);
  if (!s || want === id || name.trim() === '') return null;
  const path = stepPath(want);
  const edits: WorkflowEdit[] = [{ path: s.path, text: null }, { path, text: files[s.path] ?? '' }];
  if (s.type === 'design' && s.docs === `docs/${id}`) edits.push(set(path, 'docs', `docs/${want}`));
  for (const x of m.steps) if (x.next?.to === id) edits.push(set(x.path, 'next', nextValue(want, x.next.start)));
  return { edits, select: want, reset: null };
}

/** §4.6 the impact line before a save: "Lưu → 2 project đang dùng gói này chạy bản mới · 1 tài liệu đang làm giữ bản cũ";
 *  "chưa dùng ở project nào" when none. `docs` = the open (not done) docs of those projects (they keep their rev, R6). */
export function impactLine(tr: Tr, row: WorkflowRow | null, issues: readonly ProjectIssues[]): string {
  const used = row?.usedBy ?? [];
  if (!used.length) return tr('workflow.impact.none');
  const ids = new Set(used.map(u => u.id));
  const docs = issues.filter(p => ids.has(p.projectId)).flatMap(p => p.specs).filter(sp => sp.state !== 'done').length;
  return [tr('workflow.impact.used', { n: used.length }), ...(docs ? [tr('workflow.impact.docs', { n: docs })] : [])].join(' · ');
}

/** §4.7 / WF3c the Tasks tab groups the chain makes: "Đang thiết kế → Chờ plan [Bắt đầu plan] → Đang plan → … → Xong". */
export function tasksFlow(tr: Tr, m: WfModel): string {
  const low = (s: string) => s.toLocaleLowerCase('vi');
  const parts: string[] = [];
  for (const id of m.chain) {
    const s = stepById(m, id)!;
    parts.push(s.labels.group ?? tr('workflow.flow.doing', { step: low(stepName(tr, s)) }));
    const nx = s.next && s.next.to !== DONE_ID ? stepById(m, s.next.to) : undefined;
    if (s.type === 'design' && nx && s.next?.start !== 'auto') {
      const wait = s.labels.waiting ?? tr('workflow.flow.waiting', { step: low(stepName(tr, nx)) });
      parts.push(`${wait} [${s.labels.start ?? tr('workflow.flow.start', { step: low(stepName(tr, nx)) })}]`);
    }
  }
  parts.push(m.docLabel ? tr('workflow.flow.outside', { doc: low(m.docLabel) }) : tr('workflow.flow.items'), tr('workflow.done'));
  return parts.join(' → ');
}

/** §4.2 the library column: built-ins, then the user's packs. */
export function libraryGroups(rows: readonly WorkflowRow[]): { builtin: WorkflowRow[]; user: WorkflowRow[] } {
  return { builtin: rows.filter(r => r.builtin), user: rows.filter(r => !r.builtin) };
}
/** §4.2 / §6.2 a row's second line: "lỗi" (red) · "mẫu gốc có bản mới" · "dùng ở 2 project" · "chưa dùng". */
export function rowSub(tr: Tr, r: WorkflowRow): { text: string; bad: boolean } {
  if (r.errors.length) return { text: tr('workflow.row.broken'), bad: true };
  if (r.baseOutdated) return { text: tr('workflow.row.outdated'), bad: false };
  return { text: r.usedBy.length ? tr('workflow.row.used', { n: r.usedBy.length }) : tr('workflow.row.unused'), bad: false };
}

/** §4.3 a blocked skill that is no longer installed: plugin skills as `<plugin>:<name>`, user / project skills bare. */
export function installedSkills(rows: readonly { scope: string; id: string; name: string }[]): Set<string> {
  return new Set(rows.map(r => (r.scope === 'plugin' ? `${r.id.split(':')[1]?.split('@')[0] ?? ''}:${r.name}` : r.name)));
}

/** Two file maps hold the same text (dirty = the page differs from what was opened). */
export function sameFiles(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => b[k] === a[k]);
}
