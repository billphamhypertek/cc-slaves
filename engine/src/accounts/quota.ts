// Account quota (spec §3.3-9, §3.4 I2/I3, §8.1, D7). Numbers come from the usage API (polled, spaced) and from live
// `rate_limit_event`s of any session; both land in the quota repo. The OAuth token is read per call and never kept.
import { getQuota, upsertQuota, type Db, type QuotaRow } from '../db.ts';
import type { RateLimitEvent, RateWindow } from '../stream/parser.ts';
import type { Account } from './registry.ts';
import { readAccessToken, securityExec } from './keychain.ts';
import { isObj } from '../../../shared/json.ts';
import type { AccountQuotaFields, QuotaRefreshAck, QuotaState } from '../../../shared/accounts.ts';
import type { KeyedReason } from '../../../shared/protocol.ts';
import { t, type Key } from '../../../shared/i18n/index.ts';

/** §3.4 I2: hard caps only trust numbers this young. */
export const FRESH_MAX_AGE_S = 600;
/** §8.1: per-account floor; also the poll interval while a UI is open. */
export const POLL_UI_S = 300;
/** §8.1: poll interval when no UI is open. */
export const POLL_BACKGROUND_S = 900;
/** §3.3-9: ~6 back-to-back calls → 429, so never two calls closer than this across all accounts. */
export const GLOBAL_GAP_S = 20;
/** After a 429, no call to any account for this long. */
const RATE_LIMIT_COOLDOWN_S = 120;
/** v2.7.1 D101: a manual refresh of one account at most once per this. */
export const MANUAL_FLOOR_S = 60;
/** v2.7.1 §7.1-1 / L6: ask again this long after a known reset (Anthropic needs a few seconds to reopen). */
export const RESET_RECHECK_S = 60;

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

type QuotaStatus = 'ok' | 'allowed_warning' | 'rejected' | 'needs_probe';

export interface UsageSnapshot {
  fivePct: number | null;
  weekPct: number | null;
  /** Epoch seconds. */
  fiveResetsAt: number | null;
  weekResetsAt: number | null;
  /** `seven_day_breakdown` share per client (claude_code/chat/cowork/other); display only (D4). */
  breakdown?: Record<string, number>;
  /** D103: `five_hour` object → true; `seven_day` object without one → false (Ultra); neither → null. */
  fiveWindow?: boolean | null;
}

export class UsageHttpError extends Error {
  constructor(readonly status: number) { super(`usage API HTTP ${status}`); this.name = 'UsageHttpError'; }
}

/** A usage-API failure with its §6A catalog reason (no token in it). */
export class UsageError extends Error {
  constructor(readonly reason: KeyedReason) { super(t('vi', reason.key as Key, reason.params)); this.name = 'UsageError'; }
}

export interface QuotaSource { fetchUsage(account: Account): Promise<UsageSnapshot> }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isoToS = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

export interface KeychainDeps {
  exec?: (cmd: string, args: string[]) => string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

// The Keychain read lives in keychain.ts (v2 §7); re-exported for existing callers.
export { keychainHasLogin } from './keychain.ts';

export function keychainQuotaSource(deps: KeychainDeps = {}): QuotaSource {
  const exec = deps.exec ?? securityExec;
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? 15_000;
  return {
    async fetchUsage(account) {
      let token: string | null = readAccessToken(account.keychainService, exec);
      if (!token) throw new UsageError({ key: 'errors.quotaToken', params: { service: account.keychainService } });
      let res: Response;
      try {
        res = await doFetch(USAGE_URL, {
          headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new UsageError((e as Error)?.name === 'TimeoutError' ? { key: 'errors.quotaTimeout' } : { key: 'errors.quotaNetwork' });
      } finally {
        token = null;
      }
      if (!res.ok) throw new UsageHttpError(res.status);
      let u: unknown;
      try { u = await res.json(); } catch { throw new UsageError({ key: 'errors.quotaData' }); }
      if (!isObj(u)) throw new UsageError({ key: 'errors.quotaData' });
      const five = isObj(u.five_hour) ? u.five_hour : {};
      const week = isObj(u.seven_day) ? u.seven_day : {};
      const rows = isObj(u.seven_day_breakdown) && Array.isArray(u.seven_day_breakdown.rows) ? u.seven_day_breakdown.rows : [];
      const breakdown: Record<string, number> = {};
      for (const r of rows) if (isObj(r) && typeof r.key === 'string' && num(r.percent) !== null) breakdown[r.key] = r.percent as number;
      return {
        fivePct: num(five.utilization), weekPct: num(week.utilization),
        fiveResetsAt: isoToS(five.resets_at), weekResetsAt: isoToS(week.resets_at), breakdown,
        fiveWindow: isObj(u.five_hour) ? true : isObj(u.seven_day) ? false : null,
      };
    },
  };
}

const pastReset = (r: QuotaRow, now: number) =>
  (r.weekResetsAt !== null && now >= r.weekResetsAt) || (r.fiveResetsAt !== null && now >= r.fiveResetsAt);

/**
 * D103 (one source, `views.ts` + the schedule): a tier with `max` → true; else the last ok usage response (`five_window`);
 * nothing known → `fivePct !== null` (never a 5-hour bar without a number).
 */
export function hasFiveWindow(planTier: string | null, r: QuotaRow | null): boolean {
  if (/max/i.test(planTier ?? '')) return true;
  if (r?.fiveWindow != null) return r.fiveWindow;
  return r?.fivePct != null;
}

/** The known resets (epoch s) of the windows this account has (Ultra: the week only). */
const resetsOf = (a: Account, r: QuotaRow | null): number[] => r === null ? [] :
  [r.weekResetsAt, hasFiveWindow(a.planTier, r) ? r.fiveResetsAt : null].filter((x): x is number => x !== null);

/** §3.4 I2: ≤10 min old, before every known resets_at, and not waiting on a probe. Anything else = unknown. */
export function isFresh(r: QuotaRow | null, now: number): boolean {
  return r !== null && r.status !== 'needs_probe' && now - r.fetchedAt <= FRESH_MAX_AGE_S && !pastReset(r, now);
}

/** A `rejected` row with no known reset is held this long after it was written (MINOR-1 ruling), or until an API refresh. */
export const LIMIT_HOLD_UNKNOWN_S = 30 * 60;

/** A `rejected` row still blocks new work while no known reset has passed; none known → for LIMIT_HOLD_UNKNOWN_S. */
export function rejectedHeld(r: QuotaRow, now: number): boolean {
  if (r.status !== 'rejected') return false;
  if (r.fiveResetsAt === null && r.weekResetsAt === null) return now - r.fetchedAt < LIMIT_HOLD_UNKNOWN_S;
  return !pastReset(r, now);
}

export type RefreshResult = 'ok' | 'rate_limited' | 'needs_probe' | 'error';
type TrackFields = Pick<AccountQuotaFields, 'refresh' | 'nextCheckAt' | 'quotaError'>;
type SkipReason = QuotaRefreshAck['skipped'][number]['reason'];

export interface QuotaTrackerOpts {
  db: Db;
  source: QuotaSource;
  /** Epoch seconds. */
  now?: () => number;
  /** §3.4 I3: fired on every change of an account's numbers or status (group 2 re-checks every session on it). */
  onAccountChanged?: (email: string) => void;
  /** §3.4 I2: 401 → a haiku probe on that account (group 2 runs it, then feeds `applyRateLimitEvent(…, 'probe')`). */
  onNeedsProbe?: (account: Account) => void;
  /** v2.7.1 §7.3: the row's refresh state / queue turn / last error changed while its numbers did not → push the row. */
  onRefreshState?: (email: string) => void;
  /** v2.7.1 §7.3: `QuotaState` (cooldown, queue end) changed. */
  onQueueState?: (s: QuotaState) => void;
  uiOpen?: boolean;
}

const sameNumbers = (a: QuotaRow | null, b: QuotaRow) => a !== null && a.fivePct === b.fivePct && a.weekPct === b.weekPct
  && a.fiveResetsAt === b.fiveResetsAt && a.weekResetsAt === b.weekResetsAt && a.status === b.status;

const pct01 = (u: unknown): number | null => {
  const n = num(u);
  return n === null ? null : Math.round(n * 1000) / 10;
};

const ms = (s: number) => s * 1000;
const MINUTE_MS = 60_000;

/** §6A the reason a failed ask shows on its row (429 / 401 have their own states). */
const errorReason = (e: unknown, status: number | null): KeyedReason =>
  e instanceof UsageError ? e.reason : status !== null ? { key: 'errors.quotaHttp', params: { status } } : { key: 'errors.quotaNetwork' };

export class QuotaTracker {
  private readonly db: Db;
  private readonly source: QuotaSource;
  private readonly now: () => number;
  private readonly onChanged: (email: string) => void;
  private readonly onNeedsProbe: (account: Account) => void;
  private readonly onRefreshState: (email: string) => void;
  private readonly onQueueState: (s: QuotaState) => void;
  private uiOpen: boolean;
  private readonly lastAttempt = new Map<string, number>();
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private cooldownUntil = Number.NEGATIVE_INFINITY;
  /** §7.2 the manual queue, in ask order (no duplicates). */
  private queue: string[] = [];
  private fetching: { email: string; manual: boolean } | null = null;
  private readonly errors = new Map<string, NonNullable<TrackFields['quotaError']>>();
  private lastState = '';

  constructor(o: QuotaTrackerOpts) {
    this.db = o.db;
    this.source = o.source;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.onChanged = o.onAccountChanged ?? (() => {});
    this.onNeedsProbe = o.onNeedsProbe ?? (() => {});
    this.onRefreshState = o.onRefreshState ?? (() => {});
    this.onQueueState = o.onQueueState ?? (() => {});
    this.uiOpen = o.uiOpen ?? false;
  }

  setUiOpen(open: boolean): void { this.uiOpen = open; }

  get(email: string): QuotaRow | null { return getQuota(this.db, email); }

  isFresh(email: string): boolean { return isFresh(this.get(email), this.now()); }

  private last(email: string): number {
    const m = this.lastAttempt.get(email);
    if (m !== undefined) return m;
    const r = this.get(email); // engine restart: the persisted API fetch still counts toward the floor
    return r && r.source === 'api' ? r.fetchedAt : Number.NEGATIVE_INFINITY;
  }

  /** When the next API call for this account is allowed by §8.1 (UI 5 min / background 15 min; past reset → 5 min). */
  private dueAt(a: Account): number {
    const now = this.now();
    const fast = this.uiOpen || resetsOf(a, this.get(a.email)).some((at) => now >= at);
    return this.last(a.email) + (fast ? POLL_UI_S : POLL_BACKGROUND_S);
  }

  /** v2.7.1 §7.1-1: 60 s after the earliest known reset not asked about since (only windows the account has); null = none. */
  private resetDue(a: Account): number | null {
    const last = this.last(a.email);
    const open = resetsOf(a, this.get(a.email)).filter((at) => last < at);
    return open.length ? Math.min(...open) + RESET_RECHECK_S : null;
  }

  private globalBlocked(now: number): boolean {
    return now - this.lastCallAt < GLOBAL_GAP_S || now < this.cooldownUntil;
  }

  /** The earliest moment the next call may go out (20 s gap, 429 cooldown). */
  private earliest(now: number): number { return Math.max(now, this.lastCallAt + GLOBAL_GAP_S, this.cooldownUntil); }

  /** §4.4 the expected ask time (epoch s) of each queued account. */
  private turns(now: number): [string, number][] {
    const start = this.earliest(now);
    return this.queue.map((e, i) => [e, start + i * GLOBAL_GAP_S]);
  }

  /**
   * At most one API call (§7.1-3): the manual queue first, then a reset due, then the most overdue account — if the
   * global spacing allows. `manualOnly` = the fast queue tick (§7.1-3, every 5 s while the queue is not empty).
   */
  async tick(accounts: Account[], manualOnly = false): Promise<{ email: string; result: RefreshResult } | null> {
    const now = this.now();
    if (this.globalBlocked(now) || this.fetching !== null) return null;
    const byEmail = new Map(accounts.map((a) => [a.email, a]));
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => byEmail.has(e)); // a deleted account leaves the queue
    const head = this.queue.shift();
    const pick = head !== undefined ? byEmail.get(head)! : manualOnly ? null : this.dueAccount(accounts, now);
    if (!pick) {
      if (before !== this.queue.length) this.pushState();
      return null;
    }
    return { email: pick.email, result: await this.call(pick, now, head !== undefined) };
  }

  private dueAccount(accounts: Account[], now: number): Account | null {
    let best: Account | null = null;
    let bestDue = Number.POSITIVE_INFINITY;
    for (const a of accounts) {
      const d = this.resetDue(a);
      if (d !== null && d <= now && d < bestDue) { best = a; bestDue = d; }
    }
    if (best) return best;
    for (const a of accounts) {
      const d = this.dueAt(a);
      if (d <= now && d < bestDue) { best = a; bestDue = d; }
    }
    return best;
  }

  /**
   * v2.7.1 §7.2 `quota_refresh`: queue the accounts (already in ask order) and answer at once. `front` (⟳ of one row) puts
   * them first; the rest keep their place, never twice. D101: asked < 60 s ago → skipped `recent`.
   */
  requestRefresh(accounts: Account[], o: { front: boolean; loggedOut: ReadonlySet<string> }): QuotaRefreshAck {
    const now = this.now();
    const queued: string[] = [];
    const skipped: QuotaRefreshAck['skipped'] = [];
    const skip = (email: string, reason: SkipReason, until: number | null) => { skipped.push({ email, reason, until }); };
    for (const a of accounts) {
      const last = this.last(a.email);
      if (o.loggedOut.has(a.email)) skip(a.email, 'logged_out', null);
      else if (this.get(a.email)?.status === 'needs_probe') skip(a.email, 'needs_probe', null);
      else if (now < last + MANUAL_FLOOR_S || this.fetching?.email === a.email) skip(a.email, 'recent', ms(last + MANUAL_FLOOR_S));
      else queued.push(a.email);
    }
    const fresh = queued.filter((e) => !this.queue.includes(e));
    this.queue = o.front ? [...queued, ...this.queue.filter((e) => !queued.includes(e))] : [...this.queue, ...fresh];
    for (const e of o.front ? this.queue : fresh) this.onRefreshState(e);
    this.pushState();
    return { queued: this.queue.filter((e) => queued.includes(e)), skipped, cooldownUntil: this.state().cooldownUntil };
  }

  /** v2.7.1 §7.3 `Snapshot.quota`: the 429 cooldown in force, and when the manual queue is done (rounded up to the minute). */
  state(): QuotaState {
    const now = this.now();
    const turns = this.turns(now);
    const end = turns.length ? turns[turns.length - 1]![1] : this.fetching?.manual ? now : null;
    return {
      cooldownUntil: now < this.cooldownUntil ? ms(this.cooldownUntil) : null,
      queueEndsAt: end === null ? null : Math.ceil(ms(end) / MINUTE_MS) * MINUTE_MS,
    };
  }

  private pushState(): void {
    const s = this.state();
    const key = JSON.stringify(s);
    if (key !== this.lastState) { this.lastState = key; this.onQueueState(s); }
  }

  /** v2.7.1 §7.3 the tracker part of `AccountView`. `auto` = the scheduled polls run (config `quotaReading`). */
  view(a: Account, auto: boolean): TrackFields {
    const now = this.now();
    const turn = this.turns(now).find(([e]) => e === a.email)?.[1] ?? null;
    const refresh: TrackFields['refresh'] = this.fetching?.email === a.email ? { state: 'fetching', at: null }
      : turn !== null ? { state: 'queued', at: ms(turn) } : { state: 'idle', at: null };
    const next = [turn, auto ? this.resetDue(a) : null, auto ? this.dueAt(a) : null].filter((x): x is number => x !== null);
    return {
      refresh,
      nextCheckAt: next.length ? ms(Math.max(Math.min(...next), this.earliest(now))) : null,
      quotaError: this.errors.get(a.email) ?? null,
    };
  }

  private async call(a: Account, now: number, manual: boolean): Promise<RefreshResult> {
    const prevAttempt = this.lastAttempt.get(a.email);
    this.lastAttempt.set(a.email, now);
    this.lastCallAt = now;
    this.fetching = { email: a.email, manual };
    this.onRefreshState(a.email);
    let u: UsageSnapshot | null = null;
    let err: unknown = null;
    try { u = await this.source.fetchUsage(a); } catch (e) { err = e; } finally { this.fetching = null; } // idle before any push
    let changed = false;
    try {
      if (u) {
        this.errors.delete(a.email);
        changed = this.write(this.get(a.email), {
          account: a.email, fivePct: u.fivePct, weekPct: u.weekPct, fiveResetsAt: u.fiveResetsAt, weekResetsAt: u.weekResetsAt,
          source: 'api', fetchedAt: now, status: 'ok', fiveWindow: u.fiveWindow ?? null,
        });
        return 'ok';
      }
      const status = err instanceof UsageHttpError ? err.status : null;
      if (status === 429) { // §4.4 the ask did not happen: it keeps its turn (front of the queue / reset due) after the cooldown
        this.cooldownUntil = now + RATE_LIMIT_COOLDOWN_S;
        if (prevAttempt === undefined) this.lastAttempt.delete(a.email); else this.lastAttempt.set(a.email, prevAttempt);
        if (manual) this.queue.unshift(a.email);
        for (const e of this.queue) if (e !== a.email) this.onRefreshState(e);
        return 'rate_limited';
      }
      if (status === 401) {
        this.errors.delete(a.email);
        const prev = this.get(a.email);
        const next: QuotaRow = prev
          ? { ...prev, status: 'needs_probe' }
          : { account: a.email, fivePct: null, weekPct: null, fiveResetsAt: null, weekResetsAt: null, source: 'api', fetchedAt: now, status: 'needs_probe' };
        changed = this.write(prev, next);
        if (prev?.status !== 'needs_probe') this.onNeedsProbe(a);
        return 'needs_probe';
      }
      const r = errorReason(err, status);
      this.errors.set(a.email, { key: r.key, ...(r.params ? { params: r.params } : {}), at: ms(now) });
      return 'error';
    } finally {
      if (!changed) this.onRefreshState(a.email);
      this.pushState();
    }
  }

  /** Writes the row; true when its numbers / status changed (→ `onAccountChanged`, which pushes the row). */
  private write(prev: QuotaRow | null, next: QuotaRow): boolean {
    upsertQuota(this.db, next);
    if (sameNumbers(prev, next)) return false;
    this.onChanged(next.account);
    return true;
  }

  /**
   * A `result` classified as a limit (g2-t3 concern 2): mark the account `rejected` so waiting sessions do not pick it
   * again. It holds until the row's known reset (windows whose reset already passed are dropped) or until the next
   * API refresh overwrites it. Numbers and their age are kept, so a stale week number is never made to look fresh.
   */
  markLimited(email: string): void {
    const now = this.now();
    const prev = this.get(email);
    const live = (pct: number | null | undefined, at: number | null | undefined) =>
      at !== null && at !== undefined && now < at ? { pct: pct ?? null, at } : { pct: null, at: null };
    const five = live(prev?.fivePct, prev?.fiveResetsAt);
    const week = live(prev?.weekPct, prev?.weekResetsAt);
    this.write(prev, {
      account: email, fivePct: five.pct, fiveResetsAt: five.at, weekPct: week.pct, weekResetsAt: week.at,
      // No reset known → both numbers are null, so the row's age is the mark's age (the 30-min hold counts from now).
      source: prev?.source ?? 'stream', fetchedAt: five.at === null && week.at === null ? now : prev?.fetchedAt ?? now, status: 'rejected',
    });
  }

  /**
   * Live `rate_limit_event` from any session on `email` (§3.3-9), already normalized by the stream parser (one shape
   * table for both the `unifiedWindows` and the flat SDK shape): utilization 0–1 → %, status, resetsAt. Windows the
   * event leaves out keep the previous value only while that value is still fresh (I2), so stale numbers never revive.
   */
  applyRateLimitEvent(email: string, ev: RateLimitEvent, source: 'stream' | 'probe' = 'stream'): void {
    const read = (w: RateWindow | null) => {
      const pct = w ? pct01(w.utilization) : null;
      return pct === null ? null : { pct, resetsAt: w!.resetsAt };
    };
    let five = read(ev.fiveHour);
    let week = read(ev.sevenDay);
    const raw = ev.status;
    const status: QuotaStatus | null = raw === 'allowed' ? 'ok' : raw === 'allowed_warning' || raw === 'rejected' ? raw : null;
    if (status === 'rejected') {
      const info = isObj(ev.raw.rate_limit_info) ? ev.raw.rate_limit_info : {};
      const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : '';
      const until = ev.resetsAt;
      if (type === 'five_hour') five = { pct: 100, resetsAt: until ?? five?.resetsAt ?? null };
      if (type.startsWith('seven_day')) week = { pct: 100, resetsAt: until ?? week?.resetsAt ?? null };
    }
    if (!five && !week && !status) return;

    const now = this.now();
    const prev = this.get(email);
    const prevYoung = prev !== null && now - prev.fetchedAt <= FRESH_MAX_AGE_S;
    const keep = (pct: number | null, resetsAt: number | null) =>
      prevYoung && pct !== null && (resetsAt === null || now < resetsAt) ? { pct, resetsAt } : null;
    const keptWeek = week ? null : keep(prev?.weekPct ?? null, prev?.weekResetsAt ?? null);
    const f = five ?? keep(prev?.fivePct ?? null, prev?.fiveResetsAt ?? null);
    const w = week ?? keptWeek;
    this.write(prev, {
      account: email, fivePct: f?.pct ?? null, fiveResetsAt: f?.resetsAt ?? null,
      weekPct: w?.pct ?? null, weekResetsAt: w?.resetsAt ?? null,
      source,
      // fetchedAt = age of the week number: hard caps (week only, D6) must not be fooled by a fresh 5h-only event.
      fetchedAt: keptWeek ? prev!.fetchedAt : now,
      status: status ?? (prev && prev.status !== 'needs_probe' ? prev.status : 'ok'),
    });
  }
}
