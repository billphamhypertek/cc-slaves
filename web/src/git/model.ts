// spec v2.3 §6.1 / §4.2 / §4.3 the Git column's pure rules: the branch Đang xem preselects, the row order of "Nhánh", what a
// row says about its measurement, the file picked first, and who a "Nhờ …" ask goes to with which sentence (V18).
import type { Tr } from '../../../shared/i18n/core.ts';
import type { GitBranchesResult, GitFileChange, GitSetup, LaneBranch, LaneState, LaneView } from '../../../shared/protocol.ts';
import { selLane, type Selection } from '../lib/inspector.ts';

/** The branch the column shows: the base, or a lane's own branch. */
export type GitPick = { k: 'base' } | { k: 'lane'; lane: string };
/** One lane row of "Nhánh": `state` null = the lane is not in the snapshot (done, paged out). */
export interface LaneRow { lane: string; branch: string; state: LaneState | null; b: LaneBranch | null }

/** The measurement a row shows (§6.1, §7 G5 / G6); `pending` = never measured yet ("đang đo…" the first time). */
export type Measure =
  | { k: 'clean' } | { k: 'conflicts'; n: number } | { k: 'merged' } | { k: 'gone' } | { k: 'noChange' }
  | { k: 'unknown'; reason: string | null } | { k: 'pending' };

const ENDED: ReadonlySet<LaneState> = new Set(['done', 'stopped', 'broken']);
/** §6.1 a lane "còn sống" for the asks: anything but done / stopped / broken (a lane missing from the snapshot is done). */
const laneLive = (s: LaneState | null): boolean => s !== null && !ENDED.has(s);

export function measureOf(b: LaneBranch | null): Measure {
  if (!b) return { k: 'pending' };
  if (b.state === 'gone') return { k: 'gone' };
  if (b.state === 'merged') return { k: 'merged' };
  if (b.state === 'unknown') return { k: 'unknown', reason: b.reason ?? null };
  if (b.state === 'none' || b.ahead === 0) return { k: 'noChange' };
  if (!b.conflicts) return { k: 'pending' };
  return b.conflicts.length ? { k: 'conflicts', n: b.conflicts.length } : { k: 'clean' };
}

const PROGRAM = /^repo configures a program \((.+)\)$/;
/** §10.2 / E1: the engine's English reasons never reach the UI as such — the two it composes are mapped; git's own stderr
 *  line (a tool's output, like v2.1 §4.15) is shown as git wrote it. */
export function reasonText(tr: Tr, reason: string | null | undefined, program?: string): string {
  const key = program ?? PROGRAM.exec(reason ?? '')?.[1];
  if (key) return tr('git.program', { key });
  if (reason === 'timeout') return tr('git.timeout');
  return reason ?? '';
}

/** §4.2 the branch Đang xem preselects: its lane's branch when the lane has one (also with no worktree), else the base. */
export function defaultPick(sel: Selection, lanes: readonly Pick<LaneView, 'name' | 'branch'>[], res: GitBranchesResult | null): GitPick {
  const name = selLane(sel);
  if (name === null) return { k: 'base' };
  if (res?.lanes.some(r => r.lane === name)) return { k: 'lane', lane: name };
  const l = lanes.find(x => x.name === name);
  return l?.branch?.name && l.branch.state !== 'none' && l.branch.state !== 'gone' ? { k: 'lane', lane: name } : { k: 'base' };
}

/** §6.1 rows: every lane `git_branches` lists, plus the viewed lane's branch when only the snapshot knows it (worktree gone, G10). */
export function laneRows(res: GitBranchesResult, lanes: readonly LaneView[], pick: GitPick): LaneRow[] {
  const st = new Map(lanes.map(l => [l.name, l.state] as const));
  const rows: LaneRow[] = res.lanes.map(r => ({ lane: r.lane, branch: r.name, state: st.get(r.lane) ?? null, b: r.branch }));
  if (pick.k === 'lane' && !rows.some(r => r.lane === pick.lane)) {
    const l = lanes.find(x => x.name === pick.lane);
    if (l?.branch?.name) rows.push({ lane: l.name, branch: l.branch.name, state: l.state, b: l.branch });
  }
  return rows;
}

/** §6.1 order: lanes not done in deck order, then done lanes not merged, then deleted branches (dim); merged ones fold apart. */
export function orderRows(rows: readonly LaneRow[], order: readonly string[]): { top: LaneRow[]; merged: LaneRow[] } {
  const at = (r: LaneRow) => { const i = order.indexOf(r.lane); return i < 0 ? order.length : i; };
  const rank = (r: LaneRow) => (r.b?.state === 'gone' ? 2 : r.state === 'done' || r.state === null ? 1 : 0);
  const top = rows.filter(r => r.b?.state !== 'merged').sort((a, b) => rank(a) - rank(b) || at(a) - at(b));
  return { top, merged: rows.filter(r => r.b?.state === 'merged') };
}

/** §6.2 the file picked first: the first conflicted file, else the first one; none for an empty list. */
export function firstFile(files: readonly GitFileChange[]): string | null {
  return (files.find(f => f.conflict) ?? files[0])?.path ?? null;
}

/** §6.1 conflicts first, the rest in git's order. */
export const conflictsFirst = (files: readonly GitFileChange[]): GitFileChange[] =>
  [...files.filter(f => f.conflict), ...files.filter(f => !f.conflict)];

/** Who an ask goes to: Điều phối (the viewed session, resolved by the host) or a lane. */
export type AskWho = { k: 'orch' } | { k: 'lane'; name: string };
export interface Ask { label: string; who: AskWho; text: string; warn?: string }

export interface AskCtx {
  base: string;
  /** the row picked (null = the base) */
  row: LaneRow | null;
  /** uncommitted entries: the lane worktree's (row) or the project dir's (base) */
  dirty: number;
  /** files a merge would conflict on (the row's), for the rebase sentence */
  conflictFiles: readonly string[];
  /** the folder the dirty files sit in: the lane worktree / project dir (absolute, only shown in the sentence) */
  dir: string;
}

/** §6.1 + V18 the "Nhờ …" buttons under Thay đổi: merge / rebase only on a measured result, commit to whoever sits in the folder. */
export function asksFor(tr: Tr, c: AskCtx): Ask[] {
  const out: Ask[] = [];
  const r = c.row;
  if (r) {
    const m = measureOf(r.b), live = laneLive(r.state), b = r.b!;
    if (m.k === 'clean') {
      const n = b.ahead;
      const text = tr('git.askMergeText', { branch: r.branch, commits: n, files: b.files, base: c.base });
      out.push(live
        ? { label: tr('git.askMerge'), who: { k: 'orch' }, text: `${text} ${tr('git.askMergeLive', { lane: r.lane })}`, warn: tr('git.liveWarn', { lane: r.lane, n }) }
        : { label: tr('git.askMerge'), who: { k: 'orch' }, text });
    } else if (m.k === 'conflicts') {
      const files = (b.conflicts ?? c.conflictFiles).join(', ');
      out.push(live
        ? { label: tr('git.askRebase', { lane: r.lane }), who: { k: 'lane', name: r.lane }, text: tr('git.askRebaseText', { branch: r.branch, base: c.base, files }) }
        : { label: tr('git.askFix'), who: { k: 'orch' }, text: tr('git.askFixText', { branch: r.branch, base: c.base, files }) });
    }
  }
  if (c.dirty > 0) {
    if (r && laneLive(r.state)) out.push({ label: tr('git.askCommitLane', { lane: r.lane }), who: { k: 'lane', name: r.lane }, text: tr('git.askCommitLaneText', { lane: r.lane }) });
    else out.push({ label: tr('git.askCommitOrch'), who: { k: 'orch' }, text: tr('git.askCommitOrchText', { src: r ? tr('git.srcWorktree', { lane: r.lane }) : tr('git.srcProject'), path: c.dir }) });
  }
  return out;
}

/** §6.1 Đồ thị filter → the refs of `git_log` ([] = base + every lane branch). */
export type GraphFilter = 'sel' | 'lanes' | 'base';
export function logRefs(f: GraphFilter, base: string | null, branch: string | null): string[] {
  if (f === 'lanes') return [];
  if (!base) return branch && f === 'sel' ? [branch] : [];
  return f === 'sel' && branch ? [base, branch] : [base];
}

/** §6.1 the blocks fold per project (`localStorage`, like the mode, V9). */
export interface Folds { b: boolean; c: boolean; g: boolean }
const FOLDS0: Folds = { b: false, c: false, g: false };
export function foldsOf(raw: string | null, pid: string): Folds {
  try { const all = JSON.parse(raw ?? '{}') as Record<string, Partial<Folds>>; return { ...FOLDS0, ...all[pid] }; } catch { return FOLDS0; }
}
export function withFolds(raw: string | null, pid: string, f: Folds): string {
  let all: Record<string, Folds> = {};
  try { all = JSON.parse(raw ?? '{}') as Record<string, Folds>; } catch { /* a bad entry is replaced */ }
  return JSON.stringify({ ...all, [pid]: f });
}

/** hf1116 (b) G5: the Git tab shows the setup block instead of git's raw error while git is missing or blocked by Xcode's license. */
export const gitBlocked = (g: GitSetup | undefined) => g?.state === 'missing' || g?.state === 'license';
