// v2.7.1 §7.4 start options of spec_* (validation), why a hand-picked account cannot run (§4.5 copy, L13, D103), and the
// earliest reopen when "Tự chọn" finds none (SA9). Views come from the real `accountView` (one source with `full`).
import { describe, expect, test } from 'bun:test';
import type { Caps } from '../../src/config.ts';
import type { QuotaRow } from '../../src/db.ts';
import { CommandError } from '../../src/server/router.ts';
import { checkAccount, earliest, fmtAt, noAccount, startPicks, unusableWhy } from '../../src/server/start-picks.ts';
import { accountView } from '../../src/server/views.ts';

const NOW = 1_800_000_000;
const MAX = 'default_claude_max_5x';
const HARD = { default: { week: 98, five: 95 }, 'a@x': { week: 70, hard: true }, 'b@x': { week: 90 } } as Caps;
const q = (email: string, o: Partial<QuotaRow> = {}): QuotaRow => ({
  account: email, fivePct: 8, weekPct: 40, fiveResetsAt: NOW + 3600, weekResetsAt: NOW + 86_400, source: 'api', fetchedAt: NOW - 60, status: 'ok', ...o,
});
const view = (email: string, quota: QuotaRow | null, o: { tier?: string | null; out?: boolean } = {}) => accountView({
  account: { email, id: null, configDir: `/c/${email}`, keychainService: 'k', planTier: o.tier === undefined ? MAX : o.tier, terminal: false },
  caps: HARD, quota, lanes: 0, now: NOW, loggedOut: o.out ?? false,
});
const at = (s: number) => fmtAt(s * 1000);
const caught = (f: () => unknown): CommandError => { try { f(); } catch (e) { return e as CommandError; } throw new Error('no throw'); };

describe('§7.4 startPicks (option validation)', () => {
  test('absent → {} (today\'s defaults exactly)', () => expect(startPicks({})).toEqual({}));
  test('account trimmed + lower-cased; model / effort strings and null kept', () => {
    expect(startPicks({ account: ' A@X ', model: 'sonnet', effort: null })).toEqual({ account: 'a@x', model: 'sonnet', effort: null });
  });
  test('bad account (empty, not a string) → bad_input errors.badAccount', () => {
    for (const account of ['', '  ', 3, null]) expect(caught(() => startPicks({ account }))).toMatchObject({ code: 'bad_input', key: 'errors.badAccount' });
  });
  test('bad model / effort (empty, not a string) → bad_input errors.badModel', () => {
    for (const c of [{ model: '' }, { effort: ' ' }, { model: 4 }]) expect(caught(() => startPicks(c))).toMatchObject({ code: 'bad_input', key: 'errors.badModel' });
  });
});

describe('§7.4 / §4.5 unusableWhy (hand-picked account)', () => {
  test('room left → null', () => expect(unusableWhy(view('a@x', q('a@x')))).toBeNull());
  test('signed out → startAccountOut', () => expect(unusableWhy(view('a@x', q('a@x'), { out: true }))).toEqual({ key: 'errors.startAccountOut', params: { email: 'a@x' } }));
  test('needs a test run → startAccountProbe', () => expect(unusableWhy(view('a@x', q('a@x', { status: 'needs_probe' })))?.key).toBe('errors.startAccountProbe'));
  test('hard week 73 % / cap 70 → "dừng ở 69 %" + reopen', () => {
    expect(unusableWhy(view('a@x', q('a@x', { weekPct: 73 })))).toEqual({
      key: 'errors.startFullWeekHard', params: { email: 'a@x', used: 73, cap: 70, leave: 69, at: at(NOW + 86_400) },
    });
  });
  test('soft week 92 % / cap 90', () => {
    expect(unusableWhy(view('b@x', q('b@x', { weekPct: 92 })))).toEqual({ key: 'errors.startFullWeekSoft', params: { email: 'b@x', used: 92, cap: 90, at: at(NOW + 86_400) } });
  });
  test('Max 5 hours 96 % / cap 95 → five + its reset', () => {
    expect(unusableWhy(view('b@x', q('b@x', { fivePct: 96 })))).toEqual({ key: 'errors.startFullFive', params: { email: 'b@x', used: 96, cap: 95, at: at(NOW + 3600) } });
  });
  test('D103 Ultra 5 hours 96 % (no 5-hour window) → usable, never a 5-hour reason', () => {
    expect(unusableWhy(view('b@x', q('b@x', { fivePct: 96, fiveWindow: false }), { tier: 'default_claude_ultra' }))).toBeNull();
  });
  test('rejected: Max → 5 hours, Ultra → week', () => {
    expect(unusableWhy(view('b@x', q('b@x', { status: 'rejected' })))?.key).toBe('errors.startFullAnthropicFive');
    expect(unusableWhy(view('b@x', q('b@x', { status: 'rejected', fiveWindow: false }), { tier: null }))?.key).toBe('errors.startFullAnthropicWeek');
  });
  test('full, reset unknown → startFullNoReset', () => {
    expect(unusableWhy(view('b@x', q('b@x', { weekPct: 95, weekResetsAt: null }))))
      .toEqual({ key: 'errors.startFullNoReset', params: { email: 'b@x' } });
  });
  test('L13 hard week 68 % (> 67, < 69) → startAdmit, not pickable', () => {
    expect(unusableWhy(view('a@x', q('a@x', { weekPct: 68 })))).toEqual({ key: 'errors.startAdmit', params: { email: 'a@x', used: 68, admit: 67, cap: 70 } });
  });
  test('past the reset of the window that filled it → startPastReset', () => {
    expect(unusableWhy(view('b@x', q('b@x', { weekPct: 95, weekResetsAt: NOW - 30 })))).toEqual({ key: 'errors.startPastReset', params: { email: 'b@x', at: at(NOW - 30) } });
  });
  test('checkAccount: unknown email → account_unusable errors.noAccount; full → account_unusable with the reason; ok → no throw', () => {
    const vs = [view('a@x', q('a@x', { weekPct: 73 })), view('b@x', q('b@x'))];
    expect(caught(() => checkAccount(vs, 'z@x'))).toMatchObject({ code: 'account_unusable', key: 'errors.noAccount', params: { email: 'z@x' } });
    expect(caught(() => checkAccount(vs, 'a@x'))).toMatchObject({ code: 'account_unusable', key: 'errors.startFullWeekHard' });
    expect(() => checkAccount(vs, 'b@x')).not.toThrow();
  });
});

describe('SA9 earliest / no_account', () => {
  test('the account that reopens first: full (its window\'s reset), admit band (week reset), past reset (re-check); out / probe skipped', () => {
    const vs = [
      view('a@x', q('a@x', { weekPct: 68, weekResetsAt: NOW + 7200 })), // admit band → week reset
      view('b@x', q('b@x', { fivePct: 96, fiveResetsAt: NOW + 5000 })), // Max 5 hours
      view('c@x', q('c@x', { weekPct: 99, weekResetsAt: NOW + 100 }), { out: true }),
      view('d@x', q('d@x', { status: 'needs_probe', weekPct: 99, weekResetsAt: NOW + 50 })), // full too, reopens first: still skipped
    ];
    expect(earliest(vs)).toEqual({ email: 'b@x', at: (NOW + 5000) * 1000 });
    expect(earliest(vs.slice(0, 1))).toEqual({ email: 'a@x', at: (NOW + 7200) * 1000 });
  });
  test('nothing known → null; no_account error carries the earliest (text + ms) or the bare reason', () => {
    expect(earliest([view('c@x', null, { out: true })])).toBeNull();
    expect(noAccount([view('c@x', null, { out: true })])).toMatchObject({ code: 'no_account', key: 'errors.noAccountNone' });
    const b = view('b@x', q('b@x', { fivePct: 96 }));
    expect(noAccount([b])).toMatchObject({ code: 'no_account', key: 'errors.noAccountEarliest', params: { email: 'b@x', at: at(NOW + 3600), atMs: (NOW + 3600) * 1000 } });
  });
  test('fmtAt = HH:MM dd/mm (local time)', () => {
    const d = new Date(2026, 10, 18, 5, 9);
    expect(fmtAt(d.getTime())).toBe('05:09 18/11');
  });
});
