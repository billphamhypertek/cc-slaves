// v2.7.1 §7.1–§7.2 / D101: the quota schedule — re-check after a reset, the manual queue (60 s floor, front of queue),
// the 20 s global gap and the 120 s 429 cooldown, `nextCheckAt` from its three sources, the error kept for the row.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { Account } from '../../src/accounts/registry.ts';
import {
  GLOBAL_GAP_S, MANUAL_FLOOR_S, POLL_BACKGROUND_S, POLL_UI_S, QuotaTracker, RESET_RECHECK_S, UsageError, UsageHttpError,
  hasFiveWindow, keychainQuotaSource, type QuotaSource, type UsageSnapshot,
} from '../../src/accounts/quota.ts';
import { getQuota, openDb, type Db } from '../../src/db.ts';
import { classify, type RateLimitEvent } from '../../src/stream/parser.ts';

const T0 = 1_800_000_000;
const acct = (email: string, planTier: string | null = null): Account => ({
  email, id: null, configDir: `/x/${email}`, keychainService: `svc-${email}`, planTier, terminal: false,
});
const A = acct('a@x');
const B = acct('b@x');
const C = acct('c@x');
const ALL = [A, B, C];

let db: Db;
let now: number;
let calls: string[];
let next: Map<string, UsageSnapshot | Error>;
let rowEvents: string[];
let queueEvents: number;
let tracker: QuotaTracker;

const snap = (week: number, o: Partial<UsageSnapshot> = {}): UsageSnapshot =>
  ({ weekPct: week, fivePct: 10, weekResetsAt: T0 + 86_400, fiveResetsAt: T0 + 3_600, ...o });

beforeEach(() => {
  db = openDb(':memory:');
  now = T0;
  calls = []; next = new Map(); rowEvents = []; queueEvents = 0;
  const source: QuotaSource = {
    async fetchUsage(a) {
      calls.push(a.email);
      const r = next.get(a.email) ?? snap(50);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  tracker = new QuotaTracker({
    db, source, now: () => now, onRefreshState: (e) => rowEvents.push(e), onQueueState: () => { queueEvents++; },
  });
});

const NONE = new Set<string>();
const ms = (s: number) => s * 1000;

describe('§7.1-1 re-check 60 s after a known reset (L6)', () => {
  test('§7.1-1 week reset passed → asked at reset + 60 s even with no UI, before the 15-min schedule', async () => {
    next.set('a@x', snap(50, { fiveResetsAt: null, weekResetsAt: T0 + 100 }));
    expect((await tracker.tick([A]))?.email).toBe('a@x');
    now = T0 + 100 + RESET_RECHECK_S - 1;
    expect(await tracker.tick([A])).toBeNull();
    now += 1;
    expect((await tracker.tick([A]))?.email).toBe('a@x');
    expect(RESET_RECHECK_S).toBe(60);
  });

  test('§4.4 a 429 on the re-check after a reset keeps the turn: asked again right after the cooldown', async () => {
    next.set('a@x', snap(50, { fiveResetsAt: null, weekResetsAt: T0 + 100 }));
    expect((await tracker.tick([A]))?.email).toBe('a@x');
    now = T0 + 100 + RESET_RECHECK_S;
    next.set('a@x', new UsageHttpError(429));
    expect(await tracker.tick([A])).toEqual({ email: 'a@x', result: 'rate_limited' });
    next.delete('a@x');
    now += 120;
    expect((await tracker.tick([A]))?.email).toBe('a@x');
  });

  test('§7.1-1 Ultra (no 5-hour window): a stale five reset never schedules; Max: the five reset does', async () => {
    const U = acct('u@x');
    db.query("INSERT INTO quota VALUES ('u@x', NULL, 40, ?, ?, 'api', ?, 'ok', 0)").run(T0 + 50, T0 + 86_400, T0);
    db.query("INSERT INTO quota VALUES ('m@x', 10, 40, ?, ?, 'api', ?, 'ok', 1)").run(T0 + 50, T0 + 86_400, T0);
    const M = acct('m@x', 'default_claude_max_5x');
    now = T0 + 50 + RESET_RECHECK_S;
    expect(tracker.view(U, true).nextCheckAt).toBe(ms(T0 + POLL_BACKGROUND_S));
    expect(tracker.view(M, true).nextCheckAt).toBe(ms(now));
    expect((await tracker.tick([U, M]))?.email).toBe('m@x');
  });

  test('§7.1-3 order per tick: manual queue → reset due → overdue schedule', async () => {
    db.query("INSERT INTO quota VALUES ('a@x', 1, 1, ?, ?, 'api', ?, 'ok', NULL)").run(T0 + 3600, T0 + 86_400, T0 - POLL_BACKGROUND_S * 2); // overdue
    db.query("INSERT INTO quota VALUES ('b@x', 1, 1, ?, ?, 'api', ?, 'ok', NULL)").run(T0 - 70, T0 + 86_400, T0 - 200); // reset due
    tracker.requestRefresh([C], { front: true, loggedOut: NONE });
    expect((await tracker.tick(ALL))?.email).toBe('c@x');
    now += GLOBAL_GAP_S;
    expect((await tracker.tick(ALL))?.email).toBe('b@x');
    now += GLOBAL_GAP_S;
    expect((await tracker.tick(ALL))?.email).toBe('a@x');
  });
});

describe('§7.2 manual queue (D101)', () => {
  test('§7.2 ack lists queued in ask order, never two calls < 20 s apart', async () => {
    const ack = tracker.requestRefresh(ALL, { front: false, loggedOut: NONE });
    expect(ack).toEqual({ queued: ['a@x', 'b@x', 'c@x'], skipped: [], cooldownUntil: null });
    expect(tracker.view(B, true).refresh).toEqual({ state: 'queued', at: ms(T0 + GLOBAL_GAP_S) });
    expect(tracker.view(C, true).refresh).toEqual({ state: 'queued', at: ms(T0 + 2 * GLOBAL_GAP_S) });
    expect(tracker.state().queueEndsAt).toBe(Math.ceil(ms(T0 + 40) / 60_000) * 60_000);
    expect((await tracker.tick(ALL, true))?.email).toBe('a@x');
    now += GLOBAL_GAP_S - 1;
    expect(await tracker.tick(ALL, true)).toBeNull();
    now += 1;
    expect((await tracker.tick(ALL, true))?.email).toBe('b@x');
    now += GLOBAL_GAP_S;
    expect((await tracker.tick(ALL, true))?.email).toBe('c@x');
    expect(tracker.state()).toEqual({ cooldownUntil: null, queueEndsAt: null });
    expect(tracker.view(C, true).refresh).toEqual({ state: 'idle', at: null });
  });

  test('§7.2 D101 an account asked < 60 s ago → skipped recent with until; logged out / needs_probe skipped', async () => {
    db.query("INSERT INTO quota VALUES ('c@x', 1, 1, NULL, NULL, 'api', ?, 'needs_probe', NULL)").run(T0 - 3600);
    await tracker.tick([A]);
    now += MANUAL_FLOOR_S - 1;
    const ack = tracker.requestRefresh(ALL, { front: false, loggedOut: new Set(['b@x']) });
    expect(ack.queued).toEqual([]);
    expect(ack.skipped).toEqual([
      { email: 'a@x', reason: 'recent', until: ms(T0 + MANUAL_FLOOR_S) },
      { email: 'b@x', reason: 'logged_out', until: null },
      { email: 'c@x', reason: 'needs_probe', until: null },
    ]);
    now += 1;
    expect(tracker.requestRefresh([A], { front: true, loggedOut: NONE }).queued).toEqual(['a@x']);
    expect(MANUAL_FLOOR_S).toBe(60);
  });

  test('§4.4 ⟳ of a queued row moves it to the front, no duplicate', () => {
    tracker.requestRefresh(ALL, { front: false, loggedOut: NONE });
    expect(tracker.requestRefresh([C], { front: true, loggedOut: NONE }).queued).toEqual(['c@x']);
    expect(tracker.requestRefresh(ALL, { front: false, loggedOut: NONE }).queued).toEqual(['c@x', 'a@x', 'b@x']);
  });

  test('§7.1 429 → no call for 120 s, the account goes back to the front, the queue runs on after', async () => {
    tracker.requestRefresh([A, B], { front: false, loggedOut: NONE });
    next.set('a@x', new UsageHttpError(429));
    expect(await tracker.tick(ALL, true)).toEqual({ email: 'a@x', result: 'rate_limited' });
    expect(tracker.state().cooldownUntil).toBe(ms(T0 + 120));
    expect(tracker.view(A, true).refresh).toEqual({ state: 'queued', at: ms(T0 + 120) });
    expect(tracker.requestRefresh([C], { front: false, loggedOut: NONE }).cooldownUntil).toBe(ms(T0 + 120));
    next.delete('a@x');
    now = T0 + 119;
    expect(await tracker.tick(ALL, true)).toBeNull();
    now = T0 + 120;
    expect((await tracker.tick(ALL, true))?.email).toBe('a@x');
    now += GLOBAL_GAP_S;
    expect((await tracker.tick(ALL, true))?.email).toBe('b@x');
    expect(tracker.state().cooldownUntil).toBeNull();
    expect(queueEvents).toBeGreaterThan(0);
  });

  test('§7.3 refresh state queued → fetching → idle, each pushed for the row', async () => {
    let seen = null as string | null;
    const t = new QuotaTracker({
      db, now: () => now,
      source: { async fetchUsage() { seen = t.view(A, true).refresh.state; return snap(5); } },
    });
    t.requestRefresh([A], { front: true, loggedOut: NONE });
    expect(t.view(A, true).refresh.state).toBe('queued');
    await t.tick([A], true);
    expect(seen).toBe('fetching');
    expect(t.view(A, true).refresh.state).toBe('idle');
    // new numbers: queued + fetching here, idle goes out with onAccountChanged; same numbers: idle pushed here too
    tracker.requestRefresh([B], { front: true, loggedOut: NONE });
    await tracker.tick([B], true);
    expect(rowEvents).toEqual(['b@x', 'b@x']);
    now += MANUAL_FLOOR_S;
    tracker.requestRefresh([B], { front: true, loggedOut: NONE });
    await tracker.tick([B], true);
    expect(rowEvents).toEqual(['b@x', 'b@x', 'b@x', 'b@x', 'b@x']);
  });

  test('§7.3 the row pushed on new numbers already reads idle (not fetching)', async () => {
    const pushed: string[] = [];
    const t: QuotaTracker = new QuotaTracker({
      db, now: () => now, source: { fetchUsage: async () => snap(7) },
      onAccountChanged: (e) => pushed.push(`${e}:${t.view(A, true).refresh.state}`),
    });
    t.requestRefresh([A], { front: true, loggedOut: NONE });
    await t.tick([A], true);
    expect(pushed).toEqual(['a@x:idle']);
  });

  test('§7.1-4 nextCheckAt = nearest of queue turn, reset due, schedule; auto off → queue only', async () => {
    tracker.setUiOpen(true);
    next.set('a@x', snap(50, { weekResetsAt: T0 + 100, fiveResetsAt: null }));
    await tracker.tick([A]);
    expect(tracker.view(A, true).nextCheckAt).toBe(ms(T0 + 100 + RESET_RECHECK_S));
    expect(tracker.view(A, false).nextCheckAt).toBeNull();
    next.set('b@x', snap(50, { weekResetsAt: T0 + 86_400, fiveResetsAt: null }));
    now += GLOBAL_GAP_S;
    await tracker.tick([B]);
    expect(tracker.view(B, true).nextCheckAt).toBe(ms(now + POLL_UI_S));
    now += MANUAL_FLOOR_S;
    tracker.requestRefresh([B], { front: true, loggedOut: NONE });
    expect(tracker.view(B, false).nextCheckAt).toBe(ms(now));
  });

  test('§7.3 quotaError: keyed reason of the last failed ask, cleared by the next ok', async () => {
    next.set('a@x', new UsageError({ key: 'errors.quotaTimeout' }));
    await tracker.tick([A]);
    expect(tracker.view(A, true).quotaError).toEqual({ key: 'errors.quotaTimeout', at: ms(T0) });
    next.set('b@x', new UsageHttpError(500));
    now += GLOBAL_GAP_S;
    await tracker.tick([B]);
    expect(tracker.view(B, true).quotaError).toEqual({ key: 'errors.quotaHttp', params: { status: 500 }, at: ms(now) });
    next.delete('a@x');
    now += POLL_BACKGROUND_S;
    await tracker.tick([A]);
    expect(tracker.view(A, true).quotaError).toBeNull();
  });
});

describe('§7.3 D103 fiveWindow signal', () => {
  const usage = async (body: unknown) => {
    const src = keychainQuotaSource({
      exec: () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }),
      fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
    });
    return src.fetchUsage(A);
  };
  const week = { utilization: 40, resets_at: '2027-01-01T00:00:00Z' };

  test('D103 usage {five_hour: null} / no five_hour key → false; five_hour object → true', async () => {
    expect((await usage({ five_hour: null, seven_day: week })).fiveWindow).toBe(false);
    expect((await usage({ seven_day: week })).fiveWindow).toBe(false);
    expect((await usage({ five_hour: { utilization: 0 }, seven_day: week })).fiveWindow).toBe(true);
    expect((await usage({})).fiveWindow).toBeNull();
  });

  test('D103 only an ok usage response writes five_window; stream / markLimited never change it', async () => {
    next.set('a@x', snap(40, { fivePct: null, fiveResetsAt: null, fiveWindow: false }));
    await tracker.tick([A]);
    expect(getQuota(db, 'a@x')?.fiveWindow).toBe(false);
    const ev = classify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: T0 + 9000 } } } }) as RateLimitEvent;
    tracker.applyRateLimitEvent('a@x', ev);
    tracker.markLimited('a@x');
    expect(getQuota(db, 'a@x')?.fiveWindow).toBe(false);
    next.set('a@x', snap(40, { fiveWindow: true }));
    now += POLL_BACKGROUND_S;
    await tracker.tick([A]);
    expect(getQuota(db, 'a@x')?.fiveWindow).toBe(true);
  });

  test('D103 tier with max → true; else the stored signal; nothing known → fivePct !== null', () => {
    const row = (fivePct: number | null, fiveWindow: boolean | null) => ({
      account: 'a@x', fivePct, weekPct: 40, fiveResetsAt: null, weekResetsAt: null, source: 'api' as const, fetchedAt: T0, status: 'ok', fiveWindow,
    });
    expect(hasFiveWindow('default_claude_max_5x', row(null, null))).toBe(true);
    expect(hasFiveWindow(null, row(10, false))).toBe(false);
    expect(hasFiveWindow(null, row(null, true))).toBe(true);
    expect(hasFiveWindow(null, row(null, null))).toBe(false);
    expect(hasFiveWindow(null, row(3, null))).toBe(true);
    expect(hasFiveWindow(null, null)).toBe(false);
  });
});
