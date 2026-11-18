// spec v2.1 §4.1, §4.4, §4.5, §4.6, §4.11, §4.14, §4.15 §2, §6 "Bố cục": the pure tree layout.
import { describe, expect, test } from 'bun:test';
import type { LaneState } from '../../shared/protocol.ts';
import {
  layoutDeck, LANE_GAP, LANE_H, LANE_W, ORCH_W, SUB_H, SUB_W,
  type DeckLayout, type LayoutInput, type LayoutLane, type Wire,
} from '../src/deck/layout.ts';
import { deckTreeInput } from '../src/deck/model.ts';
import { CHANGED_MS, FADE_MS } from '../src/lib/collapse.ts';
import { scene } from './deck/scene.ts';
import type { SubagentView } from '../../shared/protocol.ts';

const sub = (taskId: string, status: SubagentView['status']): SubagentView =>
  ({ taskId, toolUseId: taskId, description: '', subagentType: 'x', background: false, status, totalTokens: null, toolUses: null, lastTool: null });

type Seg = [[number, number], [number, number]];
const NOW = 1_000_000;

function lane(name: string, root: string, order: number, o: Partial<LayoutLane> = {}): LayoutLane {
  return { name, root, order, state: 'running', done: false, unmerged: false, doneAt: null, changedAt: null, subs: [], subsOpen: true, ...o };
}
function input(o: Partial<LayoutInput> = {}): LayoutInput {
  return { roots: [{ id: 'r1', collapsed: false }], lanes: [], selected: null, doneOpen: false, now: NOW, ...o };
}
/** n lanes on one root, lane i has subs(i) subagents. */
function oneTree(n: number, subs: (i: number) => number = () => 0, open = true, extra: Partial<LayoutInput> = {}): LayoutInput {
  return input({ lanes: Array.from({ length: n }, (_, i) => lane(`L${i}`, 'r1', i, { subs: Array.from({ length: subs(i) }, (_, k) => `s${k}`), subsOpen: open })), ...extra });
}

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function overlapping(l: DeckLayout): string[] {
  const out: string[] = [];
  for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++)
    if (overlap(l.nodes[i]!, l.nodes[j]!)) out.push(`${l.nodes[i]!.id} × ${l.nodes[j]!.id}`);
  return out;
}
const segs = (w: Wire): Seg[] => w.points.slice(1).map((p, i) => [w.points[i]!, p]);
function nonOrthogonal(l: DeckLayout): string[] {
  return l.wires.flatMap(w => segs(w).filter(([a, b]) => a[0] !== b[0] && a[1] !== b[1]).map(() => w.id));
}
/** Intersection point of two axis-aligned segments (null = none; collinear overlap → 'collinear'). */
function meet(s: Seg, t: Seg): [number, number] | 'collinear' | null {
  const box = (q: Seg) => ({ x0: Math.min(q[0][0], q[1][0]), x1: Math.max(q[0][0], q[1][0]), y0: Math.min(q[0][1], q[1][1]), y1: Math.max(q[0][1], q[1][1]) });
  const a = box(s), b = box(t);
  const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1), y0 = Math.max(a.y0, b.y0), y1 = Math.min(a.y1, b.y1);
  if (x0 > x1 || y0 > y1) return null;
  return x0 === x1 && y0 === y1 ? [x0, y0] : 'collinear';
}
/** §4.6 crossing pairs: wires of different parents may not touch; wires of one parent may only meet on their shared vertical. */
function crossings(wires: Wire[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
    const A = wires[i]!, B = wires[j]!, same = A.from === B.from, vx = A.points[1]?.[0];
    for (const s of segs(A)) for (const t of segs(B)) {
      const m = meet(s, t);
      if (!m) continue;
      if (same && (m === 'collinear' || m[0] === vx || (m[0] === A.points[0]![0] && m[1] === A.points[0]![1]))) continue;
      out.push(`${A.id} × ${B.id}`);
    }
  }
  return out;
}
const node = (l: DeckLayout, id: string) => l.nodes.find(n => n.id === id)!;
const cy = (n: { y: number; h: number }) => n.y + n.h / 2;

describe('§6 crossing check itself', () => {
  test('§6 a hand-made crossing pair from two parents is detected; one parent sharing its vertical is not', () => {
    const x: Wire = { id: 'a', from: 'p', to: 'c1', points: [[0, 0], [10, 0], [10, 50], [20, 50]] };
    const y: Wire = { id: 'b', from: 'q', to: 'c2', points: [[0, 20], [30, 20]] };
    expect(crossings([x, y])).toEqual(['a × b']);
    const z: Wire = { id: 'c', from: 'p', to: 'c3', points: [[0, 0], [10, 0], [10, 30], [20, 30]] };
    expect(crossings([x, z])).toEqual([]);
  });
});

describe('§6 Bố cục — scale matrix', () => {
  for (const n of [1, 10, 24, 33]) for (const maxSubs of [0, 3, 8]) for (const open of [true, false]) {
    test(`§6 ${n} lanes × 0–${maxSubs} subs × subs ${open ? 'open' : 'closed'}: 0 overlaps, orthogonal wires, 0 crossings`, () => {
      const l = layoutDeck(oneTree(n, i => (i * 5) % (maxSubs + 1), open));
      expect(overlapping(l)).toEqual([]);
      expect(nonOrthogonal(l)).toEqual([]);
      expect(crossings(l.wires)).toEqual([]);
      expect(l.nodes.filter(x => x.kind === 'lane').length).toBe(n);
    });
  }
});

describe('§4.1 geometry', () => {
  test('§4.2 §4.4 §4.5 node sizes; §4.1 lanes 64 px, 10 px apart, column gap ≥ 36 px', () => {
    const l = layoutDeck(oneTree(3, i => (i === 1 ? 2 : 0)));
    const root = node(l, 'orch:r1'), a = node(l, 'lane:L0'), b = node(l, 'lane:L1'), s = node(l, 'sub:L1:s0');
    expect([root.w, root.h]).toEqual([ORCH_W, 64]);
    expect([a.w, a.h]).toEqual([LANE_W, LANE_H]);
    expect([s.w, s.h]).toEqual([SUB_W, SUB_H]);
    expect([ORCH_W, LANE_W, SUB_W, SUB_H, LANE_H, LANE_GAP]).toEqual([216, 268, 150, 30, 64, 10]);
    expect(b.y - (a.y + a.h)).toBe(LANE_GAP);
    expect(a.x - (root.x + root.w)).toBeGreaterThanOrEqual(36);
    expect(s.x - (b.x + b.w)).toBeGreaterThanOrEqual(36);
  });
  test('§4.1 sub column centred on its lane; the next lane shifts down so nothing overlaps', () => {
    const l = layoutDeck(oneTree(3, i => (i === 1 ? 5 : 0)));
    const subs = l.nodes.filter(n => n.kind === 'subagent' && n.lane === 'L1');
    expect(subs.length).toBe(5);
    const top = Math.min(...subs.map(s => s.y)), bot = Math.max(...subs.map(s => s.y + s.h));
    expect((top + bot) / 2).toBe(cy(node(l, 'lane:L1')));
    expect(node(l, 'lane:L2').y).toBe(bot + LANE_GAP);
    expect(top).toBe(node(l, 'lane:L0').y + LANE_H + LANE_GAP);
  });
  test('§4.5 ≤ 6 sub nodes + "+n"; closed branch → no sub node', () => {
    const l = layoutDeck(oneTree(1, () => 8));
    expect(l.nodes.filter(n => n.kind === 'subagent').length).toBe(6);
    const more = node(l, 'more:L0');
    expect([more.kind, more.count]).toEqual(['more', 2]);
    expect(layoutDeck(oneTree(1, () => 8, false)).nodes.filter(n => n.kind === 'subagent' || n.kind === 'more')).toEqual([]);
  });
  test('§4.6 every wire of one parent shares one vertical x; child wires end at the child left edge', () => {
    const l = layoutDeck(oneTree(5, i => i % 3));
    const fromRoot = l.wires.filter(w => w.from === 'orch:r1');
    expect(fromRoot.length).toBe(5);
    expect(new Set(fromRoot.map(w => w.points[1]![0])).size).toBe(1);
    for (const w of l.wires) {
      const c = node(l, w.to), last = w.points.at(-1)!;
      expect(last).toEqual([c.x, cy(c)]);
    }
  });
  test('§4.1 root centred on its lanes when ≤ 4', () => {
    const l = layoutDeck(oneTree(3));
    expect(cy(node(l, 'orch:r1'))).toBe((node(l, 'lane:L0').y + node(l, 'lane:L2').y + LANE_H) / 2);
  });
  test('§4.1 W18 root never below lane 4 (24 lanes)', () => {
    const l = layoutDeck(oneTree(24));
    expect(cy(node(l, 'orch:r1'))).toBe(cy(node(l, 'lane:L3')));
    const eight = layoutDeck(oneTree(8)), seven = layoutDeck(oneTree(7));
    expect(cy(node(eight, 'orch:r1'))).toBe(cy(node(eight, 'lane:L3'))); // mid (between L3 and L4) clamped up
    expect(cy(node(seven, 'orch:r1'))).toBe(cy(node(seven, 'lane:L3'))); // mid = L3 exactly
  });
  test('§4.1 lane order = creation order, whatever the input order', () => {
    const ls = [lane('B', 'r1', 2), lane('C', 'r1', 0), lane('A', 'r1', 1)];
    const l = layoutDeck(input({ lanes: ls }));
    const ys = ['C', 'A', 'B'].map(n => node(l, `lane:${n}`).y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(l.keyOrder).toEqual(['C', 'A', 'B']);
  });
});

describe('§4.15 §3 Xong shelf (Rev 18/11, concept B)', () => {
  /** lane L0 live; nDone done lanes, the first `um` of them unmerged; D(i) done at 100 + i. */
  const withDone = (nDone: number, open: boolean, um = 0, o: Partial<LayoutInput> = {}) => input({
    lanes: [lane('L0', 'r1', 0), ...Array.from({ length: nDone }, (_, i) => lane(`D${i}`, 'r1', i + 1, { state: 'done', done: true, doneAt: 100 + i, unmerged: i < um }))],
    doneOpen: open, ...o,
  });
  test('one shelf node under the first root, root column, no wire to it; done lanes are never lane nodes or keys', () => {
    const l = layoutDeck(withDone(4, false, 1));
    expect(l.nodes.filter(n => n.kind === 'lane').map(n => n.lane)).toEqual(['L0']);
    const s = node(l, 'done'), r = node(l, 'orch:r1');
    expect([s.kind, s.count, s.x, s.w]).toEqual(['doneShelf', 4, 0, 228]);
    expect(s.y).toBe(r.y + r.h + 26);
    expect(l.wires.some(w => w.to === 'done')).toBe(false);
    expect(l.keyOrder).toEqual(['L0']);
  });
  test('unmerged rows always listed (newest first); merged rows only when open, ≤ 6 − unmerged, newest first; then older', () => {
    const closed = node(layoutDeck(withDone(9, false, 2)), 'done');
    expect(closed.shelf).toEqual({ unmerged: ['D1', 'D0'], merged: [], umCount: 2, older: 0 });
    const open = node(layoutDeck(withDone(9, true, 2)), 'done');
    expect(open.shelf).toEqual({ unmerged: ['D1', 'D0'], merged: ['D8', 'D7', 'D6', 'D5'], umCount: 2, older: 3 });
    expect(node(layoutDeck(withDone(6, true, 2)), 'done').shelf!.older).toBe(0);
  });
  test('height = header 30 + sections 24 + rows 26 + older 28 + border 2 (closed 132, open 264 for 2 unmerged / 4 merged)', () => {
    expect(node(layoutDeck(withDone(9, false, 2)), 'done').h).toBe(2 + 30 + 24 + 2 * 26 + 24);
    expect(node(layoutDeck(withDone(9, true, 2)), 'done').h).toBe(2 + 30 + 24 + 2 * 26 + 24 + 4 * 26 + 28);
    expect(node(layoutDeck(withDone(3, false, 0)), 'done').h).toBe(2 + 30 + 24); // no "Chưa merge" section
  });
  test('the root stays centred on its live lanes (shelf excluded); the tree bottom clears the shelf; no overlap', () => {
    const two = withDone(9, true, 2);
    two.lanes.push(lane('L1', 'r1', 50));
    const l = layoutDeck(two);
    const r = node(l, 'orch:r1'), s = node(l, 'done');
    expect(r.y + r.h / 2).toBe((node(l, 'lane:L0').y + node(l, 'lane:L1').y + LANE_H) / 2);
    expect(l.height).toBe(s.y + s.h);
    expect(overlapping(l)).toEqual([]);
  });
  test('0 live lanes: the shelf sits right under the root, no fake lane, no wire', () => {
    const l = layoutDeck(input({ lanes: [lane('D0', 'r1', 0, { state: 'done', done: true, doneAt: 1, unmerged: true })] }));
    const r = node(l, 'orch:r1'), s = node(l, 'done');
    expect([r.y, s.y]).toEqual([0, 64 + 26]);
    expect(l.wires).toEqual([]);
    expect(l.nodes.map(n => n.kind)).toEqual(['orchestrator', 'doneShelf']);
  });
  test('the unmerged count is the engine total when larger (doneUnmerged), rows stay what the snapshot carries', () => {
    expect(node(layoutDeck(withDone(4, false, 1, { doneUnmerged: 5 })), 'done').shelf!.umCount).toBe(5);
  });
  test('no done lane → no shelf', () => expect(layoutDeck(oneTree(2)).nodes.some(n => n.kind === 'doneShelf')).toBe(false));
});

describe('§4.14 several roots', () => {
  const three = (o: Partial<LayoutInput> = {}, subs = 0) => input({
    roots: [{ id: 'a', collapsed: false }, { id: 'b', collapsed: false }, { id: 'c', collapsed: false }],
    lanes: ['a', 'b', 'c'].flatMap((r, ri) => Array.from({ length: 20 }, (_, i) => lane(`${r}${i}`, r, ri * 100 + i, { subs: Array.from({ length: (i * 7) % (subs + 1) }, (_, k) => `s${k}`) }))),
    ...o,
  });
  test('§4.14 3 roots × 20 lanes: no overlap, orthogonal, 0 crossings, separators between trees', () => {
    const l = layoutDeck(three({}, 8));
    expect(overlapping(l)).toEqual([]);
    expect(nonOrthogonal(l)).toEqual([]);
    expect(crossings(l.wires)).toEqual([]);
    expect(l.separators.length).toBe(2);
    const bottom = (r: string) => Math.max(...l.nodes.filter(n => n.root === r).map(n => n.y + n.h));
    const top = (r: string) => Math.min(...l.nodes.filter(n => n.root === r).map(n => n.y));
    expect(l.separators[0]!.y).toBeGreaterThan(bottom('a'));
    expect(l.separators[0]!.y).toBeLessThan(top('b'));
    expect(l.separators[1]!.y).toBeGreaterThan(bottom('b'));
    expect(l.separators[1]!.y).toBeLessThan(top('c'));
  });
  test('§4.14 the shelf of every session sits under the first root (no wire)', () => {
    const base = three();
    base.lanes.push(lane('Dx', 'c', 999, { state: 'done', done: true, doneAt: 5 }), lane('Dy', 'gone', 998, { state: 'done', done: true, doneAt: 6 }));
    const l = layoutDeck(base);
    const g = node(l, 'done');
    expect(g.root).toBe('a');
    expect(g.count).toBe(2);
    expect(l.wires.some(w => w.to === 'done')).toBe(false);
    expect(overlapping(l)).toEqual([]);
    expect(g.y).toBeLessThan(l.separators[0]!.y);
  });
  test('§4.11 §4.14 keys 1–9 run over every root in tree order', () => {
    const l = layoutDeck(three());
    expect(l.keyOrder.slice(0, 3)).toEqual(['a0', 'a1', 'a2']);
    expect(l.keyOrder.slice(20, 22)).toEqual(['b0', 'b1']);
    expect(l.keyOrder.length).toBe(60);
  });
  test('§4.14 a lane whose root is not live goes to the first root', () => {
    const l = layoutDeck(input({ lanes: [lane('X', 'gone', 0)] }));
    expect(node(l, 'lane:X').root).toBe('r1');
  });
});

describe('§4.15 §2 collapsed tree', () => {
  const states: LaneState[] = ['running', 'waiting_po', 'idle', 'broken', 'running', 'waiting_quota', 'running', 'idle'];
  const coll = (o: { selected?: string | null; changed?: Record<string, number>; collapsed?: boolean; only?: LaneState[] } = {}) => {
    const st = o.only ?? states;
    return input({
      roots: [{ id: 'a', collapsed: false }, { id: 'b', collapsed: o.collapsed ?? true }],
      lanes: [lane('A0', 'a', 0), ...st.map((s, i) => lane(`B${i}`, 'b', 10 + i, { state: s, changedAt: o.changed?.[`B${i}`] ?? null }))],
      selected: o.selected ?? null,
    });
  };
  const kept = (l: DeckLayout) => l.nodes.filter(n => n.kind === 'lane' && n.root === 'b').map(n => n.lane);
  test('§4.15 collapsed root keeps waiting_po + broken lanes; the rest → one row with per-state counts', () => {
    const l = layoutDeck(coll());
    expect(kept(l)).toEqual(['B1', 'B3']);
    const row = node(l, 'row:b');
    expect(row.kind).toBe('collapsedRow');
    expect(row.count).toBe(6);
    expect(row.counts).toEqual({ running: 3, idle: 2, waiting_quota: 1 });
    expect(l.wires.find(w => w.to === 'row:b')!.dashed).toBe(true);
    expect(overlapping(l)).toEqual([]);
    expect(crossings(l.wires)).toEqual([]);
  });
  test('§4.15 collapsed root keeps the selected lane', () => {
    expect(kept(layoutDeck(coll({ selected: 'B5' })))).toEqual(['B1', 'B3', 'B5']);
  });
  test('§4.15 collapsed root keeps a lane changed < 60 s + 300 ms fade ago, folds it after', () => {
    const l = layoutDeck(coll({ changed: { B0: NOW - CHANGED_MS - FADE_MS + 1, B2: NOW - CHANGED_MS - FADE_MS } }));
    expect(kept(l)).toEqual(['B0', 'B1', 'B3']);
    expect([CHANGED_MS, FADE_MS]).toEqual([60_000, 300]);
  });
  test('§4.15 no row when every lane is kept', () => {
    const l = layoutDeck(coll({ only: ['waiting_po', 'broken'] }));
    expect(l.nodes.some(n => n.kind === 'collapsedRow')).toBe(false);
    expect(kept(l)).toEqual(['B0', 'B1']);
  });
  test('§4.11 key order skips hidden lanes (and done lanes)', () => {
    const l = layoutDeck(coll());
    expect(l.keyOrder).toEqual(['A0', 'B1', 'B3']);
  });
  test('§4.15 collapse applies only when > 1 root is live', () => {
    const l = layoutDeck(input({ roots: [{ id: 'r1', collapsed: true }], lanes: [lane('A', 'r1', 0), lane('B', 'r1', 1)] }));
    expect(l.keyOrder).toEqual(['A', 'B']);
    expect(l.nodes.some(n => n.kind === 'collapsedRow')).toBe(false);
  });
  test('§4.15 the shelf is shown even when the first root is collapsed', () => {
    const base = coll();
    base.roots = [{ id: 'b', collapsed: true }, { id: 'a', collapsed: false }];
    base.lanes.push(lane('D', 'a', 99, { state: 'done', done: true, doneAt: 1 }));
    const l = layoutDeck(base);
    expect(node(l, 'done').root).toBe('b');
    expect(overlapping(l)).toEqual([]);
  });
  test('§4.15 §3 the shelf counts every done lane (doneTotal); older = total − rows shown', () => {
    const lanes = Array.from({ length: 8 }, (_, i) => lane(`X${i}`, 'r1', i, { state: 'done', done: true, doneAt: i }));
    const l = layoutDeck(input({ lanes, doneOpen: true, doneTotal: 41 }));
    expect(node(l, 'done').count).toBe(41);
    expect(l.nodes.filter(n => n.kind === 'lane')).toEqual([]);
    expect(node(l, 'done').shelf).toEqual({ unmerged: [], merged: ['X7', 'X6', 'X5', 'X4', 'X3', 'X2'], umCount: 0, older: 35 });
    expect(node(layoutDeck(input({ lanes, doneOpen: true })), 'done').count).toBe(8);
  });
});

describe('§5.1 snapshot → layout input (model.ts deckTreeInput)', () => {
  test('§4.14 one live root per project today; lanes keep snapshot (creation) order; done lanes flagged', () => {
    const s = scene(5);
    const t = deckTreeInput(s, 'p1', { subagents: { D2: [sub('t1', 'running'), sub('t2', 'failed')], B2: 2 }, selected: 'D2', now: 5 });
    expect(t.roots).toEqual([{ id: 'p1', collapsed: false }]);
    expect(t.lanes.map(l => l.name)).toEqual(s.lanes.map(l => l.name));
    expect(t.lanes.map(l => l.order)).toEqual(s.lanes.map((_, i) => i));
    expect(t.lanes.find(l => l.name === 'E4')!.done).toBe(true);
    const um = scene(5);
    um.lanes.find(l => l.name === 'E4')!.branch = { name: 'lane/e4', base: 'main', state: 'unmerged', ahead: 2, files: 1, add: 1, del: 0, measuredAt: 0 };
    expect(deckTreeInput(um, 'p1', { subagents: {}, selected: null, now: 0 }).lanes.filter(l => l.unmerged).map(l => l.name)).toEqual(['E4']);
    expect(t.lanes.find(l => l.name === 'D2')!.subs).toEqual(['t1', 't2']);
    expect(t.lanes.find(l => l.name === 'B2')!.subs.length).toBe(2);
    expect([t.selected, t.now, t.doneOpen]).toEqual(['D2', 5, false]);
  });
  test('§4.5 closed sub branches stay closed; no project → no root', () => {
    const t = deckTreeInput(scene(5), 'p1', { subagents: {}, selected: null, now: 0, closedSubs: new Set(['D2']) });
    expect(t.lanes.find(l => l.name === 'D2')!.subsOpen).toBe(false);
    expect(t.lanes.find(l => l.name === 'B2')!.subsOpen).toBe(true);
    expect(deckTreeInput(scene(5), 'nope', { subagents: {}, selected: null, now: 0 }).roots).toEqual([]);
  });
  test('§4.11 keys 1–9 of the deck model = layout order (creation order), done lanes excluded', () => {
    const s = scene(5), t = deckTreeInput(s, 'p1', { subagents: {}, selected: null, now: 0 });
    expect(layoutDeck(t).keyOrder).toEqual(s.lanes.filter(l => l.state !== 'done').map(l => l.name));
  });
});
