// v2.7 Tasks store slice (spec §4.3, §4.2-2, §5.6, §10.1): specs / issues per project as the snapshot carries them
// (`Snapshot.issues`, Mac channel only) kept fresh by `spec_changed` / `issue_changed`; the rail groups and list blocks in
// their fixed order; unseen; progress through the one rule (`progressOf`); the typed senders of every Mac-only command;
// what the Tasks tab remembers per project. Pure: the store calls `applyIssueEvent`, components read the selectors.
import {
  progressOf, type IssueCancelPreview, type IssueCancelResult, type IssueEngineEvent, type IssueFileData, type IssueInfo, type PriorSession, type Progress,
  type ProjectIssues, type SpecInfo, type SpecOutput, type StartPicks,
} from '../../../shared/issues.ts';
import type { Command, Snapshot } from '../../../shared/protocol.ts';
import type { RailSlots, SlotKind } from './wf-tasks.ts';

// ---------- the slice: snapshot entry per project + events ----------
const emptyProject = (projectId: string): ProjectIssues =>
  ({ projectId, specs: [], issues: [], outside: { done: 0, total: 0, scope: 0, cancelled: 0, amend: 0 } });

const upsertById = <T extends { id: number }>(xs: readonly T[], x: T): T[] => {
  const i = xs.findIndex(y => y.id === x.id);
  if (i < 0) return [...xs, x];
  const next = xs.slice();
  next[i] = x;
  return next;
};

/** §10.1 one `spec_changed` / `issue_changed`: upsert into its project (an entry the snapshot did not have is created). */
export function applyIssueEvent(list: readonly ProjectIssues[] | undefined, e: IssueEngineEvent): ProjectIssues[] {
  const pid = e.type === 'spec_changed' ? e.spec.projectId : e.issue.projectId;
  const all = list ? list.slice() : [];
  const i = all.findIndex(p => p.projectId === pid);
  const cur = i < 0 ? emptyProject(pid) : all[i]!;
  const next = e.type === 'spec_changed' ? { ...cur, specs: upsertById(cur.specs, e.spec) } : { ...cur, issues: upsertById(cur.issues, e.issue) };
  if (i < 0) all.push(next); else all[i] = next;
  return all;
}

/** hf1117-perf a `project` event: a project the list does not have yet (just added) gets its empty entry, so Tasks paints
 *  IS8 at once instead of the skeleton until the `spec_scan` ack; specs the add's scan found follow as `spec_changed`. */
export const withProjectEntry = (list: ProjectIssues[], pid: string): ProjectIssues[] =>
  (list.some(p => p.projectId === pid) ? list : [...list, emptyProject(pid)]);

/** The project's specs + issues; null = none in this snapshot (remote channel, or not seen yet). */
export const projectIssues = (snap: Snapshot | null, pid: string | null): ProjectIssues | null =>
  (pid && snap?.issues?.find(p => p.projectId === pid)) || null;

// ---------- §4.3 / v2.9 §4.7 rail: spec groups by the pack's steps ----------
type SpecGroup = SlotKind | 'outside' | 'done';
/** §4.3 "Xong": always the 5 newest + "Xem thêm n"; the list's Xong block likewise. */
const DONE_SHOWN = 5;

export interface RailGroup {
  group: SpecGroup;
  /** v2.9 §4.7 the heading (the pack's label of the step, "Ngoài spec" / "Việc", "Xong"). */
  label: string;
  /** v2.9 §4.7 a waiting group's start button ("Bắt đầu build"); null elsewhere. */
  start: string | null;
  /** `outside` has none: it is one row ("Bug & việc lẻ" + open count). */
  specs: SpecInfo[];
  /** "Xem thêm n" (only `done`, while folded). */
  more: number;
  /** `outside`: its open issues (not done / cancelled). */
  open: number;
}

/** What the list / progress shows: one spec, or the issues outside every spec. */
export type SpecSel = { spec: number } | 'outside';

const isOpen = (i: IssueInfo) => i.state === 'todo' || i.state === 'doing';
const outsideIssues = (pi: ProjectIssues): IssueInfo[] => pi.issues.filter(i => i.specId === null);

/** §4.3 / v2.9 §4.7 the rail: one group per doc step and its waiting group (chain order of the project's workflow, then
 *  any other label a spec of an older rev carries), the build group, Ngoài <doc>, Xong; an empty group is not shown —
 *  except "Việc" of a pack with no document. Within a group by creation; Xong newest first (`doneAt`). */
export function specRail(pi: ProjectIssues, slots: RailSlots, o: { doneOpen?: boolean } = {}): RailGroup[] {
  const open = new Map<string, RailGroup>();
  const done: SpecInfo[] = [];
  for (const s of [...pi.specs].sort((a, b) => a.createdAt - b.createdAt)) {
    if (s.state === 'done') { done.push(s); continue; }
    const sl = slots.slot(s), k = `${sl.kind}\n${sl.label}`;
    const g = open.get(k);
    if (g) g.specs.push(s); else open.set(k, { group: sl.kind, label: sl.label, start: sl.start, specs: [s], more: 0, open: 0 });
  }
  // a label outside the project's chain now (a spec kept on its old rev, §4.6): after the chain, in lifecycle order
  const rank = (g: RailGroup) => { const i = slots.order.indexOf(g.label); return g.group === 'building' ? 1e6 : i < 0 ? 1e5 + (g.group === 'ready' ? 1 : 0) : i; };
  const out = [...open.values()].sort((a, b) => rank(a) - rank(b));
  const xs = outsideIssues(pi);
  if (xs.length || slots.docless) out.push({ group: 'outside', label: slots.outside, start: null, specs: [], more: 0, open: xs.filter(isOpen).length });
  if (done.length) {
    let specs = done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)), more = 0;
    if (!o.doneOpen && specs.length > DONE_SHOWN) { more = specs.length - DONE_SHOWN; specs = specs.slice(0, DONE_SHOWN); }
    out.push({ group: 'done', label: slots.done, start: null, specs, more, open: 0 });
  }
  return out;
}

export function issuesOf(pi: ProjectIssues, sel: SpecSel): IssueInfo[] {
  return sel === 'outside' ? outsideIssues(pi) : pi.issues.filter(i => i.specId === sel.spec);
}

/** §4.2-2 THE progress rule for a spec / the outside group (the Deck head strip uses the same `progressOf`). */
export const progressFor = (pi: ProjectIssues, sel: SpecSel): Progress => progressOf(issuesOf(pi, sel));

// ---------- §4.3 list blocks, fixed order ----------
export type IssueBlock = 'arising' | 'doing' | 'ready' | 'blocked' | 'done' | 'cancelled';
const BLOCKS: readonly IssueBlock[] = ['arising', 'doing', 'ready', 'blocked', 'done', 'cancelled'];
export interface BlockRows { block: IssueBlock; issues: IssueInfo[]; more: number }

/** §5.6 an issue that arose while building (lane / Điều phối) and the PO has not looked at yet (the engine rule:
 *  `issues/cards.ts:29` / `store.ts:327` `unseenCount`). */
export const isArising = (i: IssueInfo): boolean => !i.poSeen && i.state !== 'cancelled';
export const unseenCount = (pi: ProjectIssues): number => pi.issues.filter(isArising).length;
/** §4.1 the orange dot on the Tasks tab. */
export const hasUnseen = (snap: Snapshot | null, pid: string | null): boolean => {
  const pi = projectIssues(snap, pid);
  return !!pi && unseenCount(pi) > 0;
};

function blockOf(i: IssueInfo, arising: boolean): IssueBlock {
  if (arising && isArising(i)) return 'arising';
  if (i.state === 'doing') return 'doing';
  if (i.state === 'done') return 'done';
  if (i.state === 'cancelled') return 'cancelled';
  return i.waitingOn.length ? 'blocked' : 'ready';
}
const keyNum = (i: IssueInfo) => Number(i.key.slice(2)) || 0;
/** §5.4 (R-B19 M1) every open block: priority first, then key number. */
const openOrder = (a: IssueInfo, b: IssueInfo) => Number(b.priority) - Number(a.priority) || keyNum(a) - keyNum(b);

/** §4.3 Phát sinh (only when filtered from the card: unseen issues, out of their own block) · Đang làm · Sẵn sàng · Bị chặn ·
 *  Xong (5 newest + more) · Huỷ. An empty block is not listed. Open blocks priority first, then key number; Xong / Huỷ
 *  newest first. */
export function issueBlocks(issues: readonly IssueInfo[], o: { arising?: boolean; doneOpen?: boolean } = {}): BlockRows[] {
  const by = new Map<IssueBlock, IssueInfo[]>();
  for (const i of issues) {
    const b = blockOf(i, !!o.arising), xs = by.get(b);
    if (xs) xs.push(i); else by.set(b, [i]);
  }
  const out: BlockRows[] = [];
  for (const block of BLOCKS) {
    let xs = by.get(block);
    if (!xs?.length) continue;
    xs = block === 'done' || block === 'cancelled'
      ? xs.sort((a, b) => (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt))
      : xs.sort(openOrder);
    let more = 0;
    if (block === 'done' && !o.doneOpen && xs.length > DONE_SHOWN) { more = xs.length - DONE_SHOWN; xs = xs.slice(0, DONE_SHOWN); }
    out.push({ block, issues: xs, more });
  }
  return out;
}

// ---------- §10.1 + R-B12 the Mac-only commands: one typed home ----------
type Send = (c: Command) => Promise<unknown>;
/** Typed senders for one project (keys and spec paths are per project). Acks per `IssueCommand` in shared/issues.ts. */
export function issueCmds(send: Send, projectId: string) {
  const run = <T>(c: Command) => send(c) as Promise<T>;
  return {
    ok: (key: string) => run<void>({ cmd: 'issue_ok', projectId, key }),
    seen: (key: string) => run<void>({ cmd: 'issue_seen', projectId, key }),
    /** v2.7.1 §7.4 `picks` = the start dialog's account / model / effort (absent = the defaults, the split button's main part). */
    specNew: (picks?: StartPicks) => run<{ sessionId: string }>({ cmd: 'spec_new', projectId, ...picks }),
    specBuild: (path: string, resume?: string, picks?: StartPicks) => run<{ sessionId: string }>({ cmd: 'spec_build', projectId, path, ...(resume ? { resume } : {}), ...picks }),
    specEdit: (path: string, picks?: StartPicks) => run<{ sessionId: string }>({ cmd: 'spec_edit', projectId, path, ...picks }),
    specMark: (path: string, state: 'draft' | 'approved') => run<SpecInfo>({ cmd: 'spec_mark', projectId, path, state }),
    specScan: () => run<{ imported: number; moved: number }>({ cmd: 'spec_scan', projectId }),
    specImportHide: () => run<void>({ cmd: 'spec_import_hide', projectId }),
    priorSessions: (path: string) => run<PriorSession[]>({ cmd: 'spec_prior_sessions', projectId, path }),
    outputs: (path: string) => run<SpecOutput[]>({ cmd: 'spec_outputs', projectId, path }),
    cancelPreview: (key: string) => run<IssueCancelPreview>({ cmd: 'issue_cancel_preview', projectId, key }),
    cancel: (key: string, reason?: string) => run<IssueCancelResult>({ cmd: 'issue_cancel', projectId, key, ...(reason ? { reason } : {}) }),
    file: (key: string, id: number) => run<IssueFileData>({ cmd: 'issue_file', projectId, key, id }),
  };
}
export type IssueCmds = ReturnType<typeof issueCmds>;

// ---------- §4.3 remembered per project (localStorage `ccs.tasks`, convenience only) ----------
export interface TasksUi {
  /** the rail choice (null = the default: the first building spec) */
  sel: SpecSel | null;
  /** the open issue key (detail) */
  issue: string | null;
  /** list Xong block / rail Xong group / list Huỷ block unfolded */
  doneOpen: boolean; specDoneOpen: boolean; cancelledOpen: boolean;
  /** list blocks the PO folded (Huỷ is folded unless `cancelledOpen`) */
  folded: IssueBlock[];
  /** §4.3 the list came from the `issues_new` card: the Phát sinh block shows (cleared by a filter / spec pick) */
  arising: boolean;
}
const TASKS_KEY = 'ccs.tasks';
type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;
const UI0: TasksUi = { sel: null, issue: null, doneOpen: false, specDoneOpen: false, cancelledOpen: false, folded: [], arising: false };

function readAll(s: KeyStore | null): Record<string, unknown> {
  try { const v: unknown = JSON.parse(s?.getItem(TASKS_KEY) ?? '{}'); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}
const selOf = (v: unknown): SpecSel | null =>
  (v === 'outside' ? 'outside' : v && typeof v === 'object' && typeof (v as { spec?: unknown }).spec === 'number' ? { spec: (v as { spec: number }).spec } : null);

export function readTasksUi(s: KeyStore | null, pid: string): TasksUi {
  const v = readAll(s)[pid];
  if (!v || typeof v !== 'object') return UI0;
  const o = v as Record<string, unknown>;
  const folded = Array.isArray(o.folded) ? o.folded.filter((b): b is IssueBlock => (BLOCKS as readonly unknown[]).includes(b)) : [];
  return { sel: selOf(o.sel), issue: typeof o.issue === 'string' ? o.issue : null, doneOpen: o.doneOpen === true, specDoneOpen: o.specDoneOpen === true,
    cancelledOpen: o.cancelledOpen === true, folded, arising: o.arising === true };
}
export function writeTasksUi(s: KeyStore | null, pid: string, ui: TasksUi): void {
  try { s?.setItem(TASKS_KEY, JSON.stringify({ ...readAll(s), [pid]: ui })); } catch { /* private mode */ }
}
