// v2.1 §4.15 §3 done lanes as pure logic: the branch line (node line 2, list rows, done-lane view), "báo xong", the
// "Nhờ Điều phối #n merge…" prefill (appended under a draft), the done list groups (days / measured state), local filter,
// the transcript days left. No React / DOM.
import type { LaneBranch, LaneState, LaneView, OrchestratorView } from '../../../shared/protocol.ts';
import { fmtDate, type Tr } from '../../../shared/i18n/core.ts';
import { fmtHm, midnight } from './format.ts';
import { fold } from './palette.ts';

/** §4.15 §1 "báo xong": `lane_set_phase done` parked the lane; it is not in Xong until the orchestrator's `lane_finish`. */
export const reportedDone = (l: Pick<LaneView, 'phase' | 'state'>): boolean => l.phase === 'done' && l.state !== 'done';

export interface BranchText { text: string; tone: 'warn' | 'mut' | 'bad'; measuring: boolean }
/** §4.15 §3 short merge state: "chưa merge · 4 commit", "đã merge #415", "nhánh đã xoá", "không có nhánh riêng", "không đo được". */
export function branchText(tr: Tr, b: LaneBranch | null | undefined): BranchText {
  const measuring = !!b?.measuring;
  if (!b) return { text: tr('done.b.never'), tone: 'mut', measuring };
  switch (b.state) {
    case 'unmerged': return { text: `${tr('done.b.unmerged')} · ${tr('done.b.ahead', { n: b.ahead })}`, tone: 'warn', measuring };
    case 'merged': return { text: b.pr ? tr('done.b.mergedPr', { pr: b.pr.number }) : tr('done.b.merged'), tone: 'mut', measuring };
    case 'gone': return { text: tr('done.b.gone'), tone: 'mut', measuring };
    case 'none': return { text: tr('done.b.none'), tone: 'mut', measuring };
    case 'unknown': return { text: tr('done.b.unknown'), tone: 'bad', measuring };
  }
}

/** §4.15 §3 N6-g prefill: "Merge D11 (lane/d11, 4 commit, 12 file) vào main sau khi chạy lại gate." */
export const mergeAsk = (tr: Tr, l: Pick<LaneView, 'name' | 'branch'>): string => tr('done.mergeText', {
  name: l.name, branch: l.branch?.name ?? l.name, ahead: l.branch?.ahead ?? 0, files: l.branch?.files ?? 0, base: l.branch?.base ?? 'main',
});

/** §4.15 §3 the prefill never overwrites: a draft keeps its text and the new sentence goes on the line below. */
export const appendDraft = (cur: string, text: string): string => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n${text}` : text);
/** §4.15 §3 the composer grows with its content up to 120 px, then scrolls. `border` = top + bottom border of the
 *  border-box textarea (offsetHeight − clientHeight): scrollHeight leaves it out, so without it the box is 2 px short. */
export const COMPOSER_MAX_H = 120;
export const composerHeight = (scrollHeight: number, border: number): number => Math.min(COMPOSER_MAX_H, scrollHeight + border);

/** §4.15 §3 who gets "Nhờ … merge": the running session that holds the lane, else the session being viewed. */
export function mergeSession(l: Pick<LaneView, 'ownerSession'>, os: readonly OrchestratorView[], viewed: string | null): string | null {
  return l.ownerSession && os.some(o => o.sessionId === l.ownerSession) ? l.ownerSession : viewed;
}

/** §4.15 §3 "Bản ghi: còn (hết hạn sau n ngày)": days left before Claude Code's `cleanupPeriodDays` removes the transcript
 *  (counted from the lane's last activity); ≤ 0 = expired. */
export const transcriptLeft = (updatedAt: number, now: number, periodDays: number): number =>
  Math.ceil(periodDays - (now - updatedAt) / 86_400_000);

/** §4.15 §2 "n lane khác · 4 chạy · 1 rảnh · 1 chờ quota": every state > 0, in a fixed order; with `max`, the first `max`
 *  states and "+n" for the lanes in the rest (N-d: the row never cuts a count in half; its tip keeps them all). */
const COUNT_ORDER: LaneState[] = ['running', 'idle', 'waiting_quota', 'starting', 'switching', 'draining', 'stopped', 'paused', 'waiting_po', 'broken', 'done'];
export function rowCounts(tr: Tr, counts: Partial<Record<LaneState, number>>, max = Infinity): string {
  const on = COUNT_ORDER.filter(s => (counts[s] ?? 0) > 0), rest = on.slice(max).reduce((a, s) => a + counts[s]!, 0);
  return [...on.slice(0, max).map(s => tr(`done.cnt.${s}`, { n: counts[s]! })), ...(rest ? [`+${rest}`] : [])].join(' · ');
}

/** §4.15 Mất kết nối: the loaded rows filtered on the spot (name, task, branch), diacritics-insensitive. */
export function filterDone(lanes: readonly LaneView[], q: string): LaneView[] {
  const k = fold(q.trim());
  return k ? lanes.filter(l => [l.name, l.task, l.note, l.branch?.name].some(x => x && fold(x).includes(k))) : [...lanes];
}

export interface DoneGroup { id: string; label: string; n: number; closed: boolean; lanes: LaneView[] }
const DAY = 86_400_000;
/** §4.15 §3 N6-e / N6-k: by day (Hôm nay, each of the 6 days before, "Cũ hơn 7 ngày" closed), newest first; with the
 *  "Chưa merge" chip by measured state instead ("Chưa merge · n", then "Không đo được · n" — shown to retry, not counted). */
export function groupDone(tr: Tr, lanes: readonly LaneView[], now: number, byState: boolean): DoneGroup[] {
  const sorted = [...lanes].sort((a, b) => b.updatedAt - a.updatedAt);
  const out: DoneGroup[] = [];
  const add = (id: string, label: string, ls: LaneView[], closed = false) => { if (ls.length) out.push({ id, label, n: ls.length, closed, lanes: ls }); };
  if (byState) {
    add('unmerged', tr('done.grpUnmerged'), sorted.filter(l => l.branch?.state === 'unmerged'));
    add('unknown', tr('done.grpUnknown'), sorted.filter(l => l.branch?.state === 'unknown'));
    return out;
  }
  const today = midnight(now), ageOf = (t: number) => Math.round((today - midnight(t)) / DAY);
  for (let d = 0; d < 7; d++) {
    const day = sorted.filter(l => ageOf(l.updatedAt) === d);
    add(`d${d}`, d === 0 ? tr('done.today') : fmtDate(tr.lang, today - d * DAY, { weekday: 'short', day: '2-digit', month: '2-digit' }), day);
  }
  add('older', tr('done.older'), sorted.filter(l => ageOf(l.updatedAt) >= 7), true);
  return out;
}

/** §4.15 §3 a done row's time: "15:10" today, "13/11" before. */
export const doneWhen = (tr: Tr, t: number, now: number): string =>
  midnight(t) === midnight(now) ? fmtHm(t) : fmtDate(tr.lang, t, { day: '2-digit', month: '2-digit' });
