// F8 switch menu, F24 account panel, F25 subagent list (spec §6.8, §6.8A, §6.8B), F2 project names (M13).
import type { Tr } from '../../../shared/i18n/core.ts';
import type { AccountView, LaneView, SubagentView } from '../../../shared/protocol.ts';
import { fmtResetTime, midnight, resetAt, shortEmail } from './format.ts';

export interface SwitchOption { email: string | null; label: string; pct: string; disabled: boolean; reason: string }

export function switchOptions(tr: Tr, lane: LaneView, accounts: AccountView[]): SwitchOption[] {
  const rs = (a: AccountView) => { const r = fmtResetTime(resetAt(a)); return r === null ? '' : tr('labels.sw.reset', { at: r }); };
  const left = (a: AccountView) => (a.headroomPct === null ? tr('labels.sw.unknown') : tr('labels.sw.left', { pct: Math.round(a.headroomPct) }));
  const no = (a: AccountView, reason: string, pct = '') => ({ email: a.email, label: shortEmail(a.email), pct, disabled: true, reason });
  // v2 §6: the orchestrator account takes lanes only when no Chính / Dự phòng is usable (one-account setup)
  const usable = (a: AccountView) => !a.loggedOut && a.login !== 'out' && !a.full && a.sharedCfg.ok;
  const orchOnly = !accounts.some(a => a.role !== 'orchestrator' && usable(a));
  const opt = (a: AccountView): SwitchOption => {
    if (a.email === lane.account) return no(a, tr('labels.sw.here'), left(a));
    if (a.loggedOut || a.login === 'out') return no(a, tr('labels.sw.loggedOut'));
    if (a.role === 'orchestrator' && !orchOnly) return no(a, tr('labels.sw.orchAccount'));
    if (a.full) return no(a, `${tr('labels.sw.full')}${rs(a)}`, tr('labels.sw.full'));
    if (!a.sharedCfg.ok) return no(a, tr('labels.sw.cfgBad'));
    const reason = a.role === 'backup'
      ? tr('labels.sw.backup', { left: left(a), cap: tr(a.hard ? 'labels.sw.hard' : 'labels.sw.soft'), week: a.week, reset: rs(a) })
      : tr('labels.sw.primary', { left: left(a), reset: rs(a), n: a.lanes });
    return { email: a.email, label: shortEmail(a.email), pct: left(a), disabled: false, reason };
  };
  const cur = accounts.filter(a => a.email === lane.account), rest = accounts.filter(a => a.email !== lane.account);
  return [{ email: null, label: tr('labels.sw.auto'), pct: '', disabled: false, reason: tr('labels.sw.autoWhy') }, ...cur.map(opt), ...rest.map(opt)];
}

export type AccountState = 'ok' | 'full' | 'out' | 'stale';
const STALE_MS = 10 * 60_000;
export function accountState(a: AccountView, now: number): AccountState {
  if (a.loggedOut) return 'out';
  if (a.full) return 'full';
  if (!a.fresh || a.fetchedAt === null || now - a.fetchedAt > STALE_MS) return 'stale';
  return 'ok';
}

const INACTIVE = new Set(['stopped', 'done']);
/** A lane that holds its account now (hf1116 A-M4: a paused lane of a held project does not, as the engine's OCCUPY). */
export const isActiveLane = (l: LaneView): boolean => !INACTIVE.has(l.state) && l.state !== 'paused';
export const lanesOn = (email: string, lanes: LaneView[]) => {
  const on = lanes.filter(l => l.account === email);
  return [...on.filter(isActiveLane), ...on.filter(l => !isActiveLane(l))];
};

/** v2.1 §4.11b Account "đã chạy hôm nay": stopped / done lanes of this account last touched since local midnight. */
export const ranToday = (email: string, lanes: LaneView[], now: number): LaneView[] =>
  lanes.filter(l => l.account === email && INACTIVE.has(l.state) && l.updatedAt >= midnight(now));

/** v2.1 §4.11b Account "Hôm nay" (§9.3 R8: no per-kind week row, no data for it): lanes on it touched today (running or finished) · its Điều phối sessions. */
export const todayLine = (tr: Tr, email: string, lanes: LaneView[], orchs: number, now: number): string =>
  tr('unit.todayLine', { lanes: lanes.filter(l => l.account === email && l.updatedAt >= midnight(now)).length, orchs });

/** F25: running ones + the 3 most recent finished, in stream order; `all` = "Xem tất cả". */
export function visibleSubs(subs: SubagentView[], all: boolean): SubagentView[] {
  if (all) return subs;
  const done = subs.filter(s => s.status !== 'running').slice(-3);
  return subs.filter(s => s.status === 'running' || done.includes(s));
}

/** M13: display name = folder name, never a duplicate. */
export function projectName(path: string, existing: string[]): string {
  const base = path.replace(/\/+$/, '').split('/').pop() || path;
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
