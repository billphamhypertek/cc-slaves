// spec v2.3 §6.1 "Đồ thị" + §10.1 "Đồ thị" + §11 Web-unit "xếp đường đồ thị": the pure lane layout of web/src/git/graph.ts.
import { describe, expect, test } from 'bun:test';
import { GRAPH_VIRTUAL_AFTER, graphWindow, layoutGraph, railPaths, trackColor, type GraphCommit } from '../../src/git/graph.ts';

const c = (hash: string, parents: string[], branches: string[] = []): GraphCommit => ({ hash, parents, branches });

/** Mockup G5 (filter: main + lane/d15), newest first. */
const D15 = [
  c('d3', ['d2'], ['lane/d15']),
  c('d2', ['d1']),
  c('m3', ['m2'], ['main']),
  c('d1', ['m2']),
  c('m2', ['m1']),
  c('m1', []),
];

describe('§6.1 Đồ thị layout', () => {
  test('§6.1 the base keeps column 0 even when a lane head is newer (mockup G5)', () => {
    const g = layoutGraph(D15, 'main');
    expect(g.rows.map(r => r.col)).toEqual([1, 1, 0, 1, 0, 0]);
    expect(g.cols).toBe(2);
  });
  test('§6.1 a lane line starts at its head commit: nothing drawn above it', () => {
    const g = layoutGraph(D15, 'main');
    expect(g.rows[0]!.segs).toEqual([{ col: 1, track: g.rows[0]!.track, part: 'bottom' }]);
    // the base line starts at the base head (row 2): rows 0–1 carry no column-0 line
    expect(g.rows[0]!.segs.some(s => s.col === 0)).toBe(false);
    expect(g.rows[1]!.segs.some(s => s.col === 0)).toBe(false);
    expect(g.rows[2]!.segs).toContainEqual({ col: 0, track: g.rows[2]!.track, part: 'bottom' });
  });
  test('§6.1 the lane line forks into the base at the merge-base with a curve into that dot', () => {
    const g = layoutGraph(D15, 'main');
    const mb = g.rows[4]!; // m2
    expect(mb.col).toBe(0);
    expect(mb.curves).toEqual([{ from: 1, to: 0, track: g.rows[0]!.track, dir: 'in' }]);
    expect(mb.segs.some(s => s.col === 1)).toBe(false); // the lane column ends there
    expect(g.rows[5]!.segs).toEqual([{ col: 0, track: mb.track, part: 'top' }]); // root: no line below
  });
  test('§10.1 stable columns: a column passing a row is a full line, the commit column never moves', () => {
    const g = layoutGraph(D15, 'main');
    expect(g.rows[2]!.segs).toContainEqual({ col: 1, track: g.rows[0]!.track, part: 'full' });
    expect(g.rows[3]!.segs).toContainEqual({ col: 0, track: g.rows[2]!.track, part: 'full' });
  });
  test('§10.1 a merge commit curves out to its second parent column', () => {
    const g = layoutGraph([c('m', ['a', 'b'], ['main']), c('b', ['a']), c('a', [])], 'main');
    expect(g.rows[0]!.curves).toEqual([{ from: 0, to: 1, track: g.rows[1]!.track, dir: 'out' }]);
    expect(g.rows[1]!.col).toBe(1);
    expect(g.rows[2]!.curves).toEqual([{ from: 1, to: 0, track: g.rows[1]!.track, dir: 'in' }]);
  });
  test('§10.1 a merge whose second parent is already in a column curves into that column', () => {
    const g = layoutGraph([c('x', ['a'], ['lane/x']), c('m', ['b', 'a'], ['main']), c('b', ['a']), c('a', [])], 'main');
    expect(g.rows[1]!.curves).toEqual([{ from: 0, to: 1, track: g.rows[0]!.track, dir: 'out' }]);
  });
  test('§10.1 freed columns are reused (no ever-growing width)', () => {
    const g = layoutGraph([
      c('x', ['a'], ['lane/x']), c('a', ['r'], ['main']), c('y', ['r'], ['lane/y']), c('r', []),
    ], 'main');
    expect(g.rows.map(r => r.col)).toEqual([1, 0, 1, 0]);
    expect(g.cols).toBe(2);
  });
  test('§10.1 without a base label the first commit takes column 0', () => {
    expect(layoutGraph([c('a', ['b']), c('b', [])], null).rows.map(r => r.col)).toEqual([0, 0]);
  });
  test('§10.1 a parent past the page keeps its line to the bottom', () => {
    const g = layoutGraph([c('a', ['zz'], ['main'])], 'main');
    expect(g.rows[0]!.segs).toEqual([{ col: 0, track: g.rows[0]!.track, part: 'bottom' }]);
  });
  test('§6.1 > 6 lanes: tracks keep their order; the 7th and later lines are --fg-3', () => {
    const heads = Array.from({ length: 8 }, (_, i) => c(`h${i}`, ['r'], [`lane/l${i}`]));
    const g = layoutGraph([...heads, c('r', [], ['main'])], 'main');
    expect(g.rows.slice(0, 8).map(r => r.col)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(g.tracks.map(t => t.ref)).toEqual(['main', ...heads.map(h => h.branches![0]!)]);
    const color = (ref: string | null) => (ref === 'main' ? 'var(--accent)' : `lane:${ref}`);
    const cols = g.tracks.map(t => trackColor(t, color));
    expect(cols[0]).toBe('var(--accent)');
    expect(cols.slice(1, 6)).toEqual(['lane:lane/l0', 'lane:lane/l1', 'lane:lane/l2', 'lane:lane/l3', 'lane:lane/l4']);
    expect(cols.slice(6)).toEqual(['var(--fg-3)', 'var(--fg-3)', 'var(--fg-3)']);
  });
});

describe('§10.1 rail drawing (26 px rows, mockup RX = 7 + 12·col)', () => {
  test('in-curve starts at the top of its column and ends at the dot edge', () => {
    const g = layoutGraph(D15, 'main');
    const p = railPaths(g.rows[4]!);
    expect(p.curves[0]!.d).toBe('M19 0 C19 9 11 13 12 13');
    expect(p.lines).toContainEqual({ x: 7, y1: 0, y2: 26, track: g.rows[4]!.track });
    expect(p.dot).toEqual({ x: 7, y: 13 });
  });
  test('out-curve leaves the dot edge and reaches the bottom of its column', () => {
    const g = layoutGraph([c('m', ['a', 'b'], ['main']), c('b', ['a']), c('a', [])], 'main');
    expect(railPaths(g.rows[0]!).curves[0]!.d).toBe('M12 13 C11 13 19 17 19 26');
  });
});

describe('§10.1 virtualise only past 200 rows', () => {
  test('≤ 200 rows: every row rendered', () => {
    expect(graphWindow(GRAPH_VIRTUAL_AFTER, 0, 300)).toEqual({ start: 0, end: 200, padTop: 0, padBottom: 0 });
  });
  test('> 200 rows: only the visible window (+ overscan)', () => {
    const w = graphWindow(GRAPH_VIRTUAL_AFTER + 1, 26 * 100, 260);
    expect(w.start).toBeGreaterThan(0);
    expect(w.end).toBeLessThan(201);
    expect(w.padTop).toBe(w.start * 26);
    expect(w.padBottom).toBe((201 - w.end) * 26);
  });
});
