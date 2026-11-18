// spec v2.1 §4.8 / §4.9 / §4.10 the floating parts of the deck frame, rendered inside <ReactFlow> so they can drive its
// viewport: the offline strip under the header bar (the bar itself is the shell's, v2.3 §4.1), zoom buttons (bottom left), minimap (bottom right, only when the graph
// does not fit), edge markers ↑ ↓ ← →, auto-fit on open / new lane (unless the PO moved in the last 30 s), F = fit,
// select lane → glide into view. Geometry decisions live in viewport.ts (pure, unit-tested).
import { memo, useCallback, useEffect, useMemo, useRef, type MutableRefObject, type ReactElement } from 'react';
import { MiniMap, useReactFlow, useStore, useViewport, type Node } from '@xyflow/react';
import type { Tr } from '../../../../shared/i18n/core.ts';
import { C, type DeckNode, type FlowModel, type LaneData, type OrchData } from './model.ts';
import {
  contentBox, edgeMarkers, fitViewport, FIT_MS, glideInto, minimapVisible, shouldAutoFit, type FitSeen, type Marked, type Rect, type Side, type Vp,
} from './viewport.ts';

/** N4-b "Chưa có lane · nhắn Điều phối…" sits right of the root: the fit keeps room for it. */
const NO_LANES_HINT_W = 330;
const ARROW: Record<Side, string> = { up: '↑', down: '↓', left: '←', right: '→' };

export interface DeckViewportProps {
  nodes: DeckNode[]; screen: 'no_project' | 'no_lanes' | 'deck';
  /** §4.14 the session separator lines (React Flow nodes too): the floor fit keeps them clear of the bottom boxes as well. */
  separators: FlowModel['separators'];
  projectId: string | null; selected: string | null;
  /** bumped by the F key (App) → fit now, whatever the 30 s rule says. */
  fitReq: number;
  /** motion off (reduced / blurred / offline): viewport moves are instant. */
  instant: boolean;
  offline: string | null; tr: Tr;
  /** time of the last PO pan / zoom (DeckView sets it from React Flow onMoveStart with a user event). */
  lastUser: MutableRefObject<number | null>;
}

/** §4.9 minimap colours = the §4.3 state colours. */
function miniColor(n: Node): string {
  const d = n.data as LaneData | OrchData | { kind: string };
  if (d.kind === 'lane') {
    const s = (d as LaneData).state;
    return s === 'running' ? C.run : s === 'waiting_po' ? C.wait : s === 'broken' ? C.err : s === 'waiting_quota' ? C.amb : C.gry;
  }
  if (d.kind === 'orchestrator') { const g = (d as OrchData).glyph; return g === 'root_down' ? C.err : g === 'root_ask' ? C.wait : C.acc; }
  return C.dark;
}

/** §4.9 what an edge marker counts: lanes waiting on the PO / broken, and roots asking the PO / stopped. */
export function markedNodes(nodes: readonly DeckNode[]): Marked[] {
  const out: Marked[] = [];
  for (const n of nodes) {
    const d = n.data, rect = { x: n.x, y: n.y, w: n.w, h: n.h };
    if (d.kind === 'lane' && (d.state === 'waiting_po' || d.state === 'broken')) out.push({ id: n.id, rect, kind: d.state === 'broken' ? 'broken' : 'ask' });
    else if (d.kind === 'orchestrator' && (d.glyph === 'root_ask' || d.glyph === 'root_down')) out.push({ id: n.id, rect, kind: d.glyph === 'root_down' ? 'broken' : 'ask' });
  }
  return out;
}

/** §4.15 §3 "bấm để mở, khung lướt tới": when the shelf's merged rows go hidden → shown, the shelf box (the glide target);
 *  null otherwise. */
export function doneGlideBox(nodes: readonly DeckNode[], wasOpen: boolean, open: boolean): Rect | null {
  if (wasOpen || !open) return null;
  const shelf = nodes.find(n => n.type === 'doneShelf');
  return shelf ? { x: shelf.x, y: shelf.y, w: shelf.w, h: shelf.h } : null;
}
/** §4.9 the node a selection glides to: the lane node, else the shelf when the lane is one of its rows. */
export function selectedBox(nodes: readonly DeckNode[], lane: string): DeckNode | null {
  return nodes.find(x => x.id === `lane:${lane}`)
    ?? nodes.find(x => x.data.kind === 'doneShelf' && [...x.data.unmerged, ...x.data.merged].some(r => r.name === lane)) ?? null;
}

function DeckViewportImpl(p: DeckViewportProps): ReactElement {
  const rf = useReactFlow();
  const vp = useViewport();
  const w = useStore(s => s.width), h = useStore(s => s.height);
  const frame = useMemo(() => ({ w, h }), [w, h]);
  const box = useMemo(() => contentBox(p.nodes, p.screen === 'no_lanes' ? { w: NO_LANES_HINT_W } : undefined), [p.nodes, p.screen]);
  const lastUser = p.lastUser;
  const dur = p.instant ? 0 : FIT_MS;
  const go = useCallback((v: Vp) => { void rf.setViewport(v, { duration: dur }); }, [rf, dur]);
  const marked = useMemo(() => markedNodes(p.nodes), [p.nodes]);
  const drawn = useMemo(() => [...p.nodes, ...p.separators.map(s => ({ x: s.x0, y: s.y, w: s.x1 - s.x0, h: 1 }))], [p.nodes, p.separators]);
  const fitVp = useCallback(() => fitViewport(box, frame, drawn, marked), [box, frame, drawn, marked]);
  const fit = useCallback(() => { if (frame.w > 0 && frame.h > 0) go(fitVp()); }, [go, fitVp, frame]);

  // ---------- §4.9 auto-fit: open (project / frame size), a new lane; never within 30 s of a PO pan / zoom ----------
  const seen = useRef<FitSeen | null>(null);
  useEffect(() => {
    if (frame.w <= 0 || frame.h <= 0 || p.screen === 'no_project') return;
    const next: FitSeen = { pid: p.projectId, lanes: new Set(p.nodes.filter(n => n.type === 'lane').map(n => n.id)), w: frame.w, h: frame.h };
    const act = shouldAutoFit(seen.current, next, lastUser.current, Date.now());
    seen.current = next;
    if (act === 'open') lastUser.current = null;
    if (act) go(fitVp());
  }, [p.nodes, p.projectId, p.screen, frame, fitVp, go, lastUser]);

  // ---------- §4.11 F / "Vừa màn hình" ----------
  const fitSeen = useRef(p.fitReq);
  useEffect(() => { if (p.fitReq !== fitSeen.current) { fitSeen.current = p.fitReq; fit(); } }, [p.fitReq, fit]);

  // ---------- §4.9 select lane (click, 1–9) → glide so the node is in view ----------
  const vpRef = useRef(vp);
  vpRef.current = vp;
  useEffect(() => {
    if (!p.selected || frame.w <= 0) return;
    const n = selectedBox(p.nodes, p.selected);
    if (!n) return;
    const next = glideInto(n, vpRef.current, frame);
    if (next !== vpRef.current) go(next);
  }, [p.selected]); // eslint-disable-line react-hooks/exhaustive-deps -- glide on a new selection only

  // ---------- §4.15 §3 shelf merged rows shown → glide to it (a PO click: the 30 s quiet window does not apply) ----------
  const doneOpen = p.nodes.some(n => n.data.kind === 'doneShelf' && n.data.open);
  const doneSeen = useRef(doneOpen);
  useEffect(() => {
    const box = frame.w > 0 ? doneGlideBox(p.nodes, doneSeen.current, doneOpen) : null;
    doneSeen.current = doneOpen;
    if (box) { const next = glideInto(box, vpRef.current, frame); if (next !== vpRef.current) go(next); }
  }, [doneOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- glide on the closed → open edge only

  // a PO pan / zoom (drag, wheel, pinch via DeckView onMoveStart; the +/− buttons, the minimap here) starts the 30 s quiet window
  const onUser = useCallback(() => { lastUser.current = Date.now(); }, [lastUser]);

  const marks = useMemo(() => edgeMarkers(marked, vp, frame), [marked, vp, frame]);
  const glideTo = (id: string | null) => {
    const n = id ? p.nodes.find(x => x.id === id) : null;
    if (n) go(glideInto(n, vp, frame));
  };
  const showMini = p.screen !== 'no_project' && frame.w > 0 && minimapVisible(box, vp, frame);
  const tr = p.tr;

  return (
    <>
      {p.offline ? <div className="cband" role="status">{p.offline}</div> : null}
      <div className="dzoom" role="group" aria-label={tr('deck.view.aria')}>
        <button type="button" className="zb" aria-label={tr('deck.view.zoomIn')} title={tr('deck.view.zoomIn')} onClick={() => { onUser(); void rf.zoomIn({ duration: dur ? 200 : 0 }); }}>+</button>
        <button type="button" className="zb" aria-label={tr('deck.view.zoomOut')} title={tr('deck.view.zoomOut')} onClick={() => { onUser(); void rf.zoomOut({ duration: dur ? 200 : 0 }); }}>−</button>
        <button type="button" className="zb fit" aria-label={tr('deck.view.fit')} title={tr('deck.view.fit')} onClick={fit}>⛶</button>
      </div>
      {showMini ? <MiniMap className="dmini" pannable nodeColor={miniColor} nodeStrokeWidth={0} maskColor="var(--dk-mini-mask)" bgColor="var(--dk-mini-bg)"
        ariaLabel={tr('deck.view.minimap')} onClick={(_e, pos) => { onUser(); void rf.setCenter(pos.x, pos.y, { zoom: vp.zoom, duration: dur }); }} /> : null}
      {(Object.keys(marks) as Side[]).map(side => {
        const m = marks[side];
        if (!m.ask && !m.broken) return null;
        const text = [m.ask ? tr('deck.mark.ask', { n: m.ask }) : null, m.broken ? tr('deck.mark.broken', { n: m.broken }) : null].filter(Boolean).join(' · ');
        return (
          <button key={side} type="button" className={`dmark dm-${side}`} aria-label={tr('deck.mark.go', { text })} title={tr('deck.mark.go', { text })} onClick={() => glideTo(m.first)}>
            <i aria-hidden="true">{ARROW[side]}</i>
            {m.ask ? <span className="ma">{tr('deck.mark.ask', { n: m.ask })}</span> : null}
            {m.broken ? <span className="mb">{tr('deck.mark.broken', { n: m.broken })}</span> : null}
          </button>
        );
      })}
    </>
  );
}
export const DeckViewport = memo(DeckViewportImpl);
