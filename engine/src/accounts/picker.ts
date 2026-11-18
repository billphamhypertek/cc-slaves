// Account choice for a new lane / an orchestrator fallback, and the leave rule for a running session (spec §3.4,
// §7.4 limits, §7.5, D4/D6/D12). Pure: every input is passed in, nothing is read from disk or the clock.
import type { Key } from '../../../shared/i18n/index.ts';
import { resolveCaps, type Caps, type Config, type ResolvedCaps } from '../config.ts';
import type { QuotaRow } from '../db.ts';
import type { Account } from './registry.ts';
import { hasFiveWindow, isFresh, rejectedHeld } from './quota.ts';

/** Weekly resets this close (seconds) count as a tie → more headroom wins (§3.4, g1 review MINOR-1 ruling). */
export const RESET_TIE_S = 3600;

type PickKind = 'lane' | 'orchestrator-fallback';

export type PickReason = 'machine_full' | 'no_accounts' | 'logged_out' | 'all_full' | 'account_lanes_full' | 'quota_unknown';
type SkipReason = 'excluded' | 'role' | 'logged_out' | 'account_lanes_full' | 'quota_unknown' | 'week_full' | 'five_full' | 'rejected' | 'paused';

/** §6A catalog key per reason (`errors.pick_<reason>`); the UI renders it in `ui.lang`. */
export const PICK_REASON_KEY: Readonly<Record<PickReason, Key>> = Object.freeze({
  machine_full: 'errors.pick_machine_full', no_accounts: 'errors.pick_no_accounts', logged_out: 'errors.pick_logged_out',
  all_full: 'errors.pick_all_full', account_lanes_full: 'errors.pick_account_lanes_full', quota_unknown: 'errors.pick_quota_unknown',
});

export interface PickInput {
  accounts: Account[];
  /** Latest quota row per email (missing = never read). */
  quotas: Record<string, QuotaRow | null | undefined>;
  caps: Caps;
  /** Live lanes per email. */
  laneCounts: Record<string, number>;
  machineLaneCount: number;
  config: Pick<Config, 'maxLanes' | 'maxLanesPerAccount'> & Partial<Pick<Config, 'laneCaps' | 'noNewLanes'>>;
  /** Epoch seconds. */
  now: number;
  exclude: string[];
  kind: PickKind;
  /** §6.16 accounts that cannot be used: Keychain holds no Claude login, or a recent auth error not yet cleared. */
  loggedOut?: readonly string[];
  /** Every usable account (the §6 single-account rule); default `accounts`. Differs when a caller pins one account. */
  pool?: Account[];
}

/**
 * §6 (rev 2.1 N4): the email of the only usable account (in the registry with `dir`, not logged out), else null. That
 * account takes lanes even when it is the orchestrator; with ≥ 2 usable accounts the orchestrator takes lanes only when
 * its max lanes (`laneCaps`) is set > 0 (D26, §3.4).
 */
export function soleUsable(pool: readonly Account[], loggedOut: readonly string[] = []): string | null {
  const usable = pool.filter((a) => !loggedOut.includes(a.email));
  return usable.length === 1 ? usable[0]!.email : null;
}

interface Skipped { email: string; reason: SkipReason }
export type PickResult =
  | { account: Account; caps: ResolvedCaps }
  | { none: true; reason: PickReason; skipped: Skipped[]; /** earliest reset that could free a full account */ waitUntil: number | null };

interface Load { weekOver: boolean; fiveOver: boolean; weekAdmit: boolean; fiveAdmit: boolean; score: number }

/** D103 the 5-hour number counts only on an account that has that window (Ultra: never). */
const fiveOf = (a: Account, q: QuotaRow): number | null => (hasFiveWindow(a.planTier, q) ? q.fivePct : null);

/** Where the account stands against its caps. Week compares against leave/admit points; 5h is always soft (D6). */
function load(rc: ResolvedCaps, quota: QuotaRow, five: number | null): Load {
  const week = quota.weekPct;
  const weekOver = week !== null && week >= rc.weekLeaveAt;
  const fiveOver = rc.fiveLeaveAt !== null && five !== null && five >= rc.fiveLeaveAt;
  const ratios = [week === null ? 0.5 : week / rc.weekLeaveAt];
  if (rc.fiveLeaveAt !== null && five !== null) ratios.push(five / rc.fiveLeaveAt);
  return {
    weekOver, fiveOver,
    weekAdmit: week === null || (!weekOver && week <= rc.weekAdmitMax),
    fiveAdmit: !fiveOver,
    score: Math.max(...ratios),
  };
}

/** Most actionable first: unknown → refresh; lane limit → a lane ending frees it; else wait for a reset. */
const REASON_ORDER = ['quota_unknown', 'account_lanes_full', 'all_full'] as const;

export function pick(i: PickInput): PickResult {
  const skipped: Skipped[] = [];
  const none = (reason: PickReason, waitUntil: number | null = null): PickResult => ({ none: true, reason, skipped, waitUntil });
  if (i.kind === 'lane' && i.machineLaneCount >= i.config.maxLanes) return none('machine_full');

  const cands: { account: Account; caps: ResolvedCaps; backup: boolean; reset: number; score: number }[] = [];
  let waitUntil: number | null = null;
  const waitFor = (t: number | null) => { if (t !== null && (waitUntil === null || t < waitUntil)) waitUntil = t; };
  let eligible = 0;
  let primaryUnknown = false;
  const sole = i.kind === 'lane' ? soleUsable(i.pool ?? i.accounts, i.loggedOut) : null;

  for (const a of i.accounts) {
    const skip = (reason: SkipReason) => skipped.push({ email: a.email, reason });
    if (i.exclude.includes(a.email)) { skip('excluded'); continue; }
    const rc = resolveCaps(i.caps, a.email);
    const soleOrchestrator = rc.role === 'orchestrator' && sole === a.email;
    // D26: an orchestrator account with its max lanes set > 0 takes lanes, ranked like a backup (after primaries).
    const setCap = i.config.laneCaps?.[a.email];
    const orchestratorLanes = rc.role === 'orchestrator' && i.kind === 'lane' && setCap !== undefined && setCap > 0;
    if ((rc.role === 'orchestrator' && !soleOrchestrator && !orchestratorLanes)
      || (i.kind === 'orchestrator-fallback' && (rc.role !== 'primary' || rc.hard))) {
      skip('role');
      continue;
    }
    if (i.loggedOut?.includes(a.email)) { skip('logged_out'); continue; }
    eligible++;
    if (i.kind === 'lane' && i.config.noNewLanes?.[a.email] === true) { skip('paused'); continue; }
    const set = setCap;
    // §6: the F1 `laneCaps = 0` of the orchestrator account does not apply while it is the only usable account.
    const laneCap = set === undefined || (soleOrchestrator && set === 0) ? i.config.maxLanesPerAccount : set;
    if (i.kind === 'lane' && (i.laneCounts[a.email] ?? 0) >= laneCap) { skip('account_lanes_full'); continue; }
    const quota = i.quotas[a.email] ?? null;
    // A limit mark (markLimited / a rejected event) holds past freshness: until its known reset, or the next API refresh.
    if (quota !== null && rejectedHeld(quota, i.now)) {
      skip('rejected');
      waitFor(Math.min(quota.weekResetsAt ?? Infinity, quota.fiveResetsAt ?? Infinity));
      continue;
    }
    const fresh = isFresh(quota, i.now);
    if (!fresh || quota === null) {
      // §3.4 I2: unknown numbers never place work on a hard account; a soft one is still usable.
      if (rc.hard) { skip('quota_unknown'); primaryUnknown ||= rc.role === 'primary'; continue; }
      cands.push({ account: a, caps: rc, backup: rc.role !== 'primary', reset: Number.POSITIVE_INFINITY, score: 0.5 });
      continue;
    }
    if (quota.status === 'rejected') {
      skip('rejected');
      waitFor(Math.min(quota.weekResetsAt ?? Infinity, quota.fiveResetsAt ?? Infinity));
      continue;
    }
    if (rc.hard && quota.weekPct === null) { skip('quota_unknown'); primaryUnknown ||= rc.role === 'primary'; continue; }
    const l = load(rc, quota, fiveOf(a, quota));
    if (!l.weekAdmit) { skip('week_full'); waitFor(quota.weekResetsAt); continue; }
    if (!l.fiveAdmit) { skip('five_full'); waitFor(quota.fiveResetsAt); continue; }
    cands.push({ account: a, caps: rc, backup: rc.role !== 'primary', reset: quota.weekResetsAt ?? Number.POSITIVE_INFINITY, score: l.score });
  }

  // Primary first; then the weekly quota that resets soonest (unused quota is lost at reset); resets within
  // RESET_TIE_S of the soonest are a tie → more headroom wins (anchored on the soonest, so the order is transitive).
  cands.sort((x, y) => Number(x.backup) - Number(y.backup) || x.reset - y.reset || x.score - y.score);
  const first = cands[0];
  if (first) {
    // §3.4 "Dự phòng chỉ khi mọi Chính đầy" + I2: a primary that is only unknown is not full → refresh, not backup.
    if (first.backup && primaryUnknown) return none('quota_unknown');
    const tied = cands.filter((c) => c.backup === first.backup && (c.reset === first.reset || c.reset - first.reset <= RESET_TIE_S));
    const best = tied.reduce((b, c) => (c.score < b.score ? c : b));
    return { account: best.account, caps: best.caps };
  }
  if (eligible === 0) {
    if (i.accounts.length === 0) return none('no_accounts');
    return none(skipped.some((s) => s.reason === 'logged_out') ? 'logged_out' : 'all_full');
  }
  const reason = REASON_ORDER.find((r) => r === 'all_full' || skipped.some((s) => s.reason === r))!;
  return none(reason, Number.isFinite(waitUntil ?? NaN) ? waitUntil : null);
}

export type LeaveDecision = 'stay' | 'switch' | 'wait';

export interface LeaveInput {
  account: Account;
  quota: QuotaRow | null;
  caps: Caps;
  now: number;
  /** Whether `pick` (with this account excluded) finds another account. */
  otherFree: boolean;
}

/**
 * §3.4 leave rule for a session already on `account`. Over a cap (hard week: cap−1; soft week and 5h: the cap) →
 * switch when another account is free; otherwise a soft cap rides on to the plan limit (stay) while a hard weekly cap
 * or the plan limit itself means wait. Unknown numbers never move a running session (the tracker refreshes them).
 */
export function shouldLeave(i: LeaveInput): LeaveDecision {
  if (!isFresh(i.quota, i.now) || i.quota === null) return 'stay';
  const q = i.quota;
  const rc = resolveCaps(i.caps, i.account.email);
  const five = fiveOf(i.account, q);
  const l = load(rc, q, five);
  const atPlanLimit = q.status === 'rejected' || (q.weekPct ?? 0) >= 100 || (five ?? 0) >= 100;
  if (!l.weekOver && !l.fiveOver && !atPlanLimit) return 'stay';
  if (i.otherFree) return 'switch';
  if (atPlanLimit || (rc.hard && l.weekOver)) return 'wait';
  return 'stay';
}
