// v2.7.1 dev frames of the account panel (mockup AC1–AC8, AC12): the DK5 deck with the mockup's five accounts (two Max, three
// Ultra), the panel states as the engine sends them (`fullWhy`, `admitBlock`, `pastReset`, `refresh`, `quotaError`, `Snapshot.quota`).
// AC4 / AC5 / AC12 = AC1 + a hover; AC9 = AC1 with ?remote=1; AC11 = the collapsed card. Times are relative to now.
import type { AccountView, Snapshot } from '../../shared/protocol.ts';

export const ACC_FRAMES = ['AC1', 'AC2', 'AC3', 'AC5', 'AC7', 'AC8'] as const;
export type AccFrame = (typeof ACC_FRAMES)[number];
export const isAccFrame = (f: string): f is AccFrame => (ACC_FRAMES as readonly string[]).includes(f);

const H = 3_600_000, M = 60_000;
const base = (now: number): Omit<AccountView, 'email'> => ({
  id: null, login: 'ok', plan: null, role: 'primary', week: 100, five: null, hard: false, terminal: false, loggedOut: false, lanes: 0,
  weekPct: 40, fivePct: null, weekResetsAt: now + 4 * 24 * H, fiveResetsAt: null, fetchedAt: now - 9 * M, fresh: true, status: 'ok',
  headroomPct: 60, full: false, sharedCfg: { ok: true, issues: [] },
  refresh: { state: 'idle', at: null }, nextCheckAt: now - 4 * M, quotaError: null, fullWhy: null, admitBlock: null, pastReset: null, fiveWindow: false,
});
const acc = (now: number, email: string, over: Partial<AccountView>): AccountView => ({ ...base(now), email, ...over });

/** AC1: ba@ full by week (hard 70, stops at 69), bo@example.org orchestrator (Max), pm@ / bo24990 / dev2609 Ultra. */
function five(now: number): AccountView[] {
  const weekBa = now + 21 * H + 56 * M;
  return [
    acc(now, 'bo@example.org', { role: 'orchestrator', fiveWindow: true, weekPct: 49, fivePct: 31, headroomPct: 51, fiveResetsAt: now + 3 * H, plan: 'Max 5x' }),
    acc(now, 'ba@example.net', { role: 'backup', terminal: true, fiveWindow: true, week: 70, hard: true, weekPct: 73, fivePct: 8, headroomPct: 0, full: true,
      weekResetsAt: weekBa, fiveResetsAt: now + 5 * H + 17 * M, plan: 'Max 5x',
      fullWhy: { window: 'week', by: 'cap', usedPct: 73, cap: 70, leaveAt: 69, hard: true, resetsAt: weekBa } }),
    acc(now, 'bo24990@example.com', { weekPct: 92, headroomPct: 8, weekResetsAt: now + 3 * 24 * H + 13 * H }),
    acc(now, 'pm@example.net', { week: 90, weekPct: 59, headroomPct: 31 }),
    acc(now, 'dev2609@example.com', { weekPct: 60, headroomPct: 40 }),
  ];
}

function sevenStates(now: number): AccountView[] {
  return [
    acc(now, 'acc19@example.net', { loggedOut: true, login: 'out', weekPct: null, headroomPct: null }),
    acc(now, 'acc21@example.net', { fiveWindow: true, fivePct: 70, weekPct: 56, headroomPct: 44, fetchedAt: now - 31 * M, nextCheckAt: now + 4 * M,
      quotaError: { key: 'errors.quotaTimeout', at: now - 2 * M } }),
    acc(now, 'acc22@example.net', { fetchedAt: null, weekPct: null, headroomPct: null, refresh: { state: 'fetching', at: null } }),
    acc(now, 'acc23@example.net', { status: 'needs_probe', weekPct: null, headroomPct: null }),
    acc(now, 'kt@example.net', { fiveWindow: true, week: 70, hard: true, weekPct: 68, fivePct: 20, headroomPct: 1, admitBlock: { usedPct: 68, admitMax: 67, cap: 70, leaveAt: 69 } }),
    acc(now, 'acc25@example.net', { fiveWindow: true, fivePct: 97, weekPct: 40, full: true, headroomPct: 0, pastReset: { window: 'five', at: now - 12 * M, recheckAt: now + 1 * M } }),
    acc(now, 'bo@example.org', { role: 'orchestrator', fiveWindow: true, weekPct: 49, fivePct: 31, headroomPct: 51, fiveResetsAt: now + 3 * H }),
  ];
}

export function accFrame(f: AccFrame, s: Snapshot): Snapshot {
  const now = Date.now();
  const accs = f === 'AC7' ? sevenStates(now) : five(now);
  // the DK5 lanes keep their slots: [0] orchestrator, [1] backup, [2] full, [3..] primary
  const old = s.accounts.map(a => a.email), slot = (e: string | null) => (e === null ? -1 : old.indexOf(e));
  const order = f === 'AC7' ? [6, 1, 4, 5, 6] : [0, 3, 2, 2, 3]; // mockup: ba@ (full) and dev2609 hold no lane
  for (const l of s.lanes) { const i = slot(l.account); if (i >= 0) l.account = accs[order[i] ?? 0]!.email; }
  for (const o of s.orchestrators) { o.account = accs[order[0]!]!.email; o.homeAccount = o.account; o.seq = 1; }
  for (const p of s.projects) p.orchestratorAccount = accs[order[0]!]!.email;
  if (f === 'AC2') {
    const queued = (inS: number): AccountView['refresh'] => ({ state: 'queued', at: now + inS * 1000 });
    accs[1]!.fetchedAt = now - 5_000;
    accs[2]!.refresh = { state: 'fetching', at: null };
    accs[0]!.refresh = queued(20); accs[3]!.refresh = queued(40); accs[4]!.refresh = queued(60);
    s.quota = { cooldownUntil: null, queueEndsAt: Math.ceil((now + 60_000) / M) * M };
  }
  if (f === 'AC3') {
    accs[2]!.refresh = { state: 'queued', at: now + 100_000 };
    s.quota = { cooldownUntil: now + 100_000, queueEndsAt: null };
  }
  if (f === 'AC5') { const b = accs[0]!; b.fivePct = 2; b.fiveResetsAt = now + 5 * H - 4 * M; b.fetchedAt = now - 3 * M; }
  if (f === 'AC8') accs[4] = acc(now, 'nv.longer.account.alt@example.com', { weekPct: 30, headroomPct: 70 });
  s.accounts = accs;
  return s;
}
