// spec v2.3 §5.3 the pure rules of editing: the session lock (③ no live lane whose cwd equals, is inside or contains the
// source root — compared by dir, not by the lane on show; ④ the project dir also needs the orchestrator idle / stopped)
// and the C7 two-column view of a save conflict. The engine checks the lock again with realpath right before the write
// (`lane_running`); the web's check only greys "Sửa" with the reason.
import type { LaneState, LaneView, OrchestratorState } from '../../../shared/protocol.ts';

export type EditLock = { k: 'lane'; lane: string; state: LaneState } | { k: 'orch' };
const DEAD: ReadonlySet<LaneState> = new Set(['done', 'stopped', 'broken']);
const ORCH_FREE: ReadonlySet<OrchestratorState> = new Set(['idle', 'stopped']);
const norm = (p: string) => p.replace(/\/+$/, '') || '/';
const within = (a: string, b: string) => a === b || a.startsWith(b === '/' ? '/' : `${b}/`);

export function editLock(root: string, base: boolean, lanes: readonly Pick<LaneView, 'name' | 'state' | 'cwd'>[],
  orch: readonly { state: OrchestratorState | 'ended' }[]): EditLock | null {
  const r = norm(root);
  for (const l of lanes) {
    if (DEAD.has(l.state)) continue;
    const c = norm(l.cwd);
    if (within(c, r) || within(r, c)) return { k: 'lane', lane: l.name, state: l.state };
  }
  if (base && orch.some(o => o.state !== 'ended' && !ORCH_FREE.has(o.state))) return { k: 'orch' };
  return null;
}

/** One shown line of a side (1-based `no`); `u` = the differing part, widened to whole words. */
export type CfRow = { no: number; text: string; chg: boolean; u: [number, number] | null } | { gap: true };
export interface ConflictView { disk: CfRow[]; mine: CfRow[]; changed: number[] }

const MAX_CELLS = 4_000_000;
/** pairs (i, j) of equal lines in the middle parts, in order (LCS); too large → none */
function lcs(a: readonly string[], b: readonly string[]): [number, number][] {
  if (!a.length || !b.length || a.length * b.length > MAX_CELLS) return [];
  const w = b.length + 1, t = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  }
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++; else j++;
  }
  return out;
}

const isW = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
/** the differing span of `x` against `y` (common head / tail cut), widened to word edges */
function span(x: string, y: string): [number, number] {
  let h = 0;
  while (h < x.length && h < y.length && x[h] === y[h]) h++;
  let t = 0;
  while (t < x.length - h && t < y.length - h && x[x.length - 1 - t] === y[y.length - 1 - t]) t++;
  let s = h, e = x.length - t;
  while (s > 0 && isW(x[s - 1]) && (isW(x[s]) || s === e)) s--;
  while (e < x.length && isW(x[e]) && (isW(x[e - 1]) || s === e)) e++;
  return [s, Math.max(s, e)];
}

/** §5.3 C7: each side shows its changed lines with one line of context (gaps between), the differing part underlined;
 *  `changed` = the changed line numbers of "Của anh" (of the disk side when only lines were removed). */
export function conflictView(disk: string, mine: string): ConflictView {
  const a = disk.split('\n'), b = mine.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const pairs = lcs(a.slice(p, a.length - s), b.slice(p, b.length - s)).map(([i, j]) => [i + p, j + p] as const);
  const chA = new Set<number>(), chB = new Set<number>(), uA = new Map<number, [number, number]>(), uB = new Map<number, [number, number]>();
  let ai = p, bj = p;
  for (const [i, j] of [...pairs, [a.length - s, b.length - s] as const]) {
    const ra: number[] = [], rb: number[] = [];
    for (; ai < i; ai++) { chA.add(ai); ra.push(ai); }
    for (; bj < j; bj++) { chB.add(bj); rb.push(bj); }
    for (let k = 0; k < Math.min(ra.length, rb.length); k++) {
      uA.set(ra[k]!, span(a[ra[k]!]!, b[rb[k]!]!));
      uB.set(rb[k]!, span(b[rb[k]!]!, a[ra[k]!]!));
    }
    ai = i + 1; bj = j + 1;
  }
  const side = (lines: string[], ch: Set<number>, u: Map<number, [number, number]>, other: Set<number>): CfRow[] => {
    // context around this side's changes; a side with none (only the other side added / removed lines) shows where they were
    const show = new Set<number>();
    for (const i of ch.size ? ch : other) for (let d = -1; d <= 1; d++) show.add(i + d);
    const rows: CfRow[] = [];
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!show.has(i)) continue;
      if (i !== last + 1) rows.push({ gap: true });
      rows.push({ no: i + 1, text: lines[i]!, chg: ch.has(i), u: u.get(i) ?? null });
      last = i;
    }
    if (rows.length && last < lines.length - 1) rows.push({ gap: true });
    return rows;
  };
  const changed = [...(chB.size ? chB : chA)].sort((x, y) => x - y).map(i => i + 1);
  return { disk: side(a, chA, uA, chB), mine: side(b, chB, uB, chA), changed };
}
