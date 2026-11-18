// v2.7 §4.3 the issue list, pure: the row's right cluster per lane / issue state (§4.3, §5.7-5, IS2 / IS5 / IS5b / IS6),
// the head's grey line ("· 2 phát sinh thêm · 1 huỷ", "xong 14/11", Ngoài spec), the Bug / Task filter, `↑` (hidden in
// Ngoài spec), the narrow switch (< 1100 px, IS10). Components render what these return.
import type { IssueInfo, ProjectIssues, SpecInfo } from '../../../shared/issues.ts';
import { fmtDayMonth, fmtHm, midnight } from '../lib/format.ts';
import type { Tr } from '../lib/i18n.tsx';
import { isArising, type SpecSel } from '../lib/issues.ts';

/** §6 IS10 under this window width the rail becomes a menu and the detail an overlay. */
const TASKS_NARROW = 1100;
export const isNarrowTasks = (width: number): boolean => width < TASKS_NARROW;

export type IssueFilter = 'all' | 'bug' | 'task';
export const filterIssues = (xs: readonly IssueInfo[], f: IssueFilter): IssueInfo[] => (f === 'all' ? [...xs] : xs.filter(i => i.kind === f));

/** §4.3 `↑` marks an open priority issue (IS5b: not on a cancelled one); in Ngoài spec every issue is priority, so it is not
 *  drawn there (IS6). */
export const showUp = (i: IssueInfo, sel: SpecSel): boolean => i.priority && sel !== 'outside' && (i.state === 'todo' || i.state === 'doing');


/** R11 VN time of a moment: "14:41" today, "15/11" before (lists), or "14/11 15:20" (history, status lines; mockup IS9). */
const dayOrHm = (t: number, now: number): string => (t >= midnight(now) ? fmtHm(t) : fmtDayMonth(t));
export const whenHm = (t: number, now: number): string => (t >= midnight(now) ? fmtHm(t) : `${fmtDayMonth(t)} ${fmtHm(t)}`);

/** "25 phút" / "3 giờ" / "2 ngày": how long a ready issue has waited for a lane (IS2). */
function ageText(ms: number, tr: Tr): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? tr('tasks.list.age.m', { n: m }) : m < 1440 ? tr('tasks.list.age.h', { n: Math.floor(m / 60) }) : tr('tasks.list.age.d', { n: Math.floor(m / 1440) });
}

type ClusterTone = 'warn' | 'bad' | 'new' | null;
export interface Cluster { text: string; tone: ClusterTone }

/** What the cluster needs beyond the issue: the quota reset of a lane, the revert issue of an original, now. */
export interface ClusterCtx {
  tr: Tr; now: number;
  /** the time the lane's account frees room (chờ quota · 15:00); null = unknown */
  quotaAt: (lane: string) => number | null;
  /** the project's issues (the revert issue of `reverts`, the done dependants of a conflict) */
  all: readonly IssueInfo[];
}

const lastEvent = (i: IssueInfo, type: string): number | null => {
  let t: number | null = null;
  for (const e of i.events) if (e.type === type && (t === null || e.ts > t)) t = e.ts;
  return t;
};
/** §5.7-5 the done issues built on `i` (what its revert ran into). */
export const builtOn = (i: IssueInfo, all: readonly IssueInfo[]): string[] =>
  i.blocks.filter(k => all.some(x => x.key === k && x.state === 'done'));
/** §5.7-4 the revert issue of `i` (newest first). */
export const revertIssueOf = (i: IssueInfo, all: readonly IssueInfo[]): IssueInfo | null =>
  all.filter(x => x.reverts === i.key).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

/** §4.3 the lane part of a `doing` row: `D2 · code` / `B3 · chờ PO` (yellow) / `D4 · hỏng` (red) / `C1 · chờ quota · 15:00`. */
export function laneCluster(lane: NonNullable<IssueInfo['lane']>, c: Pick<ClusterCtx, 'tr' | 'quotaAt'>): Cluster {
  const { tr } = c;
  if (lane.state === 'waiting_po') return { text: tr('tasks.list.cl.lane', { lane: lane.name, what: tr('tasks.list.cl.waitPo') }), tone: 'warn' };
  if (lane.state === 'broken') return { text: tr('tasks.list.cl.lane', { lane: lane.name, what: tr('tasks.list.cl.broken') }), tone: 'bad' };
  if (lane.state === 'waiting_quota') {
    const at = c.quotaAt(lane.name);
    const what = at === null ? tr('tasks.list.cl.quota') : tr('tasks.list.cl.quotaAt', { hm: fmtHm(at) });
    return { text: tr('tasks.list.cl.lane', { lane: lane.name, what }), tone: null };
  }
  if (lane.state === 'stopped' || lane.state === 'paused') return { text: tr('tasks.list.cl.lane', { lane: lane.name, what: tr('tasks.list.cl.stopped') }), tone: null };
  return { text: tr('tasks.list.cl.lane', { lane: lane.name, what: lane.phase ?? lane.state }), tone: null };
}

/** §4.3 the one short right cluster of a row, by issue state then lane state. */
export function clusterOf(i: IssueInfo, c: ClusterCtx): Cluster {
  const { tr } = c;
  if (i.revert === 'conflict') {
    const on = builtOn(i, c.all);
    return { text: on.length ? tr('tasks.list.cl.conflictOn', { keys: on.join(', ') }) : tr('tasks.list.cl.conflict'), tone: 'bad' };
  }
  if (i.revert === 'pending' || i.revert === 'running') {
    const r = revertIssueOf(i, c.all);
    return { text: r ? tr('tasks.list.cl.revertingKey', { key: r.key }) : tr('tasks.list.cl.reverting'), tone: null };
  }
  switch (i.state) {
    case 'cancelled': return { text: tr('tasks.list.cl.cancelled', { at: dayOrHm(lastEvent(i, 'cancelled') ?? i.doneAt ?? i.createdAt, c.now) }), tone: null };
    case 'done': {
      const n = i.commits.length;
      return isArising(i) ? { text: tr('tasks.list.cl.doneNew', { n }), tone: 'new' } : { text: tr('tasks.list.cl.commits', { n }), tone: null };
    }
    case 'doing': return i.lane ? laneCluster(i.lane, c) : { text: tr('tasks.list.cl.doing'), tone: null };
    case 'todo': {
      if (i.waitingOn.length) return { text: tr('tasks.list.cl.waiting', { keys: i.waitingOn.join(', ') }), tone: null };
      if (i.source === 'amend') return { text: tr('tasks.list.cl.amend'), tone: null }; // §6 IS19 grey "bổ sung"
      const since = Math.max(i.createdAt, lastEvent(i, 'returned') ?? 0);
      return { text: tr('tasks.list.cl.ready', { left: ageText(c.now - since, tr) }), tone: null };
    }
  }
}

/** §4.3 "phát sinh thêm": issues that arose while building (lane / Điều phối / PO), not reverts, not cancelled. */
const isExtra = (i: IssueInfo) => i.state !== 'cancelled' && i.reverts === null && (i.source === 'lane' || i.source === 'orchestrator' || i.source === 'po');

/** §4.3 the grey line after `8/13` (each part only when > 0); Ngoài spec its own line (IS6); a done spec "xong 14/11" (IS9). */
export function headSub(pi: ProjectIssues, sel: SpecSel, issues: readonly IssueInfo[], tr: Tr, now: number): string {
  if (sel === 'outside') return tr('tasks.list.outsideSub', { n: issues.filter(i => i.state === 'todo' || i.state === 'doing').length });
  const spec = pi.specs.find(s => s.id === sel.spec);
  const parts: string[] = [];
  if (spec?.state === 'done' && spec.doneAt !== null) parts.push(tr('tasks.list.doneAt', { at: dayOrHm(spec.doneAt, now) }));
  const extra = issues.filter(isExtra).length, amend = issues.filter(i => i.state !== 'cancelled' && i.source === 'amend').length;
  const cancelled = issues.filter(i => i.state === 'cancelled').length;
  if (extra) parts.push(tr('tasks.list.extra', { n: extra }));
  if (amend) parts.push(tr('tasks.list.amend', { n: amend }));
  if (cancelled) parts.push(tr('tasks.list.cancelled', { n: cancelled }));
  return parts.join(' · ');
}

/** The spec a selection names (null = Ngoài spec, or gone). */
export const specOfSel = (pi: ProjectIssues, sel: SpecSel): SpecInfo | null => (sel === 'outside' ? null : pi.specs.find(s => s.id === sel.spec) ?? null);

/** §4.3 the default selection: the remembered one while it still exists, else the first building spec, else the first
 *  group with a list (Ngoài spec, Xong), else the first spec. */
export function effectiveSel(pi: ProjectIssues, sel: SpecSel | null): SpecSel | null {
  if (sel === 'outside' && pi.issues.some(i => i.specId === null)) return sel;
  if (sel && sel !== 'outside' && pi.specs.some(s => s.id === sel.spec)) return sel;
  const building = pi.specs.find(s => s.state === 'active');
  if (building) return { spec: building.id };
  if (pi.issues.some(i => i.specId === null)) return 'outside';
  const any = pi.specs.find(s => s.state === 'done') ?? pi.specs[0];
  return any ? { spec: any.id } : null;
}
