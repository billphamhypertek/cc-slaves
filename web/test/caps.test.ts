import { describe, expect, test } from 'bun:test';
import { capsPreview, previewText } from '../src/lib/caps.ts';
import type { RoleRow } from '../src/lib/wizard.ts';
import { account, lane } from './fixtures.ts';
import { makeT } from '../../shared/i18n/index.ts';
const VI = makeT('vi');

const accounts = [
  account('a@x', { role: 'orchestrator', weekPct: 48 }),
  account('pm@x', { weekPct: 68, week: 99 }),
  account('b@example.com', { weekPct: 87, week: 99 }),
  account('c@x', { role: 'backup', weekPct: 10, week: 70, hard: true }),
];
const rows = (patch: Record<string, Partial<RoleRow>> = {}): RoleRow[] => accounts.map(a => ({
  email: a.email, role: a.role, week: a.week, five: a.five === null ? '' : String(a.five), hard: a.hard, maxLanes: a.role === 'orchestrator' ? 0 : 3, ...patch[a.email], // D26 default: orchestrator 0
}));
const lanes = [lane('D2', { account: 'pm@x', state: 'running' }), lane('D15', { account: 'b@example.com', state: 'running' })];

describe('§6.12 F12 caps preview "Lưu sẽ khiến D2 rời pm@ ngay"', () => {
  test('unchanged caps: no preview', () => expect(capsPreview(lanes, accounts, rows())).toEqual([]));
  test('soft cap lowered below usage: lane leaves, resumes on the primary with most room', () => {
    const p = capsPreview(lanes, accounts, rows({ 'pm@x': { week: 65 } }));
    expect(p).toEqual([{ lane: 'D2', state: 'running', from: 'pm@x', to: 'b@example.com', usedPct: 68, newWeek: 65, toLeft: 12, why: 'cap' }]);
    expect(previewText(p[0]!, VI)).toBe('Lưu sẽ khiến D2 rời pm@ ngay — pm@ đang 68 %, ngưỡng mới 65 %. D2 sẽ resume trên b@ (còn 12 %).');
  });
  test('soft cap equal to usage counts as full', () => {
    expect(capsPreview(lanes, accounts, rows({ 'pm@x': { week: 68 } }))).toHaveLength(1);
    expect(capsPreview(lanes, accounts, rows({ 'pm@x': { week: 69 } }))).toHaveLength(0);
  });
  test('hard cap leaves at cap − 1', () => {
    expect(capsPreview(lanes, accounts, rows({ 'pm@x': { week: 69, hard: true } }))).toHaveLength(1);
    expect(capsPreview(lanes, accounts, rows({ 'pm@x': { week: 70, hard: true } }))).toHaveLength(0);
  });
  test('turning the account into the orchestrator moves its lanes off', () => {
    const p = capsPreview(lanes, accounts, rows({ 'pm@x': { role: 'orchestrator', maxLanes: 0 }, 'a@x': { role: 'primary' } }));
    expect(p[0]).toMatchObject({ lane: 'D2', why: 'orchestrator' });
    expect(previewText(p[0]!, VI)).toContain('pm@ thành account Điều phối');
  });
  test('D26 turning the account into the orchestrator with max lanes > 0: its lanes stay (no preview)', () => {
    expect(capsPreview(lanes, accounts, rows({ 'pm@x': { role: 'orchestrator', maxLanes: 2 }, 'a@x': { role: 'primary' } }))).toEqual([]);
  });
  test('no usable target: lane waits for quota', () => {
    const p = capsPreview(lanes, accounts, rows({ 'pm@x': { week: 50 }, 'b@example.com': { week: 50 }, 'c@x': { week: 11, hard: true } }));
    expect(p.map(x => [x.lane, x.to])).toEqual([['D2', null], ['D15', null]]);
    expect(previewText(p[0]!, VI)).toContain('D2 sẽ chờ quota');
  });
  test('only moves caused by this edit: a lane already over the current cap is not previewed', () => {
    const over = [...accounts, account('full@x', { weekPct: 98, week: 60, hard: true })];
    const r = over.map(a => ({ email: a.email, role: a.role, week: a.week, five: '', hard: a.hard, maxLanes: 3 }));
    expect(capsPreview([lane('D9', { account: 'full@x' })], over, r)).toEqual([]);
  });
  test('§7.4 I2 running lane leaves "ngay"; idle / waiting_po lanes leave "ở lần nhắn kế"', () => {
    const r = rows({ 'pm@x': { week: 65 } });
    const text = (state: 'running' | 'idle' | 'waiting_po') => previewText(capsPreview([lane('D2', { account: 'pm@x', state })], accounts, r)[0]!, VI);
    expect(text('running')).toStartWith('Lưu sẽ khiến D2 rời pm@ ngay — ');
    expect(text('idle')).toBe('Lưu sẽ khiến D2 rời pm@ ở lần nhắn kế — pm@ đang 68 %, ngưỡng mới 65 %. D2 sẽ resume trên b@ (còn 12 %).');
    expect(text('waiting_po')).toStartWith('Lưu sẽ khiến D2 rời pm@ ở lần nhắn kế — ');
  });
  test('stopped and done lanes are ignored', () => {
    expect(capsPreview([lane('D2', { account: 'pm@x', state: 'stopped' })], accounts, rows({ 'pm@x': { week: 50 } }))).toEqual([]);
  });
  test('backup is picked only when no primary has room', () => {
    const p = capsPreview([lane('D2', { account: 'pm@x' })], accounts, rows({ 'pm@x': { week: 50 }, 'b@example.com': { week: 80 } }));
    expect(p[0]!.to).toBe('c@x');
  });
});
