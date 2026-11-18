// v2.1 §4.15 §1–§3 on the deck: collapsed trees (localStorage, kept lanes, "vừa đổi" 60 s + 300 ms fade, "n lane khác"
// counts, the row wire), the Xong shelf (Rev 18/11 concept B), "báo xong" line 2, row clicks.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../../shared/i18n/index.ts';
import type { LaneBranch, LaneState, OrchestratorView, Snapshot } from '../../../shared/protocol.ts';
import { buildFlow, C, type FlowInput, type LaneData, type RowData, type ShelfData } from '../../src/deck/flow/model.ts';
import { DeckCtx, LaneCard, ShelfCard, shelfClick, type DeckCtxValue } from '../../src/deck/flow/nodes.tsx';
import { rowIntent } from '../../src/deck/actions.ts';
import { CHANGED_MS, collapseNext, FADE_MS, nextChangeTick, readCollapsed, trackChanges } from '../../src/lib/collapse.ts';
import { Store } from '../../src/lib/store.ts';
import { lane, snapshot } from '../fixtures.ts';

const VI = makeT('vi');
const NOW = new Date(2026, 10, 16, 14, 0).getTime();
const orch = (sessionId: string, seq: number, over: Partial<OrchestratorView> = {}): OrchestratorView => ({ projectId: 'p1', state: 'running', account: 'a@x',
  homeAccount: 'a@x', lastError: null, costUsd: 0, contextPct: 10, talkingTo: null, sessionId, seq, ...over });
const br = (state: LaneBranch['state'], over: Partial<LaneBranch> = {}): LaneBranch =>
  ({ name: 'lane/d11', base: 'main', state, ahead: 4, files: 12, add: 340, del: 58, measuredAt: NOW - 60_000, ...over });
/** #3 open, #4 collapsible: H1..H6 on #4 in the given states. */
function two(states: LaneState[] = ['running', 'waiting_po', 'running', 'idle', 'running', 'waiting_quota'], over: Partial<Snapshot> = {}): Snapshot {
  return snapshot({
    orchestrators: [orch('s3', 3), orch('s4', 4)],
    lanes: [lane('D2', { ownerSession: 's3', ownerSeq: 3 }), ...states.map((state, i) => lane(`H${i + 1}`, { state, ownerSession: 's4', ownerSeq: 4 }))],
    ...over,
  });
}
const inp = (snap: Snapshot, over: Partial<FlowInput> = {}): FlowInput => ({ snap, projectId: 'p1', subagents: {}, selected: null, now: NOW, tr: VI, live: true, collapsed: new Set(['s4']), ...over });
const ids = (m: ReturnType<typeof buildFlow>) => m.nodes.filter(n => n.type === 'lane').map(n => n.id.slice(5));
const row = (m: ReturnType<typeof buildFlow>, id: string) => m.nodes.find(n => n.id === id)!.data as RowData;
const laneD = (m: ReturnType<typeof buildFlow>, name: string) => m.nodes.find(n => n.id === `lane:${name}`)!.data as LaneData;

const CTX: DeckCtxValue = { tr: VI, live: false, act: () => {}, menu: () => {}, toggleSubs: () => {}, toggleDone: () => {}, tip: () => {} };
const render = (el: ReactElement) => renderToStaticMarkup(<DeckCtx.Provider value={CTX}>{el}</DeckCtx.Provider>);

function memStore(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
}

describe('§4.15 §2 collapse is remembered per browser', () => {
  test('§4.15 §2 collapse persists across reload (fake localStorage)', () => {
    const ls = memStore();
    new Store(() => NOW, ls).setCollapsed('p1', ['s4']);
    expect(new Store(() => NOW, ls).get().deckUi.collapsed).toEqual({ p1: ['s4'] });
    new Store(() => NOW, ls).setCollapsed('p1', []);
    expect(new Store(() => NOW, ls).get().deckUi.collapsed).toEqual({});
  });
  test('§4.15 §2 a broken entry = every tree open; "Thu gọn cây #n" / "các cây khác"', () => {
    expect(readCollapsed({ getItem: () => '{"p1":[1]', setItem: () => {} })).toEqual({});
    expect(readCollapsed({ getItem: () => '{"p1":[3],"p2":["s"]}', setItem: () => {} })).toEqual({ p2: ['s'] });
    expect(collapseNext([], ['s3', 's4', 's5'], 's4', 'collapse')).toEqual(['s4']);
    expect(collapseNext(['s4'], ['s3', 's4', 's5'], 's4', 'collapse')).toEqual(['s4']);
    expect(collapseNext(['s4'], ['s3', 's4', 's5'], 's3', 'collapseOthers')).toEqual(['s4', 's5']);
  });
});

describe('§4.15 §2 the "vừa đổi" clock (web side, T4 ⑤)', () => {
  test('§4.15 §2 first snapshot starts nothing; a state change or a new lane starts 60 s; old entries drop', () => {
    let t = NOW;
    const s = new Store(() => t, null), snap = two();
    s.apply({ type: 'snapshot', snapshot: snap });
    expect(s.get().deckUi.changedAt).toEqual({});
    t = NOW + 1000;
    s.apply({ type: 'event', event: { type: 'lane', lane: { ...snap.lanes[1]!, state: 'idle' } } });
    s.apply({ type: 'event', event: { type: 'lane', lane: { ...snap.lanes[2]!, task: 'only text' } } });
    s.apply({ type: 'event', event: { type: 'lane', lane: lane('H9', { ownerSession: 's4' }) } });
    expect(s.get().deckUi.changedAt).toEqual({ 'p1:H1': NOW + 1000, 'p1:H9': NOW + 1000 });
    expect(trackChanges({ 'p1:H1': NOW }, [], [], NOW + CHANGED_MS + FADE_MS)).toEqual({});
    expect(nextChangeTick({ a: NOW }, NOW + 5)).toBe(NOW + CHANGED_MS);
    expect(nextChangeTick({ a: NOW }, NOW + CHANGED_MS)).toBe(NOW + CHANGED_MS + FADE_MS);
  });
});

describe('§4.15 §2 collapsed tree on the deck', () => {
  test('§4.15 §2 kept lanes: Chờ PO, Hỏng, selected (until deselect); the rest fold into one row', () => {
    const snap = two(['running', 'waiting_po', 'broken', 'idle', 'running', 'waiting_quota']);
    expect(ids(buildFlow(inp(snap)))).toEqual(['D2', 'H2', 'H3']);
    expect(ids(buildFlow(inp(snap, { selected: 'H5' })))).toEqual(['D2', 'H2', 'H3', 'H5']);
    expect(ids(buildFlow(inp(snap, { selected: null })))).toEqual(['D2', 'H2', 'H3']);
    expect(ids(buildFlow(inp(snap, { collapsed: new Set() })))).toEqual(['D2', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  });
  test('§4.15 §2 counts row text: "n lane khác" + the first two states, "+n" for the rest (N-d: never cut); the tip has every state > 0', () => {
    const r = row(buildFlow(inp(two())), 'row:s4');
    expect(r.text).toBe('5 lane khác');
    expect(r.extra).toBe('3 chạy · 1 rảnh · +1');
    expect(r.aria).toBe('5 lane khác · 3 chạy · 1 rảnh · 1 chờ quota');
    const r2 = row(buildFlow(inp(two(['running', 'waiting_po', 'broken', 'idle', 'running', 'running']))), 'row:s4');
    expect(r2.extra).toBe('3 chạy · 1 rảnh');
  });
  test('§4.15 §2 "vừa đổi" expires at 60 s, then a 300 ms fade, then the lane folds (fake clock)', () => {
    const at = NOW, f = (t: number) => buildFlow(inp(two(), { now: t, changedAt: { H1: at } }));
    expect([CHANGED_MS, FADE_MS]).toEqual([60_000, 300]); // the spec numbers, not the constants' own values
    expect(laneD(f(at + CHANGED_MS - 1), 'H1').fresh).toBe('on');
    expect(laneD(f(at + CHANGED_MS), 'H1').fresh).toBe('fading');
    expect(ids(f(at + CHANGED_MS + FADE_MS - 1))).toContain('H1');
    expect(ids(f(at + CHANGED_MS + FADE_MS))).not.toContain('H1');
    const html = render(<LaneCard id="lane:H1" d={laneD(f(at + 10), 'H1')} />);
    expect(html).toContain('fresh on');
    expect(html).toContain('vừa đổi');
    // an open tree never labels; a kept lane (Chờ PO) loses the label at 60 s but does not fade out
    expect(laneD(buildFlow(inp(two(), { now: at + 10, changedAt: { H1: at }, collapsed: new Set() })), 'H1').fresh).toBeNull();
    expect(laneD(f(at + CHANGED_MS + 1), 'H2').fresh).toBeNull();
  });
  test('§4.15 §2 row wire: dashed and dark; thick accent while the orchestrator talks to a lane folded in it', () => {
    const quiet = buildFlow(inp(two())).edges.find(e => e.target === 'row:s4')!.data;
    expect([quiet.dashed, quiet.color, quiet.width]).toEqual([true, C.dark, 1]);
    const talk = two(undefined, { orchestrators: [orch('s3', 3), orch('s4', 4, { talkingTo: 'H4' })] });
    const hot = buildFlow(inp(talk)).edges.find(e => e.target === 'row:s4')!.data;
    expect([hot.dashed, hot.color, hot.width]).toEqual([true, C.acc, 2.2]);
  });
});

describe('§4.15 §3 Xong shelf (Rev 18/11 concept B) and "báo xong"', () => {
  const T = (h: number, m: number) => new Date(2026, 10, 16, h, m).getTime();
  const withDone = (unmerged: number) => two(undefined, {
    projects: [{ ...snapshot().projects[0]!, unmerged }],
    lanes: [...two().lanes,
      lane('D11', { state: 'done', task: 'sửa đăng nhập', updatedAt: T(13, 30), ownerSession: 's3', branch: br('unmerged') }),
      lane('A2', { state: 'done', task: 'thêm CSV', updatedAt: T(13, 40), branch: br('merged', { pr: { number: 415, state: 'merged' } }) }),
      lane('A1', { state: 'done', task: 'dọn CSS', updatedAt: T(12, 0), branch: br('unknown') })],
  });
  const shelf = (m: ReturnType<typeof buildFlow>) => m.nodes.find(n => n.id === 'done')!.data as ShelfData;
  test('closed: header "Xong" + total, "Chưa merge · n" with its rows, toggle "Đã merge · n" closed, no merged rows', () => {
    const d = shelf(buildFlow(inp(withDone(3), { doneTotal: 41 })));
    expect([d.kind, d.title, d.count, d.umText, d.mergedText, d.open, d.older]).toEqual(['doneShelf', 'Xong', 41, 'Chưa merge · 3', 'Đã merge · 38', false, null]);
    expect(d.unmerged.map(r => [r.name, r.task, r.when, r.tone])).toEqual([['D11', 'sửa đăng nhập', '13:30', 'warn']]);
    expect(d.merged).toEqual([]);
  });
  test('open: merged rows newest first, "Không đo được" keeps the bad tone, older row text; selection marks the row', () => {
    const d = shelf(buildFlow(inp(withDone(1), { doneOpen: true, doneTotal: 9, selected: 'A2' })));
    expect(d.merged.map(r => [r.name, r.tone, r.selected])).toEqual([['A2', 'mut', true], ['A1', 'bad', false]]);
    expect(d.merged[0]!.aria).toBe('A2 · thêm CSV · đã merge #415 · 13:40');
    expect(d.older).toBe('6 lane xong cũ hơn…');
  });
  test('0 unmerged: no "Chưa merge" section; done lanes are never lane nodes and have no wire', () => {
    const z = withDone(0);
    const m = buildFlow(inp({ ...z, lanes: z.lanes.filter(l => l.name !== 'D11') }));
    expect([shelf(m).umText, shelf(m).unmerged, shelf(m).mergedText]).toEqual([null, [], 'Đã merge · 2']);
    expect(m.nodes.filter(n => n.type === 'lane').map(n => n.id)).not.toContain('lane:A2');
    expect(m.edges.some(e => e.target === 'done')).toBe(false);
  });
  test('render: rows / toggle / older are buttons; clicks → select lane, toggle, done list; amber only as text', () => {
    const acts: unknown[] = [];
    let toggled = 0;
    const ctx: DeckCtxValue = { ...CTX, act: i => { acts.push(i); }, toggleDone: () => { toggled++; } };
    const d = shelf(buildFlow(inp(withDone(1), { doneOpen: true, doneTotal: 9, selected: 'A2' })));
    const html = renderToStaticMarkup(<DeckCtx.Provider value={ctx}><ShelfCard id="done" d={d} /></DeckCtx.Provider>);
    expect(html).toContain('class="sec warn"');
    expect(html).toMatch(/<button[^>]*class="rw merged sel"/);
    expect(html).toMatch(/<button[^>]*class="tgl"[^>]*aria-expanded="true"/);
    expect(html).toMatch(/<button[^>]*class="ft"/);
    shelfClick(ctx, 'done', { t: 'lane', name: 'D11' });
    shelfClick(ctx, 'done', null);
    shelfClick(ctx, 'done', { t: 'done_list' });
    expect(acts).toEqual([{ t: 'lane', name: 'D11' }, { t: 'done_list' }]);
    expect(toggled).toBe(1);
  });
  test('§4.15 §1 "báo xong · chưa merge · 2 commit" on a live lane + tooltip', () => {
    const rep = two(undefined, { lanes: [lane('D4', { state: 'idle', phase: 'done', ownerSession: 's3', branch: br('unmerged', { ahead: 2 }) })] });
    const d = laneD(buildFlow(inp(rep)), 'D4');
    expect(d.branch).toMatchObject({ text: 'chưa merge · 2 commit', tone: 'warn' });
    expect(d.tip).toContain('chờ Điều phối kết thúc lane');
    const html = render(<LaneCard id="lane:D4" d={d} />);
    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain('báo xong · chưa merge · 2 commit');
    expect(buildFlow(inp(rep)).nodes.some(n => n.id === 'done')).toBe(false); // not in Xong → never on the shelf
  });
  test('§4.15 rows: "n lane khác" → open that tree, "+n" → its lane', () => {
    expect(rowIntent('collapsedRow', 'row:s4', null)).toEqual({ t: 'expand', root: 's4' });
    expect(rowIntent('more', 'more:D2', 'D2')).toEqual({ t: 'more', lane: 'D2' });
  });
});
