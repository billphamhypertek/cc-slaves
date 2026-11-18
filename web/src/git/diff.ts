// spec v2.3 §6.2 the diff body: a line diff of `{ old, new }` (git_diff sends both texts, "diff tính ở web", §10.2) shown as
// one column with two line-number gutters (old | new): a deleted line has only its old number, an added one only its new one.
// Myers O(ND) on lines after cutting the common head / tail; past MAX_D edits it gives up and shows delete-all + add-all.
import { windowOf, type Win } from '../lib/vhist.ts';

export interface DiffRow { k: 'c' | 'a' | 'd'; a: number | null; b: number | null; t: string }
/** A run of unchanged lines folded away between hunks. */
interface DiffGap { gap: number }
export type DiffItem = DiffRow | DiffGap;

/** Edits Myers walks before giving up (keeps a 2 MB file with a rewrite from freezing the tab). */
const MAX_D = 2000;

const split = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/** The middle part's edit script: 'c' keep, 'd' old only, 'a' new only; null past MAX_D. */
function myers(a: readonly string[], b: readonly string[]): ('c' | 'a' | 'd')[] | null {
  const n = a.length, m = b.length, max = Math.min(n + m, MAX_D), off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, off);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number, off: number): ('c' | 'a' | 'd')[] {
  const ops: ('c' | 'a' | 'd')[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!, k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? k + 1 : k - 1;
    const px = v[off + prevK]!, py = px - prevK;
    while (x > px && y > py) { ops.push('c'); x--; y--; }
    if (d > 0) ops.push(x === px ? 'a' : 'd');
    x = px; y = py;
  }
  return ops.reverse();
}

/** Every line of both sides as rows, in order (an absent side = ''). */
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = split(oldText), b = split(newText);
  let h = 0;
  while (h < a.length && h < b.length && a[h] === b[h]) h++;
  let t = 0;
  while (t < a.length - h && t < b.length - h && a[a.length - 1 - t] === b[b.length - 1 - t]) t++;
  const am = a.slice(h, a.length - t), bm = b.slice(h, b.length - t);
  const ops = myers(am, bm) ?? [...am.map(() => 'd' as const), ...bm.map(() => 'a' as const)];
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  const keep = () => { rows.push({ k: 'c', a: i + 1, b: j + 1, t: a[i]! }); i++; j++; };
  while (i < h) keep();
  for (const op of ops) {
    if (op === 'c') keep();
    else if (op === 'd') { rows.push({ k: 'd', a: i + 1, b: null, t: a[i]! }); i++; } else { rows.push({ k: 'a', a: null, b: j + 1, t: b[j]! }); j++; }
  }
  while (i < a.length) keep();
  return rows;
}

/** §6.2 hunks with `ctx` unchanged lines around each change; a longer unchanged run between two hunks folds into a gap row
 *  (before the first / after the last hunk nothing is drawn: the line numbers say where the hunk sits, mockup G1). */
export function withContext(rows: readonly DiffRow[], ctx = 3): DiffItem[] {
  const near = new Uint8Array(rows.length);
  rows.forEach((r, i) => { if (r.k !== 'c') for (let x = Math.max(0, i - ctx); x <= Math.min(rows.length - 1, i + ctx); x++) near[x] = 1; });
  const out: DiffItem[] = [];
  let gap = 0;
  rows.forEach((r, i) => {
    if (near[i]) { if (gap && out.length) out.push({ gap }); gap = 0; out.push(r); } else gap++;
  });
  return out;
}

/** §6.2 conflict block: the marker lines of one hunk of the trial merge (`<<<<<<<` base side, `=======`, lane side `>>>>>>>`). */
export interface ConflictLine { k: 'm' | 'o' | 't'; t: string }
/** §6.2 at most this many lines per hunk. */
export const HUNK_MAX = 40;
export function conflictLines(merged: string, hunk: { start: number; end: number }): ConflictLine[] {
  const lines = split(merged).slice(hunk.start - 1, hunk.end);
  let side: 'o' | 't' = 'o';
  return lines.slice(0, HUNK_MAX).map(t => {
    if (/^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)( |$)/.test(t)) { if (t.startsWith('=======')) side = 't'; return { k: 'm', t }; }
    return { k: side, t };
  });
}

/** §10.3 (M2) the body draws fixed rows (`.gcl` height); past this many only the rows in view. */
export const DIFF_ROW_PX = 22;
export const DIFF_VIRTUAL_AFTER = 300;
const DIFF_OVERSCAN = 20 * DIFF_ROW_PX;
export function diffWindow(n: number, top: number, view: number): Win {
  if (n <= DIFF_VIRTUAL_AFTER) return { start: 0, end: n, padTop: 0, padBottom: 0 };
  return windowOf(new Array<number>(n).fill(DIFF_ROW_PX), 0, top, view, DIFF_OVERSCAN);
}

/** §5.2 "Lớn": a line over 20 000 chars → no colour (the engine already sends a > 2 MB side as `large`). */
const LONG_LINE = 20_000;
export function canColour(text: string): boolean {
  let from = 0;
  for (;;) {
    const nl = text.indexOf('\n', from);
    if ((nl < 0 ? text.length : nl) - from > LONG_LINE) return false;
    if (nl < 0) return true;
    from = nl + 1;
  }
}

/** One coloured run inside a line: [from, to) offsets of the line, `c` = index in the §5.2 palette. */
export type Seg = readonly [from: number, to: number, c: number];
/** Highlighter ranges of a whole text (in order, not overlapping) → per-line segments; a range over a line end splits. */
export function lineSegs(text: string, ranges: readonly { from: number; to: number; c: number }[]): Seg[][] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const out: Seg[][] = starts.map(() => []);
  let li = 0;
  for (const r of ranges) {
    while (li + 1 < starts.length && starts[li + 1]! <= r.from) li++;
    for (let l = li, from = r.from; l < starts.length && from < r.to; l++, from = starts[l] ?? r.to) {
      const end = l + 1 < starts.length ? starts[l + 1]! - 1 : text.length;
      const to = Math.min(r.to, end);
      if (to > from) out[l]!.push([from - starts[l]!, to - starts[l]!, r.c]);
    }
  }
  return out;
}

/** The colours of a diff row: a deleted line from the old side, an added / kept one from the new side. */
export const segsOf = (r: DiffRow, sides: readonly (readonly Seg[][])[] | undefined): readonly Seg[] | undefined =>
  r.k === 'd' ? sides?.[0]?.[r.a! - 1] : sides?.[1]?.[r.b! - 1];

/** A line cut into plain / coloured pieces (`c` null = plain). */
export function paintSegs(t: string, segs: readonly Seg[] | undefined): { t: string; c: number | null }[] {
  if (!segs?.length) return [{ t, c: null }];
  const out: { t: string; c: number | null }[] = [];
  let at = 0;
  for (const [from, to, c] of segs) {
    if (from > at) out.push({ t: t.slice(at, from), c: null });
    out.push({ t: t.slice(from, to), c });
    at = to;
  }
  if (at < t.length) out.push({ t: t.slice(at), c: null });
  return out;
}
