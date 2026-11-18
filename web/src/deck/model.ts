// v2.1 deck model helpers (spec §5.1 "giữ phần trạng thái / chọn / chú thích"): the tree layout input, talkingTo and the
// v1.1 §4.4 tooltip placement (avoid the HUD). No geometry of the old isometric deck. No React, no DOM.
import type { OrchestratorView, Snapshot, SubagentView } from '../../../shared/protocol.ts';
import { rootOf, sessionsOf } from '../lib/sessions.ts';
import { bodyFont, fontPx } from '../lib/mono-font.ts';
import type { LayoutInput } from './layout.ts';

export type Pt = [number, number];
export interface Rect { x: number; y: number; w: number; h: number }

/** v1.1 §5.2 `OrchestratorView.talkingTo`: the lane the orchestrator last called an MCP tool about. */
export const talkingTo = (o: OrchestratorView | null | undefined): string | null => o?.talkingTo ?? null;

/** v2.1 §5.1: what the tree layout needs from the snapshot + UI state (no geometry here). */
export interface TreeState {
  subagents: Record<string, number | SubagentView[]>; selected: string | null; now: number;
  /** §4.5 lanes whose sub branch the PO closed (default open, remembered in the session). */
  closedSubs?: ReadonlySet<string>;
  /** §4.15 §2 collapsed root ids; §4.15 §3 shelf open (merged rows shown); §4.15 §2 last state change per lane. */
  collapsed?: ReadonlySet<string>; doneOpen?: boolean; changedAt?: Readonly<Record<string, number>>;
  /** §4.15 §3 every done lane of the project (`done_lanes_list` total). */
  doneTotal?: number;
}
/** v2.1 §4.14: one root per running orchestrator session in open / resume order (root id = session id; pre-v2.1 views
 *  without one = the project id), each lane under its owner session; lanes in snapshot order = creation order (§4.1 W1). */
export function deckTreeInput(snap: Snapshot | null, projectId: string | null, st: TreeState): LayoutInput {
  const p = snap && projectId ? snap.projects.find(x => x.id === projectId) ?? null : null;
  const base = { selected: st.selected, now: st.now, doneOpen: st.doneOpen ?? false, ...(st.doneTotal !== undefined ? { doneTotal: st.doneTotal } : {}),
    ...(p?.unmerged !== undefined ? { doneUnmerged: p.unmerged } : {}) };
  if (!p) return { roots: [], lanes: [], ...base };
  const subIds = (v: number | SubagentView[] | undefined) => (Array.isArray(v) ? v.map(s => s.taskId) : Array.from({ length: v ?? 0 }, (_, i) => `n${i}`));
  const os = sessionsOf(snap!, p.id), ids = os.length ? os.map(rootOf) : [p.id];
  return {
    roots: ids.map(id => ({ id, collapsed: st.collapsed?.has(id) ?? false })),
    lanes: snap!.lanes.filter(l => l.projectId === p.id).map((l, i) => ({
      name: l.name, root: l.ownerSession ?? ids[0]!, order: i, state: l.state, done: l.state === 'done', doneAt: l.state === 'done' ? l.updatedAt : null, unmerged: l.branch?.state === 'unmerged',
      changedAt: st.changedAt?.[l.name] ?? null, subs: subIds(st.subagents[l.name]), subsOpen: !(st.closedSubs?.has(l.name) ?? false),
    })),
    ...base,
  };
}

/** §4.4 tooltip box: real text widths, capped at TIP_MAX_W (322 incl. padding + border); longer lines wrap at spaces. */
export const TIP_MAX_W = 320;
/** .dtip box (flow.css): `var(--xs)/1.5` text, padding var(--s3) var(--s4) (7 / 10 px since hot fix 2026-11-16), 1 px border. */
const TIP_PAD = 22, TIP_VPAD = 16;
/** the `.dtip` text step: DeckView measures in it, the line is 1.5 × its px */
export const TIP_STEP = 'xs';
const tipLine = (): number => 1.5 * fontPx(bodyFont(TIP_STEP));
export function tipSize(lines: readonly string[], measure: (t: string) => number): { w: number; h: number } {
  const inner = TIP_MAX_W - TIP_PAD;
  let w = 0, rows = 0;
  for (const line of lines) {
    const lw = measure(line);
    if (lw <= inner) { w = Math.max(w, lw); rows++; continue; }
    w = inner;
    let cur = '';
    for (const word of line.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && measure(next) > inner) { rows++; cur = word; } else cur = next;
    }
    rows++;
  }
  return { w: Math.ceil(w) + TIP_PAD, h: rows * tipLine() + TIP_VPAD };
}

/** §4.4 tooltip: below-right of the pointer, else left / above, never over a card / HUD box (obstacles) or outside the
 *  window. None of those free → the free spot nearest the pointer whose edge touches an obstacle or the window (e.g. the
 *  gap between the 1024 drawer and the open account panel, T12a). Still none → the candidate clamped inside the window
 *  with the least obstacle overlap. */
export function placeTip(x: number, y: number, size: { w: number; h: number }, obstacles: Rect[], viewport: { w: number; h: number }): Pt {
  const { w, h } = size, C: Pt[] = [[x + 14, y + 16], [x - w - 14, y + 16], [x + 14, y - h - 12], [x - w - 14, y - h - 12]];
  const over = ([l, t]: Pt) => obstacles.reduce((s, r) => s + Math.max(0, Math.min(l + w, r.x + r.w) - Math.max(l, r.x)) * Math.max(0, Math.min(t + h, r.y + r.h) - Math.max(t, r.y)), 0);
  const inside = ([l, t]: Pt) => l >= 4 && t >= 4 && l + w <= viewport.w - 4 && t + h <= viewport.h - 4;
  const clamp = ([l, t]: Pt): Pt => [Math.max(4, Math.min(l, viewport.w - w - 4)), Math.max(4, Math.min(t, viewport.h - h - 4))];
  const free = C.find(c => inside(c) && over(c) === 0);
  if (free) return free;
  const xs = [x + 14, x - w - 14, 4, viewport.w - w - 4, ...obstacles.flatMap(r => [r.x + r.w + 4, r.x - w - 4])];
  const ys = [y + 16, y - h - 12, 4, viewport.h - h - 4, ...obstacles.flatMap(r => [r.y + r.h + 4, r.y - h - 4])];
  const dist = ([l, t]: Pt) => Math.hypot(Math.max(l - x, 0, x - (l + w)), Math.max(t - y, 0, y - (t + h)));
  const gap = xs.flatMap(l => ys.map((t): Pt => [l, t])).filter(c => inside(c) && over(c) === 0).sort((a, b) => dist(a) - dist(b))[0];
  if (gap) return gap;
  const K = C.map(clamp);
  return K.reduce((b, c) => (over(c) < over(b) ? c : b), K[0]!);
}
