import { describe, expect, test } from 'bun:test';
import { blockingCard, groupLanes } from '../src/lib/list.ts';
import { card, lane } from './fixtures.ts';
import { makeT } from '../../shared/i18n/index.ts';
const VI = makeT('vi');

describe('§6.9 F9 lane groups (R1 order)', () => {
  test('six groups in R1 order with the right states (hot fix 2026-11-16 "Tạm dừng" before the finished group)', () => {
    const ls = [lane('A', { state: 'idle' }), lane('B', { state: 'broken' }), lane('C', { state: 'running' }), lane('D', { state: 'waiting_quota' }),
      lane('E', { state: 'done' }), lane('F', { state: 'waiting_po' }), lane('G', { state: 'draining' }), lane('H', { state: 'stopped' }),
      lane('I', { state: 'starting' }), lane('J', { state: 'switching' }), lane('K', { state: 'paused' })];
    expect(groupLanes(VI, ls).map(g => [g.label, g.lanes.map(l => l.name)])).toEqual([
      ['Chờ PO', ['B', 'F']], ['Đang làm', ['C', 'G', 'I', 'J']], ['Chờ quota', ['D']], ['Rảnh', ['A']], ['Tạm dừng', ['K']], ['Đã xong & đã dừng', ['E', 'H']],
    ]);
  });
  test('empty groups stay (shown as "Không có lane nào")', () => {
    expect(groupLanes(VI, []).map(g => g.lanes.length)).toEqual([0, 0, 0, 0, 0, 0]);
  });
  test('every lane state lands in exactly one group', () => {
    const states = ['starting', 'running', 'idle', 'waiting_po', 'switching', 'waiting_quota', 'draining', 'stopped', 'broken', 'done', 'paused'] as const;
    const g = groupLanes(VI, states.map((s, i) => lane('L' + i, { state: s })));
    expect(g.reduce((n, x) => n + x.lanes.length, 0)).toBe(states.length);
  });
  test('blocking question: the open card from this lane in this project', () => {
    const cs = [card(1, { source: 'D2', status: 'answered' }), card(2, { source: 'D2', projectId: 'p2' }), card(3, { source: 'D2' })];
    expect(blockingCard(lane('D2'), cs)?.id).toBe(3);
    expect(blockingCard(lane('D15'), cs)).toBeNull();
  });
});
