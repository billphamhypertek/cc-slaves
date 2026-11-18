import { describe, expect, test } from 'bun:test';
import type { SetupStatus } from '../../shared/protocol.ts';
import { canAdvance, capsPayload, defaultRoles, FIRST_STEP, laneCapsPayload, loggedInCount, orchLaneCap, roleErrors, soloAccount, STEP_KEYS, stepStates, withRole, wizardRoles, type RoleRow } from '../src/lib/wizard.ts';
import { account } from './fixtures.ts';
import { makeT } from '../../shared/i18n/index.ts';

const tv = makeT('vi');

const setup = (over: Partial<SetupStatus> = {}): SetupStatus => ({
  claude: { found: true, path: '/c', version: '2.1.325', ok: true },
  accounts: [{ email: 'a@x', loggedIn: true }, { email: 'b@x', loggedIn: false }],
  poEmail: null, done: false, git: { state: 'missing', version: null, detail: null, identity: { name: null, email: null }, gh: 'missing', ghUser: null, ghLogin: null }, ...over,
});
const row = (email: string, over: Partial<RoleRow> = {}): RoleRow => ({ email, role: 'primary', week: 99, five: '', hard: false, maxLanes: 3, ...over });
const noClaude = { claude: { found: false, path: null, version: null, ok: false } };

describe('v2.5 §6 F1 wizard: 5 steps, no CC Switch', () => {
  test('v2.5 §6 step order: Công cụ → Account → Bộ công cụ → Vai trò & ngưỡng → Xong', () => {
    expect(STEP_KEYS.map(k => tv(k))).toEqual(['Công cụ', 'Account', 'Bộ công cụ', 'Vai trò & ngưỡng', 'Xong']);
    expect(STEP_KEYS.map(k => makeT('en')(k))).toEqual(['Tools', 'Account', 'Toolkit', 'Roles & caps', 'Done']);
  });
  test('v2.5 §6 A3 step 3 (Bộ công cụ) never gates: canAdvance(3) is always true', () => {
    expect(canAdvance(3, setup({ accounts: [] }), [])).toBe(true);
    expect(canAdvance(3, setup(noClaude), [row('a@x'), row('b@x')])).toBe(true);
  });
  test('step 1 needs Claude Code ok', () => {
    expect(canAdvance(1, setup(noClaude), [])).toBe(false);
    expect(canAdvance(1, setup(), [])).toBe(true);
  });
  test('v2 §6 step 2 (Account) needs ≥ 1 logged-in account', () => {
    expect(loggedInCount(setup())).toBe(1);
    expect(canAdvance(2, setup({ accounts: [] }), [])).toBe(false);
    expect(canAdvance(2, setup({ accounts: [{ email: 'a@x', loggedIn: false }] }), [])).toBe(false);
    expect(canAdvance(2, setup(), [])).toBe(true);
  });
  test('step 4 (roles) needs exactly one orchestrator and valid caps; no PO email (v3)', () => {
    const two = [row('a@x', { role: 'orchestrator' }), row('b@x', { role: 'orchestrator' })];
    const none = [row('a@x'), row('b@x')];
    const one = [row('a@x', { role: 'orchestrator' }), row('b@x')];
    expect(roleErrors(tv, two)).toContain('Cần đúng một account Điều phối (đang có 2).');
    expect(roleErrors(tv, none)).toContain('Cần đúng một account Điều phối (đang có 0).');
    expect(canAdvance(4, setup(), two)).toBe(false);
    expect(canAdvance(4, setup(), none)).toBe(false);
    expect(canAdvance(4, setup(), one)).toBe(true);
    expect(canAdvance(4, setup(), [row('a@x', { role: 'orchestrator', week: 0 })])).toBe(false);
    expect(canAdvance(4, setup(), [row('a@x', { role: 'orchestrator', five: 'abc' })])).toBe(false);
    expect(canAdvance(4, setup(), [row('a@x', { role: 'orchestrator', five: '97' })])).toBe(true);
    expect(roleErrors(tv, one)).toEqual([]);
    expect(roleErrors(tv, one, 'not-an-email')).toEqual(['Email của PO chưa đúng.']); // Settings still passes one
  });
  test('v2 §4.3 the wizard always opens on step 1, even with Claude Code installed', () => {
    expect(FIRST_STEP).toBe(1);
  });
  test('stepper: passed steps ok, current now, a failing Claude Code no', () => {
    expect(stepStates(setup(noClaude), 1, [])).toEqual(['now', '', '', '', '']);
    expect(stepStates(setup(), 3, [])).toEqual(['ok', 'ok', 'now', '', '']);
    expect(stepStates(setup({ accounts: [] }), 3, [])).toEqual(['ok', 'no', 'now', '', '']);
    expect(stepStates(setup(noClaude), 2, [])).toEqual(['no', 'now', '', '', '']);
    expect(stepStates(setup(), 5, [row('a@x')])).toEqual(['ok', 'ok', 'ok', 'no', 'now']); // step 3 always ok; no Điều phối → roles no
  });
  test('v2 §6 step 3 defaults: first account Điều phối, others Chính 99 % mềm; v1 caps rows come back', () => {
    expect(wizardRoles(['a@x', 'b@x', 'c@x'], {}).map(x => [x.email, x.role, x.week, x.hard, x.maxLanes])).toEqual([
      ['a@x', 'orchestrator', 99, false, 0], ['b@x', 'primary', 99, false, 3], ['c@x', 'primary', 99, false, 3]]);
    const cfg = { caps: { 'b@x': { role: 'orchestrator', week: 80, hard: true } }, laneCaps: { 'b@x': 0 } };
    expect(wizardRoles(['a@x', 'b@x'], cfg).map(x => [x.email, x.role, x.week, x.hard])).toEqual([['a@x', 'primary', 99, false], ['b@x', 'orchestrator', 80, true]]);
  });
});

describe('§6.1 F1d defaults', () => {
  test('no caps file: first account is orchestrator, the rest Chính 99 soft', () => {
    const r = defaultRoles(['a@x', 'b@x', 'c@x'], []);
    expect(r.map(x => [x.role, x.week, x.hard])).toEqual([['orchestrator', 99, false], ['primary', 99, false], ['primary', 99, false]]);
  });
  test('known caps prefill the rows', () => {
    const r = defaultRoles(['a@x', 'b@x'], [account('a@x', { role: 'primary', week: 60, hard: true }), account('b@x', { role: 'orchestrator', five: 90 })]);
    expect(r[0]).toMatchObject({ role: 'primary', week: 60, hard: true });
    expect(r[1]).toMatchObject({ role: 'orchestrator', five: '90' });
  });
  test('known caps without an orchestrator: first row becomes orchestrator', () => {
    const r = defaultRoles(['a@x', 'b@x'], [account('a@x'), account('b@x')]);
    expect(r.filter(x => x.role === 'orchestrator').map(x => x.email)).toEqual(['a@x']);
  });
  test('caps payload parses 5h and omits blanks', () => {
    expect(capsPayload([row('a@x', { role: 'orchestrator', five: '97' }), row('b@x', { hard: true, week: 60 })])).toEqual({
      'a@x': { role: 'orchestrator', week: 99, five: 97, hard: false }, 'b@x': { role: 'primary', week: 60, hard: true },
    });
  });
});

describe('v2 §6 one account: it orchestrates and runs lanes (G4 UX I1)', () => {
  test('§6 a single account keeps its real lane cap (editable); D26 with more accounts the orchestrator keeps its own value', () => {
    expect(soloAccount([row('a@x', { role: 'orchestrator' })])).toBe(true);
    expect(laneCapsPayload([row('a@x', { role: 'orchestrator', maxLanes: 4 })])).toEqual({ 'a@x': 4 });
    expect(soloAccount([row('a@x', { role: 'orchestrator' }), row('b@x')])).toBe(false);
    expect(laneCapsPayload([row('a@x', { role: 'orchestrator', maxLanes: 4 }), row('b@x', { maxLanes: 2 })])).toEqual({ 'a@x': 4, 'b@x': 2 });
    expect(laneCapsPayload([row('a@x', { role: 'orchestrator', maxLanes: 0 }), row('b@x', { maxLanes: 2 })])).toEqual({ 'a@x': 0, 'b@x': 2 });
  });
  test('§6 single-account wizard rows: Điều phối with 3 lanes (not 0)', () => {
    expect(wizardRoles(['a@x'], {}).map(x => [x.role, x.maxLanes])).toEqual([['orchestrator', 3]]);
    expect(wizardRoles(['a@x'], { caps: { 'a@x': { role: 'orchestrator' } }, laneCaps: { 'a@x': 0 } }).map(x => x.maxLanes)).toEqual([3]);
  });
});

describe('D26 the orchestrator account may take lanes (PO 2026-11-15)', () => {
  test('D26 wizard: a new orchestrator row starts at 0; a stored value comes back', () => {
    expect(wizardRoles(['a@x', 'b@x'], {}).map(x => x.maxLanes)).toEqual([0, 3]);
    const cfg = { caps: { 'b@x': { role: 'orchestrator' } }, laneCaps: { 'b@x': 2 } };
    expect(wizardRoles(['a@x', 'b@x'], cfg).map(x => x.maxLanes)).toEqual([3, 2]);
  });
  test('D26 F1d defaultRoles: the orchestrator row starts at 0 when not alone', () => {
    expect(defaultRoles(['a@x', 'b@x'], []).map(x => x.maxLanes)).toEqual([0, 3]);
    expect(defaultRoles(['a@x'], []).map(x => x.maxLanes)).toEqual([3]);
  });
  test('D26 orchLaneCap: solo → real cap (a stored 0 is not one); else the stored value, default 0', () => {
    expect(orchLaneCap(undefined, false)).toBe(0);
    expect(orchLaneCap(2, false)).toBe(2);
    expect(orchLaneCap(0, true)).toBe(3);
    expect(orchLaneCap(undefined, true)).toBe(3);
  });
  test('D26 withRole: becoming Điều phối starts at 0 lanes; leaving it with 0 restores 3', () => {
    expect(withRole(row('a@x', { maxLanes: 3 }), 'orchestrator', false).maxLanes).toBe(0);
    expect(withRole(row('a@x', { maxLanes: 3 }), 'orchestrator', true).maxLanes).toBe(3);
    expect(withRole(row('a@x', { role: 'orchestrator', maxLanes: 0 }), 'primary', false).maxLanes).toBe(3);
    expect(withRole(row('a@x', { role: 'orchestrator', maxLanes: 2 }), 'backup', false).maxLanes).toBe(2);
    expect(withRole(row('a@x', { maxLanes: 5 }), 'backup', false)).toMatchObject({ role: 'backup', maxLanes: 5 });
  });
});
