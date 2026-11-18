import { beforeEach, describe, expect, test } from 'bun:test';
import type { Account } from '../../src/accounts/registry.ts';
import {
  FRESH_MAX_AGE_S, GLOBAL_GAP_S, LIMIT_HOLD_UNKNOWN_S, MANUAL_FLOOR_S, POLL_BACKGROUND_S, POLL_UI_S, QuotaTracker, UsageHttpError, isFresh, rejectedHeld,
  keychainHasLogin, keychainQuotaSource, type QuotaSource, type UsageSnapshot,
} from '../../src/accounts/quota.ts';
import { pick, shouldLeave } from '../../src/accounts/picker.ts';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import { PO_CAPS } from '../_fixtures/po-caps.ts';
import { getQuota, openDb, type Db, type QuotaRow } from '../../src/db.ts';
import { classify, type RateLimitEvent } from '../../src/stream/parser.ts';

const T0 = 1_800_000_000;
const acct = (email: string): Account => ({
  email, id: null, configDir: `/x/${email}`, keychainService: `svc-${email}`, planTier: null, terminal: false,
});
const A = acct('a@x');
const B = acct('b@x');
const snap = (week: number, five: number | null = 10): UsageSnapshot => ({
  weekPct: week, fivePct: five, weekResetsAt: T0 + 86_400, fiveResetsAt: T0 + 3_600,
});

let db: Db;
let now: number;
let calls: string[];
let next: Map<string, UsageSnapshot | Error>;
let changed: string[];
let probes: string[];
let tracker: QuotaTracker;

const source: QuotaSource = {
  async fetchUsage(a) {
    calls.push(a.email);
    const r = next.get(a.email) ?? snap(50);
    if (r instanceof Error) throw r;
    return r;
  },
};

beforeEach(() => {
  db = openDb(':memory:');
  now = T0;
  calls = []; next = new Map(); changed = []; probes = [];
  tracker = new QuotaTracker({
    db, source, now: () => now, onAccountChanged: (e) => changed.push(e), onNeedsProbe: (a) => probes.push(a.email),
  });
});

const tick = async (list: Account[]) => (await tracker.tick(list))?.email ?? null;
/** "⟳" of one row (v2.7.1 §7.2): queue it first and run the queue tick; 'skipped' = refused (floor / needs_probe) or blocked. */
const refresh = async (a: Account) => {
  tracker.requestRefresh([a], { front: true, loggedOut: new Set() });
  return (await tracker.tick([a], true))?.result ?? 'skipped';
};

const row = (p: Partial<QuotaRow>): QuotaRow => ({
  account: 'a@x', fivePct: 1, weekPct: 1, fiveResetsAt: T0 + 3600, weekResetsAt: T0 + 86400, source: 'api',
  fetchedAt: T0, status: 'ok', ...p,
});

describe('isFresh (§3.4 I2)', () => {
  test('§3.4 I2 fresh when ≤10 min old and before every resets_at', () => {
    expect(isFresh(row({}), T0 + FRESH_MAX_AGE_S)).toBe(true);
    expect(FRESH_MAX_AGE_S).toBe(600);
  });
  test('§3.4 I2 stale when older than 10 min', () => {
    expect(isFresh(row({}), T0 + FRESH_MAX_AGE_S + 1)).toBe(false);
  });
  test('§3.4 I2 past week resets_at → unknown', () => {
    expect(isFresh(row({ weekResetsAt: T0 + 10 }), T0 + 10)).toBe(false);
  });
  test('§3.4 I2 past 5h resets_at → unknown', () => {
    expect(isFresh(row({ fiveResetsAt: T0 + 5 }), T0 + 6)).toBe(false);
  });
  test('§3.4 I2 needs_probe row is never fresh; null row is never fresh', () => {
    expect(isFresh(row({ status: 'needs_probe' }), T0)).toBe(false);
    expect(isFresh(null, T0)).toBe(false);
  });
});

describe('QuotaTracker polling (§8.1, §3.3-9)', () => {
  test('§8.1 refresh persists via the quota repo and emits accountChanged', async () => {
    expect(await refresh(A)).toBe('ok');
    expect(getQuota(db, 'a@x')).toMatchObject({ weekPct: 50, fivePct: 10, source: 'api', status: 'ok', fetchedAt: T0 });
    expect(changed).toEqual(['a@x']);
    expect(tracker.isFresh('a@x')).toBe(true);
  });

  test('§3.4 I3 unchanged numbers → no accountChanged on the second poll', async () => {
    await refresh(A);
    now += POLL_UI_S;
    await refresh(A);
    expect(changed).toEqual(['a@x']);
  });

  test('§8.1 scheduled polls at most every 5 min (UI open); D101 a manual ask at most every 60 s', async () => {
    tracker.setUiOpen(true);
    await refresh(A);
    now += MANUAL_FLOOR_S - 1;
    expect(await refresh(A)).toBe('skipped');
    now += 1;
    expect(await refresh(A)).toBe('ok');
    now += POLL_UI_S - 1;
    expect(await tick([A])).toBeNull();
    now += 1;
    expect(await tick([A])).toBe('a@x');
    expect(calls).toEqual(['a@x', 'a@x', 'a@x']);
  });

  test('§8.1 background polls every 15 min', async () => {
    tracker.setUiOpen(false);
    await tick([A]);
    now += POLL_UI_S; // 5 min: due when UI open, not in background
    expect(await tick([A])).toBeNull();
    now = T0 + POLL_BACKGROUND_S;
    expect(await tick([A])).toBe('a@x');
    expect(POLL_BACKGROUND_S).toBe(900);
  });

  test('§3.3-9 global spacing: one API call per tick window across accounts (no 429 burst)', async () => {
    tracker.setUiOpen(true);
    expect(await tick([A, B])).toBe('a@x');
    expect(await tick([A, B])).toBeNull();
    now += GLOBAL_GAP_S - 1;
    expect(await tick([A, B])).toBeNull();
    now += 1;
    expect(await tick([A, B])).toBe('b@x');
    expect(calls).toEqual(['a@x', 'b@x']);
  });

  test('§3.4 I2 past resets_at → refreshed at the 5-min floor even in background', async () => {
    tracker.setUiOpen(false);
    next.set('a@x', { ...snap(50), weekResetsAt: T0 + 100 });
    await tick([A]);
    now = T0 + POLL_UI_S;
    expect(tracker.isFresh('a@x')).toBe(false);
    expect(await tick([A])).toBe('a@x');
  });

  test('§3.3-9 429 → keeps old numbers, backs off globally', async () => {
    await refresh(A);
    now += POLL_UI_S;
    next.set('a@x', new UsageHttpError(429));
    expect(await refresh(A)).toBe('rate_limited');
    expect(getQuota(db, 'a@x')).toMatchObject({ weekPct: 50, status: 'ok', fetchedAt: T0 });
    now += GLOBAL_GAP_S;
    expect(await tick([B])).toBeNull(); // still inside the 429 cooldown
  });

  test('§3.4 I2 401 → needs_probe, probe hook fired once, account not fresh', async () => {
    await refresh(A);
    now += POLL_UI_S;
    next.set('a@x', new UsageHttpError(401));
    expect(await refresh(A)).toBe('needs_probe');
    expect(getQuota(db, 'a@x')).toMatchObject({ status: 'needs_probe', weekPct: 50 });
    expect(probes).toEqual(['a@x']);
    expect(tracker.isFresh('a@x')).toBe(false);
    expect(changed).toEqual(['a@x', 'a@x']);
    now += POLL_UI_S;
    await refresh(A);
    expect(probes).toEqual(['a@x']); // no repeat while still needs_probe
  });

  test('§3.4 I2 401 on an account with no row → needs_probe row with null numbers', async () => {
    next.set('a@x', new UsageHttpError(401));
    await refresh(A);
    expect(getQuota(db, 'a@x')).toMatchObject({ status: 'needs_probe', weekPct: null, fivePct: null });
  });

  test('§8.1 network error → error result, row untouched', async () => {
    next.set('a@x', new Error('ECONNRESET'));
    expect(await refresh(A)).toBe('error');
    expect(getQuota(db, 'a@x')).toBeNull();
  });
});

describe('applyRateLimitEvent (§3.3-9, §3.4 I3)', () => {
  // One shape table: the tracker consumes the parser's normalized event (IMPORTANT-1, g1 review).
  const ev = (info: object) => classify({ type: 'rate_limit_event', rate_limit_info: info }) as RateLimitEvent;

  test('§3.3-9 utilization 0–1 → %, resetsAt, status merged; source stream', () => {
    tracker.applyRateLimitEvent('a@x', ev({
      status: 'allowed_warning', resetsAt: T0 + 9000, rateLimitType: 'seven_day',
      unifiedWindows: { seven_day: { utilization: 0.73, resetsAt: T0 + 9000 }, five_hour: { utilization: 0.2, resetsAt: T0 + 100 } },
    }));
    expect(getQuota(db, 'a@x')).toMatchObject({
      weekPct: 73, fivePct: 20, weekResetsAt: T0 + 9000, fiveResetsAt: T0 + 100, source: 'stream', status: 'allowed_warning', fetchedAt: T0,
    });
    expect(changed).toEqual(['a@x']);
  });

  test('§3.3-9 partial event keeps the other window from a fresh row', async () => {
    await refresh(A); // week 50, five 10
    now += 60;
    tracker.applyRateLimitEvent('a@x', ev({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: T0 + 3600 } } }));
    // fetchedAt stays the age of the week number (the one hard caps rely on, §3.4 I2)
    expect(getQuota(db, 'a@x')).toMatchObject({ weekPct: 50, fivePct: 40, status: 'ok', fetchedAt: T0 });
  });

  test('§3.4 I2 partial event does not revive a stale window', async () => {
    await refresh(A);
    now += FRESH_MAX_AGE_S + 1;
    tracker.applyRateLimitEvent('a@x', ev({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: T0 + 3600 } } }));
    expect(getQuota(db, 'a@x')).toMatchObject({ weekPct: null, weekResetsAt: null, fivePct: 40 });
  });

  test('§3.3-9 rejected → that window pinned at 100 % with its reset', () => {
    tracker.applyRateLimitEvent('a@x', ev({ status: 'rejected', resetsAt: T0 + 500, rateLimitType: 'five_hour', unifiedWindows: {} }));
    expect(getQuota(db, 'a@x')).toMatchObject({ fivePct: 100, fiveResetsAt: T0 + 500, status: 'rejected' });
  });

  test('§3.3-9 §3.4 flat SDK shape (rateLimitType + utilization) updates the week; hard account then not picked and must wait', async () => {
    const D = acct('dev2609@example.com');
    next.set(D.email, snap(50));
    await refresh(D); // young API row: week 50 %
    now += 60;
    tracker.applyRateLimitEvent(D.email, ev({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.91, resetsAt: T0 + 9000 }));
    const row = getQuota(db, D.email)!;
    expect(row).toMatchObject({ weekPct: 91, weekResetsAt: T0 + 9000, status: 'allowed_warning', fetchedAt: now });
    const caps = structuredClone(PO_CAPS);
    const r = pick({
      accounts: [D], quotas: { [D.email]: row }, caps, laneCounts: {}, machineLaneCount: 0,
      config: { ...DEFAULT_CONFIG }, now, exclude: [], kind: 'lane',
    });
    expect('none' in r && r.reason).toBe('all_full');
    expect(shouldLeave({ account: D, quota: row, caps, now, otherFree: false })).toBe('wait');
  });

  test('§3.4 I2 probe event clears needs_probe', async () => {
    next.set('a@x', new UsageHttpError(401));
    await refresh(A);
    tracker.applyRateLimitEvent('a@x', ev({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.1, resetsAt: T0 + 9000 } } }), 'probe');
    expect(getQuota(db, 'a@x')).toMatchObject({ status: 'ok', source: 'probe', weekPct: 10 });
  });

  test('§3.3-9 malformed event is ignored without throwing', () => {
    tracker.applyRateLimitEvent('a@x', classify({ type: 'rate_limit_event' }) as RateLimitEvent);
    tracker.applyRateLimitEvent('a@x', ev({ unifiedWindows: { seven_day: { utilization: 'x' } } }));
    expect(getQuota(db, 'a@x')).toBeNull();
    expect(changed).toEqual([]);
  });
});

describe('keychainQuotaSource (§8.1, D7)', () => {
  const TOKEN = `${'sk-'}ant-oat01-SECRET-TOKEN-zzz`; // built at run time: the release export scan blocks the literal
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } });

  test('§8.1 reads token via /usr/bin/security -w for the account service, calls the usage API', async () => {
    const execs: [string, string[]][] = [];
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const src = keychainQuotaSource({
      exec: (cmd, args) => { execs.push([cmd, args]); return creds; },
      fetch: async (url, init) => {
        seen = { url: String(url), headers: init?.headers as Record<string, string> };
        return new Response(JSON.stringify({
          five_hour: { utilization: 12.5, resets_at: '2027-01-01T00:00:00Z' },
          seven_day: { utilization: 40, resets_at: '2027-01-02T00:00:00Z' },
          seven_day_breakdown: { rows: [{ key: 'claude_code', percent: 80 }] },
        }));
      },
    });
    const u = await src.fetchUsage(A);
    expect(execs).toEqual([['/usr/bin/security', ['find-generic-password', '-s', 'svc-a@x', '-w']]]);
    expect(seen!.url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(seen!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(seen!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(u).toEqual({
      fivePct: 12.5, weekPct: 40, fiveResetsAt: Date.parse('2027-01-01T00:00:00Z') / 1000,
      weekResetsAt: Date.parse('2027-01-02T00:00:00Z') / 1000, breakdown: { claude_code: 80 }, fiveWindow: true,
    });
  });

  test('D7 token never appears in thrown errors or db rows', async () => {
    const errs: string[] = [];
    const bodies = [
      new Response(`unauthorized ${TOKEN}`, { status: 401 }),
      new Response(`server ${TOKEN}`, { status: 500 }),
      new Response(`{"bad": "${TOKEN}"`, { status: 200 }),
    ];
    for (const res of bodies) {
      const src = keychainQuotaSource({ exec: () => creds, fetch: async () => res });
      try { await src.fetchUsage(A); } catch (e) { errs.push(String(e), (e as Error).stack ?? ''); }
    }
    for (const out of ['not json ' + TOKEN, JSON.stringify({ claudeAiOauth: {} })]) {
      const src = keychainQuotaSource({ exec: () => out, fetch: async () => new Response('{}') });
      try { await src.fetchUsage(A); } catch (e) { errs.push(String(e)); }
    }
    const src = keychainQuotaSource({ exec: () => { throw new Error(`security failed ${TOKEN}`); }, fetch: async () => new Response('{}') });
    try { await src.fetchUsage(A); } catch (e) { errs.push(String(e)); }
    const net = keychainQuotaSource({ exec: () => creds, fetch: async (_u, init) => { throw new Error(`ECONNRESET ${JSON.stringify(init?.headers)}`); } });
    try { await net.fetchUsage(A); } catch (e) { errs.push(String(e), (e as Error).stack ?? ''); }
    expect(errs.length).toBeGreaterThanOrEqual(8);
    for (const e of errs) expect(e).not.toContain(TOKEN);

    const t = new QuotaTracker({ db, source: keychainQuotaSource({ exec: () => creds, fetch: async () => new Response('', { status: 401 }) }), now: () => now });
    expect((await t.tick([A]))?.result).toBe('needs_probe');
    const dump = JSON.stringify(db.query('SELECT * FROM quota').all());
    expect(dump).not.toContain(TOKEN);
  });
});

describe('markLimited — a limit `result` (g2-t3 concern 2)', () => {
  test('limit result marks the account rejected, keeps numbers + age + future resets, fires onAccountChanged', () => {
    tracker.applyRateLimitEvent(A.email, classify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
      five_hour: { utilization: 0.9, resetsAt: T0 + 3600 }, seven_day: { utilization: 0.4, resetsAt: T0 + 86400 } } } }) as RateLimitEvent);
    changed = [];
    now = T0 + 30;
    tracker.markLimited(A.email);
    const r = getQuota(db, A.email)!;
    expect(r).toMatchObject({ status: 'rejected', fivePct: 90, weekPct: 40, fiveResetsAt: T0 + 3600, weekResetsAt: T0 + 86400, fetchedAt: T0 });
    expect(changed).toEqual([A.email]);
  });

  test('no row yet → a rejected row with no numbers and no reset (held until the next API refresh)', () => {
    tracker.markLimited(A.email);
    expect(getQuota(db, A.email)).toMatchObject({ status: 'rejected', fivePct: null, weekPct: null, fiveResetsAt: null, weekResetsAt: null });
  });

  test('a window whose reset already passed is dropped (its reset is no longer known)', () => {
    db.query("INSERT INTO quota VALUES ('a@x', 99, 50, ?, ?, 'api', ?, 'ok', NULL)").run(T0 - 10, T0 + 86400, T0 - 4000);
    tracker.markLimited(A.email);
    expect(getQuota(db, A.email)).toMatchObject({ status: 'rejected', fivePct: null, fiveResetsAt: null, weekPct: 50, weekResetsAt: T0 + 86400 });
  });

  test('§3.4 MINOR-1 no known reset → released 30 min after the mark (LIMIT_HOLD_UNKNOWN_S), not forever', () => {
    db.query("INSERT INTO quota VALUES ('a@x', 99, 50, ?, ?, 'api', ?, 'ok', NULL)").run(T0 - 10, T0 - 5, T0 - 4000);
    tracker.markLimited(A.email);
    const r = getQuota(db, A.email)!;
    expect(r).toMatchObject({ status: 'rejected', fiveResetsAt: null, weekResetsAt: null, fetchedAt: T0 });
    expect(LIMIT_HOLD_UNKNOWN_S).toBe(30 * 60);
    expect(rejectedHeld(r, T0 + LIMIT_HOLD_UNKNOWN_S - 1)).toBe(true);
    expect(rejectedHeld(r, T0 + LIMIT_HOLD_UNKNOWN_S)).toBe(false);
    expect(rejectedHeld(r, T0 + 30 * 86400)).toBe(false);
  });

  test('§3.4 MINOR-1 a known future reset still holds past 30 min', () => {
    db.query("INSERT INTO quota VALUES ('a@x', 99, 50, ?, ?, 'api', ?, 'ok', NULL)").run(T0 + 7200, T0 + 86400, T0 - 4000);
    tracker.markLimited(A.email);
    expect(rejectedHeld(getQuota(db, A.email)!, T0 + 3600)).toBe(true);
  });

  test('the next API refresh clears the mark', async () => {
    tracker.markLimited(A.email);
    expect(await refresh(A)).toBe('ok');
    expect(getQuota(db, A.email)!.status).toBe('ok');
  });
});

describe('keychainHasLogin (F16, smoke g6)', () => {
  const acct = { keychainService: 'Claude Code-credentials-1b6d9cec' };
  test('F16 an item with only mcpOAuth (logged out in CC Switch) is not a login', () => {
    const seen: string[][] = [];
    expect(keychainHasLogin(acct, (cmd, args) => { seen.push([cmd, ...args]); return JSON.stringify({ mcpOAuth: { x: 1 } }); })).toBe(false);
    expect(seen).toEqual([['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials-1b6d9cec', '-w']]);
  });
  test('F16 claudeAiOauth.accessToken present → login; missing item / not JSON / empty token → no login', () => {
    expect(keychainHasLogin(acct, () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))).toBe(true);
    expect(keychainHasLogin(acct, () => { throw new Error('exit 44'); })).toBe(false);
    expect(keychainHasLogin(acct, () => 'not json')).toBe(false);
    expect(keychainHasLogin(acct, () => JSON.stringify({ claudeAiOauth: { accessToken: '' } }))).toBe(false);
  });
});
