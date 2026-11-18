// Test scenes for the v1.1 grid deck (§6): the mockup's 10 lanes (BASE) and 24 lanes (BASE + EXTRA), 5 / 30 / 300 accounts.
import type { AccountView, LaneState, Phase, Snapshot } from '../../../shared/protocol.ts';
import { account, card, lane, snapshot } from '../fixtures.ts';

const PH: Phase[] = ['queue', 'spec', 'code', 'review', 'gate', 'merge'];
type Row = [name: string, zone: number, state: LaneState, acc: number];
/** mockup BASE: zone, state, account slot (0 = orchestrator, 1 = backup, 2 = full, 3.. = primary) */
export const BASE: Row[] = [
  ['S7', 0, 'starting', 3], ['X9', 0, 'stopped', 4], ['B2', 1, 'running', 1], ['C1', 1, 'waiting_quota', 2], ['D2', 2, 'running', 3],
  ['D15', 3, 'waiting_po', 4], ['R5', 3, 'broken', 1], ['K3', 4, 'draining', 3], ['I2', 4, 'idle', 4], ['E4', 5, 'done', 1],
];
export const EXTRA: Row[] = [
  ['Q4', 0, 'idle', 3], ['B7', 1, 'running', 4], ['D3', 2, 'running', 1], ['D4', 2, 'running', 3], ['D6', 2, 'running', 4], ['D8', 2, 'running', 1],
  ['D9', 2, 'idle', 3], ['D11', 2, 'running', 4], ['V1', 3, 'running', 1], ['V3', 3, 'running', 3], ['V4', 3, 'running', 4], ['G2', 4, 'running', 1],
  ['E1', 5, 'done', 3], ['E2', 5, 'done', 4],
];

const WEEK_RESET = new Date(2026, 10, 18, 8, 0).getTime(); // a Wednesday 08:00

/** n accounts: [0] orchestrator 51 %, [1] backup 33 %, [2..] 3–4 full, then 2–9 low (< 10 %), the rest 14–97 %. */
export function accounts(n: number): AccountView[] {
  const nFull = n > 40 ? 4 : n > 8 ? 3 : 1, nLow = n > 40 ? 9 : n > 8 ? 2 : 0, out: AccountView[] = [];
  for (let i = 0; i < n; i++) {
    const email = i === 0 ? 'bo@example.com' : `acc${String(i).padStart(3, '0')}@x-dev.test`;
    const role = i === 0 ? 'orchestrator' : i === 1 ? 'backup' : 'primary';
    const full = i >= 2 && i < 2 + nFull, low = !full && i >= 2 + nFull && i < 2 + nFull + nLow;
    const rem = i === 0 ? 51 : i === 1 ? 33 : full ? 0 : low ? 2 + (i % 7) : 14 + ((i * 37) % 84);
    out.push(account(email, { role, full, headroomPct: full ? 0 : rem, weekResetsAt: full ? WEEK_RESET + (i - 2) * 3_600_000 : null }));
  }
  return out;
}

export function scene(nAcc: number, rows: Row[] = BASE, over: Partial<Snapshot> = {}): Snapshot {
  const accs = accounts(nAcc), pick = (k: number) => accs[Math.min(k, accs.length - 1)]!.email;
  const lanes = rows.map(([name, z, state, a], i) => lane(name, {
    phase: z === 5 && state === 'done' ? 'done' : PH[z]!, state, account: pick(a), task: `việc ${name}`, turnStartedAt: state === 'running' ? 1000 + i : null,
  }));
  return snapshot({
    lanes, accounts: accs, cards: [card(7, { source: 'D15', question: 'giữ API cũ?' })],
    projects: [{ id: 'p1', name: 'hagenta', path: '/w/hagenta', orchestratorAccount: accs[0]!.email, gchatWebhookSet: false, gchatSendCommandText: false }],
    orchestrators: [{ projectId: 'p1', state: 'running', account: accs[0]!.email, homeAccount: accs[0]!.email, lastError: null, costUsd: 0, contextPct: 41, talkingTo: null }],
    ...over,
  });
}

/** n lanes, `perZone` in each zone (zone by index), all running on account 3. */
export function crowd(n: number, perZone: number): Row[] {
  return Array.from({ length: n }, (_, i) => [`L${i + 1}`, Math.min(5, Math.floor(i / perZone)), 'running', 3] as Row);
}
/** Tuesday 2026-11-17 10:00 — the day before WEEK_RESET. */
export const NOW = new Date(2026, 10, 17, 10, 0).getTime();
