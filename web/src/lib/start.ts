// v2.7.1 §4.1 the session start dialog (the ▾ of "Bắt đầu ▾", and the v2.4 "Mở phiên song song…" / "Chạy tiếp" / "Phiên
// mới…" dialogs, L11 / L14): the account list with its reasons (§4.5 copy, L3, L13, D103), the "Tự chọn" field (SA1, SA5,
// SA9), and the four steps after a start (SA3, SA4). Pure: no React.
import { fmtNum, type Tr } from '../../../shared/i18n/core.ts';
import type { AccountView, OrchestratorView } from '../../../shared/protocol.ts';
import { SLOW_BOOT_MS } from './boot-wait.ts';
import { fmtResetTime } from './format.ts';

/** Which Tasks button asked (§4.1 table): + Spec mới, Bắt đầu build, Sửa spec, Bổ sung yêu cầu, Mở phiên, IS17 Nhận phiên cũ. */
export type StartKind = 'new' | 'build' | 'edit' | 'amend' | 'open' | 'resume';
/** SA6b the old session's model id / effort (engine `PriorSession`), shown as "Như phiên cũ (<giá trị>)"; null = not in its transcript. */
export interface Prior { model: string | null; effort: string | null }
/** What G2b hands the start dialog (`useSessions().start`): the kind, the spec, the defaults. */
export interface StartReq {
  projectId: string; kind: StartKind;
  /** the spec (every kind but `new`): its path and short title */
  path?: string; spec?: string;
  /** IS17 "Nhận phiên cũ": the Claude session id, and how the lead names it ("“<tóm tắt>” (07:12 17/11 · 184 lượt)") */
  resume?: { id: string; label: string; prior: Prior };
  /** the split button's main part: no choice, the step list at once (account Tự chọn, the account's defaults) */
  direct?: boolean;
  /** step 4: the Deck shows the new session (Tasks → Deck); absent = the session dialogs' own `onStarted` */
  opened?: (sessionId: string) => void;
}
/** `session_pick` kind of a start: Build for build / IS17, else a Thiết kế session. */
export const pickKind = (k: StartKind): 'design' | 'build' => (k === 'build' || k === 'resume' ? 'build' : 'design');

// ---------- §4.1 the Account field ----------
/** The "Tự chọn" row: asking `session_pick` (SA5), its answer (SA1), none left (SA9), or no answer (the engine picks at run). */
export type AutoPick = { st: 'loading' } | { st: 'ok'; email: string | null; pct: number | null }
  | { st: 'none'; earliest: { email: string; at: number } | null } | { st: 'error' };

export function autoText(tr: Tr, a: AutoPick): string {
  if (a.st === 'loading') return tr('session.stAutoLoading');
  if (a.st === 'none') return tr('session.stAutoNone');
  if (a.st === 'ok' && a.email) return a.pct !== null ? tr('session.stAutoWill', { email: a.email, pct: Math.round(a.pct) }) : tr('session.stAutoWillNoPct', { email: a.email });
  return tr('session.stAuto');
}

const winName = (tr: Tr, w: 'five' | 'week') => tr(w === 'five' ? 'session.stWinFive' : 'session.stWinWeek');

/** §4.5 why an account cannot take a new session (null = it can), the second line of its list row. Engine fields only:
 *  `fullWhy` / `admitBlock` / `pastReset` (a 5-hour cause exists on Max accounts only, D103). */
export function whyNot(tr: Tr, a: AccountView): string | null {
  if (a.loggedOut || a.login === 'out') return tr('session.stWhyOut');
  if (a.status === 'needs_probe') return tr('session.stWhyProbe');
  const w = a.fullWhy;
  if (w) {
    const why = w.by === 'anthropic' ? tr(w.window === 'five' ? 'session.stWhyAnthFive' : 'session.stWhyAnthWeek')
      : w.window === 'five' ? tr('session.stWhyFive', { used: Math.round(w.usedPct ?? 0), cap: w.cap ?? 0 })
      : w.hard ? tr('session.stWhyWeekHard', { used: Math.round(w.usedPct ?? 0), cap: w.cap ?? 0, leave: w.leaveAt ?? w.cap ?? 0 })
      : tr('session.stWhyWeekSoft', { used: Math.round(w.usedPct ?? 0), cap: w.cap ?? 0 });
    return w.resetsAt !== null ? tr('session.stWhyReopen', { why, at: fmtResetTime(w.resetsAt) }) : why;
  }
  const p = a.pastReset;
  if (p) return p.recheckAt !== null ? tr('session.stWhyPast', { win: winName(tr, p.window), at: fmtResetTime(p.at), re: fmtResetTime(p.recheckAt).slice(0, 5) })
    : tr('session.stWhyPastNoRe', { win: winName(tr, p.window), at: fmtResetTime(p.at) });
  const b = a.admitBlock;
  if (b) return tr('session.stWhyAdmit', { used: Math.round(b.usedPct), admit: b.admitMax, cap: b.cap });
  return a.full ? tr('session.stWhyFull') : null;
}

/** One row of the SA2 list (pickable rows first): `main` "email — còn N %" (or "— Đầy" / "— đăng xuất" / "— cần chạy thử"), `side` its small note
 *  ("đang chạy Điều phối #1", "sắp hết"), `why` the reason it cannot be picked (L3, L13); `ok` = pickable. */
export interface AccRow { email: string; main: string; side: string | null; why: string | null; ok: boolean }

export function accRows(tr: Tr, accounts: AccountView[], os: Pick<OrchestratorView, 'account' | 'seq' | 'title'>[], low: (a: AccountView) => boolean,
  label: (o: Pick<OrchestratorView, 'seq' | 'title'>) => string): AccRow[] {
  return accounts.map(a => {
    const why = whyNot(tr, a), email = a.email;
    const main = a.loggedOut || a.login === 'out' ? tr('session.stRowOut', { email })
      : a.status === 'needs_probe' ? tr('session.stRowProbe', { email })
      : a.fullWhy || (a.full && !a.pastReset) ? tr('session.stRowFull', { email })
      : a.headroomPct !== null ? tr('session.stRowLeft', { email, pct: Math.round(a.headroomPct) }) : email;
    const who = os.find(o => o.account === email);
    const side = why ? null : who ? tr('session.stRowBusy', { who: label(who) }) : low(a) ? tr('session.stRowLow') : null;
    return { email, main, side, why, ok: why === null };
  }).sort((x, y) => Number(y.ok) - Number(x.ok)); // SA2: the pickable ones first, the greyed ones under them (stable)
}

// ---------- §4.1 SA3 / SA4 the four steps ----------
type StepSt = 'wait' | 'run' | 'ok' | 'bad';
export interface StartStep { key: 'account' | 'boot' | 'first' | 'deck'; st: StepSt; label: string; note: string | null; ms: number | null }

/** What one start has seen so far (epoch ms). `seenAt` = the session is in the snapshot, `bootAt` = it left `starting`,
 *  `ackAt` = the command answered, `deckAt` = the Deck shows it. `err` = the engine refused; `fix` = the SA4 button:
 *  `account` "Chọn account khác" (account_unusable), `panel` "Mở bảng Account" (no_account: none left, ruling 16:10),
 *  `retry` "Thử lại". `bootErr` = the session stopped while it booted. */
export interface StartRun {
  t0: number; sid: string | null; seenAt: number | null; bootAt: number | null; ackAt: number | null; deckAt: number | null;
  err: { text: string; fix: StartFix } | null; bootErr: string | null;
  /** step 1: the account (hand-picked, or the one "Tự chọn" named) and how it was chosen */
  account: string | null; auto: boolean; pct: number | null;
  /** step 2: "<model> · <effort>" as far as known */
  model: string | null;
}
export type StartFix = 'account' | 'panel' | 'retry';

export const fmtStepTime = (tr: Tr, ms: number): string =>
  tr('format.secs', { n: fmtNum(tr.lang, Math.max(0, ms) / 1000, { maximumFractionDigits: ms < 10_000 ? 1 : 0 }) });

/** The step rows of `r` at `now`; a failed start marks the step that was running. */
export function startSteps(tr: Tr, r: StartRun, now: number): StartStep[] {
  const fail = r.err ? r.err.text : r.bootErr;
  const accSt: StepSt = r.seenAt !== null ? 'ok' : r.err ? 'bad' : 'run';
  const bootSt: StepSt = r.seenAt === null ? 'wait' : r.bootErr || (r.err && r.bootAt === null) ? 'bad' : r.bootAt !== null ? 'ok' : 'run';
  const firstSt: StepSt = bootSt !== 'ok' ? 'wait' : r.ackAt !== null ? 'ok' : r.err ? 'bad' : 'run';
  const deckSt: StepSt = firstSt !== 'ok' ? 'wait' : r.deckAt !== null ? 'ok' : 'run';
  const span = (st: StepSt, from: number | null, to: number | null) => (st === 'wait' || from === null ? null : (to ?? now) - from);
  const firstFrom = r.bootAt, firstTo = r.ackAt !== null && r.bootAt !== null ? Math.max(r.ackAt, r.bootAt) : null;
  const accNote = accSt === 'bad' ? fail : !r.account ? null : r.auto ? (r.pct !== null ? tr('session.stStepAuto', { pct: Math.round(r.pct) }) : tr('session.stStepAutoNoPct')) : tr('session.stStepMine');
  const bootNote = bootSt === 'bad' ? fail : bootSt === 'run' && r.seenAt !== null && now - r.seenAt > SLOW_BOOT_MS ? tr('session.stStepBootSlow')
    : bootSt === 'ok' ? null : tr('session.stStepBootNote');
  return [
    { key: 'account', st: accSt, label: r.account ? tr('session.stStepAcc', { email: r.account }) : tr('session.stStepAccAny'), note: accNote, ms: span(accSt, r.t0, r.seenAt) },
    { key: 'boot', st: bootSt, label: r.model ? tr('session.stStepBoot', { model: r.model }) : tr('session.stStepBootAny'), note: bootNote, ms: span(bootSt, r.seenAt, r.bootAt) },
    { key: 'first', st: firstSt, label: tr('session.stStepFirst'), note: firstSt === 'bad' ? fail : null, ms: span(firstSt, firstFrom, firstTo) },
    { key: 'deck', st: deckSt, label: tr('session.stStepDeck'), note: null, ms: null },
  ];
}

/** Fold the project's sessions into a run: the new session (by id once the ack named it, else the one not there before)
 *  is seen, then boots (leaves `starting`), or stops while booting (its reason). A "Tự chọn" run takes step 1's "còn N %"
 *  from the account the session runs on (`pctOf`, the account's headroom; UX MINOR-1). */
export function trackRun(r: StartRun, os: OrchestratorView[], before: ReadonlySet<string>, now: number, reason: (o: OrchestratorView) => string | null,
  pctOf: (email: string) => number | null): StartRun {
  const o = r.sid ? os.find(x => x.sessionId === r.sid) : os.find(x => x.sessionId && !before.has(x.sessionId));
  if (!o) return r;
  let n = r;
  const acc = o.account ?? n.account;
  if (n.seenAt === null || acc !== n.account) {
    const pct = !n.auto || !acc ? n.pct : acc !== n.account ? pctOf(acc) : n.pct ?? pctOf(acc);
    n = { ...n, seenAt: n.seenAt ?? now, account: acc, pct };
  }
  if (n.model === null && o.modelName) n = { ...n, model: o.effort ? `${o.modelName} · ${o.effort}` : o.modelName };
  if (n.bootAt === null && n.bootErr === null && o.state !== 'starting') {
    n = o.state === 'stopped' ? { ...n, bootErr: reason(o) ?? '' } : { ...n, bootAt: now };
  }
  return n;
}

/** What the dialog learns after the click (the main part sends before `session_pick` and the model list answer): fill
 *  only the gaps; a % belongs to the account it was asked for (UX MINOR-1). */
export function fillRun(r: StartRun, i: Pick<StartRun, 'account' | 'auto' | 'pct' | 'model'>): StartRun {
  const account = r.account ?? i.account;
  const pct = r.pct ?? (r.auto && i.auto && account === i.account ? i.pct : null);
  const model = r.model ?? i.model;
  return account === r.account && pct === r.pct && model === r.model ? r : { ...r, account, pct, model };
}
