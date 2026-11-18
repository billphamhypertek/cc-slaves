import { describe, expect, test } from 'bun:test';
import type { Account } from '../../src/accounts/registry.ts';
import { pick } from '../../src/accounts/picker.ts';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import { PO_CAPS } from '../_fixtures/po-caps.ts';
import type { QuotaRow } from '../../src/db.ts';
import { orchestratorSwitch, pickToEvent, type SwitchBase } from '../../src/lane/switcher.ts';

const NOW = 1_800_000_000;
const DAY = 86_400;
const PM = 'pm@example.net'; // primary soft 99
const B24 = 'bo24990@example.com'; // primary soft 99
const DUNG = 'dev2609@example.com'; // primary hard 60
const BA = 'ba@example.net'; // backup hard 70
const HV = 'bo@example.org'; // orchestrator soft 99 / 5h 97

const acct = (email: string): Account => ({
  email, id: null, configDir: `/c/${email}`, keychainService: 'svc', planTier: null, terminal: false,
});
const A = Object.fromEntries([PM, B24, DUNG, BA, HV].map((e) => [e, acct(e)])) as Record<string, Account>;

const q = (account: string, weekPct: number | null, o: Partial<QuotaRow> = {}): QuotaRow => ({
  account, weekPct, fivePct: 10, weekResetsAt: NOW + 3 * DAY, fiveResetsAt: NOW + 3600, source: 'api',
  fetchedAt: NOW - 60, status: 'ok', ...o,
});

function b(rows: QuotaRow[], o: Partial<SwitchBase> = {}): SwitchBase {
  return {
    accounts: Object.values(A), quotas: Object.fromEntries(rows.map((r) => [r.account, r])),
    caps: structuredClone(PO_CAPS), laneCounts: { [PM]: 1 }, machineLaneCount: 1, config: { ...DEFAULT_CONFIG },
    now: NOW, ...o,
  };
}
const kind = (r: { kind: string; to?: Account }) => (r.kind === 'switch' ? `switch:${r.to!.email}` : r.kind);

describe('lane pick result (§7.4)', () => {
  test('§7.4 pickToEvent maps a pick result onto the reducer event', () => {
    const base = b([q(PM, 99), q(B24, 10)]);
    expect(pickToEvent(pick({ ...base, exclude: [PM], kind: 'lane' }))).toEqual({ type: 'pick_result', to: B24 });
    expect(pickToEvent(pick({ ...base, exclude: [PM, B24, DUNG, BA], kind: 'lane' }))).toEqual({ type: 'pick_result', to: null });
  });
});

describe('orchestrator switch (§7.5)', () => {
  const home = A[HV]!;

  test('§7.5 home over cap, at a turn boundary → only a primary soft account (never hard or backup)', () => {
    const rows = [q(HV, 99), q(PM, 99), q(B24, 99), q(DUNG, 1), q(BA, 1)];
    expect(kind(orchestratorSwitch(b(rows), { home, current: home, atTurnBoundary: true }))).toBe('stay');
    const ok = [q(HV, 99), q(PM, 99), q(B24, 30), q(DUNG, 1), q(BA, 1)];
    expect(kind(orchestratorSwitch(b(ok), { home, current: home, atTurnBoundary: true }))).toBe(`switch:${B24}`);
  });

  test('§7.5 mid-turn → defer to the turn boundary, unless the plan blocks outright', () => {
    const rows = [q(HV, 99), q(B24, 30)];
    expect(kind(orchestratorSwitch(b(rows), { home, current: home, atTurnBoundary: false }))).toBe('defer');
    const blocked = [q(HV, 100, { status: 'rejected' }), q(B24, 30)];
    expect(kind(orchestratorSwitch(b(blocked), { home, current: home, atTurnBoundary: false }))).toBe(`switch:${B24}`);
  });

  test('§7.5 plan blocks and no account left → waiting_quota (F6)', () => {
    const rows = [q(HV, 100, { status: 'rejected' }), q(PM, 99), q(B24, 99)];
    expect(kind(orchestratorSwitch(b(rows), { home, current: home, atTurnBoundary: true }))).toBe('waiting_quota');
  });

  test('§7.5 on a fallback: return home at the first turn boundary after it frees', () => {
    const rows = [q(HV, 40), q(B24, 30)];
    expect(kind(orchestratorSwitch(b(rows), { home, current: A[B24]!, atTurnBoundary: true }))).toBe(`switch:${HV}`);
    expect(kind(orchestratorSwitch(b(rows), { home, current: A[B24]!, atTurnBoundary: false }))).toBe('stay');
  });

  test('§7.5 on a fallback: home still full or its numbers stale → stay', () => {
    expect(kind(orchestratorSwitch(b([q(HV, 99), q(B24, 30)]), { home, current: A[B24]!, atTurnBoundary: true }))).toBe('stay');
    const stale = [q(HV, 10, { fetchedAt: NOW - 3600 }), q(B24, 30)];
    expect(kind(orchestratorSwitch(b(stale), { home, current: A[B24]!, atTurnBoundary: true }))).toBe('stay');
  });

  test('§7.5 fallback itself over cap → next primary soft at the boundary', () => {
    const rows = [q(HV, 99), q(B24, 99), q(PM, 20)];
    expect(kind(orchestratorSwitch(b(rows), { home, current: A[B24]!, atTurnBoundary: true }))).toBe(`switch:${PM}`);
  });

  test('§7.5 a logged-out home has no room: the orchestrator does not return to it', () => {
    const rows = [q(HV, 10), q(PM, 30), q(B24, 30)];
    expect(kind(orchestratorSwitch(b(rows), { home, current: A[B24]!, atTurnBoundary: true }))).toBe(`switch:${HV}`);
    expect(kind(orchestratorSwitch(b(rows, { loggedOut: [HV] }), { home, current: A[B24]!, atTurnBoundary: true }))).toBe('stay');
  });
});
