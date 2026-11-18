// v2.1 §4.15 §3 / §4 web logic: merge state text, the "Nhờ Điều phối merge" prefill, the done list groups / chips /
// local filter, the done selections (Esc ladder), the notification focus plan.
import { describe, expect, test } from 'bun:test';
import { makeT } from '../../shared/i18n/index.ts';
import type { LaneBranch } from '../../shared/protocol.ts';
import {
  appendDraft, branchText, COMPOSER_MAX_H, composerHeight, filterDone, groupDone, mergeAsk, mergeSession, transcriptLeft,
} from '../src/lib/done.ts';
import { composerTarget, crumbs, focusPlan, laneSel, ORCH, selLane, selUp } from '../src/lib/inspector.ts';
import { card, lane, snapshot } from './fixtures.ts';

const VI = makeT('vi');
const NOW = new Date(2026, 10, 16, 14, 0).getTime(), H = 3_600_000, D = 24 * H;
const br = (state: LaneBranch['state'], over: Partial<LaneBranch> = {}): LaneBranch =>
  ({ name: 'lane/d11', base: 'main', state, ahead: 4, files: 12, add: 340, del: 58, measuredAt: NOW, ...over });

describe('§4.15 §3 merge state text', () => {
  test('§4.15 §3 each measured state reads as on N6-e / N6-k', () => {
    expect(branchText(VI, br('unmerged'))).toEqual({ text: 'chưa merge · 4 commit', tone: 'warn', measuring: false });
    expect(branchText(VI, br('merged', { pr: { number: 415, state: 'merged' } })).text).toBe('đã merge #415');
    expect(branchText(VI, br('merged')).text).toBe('đã merge');
    expect(branchText(VI, br('gone')).text).toBe('nhánh đã xoá');
    expect(branchText(VI, br('none')).text).toBe('không có nhánh riêng');
    expect(branchText(VI, br('unknown', { reason: 'repo đang khoá' }))).toMatchObject({ text: 'không đo được', tone: 'bad' });
    expect(branchText(VI, br('unmerged', { measuring: true })).measuring).toBe(true);
    expect(branchText(VI, null).text).toBe('chưa đo');
  });
});

describe('§4.15 §3 "Nhờ Điều phối #n merge…" prefill', () => {
  test('§4.15 §3 the sentence names lane, branch, commits, files, base', () => {
    expect(mergeAsk(VI, lane('D11', { branch: br('unmerged') }))).toBe('Merge D11 (lane/d11, 4 commit, 12 file) vào main sau khi chạy lại gate.');
  });
  test('§4.15 §3 prefill appends under a draft on a new line, never overwrites; empty draft = the sentence', () => {
    expect(appendDraft('', 'Merge D11')).toBe('Merge D11');
    expect(appendDraft('  \n', 'Merge D11')).toBe('Merge D11');
    expect(appendDraft('xem lại D7 trước\n', 'Merge D11')).toBe('xem lại D7 trước\nMerge D11');
  });
  test('§4.15 §3 composer grows with the text up to 120 px, then scrolls', () => {
    expect(composerHeight(44, 2)).toBe(46); // T12b: #cmd is border-box, scrollHeight has no border → +2 px or it scrolls
    expect(composerHeight(300, 2)).toBe(COMPOSER_MAX_H);
    expect(COMPOSER_MAX_H).toBe(120);
  });
  test('§4.15 §3 the holding session gets it; an ended holder → the session being viewed', () => {
    const os = [{ sessionId: 's3' }, { sessionId: 's4' }] as never[];
    expect(mergeSession({ ownerSession: 's4' }, os, 's3')).toBe('s4');
    expect(mergeSession({ ownerSession: 's2' }, os, 's3')).toBe('s3');
    expect(mergeSession({ ownerSession: null }, os, 's3')).toBe('s3');
  });
});

describe('§4.15 §3 done list', () => {
  const rows = [
    lane('D11', { state: 'done', updatedAt: NOW - 2 * H, task: 'group C lot-2', branch: br('unmerged') }),
    lane('A2', { state: 'done', updatedAt: NOW - 3 * H, branch: br('merged') }),
    lane('D7', { state: 'done', updatedAt: NOW - 3 * D, branch: br('unmerged', { name: 'lane/d7' }) }),
    lane('X4', { state: 'done', updatedAt: NOW - 1 * D, task: 'docs lot-2', branch: br('unknown') }),
    lane('Z1', { state: 'done', updatedAt: NOW - 9 * D, branch: br('merged') }),
  ];
  test('§4.15 §3 by day: Hôm nay first, each day of the week, "Cũ hơn 7 ngày" closed', () => {
    const g = groupDone(VI, rows, NOW, false);
    expect(g.map(x => [x.id, x.n, x.closed])).toEqual([['d0', 2, false], ['d1', 1, false], ['d3', 1, false], ['older', 1, true]]);
    expect(g[0]!.label).toBe('Hôm nay');
    expect(g[0]!.lanes.map(l => l.name)).toEqual(['D11', 'A2']);
    expect(g.at(-1)!.label).toBe('Cũ hơn 7 ngày');
  });
  test('§4.15 §3 "Chưa merge" chip splits "Chưa merge · n" / "Không đo được · n"', () => {
    const g = groupDone(VI, rows, NOW, true);
    expect(g.map(x => [x.label, x.n])).toEqual([['Chưa merge', 2], ['Không đo được', 1]]);
    expect(g[0]!.lanes.map(l => l.name)).toEqual(['D11', 'D7']);
  });
  test('§4.15 Trạng thái offline: filter on the spot by name, task, branch (no diacritics needed)', () => {
    expect(filterDone(rows, 'd7').map(l => l.name)).toEqual(['D7']);
    expect(filterDone(rows, 'lane/d7').map(l => l.name)).toEqual(['D7']);
    expect(filterDone(rows, 'DOCS').map(l => l.name)).toEqual(['X4']);
    expect(filterDone(rows, '  ').length).toBe(5);
  });
  test('§4.15 §3 transcript days left from the last activity', () => {
    expect(transcriptLeft(NOW, NOW, 30)).toBe(30);
    expect(transcriptLeft(NOW - 2.5 * D, NOW, 30)).toBe(28);
    expect(transcriptLeft(NOW - 31 * D, NOW, 30)).toBeLessThanOrEqual(0);
  });
});

describe('§4.15 §3 done selections', () => {
  test('§4.15 §3 Esc: done lane → done list → Điều phối; done lane watches its lane (measure on open)', () => {
    expect(selUp({ k: 'doneLane', name: 'D11' })).toEqual({ k: 'doneList' });
    expect(selUp({ k: 'doneList' })).toEqual(ORCH);
    expect(composerTarget({ k: 'doneLane', name: 'D11' }, 'p1', 's3')).toEqual({ kind: 'lane', projectId: 'p1', name: 'D11' });
    expect(composerTarget({ k: 'doneList' }, 'p1', 's3')).toEqual({ kind: 'orchestrator', projectId: 'p1', sessionId: 's3' });
    expect(selLane({ k: 'doneLane', name: 'D11' })).toBe('D11');
    expect(crumbs({ k: 'doneLane', name: 'D11' }, VI, {}, 'Điều phối #3')).toEqual(['Điều phối #3', 'Xong', 'D11']);
    expect(laneSel(lane('D11', { state: 'done' }))).toEqual({ k: 'doneLane', name: 'D11' });
    expect(laneSel(lane('D2'))).toEqual({ k: 'lane', name: 'D2' });
  });
});

describe('§4.15 §4 notification focus', () => {
  const snap = snapshot({
    lanes: [lane('H4', { ownerSession: 's4' }), lane('D11', { state: 'done' }), lane('D2')],
    cards: [card(7, { source: 'D2' })],
  });
  test('§4.15 §4 card → its card focused in Chờ PO and its lane selected', () => {
    expect(focusPlan({ cardId: 7, projectId: 'p1', lane: 'D2' }, snap)).toEqual({ projectId: 'p1', sel: { k: 'lane', name: 'D2' }, cardId: 7, expand: null, openDone: false });
  });
  test('§4.15 §2 / §4 ⌘K Enter or a notification on a hidden lane → expand its tree + select it', () => {
    expect(focusPlan({ cardId: null, projectId: 'p1', lane: 'H4' }, snap)).toEqual({ projectId: 'p1', sel: { k: 'lane', name: 'H4' }, cardId: null, expand: 's4', openDone: false });
  });
  test('§4.15 §4 "lane xong" (no card) → done group opens, the done lane selected', () => {
    expect(focusPlan({ cardId: null, projectId: 'p1', lane: 'D11' }, snap)).toEqual({ projectId: 'p1', sel: { k: 'doneLane', name: 'D11' }, cardId: null, expand: null, openDone: true });
  });
  test('§4.15 §4 a card without lane target (pre-v2.1 payload) → its project, its source lane', () => {
    expect(focusPlan({ cardId: 7, projectId: null, lane: null }, snap)).toMatchObject({ projectId: 'p1', sel: { k: 'lane', name: 'D2' }, cardId: 7 });
    expect(focusPlan({ cardId: null, projectId: null, lane: null }, snap).sel).toBeNull();
  });
});
