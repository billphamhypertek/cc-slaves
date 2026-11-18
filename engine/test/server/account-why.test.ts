// v2.7.1 §4.5 / §7.3: why an account is full (`fullWhy` + `leaveAt`), `admitBlock`, `pastReset`, `fiveWindow` (D103) —
// computed next to `full` in `accountView`, the one source.
import { describe, expect, test } from 'bun:test';
import type { Account } from '../../src/accounts/registry.ts';
import type { Caps } from '../../src/config.ts';
import type { QuotaRow } from '../../src/db.ts';
import { accountView } from '../../src/server/views.ts';

const NOW = 1_800_000_000;
const MAX = 'default_claude_max_5x';
const acct = (planTier: string | null = MAX): Account =>
  ({ email: 'a@x', id: null, configDir: '/c/a', keychainService: 'k', planTier, terminal: false });
const HARD = { default: { week: 98, five: 95 }, 'a@x': { week: 70, hard: true } } as Caps;
const SOFT = { default: { week: 90, five: 95 } } as Caps;
const q = (o: Partial<QuotaRow> = {}): QuotaRow => ({
  account: 'a@x', fivePct: 8, weekPct: 40, fiveResetsAt: NOW + 3600, weekResetsAt: NOW + 86_400, source: 'api', fetchedAt: NOW - 60, status: 'ok', ...o,
});
const view = (quota: QuotaRow | null, caps: Caps = HARD, planTier: string | null = MAX, now = NOW) =>
  accountView({ account: acct(planTier), caps, quota, lanes: 0, now, loggedOut: false });

describe('§4.5 fullWhy', () => {
  test('§4.5 hard cap 70, week 73 % → full, leaveAt 69 (the 08:05 case)', () => {
    const v = view(q({ weekPct: 73 }));
    expect(v.full).toBe(true);
    expect(v.fullWhy).toEqual({ window: 'week', by: 'cap', usedPct: 73, cap: 70, leaveAt: 69, hard: true, resetsAt: (NOW + 86_400) * 1000 });
    expect(v.admitBlock).toBeNull();
    expect(v.pastReset).toBeNull();
  });
  test('§4.5 hard cap 70, week 69.5 % → full, "dừng ở 69 %"', () => {
    expect(view(q({ weekPct: 69.5 })).fullWhy).toMatchObject({ window: 'week', usedPct: 69.5, leaveAt: 69, hard: true });
  });
  test('§4.5 hard cap 70, week exactly 69 % (= leaveAt) → full', () => {
    const v = view(q({ weekPct: 69 }));
    expect(v.full).toBe(true);
    expect(v.fullWhy).toMatchObject({ window: 'week', usedPct: 69, leaveAt: 69, hard: true });
    expect(v.admitBlock).toBeNull();
  });
  test('§4.5 soft cap 90 → leaveAt = cap', () => {
    expect(view(q({ weekPct: 92 }), SOFT).fullWhy).toMatchObject({ window: 'week', by: 'cap', cap: 90, leaveAt: 90, hard: false });
  });
  test('§4.5 5-hour ≥ its cap (Max) → window five, always soft', () => {
    expect(view(q({ fivePct: 96 }), SOFT).fullWhy).toEqual({
      window: 'five', by: 'cap', usedPct: 96, cap: 95, leaveAt: 95, hard: false, resetsAt: (NOW + 3600) * 1000,
    });
  });
  test('§4.5 rejected → by anthropic: five on Max, week on Ultra / when the week is at 100 %', () => {
    expect(view(q({ status: 'rejected' }), SOFT).fullWhy).toMatchObject({ window: 'five', by: 'anthropic', cap: null, leaveAt: null });
    expect(view(q({ status: 'rejected', fivePct: null, fiveResetsAt: null, fiveWindow: false }), SOFT, null).fullWhy)
      .toMatchObject({ window: 'week', by: 'anthropic', usedPct: 40 });
    expect(view(q({ status: 'rejected', weekPct: 100 }), SOFT).fullWhy).toMatchObject({ window: 'week', by: 'anthropic' });
  });
  test('§4.5 not full → fullWhy null', () => {
    const v = view(q({ weekPct: 40 }));
    expect(v.full).toBe(false);
    expect(v.fullWhy).toBeNull();
  });
});

describe('§4.5 admitBlock (L13, picker week_full)', () => {
  test('§4.5 hard cap 70, week 68 % → not full, admitBlock {68, 67, 70, 69}', () => {
    const v = view(q({ weekPct: 68 }));
    expect(v.full).toBe(false);
    expect(v.fullWhy).toBeNull();
    expect(v.admitBlock).toEqual({ usedPct: 68, admitMax: 67, cap: 70, leaveAt: 69 });
  });
  test('§4.5 at the admit line (67 %) or soft → none', () => {
    expect(view(q({ weekPct: 67 })).admitBlock).toBeNull();
    expect(view(q({ weekPct: 89 }), SOFT).admitBlock).toBeNull();
  });
});

describe('§4.4 pastReset', () => {
  test('§4.5 now = resetsAt + 1 s, not asked again → fullWhy null, pastReset set; full kept for the picker', () => {
    const at = NOW + 86_400;
    const v = view(q({ weekPct: 73 }), HARD, MAX, at + 1);
    expect(v.full).toBe(true);
    expect(v.fullWhy).toBeNull();
    expect(v.pastReset).toEqual({ window: 'week', at: at * 1000, recheckAt: null });
  });
  test('§4.5 now = resetsAt exactly → the reset counts as passed: pastReset set, fullWhy null', () => {
    const at = NOW + 86_400;
    const v = view(q({ weekPct: 73 }), HARD, MAX, at);
    expect(v.fullWhy).toBeNull();
    expect(v.pastReset).toEqual({ window: 'week', at: at * 1000, recheckAt: null });
  });
  test('§4.4 recheckAt = the tracker nextCheckAt', () => {
    const v = accountView({
      account: acct(), caps: SOFT, quota: q({ fivePct: 96 }), lanes: 0, now: NOW + 3601, loggedOut: false,
      track: { refresh: { state: 'idle', at: null }, nextCheckAt: (NOW + 3660) * 1000, quotaError: null },
    });
    expect(v.pastReset).toEqual({ window: 'five', at: (NOW + 3600) * 1000, recheckAt: (NOW + 3660) * 1000 });
  });
});

describe('§7.3 D103 Ultra (no 5-hour window)', () => {
  const ultra = (o: Partial<QuotaRow> = {}) => q({ fivePct: null, fiveResetsAt: null, fiveWindow: false, ...o });
  test('D103 fiveWindow: tier max → true; Ultra row → false; nothing known → fivePct !== null', () => {
    expect(view(q({ fivePct: null, fiveResetsAt: null })).fiveWindow).toBe(true);
    expect(view(ultra(), SOFT, null).fiveWindow).toBe(false);
    expect(view(q(), SOFT, null).fiveWindow).toBe(true);
    expect(view(null, SOFT, null).fiveWindow).toBe(false);
  });
  test('D103 Ultra at week 40 % is never full by 5 hours (even with a stale five number), no five pastReset', () => {
    const v = view(ultra({ fivePct: 99, fiveResetsAt: NOW - 10 }), SOFT, null);
    expect(v.full).toBe(false);
    expect(v.fullWhy).toBeNull();
    expect(v.pastReset).toBeNull();
  });
  test('§7.3 default track fields: idle, no nextCheckAt, no error', () => {
    expect(view(q())).toMatchObject({ refresh: { state: 'idle', at: null }, nextCheckAt: null, quotaError: null });
  });
});
