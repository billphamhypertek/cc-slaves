// Orchestrator account choice: home or a primary soft fallback (split from orchestrator/session.ts).
import { pick, shouldLeave } from '../../accounts/picker.ts';
import { isFresh, rejectedHeld } from '../../accounts/quota.ts';
import { resolveCaps } from '../../config.ts';
import type { QuotaRow } from '../../db.ts';
import type { SwitchBase } from '../../lane/switcher.ts';
import type { OrchestratorDeps } from './types.ts';

/** What the pick reads (v2.9 §5.9 the author session picks the same way, without an Orchestrator). */
export type PickDeps = Pick<OrchestratorDeps, 'accounts' | 'loggedOut' | 'quota' | 'caps'>;

export function orchBase(d: PickDeps, now: number): SwitchBase {
  const quotas: Record<string, QuotaRow | null> = {};
  for (const a of d.accounts()) quotas[a.email] = d.quota.get(a.email);
  // Lane counts and the machine max do not apply to the orchestrator.
  return { accounts: d.accounts(), quotas, caps: d.caps(), laneCounts: {}, machineLaneCount: 0,
    config: { maxLanes: Number.MAX_SAFE_INTEGER, maxLanesPerAccount: Number.MAX_SAFE_INTEGER }, now,
    loggedOut: [...(d.loggedOut?.() ?? [])] };
}

/**
 * Account to (re)start on: `home` when it has room (§7.5), else a primary soft fallback; null = none (waiting_quota).
 * `admit` (a new session, §4.5): a hard home above its admit line (the 67–69 % band of cap 70) is skipped like the picker
 * does; a running session (`admit` false) keeps riding to the leave point.
 */
export function orchAccount(d: PickDeps, homeEmail: string | null, exclude: string[], now: number, admit = false): string | null {
  const b = orchBase(d, now);
  const home = homeEmail === null ? null : d.accounts().find((a) => a.email === homeEmail) ?? null;
  // §6.16 a logged-out home is skipped outright: no spawn that can only end in an auth error
  if (home && !exclude.includes(home.email) && !b.loggedOut?.includes(home.email)) {
    const q = d.quota.get(home.email);
    const held = q !== null && rejectedHeld(q, b.now);
    const rc = resolveCaps(b.caps, home.email);
    const band = admit && rc.hard && isFresh(q, b.now) && (q?.weekPct ?? 0) > rc.weekAdmitMax;
    if (!held && !band && shouldLeave({ account: home, quota: q, caps: b.caps, now: b.now, otherFree: true }) === 'stay') return home.email;
  }
  const r = pick({ ...b, exclude: [...exclude, ...(homeEmail ? [homeEmail] : [])], kind: 'orchestrator-fallback' });
  return 'account' in r ? r.account.email : null;
}
