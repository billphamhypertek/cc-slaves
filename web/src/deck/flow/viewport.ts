// spec v2.1 §4.9 khung nhìn as pure geometry (no React / DOM): fit with the 0.9 floor (UX-I4), the floating boxes the fit
// must keep clear (§6 "Vật cản khi vừa màn hình"), edge markers ↑ ↓ ← →, "minimap only when the graph does not fit",
// glide-into-view on select, and the 30 s "PO moved the view" quiet window for auto-fit.
// Screen coordinates are relative to the deck frame (the canvas area under the app top bar, right of the left column).

import { H_HEAD } from '../../lib/mono-font.ts';

export interface Rect { x: number; y: number; w: number; h: number }
/** React Flow viewport: screen = flow × zoom + (x, y). */
export interface Vp { x: number; y: number; zoom: number }
export interface Screen { w: number; h: number }

/** §4.9 pinch / ⌘-scroll zoom range; fit never above 1 (never blown up) nor below 0.9 (UX-I4: text ≥ 10 px, targets ≥ 24 px). */
export const ZOOM_MIN = 0.4, ZOOM_MAX = 1.5, FIT_FLOOR = 0.9;
const FIT_MAX = 1;
/** §4.9 auto-fit glide; quiet window after a PO pan / zoom. */
export const FIT_MS = 300, USER_QUIET_MS = 30_000;
/** §4.8 header bar height (v2.4 D53 `--h-head`); §4.9 bottom strip for the edge markers; margin kept around the fitted tree. */
const HEADER_H = H_HEAD, BOTTOM_STRIP = 44, PAD = 16, GAP = 8;
/** UX-M9 N5-p the toast row under the header bar (styles.css `#toasts`: --s4 10 down, ~30 px tall, + 8): the fit keeps nodes below it. */
export const TOAST_BAND = 48;
/** Floating boxes (mockup N4-f): collapsed account card top-right (T7), zoom buttons bottom-left, minimap bottom-right. */
const ACC_CARD = { w: 44, h: 150, right: 12, top: HEADER_H + 14 } as const; // AccountPanel.css .accp.mini top --h-head + --s5 (14, hot fix 2026-11-16)
const ZOOM_BTNS = { w: 30, h: 90, left: 12, bottom: 12 } as const;
const MINIMAP = { w: 160, h: 108, right: 12, bottom: 12 } as const;
/** flow.css `.dm-down`: the ↓ edge marker (28 px tall, 8 px above the frame bottom, centred); w = the widest label it draws
 *  ("↓ 12 waiting on PO 12 broken" ≈ 225 px) plus slack, since its width follows its text. */
const MARK_DOWN = { w: 240, h: 28, bottom: 8 } as const;
/** §6 the farthest "vừa màn hình" nudges a floor-fitted tree down to clear the bottom boxes (≈ 1.5 lane rows at 0.9). */
const MAX_NUDGE = 96;

export type ObstacleId = 'header' | 'account' | 'zoom' | 'minimap' | 'strip';
export function obstacleRects(s: Screen): { id: ObstacleId; rect: Rect }[] {
  return [
    { id: 'header', rect: { x: 0, y: 0, w: s.w, h: HEADER_H } },
    { id: 'account', rect: { x: s.w - ACC_CARD.right - ACC_CARD.w, y: ACC_CARD.top, w: ACC_CARD.w, h: ACC_CARD.h } },
    { id: 'zoom', rect: { x: ZOOM_BTNS.left, y: s.h - ZOOM_BTNS.bottom - ZOOM_BTNS.h, w: ZOOM_BTNS.w, h: ZOOM_BTNS.h } },
    { id: 'minimap', rect: { x: s.w - MINIMAP.right - MINIMAP.w, y: s.h - MINIMAP.bottom - MINIMAP.h, w: MINIMAP.w, h: MINIMAP.h } },
    { id: 'strip', rect: { x: 0, y: s.h - BOTTOM_STRIP, w: s.w, h: BOTTOM_STRIP } },
  ];
}

/** §6 what a node wholly on screen must not sit under once a floor-fitted tree runs past the frame: the header bar, the
 *  account card, the zoom buttons, the minimap (it shows: the tree does not fit) and, when one shows, the ↓ edge marker. */
function floorObstacles(s: Screen, down: boolean): Rect[] {
  const out = obstacleRects(s).filter(o => o.id !== 'strip').map(o => o.rect);
  if (down) out.push({ x: (s.w - MARK_DOWN.w) / 2, y: s.h - MARK_DOWN.bottom - MARK_DOWN.h, w: MARK_DOWN.w, h: MARK_DOWN.h });
  return out;
}

/** Bounding box of the nodes; `extra.w` widens it to the right (N4-b "Chưa có lane…" hint beside the root). */
export function contentBox(nodes: readonly Rect[], extra?: { w: number }): Rect {
  if (!nodes.length) return { x: 0, y: 0, w: extra?.w ?? 0, h: 0 };
  const x0 = Math.min(...nodes.map(n => n.x)), y0 = Math.min(...nodes.map(n => n.y));
  const x1 = Math.max(...nodes.map(n => n.x + n.w)), y1 = Math.max(...nodes.map(n => n.y + n.h));
  return { x: x0, y: y0, w: x1 - x0 + (extra?.w ?? 0), h: y1 - y0 };
}

export const toScreen = (r: Rect, vp: Vp): Rect => ({ x: r.x * vp.zoom + vp.x, y: r.y * vp.zoom + vp.y, w: r.w * vp.zoom, h: r.h * vp.zoom });

/** The part of the frame where a node counts as "seen": below the header bar, above the marker strip. */
const viewArea = (s: Screen): Rect => ({ x: 0, y: HEADER_H, w: s.w, h: s.h - HEADER_H - BOTTOM_STRIP });

type Box = { x0: number; y0: number; x1: number; y1: number };
/** Fit candidates: each corner box is kept clear either by moving the top / bottom edge past it or the left / right edge. */
function candidates(s: Screen): Box[] {
  const o = Object.fromEntries(obstacleRects(s).map(r => [r.id, r.rect])) as Record<ObstacleId, Rect>;
  const base: Box = { x0: PAD, y0: HEADER_H + TOAST_BAND, x1: s.w - PAD, y1: s.h - BOTTOM_STRIP };
  const out: Box[] = [];
  for (const acc of ['v', 'h'] as const) for (const zb of ['v', 'h'] as const) for (const mm of ['v', 'h'] as const) {
    const b = { ...base };
    if (acc === 'v') b.y0 = Math.max(b.y0, o.account.y + o.account.h + GAP); else b.x1 = Math.min(b.x1, o.account.x - GAP);
    if (zb === 'v') b.y1 = Math.min(b.y1, o.zoom.y - GAP); else b.x0 = Math.max(b.x0, o.zoom.x + o.zoom.w + GAP);
    if (mm === 'v') b.y1 = Math.min(b.y1, o.minimap.y - GAP); else b.x1 = Math.min(b.x1, o.minimap.x - GAP);
    if (b.x1 > b.x0 && b.y1 > b.y0) out.push(b);
  }
  return out;
}

/** §4.9 "Vừa màn hình": the largest zoom ≤ 1 that keeps the tree clear of every floating box, never below 0.9. Below the
 *  floor the tree sits at 0.9, top-aligned (the root and the first lanes show), and the rest scrolls. */
export function fitViewport(c: Rect, s: Screen, nodes: readonly Rect[] = [], marked: readonly Marked[] = []): Vp {
  if (c.w <= 0 && c.h <= 0) return { x: s.w / 2, y: s.h / 2, zoom: FIT_MAX };
  const cands = candidates(s);
  if (!cands.length) return { x: PAD - c.x * FIT_FLOOR, y: HEADER_H + TOAST_BAND - c.y * FIT_FLOOR, zoom: FIT_FLOOR };
  const zOf = (b: Box) => Math.min(FIT_MAX, (b.x1 - b.x0) / Math.max(c.w, 1), (b.y1 - b.y0) / Math.max(c.h, 1));
  let best = cands[0]!, bz = zOf(best);
  for (const b of cands) { const z = zOf(b); if (z > bz + 1e-9) { best = b; bz = z; } }
  if (bz >= FIT_FLOOR) {
    return { zoom: bz, x: best.x0 + (best.x1 - best.x0 - c.w * bz) / 2 - c.x * bz, y: best.y0 + (best.y1 - best.y0 - c.h * bz) / 2 - c.y * bz };
  }
  const z = FIT_FLOOR, wide = cands.filter(b => c.w * z <= b.x1 - b.x0);
  const pick = wide.length ? wide.reduce((a, b) => (b.y1 - b.y0 > a.y1 - a.y0 ? b : a)) : cands.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a));
  const room = pick.x1 - pick.x0 - c.w * z;
  return settleFloor({ zoom: z, x: pick.x0 + Math.max(0, room / 2) - c.x * z, y: pick.y0 - c.y * z }, c, nodes, marked, s);
}

/** §6 below the floor the tree runs past the frame, so its lower rows meet the bottom boxes. Keep the top-aligned pan when no
 *  node wholly on screen sits under a box; else take the nearest clean pan: a sideways shift that keeps the tree inside the
 *  margins, and a nudge down (never up: UX-M9 toast band) of at most MAX_NUDGE. Nothing clean → the top-aligned pan. */
function settleFloor(vp: Vp, c: Rect, nodes: readonly Rect[], marked: readonly Marked[], s: Screen): Vp {
  const z = vp.zoom, w = c.w * z, left = c.x * z + vp.x, e = 0.5;
  const o = Object.fromEntries(obstacleRects(s).map(r => [r.id, r.rect])) as Record<ObstacleId, Rect>;
  const lefts = [left, PAD, o.zoom.x + o.zoom.w + GAP, o.minimap.x - GAP - w, s.w - PAD - w]
    .filter((l, i) => i === 0 || (l >= PAD - e && l + w <= s.w - PAD + e)).sort((a, b) => Math.abs(a - left) - Math.abs(b - left));
  const under = (r: Rect, b: Rect) => r.x + e < b.x + b.w && b.x + e < r.x + r.w && r.y + e < b.y + b.h && b.y + e < r.y + r.h;
  const clean = (at: Vp) => {
    const d = edgeMarkers(marked, at, s).down, obs = floorObstacles(s, d.ask + d.broken > 0);
    return nodes.every(n => {
      const r = toScreen(n, at);
      return r.x < -e || r.y < -e || r.x + r.w > s.w + e || r.y + r.h > s.h + e || !obs.some(b => under(r, b)); // cut by the edge: scrolls
    });
  };
  for (let dy = 0; dy <= MAX_NUDGE; dy++) for (const l of lefts) {
    const at = { zoom: z, x: vp.x + l - left, y: vp.y + dy };
    if (clean(at)) return at;
  }
  return vp;
}

/** The whole graph lies inside the seen area at this viewport. */
function fitsInView(c: Rect, vp: Vp, s: Screen): boolean {
  const r = toScreen(c, vp), a = viewArea(s), e = 0.5;
  return r.x >= a.x - e && r.y >= a.y - e && r.x + r.w <= a.x + a.w + e && r.y + r.h <= a.y + a.h + e;
}
/** §4.9 the minimap shows by itself only when the graph does not fit at the current zoom / pan. */
export const minimapVisible = (c: Rect, vp: Vp, s: Screen): boolean => !fitsInView(c, vp, s);

export type Side = 'up' | 'down' | 'left' | 'right';
export interface SideCount { ask: number; broken: number; first: string | null }
export interface Marked { id: string; rect: Rect; kind: 'ask' | 'broken' }
/** §4.9 edge markers: every lane / root that waits on the PO or is broken and lies outside the seen area, counted on the
 *  side it lies past (vertical first; ← → only after a sideways pan). `first` = the first one in tree order. */
export function edgeMarkers(items: readonly Marked[], vp: Vp, s: Screen): Record<Side, SideCount> {
  const out: Record<Side, SideCount> = {
    up: { ask: 0, broken: 0, first: null }, down: { ask: 0, broken: 0, first: null },
    left: { ask: 0, broken: 0, first: null }, right: { ask: 0, broken: 0, first: null },
  };
  const a = viewArea(s);
  for (const it of items) {
    const r = toScreen(it.rect, vp), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const side: Side | null = cy < a.y ? 'up' : cy > a.y + a.h ? 'down' : cx < a.x ? 'left' : cx > a.x + a.w ? 'right' : null;
    if (!side) continue;
    const c = out[side];
    c[it.kind]++;
    c.first ??= it.id;
  }
  return out;
}

/** §4.9 select lane / marker click: move the view only as far as needed so the node sits inside the seen area (with a
 *  margin); a node already in view leaves the viewport untouched. Zoom is kept. */
export function glideInto(node: Rect, vp: Vp, s: Screen): Vp {
  const a = viewArea(s), r = toScreen(node, vp);
  const ax0 = a.x + PAD, ay0 = a.y + PAD, ax1 = a.x + a.w - PAD, ay1 = a.y + a.h - PAD;
  const d = (lo: number, len: number, min: number, max: number) =>
    len > max - min || lo < min ? min - lo : lo + len > max ? max - (lo + len) : 0;
  const dx = d(r.x, r.w, ax0, ax1), dy = d(r.y, r.h, ay0, ay1);
  return dx || dy ? { x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom } : vp;
}

/** §4.9 auto-fit (open / new lane) runs unless the PO panned or zoomed in the last 30 s. */
export const autoFitAllowed = (lastUserMove: number | null, now: number): boolean => lastUserMove === null || now - lastUserMove >= USER_QUIET_MS;

export interface FitSeen { pid: string | null; lanes: ReadonlySet<string>; w: number; h: number }
/** §4.9 auto-fit decision: 'open' = project opened (always fit, PO window reset); 'fit' = a new lane or a frame resize
 *  outside the 30 s PO pan / zoom window; null = leave the view alone. */
export function shouldAutoFit(seen: FitSeen | null, next: FitSeen, lastUserMove: number | null, now: number): 'open' | 'fit' | null {
  if (!seen || seen.pid !== next.pid) return 'open';
  const resized = seen.w !== next.w || seen.h !== next.h, grew = [...next.lanes].some(id => !seen.lanes.has(id));
  return (grew || resized) && autoFitAllowed(lastUserMove, now) ? 'fit' : null;
}
