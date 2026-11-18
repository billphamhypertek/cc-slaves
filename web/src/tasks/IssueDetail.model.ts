// v2.7 §4.3 the issue detail, pure: "Lịch sử" in plain Vietnamese from the structured events (§5.1; R-B11 "PO huỷ (hoàn
// tác)"), the table rows (Trạng thái, Nguồn, Lane, Ưu tiên, Bị chặn bởi / Đang chặn, Commit), which buttons show (Huỷ /
// Cho làm, §5.6, §5.7-5) and §5.6 seen-on-leave (R19): the issue counts as seen when the PO leaves it, not when it opens.
import type { IssueInfo, SpecInfo } from '../../../shared/issues.ts';
import type { AccountView, CardView, LaneView } from '../../../shared/protocol.ts';
import { fmtHm, resetAt, shortEmail } from '../lib/format.ts';
import type { Tr } from '../lib/i18n.tsx';
import { isArising } from '../lib/issues.ts';
import { specShort } from '../lib/traces.ts';
import { builtOn, laneCluster, revertIssueOf, whenHm } from './IssueList.model.ts';

export interface DetailCtx {
  tr: Tr; now: number;
  /** the issue's spec (null = Ngoài spec) */
  spec: SpecInfo | null;
  all: readonly IssueInfo[];
  quotaAt: (lane: string) => number | null;
  /** the live lane rows of the project (account of the lane) */
  lanes: readonly LaneView[];
}

export interface HistoryLine { ts: number; at: string; text: string }

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const quoted = (tr: Tr, v: unknown) => { const r = str(v); return r ? tr('tasks.detail.h.reason', { reason: r }) : ''; };

function createdText(i: IssueInfo, x: DetailCtx): string {
  const { tr } = x;
  if (i.reverts) return tr('tasks.detail.h.createdRevert', { key: i.reverts });
  switch (i.source) {
    case 'spec': return x.spec ? tr('tasks.detail.h.createdSpec', { spec: specShort(x.spec.title) }) : tr('tasks.detail.h.created');
    case 'amend': return tr('tasks.detail.h.createdAmend');
    case 'po': return i.kind === 'bug' ? tr('tasks.detail.h.createdPoBug') : tr('tasks.detail.h.createdPo');
    case 'lane': return i.sourceIssue ? tr('tasks.detail.h.createdLaneOn', { lane: i.sourceLane ?? '?', key: i.sourceIssue }) : tr('tasks.detail.h.createdLane', { lane: i.sourceLane ?? '?' });
    case 'orchestrator': return tr('tasks.detail.h.createdOrch');
    case 'prior': return tr('tasks.detail.h.createdPrior');
  }
}

function eventText(i: IssueInfo, e: IssueInfo['events'][number], x: DetailCtx): string | null {
  const { tr } = x, d = e.data;
  switch (e.type) {
    case 'created': return createdText(i, x);
    case 'taken': { // §4.3 "Điều phối mở lane R5 (ưu tiên)"
      const l = str(d.lane), pri = i.specId !== null && i.priority ? tr('tasks.detail.h.priority') : '';
      return (l ? tr('tasks.detail.h.taken', { lane: l }) : tr('tasks.detail.h.takenBare')) + pri;
    }
    case 'returned': return tr('tasks.detail.h.returned', { lane: str(d.lane) ?? '?', reason: quoted(tr, d.reason) });
    case 'done': return tr('tasks.detail.h.done', { n: Array.isArray(d.commits) ? d.commits.length : 0 });
    case 'updated': {
      const f = Array.isArray(d.fields) ? d.fields.filter(k => k !== 'commits') : [];
      return f.length ? tr('tasks.detail.h.updated') : null; // commits show as their own lines
    }
    case 'cancelled':
      // R-B11 a PO cancel of a done issue keeps it done while its revert runs (and after "Giữ"): it reads "(hoàn tác)"
      if (d.by === 'po') return (i.state === 'done' || i.revert !== 'none' ? tr('tasks.detail.h.cancelRevert') : tr('tasks.detail.h.cancelPo')) + quoted(tr, d.reason);
      return tr('tasks.detail.h.dropped') + quoted(tr, d.reason);
    case 'revert': {
      const r = revertIssueOf(i, x.all);
      if (d.to === 'pending') return tr('tasks.detail.h.revertPending');
      if (d.to === 'running') return !r ? tr('tasks.detail.h.revertPending')
        : r.lane ? tr('tasks.detail.h.revertRunningLane', { key: r.key, lane: r.lane.name }) : tr('tasks.detail.h.revertRunning', { key: r.key });
      if (d.to === 'conflict') { // IS5b "R6 dừng: T-53 đã xây trên T-46 · T-54 huỷ" (the blocker = the engine's: newest done dependant)
        const b = blockerOf(i, x.all);
        return r?.lane && b ? tr('tasks.detail.h.revertConflictOn', { lane: r.lane.name, blocker: b, key: i.key, revert: r.key }) : tr('tasks.detail.h.revertConflict');
      }
      if (d.to === 'done') return tr('tasks.detail.h.revertDone');
      if (d.to === 'none') return tr('tasks.detail.h.revertKept', { key: i.key });
      return null;
    }
    case 'po_ok': return tr('tasks.detail.h.poOk');
    default: return null;
  }
}

/** §5.7-5 the done issue a revert of `i` ran into: its newest done dependant (the engine's `blocker`). */
function blockerOf(i: IssueInfo, all: readonly IssueInfo[]): string | null {
  const num = (k: string) => Number(k.slice(2));
  return i.blocks.filter(k => all.find(y => y.key === k)?.state === 'done').sort((a, b) => num(b) - num(a))[0] ?? null;
}

/** §4.3 "Lịch sử": events + the commits (`D2 commit e07b31d`), oldest first, VN time (today HH:MM, else dd/mm HH:MM); a commit
 *  sits before the "Xong" of the same minute (UX-M5). */
export function historyLines(i: IssueInfo, x: DetailCtx): HistoryLine[] {
  const rows: { ts: number; text: string; first?: true }[] = [];
  for (const e of i.events) { const text = eventText(i, e, x); if (text) rows.push({ ts: e.ts, text }); }
  // the issues a lane logged while doing this one ("D2 ghi thêm việc phát sinh B-50")
  for (const y of x.all) if (y.sourceIssue === i.key) rows.push({ ts: y.createdAt, text: y.sourceLane ? x.tr('tasks.detail.h.spawned', { lane: y.sourceLane, key: y.key }) : x.tr('tasks.detail.h.spawnedBare', { key: y.key }) });
  const lane = i.lane?.name ?? null;
  for (const c of i.commits) rows.push({ ts: c.at, first: true, text: lane ? x.tr('tasks.detail.h.commitBy', { lane, sha: c.sha.slice(0, 7) }) : x.tr('tasks.detail.h.commit', { sha: c.sha.slice(0, 7) }) });
  return rows.sort((a, b) => a.ts - b.ts || (a.first ? 0 : 1) - (b.first ? 0 : 1)).map(r => ({ ts: r.ts, text: r.text, at: whenHm(r.ts, x.now) }));
}

export interface DetailRow { label: string; value: string; mono?: boolean; keys?: string[] }

const lastTs = (i: IssueInfo, type: string) => i.events.reduce<number | null>((t, e) => (e.type === type && (t === null || e.ts > t) ? e.ts : t), null);

function stateValue(i: IssueInfo, x: DetailCtx): string {
  const { tr } = x;
  if (i.state === 'done') return tr('tasks.detail.st.done', { at: whenHm(i.doneAt ?? i.createdAt, x.now) });
  if (i.state === 'cancelled') return tr('tasks.detail.st.cancelled', { at: whenHm(lastTs(i, 'cancelled') ?? i.doneAt ?? i.createdAt, x.now) });
  if (i.state === 'todo') return i.waitingOn.length ? tr('tasks.detail.st.blocked') : tr('tasks.detail.st.ready');
  const st = i.lane?.state;
  if (st === 'waiting_quota') return tr('tasks.detail.st.doingQuota');
  if (st === 'waiting_po') return tr('tasks.detail.st.doingPo');
  if (st === 'broken') return tr('tasks.detail.st.doingBroken');
  const since = lastTs(i, 'taken');
  return since === null ? tr('tasks.detail.st.doing') : tr('tasks.detail.st.doingSince', { at: whenHm(since, x.now) });
}

function sourceValue(i: IssueInfo, x: DetailCtx): string {
  const { tr } = x;
  if (i.reverts) return tr('tasks.detail.src.revert', { key: i.reverts });
  switch (i.source) {
    case 'spec': return x.spec ? tr('tasks.detail.src.spec', { spec: specShort(x.spec.title) }) : tr('tasks.detail.src.specBare');
    case 'amend': return tr('tasks.detail.src.amend');
    case 'po': return (i.kind === 'bug' ? tr('tasks.detail.src.poBug', { at: fmtHm(i.createdAt) }) : tr('tasks.detail.src.po', { at: fmtHm(i.createdAt) }));
    case 'lane': return i.sourceIssue ? tr('tasks.detail.src.laneOn', { lane: i.sourceLane ?? '?', key: i.sourceIssue }) : tr('tasks.detail.src.lane', { lane: i.sourceLane ?? '?' });
    case 'orchestrator': return tr('tasks.detail.src.orch');
    case 'prior': return tr('tasks.detail.src.prior');
  }
}

function laneValue(i: IssueInfo, x: DetailCtx): string | null {
  if (!i.lane) return null;
  if (i.state !== 'doing') return x.tr('tasks.detail.laneClosed', { lane: i.lane.name });
  const acc = x.lanes.find(l => l.name === i.lane!.name)?.account;
  const base = laneCluster(i.lane, x).text;
  return acc ? `${base} · ${shortEmail(acc)}` : base;
}

function commitValue(i: IssueInfo, tr: Tr): string {
  if (!i.commits.length) return tr('tasks.detail.noCommit');
  const shas = i.commits.map(c => c.sha.slice(0, 7)).join(', ');
  const br = i.commits.find(c => c.branch)?.branch ?? null;
  return br === null ? shas : br === 'main' ? tr('tasks.detail.commitMain', { shas }) : tr('tasks.detail.commitBranch', { shas, branch: br });
}

/** §4.3 the detail table (a row only when it has something). */
export function detailRows(i: IssueInfo, x: DetailCtx): DetailRow[] {
  const { tr } = x;
  const rows: DetailRow[] = [
    { label: tr('tasks.detail.row.state'), value: stateValue(i, x) },
    { label: tr('tasks.detail.row.source'), value: sourceValue(i, x) },
  ];
  const lane = laneValue(i, x);
  if (lane) rows.push({ label: tr('tasks.detail.row.lane'), value: lane });
  if (i.priority && i.specId !== null) rows.push({ label: tr('tasks.detail.row.priority'), value: i.kind === 'bug' ? tr('tasks.detail.prioBug') : tr('tasks.detail.prio') });
  if (i.blockedBy.length) rows.push({ label: tr('tasks.detail.row.blockedBy'), value: i.blockedBy.join(', '), keys: i.blockedBy });
  if (i.blocks.length) rows.push({ label: i.state === 'done' ? tr('tasks.detail.row.builtOn') : tr('tasks.detail.row.blocks'), value: i.blocks.join(', '), keys: i.blocks });
  rows.push({ label: tr('tasks.detail.row.commit'), value: commitValue(i, tr), mono: i.commits.length > 0 });
  return rows;
}

/** §5.7-5 the open `revert_conflict` card of this issue (its strip in the detail; Huỷ hidden while it is open). */
export const conflictCard = (i: IssueInfo, cards: readonly CardView[]): CardView | null =>
  cards.find(c => c.kind === 'revert_conflict' && c.status === 'open' && c.projectId === i.projectId && c.params?.key === i.key) ?? null;

/** §5.6 Cho làm: an arising issue the PO has not let through yet, in a spec still building (none on a done spec, IS9). */
export const canOk = (i: IssueInfo, spec: SpecInfo | null): boolean =>
  (i.source === 'lane' || i.source === 'orchestrator') && !i.poOk && isArising(i) && spec?.state !== 'done';

/** §5.6 R19 seen = when the PO leaves an issue he opened: the open issue (`prev`, while the tab shows) changed to `next`;
 *  returns the key to send `issue_seen` for, or null (opening never counts; an issue already seen sends nothing). */
export function seenOnLeave(prev: string | null, next: string | null, issues: readonly IssueInfo[]): string | null {
  if (prev === null || prev === next) return null;
  const i = issues.find(x => x.key === prev);
  return i && isArising(i) ? prev : null;
}

/** §5.7-5 the done dependants named in the conflict strip (from the card, else the done issues built on it). */
export const conflictWith = (i: IssueInfo, card: CardView | null, all: readonly IssueInfo[]): string | null => {
  const b = card?.params?.blocker;
  return typeof b === 'string' && b ? b : builtOn(i, all)[0] ?? null;
};

/** §5.7-5 IS5b "Huỷ cả hai…": IS4 for the done dependant first, then the issue (the same order as the Deck card). */
export const cancelBothKeys = (i: IssueInfo, blocker: string | null): string[] => (blocker ? [blocker, i.key] : [i.key]);

/** The account lookup of the quota cluster: the lane's account → its reset time. */
export function quotaAtOf(lanes: readonly LaneView[], accounts: readonly AccountView[]) {
  return (lane: string): number | null => {
    const acc = lanes.find(l => l.name === lane)?.account;
    const a = acc ? accounts.find(x => x.email === acc) : undefined;
    return a ? resetAt(a) : null;
  };
}
