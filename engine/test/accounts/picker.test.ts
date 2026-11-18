import { describe, expect, test } from 'bun:test';
import type { Account } from '../../src/accounts/registry.ts';
import { t } from '../../../shared/i18n/index.ts';
import { PICK_REASON_KEY, RESET_TIE_S, pick, shouldLeave, type PickInput } from '../../src/accounts/picker.ts';
import { DEFAULT_CONFIG, resolveCaps } from '../../src/config.ts';
import { PO_CAPS } from '../_fixtures/po-caps.ts';
import type { QuotaRow } from '../../src/db.ts';

const NOW = 1_800_000_000;
const DAY = 86_400;
const PM = 'pm@example.net';
const B24 = 'bo24990@example.com';
const DUNG = 'dev2609@example.com';
const BA = 'ba@example.net';
const HV = 'bo@example.org';

const acct = (email: string): Account => ({ email, id: null, configDir: `/c/${email}`, keychainService: 'svc', planTier: null, terminal: false });
const ALL = [acct(PM), acct(B24), acct(DUNG), acct(BA), acct(HV)];

const q = (account: string, weekPct: number | null, o: Partial<QuotaRow> = {}): QuotaRow => ({
  account, weekPct, fivePct: 10, weekResetsAt: NOW + 3 * DAY, fiveResetsAt: NOW + 3600, source: 'api',
  fetchedAt: NOW - 60, status: 'ok', ...o,
});

function input(quotas: QuotaRow[], o: Partial<PickInput> = {}): PickInput {
  return {
    accounts: ALL, quotas: Object.fromEntries(quotas.map((x) => [x.account, x])), caps: structuredClone(PO_CAPS),
    laneCounts: {}, machineLaneCount: 0, config: { ...DEFAULT_CONFIG }, now: NOW, exclude: [], kind: 'lane', ...o,
  };
}
const picked = (r: ReturnType<typeof pick>) => ('account' in r ? r.account.email : `none:${r.reason}`);
/** Every lane-eligible account full except the ones given. */
const full = () => [q(PM, 99), q(B24, 99), q(DUNG, 59), q(BA, 69), q(HV, 10)];
const without = (rows: QuotaRow[], ...emails: string[]) => rows.filter((r) => !emails.includes(r.account));

describe('pick — the 8 cc-lanes cases (§3.4)', () => {
  test('§3.4 (1) earliest weekly reset wins among primaries', () => {
    const r = pick(input([q(PM, 10, { weekResetsAt: NOW + 5 * DAY }), q(B24, 80, { weekResetsAt: NOW + DAY }), q(DUNG, 10, { weekResetsAt: NOW + 4 * DAY })]));
    expect(picked(r)).toBe(B24);
  });

  test('§3.4 (2) same reset → more headroom wins', () => {
    expect(picked(pick(input([q(PM, 70), q(B24, 30), q(DUNG, 50), q(BA, 1)])))).toBe(B24);
  });

  test('§3.4 (2) RESET_TIE_S: resets within 1 hour count as a tie → more headroom wins; 2 h apart → earlier reset wins', () => {
    expect(RESET_TIE_S).toBe(3600);
    const at = (pmReset: number) => pick(input([q(PM, 10, { weekResetsAt: NOW + DAY + pmReset }), q(B24, 98, { weekResetsAt: NOW + DAY })],
      { accounts: [acct(PM), acct(B24)] }));
    expect(picked(at(1))).toBe(PM);
    expect(picked(at(2 * 3600))).toBe(B24);
  });

  test('§3.4 (3) backup only when every primary is full', () => {
    const rows = [q(PM, 99), q(B24, 99.5), q(DUNG, 58), q(BA, 10, { weekResetsAt: NOW + 60 })];
    expect(picked(pick(input(rows)))).toBe(BA);
    expect(picked(pick(input([...without(rows, DUNG), q(DUNG, 40)])))).toBe(DUNG); // a primary frees → primary, even with a later reset
  });

  test('§3.4 (4) orchestrator never gets a lane, even when it is the only one with room', () => {
    const r = pick(input(full()));
    expect(r).toMatchObject({ none: true, reason: 'all_full' });
    expect(picked(pick(input(full(), { exclude: [] })))).not.toBe(HV);
  });

  test('§3.4 (5) hard: admit only at ≤ cap−3, leave at cap−1', () => {
    const only = (pct: number) => pick(input([q(PM, 99), q(B24, 99), q(DUNG, pct), q(BA, 69)]));
    expect(picked(only(57))).toBe(DUNG);
    expect(picked(only(57.5))).toBe('none:all_full');
    expect(shouldLeave({ account: acct(DUNG), quota: q(DUNG, 58.9), caps: PO_CAPS, now: NOW, otherFree: true })).toBe('stay');
    expect(shouldLeave({ account: acct(DUNG), quota: q(DUNG, 59), caps: PO_CAPS, now: NOW, otherFree: true })).toBe('switch');
  });

  test('§3.4 (6) soft: admitted up to just under the cap and rides to the plan limit when nothing else is free', () => {
    expect(picked(pick(input([...without(full(), PM), q(PM, 98.9)])))).toBe(PM);
    expect(picked(pick(input([...without(full(), PM), q(PM, 99)])))).toBe('none:all_full');
    expect(shouldLeave({ account: acct(PM), quota: q(PM, 99), caps: PO_CAPS, now: NOW, otherFree: true })).toBe('switch');
    expect(shouldLeave({ account: acct(PM), quota: q(PM, 99.7), caps: PO_CAPS, now: NOW, otherFree: false })).toBe('stay');
  });

  test('§3.4 (7) all full → hard waits, soft stays; soft at the plan limit waits', () => {
    const leave = (a: string, pct: number, o: Partial<QuotaRow> = {}) =>
      shouldLeave({ account: acct(a), quota: q(a, pct, o), caps: PO_CAPS, now: NOW, otherFree: false });
    expect(leave(DUNG, 59)).toBe('wait');
    expect(leave(BA, 69)).toBe('wait');
    expect(leave(PM, 99)).toBe('stay');
    expect(leave(PM, 100)).toBe('wait');
    expect(leave(PM, 50, { status: 'rejected' })).toBe('wait');
  });

  test('§3.4 (8) exclude skips an account (the one being left)', () => {
    const rows = [q(PM, 10), q(B24, 20), q(DUNG, 99), q(BA, 99)];
    expect(picked(pick(input(rows)))).toBe(PM);
    expect(picked(pick(input(rows, { exclude: [PM] })))).toBe(B24);
    expect(picked(pick(input(rows, { exclude: [PM, B24] })))).toBe('none:all_full');
  });
});

describe('pick — freshness (§3.4 I2)', () => {
  test('§3.4 I2 hard account with stale numbers is not pickable', () => {
    const rows = [...without(full(), DUNG), q(DUNG, 10, { fetchedAt: NOW - 601 })];
    const r = pick(input(rows));
    expect(r).toMatchObject({ none: true, reason: 'quota_unknown' });
    expect('skipped' in r && r.skipped.find((s) => s.email === DUNG)?.reason).toBe('quota_unknown');
  });

  test('§3.4 I2 hard account with no numbers or past resets_at is not pickable', () => {
    expect(picked(pick(input(without(full(), DUNG))))).toBe('none:quota_unknown');
    expect(picked(pick(input([...without(full(), DUNG), q(DUNG, 10, { weekResetsAt: NOW })]))))
      .toBe('none:quota_unknown');
  });

  test('§3.4 I2 hard account with fresh numbers is pickable', () => {
    expect(picked(pick(input([...without(full(), DUNG), q(DUNG, 10, { fetchedAt: NOW - 600 })])))).toBe(DUNG);
  });

  test('§3.4 I2 soft account with unknown numbers is still pickable (after accounts with known numbers)', () => {
    expect(picked(pick(input(without(full(), PM))))).toBe(PM);
    expect(picked(pick(input([...without(full(), PM, B24), q(B24, 90, { fetchedAt: NOW - 9999 })])))).toBe(PM);
    expect(picked(pick(input([...without(full(), PM, B24), q(B24, 90)])))).toBe(B24); // known beats unknown
  });

  test('§3.4 I2 needs_probe (401) hard account is not pickable', () => {
    expect(picked(pick(input([...without(full(), DUNG), q(DUNG, 10, { status: 'needs_probe' })])))).toBe('none:quota_unknown');
  });

  test('§3.4 I2 backup is not used while a hard primary is only unknown (not full) → quota_unknown, caller refreshes', () => {
    const r = pick(input([q(BA, 1)], { accounts: [acct(DUNG), acct(BA)] }));
    expect(r).toMatchObject({ none: true, reason: 'quota_unknown' });
    // once the primary is known to be full, the backup is fine (§3.4 "Dự phòng chỉ khi mọi Chính đầy")
    expect(picked(pick(input([q(DUNG, 59), q(BA, 1)], { accounts: [acct(DUNG), acct(BA)] })))).toBe(BA);
    // a usable primary alongside the unknown one still wins
    expect(picked(pick(input([q(PM, 10), q(BA, 1)], { accounts: [acct(PM), acct(DUNG), acct(BA)] })))).toBe(PM);
    // only an unknown PRIMARY blocks the backup; an unknown hard backup does not block another backup
    const caps = { ...structuredClone(PO_CAPS), 'bk2@x': { role: 'backup' as const, week: 90 } };
    expect(picked(pick(input([q(DUNG, 59), q('bk2@x', 5)], { accounts: [acct(DUNG), acct(BA), acct('bk2@x')], caps })))).toBe('bk2@x');
  });

  test('§3.3-9 rejected status (plan blocks) → not pickable even if soft', () => {
    expect(picked(pick(input([...without(full(), PM), q(PM, 10, { status: 'rejected' })])))).toBe('none:all_full');
  });
});

describe('pick — 5h is always soft (D6)', () => {
  test('D6 5h at its cap blocks a new lane on that account', () => {
    expect(picked(pick(input([...without(full(), PM), q(PM, 10, { fivePct: 95 })])))).toBe('none:all_full');
    expect(picked(pick(input([...without(full(), PM), q(PM, 10, { fivePct: 94.9 })])))).toBe(PM);
  });

  test('D6 hard account over its 5h cap with nothing else free stays (5h never waits)', () => {
    expect(shouldLeave({ account: acct(BA), quota: q(BA, 50, { fivePct: 96 }), caps: PO_CAPS, now: NOW, otherFree: false })).toBe('stay');
    expect(shouldLeave({ account: acct(BA), quota: q(BA, 50, { fivePct: 96 }), caps: PO_CAPS, now: NOW, otherFree: true })).toBe('switch');
  });

  test('D6 5h leave point is the cap itself, also on a hard account', () => {
    expect(resolveCaps(PO_CAPS, BA).fiveLeaveAt).toBe(95);
    expect(shouldLeave({ account: acct(BA), quota: q(BA, 50, { fivePct: 94.9 }), caps: PO_CAPS, now: NOW, otherFree: true })).toBe('stay');
  });

  test('D103 Ultra (no 5-hour window): a five number never blocks a lane nor moves a session; Max still does', () => {
    const ultra = { ...acct(PM), planTier: null }, max = { ...acct(PM), planTier: 'default_claude_max_5x' };
    const row = q(PM, 10, { fivePct: 100, fiveWindow: false });
    expect(picked(pick(input([...without(full(), PM), row])))).toBe(PM);
    expect(shouldLeave({ account: ultra, quota: row, caps: PO_CAPS, now: NOW, otherFree: true })).toBe('stay');
    expect(picked(pick(input([...without(full(), PM), row], { accounts: [max, ...ALL.slice(1)] })))).toBe('none:all_full');
    expect(shouldLeave({ account: max, quota: row, caps: PO_CAPS, now: NOW, otherFree: true })).toBe('switch');
  });
});

describe('pick — limits (§3.4, §7.4)', () => {
  test('§3.4 at most 3 lanes per account', () => {
    const rows = [q(PM, 10), q(B24, 50), q(DUNG, 99), q(BA, 99)];
    expect(picked(pick(input(rows, { laneCounts: { [PM]: 2 } })))).toBe(PM);
    expect(picked(pick(input(rows, { laneCounts: { [PM]: 3 } })))).toBe(B24);
    expect(picked(pick(input(rows, { laneCounts: { [PM]: 3, [B24]: 3 } })))).toBe('none:account_lanes_full');
  });

  test('§3.4 lanes per account limit is configurable', () => {
    const rows = [q(PM, 10), q(B24, 50), q(DUNG, 99), q(BA, 99)];
    expect(picked(pick(input(rows, { laneCounts: { [PM]: 1 }, config: { ...DEFAULT_CONFIG, maxLanesPerAccount: 1 } })))).toBe(B24);
  });

  test('§6.12 F12 per-account lane cap (laneCaps) overrides maxLanesPerAccount; 0 = no lanes', () => {
    const rows = [q(PM, 10), q(B24, 50), q(DUNG, 99), q(BA, 99)];
    expect(picked(pick(input(rows, { laneCounts: { [PM]: 1 }, config: { ...DEFAULT_CONFIG, laneCaps: { [PM]: 1 } } })))).toBe(B24);
    expect(picked(pick(input(rows, { config: { ...DEFAULT_CONFIG, laneCaps: { [PM]: 0 } } })))).toBe(B24);
    expect(picked(pick(input(rows, { laneCounts: { [PM]: 3 }, config: { ...DEFAULT_CONFIG, laneCaps: { [PM]: 5 } } })))).toBe(PM);
  });

  test('§6.8A F24 "Không giao lane mới" skips the account for new lanes only', () => {
    const rows = [q(PM, 10), q(B24, 50), q(DUNG, 99), q(BA, 99)];
    const r = pick(input(rows, { config: { ...DEFAULT_CONFIG, noNewLanes: { [PM]: true } } }));
    expect(picked(r)).toBe(B24);
    expect(picked(pick(input(rows, { config: { ...DEFAULT_CONFIG, noNewLanes: { [PM]: false } } })))).toBe(PM);
  });

  test('§7.4 machine-wide max 8 live lanes', () => {
    const rows = [q(PM, 10)];
    expect(picked(pick(input(rows, { machineLaneCount: 7 })))).toBe(PM);
    expect(picked(pick(input(rows, { machineLaneCount: 8 })))).toBe('none:machine_full');
    expect(picked(pick(input(rows, { machineLaneCount: 2, config: { ...DEFAULT_CONFIG, maxLanes: 2 } })))).toBe('none:machine_full');
  });


  test('§3.4 no accounts → none/no_accounts', () => {
    expect(picked(pick(input([], { accounts: [] })))).toBe('none:no_accounts');
  });

  test('§3.4 none carries the earliest reset to wait for', () => {
    const rows = [...without(full(), PM), q(PM, 99, { weekResetsAt: NOW + 500 })];
    const r = pick(input(rows));
    expect(r).toMatchObject({ none: true, reason: 'all_full' });
    expect('waitUntil' in r && r.waitUntil).toBe(NOW + 500);
  });

  test('every reason code has Vietnamese text', () => {
    for (const k of ['machine_full', 'no_accounts', 'all_full', 'account_lanes_full', 'quota_unknown'] as const) {
      expect(t('vi', PICK_REASON_KEY[k]).length).toBeGreaterThan(0);
    }
  });
});

describe('pick — orchestrator-fallback (§7.5)', () => {
  test('§7.5 only primary + soft accounts; never hard, backup or orchestrator', () => {
    const rows = [q(PM, 99), q(B24, 99), q(DUNG, 10), q(BA, 1), q(HV, 1)];
    expect(picked(pick(input(rows, { kind: 'orchestrator-fallback' })))).toBe('none:all_full');
    expect(picked(pick(input([...without(rows, PM), q(PM, 50)], { kind: 'orchestrator-fallback' })))).toBe(PM);
  });

  test('§7.5 orchestrator-fallback ignores lane limits (it is not a lane)', () => {
    const r = pick(input([q(PM, 50)], { kind: 'orchestrator-fallback', machineLaneCount: 8, laneCounts: { [PM]: 3 } }));
    expect(picked(r)).toBe(PM);
  });
});

describe('rejected mark holds past freshness (g2-t3 concern 2)', () => {
  const stale = NOW - 3600;
  test('MINOR-1 rejected, no reset known, marked < 30 min ago → not pickable even for a soft account', () => {
    const rows = [...without(full(), PM), q(PM, null, { status: 'rejected', fivePct: null, fiveResetsAt: null, weekResetsAt: null, fetchedAt: NOW - 29 * 60 })];
    expect(picked(pick(input(rows)))).toBe('none:all_full');
  });
  test('MINOR-1 rejected, no reset known, marked ≥ 30 min ago → released (unknown again) → a soft account is pickable', () => {
    const rows = [...without(full(), PM), q(PM, null, { status: 'rejected', fivePct: null, fiveResetsAt: null, weekResetsAt: null, fetchedAt: stale })];
    expect(picked(pick(input(rows)))).toBe(PM);
  });
  test('rejected, stale, known reset in the future → not pickable; waitUntil = that reset', () => {
    const rows = [...without(full(), PM), q(PM, 10, { status: 'rejected', fiveResetsAt: NOW + 900, weekResetsAt: NOW + DAY, fetchedAt: stale })];
    const r = pick(input(rows));
    expect(picked(r)).toBe('none:all_full');
    expect('waitUntil' in r && r.waitUntil).toBe(NOW + 900);
  });
  test('rejected with a reset that has passed → unknown again → a soft account is pickable', () => {
    const rows = [...without(full(), PM), q(PM, 10, { status: 'rejected', fiveResetsAt: NOW - 1, fetchedAt: stale })];
    expect(picked(pick(input(rows)))).toBe(PM);
  });
});

describe('pick — logged-out accounts are unusable (§6.16, §7.5, §7.7)', () => {
  test('§6.16 a logged-out account is never picked for a lane, even with the most headroom', () => {
    const r = pick(input([q(PM, 1), q(B24, 50), q(DUNG, 50), q(BA, 1)], { loggedOut: [PM] }));
    expect(picked(r)).toBe(B24);
  });

  test('§6.16 skipped list names logged_out; every account logged out → reason logged_out with a Vietnamese text', () => {
    const r = pick(input([q(PM, 1)], { accounts: [acct(PM)], loggedOut: [PM] }));
    expect(r).toMatchObject({ none: true, reason: 'logged_out', skipped: [{ email: PM, reason: 'logged_out' }] });
    expect(t('vi', PICK_REASON_KEY.logged_out)).toContain('đăng xuất');
  });

  test('§7.5 orchestrator fallback never lands on a logged-out primary soft account', () => {
    const rows = [q(PM, 1), q(B24, 50)];
    expect(picked(pick(input(rows, { kind: 'orchestrator-fallback' })))).toBe(PM);
    expect(picked(pick(input(rows, { kind: 'orchestrator-fallback', loggedOut: [PM] })))).toBe(B24);
    expect(picked(pick(input(rows, { kind: 'orchestrator-fallback', loggedOut: [PM, B24] })))).toBe('none:logged_out');
  });
});

describe('§6 single usable account (rev 2.1 N4)', () => {
  const O = HV; // PO_CAPS: orchestrator
  const caps = structuredClone(PO_CAPS);
  test('§6 the only usable account is the orchestrator → it takes lanes; its laneCaps 0 does not apply', () => {
    const r = pick(input([q(O, 10)], { accounts: [acct(O)], caps, config: { ...DEFAULT_CONFIG, laneCaps: { [O]: 0 } }, laneCounts: { [O]: 2 } }));
    expect(picked(r)).toBe(O);
  });
  test('§6 ≥ 2 usable accounts → the orchestrator takes no lane', () => {
    const r = pick(input([q(O, 10), q(PM, 99)], { accounts: [acct(O), acct(PM)], caps }));
    expect(picked(r)).toBe('none:all_full');
    expect(r).toMatchObject({ skipped: expect.arrayContaining([{ email: O, reason: 'role' }]) });
  });
  test('§6 the other account is logged out → the orchestrator is the only usable one and takes lanes', () => {
    const r = pick(input([q(O, 10), q(PM, 10)], { accounts: [acct(O), acct(PM)], caps, loggedOut: [PM] }));
    expect(picked(r)).toBe(O);
  });
  test('§6 `pool` (pickForStart pins one account) still counts every usable account', () => {
    const r = pick(input([q(O, 10)], { accounts: [acct(O)], pool: [acct(O), acct(PM)], caps }));
    expect(picked(r)).toBe('none:all_full');
  });
  test('§6 orchestrator fallback is unchanged: never the orchestrator account', () => {
    expect(picked(pick(input([q(O, 10)], { accounts: [acct(O)], caps, kind: 'orchestrator-fallback' })))).toBe('none:all_full');
  });
});

describe('D26 the orchestrator account takes lanes when its max lanes > 0 (PO 2026-11-15)', () => {
  const O = HV; // PO_CAPS: orchestrator
  const cfg = (cap: number | undefined) => ({ ...DEFAULT_CONFIG, laneCaps: (cap === undefined ? {} : { [O]: cap }) as Record<string, number> });
  test('D26 cap 0 → skipped `role`', () => {
    const r = pick(input(full(), { config: cfg(0) }));
    expect(picked(r)).toBe('none:all_full');
    expect(r).toMatchObject({ skipped: expect.arrayContaining([{ email: O, reason: 'role' }]) });
  });
  test('D26 cap unset → skipped `role`', () => {
    const r = pick(input(full(), { config: cfg(undefined) }));
    expect(r).toMatchObject({ none: true, skipped: expect.arrayContaining([{ email: O, reason: 'role' }]) });
  });
  test('D26 cap 2 → picked only when no primary admits', () => {
    expect(picked(pick(input(full(), { config: cfg(2) })))).toBe(O);
    // a primary admits → primary, even though the orchestrator has more headroom and an earlier reset
    const rows = [...without(full(), PM), q(PM, 90, { weekResetsAt: NOW + 6 * DAY })];
    expect(picked(pick(input([...without(rows, O), q(O, 1, { weekResetsAt: NOW + 60 })], { config: cfg(2) })))).toBe(PM);
  });
  test('D26 ranked like a backup: earlier weekly reset wins between backup and orchestrator', () => {
    const rows = [q(PM, 99), q(B24, 99), q(DUNG, 59), q(BA, 10, { weekResetsAt: NOW + DAY }), q(O, 10, { weekResetsAt: NOW + 2 * DAY })];
    expect(picked(pick(input(rows, { config: cfg(2) })))).toBe(BA);
    const later = [...without(rows, BA), q(BA, 10, { weekResetsAt: NOW + 3 * DAY })];
    expect(picked(pick(input(later, { config: cfg(2) })))).toBe(O);
  });
  test('D26 review M-4: an orchestrator with unknown quota still ranks with the backups (a fresh backup with an earlier reset wins)', () => {
    const rows = [q(PM, 99), q(B24, 99), q(DUNG, 59), q(BA, 10, { weekResetsAt: NOW + DAY }), q(O, 10, { fetchedAt: NOW - 10 * DAY })];
    expect(picked(pick(input(rows, { config: cfg(2) })))).toBe(BA);
  });
  test('D26 a primary only unknown → refresh, not the orchestrator', () => {
    const rows = [q(PM, 99), q(B24, 99), q(DUNG, 50, { fetchedAt: NOW - 10 * DAY }), q(BA, 69), q(O, 10)];
    expect(picked(pick(input(rows, { config: cfg(2) })))).toBe('none:quota_unknown');
  });
  test('D26 lane count reaches 2 → account_lanes_full', () => {
    const r = pick(input(full(), { config: cfg(2), laneCounts: { [O]: 2 } }));
    expect(picked(r)).toBe('none:account_lanes_full');
    expect(r).toMatchObject({ skipped: expect.arrayContaining([{ email: O, reason: 'account_lanes_full' }]) });
  });
  test('D26 sole-usable rule still works (cap 0 → maxLanesPerAccount)', () => {
    const r = pick(input([q(O, 10)], { accounts: [acct(O)], config: cfg(0), laneCounts: { [O]: 2 } }));
    expect(picked(r)).toBe(O);
  });
  test('D26 orchestrator-fallback unchanged: never the orchestrator account, whatever its cap', () => {
    expect(picked(pick(input([q(O, 10)], { accounts: [acct(O)], config: cfg(2), kind: 'orchestrator-fallback' })))).toBe('none:all_full');
  });
});
