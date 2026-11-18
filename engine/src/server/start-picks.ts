// v2.7.1 §7.4 start options of a new session: the model / effort picks (v2.4 §5.5, shared with `session_open` /
// `session_resume`), the spec_* `account` (the ▾ dialog), why a hand-picked account cannot run (§4.5 copy, L13, D103 —
// read off the engine's own `AccountView`, the one source with `full`), and the earliest reopen when "Tự chọn" finds none (SA9).
import type { Key, Params } from '../../../shared/i18n/index.ts';
import type { StartPicks } from '../../../shared/issues.ts';
import type { AccountView } from '../../../shared/protocol.ts';
import { CommandError } from './router.ts';

export const isPick = (v: unknown): v is string | null | undefined => v === undefined || v === null || (typeof v === 'string' && v.trim() !== '');

/** v2.4 §5.5 `model` / `effort` (null = "Theo mặc định"; absent = unchanged). */
export function picks(c: { model?: unknown; effort?: unknown }): { model?: string | null; effort?: string | null } {
  if (!isPick(c.model) || !isPick(c.effort)) throw new CommandError('bad_input', { key: 'errors.badModel' });
  return { ...(c.model !== undefined ? { model: c.model } : {}), ...(c.effort !== undefined ? { effort: c.effort } : {}) };
}

/** §7.4 the spec_* picks; every absent field stays absent (= today's defaults exactly). */
export function startPicks(c: { account?: unknown; model?: unknown; effort?: unknown }): StartPicks {
  if (c.account !== undefined && (typeof c.account !== 'string' || c.account.trim() === '')) throw new CommandError('bad_input', { key: 'errors.badAccount' });
  return { ...(typeof c.account === 'string' ? { account: c.account.trim().toLowerCase() } : {}), ...picks(c) };
}

const two = (n: number) => String(n).padStart(2, '0');
/** §4.5 L8 every reset time = `HH:MM dd/mm` (the Mac's local time). */
export const fmtAt = (ms: number): string => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())} ${two(d.getDate())}/${two(d.getMonth() + 1)}`;
};

interface Why { key: Key; params: Params }

/** §4.5 the full-row reason as an error: the window, the level the engine really stops at, " · mở lại" its reset. */
function fullReason(email: string, w: NonNullable<AccountView['fullWhy']>): Why {
  if (w.resetsAt === null) return { key: 'errors.startFullNoReset', params: { email } };
  const at = fmtAt(w.resetsAt);
  if (w.by === 'anthropic') return { key: w.window === 'five' ? 'errors.startFullAnthropicFive' : 'errors.startFullAnthropicWeek', params: { email, at } };
  const used = w.usedPct ?? 0, cap = w.cap ?? 0;
  if (w.window === 'five') return { key: 'errors.startFullFive', params: { email, used, cap, at } };
  return w.hard ? { key: 'errors.startFullWeekHard', params: { email, used, cap, leave: w.leaveAt ?? cap, at } }
    : { key: 'errors.startFullWeekSoft', params: { email, used, cap, at } };
}

/** §7.4 why a hand-picked account cannot open a session (null = it can): signed out, needs a test run, full, past the
 *  reset that filled it (no new numbers yet), or the hard admit band (L13 — picker `week_full`). */
export function unusableWhy(v: AccountView): Why | null {
  const email = v.email;
  if (v.loggedOut || v.login === 'out') return { key: 'errors.startAccountOut', params: { email } };
  if (v.status === 'needs_probe') return { key: 'errors.startAccountProbe', params: { email } };
  if (v.fullWhy) return fullReason(email, v.fullWhy);
  if (v.pastReset) return { key: 'errors.startPastReset', params: { email, at: fmtAt(v.pastReset.at) } };
  if (v.admitBlock) return { key: 'errors.startAdmit', params: { email, used: v.admitBlock.usedPct, admit: v.admitBlock.admitMax, cap: v.admitBlock.cap } };
  if (v.full) return { key: 'errors.startFullNoReset', params: { email } };
  return null;
}

/** §7.4 the hand-picked account, checked at run time → `account_unusable` with the §4.5 reason. */
export function checkAccount(views: AccountView[], email: string): void {
  const v = views.find((x) => x.email === email);
  if (!v) throw new CommandError('account_unusable', { key: 'errors.noAccount', params: { email } });
  const why = unusableWhy(v);
  if (why) throw new CommandError('account_unusable', why);
}

/** SA9 when an account that cannot run now reopens: its full window's reset, the re-check after a passed reset, the week
 *  reset of the admit band; null = unknown (signed out / needs a test run never reopen by themselves). */
function reopensAt(v: AccountView): number | null {
  if (v.loggedOut || v.login === 'out' || v.status === 'needs_probe') return null;
  return v.fullWhy?.resetsAt ?? v.pastReset?.recheckAt ?? (v.admitBlock ? v.weekResetsAt : null);
}

/** SA9 the logged-in account that reopens first (epoch ms); null = none known. */
export function earliest(views: AccountView[]): { email: string; at: number } | null {
  let best: { email: string; at: number } | null = null;
  for (const v of views) {
    const at = reopensAt(v);
    if (at !== null && (best === null || at < best.at)) best = { email: v.email, at };
  }
  return best;
}

/** §7.4 "Tự chọn" found no account → `no_account` (+ the earliest reopen: text and ms). */
export function noAccount(views: AccountView[]): CommandError {
  const e = earliest(views);
  return e ? new CommandError('no_account', { key: 'errors.noAccountEarliest', params: { email: e.email, at: fmtAt(e.at), atMs: e.at } })
    : new CommandError('no_account', { key: 'errors.noAccountNone' });
}
