// spec v2.3 §6.1 "Đồ thị" + §10.1 "Đồ thị": the commit-graph lane layout, stable columns like `git log --graph` (no library).
// Input = the `git_log` order (newest first, topological). Column 0 is kept for the base branch from the top, so a newer lane
// head sits right of it (mockup G5); a lane line starts at its head commit and curves into the base at the merge-base.
import { windowOf, type Win } from '../lib/vhist.ts';

export interface GraphCommit { hash: string; parents: readonly string[]; branches?: readonly string[] }
/** a vertical line in one column: `top` = above the dot, `bottom` = below it, `full` = a column passing the row */
interface Seg { col: number; track: number; part: 'top' | 'bottom' | 'full' }
/** `in`: a line from the top of column `from` into the dot at column `to`; `out`: from the dot at `from` down to column `to` */
interface Curve { from: number; to: number; track: number; dir: 'in' | 'out' }
export interface GraphRow { hash: string; col: number; track: number; segs: Seg[]; curves: Curve[] }
/** one line of the graph, numbered in order of appearance; `ref` = the branch label of the commit that started it */
export interface Track { id: number; ref: string | null }
export interface GraphLayout { rows: GraphRow[]; tracks: Track[]; cols: number }

/** §6.1 at most 6 coloured lines; the 7th and later are `--fg-3`. */
const COLOURED = 6;
export const ROW_PX = 26;
/** §10.1 the graph is virtualised past this many rows. */
export const GRAPH_VIRTUAL_AFTER = 200;

interface Slot { hash: string; track: number }

export function layoutGraph(commits: readonly GraphCommit[], base: string | null): GraphLayout {
  const slots: (Slot | null)[] = [];
  const tracks: Track[] = [];
  const newTrack = (ref: string | null): number => { tracks.push({ id: tracks.length, ref }); return tracks.length - 1; };
  // column 0 waits for the base head while that head is on the page
  let reserved = base !== null && commits.some(c => c.branches?.includes(base));
  const baseTrack = reserved ? newTrack(base) : -1; // the base line is always the first (coloured) track
  const free = (): number => {
    for (let i = reserved ? 1 : 0; i < slots.length; i++) if (!slots[i]) return i;
    return Math.max(slots.length, reserved ? 1 : 0);
  };
  let cols = 0;
  const rows = commits.map((c): GraphRow => {
    const isBase = base !== null && !!c.branches?.includes(base);
    const at = slots.flatMap((s, i) => (s?.hash === c.hash ? [i] : []));
    // the base head takes column 0 even when a lane line already waits for it elsewhere (it then curves in)
    const col = isBase && reserved ? 0 : (at[0] ?? free());
    if (isBase) reserved = false;
    const expected = at.includes(col);
    const track = expected ? slots[col]!.track : isBase && baseTrack >= 0 ? baseTrack : newTrack(c.branches?.[0] ?? null);
    const segs: Seg[] = [], curves: Curve[] = [];
    // columns passing this row (not this commit's, not those ending here)
    slots.forEach((s, i) => { if (s && s.hash !== c.hash) segs.push({ col: i, track: s.track, part: 'full' }); });
    // other children of this commit end here with a curve into the dot
    for (const i of at.filter(i => i !== col)) { curves.push({ from: i, to: col, track: slots[i]!.track, dir: 'in' }); slots[i] = null; }
    const [first, ...more] = c.parents;
    if (first !== undefined) slots[col] = { hash: first, track };
    else slots[col] = null;
    if (expected || first !== undefined) {
      const part = expected && first !== undefined ? 'full' : expected ? 'top' : 'bottom';
      segs.push({ col, track, part });
    }
    for (const p of more) {
      const has = slots.findIndex(s => s?.hash === p);
      if (has >= 0) { curves.push({ from: col, to: has, track: slots[has]!.track, dir: 'out' }); continue; }
      const k = free(), t = newTrack(null);
      slots[k] = { hash: p, track: t };
      curves.push({ from: col, to: k, track: t, dir: 'out' });
    }
    while (slots.length && !slots[slots.length - 1]) slots.pop();
    cols = Math.max(cols, col + 1, slots.length, ...curves.map(v => Math.max(v.from, v.to) + 1));
    segs.sort((a, b) => a.col - b.col);
    return { hash: c.hash, col, track, segs, curves };
  });
  return { rows, tracks, cols };
}

/** §6.1 base `--accent` / lane by its state colour (`color`), tracks past the 6th `--fg-3`. */
export const trackColor = (t: Track, color: (ref: string | null) => string): string => (t.id < COLOURED ? color(t.ref) : 'var(--fg-3)');

/** mockup `RX`: the x of a column in a 26 px row */
const colX = (col: number): number => 7 + col * 12;
/** UX M6: at least two columns, so subjects sit at the same x whether or not a lane line is drawn (G3 / G4 / G10). */
export const railWidth = (cols: number): number => 4 + 12 * Math.max(2, cols);

export interface RailPaths {
  lines: { x: number; y1: number; y2: number; track: number }[];
  curves: { d: string; track: number }[];
  dot: { x: number; y: number };
}
const MID = ROW_PX / 2;
/** The SVG geometry of one row: lines, curves (mockup `rail()`: a curve meets the dot at its edge, 5 px from its centre). */
export function railPaths(r: GraphRow): RailPaths {
  const lines = r.segs.map(s => ({
    x: colX(s.col), y1: s.part === 'bottom' ? MID : 0, y2: s.part === 'top' ? MID : ROW_PX, track: s.track,
  }));
  const curves = r.curves.map(v => {
    const dotCol = v.dir === 'in' ? v.to : v.from, lineCol = v.dir === 'in' ? v.from : v.to;
    const x = colX(lineCol), side = lineCol > dotCol ? 1 : -1;
    const edge = colX(dotCol) + 5 * side, near = colX(dotCol) + 4 * side;
    const d = v.dir === 'in'
      ? `M${x} 0 C${x} 9 ${near} ${MID} ${edge} ${MID}`
      : `M${edge} ${MID} C${near} ${MID} ${x} 17 ${x} ${ROW_PX}`;
    return { d, track: v.track };
  });
  return { lines, curves, dot: { x: colX(r.col), y: MID } };
}

const OVERSCAN = 10 * ROW_PX;
/** §10.1 every row up to 200; past that only the window in view (fixed 26 px rows, the `VirtualHist` window rule). */
export function graphWindow(n: number, top: number, view: number): Win {
  if (n <= GRAPH_VIRTUAL_AFTER) return { start: 0, end: n, padTop: 0, padBottom: 0 };
  return windowOf(Array.from({ length: n }, () => ROW_PX), 0, top, view, OVERSCAN);
}
