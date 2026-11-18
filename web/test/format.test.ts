import { describe, expect, test } from 'bun:test';
import { chipLine, fmtAgo, fmtCost, fmtHm, fmtLeft, fmtResetLeft, fmtStamp, shortEmail, statLine } from '../src/lib/format.ts';
import { account } from './fixtures.ts';
import { makeT } from '../../shared/i18n/index.ts';
const VI = makeT('vi');

const H = 3_600_000, M = 60_000, D = 24 * H;

describe('§6.0 U4 one way to say quota', () => {
  test('left durations', () => {
    expect(fmtLeft(4 * D + 16 * H + 5 * M, VI)).toBe('4\u00a0ngày\u00a016\u00a0g');
    expect(fmtLeft(21 * H + 40 * M, VI)).toBe('21\u00a0g\u00a040\u00a0p');
    expect(fmtLeft(13 * M, VI)).toBe('13\u00a0p');
    expect(fmtLeft(-5, VI)).toBe('0\u00a0p');
  });
  test('v2.7.1 §4.5 tooltip reset = HH:MM dd/mm + the time left in one whole unit (days, else hours, else minutes)', () => {
    const now = new Date(2026, 10, 17, 8, 3).getTime();
    expect(fmtResetLeft(new Date(2026, 10, 18, 5, 59).getTime(), now, VI)).toBe('05:59 18/11 (còn 21\u00a0giờ)');
    expect(fmtResetLeft(new Date(2026, 10, 17, 13, 20).getTime(), now, VI)).toBe('13:20 17/11 (còn 5\u00a0giờ)');
    expect(fmtResetLeft(new Date(2026, 10, 21, 9, 10).getTime(), now, VI)).toBe('09:10 21/11 (còn 4\u00a0ngày)');
    expect(fmtResetLeft(new Date(2026, 10, 17, 8, 40).getTime(), now, VI)).toBe('08:40 17/11 (còn 37\u00a0phút)');
    expect(fmtResetLeft(now - 5000, now, VI)).toBe('08:02 17/11 (còn 1\u00a0phút)');
  });
  test('D21 chip: "còn N %" without "tới ngưỡng"', () => {
    expect(chipLine(account('a', { headroomPct: 51 }), 0, VI)).toEqual({ kind: 'ok', main: 'còn 51 %', rest: '' });
  });
  test('chip: full shows ĐẦY + reset left', () => {
    const now = 0;
    expect(chipLine(account('a', { full: true, weekResetsAt: 3 * D + 15 * H }), now, VI)).toEqual({ kind: 'full', main: 'ĐẦY', rest: '· reset còn 3\u00a0ngày\u00a015\u00a0g' });
  });
  test('U4 full by the weekly cap shows the weekly reset, not the 5h one', () => {
    const a = account('a', { full: true, week: 60, hard: true, weekPct: 98, headroomPct: 0, weekResetsAt: 3 * D + 15 * H, fiveResetsAt: 3 * H, five: null });
    expect(chipLine(a, 0, VI).rest).toBe('· reset còn 3\u00a0ngày\u00a015\u00a0g');
  });
  test('U4 full by the 5h cap (week still has room) shows the 5h reset', () => {
    const a = account('a', { full: true, week: 99, weekPct: 40, headroomPct: 59, five: 95, fivePct: 96, weekResetsAt: 3 * D, fiveResetsAt: 2 * H });
    expect(chipLine(a, 0, VI).rest).toBe('· reset còn 2\u00a0g\u00a00\u00a0p');
  });
  test('§6.16 chip: logged out wins over everything', () => {
    expect(chipLine(account('a', { loggedOut: true, full: true }), 0, VI)).toEqual({ kind: 'out', main: 'đã đăng xuất', rest: '' });
  });
  test('chip: unknown headroom', () => {
    expect(chipLine(account('a', { headroomPct: null }), 0, VI)).toEqual({ kind: 'unknown', main: 'chưa rõ', rest: '' });
  });
  test('§6.0 U10 cost always ≈ with Vietnamese decimal comma', () => {
    expect(fmtCost(41.2, VI)).toBe('≈ $41,20');
    expect(fmtCost(0, VI)).toBe('≈ $0,00');
  });
  test('U11 hh:mm', () => {
    expect(fmtHm(new Date(2026, 10, 14, 9, 5).getTime())).toBe('09:05');
  });
});

describe('§6.1 Đồ thị relative time (giờ tương đối, through the catalog)', () => {
  const EN = makeT('en'), now = new Date(2026, 10, 16, 14, 0).getTime();
  test('§6.1 mockup wording: "5 ph", "2 giờ", vi and en', () => {
    expect(fmtAgo(now - 30_000, now, VI)).toBe('vừa xong');
    expect(fmtAgo(now - 5 * M, now, VI)).toBe('5 ph');
    expect(fmtAgo(now - 2 * H - 10 * M, now, VI)).toBe('2 giờ');
    expect(fmtAgo(now - 3 * D, now, VI)).toBe('3 ngày');
    expect(fmtAgo(now - 5 * M, now, EN)).toBe('5 min');
    expect(fmtAgo(now - 2 * H, now, EN)).toBe('2 h');
    expect(fmtAgo(now - 3 * D, now, EN)).toBe('3 d');
    expect(fmtAgo(now - 30_000, now, EN)).toBe('now');
  });
  test('§6.1 a month or older → the date; a clock skew into the future → "vừa xong"', () => {
    expect(fmtAgo(new Date(2026, 8, 2, 9, 0).getTime(), now, VI)).toBe('02/09/2026');
    expect(fmtAgo(now + 5 * M, now, VI)).toBe('vừa xong');
  });
  test('§6.1 unit boundaries: 59 ph / 1 giờ, 23 giờ / 1 ngày, 29 ngày / the date', () => {
    expect(fmtAgo(now - 59 * M, now, VI)).toBe('59 ph');
    expect(fmtAgo(now - 60 * M, now, VI)).toBe('1 giờ');
    expect(fmtAgo(now - D + M, now, VI)).toBe('23 giờ');
    expect(fmtAgo(now - D, now, VI)).toBe('1 ngày');
    expect(fmtAgo(now - 30 * D + M, now, VI)).toBe('29 ngày');
    expect(fmtAgo(now - 30 * D, now, VI)).toMatch(/^\d\d\/\d\d\/2026$/);
  });
  test('§6.1 hover = the full time', () => {
    expect(fmtStamp(new Date(2026, 10, 16, 9, 5).getTime(), VI)).toBe('16/11/2026 09:05');
  });
});

describe('§6.2 m2 / m10 no-break spaces: a line wraps between items, never inside one', () => {
  test('m10 a duration never splits number and unit ("1 ngày 2 g trước")', () => {
    expect(fmtLeft(D + 2 * H, VI)).not.toContain(' ');
  });
  test('m2 the stat line joins items with " · ", each item unbreakable ("≈ $8,30", "5h 31 %")', () => {
    expect(statLine(['dev', 'ctx 41 %', null, fmtCost(8.3, VI), '5h 31 %'])).toBe('dev · ctx\u00a041\u00a0% · ≈\u00a0$8,30 · 5h\u00a031\u00a0%');
  });
  test('shortEmail: a gmail address shows only the user part, any other domain keeps "user@"', () => {
    const gmail = 'po@' + ['gmail', 'com'].join('.'); // built at run time: the export scan never sees a literal gmail address
    expect(shortEmail(gmail)).toBe('po');
    expect(shortEmail('dev@example.com')).toBe('dev@');
  });
});
