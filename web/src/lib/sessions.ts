// v2.1 §4.14 parallel orchestrator sessions as pure logic (no React / DOM): the running sessions of a project (one deck
// root each, open / resume order), which one Đang xem shows, names and chips, the dialog defaults (next #n, first message,
// receiver, asks that expire), the resume choice (parallel / replace, cap 3, context ≥ 80 %), the reassign undo and
// the history rows.
import type { Tr } from './i18n.tsx';
import { isPending } from './cards.ts';
import { fmtCost, fmtDayHm, fmtHm, fmtTok, shortEmail } from './format.ts';
import type { StartReq } from './start.ts';
import { displayTokens, type CardView, type Command, type LaneView, type OrchestratorView, type ResumePreview, type SessionRowView, type SessionsList, type SinceStopLane, type Snapshot, type StreamLine } from '../../../shared/protocol.ts';

/** §4.14 the project's running sessions (each a deck root), in open / resume order = snapshot order. */
export const sessionsOf = (snap: Snapshot, projectId: string | null): OrchestratorView[] =>
  snap.orchestrators.filter(o => o.projectId === projectId);

/** §4.14 the deck root id of a session (pre-v2.1 engines: the project id). */
export const rootOf = (o: OrchestratorView): string => o.sessionId ?? o.projectId;

/** §4.14 Đang xem: the asked session while it runs, else the first running one. */
export function viewedSession(os: readonly OrchestratorView[], want: string | null): OrchestratorView | null {
  return os.find(o => o.sessionId === want) ?? os[0] ?? null;
}

/** §4.14 the project ever had > 1 session: several run now, or a running one is not #1. */
export const everMulti = (os: readonly OrchestratorView[]): boolean => os.length > 1 || os.some(o => (o.seq ?? 1) > 1);

/** §4.14 root / Inspector name: "Điều phối #n" once the project ever had > 1 session, else "Điều phối". */
export const orchName = (tr: Tr, o: OrchestratorView, multi: boolean): string =>
  multi ? tr('session.orch', { n: o.seq ?? 1 }) : tr('common.role.orchestrator');

/** §4.7 UX-I1 a Thiết kế session is named by its title ("Thiết kế · 15:02", the spec's once `spec_draft` ran); the
 *  others "Điều phối #n" / "Điều phối". */
export const rootName = (tr: Tr, o: OrchestratorView, multi: boolean): string =>
  o.orchKind === 'design' && o.title ? o.title : orchName(tr, o, multi);

/** §4.7 UX-I11 a Thiết kế session the PO has not written to yet (the engine's first line does not count): its empty
 *  state + the "Kể ý tưởng…" placeholder. */
export const designFresh = (o: Pick<OrchestratorView, 'orchKind'> | null, lines: readonly Pick<StreamLine, 'kind'>[]): boolean =>
  o?.orchKind === 'design' && !lines.some(l => l.kind === 'po');

/** "#3 · hotfix" / "#3". */
export const sessionLabel = (tr: Tr, seq: number | null, title: string | null | undefined): string =>
  title ? tr('session.named', { n: seq ?? '?', title }) : tr('session.num', { n: seq ?? '?' });

/** §4.14 Đang xem of a lane: "Phiên #3 · <tên>" when > 1 session runs. */
export function laneSessionLine(tr: Tr, l: LaneView, os: readonly OrchestratorView[]): string | null {
  if (os.length < 2 || l.ownerSeq == null) return null;
  const title = os.find(o => o.sessionId === l.ownerSession)?.title;
  return title ? tr('session.laneTitled', { n: l.ownerSeq, title }) : tr('session.lane', { n: l.ownerSeq });
}

/** §4.14 Chờ PO chip: "#4 · Lane H2" when > 1 session runs (the engine's `seq`, never inferred). */
export const cardChip = (tr: Tr, c: Pick<CardView, 'seq'>, who: string, running: number): string =>
  running > 1 && c.seq != null ? tr('session.chip', { n: c.seq, who }) : who;

/** §4.14 N5-b the next #n: numbers are never reused (running + ended). */
export function nextSeq(list: SessionsList | null, os: readonly OrchestratorView[]): number {
  const seqs = [...os.map(o => o.seq ?? 1), ...(list ? [...list.running, ...list.ended].map(r => r.seq ?? 0) : [])];
  return Math.max(0, ...seqs) + 1;
}

/** §4.14 N5-b the engine's default first message (shown as the placeholder). */
export const parallelFirst = (tr: Tr, n: number, project: string): string => tr('session.parallelFirst', { n, project });

/** §4.14 N5-b `session_open`: a blank title / first message / auto account is left to the engine. */
export function openCmd(projectId: string, f: { title: string; first: string; account: string | null; model: string | null; effort: string | null }): Command {
  const title = f.title.trim(), first = f.first.trim();
  return { cmd: 'session_open', projectId, ...(title ? { title } : {}), ...(first ? { first } : {}), ...(f.account ? { account: f.account } : {}), ...picks(f) };
}

type Place = { mode: 'parallel' | 'replace'; replaceId: string | null; account: string | null; model: string | null; effort: string | null };
const replaceOf = (f: Place) => (f.mode === 'replace' && f.replaceId ? { replaceId: f.replaceId } : {});
/** §4.14 N5-f "Chạy tiếp phiên #n" (§4.4 MD11 the picks always sent: null = back to the default). */
export const resumeCmd = (sessionId: string, f: Place & { pvAccount: string | null }): Command => ({ cmd: 'session_resume', sessionId, mode: f.mode, ...replaceOf(f),
  ...(f.account && f.account !== f.pvAccount ? { account: f.account } : {}), model: f.model, effort: f.effort });
/** §4.14 N5-g / N5-r "Phiên mới từ #n" (handoff / last 50 lines). */
export const freshCmd = (projectId: string, sessionId: string, kind: 'handoff' | 'tail', f: Place): Command => ({ cmd: 'session_open', projectId,
  from: { sessionId, kind }, ...replaceOf(f), ...(f.account ? { account: f.account } : {}), ...picks(f) });

/** v2.4 §4.4 the dialog's Model · Effort picks (absent = "Theo mặc định"). */
const picks = (f: { model: string | null; effort: string | null }): { model?: string; effort?: string } =>
  ({ ...(f.model ? { model: f.model } : {}), ...(f.effort ? { effort: f.effort } : {}) });

/** §4.14 N5-k "Kết thúc phiên": lanes go to the earliest running session other than the ending one. */
export const defaultReceiver = (os: readonly OrchestratorView[], ending: string): string | null =>
  os.find(o => o.sessionId && o.sessionId !== ending)?.sessionId ?? null;

/** §4.14 N5-k the ending session's own questions still waiting for the PO (they expire). */
export const endAsks = (cards: readonly CardView[], sessionId: string): CardView[] => cards.filter(c => c.sessionId === sessionId && isPending(c));

export interface ResumeDefaults { mode: 'parallel' | 'replace'; replaceId: string | null; parallelBlocked: boolean; main: 'resume' | 'handoff' }
/** §4.14 N5-f/g/r: parallel by default; "Thay [#n ▾]" defaults to the session viewed before history; at the cap parallel
 *  is dimmed and replace preselected; context ≥ 80 % with a handoff → the main button is "Phiên mới từ handoff #n". */
export function resumeDefaults(pv: ResumePreview, prevSid: string | null, os: readonly OrchestratorView[]): ResumeDefaults {
  const blocked = !pv.parallelAllowed;
  const replaceId = os.find(o => o.sessionId === prevSid)?.sessionId ?? os[0]?.sessionId ?? null;
  return { mode: blocked ? 'replace' : 'parallel', replaceId, parallelBlocked: blocked, main: pv.ctxHigh && pv.handoffPath ? 'handoff' : 'resume' };
}

/** §4.14 "Lượt đầu": ≈ % of the account's 5-hour quota with its sample count; < 5 samples → tokens only. */
export function estimateText(tr: Tr, pv: Pick<ResumePreview, 'estimate' | 'account'>): string {
  const e = pv.estimate;
  if (!e) return '—';
  const tok = fmtTok(e.tokens, tr);
  return e.pct === null ? tr('session.estNoPct', { tok })
    : tr('session.estPct', { tok, pct: Math.round(e.pct), acc: pv.account ? shortEmail(pv.account) : '—', n: e.samples });
}

/** §4.14 "Hoàn tác" of "Chuyển sang phiên": the reverse move to the old owner (unsent notes are dropped, `undo`). */
export function reassignBack(m: { projectId: string; name: string; from: string | null }): Command | null {
  return m.from ? { cmd: 'lane_reassign', projectId: m.projectId, name: m.name, toSession: m.from, undo: true } : null;
}

/** §4.14 an ended row: "chạy tiếp được" / "chỉ xem · hết hạn", + "hết hạn sau n ngày" when ≤ 5 days are left. */
export function rowStatus(tr: Tr, r: SessionRowView): { text: string; ok: boolean } | null {
  if (r.state !== 'ended') return null;
  if (!r.resumable) return { text: tr('session.expired'), ok: false };
  const ok = tr('session.resumable');
  return { text: r.expiresInDays != null && r.expiresInDays <= 5 ? tr('session.expiresIn', { status: ok, n: r.expiresInDays }) : ok, ok: true };
}

/** §4.14 N5-d history row meta: "giờ · account (đầu → cuối) · số lane · tok · $ · cách kết thúc" (ended rows only). */
export function rowMeta(tr: Tr, r: SessionRowView): string {
  const when = r.endedAt ? tr('session.rowSpan', { start: fmtDayHm(r.startedAt, tr), end: fmtHm(r.endedAt) }) : tr('session.rowFrom', { start: fmtDayHm(r.startedAt, tr) });
  const accs = [r.accountFirst, r.accountLast].filter((a): a is string => !!a).map(shortEmail);
  const acc = accs.length === 2 && accs[0] === accs[1] ? accs[0] : accs.join(' → ');
  return [when, acc || null, tr('session.rowLanes', { n: r.lanes }), `${fmtTok(displayTokens(r.tokens), tr)} tok`, fmtCost(r.costUsd, tr),
    r.state === 'ended' ? endHow(tr, r) : null].filter(Boolean).join(' · ');
}

/** §4.14 "Từ lúc dừng" lane line: "D7 xong 12:40 · D9 → #3 lúc 14:22". */
export const sinceText = (tr: Tr, xs: readonly SinceStopLane[]): string => (xs.length
  ? xs.map(x => (x.kind === 'done' ? tr('session.sinceDone', { name: x.name, at: x.at ? fmtHm(x.at) : '—' })
    : tr('session.sinceMoved', { name: x.name, n: x.seq ?? '?', at: x.at ? fmtHm(x.at) : '—' }))).join(' · ')
  : tr('session.sinceNone'));

/** §4.14 how a session ended, in words. */
export const endHow = (tr: Tr, r: Pick<SessionRowView, 'endReason'>): string => tr(`session.endHow.${r.endReason ?? 'none'}`);

/** §4.14 the session dialogs (lazy layer): open a parallel session, end one, rename, resume an ended one (or a new
 *  session from its handoff / last 50 lines). */
export type SessionDlg =
  | { k: 'parallel'; projectId: string }
  | { k: 'end'; sessionId: string }
  | { k: 'rename'; sessionId: string }
  | { k: 'resume'; sessionId: string; from?: 'handoff' | 'tail' }
  /** §4.14 / §4.15 N5-o "Chạy tiếp lane…" of a done lane. */
  | { k: 'laneContinue'; projectId: string; name: string }
  /** v2.7.1 §4.1 a Tasks start: the ▾ dialog, or the step list at once (`req.direct`). */
  | { k: 'start'; req: StartReq };

/** §4.14 the "D2 chuyển sang #4 · Hoàn tác" toast (5 s, v1 F5 pattern): `back` is the reverse command. */
export interface MovedToast { text: string; back: Command; at: number }
export const UNDO_MS = 5_000;
