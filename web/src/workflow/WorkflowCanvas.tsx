// spec v2.9 §4.2 / §5.3 the Quy trình canvas (React Flow, the Deck node look §13): the chain left → right ending in Xong, Chung
// and Lane below on dashed edges, labelled edges, the "Thêm bước — kéo thả" palette (HTML drag onto an edge, WF3a), a
// dragged connection checked before it lands (WF3d: refused with the reason), node drag written to `.layout.json`, zoom
// + / − / fit with the % readout, no minimap. Selected = the neutral `--sel` step (workflow.css overrides
// `.react-flow__node.selected`); an error node keeps a fixed 1.5 px red border + ⚠ (a state, not a selection).
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import {
  BaseEdge, EdgeLabelRenderer, getStraightPath, Handle, MarkerType, Position, ReactFlow, useReactFlow, useViewport,
  type Edge, type EdgeProps, type FinalConnectionState, type Node, type NodeChange, type NodeProps, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import type { Tr } from '../../../shared/i18n/core.ts';
import { DONE_ID, MAX_DOCS, type StepType } from '../../../shared/workflows.ts';
import { Icon } from '../ui/icons.tsx';
import {
  connect, connectReason, docCount, dropReason, edgeLabel, enforceLine, hasBuild, insertStep, keyInsertReason, LAYOUT_FILE, layoutOf, DONE_H, NODE_H, NODE_W,
  parseLayout, sizeLine, stepById, stepName, type WfChange, type WfModel, type WfStep, type XY,
} from '../lib/workflow.ts';
import { TypeIcon, WfIcon } from './wf-icons.tsx';

export type Sel = { k: 'step'; id: string } | { k: 'edge'; from: string } | null;

interface StepData extends Record<string, unknown> {
  s: WfStep; name: string; type: string; enforce: string; size: string; err: string | null; chain: boolean; done?: false;
  /** §4.10 the draft canvas: "mới" / "đổi" / "bỏ" tag (grey, no border colour — PO 16/11); `gone` = a removed step drawn struck */
  tag?: string | null; gone?: boolean;
}
interface DoneData extends Record<string, unknown> { done: true; name: string }
interface EdgeData extends Record<string, unknown> { label: string; from: string | null; dashed: boolean }

interface Ctx { tr: Tr; m: WfModel; drag: StepType | null; sel: Sel; locked: boolean; drop(from: string): void; pick(from: string): void }
const WfCtx = createContext<Ctx | null>(null);

const hidden = { opacity: 0 };
const StepNode = memo(({ data }: NodeProps<Node<StepData>>) => {
  const { s, err, chain } = data;
  const ctx = useContext(WfCtx);
  const connectable = !!ctx && !ctx.locked && chain;
  return <div className={`wn${err ? ' err' : ''}${data.gone ? ' gone' : ''}`} title={err ?? undefined} data-step={s.id} data-tag={data.tag ?? undefined}>
    {data.tag ? <span className="wtag">{data.tag}</span> : null}
    {chain ? <Handle type="target" position={Position.Left} id="l" className="hd" isConnectable={connectable} /> : null}
    {s.type === 'lane' ? <Handle type="target" position={Position.Left} id="l" className="hd" style={hidden} isConnectable={false} /> : null}
    {s.type === 'build' ? <Handle type="target" position={Position.Bottom} id="b" className="hd" style={hidden} isConnectable={false} /> : null}
    <div className="g">{err ? <Icon n="alert" /> : <TypeIcon type={s.type} />}</div>
    <div className="b">
      <div className="r1"><span className="nm">{data.name}</span><span className="ty">{data.type}</span></div>
      <div className="sm">{data.enforce}</div>
      <div className="sm z">{data.size}</div>
    </div>
    {chain ? <Handle type="source" position={Position.Right} id="r" className="hd" isConnectable={connectable} /> : null}
    {s.type === 'general' ? <Handle type="source" position={Position.Right} id="r" className="hd" style={hidden} isConnectable={false} /> : null}
    {s.type === 'lane' ? <Handle type="source" position={Position.Top} id="t" className="hd" style={hidden} isConnectable={false} /> : null}
    {s.type === 'lane' ? <Handle type="source" position={Position.Right} id="r" className="hd" style={hidden} isConnectable={false} /> : null}
  </div>;
});
const DoneNode = memo(({ data }: NodeProps<Node<DoneData>>) => {
  const ctx = useContext(WfCtx);
  return <div className="wn end" data-step={DONE_ID}>
    <Handle type="target" position={Position.Left} id="l" className="hd" isConnectable={!!ctx && !ctx.locked} />
    <Icon n="check" s={14} />{data.name}
  </div>;
});

const WfEdge = memo(({ id, sourceX, sourceY, targetX, targetY, data, markerEnd, selected }: EdgeProps<Edge<EdgeData>>) => {
  const ctx = useContext(WfCtx);
  const [over, setOver] = useState(false);
  const [d, lx, ly] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  if (!data || !ctx) return null;
  const from = data.from;
  const droppable = from !== null && ctx.drag !== null && dropReason(ctx.m, ctx.drag, from) === null;
  const on = selected || (from !== null && ctx.sel?.k === 'edge' && ctx.sel.from === from);
  const onOver = (e: DragEvent) => { if (!droppable) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); };
  return <>
    <BaseEdge id={id} path={d} markerEnd={markerEnd} className={data.dashed ? 'wpath dash' : 'wpath'} />
    <EdgeLabelRenderer>
      <div className={`wel nodrag nopan${data.dashed ? ' sm' : ''}${on ? ' on' : ''}${droppable ? ' can' : ''}${over && droppable ? ' drop' : ''}`}
        style={{ transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)` }} data-edge={from ?? id}
        tabIndex={from !== null ? 0 : undefined} role={from !== null ? 'button' : undefined} aria-pressed={from !== null ? on : undefined}
        onKeyDown={e => { if (from !== null && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.pick(from); } }}
        onDragOver={onOver} onDragEnter={onOver} onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); setOver(false); if (droppable && from) ctx.drop(from); }}>
        {over && droppable ? ctx.tr('workflow.edge.dropHere') : data.label}
      </div>
    </EdgeLabelRenderer>
  </>;
});

/** §5.1 declared once, outside any component. */
const nodeTypes = { step: StepNode, done: DoneNode };
const edgeTypes = { wf: WfEdge };
const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--dk-gry)' };

/** Fit leaves room for the palette (top left) when there is one, for a band over the top (offline / broken: it pushes the
 *  palette down 72 px, workflow.css `.wcv.i2.ban .wpal`) and for what covers the canvas on the right (the 360 overlay panel
 *  under 1280, WF13: the chain fits the part still seen). */
type Fit = { maxZoom: number; padding: { top: `${number}px`; right: `${number}px`; bottom: `${number}px`; left: `${number}px` } };
const fitOf = (palette: boolean, band: boolean, cover: number): Fit => ({ maxZoom: 1, padding: { top: `${(palette ? 190 : 60) + (band ? 72 : 0)}px`, right: `${40 + cover}px`, bottom: '60px', left: '40px' } });

/** WF3b the chain changed (a step dropped on an edge, or removed): fit the whole chain again once the new node is measured.
 *  §6.2 the seen part changed (window resized, the overlay panel opened / closed): fit it again — unless the user zoomed or
 *  panned by hand since the last fit. */
function AutoFit({ chain, fit, box, manual }: { chain: string; fit: Fit; box: RefObject<HTMLDivElement | null>; manual: { current: boolean } }): null {
  const rf = useReactFlow();
  const first = useRef(chain);
  const fitRef = useRef(fit);
  useEffect(() => {
    if (first.current === chain) return;
    first.current = chain;
    const t = window.setTimeout(() => void rf.fitView({ ...fit, duration: 200 }), 60);
    return () => window.clearTimeout(t);
  }, [chain, fit, rf]);
  useEffect(() => {
    if (fitRef.current === fit) return;
    fitRef.current = fit;
    if (!manual.current) void rf.fitView({ ...fit, duration: 200 });
  }, [fit, rf, manual]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let size = `${el.clientWidth}x${el.clientHeight}`;
    const ro = new ResizeObserver(() => {
      const now = `${el.clientWidth}x${el.clientHeight}`;
      if (now === size) return;
      size = now;
      if (!manual.current) void rf.fitView(fitRef.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [box, rf, manual]);
  return null;
}

function Zoom({ tr, fit, manual }: { tr: Tr; fit: Fit; manual: { current: boolean } }): ReactElement {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  return <>
    <div className="wzm" role="group" aria-label={tr('workflow.zoom.fit')}>
      <button type="button" aria-label={tr('workflow.zoom.in')} title={tr('workflow.zoom.in')} onClick={() => { manual.current = true; void rf.zoomIn(); }}><Icon n="plus" s={14} /></button>
      <button type="button" aria-label={tr('workflow.zoom.out')} title={tr('workflow.zoom.out')} onClick={() => { manual.current = true; void rf.zoomOut(); }}><WfIcon n="minus" s={14} /></button>
      <button type="button" aria-label={tr('workflow.zoom.fit')} title={tr('workflow.zoom.fit')} onClick={() => { manual.current = false; void rf.fitView(fit); }}><WfIcon n="fit" s={14} /></button>
    </div>
    <span className="wpct">{Math.round(zoom * 100)} %</span>
  </>;
}

/** §4.2 "Thêm bước — kéo thả": the four types with what exists / the limit; general and lane are "đúng 1" (never added). */
function Palette({ tr, m, locked, onDrag, onKey }: { tr: Tr; m: WfModel; locked: boolean; onDrag: (t: StepType | null) => void; onKey: (t: StepType, at: DOMRect) => void }): ReactElement {
  const items: { t: StepType; note: string; can: boolean }[] = [
    { t: 'design', note: tr('workflow.palette.count', { n: docCount(m), max: MAX_DOCS }), can: docCount(m) < MAX_DOCS },
    { t: 'build', note: hasBuild(m) ? tr('workflow.palette.has') : tr('workflow.palette.count', { n: 0, max: 1 }), can: !hasBuild(m) },
    { t: 'general', note: tr('workflow.palette.one'), can: false },
    { t: 'lane', note: tr('workflow.palette.one'), can: false },
  ];
  return <div className={`wpal${locked ? ' off' : ''}`} aria-label={tr('workflow.palette.title')}>
    <h4>{tr('workflow.palette.title')}</h4>
    {items.map(i => {
      const why = locked ? null : i.can ? tr('workflow.palette.dropHint') : tr(dropReason(m, i.t, null) ?? 'workflow.why.onlyOne');
      // M10 Tab reaches a block; Enter inserts it into the selected edge (the keyboard path of T4 / WF3c)
      return <div key={i.t} className={`pi2${i.can && !locked ? '' : ' dis'}`} draggable={i.can && !locked} title={why ?? undefined} data-type={i.t}
        aria-disabled={!i.can || locked || undefined} tabIndex={i.can && !locked ? 0 : undefined} role="button"
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onKey(i.t, e.currentTarget.getBoundingClientRect()); } }}
        onDragStart={e => { e.dataTransfer.setData('text/plain', i.t); e.dataTransfer.effectAllowed = 'copy'; onDrag(i.t); }}
        onDragEnd={() => onDrag(null)}>
        <TypeIcon type={i.t} s={14} />{tr(`workflow.type.${i.t}`)}<small>{i.note}</small>
      </div>;
    })}
  </div>;
}

export interface CanvasProps {
  tr: Tr; m: WfModel; files: Readonly<Record<string, string>>;
  /** built-in (view only) or offline: no drag, no connect, no palette */
  readOnly: boolean; offline: boolean;
  /** px of the canvas covered on the right (the overlay panel under 1280): the fit keeps the chain in the part still seen */
  cover?: number;
  /** a band (offline / broken) over the top of the canvas: the fit keeps the chain under the palette it pushes down */
  band?: boolean;
  /** step id → the first error sentence on it (red node) */
  errs: ReadonlyMap<string, string>;
  sel: Sel; onSel: (s: Sel) => void;
  onChange: (c: WfChange) => void;
  /** a node moved: the whole `.layout.json` text */
  onLayout: (text: string) => void;
  /** §4.10 the draft canvas: step id → tag ("mới" / "đổi"); the steps the draft removed, struck where they stood (not selectable) */
  tags?: ReadonlyMap<string, string>;
  ghosts?: readonly { s: WfStep; at: XY }[];
  children?: ReactNode;
}

function useFlow(p: CanvasProps, at: Record<string, XY>) {
  const { tr, m, errs, sel, tags, ghosts } = p;
  return useMemo(() => {
    const nodes: Node[] = m.steps.map(s => ({
      id: s.id, type: 'step', position: at[s.id] ?? { x: 0, y: 0 }, width: NODE_W, height: NODE_H,
      selected: sel?.k === 'step' && sel.id === s.id,
      data: {
        s, name: stepName(tr, s), type: s.type ? tr(`workflow.type.${s.type}`) : '', enforce: enforceLine(tr, s), size: sizeLine(tr, s),
        err: errs.get(s.id) ?? null, chain: s.type === 'design' || s.type === 'build', tag: tags?.get(s.id) ?? null,
      } satisfies StepData,
    }));
    for (const g of ghosts ?? []) {
      nodes.push({ id: `gone:${g.s.id}`, type: 'step', position: g.at, width: NODE_W, height: NODE_H, selectable: false, draggable: false, connectable: false,
        data: { s: g.s, name: stepName(tr, g.s), type: g.s.type ? tr(`workflow.type.${g.s.type}`) : '', enforce: enforceLine(tr, g.s), size: sizeLine(tr, g.s),
          err: null, chain: false, tag: tr('workflow.author.tagGone'), gone: true } satisfies StepData });
    }
    nodes.push({ id: DONE_ID, type: 'done', position: at[DONE_ID] ?? { x: 0, y: 0 }, width: 84, height: DONE_H, selectable: false, data: { done: true, name: tr('workflow.done') } satisfies DoneData });
    const edges: Edge[] = [];
    for (const id of m.chain) {
      const s = stepById(m, id)!;
      if (!s.next || (s.next.to !== DONE_ID && !stepById(m, s.next.to))) continue;
      edges.push({ id: `e:${id}`, type: 'wf', source: id, sourceHandle: 'r', target: s.next.to, targetHandle: 'l', markerEnd: arrow,
        selected: sel?.k === 'edge' && sel.from === id, data: { label: edgeLabel(tr, s), from: id, dashed: false } satisfies EdgeData });
    }
    const build = m.steps.find(s => s.type === 'build');
    if (m.general && m.lane) edges.push({ id: 'e:general-lane', type: 'wf', source: m.general.id, sourceHandle: 'r', target: m.lane.id, targetHandle: 'l', markerEnd: arrow, selectable: false, data: { label: tr('workflow.edge.generalLane'), from: null, dashed: true } });
    // a pack with no doc steps (Giao thẳng): the lanes' merge is the end, so Xong follows Lane instead of standing alone
    if (m.lane && !m.chain.length) edges.push({ id: 'e:lane-done', type: 'wf', source: m.lane.id, sourceHandle: 'r', target: DONE_ID, targetHandle: 'l', markerEnd: arrow, selectable: false, data: { label: tr('workflow.edge.laneDone'), from: null, dashed: true } });
    if (m.lane && build) edges.push({ id: 'e:lane-build', type: 'wf', source: m.lane.id, sourceHandle: 't', target: build.id, targetHandle: 'b', markerEnd: arrow, selectable: false, data: { label: tr('workflow.edge.laneBuild'), from: null, dashed: true } });
    return { nodes, edges };
  }, [tr, m, errs, sel, at, tags, ghosts]);
}

export function WorkflowCanvas(p: CanvasProps): ReactElement {
  const { tr, m, files, readOnly, offline, onSel, onChange, onLayout } = p;
  const locked = readOnly || offline;
  const layoutText = files[LAYOUT_FILE];
  const base = useMemo(() => layoutOf(m, parseLayout(layoutText)), [m, layoutText]);
  const [at, setAt] = useState(base);
  useEffect(() => setAt(base), [base]);
  const { nodes, edges } = useFlow(p, at);
  const [drag, setDrag] = useState<StepType | null>(null);
  const [why, setWhy] = useState<{ text: string; x: number; y: number } | null>(null);
  const whyT = useRef(0);
  const say = useCallback((text: string, x: number, y: number) => {
    window.clearTimeout(whyT.current);
    setWhy({ text, x, y });
    whyT.current = window.setTimeout(() => setWhy(null), 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(whyT.current), []);
  const box = useRef<HTMLDivElement>(null);
  const local = (x: number, y: number) => { const r = box.current?.getBoundingClientRect(); return { x: x - (r?.left ?? 0), y: y - (r?.top ?? 0) }; };

  const drop = useCallback((from: string | null) => {
    if (!drag || drag === 'general' || drag === 'lane') return;
    setDrag(null);
    onChange(insertStep(tr, m, drag, from));
  }, [drag, m, tr, onChange]);
  const pick = useCallback((from: string) => onSel({ k: 'edge', from }), [onSel]);
  const ctx = useMemo<Ctx>(() => ({ tr, m, drag, sel: p.sel, locked, drop, pick }), [tr, m, drag, p.sel, locked, drop, pick]);
  const keyInsert = (t: StepType, at: DOMRect) => {
    const from = p.sel?.k === 'edge' ? p.sel.from : null;
    const reason = keyInsertReason(m, t, from);
    if (reason || t === 'general' || t === 'lane') { const l = local(at.right, at.top); say(tr(reason ?? 'workflow.why.onlyOne'), l.x, l.y); return; }
    onChange(insertStep(tr, m, t, from));
  };

  const onNodesChange = useCallback((cs: NodeChange[]) => {
    const moved = cs.flatMap(c => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : []));
    if (moved.length) setAt(a => ({ ...a, ...Object.fromEntries(moved) }));
  }, []);
  const atRef = useRef(at);
  atRef.current = at;
  const onDragStop = useCallback(() => { onLayout(`${JSON.stringify(atRef.current, null, 2)}\n`); }, [onLayout]);
  const onConnectEnd = useCallback((e: MouseEvent | TouchEvent, c: FinalConnectionState) => {
    if (!c.fromNode || !c.toNode || c.isValid !== false) return;
    const reason = connectReason(m, c.fromNode.id, c.toNode.id);
    const pt = 'clientX' in e ? e : e.changedTouches[0];
    if (reason && pt) { const l = local(pt.clientX, pt.clientY); say(tr(reason), l.x, l.y); }
  }, [m, tr, say]);
  // a block let go on the canvas, not on an edge: allowed only as the first step of an empty chain, else say why
  // every drag over the canvas is accepted so a refused drop still lands here and says why (WF3d)
  const paneOver = (e: DragEvent) => { if (drag) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  const paneDrop = (e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    const reason = dropReason(m, drag, null);
    if (reason) { const l = local(e.clientX, e.clientY); say(tr(reason), l.x, l.y); setDrag(null); } else drop(null);
  };

  const cover = p.cover ?? 0;
  const band = !!p.band;
  const fit = useMemo(() => fitOf(!readOnly, band, cover), [readOnly, band, cover]);
  const manual = useRef(false);
  /** the viewport when the user's pan / zoom began: a plain click on the background (d3-zoom starts on mousedown) moves nothing */
  const moved = useRef<Viewport | null>(null);
  return <WfCtx.Provider value={ctx}>
    <div ref={box} className={`wvp${drag ? ' dragging' : ''}${locked ? ' locked' : ''}`} onDragOver={paneOver} onDrop={paneDrop}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange}
        onNodeDragStop={onDragStop} nodesDraggable={!locked} nodesConnectable={!locked} elementsSelectable edgesFocusable={false}
        isValidConnection={c => connectReason(m, c.source, c.target) === null}
        onConnect={c => onChange(connect(m, c.source, c.target))} onConnectEnd={onConnectEnd}
        onNodeClick={(_, n) => { if (!n.id.startsWith('gone:')) onSel(n.id === DONE_ID ? null : { k: 'step', id: n.id }); }}
        onEdgeClick={(_, ed) => { const f = (ed.data as EdgeData | undefined)?.from; if (f) onSel({ k: 'edge', from: f }); }}
        onPaneClick={() => onSel(null)} onMoveStart={(e, v) => { moved.current = e ? v : null; }} onMoveEnd={(_, v) => { const a = moved.current; if (a && (a.x !== v.x || a.y !== v.y || a.zoom !== v.zoom)) manual.current = true; }} fitView fitViewOptions={fit} minZoom={0.3} maxZoom={2}
        deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null} proOptions={{ hideAttribution: true }}>
        <Zoom tr={tr} fit={fit} manual={manual} />
        <AutoFit chain={m.chain.join(' ')} fit={fit} box={box} manual={manual} />
      </ReactFlow>
      {readOnly ? null : <Palette tr={tr} m={m} locked={locked} onDrag={setDrag} onKey={keyInsert} />}
      {why ? <div className="wtip" role="status" style={{ left: why.x + 12, top: why.y + 12 }}>{why.text}</div> : null}
      {p.children}
    </div>
  </WfCtx.Provider>;
}

/** The pane label of an edge leaving `from` (also the edge panel title, §4.9 "Đường nối Thiết kế → Plan"). */
export function edgeEnds(tr: Tr, m: WfModel, from: string): { from: string; to: string } | null {
  const s = stepById(m, from);
  if (!s?.next) return null;
  const t = s.next.to === DONE_ID ? null : stepById(m, s.next.to);
  return { from: stepName(tr, s), to: t ? stepName(tr, t) : tr('workflow.done') };
}
