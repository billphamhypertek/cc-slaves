// Quota / time / cost wording — §6.0 U4 (quota wording), U10 (cost), U11 (data time), §6A (vi / en, `format.*` keys).
// `tr` is the last parameter; every caller passes it (no Vietnamese default since lane T9c).
import { fmtDate, fmtNum, type Tr } from '../../../shared/i18n/core.ts';
import type { AccountView } from '../../../shared/protocol.ts';

const pad = (n: number) => String(n).padStart(2, '0');
/** Local midnight of `t` ("hôm nay" starts here). */
export const midnight = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** m2 / m10 one item that never wraps inside: every space a no-break space. */
const nb = (s: string) => s.replace(/ /g, '\u00a0');

/** m10 a duration is one unbreakable item ("1 ngày 2 g trước" never splits "2" from "g"). */
export function fmtLeft(ms: number, tr: Tr): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return nb(tr('format.left.d', { d, h }));
  if (h) return nb(tr('format.left.h', { h, m: mm }));
  return nb(tr('format.left.m', { m: mm }));
}

/** m2 a stat line ("dev · ctx 41 % · ≈ $8,30 · 5h 31 %"): it wraps between items only. */
export const statLine = (items: readonly (string | null | false | undefined)[]) => items.filter((x): x is string => !!x).map(nb).join(' · ');

export const fmtHm = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** v2.1 §4.14 "15/11 15:20" (day / month in the UI language's order). */
export const fmtDayHm = (t: number, tr: Pick<Tr, 'lang'>) => `${fmtDate(tr.lang, t, { day: '2-digit', month: '2-digit' })} ${fmtHm(t)}`;
/** v2.7 R11 "16/11": day / month in every UI language (Tasks lists and history). */
export const fmtDayMonth = (t: number) => { const d = new Date(t); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
/** v2.7 R11 "14:02 16/11": VN time first, then day / month, in every UI language (Tasks: spec card, overview, IS17). */
export const fmtHmDay = (t: number) => `${fmtHm(t)} ${fmtDayMonth(t)}`;
/** U10: always "≈", the language's decimal mark, no thousands grouping ("≈ $1234,50" / "≈ $1234.50"). */
export const fmtCost = (usd: number, tr: Tr) => '≈ $' + fmtNum(tr.lang, usd, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

/** v2.1 §4.2 line 3 / §4.5: compact token count in the UI language ("412k", "4,1k", "1,1M"). */
export function fmtTok(n: number, tr: Pick<Tr, 'lang'>): string {
  if (n < 1000) return fmtNum(tr.lang, Math.round(n));
  if (n < 1e6) { const k = n / 1000; return fmtNum(tr.lang, k, { maximumFractionDigits: k < 10 ? 1 : 0, useGrouping: false }) + 'k'; }
  const m = n / 1e6;
  return fmtNum(tr.lang, m, { maximumFractionDigits: m < 100 ? 1 : 0, useGrouping: false }) + 'M';
}
/** v2.7.1 §4.5 / L8 the one reset formatter: "05:59 18/11" (local = VN time, never a weekday, never the hour alone, also
 *  today). Unknown reset → null, so the caller drops the item instead of printing a placeholder. */
export function fmtResetTime(at: number): string;
export function fmtResetTime(at: number | null): string | null;
export function fmtResetTime(at: number | null): string | null { return at === null ? null : fmtHmDay(at); }
/** v2.7.1 §4.5 tooltip form: "05:59 18/11 (còn 21 giờ)" — the time left in one whole unit (days, else hours, else minutes). */
export function fmtResetLeft(at: number, now: number, tr: Tr): string {
  const m = Math.max(1, Math.floor((at - now) / 60_000));
  const left = m >= 1440 ? tr('format.leftR.d', { n: Math.floor(m / 1440) }) : m >= 60 ? tr('format.leftR.h', { n: Math.floor(m / 60) }) : tr('format.leftR.m', { n: m });
  return tr('format.resetLeft', { at: fmtHmDay(at), left: nb(left) });
}

/** The reset that frees room: the 5h window only when it alone is full; otherwise the weekly one. */
export function resetAt(a: AccountView): number | null {
  const fiveFull = a.five !== null && a.fivePct !== null && a.fivePct >= a.five;
  const weekFull = (a.headroomPct !== null && a.headroomPct <= 0) || (a.weekPct !== null && a.weekPct >= a.week - (a.hard ? 1 : 0));
  return fiveFull && !weekFull ? (a.fiveResetsAt ?? a.weekResetsAt) : (a.weekResetsAt ?? a.fiveResetsAt);
}

export interface ChipLine { kind: 'ok' | 'full' | 'out' | 'unknown'; main: string; rest: string }

/** D21 "còn N %" / "N% left". The number is plain (not `fmtPct`): vi-VN Intl writes "51%", D21 wants "51 %". */
export const leftPct = (tr: Tr, pct: number) => tr('format.chip.left', { pct: Math.round(pct) });

export function chipLine(a: AccountView, now: number, tr: Tr): ChipLine {
  if (a.loggedOut) return { kind: 'out', main: tr('format.chip.out'), rest: '' };
  if (a.full) { const r = resetAt(a); return { kind: 'full', main: tr('format.chip.full'), rest: r === null ? '' : tr('format.chip.fullRest', { left: fmtLeft(r - now, tr) }) }; }
  if (a.headroomPct === null) return { kind: 'unknown', main: tr('format.chip.unknown'), rest: '' };
  return { kind: 'ok', main: leftPct(tr, a.headroomPct), rest: '' };
}

export const shortEmail = (e: string) => {
  const [u, d] = e.split('@');
  return d && /gmail\.com$/.test(d) ? u! : `${u}@`;
};

/** v2.2 §14.5 a tool's run time: "6,2 s" under a minute, then the minute form of `fmtLeft`. */
export const fmtSecs = (ms: number, tr: Tr) =>
  (ms < 60_000 ? tr('format.secs', { n: fmtNum(tr.lang, ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : fmtLeft(ms, tr));
/** v2.2 §14.5 S4 / S7 (F-M9) a running clock in whole seconds: "8 s", past a minute like `fmtLeft`. */
export const fmtElapsed = (ms: number, tr: Tr) => (ms < 60_000 ? tr('format.secs', { n: Math.floor(Math.max(0, ms) / 1000) }) : fmtLeft(ms, tr));
/** v2.2 §6 K3 the login countdown "9:42" (m:ss, never negative). */
export const fmtClock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
/** v2.3 §6.1 Đồ thị the commit age: "vừa xong" · "5 ph" · "2 giờ" · "3 ngày"; a month or older → the date (dd/mm/yyyy). */
export function fmtAgo(t: number, now: number, tr: Tr): string {
  const m = Math.floor(Math.max(0, now - t) / 60_000);
  if (m < 1) return tr('format.ago.now');
  if (m < 60) return tr('format.ago.m', { n: m });
  if (m < 1440) return tr('format.ago.h', { n: Math.floor(m / 60) });
  if (m < 30 * 1440) return tr('format.ago.d', { n: Math.floor(m / 1440) });
  return fmtDate(tr.lang, t, { day: '2-digit', month: '2-digit', year: 'numeric' });
}
/** v2.3 §6.1 the hover of a commit: the full time "16/11/2026 09:05". */
export const fmtStamp = (t: number, tr: Pick<Tr, 'lang'>) => `${fmtDate(tr.lang, t, { day: '2-digit', month: '2-digit', year: 'numeric' })} ${fmtHm(t)}`;
/** v2.3 §5.2 a file size: "820 B", "2,1 KB", "182 KB", "3,4 MB" (one decimal under 10). */
export function fmtBytes(n: number, tr: Pick<Tr, 'lang'>): string {
  const [unit, div] = n < 1024 ? ['B', 1] as const : n < 1024 ** 2 ? ['KB', 1024] as const : ['MB', 1024 ** 2] as const;
  const v = n / div;
  return `${fmtNum(tr.lang, v, { maximumFractionDigits: div > 1 && v < 10 ? 1 : 0 })} ${unit}`;
}
