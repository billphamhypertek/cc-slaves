// v2.1 deck view (spec §4, §5.1, §5.2): store → buildFlow (pure) → React Flow. Owns what the pure model cannot read:
// the token ring for sparklines, the "turn ended" bursts, the move guard (§4.12), the motion gate (motion.ts, the single
// gate: blur / hidden / idle / nothing running / battery / reduced (macOS + config) / F9 overlay / offline), tooltips
// placed clear of the HUD (v1.1 fx3), and the node click → DeckIntent mapping (§4.11).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { ReactFlow, ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { displayTokens, ZERO_TOKENS, type SubagentView } from '../../../shared/protocol.ts';
import type { Store } from '../lib/store.ts';
import { fmtHm } from '../lib/format.ts';
import { placeTip, tipSize, TIP_STEP, type Rect } from './model.ts';
import type { DeckIntent } from './actions.ts';
import { deckAnimated, deckClass, useMotion } from './motion.ts';
import { buildFlow, nextSubExpiry } from './flow/model.ts';
import { DeckCtx, nodeTypes, type DeckCtxValue } from './flow/nodes.tsx';
import { edgeTypes } from './flow/WireEdge.tsx';
import { SparkRing, SPARK_REDRAW_MS } from './flow/spark.ts';
import { menuAllowed, MoveGuard } from './flow/guard.ts';
import { keepStable } from './flow/stable.ts';
import { useT } from '../lib/i18n.tsx';
import { DeckViewport } from './flow/DeckViewport.tsx';
import { sessionsOf } from '../lib/sessions.ts';
import { nextChangeTick } from '../lib/collapse.ts';
import { bodyFont, fontPx } from '../lib/mono-font.ts';
import { ZOOM_MAX, ZOOM_MIN } from './flow/viewport.ts';
import './flow/flow.css';
import { AccountPanel, type AccountPanelProps } from './AccountPanel.tsx';
import { accCardShown, laneHoverClass } from './accounts.ts';

/** HUD boxes a tooltip must not cover (v1.1 fx3 "avoid HUD"). */
export const HUD_SELECTORS = ['#top', '#left', '#listview', '.accp.open'] as const;
type Boxed = { getBoundingClientRect(): { x: number; y: number; width: number; height: number } };
/** Rects of the HUD boxes that are on screen; a closed / hidden box (0 × 0) is not an obstacle. */
export function hudRects(get: (sel: string) => Boxed | null): Rect[] {
  const out: Rect[] = [];
  for (const s of HUD_SELECTORS) {
    const r = get(s)?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
  }
  return out;
}

export interface DeckViewProps {
  store: Store; projectId: string | null; selected: string | null; selectedSub?: string | null;
  /** §4.14 the root of the session Đang xem shows (bright); null = an ended session is viewed (no root bright). */
  viewed?: string | null;
  /** §4.11: every click / Enter on the deck, already mapped (actions.ts). */
  onIntent: (i: DeckIntent) => void;
  /** §4.11 keys 1–9: the deck key order, sent whenever it changes; §4.15 §2 the lanes folded into collapsed rows. */
  onKeys?: (keys: string[], hidden: string[]) => void;
  /** §4.12 the "⋯" menu of a node (React Flow id) at the opener's rect (already move-guarded). */
  onMenu?: (nodeId: string, anchor: Element) => void;
  /** v1 U12 Cài đặt "Giảm chuyển động" (config.reducedMotion). */
  reducedSetting?: boolean;
  /** extra pause from the host (F9 covers the deck). */
  paused?: boolean;
  /** v2.1 §4.11 F: bumped by the App → fit to screen. */
  fitReq?: number;
  /** v2.1 §4.7 the account panel (lives in this lazy chunk): drawn in an overlay layer over the deck area, never resizes the canvas. */
  accPanel?: Omit<AccountPanelProps, 'snap' | 'projectId' | 'now' | 'offline'>;
  /** v2.1 §4.7 hover both ways: a hovered account row lights its lanes (others dim .5); a hovered lane reports its account. */
  hoverAccount?: string | null;
  onLaneHover?: (account: string | null) => void;
}

type Tip = { lines: string[]; x: number; y: number };
declare global { interface Window { __ccDeck?: { paused: boolean; why: string[]; running(): number } } }
const BURST_MS = 2200;

/** no canvas: an average Be Vietnam Pro glyph ≈ 0.55 em */
const TIP_EM = 0.55;
function tipMeasure(): (t: string) => number {
  const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext?.('2d') : null;
  const font = bodyFont(TIP_STEP, 500); // flow.css .dtip `font:500 var(--xs)/1.5`
  if (!ctx) return t => t.length * fontPx(font) * TIP_EM;
  ctx.font = font;
  return t => ctx.measureText(t).width;
}

/** v2.8 §7.1 React Flow gets the computed theme (`data-theme` on <html>), never 'system', so it and the app cannot disagree. */
const themeNow = (): 'light' | 'dark' => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
function onThemeAttr(cb: () => void): () => void {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => o.disconnect();
}

export function DeckView(p: DeckViewProps): ReactElement {
  const colorMode = useSyncExternalStore(onThemeAttr, themeNow, () => 'dark' as const);
  const st = useSyncExternalStore(p.store.subscribe, p.store.shell); // no stream slices: a reveal frame never redraws the Deck (C3)
  const tr = useT(), pid = p.projectId;
  const subagents = useMemo(() => {
    const out: Record<string, number | SubagentView[]> = {}, pre = `l:${pid}:`;
    for (const [k, v] of Object.entries(st.subagents)) if (k.startsWith(pre)) out[k.slice(pre.length)] = v;
    return out;
  }, [st.subagents, pid]);
  const connected = st.conn.status === 'open' || !st.snap;
  const lanes = useMemo(() => (st.snap?.lanes ?? []).filter(l => l.projectId === pid), [st.snap?.lanes, pid]);
  const os = st.snap ? sessionsOf(st.snap, pid) : [], orch = os[0] ?? null;

  // ---------- §5.2 motion gate (any running session animates, §4.14) ----------
  const motion = useMotion({ animated: deckAnimated(lanes.map(l => l.state), (os.find(o => deckAnimated([], o.state)) ?? orch)?.state ?? null), reducedSetting: !!p.reducedSetting, connected });
  const paused = !!p.paused || motion.paused, live = !paused;
  const still = !!p.paused || motion.still; // §6: F9 list (host pause) stills the HUD loops too
  useEffect(() => { document.documentElement.classList.toggle('still', still); }, [still]); // v1 §8.4 HUD loops
  useEffect(() => () => document.documentElement.classList.remove('still'), []);
  useEffect(() => {
    window.__ccDeck = { paused, why: motion.why, running: () => document.getAnimations().filter(a => a.playState === 'running').length };
  }, [paused, motion.why]);
  useEffect(() => () => { delete window.__ccDeck; }, []);

  // ---------- clock: sparkline redraw ≤ 1 / 10 s (§5.2), the 60 s sub rule (§4.5) ----------
  const [now, setNow] = useState(() => Date.now());
  // §5.2 "để yên": tick only while live; paused → one timer for the next completed sub leaving (§4.5 60 s rule).
  useEffect(() => {
    if (!live) return;
    setNow(Date.now()); // catch up on resume
    const t = setInterval(() => setNow(Date.now()), SPARK_REDRAW_MS);
    return () => clearInterval(t);
  }, [live]);
  useEffect(() => {
    if (live) return;
    const at = nextSubExpiry(subagents, Date.now());
    if (at === null) return;
    const t = setTimeout(() => setNow(Date.now()), at - Date.now());
    return () => clearTimeout(t);
  }, [live, subagents, now]);

  // ---------- §4.2 token ring + §4.6 one-shot "turn ended" bursts ----------
  const ring = useRef(new SparkRing()), prevStates = useRef(new Map<string, string>());
  const [bursts, setBursts] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const t = Date.now(), ended: string[] = [];
    for (const l of lanes) {
      ring.current.push(`${pid}:${l.name}`, t, displayTokens(l.tokens ?? ZERO_TOKENS));
      const was = prevStates.current.get(l.name);
      if (was === 'running' && (l.state === 'idle' || l.state === 'waiting_po' || l.state === 'done')) ended.push(l.name);
    }
    prevStates.current = new Map(lanes.map(l => [l.name, l.state]));
    if (!ended.length) return;
    setBursts(new Set(ended));
    const h = setTimeout(() => setBursts(new Set()), BURST_MS);
    return () => clearTimeout(h);
  }, [lanes, pid]);

  const closedSubs = useMemo(() => {
    const pre = `${pid}:`, out = new Set<string>();
    for (const k of st.deckUi.closedSubs) if (k.startsWith(pre)) out.add(k.slice(pre.length));
    return out;
  }, [st.deckUi.closedSubs, pid]);
  const doneOpen = !!(pid && st.deckUi.doneOpen[pid]);
  // §4.15 §2 collapsed trees of this project, the "vừa đổi" clock by lane name (one wake-up per label end / fade end)
  const collapsed = useMemo(() => new Set(pid ? st.deckUi.collapsed[pid] ?? [] : []), [st.deckUi.collapsed, pid]);
  const changedAt = useMemo(() => {
    const out: Record<string, number> = {}, pre = `${pid}:`;
    for (const [k, v] of Object.entries(st.deckUi.changedAt)) if (k.startsWith(pre)) out[k.slice(pre.length)] = v;
    return out;
  }, [st.deckUi.changedAt, pid]);
  useEffect(() => {
    const at = nextChangeTick(changedAt, Date.now());
    if (at === null) return;
    const t = setTimeout(() => setNow(Date.now()), at - Date.now() + 1);
    return () => clearTimeout(t);
  }, [changedAt, now]);
  const doneTotal = pid ? st.deckUi.doneTotal[pid] : undefined;
  const m = useMemo(() => buildFlow({
    snap: st.snap, projectId: pid, subagents, selected: p.selected, selectedSub: p.selectedSub ?? null, now, tr, live,
    closedSubs, doneOpen, bursts, spark: lane => ring.current.series(`${pid}:${lane}`, now), ...(p.viewed !== undefined ? { viewed: p.viewed } : {}),
    collapsed, changedAt, ...(doneTotal !== undefined ? { doneTotal } : {}),
  }), [st.snap, pid, subagents, p.selected, p.selectedSub, now, tr, live, closedSubs, doneOpen, bursts, p.viewed, collapsed, changedAt, doneTotal]);

  // ---------- §4.12 move guard ----------
  const guard = useRef(new MoveGuard());
  useEffect(() => { guard.current.update(m.nodes, Date.now()); }, [m.nodes]);

  const cbs = useRef(p);
  cbs.current = p;
  const keySig = `${m.keyOrder.join('\n')}|${m.hidden.join('\n')}`;
  useEffect(() => { cbs.current.onKeys?.(m.keyOrder, m.hidden); }, [keySig]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- tooltip (v1.1 §4.4, fx3: clear of the HUD, inside the window) ----------
  const [tip, setTip] = useState<Tip | null>(null);
  const measure = useMemo(() => tipMeasure(), []);
  const tipBox = tip ? (() => {
    const size = tipSize(tip.lines, measure);
    const [left, top] = placeTip(tip.x, tip.y, size, hudRects(s => document.querySelector(s)), { w: window.innerWidth, h: window.innerHeight });
    return { left, top };
  })() : null;

  const ctx = useMemo<DeckCtxValue>(() => ({
    tr, live,
    act: (i, node) => { if (guard.current.allow(node, Date.now())) cbs.current.onIntent(i); },
    menu: (node, anchor, via) => { if (menuAllowed(guard.current, node, Date.now(), via)) { setTip(null); cbs.current.onMenu?.(node, anchor); } },
    toggleSubs: lane => { if (cbs.current.projectId) p.store.toggleSubs(cbs.current.projectId, lane); },
    toggleDone: () => { if (cbs.current.projectId) p.store.toggleDone(cbs.current.projectId); },
    tip: (lines, at) => setTip(lines ? { lines, x: at?.x ?? 0, y: at?.y ?? 0 } : null),
    hover: name => cbs.current.onLaneHover?.(name === null ? null : laneAcc.current.get(name) ?? null),
  }), [tr, live, p.store]);

  const laneAcc = useRef(new Map<string, string | null>());
  laneAcc.current = new Map(lanes.map(l => [l.name, l.account]));
  // §4.7 inverse hover (v1.1 §4.5): the hovered row's lanes light their border, every other lane dims to .5
  const hov = p.hoverAccount ?? null;
  // hf1117-p2: `measured` + the previous object for an unchanged node keep React Flow's handle bounds, so wires stay mounted
  const prevNodes = useRef<Node[]>([]);
  const rfNodes = useMemo<Node[]>(() => {
    prevNodes.current = keepStable(prevNodes.current, m.nodes.map<Node>(n => ({
      id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: n.data, width: n.w, height: n.h, measured: { width: n.w, height: n.h },
      draggable: false, selectable: false, connectable: false,
      ...(hov && n.type === 'lane' ? { className: laneHoverClass(laneAcc.current.get((n.data as { name: string }).name) ?? null, hov) } : {}),
    })).concat(m.separators.map((s, i) => ({ id: `sep:${i}`, type: 'sep', position: { x: s.x0, y: s.y }, data: {}, width: s.x1 - s.x0, height: 1,
      measured: { width: s.x1 - s.x0, height: 1 }, draggable: false, selectable: false, connectable: false, focusable: false }))));
    return prevNodes.current;
  }, [m.nodes, m.separators, hov]);
  // §4.6 / v2.8 N2 the shared trunk is grey on every wire (WireEdge), so no wire needs to be drawn over another
  const rfEdges = useMemo<Edge[]>(() => m.edges.map(e => ({ id: e.id, source: e.source, target: e.target, type: 'wire', data: e.data, selectable: false, focusable: false })), [m.edges]);
  const onAdd = useCallback(() => cbs.current.onIntent({ t: 'add_project' }), []);
  // §4.8 header bar; §4.9 a PO pan / zoom (user event, not our own setViewport) starts the 30 s auto-fit quiet window
  const lastUser = useRef<number | null>(null);
  const onMoveStart = useCallback((e: MouseEvent | TouchEvent | null) => { if (e) lastUser.current = Date.now(); }, []);
  const offline = connected ? null : st.dataAt === null ? tr('deck.offline') : tr('deck.offlineAt', { hm: fmtHm(st.dataAt) });

  // §4.11 Tab order: nodes → account card / panel → viewport buttons, so inside the deck the panel is a React Flow child
  // ahead of DeckViewport (a sibling of the pane: its wheel / drag never pans the graph)
  const panel = p.accPanel && st.snap && accCardShown(orch?.state ?? null) ? <div className="dover"><AccountPanel snap={st.snap} projectId={pid} now={now} offline={!connected} {...p.accPanel} /></div> : null;
  const cls = deckClass(motion, connected, paused);
  return (
    <div id="map" className={cls} aria-label={tr('deck.aria')}>
      {m.screen === 'no_project' ? (
        <div className="cstate"><b>{tr('deck.noProject')}</b><button type="button" className="nb" onClick={onAdd}>{tr('deck.addProject')}</button></div>
      ) : (
        <div className="dframe">
          <ReactFlowProvider>
            <DeckCtx.Provider value={ctx}>
              {/* §4.9 drag the background to pan, pinch / ⌘-scroll to zoom 0.4–1.5 (plain scroll pans), no node drag */}
              <ReactFlow nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
                nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
                zoomOnDoubleClick={false} minZoom={ZOOM_MIN} maxZoom={ZOOM_MAX} panOnDrag panOnScroll zoomOnScroll={false} zoomOnPinch
                zoomActivationKeyCode="Meta" onMoveStart={onMoveStart} proOptions={{ hideAttribution: true }} colorMode={colorMode}>
                {panel}
                <DeckViewport nodes={m.nodes} separators={m.separators} screen={m.screen} projectId={pid} selected={p.selected} fitReq={p.fitReq ?? 0}
                  instant={motion.transition === 'none' || motion.reduced} offline={offline} tr={tr} lastUser={lastUser} />
              </ReactFlow>
            </DeckCtx.Provider>
          </ReactFlowProvider>
        </div>
      )}
      {m.screen === 'no_project' ? panel : null}
      {m.screen === 'no_project' && offline ? <div className="cband nop" role="status">{offline}</div> : null}
      {tip && tipBox ? <div className="dtip" role="tooltip" style={{ left: `${tipBox.left.toFixed(1)}px`, top: `${tipBox.top.toFixed(1)}px` }}>
        {tip.lines.map((t, i) => <div key={i}>{t}</div>)}
      </div> : null}
    </div>
  );
}
