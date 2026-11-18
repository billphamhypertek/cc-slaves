// Account wire types split out of protocol.ts (800-line cap): the login view (v2 §6) and the v2.7.1 quota fields (§7.2–§7.3).
// A leaf: protocol.ts imports and re-exports them. Every time is epoch MILLISECONDS (protocol §5.3).

/** v2 §6 A3–A7: the one running login (A3 single-flight), pushed as `account_login` on every state change. */
export interface AccountLoginView {
  id: string; mode: 'add' | 'relogin';
  /** Typed at A3 (add) or the row email (relogin); null = none typed. */
  email: string | null;
  state: 'starting' | 'waiting_browser' | 'verifying' | 'email_mismatch' | 'done' | 'failed' | 'cancelled' | 'timed_out';
  /** A4 link (waiting_browser onwards). */
  url: string | null;
  /** A4 "Dán mã": the manual link that shows a code (another device / a browser that cannot reach localhost); null = `url` itself. */
  codeUrl?: string | null;
  /** A4 10:00 clock: epoch ms when the login times out. */
  deadline: number;
  /** A7(c)(d)(e): why it failed; `detail` = last output line, or the real email. */
  error: { reason: 'exit' | 'wrong_email' | 'duplicate' | 'no_identity' | 'layout' | 'spawn' | 'no_account'; detail: string | null } | null;
  /** A7f / done: the email actually logged in. */
  realEmail: string | null;
}

type QuotaWindow = 'five' | 'week';

/** v2.7.1 §7.3 quota fields of `AccountView`, all computed by the engine next to `full` (`server/views.ts`). */
export interface AccountQuotaFields {
  /** §4.4 manual refresh: `at` = when the queued ask is expected (null unless queued). */
  refresh: { state: 'idle' | 'queued' | 'fetching'; at: number | null };
  /** §7.1-4 nearest of: the queue turn, ≈ 60 s after a known reset, the regular 5 / 15-min schedule. */
  nextCheckAt: number | null;
  /** §4.4 the last ask failed (timeout, network, HTTP …); catalog key (§6A). Null after an ok ask. */
  quotaError: { key: string; params?: Record<string, string | number>; at: number } | null;
  /** §4.5 why `full`: `leaveAt` = where the engine really stops (weekLeaveAt / fiveLeaveAt); null once the reset passed. */
  fullWhy: { window: QuotaWindow; by: 'cap' | 'anthropic'; usedPct: number | null; cap: number | null; leaveAt: number | null;
    hard: boolean; resetsAt: number | null } | null;
  /** §4.5 not full, but the week is past `weekAdmitMax` (hard): no new work here (picker `week_full`). */
  admitBlock: { usedPct: number; admitMax: number; cap: number; leaveAt: number } | null;
  /** §4.4 the reset of the window that filled it has passed, no new numbers yet (`fullWhy` is null then). */
  pastReset: { window: QuotaWindow; at: number; recheckAt: number | null } | null;
  /** D103 the account has a 5-hour window (Max) or not (Ultra: weekly only). */
  fiveWindow: boolean;
}

/** v2.7.1 §7.3 `Snapshot.quota` / event `quota`: the 429 cooldown and when the manual queue is done (rounded up to the minute). */
export interface QuotaState { cooldownUntil: number | null; queueEndsAt: number | null }

/** v2.7.1 §7.2 ack of `quota_refresh`: answered at once; results come as `account` events. */
export interface QuotaRefreshAck {
  /** In ask order. */
  queued: string[];
  skipped: { email: string; reason: 'recent' | 'logged_out' | 'needs_probe'; until: number | null }[];
  /** A 429 cooldown in force. */
  cooldownUntil: number | null;
}
