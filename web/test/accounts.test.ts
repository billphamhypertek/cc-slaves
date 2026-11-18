import { describe, expect, test } from 'bun:test';
import type { SubagentView } from '../../shared/protocol.ts';
import { accountState, isActiveLane, lanesOn, projectName, ranToday, switchOptions, todayLine, visibleSubs } from '../src/lib/accounts.ts';
import { account, lane } from './fixtures.ts';
import { makeT } from '../../shared/i18n/index.ts';
const VI = makeT('vi');

const now = 10_000_000;
describe('§6.8 F8 switch account menu', () => {
  const accs = [account('a@x', { role: 'orchestrator' }), account('pm@x'), account('full@x', { full: true, headroomPct: 0 }),
    account('out@x', { loggedOut: true }), account('bk@x', { role: 'backup', headroomPct: 20, week: 70, hard: true })];
  test('auto first, current disabled, invalid accounts dimmed with a reason', () => {
    const o = switchOptions(VI, lane('D2', { account: 'pm@x' }), accs);
    expect(o.map(x => [x.email, x.disabled])).toEqual([[null, false], ['pm@x', true], ['a@x', true], ['full@x', true], ['out@x', true], ['bk@x', false]]);
    expect(o.find(x => x.email === 'a@x')!.reason).toBe('Account Điều phối — không nhận lane');
    expect(o.find(x => x.email === 'out@x')!.reason).toBe('đã đăng xuất');
    expect(o.find(x => x.email === 'full@x')!.reason).toStartWith('ĐẦY');
    expect(o.find(x => x.email === 'pm@x')!.reason).toBe('đang chạy ở đây');
    expect(o.find(x => x.email === 'bk@x')!.reason).toStartWith('Dự phòng · còn 20 % (cứng 70)');
  });
});

describe('v2 §6 one account: the orchestrator takes lanes when no Chính / Dự phòng is usable', () => {
  test('v2 §6 orchestrator enabled when it is the only usable account', () => {
    const o = switchOptions(VI, lane('D2', { account: null }), [account('a@x', { role: 'orchestrator' })]);
    expect(o.find(x => x.email === 'a@x')!.disabled).toBe(false);
  });
  test('v2 §6 orchestrator enabled when every other account is out / full / shared-config flagged', () => {
    const accs = [account('a@x', { role: 'orchestrator' }), account('out@x', { loggedOut: true }), account('full@x', { full: true }),
      account('cfg@x', { sharedCfg: { ok: false, issues: [{ kind: 'real-entry', name: 'plans', path: '/p' }] } })];
    const o = switchOptions(VI, lane('D2', { account: null }), accs);
    expect(o.find(x => x.email === 'a@x')!.disabled).toBe(false);
    expect(o.find(x => x.email === 'cfg@x')).toMatchObject({ disabled: true, reason: 'cấu hình chung lỗi' });
  });
  test('v2 §6 with a usable Chính the orchestrator stays off', () => {
    const o = switchOptions(VI, lane('D2', { account: null }), [account('a@x', { role: 'orchestrator' }), account('pm@x')]);
    expect(o.find(x => x.email === 'a@x')!.disabled).toBe(true);
  });
});

describe('§6.8A F24 account state', () => {
  test('logged out > full > stale (> 10 min or not fresh) > ok', () => {
    expect(accountState(account('a', { loggedOut: true, full: true }), now)).toBe('out');
    expect(accountState(account('a', { full: true }), now)).toBe('full');
    expect(accountState(account('a', { fetchedAt: now - 11 * 60_000 }), now)).toBe('stale');
    expect(accountState(account('a', { fresh: false, fetchedAt: now }), now)).toBe('stale');
    expect(accountState(account('a', { fetchedAt: now - 9 * 60_000 }), now)).toBe('ok');
  });
  test('lanes on the account, all projects, active first', () => {
    const ls = [lane('D2', { account: 'pm@x', state: 'stopped' }), lane('D7', { account: 'pm@x', projectId: 'p2' }), lane('D15', { account: 'b@x' })];
    expect(lanesOn('pm@x', ls).map(l => l.name)).toEqual(['D7', 'D2']);
  });
  test('hf1116 A-M4 a paused lane (held project) is not active on the account: listed after the active ones', () => {
    const ls = [lane('P1', { account: 'pm@x', state: 'paused' }), lane('D7', { account: 'pm@x' })];
    expect(lanesOn('pm@x', ls).map(l => l.name)).toEqual(['D7', 'P1']);
    expect(ls.filter(isActiveLane).map(l => l.name)).toEqual(['D7']);
  });
});

describe('§6.8B F25 subagent list', () => {
  const sub = (id: string, status: SubagentView['status']): SubagentView => ({ taskId: id, toolUseId: 'tu' + id, description: id, subagentType: 'x', background: false, status, totalTokens: null, toolUses: null, lastTool: null });
  test('default: running + 3 most recent finished; all on demand', () => {
    const s = [sub('1', 'completed'), sub('2', 'completed'), sub('3', 'running'), sub('4', 'failed'), sub('5', 'completed'), sub('6', 'completed')];
    expect(visibleSubs(s, false).map(x => x.taskId)).toEqual(['3', '4', '5', '6']);
    expect(visibleSubs(s, true)).toHaveLength(6);
  });
});

describe('§6.2 M13 project display name', () => {
  test('basename, made unique', () => {
    expect(projectName('/Users/b/Works/hagenta/', [])).toBe('hagenta');
    expect(projectName('/x/hagenta', ['hagenta'])).toBe('hagenta 2');
    expect(projectName('/x/hagenta', ['hagenta', 'hagenta 2'])).toBe('hagenta 3');
  });
});

describe('§4.11b Account: "Hôm nay" and "đã chạy hôm nay"', () => {
  const VI = makeT('vi');
  const now = new Date(2026, 10, 16, 14, 0).getTime(), today = new Date(2026, 10, 16, 0, 30).getTime(), yesterday = new Date(2026, 10, 15, 23, 50).getTime();
  const ls = [lane('R1', { account: 'a@x', updatedAt: now }), lane('D1', { account: 'a@x', state: 'done', updatedAt: today }),
    lane('S1', { account: 'a@x', state: 'stopped', updatedAt: yesterday }), lane('D9', { account: 'b@x', state: 'done', updatedAt: today })];
  test('§4.11b "đã chạy hôm nay" = stopped / done lanes of this account with updatedAt ≥ local midnight', () => {
    expect(ranToday('a@x', ls, now).map(l => l.name)).toEqual(['D1']);
  });
  test('§4.11b "Hôm nay": lanes active today + Điều phối on this account', () => {
    expect(todayLine(VI, 'a@x', ls, 1, now)).toBe('2 lane · 1 Điều phối');
    expect(todayLine(VI, 'c@x', ls, 0, now)).toBe('0 lane · 0 Điều phối');
  });
});
