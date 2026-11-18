// spec v2.1 §4.1 tree layout (pure, no React / DOM; §5.1 "hàm thuần tự viết, không dùng dagre / ELK").
// Columns left → right: orchestrator roots → lanes → subagents. Several live roots are stacked top → bottom (§4.14),
// a collapsed root keeps only some lanes and folds the rest into one row (§4.15 §2), done lanes live on one shelf under
// the first root, in the root column with no wire (§4.15 §3, Rev 18/11 concept B). Output: node boxes, orthogonal wires, the 1–9 key order, separators between trees.
import type { LaneState } from '../../../shared/protocol.ts';
import { CHANGED_MS, FADE_MS } from '../lib/collapse.ts';

/** §4.4 root card, §4.2 lane card, §4.5 sub card; §4.1 spacing. */
export const ORCH_W = 216;
const ORCH_H = 64;
export const LANE_W = 268, LANE_H = 64, LANE_GAP = 10;
export const SUB_W = 150, SUB_H = 30;
const SUB_GAP = 4;
/** The collapsed-tree row in the lane column. */
const ROW_H = 30;
/** §4.15 §3 Xong shelf: width, gap under the root, header / section / row / "older" heights + top and bottom border. */
const SHELF_W = 228, SHELF_GAP = 26, SHELF_HD = 30, SHELF_SEC = 24, SHELF_ROW = 26, SHELF_FT = 28, SHELF_BORDER = 2;
/** §4.1 column gaps (≥ 36 px for the horizontal run of the orthogonal wire). */
const COL_GAP = 56, SUB_COL_GAP = 44;
/** §4.14 gap between two trees; the separator line sits in its middle. */
const TREE_GAP = 40;
/** §4.5 sub nodes per lane before "+n"; §4.15 §3 rows on the open shelf (unmerged + merged). */
const MAX_SUBS = 6, DONE_SHOWN = 6;
/** §4.1 W18: the root is never lower than this lane (1-based). */
const ROOT_CLAMP_LANE = 4;

const LANE_X = ORCH_W + COL_GAP;
const SUB_X = LANE_X + LANE_W + SUB_COL_GAP;

interface LayoutRoot { id: string; collapsed: boolean }
export interface LayoutLane {
  name: string;
  /** owning root id (a live orchestrator session); unknown → the first root. */
  root: string;
  /** creation order (§4.1 W1): lanes sort by it, never by state. */
  order: number;
  state: LaneState; done: boolean; doneAt: number | null;
  /** §4.15 §3 a done lane whose branch is measured unmerged (the shelf's "Chưa merge" section). */
  unmerged: boolean;
  /** last state change / creation time (§4.15 §2 "vừa đổi"); null = unknown. */
  changedAt: number | null;
  /** sub ids in display order (the caller already dropped subs past their 60 s fade). */
  subs: string[]; subsOpen: boolean;
}
export interface LayoutInput {
  /** live orchestrator sessions in tree order (§4.14). */
  roots: LayoutRoot[]; lanes: LayoutLane[];
  selected: string | null; doneOpen: boolean; now: number;
  /** §4.15 §3 every done lane of the project (`done_lanes_list` total; the snapshot only carries 7 days); the engine's
   *  unmerged count (`ProjectView.unmerged`). */
  doneTotal?: number; doneUnmerged?: number;
}

export type NodeKind = 'orchestrator' | 'lane' | 'subagent' | 'more' | 'doneShelf' | 'collapsedRow';
export interface LayoutNode {
  id: string; kind: NodeKind; x: number; y: number; w: number; h: number;
  /** tree the node is drawn in. */
  root: string;
  /** lane name (lane, its subs, its "+n"). */
  lane?: string;
  sub?: string;
  /** "+n" / shelf / collapsed row: how many lanes or subs it stands for (the shelf: every done lane). */
  count?: number;
  /** §4.15 §3 shelf rows (lane names, newest first), the unmerged total and the "n lane xong cũ hơn…" count (0 = no row). */
  shelf?: Shelf;
  /** collapsed row: per-state counts of the folded lanes (only states > 0). */
  counts?: Partial<Record<LaneState, number>>;
}
interface Shelf { unmerged: string[]; merged: string[]; umCount: number; older: number }
export interface Wire { id: string; from: string; to: string; points: [number, number][]; dashed?: boolean }
interface Separator { y: number; x0: number; x1: number }
export interface DeckLayout {
  nodes: LayoutNode[]; wires: Wire[];
  /** §4.11 keys 1–9 / Tab: visible non-done lanes, tree order across every root. */
  keyOrder: string[];
  /** lanes that exist but are folded into a collapsed row. */
  hidden: string[];
  separators: Separator[];
  width: number; height: number;
}

const KEEP_STATES: LaneState[] = ['waiting_po', 'broken'];

/** Orthogonal polyline parent right-centre → shared vertical at `vx` → child left-centre, without repeated points. */
function wirePoints(px: number, py: number, vx: number, cx: number, cy: number): [number, number][] {
  const pts: [number, number][] = [[px, py], [vx, py], [vx, cy], [cx, cy]];
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
}

/** One child block of a root's lane column, laid out at local y = 0. */
interface Block { nodes: LayoutNode[]; wires: Wire[]; top: number; bottom: number; anchor: LayoutNode; dashed?: boolean }

function laneBlock(l: LayoutLane, root: string): Block {
  const laneNode: LayoutNode = { id: `lane:${l.name}`, kind: 'lane', x: LANE_X, y: 0, w: LANE_W, h: LANE_H, root, lane: l.name };
  const nodes: LayoutNode[] = [laneNode], wires: Wire[] = [];
  const subs = l.subsOpen ? l.subs : [];
  if (subs.length) {
    const shown = subs.slice(0, MAX_SUBS), extra = subs.length - shown.length;
    const n = shown.length + (extra > 0 ? 1 : 0), colH = n * SUB_H + (n - 1) * SUB_GAP;
    const lcy = LANE_H / 2, top = lcy - colH / 2, vx = LANE_X + LANE_W + SUB_COL_GAP / 2;
    const add = (node: LayoutNode) => {
      nodes.push(node);
      wires.push({ id: `w:${node.id}`, from: laneNode.id, to: node.id, points: wirePoints(LANE_X + LANE_W, lcy, vx, node.x, node.y + node.h / 2) });
    };
    shown.forEach((s, i) => add({ id: `sub:${l.name}:${s}`, kind: 'subagent', x: SUB_X, y: top + i * (SUB_H + SUB_GAP), w: SUB_W, h: SUB_H, root, lane: l.name, sub: s }));
    if (extra > 0) add({ id: `more:${l.name}`, kind: 'more', x: SUB_X, y: top + shown.length * (SUB_H + SUB_GAP), w: SUB_W, h: SUB_H, root, lane: l.name, count: extra });
  }
  const ys = nodes.flatMap(n => [n.y, n.y + n.h]);
  return { nodes, wires, top: Math.min(...ys), bottom: Math.max(...ys), anchor: laneNode };
}

/** §4.15 §3 the shelf: "Chưa merge" rows always (newest first), merged rows behind the toggle (≤ DONE_SHOWN − unmerged,
 *  newest first), then "n lane xong cũ hơn…" for the rest of the total. */
function shelfOf(done: readonly LayoutLane[], total: number, open: boolean, umTotal: number): { shelf: Shelf; h: number } {
  const newest = [...done].sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || b.order - a.order);
  const unmerged = newest.filter(l => l.unmerged).map(l => l.name);
  const merged = open ? newest.filter(l => !l.unmerged).slice(0, Math.max(0, DONE_SHOWN - unmerged.length)).map(l => l.name) : [];
  const older = open ? Math.max(0, total - unmerged.length - merged.length) : 0;
  const h = SHELF_BORDER + SHELF_HD + (unmerged.length ? SHELF_SEC : 0) + SHELF_SEC + (unmerged.length + merged.length) * SHELF_ROW + (older ? SHELF_FT : 0);
  return { shelf: { unmerged, merged, umCount: Math.max(umTotal, unmerged.length), older }, h };
}
const shift = (b: Block, dy: number) => {
  for (const n of b.nodes) n.y += dy;
  for (const w of b.wires) for (const p of w.points) p[1] += dy;
};

export function layoutDeck(inp: LayoutInput): DeckLayout {
  const nodes: LayoutNode[] = [], wires: Wire[] = [], keyOrder: string[] = [], hidden: string[] = [], separators: Separator[] = [];
  if (!inp.roots.length) return { nodes, wires, keyOrder, hidden, separators, width: 0, height: 0 };
  const rootIds = new Set(inp.roots.map(r => r.id)), first = inp.roots[0]!.id, multi = inp.roots.length > 1;
  const byOrder = [...inp.lanes].sort((a, b) => a.order - b.order);
  const live = byOrder.filter(l => !l.done), done = byOrder.filter(l => l.done);
  const ownerOf = (l: LayoutLane) => (rootIds.has(l.root) ? l.root : first);
  const keep = (l: LayoutLane) =>
    KEEP_STATES.includes(l.state) || l.name === inp.selected || (l.changedAt !== null && inp.now - l.changedAt < CHANGED_MS + FADE_MS);

  let cursor = 0, prevBottom: number | null = null;
  for (const r of inp.roots) {
    const mine = live.filter(l => ownerOf(l) === r.id);
    const collapsed = multi && r.collapsed;
    const shown = collapsed ? mine.filter(keep) : mine, folded = collapsed ? mine.filter(l => !keep(l)) : [];
    const blocks: Block[] = shown.map(l => laneBlock(l, r.id));
    if (folded.length) {
      const counts: Partial<Record<LaneState, number>> = {};
      for (const l of folded) counts[l.state] = (counts[l.state] ?? 0) + 1;
      const row: LayoutNode = { id: `row:${r.id}`, kind: 'collapsedRow', x: LANE_X, y: 0, w: LANE_W, h: ROW_H, root: r.id, count: folded.length, counts };
      blocks.push({ nodes: [row], wires: [], top: 0, bottom: ROW_H, anchor: row, dashed: true });
      hidden.push(...folded.map(l => l.name));
    }
    // stack the blocks: each block's top sits LANE_GAP below the previous block's bottom (§4.1 "lane kế tiếp dịch xuống")
    let y = 0;
    for (const b of blocks) { const dy = y - b.top; shift(b, dy); b.top += dy; b.bottom += dy; y = b.bottom + LANE_GAP; }
    // §4.1 root centred on its lanes (the shelf excluded), W18 never below lane 4
    const span = blocks.map(b => b.anchor);
    let rcy = span.length ? (span[0]!.y + span.at(-1)!.y + span.at(-1)!.h) / 2 : ORCH_H / 2;
    const clamp = span.filter(n => n.kind === 'lane')[ROOT_CLAMP_LANE - 1];
    if (clamp) rcy = Math.min(rcy, clamp.y + clamp.h / 2);
    const rootNode: LayoutNode = { id: `orch:${r.id}`, kind: 'orchestrator', x: 0, y: rcy - ORCH_H / 2, w: ORCH_W, h: ORCH_H, root: r.id };
    const treeNodes = [rootNode, ...blocks.flatMap(b => b.nodes)], vx = ORCH_W + COL_GAP / 2;
    // §4.15 §3 Rev 18/11: the shelf belongs to the project, so it sits in the root column under the first root, no wire
    const doneN = Math.max(done.length, inp.doneTotal ?? 0);
    if (r.id === first && doneN) {
      const { shelf, h } = shelfOf(done, doneN, inp.doneOpen, inp.doneUnmerged ?? 0);
      treeNodes.push({ id: 'done', kind: 'doneShelf', x: 0, y: rootNode.y + ORCH_H + SHELF_GAP, w: SHELF_W, h, root: r.id, count: doneN, shelf });
    }
    const treeWires: Wire[] = [
      ...blocks.map(b => ({
        id: `w:${b.anchor.id}`, from: rootNode.id, to: b.anchor.id,
        points: wirePoints(ORCH_W, rcy, vx, b.anchor.x, b.anchor.y + b.anchor.h / 2), ...(b.dashed ? { dashed: true } : {}),
      })),
      ...blocks.flatMap(b => b.wires),
    ];
    // place the tree below the previous one
    const top = Math.min(...treeNodes.map(n => n.y)), bottom = Math.max(...treeNodes.map(n => n.y + n.h));
    const start = prevBottom === null ? 0 : cursor + TREE_GAP, dy = start - top;
    for (const n of treeNodes) n.y += dy;
    for (const w of treeWires) for (const p of w.points) p[1] += dy;
    if (prevBottom !== null) separators.push({ y: prevBottom + TREE_GAP / 2, x0: 0, x1: 0 });
    nodes.push(...treeNodes);
    wires.push(...treeWires);
    keyOrder.push(...shown.map(l => l.name));
    cursor = bottom + dy;
    prevBottom = cursor;
  }
  const width = Math.max(...nodes.map(n => n.x + n.w));
  for (const s of separators) s.x1 = width;
  return { nodes, wires, keyOrder, hidden, separators, width, height: cursor };
}
