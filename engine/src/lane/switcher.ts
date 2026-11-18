// Account-switch decisions for a running lane (§3.4 leave rule, §7.4) and for the orchestrator (§7.5). Pure: wraps
// picker.ts `pick` / `shouldLeave`; the reducer's `pick_account` effect resolves through `pickToEvent`.
import type { Account } from '../accounts/registry.ts';
import { pick, shouldLeave, type PickInput, type PickResult } from '../accounts/picker.ts';
import { isFresh } from '../accounts/quota.ts';
import type { QuotaRow } from '../db.ts';
import type { LaneEvent } from './reducer.ts';

/** Pick input without the per-call `exclude` / `kind`. Counts include the session being decided on. */
export type SwitchBase = Omit<PickInput, 'exclude' | 'kind'>;

type LaneSwitch =
  | { kind: 'switch'; to: Account }
  | { kind: 'stay' }
  | { kind: 'waiting_quota'; waitUntil: number | null };

/** Orchestrator adds `defer`: must leave, but only at the next turn boundary (§7.5). */
export type OrchestratorSwitch = LaneSwitch | { kind: 'defer' };

export function pickToEvent(r: PickResult): Extract<LaneEvent, { type: 'pick_result' }> {
  return { type: 'pick_result', to: 'account' in r ? r.account.email : null };
}

const quotaOf = (b: SwitchBase, email: string): QuotaRow | null => b.quotas[email] ?? null;

function decide(b: SwitchBase, current: Account, alt: PickResult): LaneSwitch {
  const leave = shouldLeave({ account: current, quota: quotaOf(b, current.email), caps: b.caps, now: b.now, otherFree: 'account' in alt });
  if (leave === 'stay') return { kind: 'stay' };
  if ('account' in alt) return { kind: 'switch', to: alt.account };
  return { kind: 'waiting_quota', waitUntil: 'waitUntil' in alt ? alt.waitUntil : null };
}

/** The plan itself refuses work (not just our cap): the only case that may cut an orchestrator turn short (§7.5). */
function planBlocked(q: QuotaRow | null): boolean {
  return q !== null && (q.status === 'rejected' || (q.weekPct ?? 0) >= 100 || (q.fivePct ?? 0) >= 100);
}

/**
 * §7.5: the orchestrator leaves `home` only for a primary soft account (picker kind `orchestrator-fallback`), only
 * between turns unless the plan blocks outright, and returns home at the first turn boundary after home has room.
 */
export function orchestratorSwitch(
  b: SwitchBase, o: { home: Account; current: Account; atTurnBoundary: boolean },
): OrchestratorSwitch {
  if (o.current.email !== o.home.email && o.atTurnBoundary) {
    const hq = quotaOf(b, o.home.email);
    const homeHasRoom = !b.loggedOut?.includes(o.home.email) && isFresh(hq, b.now) &&
      shouldLeave({ account: o.home, quota: hq, caps: b.caps, now: b.now, otherFree: true }) === 'stay';
    if (homeHasRoom) return { kind: 'switch', to: o.home };
  }
  const alt = pick({ ...b, exclude: [o.current.email], kind: 'orchestrator-fallback' });
  const d = decide(b, o.current, alt);
  if (d.kind === 'stay' || o.atTurnBoundary || planBlocked(quotaOf(b, o.current.email))) return d;
  return { kind: 'defer' };
}
