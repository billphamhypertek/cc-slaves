// v2.1 React Flow nodes (spec §4.2 lane, §4.4 orchestrator, §4.5 subagent / "+n", §4.15 §3 Xong shelf, §4.15 collapsed row).
// Each node is a `role=group` with one full-size select button underneath and separate inner buttons on top (no nested
// buttons, §4.2). Cards are presentational (render without React Flow, unit-tested); the `*Node` wrappers add the
// hidden handles React Flow needs to attach the wires. `nodeTypes` is declared once, outside any component (§5.1).
import { createContext, memo, useContext, type CSSProperties, type FocusEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Tr } from '../../../../shared/i18n/core.ts';
import { cardButton, cardLabel } from '../cards.ts';
import { rootIntent, rowIntent, type DeckIntent } from '../actions.ts';
import { Glyph } from './Glyph.tsx';
import { C, type LaneData, type OrchData, type RowData, type ShelfData, type ShelfRow, type SubData } from './model.ts';
import { sparkPoints } from './spark.ts';
import { isMenuKey } from '../../lib/keys.ts';

export interface DeckCtxValue {
  tr: Tr; live: boolean;
  /** a click on a node part; `node` = the React Flow node id (the move guard, §4.12). */
  act(i: DeckIntent, node: string): void;
  /** §4.12 open the "⋯" menu of `node` at `anchor`; `via` = pointer (move-guarded) or keyboard (ContextMenu / ⇧F10). */
  menu(node: string, anchor: Element, via: 'pointer' | 'key'): void;
  /** §4.11 sub branch open / close, the shelf's merged rows shown / hidden (store actions). */
  toggleSubs(lane: string): void; toggleDone(): void;
  /** tooltip: lines at a point (pointer) or under an element (focus); null hides it. */
  tip(lines: string[] | null, at?: { x: number; y: number }): void;
  /** §4.7 lane node hover → the account panel lights that lane's account row (null = left). */
  hover?(lane: string | null): void;
}
const noop = () => {};
export const DeckCtx = createContext<DeckCtxValue>({ tr: ((k: string) => k) as unknown as Tr, live: false, act: noop, menu: noop, toggleSubs: noop, toggleDone: noop, tip: noop });

const MoreIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /></svg>;
const CheckIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;

/** Pointer / focus → tooltip handlers for a node (§4.2 rê chuột, §4.11 focus hiện chú thích); UX-M8 N2-i a keyboard focus
 *  (`:focus-visible`, not a click) adds the keys line (`keys`) under the same lines. */
function tipProps(ctx: DeckCtxValue, lines: string[], keys?: string) {
  return {
    onPointerEnter: (e: PointerEvent) => ctx.tip(lines, { x: e.clientX, y: e.clientY }),
    onPointerMove: (e: PointerEvent) => ctx.tip(lines, { x: e.clientX, y: e.clientY }),
    onPointerLeave: () => ctx.tip(null),
    onFocus: (e: FocusEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect?.(); ctx.tip(keys && e.target.matches?.(':focus-visible') ? [...lines, keys] : lines, r ? { x: r.x + r.width / 2, y: r.y + r.height } : { x: 0, y: 0 }); },
    onBlur: () => ctx.tip(null),
  };
}
/** Inner buttons stop the click from reaching the select button underneath. */
const inner = (f: () => void) => (e: { stopPropagation(): void }) => { e.stopPropagation(); f(); };

function MenuBtn({ id }: { id: string }): ReactElement {
  const ctx = useContext(DeckCtx);
  return <button type="button" className="more" aria-label={ctx.tr('deck.node.menu')} aria-haspopup="menu"
    onClick={e => { e.stopPropagation(); ctx.menu(id, e.currentTarget, 'pointer'); }}><MoreIcon /></button>;
}

type MenuEv = { preventDefault(): void; stopPropagation(): void; currentTarget: Element };
/** §4.11 right-click anywhere on a node, or ContextMenu / ⇧F10 while it has focus → its "⋯" menu (§4.12). */
export function menuHandlers(ctx: Pick<DeckCtxValue, 'menu'>, id: string) {
  const open = (e: MenuEv, via: 'pointer' | 'key') => { e.preventDefault(); e.stopPropagation(); ctx.menu(id, e.currentTarget, via); };
  return {
    onContextMenu: (e: MenuEv) => open(e, 'pointer'),
    onKeyDown: (e: MenuEv & { key: string; shiftKey: boolean }) => { if (isMenuKey(e)) open(e, 'key'); },
  };
}

export function LaneCard({ id, d }: { id: string; d: LaneData }): ReactElement {
  const ctx = useContext(DeckCtx), tr = ctx.tr, l2 = d.line2;
  const cls = ['nd', 'lane', `st-${d.state}`, d.selected ? 'sel' : '', d.fresh ? `fresh ${d.fresh}` : ''].filter(Boolean).join(' ');
  let mid: ReactNode;
  if (l2.kind === 'card') {
    const f = l2.face;
    mid = <div className="r l2"><span className={f.tone === 'bad' ? 'lb bad' : 'lb warn'}>{cardLabel(tr, f.kind)}</span>
      {f.text ? <span className={`task hi${f.kind === 'perm' ? ' mono' : ''}`}>{f.text}</span> : null}
      {f.more ? <span className="tg">+{f.more}</span> : null}
      <button type="button" className={`nb ml ${f.tone === 'bad' ? 'e' : 'w'}`}
        onClick={inner(() => ctx.act({ t: 'card', cardId: f.cardId, lane: d.name }, id))}>{cardButton(tr, f.kind)}</button></div>;
  } else if (d.branch) { // §4.15 §1 "báo xong · chưa merge · 2 commit"
    const b = d.branch;
    mid = <div className="r l2"><span className="mut">{tr('done.reported')} ·</span><span className={`task br-${b.tone}`}>{b.text}</span>
      {b.measuring ? <span className="mut">{tr('done.b.measuring')}</span> : null}</div>;
  } else if (l2.kind === 'quota') {
    mid = <div className="r l2"><span className="mut">{tr('deck.node.quota')}</span>{l2.at ? <span className="task">{tr('deck.node.reset', { at: l2.at })}</span> : null}</div>;
  } else mid = <div className="r l2"><span className="task">{l2.text}</span></div>;
  return (
    <div className={cls} role="group" aria-label={d.aria} {...tipProps(ctx, d.tip, tr('deck.node.keysTip'))} {...menuHandlers(ctx, id)}
      onMouseEnter={() => ctx.hover?.(d.name)} onMouseLeave={() => ctx.hover?.(null)}>
      <button type="button" className="hit" aria-label={d.aria} onClick={() => ctx.act({ t: 'lane', name: d.name }, id)} />
      <div className="g"><Glyph key={d.glyph} state={d.glyph} live={ctx.live} orbit={d.orbit} /></div>
      <div className="b">
        <div className="r">
          <span className="id">{d.name}</span>{d.phase ? <span className="stp">{d.phase}</span> : null}
          {d.issue ? <button type="button" className={`ikey${d.issue.unseen ? ' am' : ''}`} aria-label={tr('deck.node.issueOpen', { key: d.issue.key })}
            onClick={inner(() => ctx.act({ t: 'issue', key: d.issue!.key }, id))}>{d.issue.key}</button> : null}
          {d.subs ? <button type="button" className="tg sb" aria-expanded={d.subs.open} aria-label={tr('deck.node.subsToggle', { n: d.subs.n })}
            onClick={inner(() => ctx.toggleSubs(d.name))}>{tr('deck.node.subs', { n: d.subs.n })} {d.subs.open ? '▾' : '▸'}</button> : null}
          <span className="acct">{d.account ?? ''}</span><MenuBtn id={id} />
        </div>
        {mid}
        <div className="r tok"><span>{d.tok}</span><span>{d.cost}</span>
          {d.tail?.kind === 'spark' ? <span className="ml spark"><svg width="40" height="14" aria-hidden="true"><polyline points={sparkPoints(d.tail.pts)} fill="none" stroke={C.run} strokeWidth="1.2" /></svg></span>
            : d.tail ? <span className="ml mut">{d.tail.text}</span> : null}
        </div>
      </div>
      {d.fresh ? <span className="freshl">{tr('done.fresh')}</span> : null}
    </div>
  );
}

export function OrchCard({ id, d }: { id: string; d: OrchData }): ReactElement {
  const ctx = useContext(DeckCtx), tr = ctx.tr, l2 = d.line2;
  const cls = ['nd', 'orch', d.selected ? 'sel' : ''].filter(Boolean).join(' ');
  // §4.14 the short session name is the small label at the start of line 2
  const row2 = (children: ReactNode) => <div className="r l2">{d.title ? <span className="stitle mono">{d.title}</span> : null}{children}</div>;
  let mid: ReactNode;
  switch (l2.kind) {
    case 'down': mid = row2(<><span className="lb bad">{tr('deck.node.stopped')}</span>
      {l2.remote ? <span className="ml mut" title={tr('deck.node.macOnlyTip')}>{tr('deck.node.macOnly')}</span>
        : <button type="button" className="nb ml e" onClick={inner(() => ctx.act({ t: 'orch_restart', root: id.slice(5) }, id))}>{tr('deck.node.restart')}</button>}</>); break;
    case 'ask': mid = row2(<><span className="lb warn">{tr('deck.node.waiting')}</span>
      <button type="button" className="nb ml w" onClick={inner(() => ctx.act({ t: 'card', cardId: l2.cardId, lane: null }, id))}>{tr('deck.node.answer')}</button></>); break;
    case 'quota': mid = row2(<><span className="mut">{tr('deck.node.quota')}</span>{l2.at ? <span className="task">{l2.at}</span> : null}</>); break;
    case 'starting': mid = row2(<><span className="task">{tr('deck.node.starting')}</span></>); break;
    case 'noAccount': mid = row2(<><span className="lb warn">{tr('deck.node.noAccount')}</span></>); break;
    case 'paused': mid = row2(<><span className="task mut">{tr('deck.orch.paused')}</span></>); break;
    case 'with': mid = row2(l2.lanes.length ? <span className="task">{tr('deck.node.with')} <b>{l2.lanes.join(', ')}</b></span>
      : <span className="task">{tr('deck.orch.running')}</span>); break;
    default: mid = row2(<><span className="task mut">{tr('deck.node.idle')}</span></>);
  }
  return (
    <div className={cls} role="group" aria-label={d.aria} {...tipProps(ctx, d.tip, tr('deck.node.keysTip'))} {...menuHandlers(ctx, id)}>
      <button type="button" className="hit" aria-label={d.aria} onClick={() => ctx.act(rootIntent(id), id)} />
      <div className="g"><Glyph key={d.glyph} state={d.glyph} live={ctx.live} /></div>
      <div className="b">
        {/* §4.7 UX-I1 with a kind chip the account moves to the token line: line 1 is the name + chip whole (v2.1 I5 keeps it shown) */}
        <div className="r"><span className="id sans">{d.name}</span>{d.kindLabel ? <span className="okind" title={d.kindLabel}>{d.kindLabel}</span> : <span className="acct">{d.account ?? ''}</span>}<MenuBtn id={id} /></div>
        {mid}
        <div className="r tok">{d.tok === null ? <span>—</span> : <><span>{d.tok}</span><span>{d.cost}</span></>}{d.kindLabel ? <span className="acct">{d.account ?? ''}</span> : null}</div>
      </div>
      {d.empty ? <div className="nolanes">{d.empty}</div> : null}
    </div>
  );
}

const SUB_DOT: Record<SubData['status'], string> = { running: C.run, failed: C.err, completed: C.gry, unknown: C.gry };
export function SubCard({ id, d }: { id: string; d: SubData }): ReactElement {
  const ctx = useContext(DeckCtx);
  const cls = ['sub', d.status === 'completed' ? 'cmp' : '', d.status === 'failed' ? 'fail' : '', d.selected ? 'sel' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="group" aria-label={d.aria} {...tipProps(ctx, d.tip)} {...menuHandlers(ctx, id)}>
      <button type="button" className="hit" aria-label={d.aria} onClick={() => ctx.act({ t: 'sub', lane: d.lane, taskId: d.taskId }, id)} />
      <span className="d" style={{ background: SUB_DOT[d.status] }} /><span className="mono nm">{d.type}</span>
      {d.tok ? <span className="ml mono mut">{d.tok}</span> : null}
    </div>
  );
}

function RowCard({ id, d }: { id: string; d: RowData }): ReactElement {
  const ctx = useContext(DeckCtx);
  const fold = d.kind === 'collapsedRow';
  return (
    <div className={fold ? 'grp' : 'sub mr'} role="group" aria-label={d.aria} title={fold ? d.aria : undefined}>
      <button type="button" className="hit" aria-label={d.aria} onClick={() => ctx.act(rowIntent(d.kind, id, d.lane), id)} />
      <span>{d.text}</span>{d.extra ? <span className="mut">{d.extra}</span> : null}
      {fold ? <span className="ml mono mut">›</span> : null}
    </div>
  );
}

/** §4.15 §3 a shelf click: a row selects its lane, the "Đã merge" toggle shows / hides merged rows (null), "n lane xong
 *  cũ hơn…" opens the done list. */
export function shelfClick(ctx: Pick<DeckCtxValue, 'act' | 'toggleDone'>, id: string, i: DeckIntent | null): void {
  if (i) ctx.act(i, id); else ctx.toggleDone();
}

function ShelfRowBtn({ id, r, merged }: { id: string; r: ShelfRow; merged: boolean }): ReactElement {
  const ctx = useContext(DeckCtx);
  const cls = ['rw', merged ? 'merged' : '', r.selected ? 'sel' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} aria-label={r.aria} aria-current={r.selected || undefined} {...tipProps(ctx, r.tip)}
      onClick={() => shelfClick(ctx, id, { t: 'lane', name: r.name })}>
      <span className="nm">{r.name}</span><span className={r.tone === 'bad' ? 'tk br-bad' : 'tk'}>{r.task}</span><span className="tm">{r.when}</span>
    </button>
  );
}

/** §4.15 §3 Rev 18/11 concept B: "✓ Xong n", "Chưa merge · n" + rows (always), "Đã merge · n ▸" toggle, merged rows,
 *  "n lane xong cũ hơn… ›". Unmerged stands out by amber text only; selection = the neutral grey step. */
export function ShelfCard({ id, d }: { id: string; d: ShelfData }): ReactElement {
  const ctx = useContext(DeckCtx);
  return (
    <div className="shelf" role="group" aria-label={d.aria}>
      <div className="hd"><CheckIcon /><b>{d.title}</b><span className="mut">{d.count}</span></div>
      {d.umText ? <div className="sec warn">{d.umText}</div> : null}
      {d.unmerged.map(r => <ShelfRowBtn key={r.name} id={id} r={r} merged={false} />)}
      <button type="button" className="tgl" aria-expanded={d.open} aria-label={d.mergedAria} onClick={() => shelfClick(ctx, id, null)}>
        <span>{d.mergedText}</span><span className="chev">{d.open ? '▾' : '▸'}</span>
      </button>
      {d.merged.map(r => <ShelfRowBtn key={r.name} id={id} r={r} merged />)}
      {d.older ? <button type="button" className="ft" onClick={() => shelfClick(ctx, id, { t: 'done_list' })}><span>{d.older}</span><span className="chev">›</span></button> : null}
    </div>
  );
}

const HS: CSSProperties = { opacity: 0, pointerEvents: 'none', width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };
const Handles = () => <><Handle type="target" position={Position.Left} isConnectable={false} style={HS} /><Handle type="source" position={Position.Right} isConnectable={false} style={HS} /></>;

/** §4.14 N5-c the faint dashed line between two session trees: drawn only, never focused or clicked. */
export const SepLine = memo(() => <div className="tsep" aria-hidden="true" />);

const LaneNode = memo(({ id, data }: NodeProps) => <><Handles /><LaneCard id={id} d={data as LaneData} /></>);
const OrchNode = memo(({ id, data }: NodeProps) => <><Handles /><OrchCard id={id} d={data as OrchData} /></>);
const SubNode = memo(({ id, data }: NodeProps) => <><Handles /><SubCard id={id} d={data as SubData} /></>);
const RowNode = memo(({ id, data }: NodeProps) => <><Handles /><RowCard id={id} d={data as RowData} /></>);
const ShelfNode = memo(({ id, data }: NodeProps) => <ShelfCard id={id} d={data as ShelfData} />);

/** §5.1 declared outside components, each wrapped in memo. */
export const nodeTypes = {
  orchestrator: OrchNode, lane: LaneNode, subagent: SubNode, more: RowNode, doneShelf: ShelfNode, collapsedRow: RowNode, sep: SepLine,
};
