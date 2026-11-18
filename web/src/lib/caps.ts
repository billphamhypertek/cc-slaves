// F12 Account tab preview (spec §6.12, D11): which running lanes a caps edit would push off their account right now.
import type { Tr } from '../../../shared/i18n/core.ts';
import type { AccountView, LaneState, LaneView } from '../../../shared/protocol.ts';
import { shortEmail } from './format.ts';
import type { RoleRow } from './wizard.ts';

export interface CapsMove { lane: string; state: LaneState; from: string; to: string | null; usedPct: number | null; newWeek: number; toLeft: number | null; why: 'cap' | 'orchestrator' }

/** §3.4: hard cap → leave at cap − 1; soft → leave at cap. Unknown usage never counts as full. */
const fullAt = (used: number | null, week: number, hard: boolean) => used !== null && (hard ? used >= week - 1 : used >= week);
/** D26: an orchestrator row with max lanes > 0 keeps lanes (an AccountView has no max lanes → counts as 0). */
const orchNoLanes = (r: { role: string; maxLanes?: number }) => r.role === 'orchestrator' && !((r.maxLanes ?? 0) > 0);
const leaves = (a: AccountView, r: { role: string; week: number; hard: boolean; maxLanes?: number }) => orchNoLanes(r) || a.loggedOut || fullAt(a.weekPct, r.week, r.hard);
const ACTIVE_OUT = new Set(['stopped', 'done']);
/** §7.4: an idle / waiting lane hitting a cap moves before its next message, not at once (I2). */
const MOVES_ON_NEXT_MSG: ReadonlySet<LaneState> = new Set(['idle', 'waiting_po']);

export function capsPreview(lanes: LaneView[], accounts: AccountView[], rows: RoleRow[]): CapsMove[] {
  const rowOf = (e: string) => rows.find(r => r.email === e);
  const out: CapsMove[] = [];
  for (const l of lanes) {
    if (!l.account || ACTIVE_OUT.has(l.state)) continue;
    const a = accounts.find(x => x.email === l.account), r = rowOf(l.account);
    if (!a || !r) continue;
    if (!leaves(a, r) || leaves(a, a)) continue; // only moves caused by this edit
    const room = (x: AccountView) => { const rx = rowOf(x.email) ?? x; return x.weekPct === null ? null : rx.week - x.weekPct; };
    const cands = accounts.filter(x => x.email !== a.email && !leaves(x, rowOf(x.email) ?? x));
    const rank = (x: AccountView) => ((rowOf(x.email) ?? x).role === 'primary' ? 1000 : 0) + (room(x) ?? 0);
    const to = cands.sort((x, y) => rank(y) - rank(x))[0] ?? null;
    out.push({ lane: l.name, state: l.state, from: a.email, to: to?.email ?? null, usedPct: a.weekPct, newWeek: r.week, toLeft: to ? room(to) : null, why: orchNoLanes(r) ? 'orchestrator' : 'cap' });
  }
  return out;
}

/** §6.12 preview sentence (§6A `roles.prev.*`); the Settings box bolds the part before " — ". */
export function previewText(m: CapsMove, tr: Tr): string {
  const from = shortEmail(m.from), lane = m.lane;
  const why = m.why === 'orchestrator' ? tr('roles.prev.orch', { from }) : tr('roles.prev.cap', { from, used: m.usedPct ?? '?', week: m.newWeek });
  const next = !m.to ? tr('roles.prev.wait', { lane })
    : m.toLeft === null ? tr('roles.prev.to', { lane, to: shortEmail(m.to) }) : tr('roles.prev.toLeft', { lane, to: shortEmail(m.to), left: m.toLeft });
  const when = tr(MOVES_ON_NEXT_MSG.has(m.state) ? 'roles.prev.nextMsg' : 'roles.prev.now');
  return tr('roles.prev.main', { lane, from, when, why, next });
}
