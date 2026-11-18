// v2.1 §4.11b the conversation of the viewed orchestrator session / lane / subagent; §4.14 a session boundary renders as a
// divider. v2.2 §14.5: assistant text as Markdown (the streaming block and its full line are one item, one key, one
// <TextBlock>), tool rows (grouped, or hidden by "Ẩn công cụ"), "Đang nghĩ…", the S9 disconnect line, copy buttons.
// Shared by the Inspector and the read-only ended session view (SessionView).
import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactElement } from 'react';
import type { StreamLine } from '../../../shared/protocol.ts';
import { boundaryText, type StreamBuffer } from '../lib/console.ts';
import { convoItems, type ConvItem } from '../lib/convo.ts';
import { fmtElapsed, fmtHm } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { copyText } from '../lib/links.ts';
import { blocksOf } from '../lib/partials.ts';
import type { Store } from '../lib/store.ts';
import type { ToolCall } from '../lib/tool-rows.ts';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { midEllipsis, textWidth } from '../lib/mid-ellipsis.ts';
import { monoFont } from '../lib/mono-font.ts';
import { ToolCount, ToolGroup, ToolRow, useClock } from './ToolRow.tsx';
import { freshLabel } from '../lib/vhist.ts';
import { VirtualHist } from './VirtualHist.tsx';

/** v2.2 §14.5 where one surface streams (the target `tk`'s own, or one subagent's: `parent` = its Task id). The list reads
 *  the blocks + "Đang nghĩ…" itself, so a reveal frame re-renders the list alone (perf audit C3); paced while it is mounted. */
export interface Live { store: Store; tk: string; parent: string | null }

const noSub = () => () => {};
/** the streaming blocks + "Đang nghĩ…" since (ms, null = not thinking) of `live`; registers the surface as shown */
function useLiveBlocks(live: Live | undefined) {
  const store = live?.store, tk = live?.tk ?? null, parent = live?.parent ?? null;
  const subscribe = store?.subscribe ?? noSub;
  const getBlocks = useCallback(() => (store && tk ? store.get().partials[tk] : undefined), [store, tk]);
  const getThinking = useCallback(() => (store && tk ? store.get().thinking[tk]?.[parent ?? ''] ?? null : null), [store, tk, parent]);
  const blocks = useSyncExternalStore(subscribe, getBlocks, getBlocks), thinking = useSyncExternalStore(subscribe, getThinking, getThinking);
  useEffect(() => (store && tk ? store.show(tk, parent) : undefined), [store, tk, parent]);
  return { blocks: useMemo(() => blocksOf(blocks, parent), [blocks, parent]), thinking };
}

/** v2.4 §6.3 a label is at most 200 px: `.m-lb` padding 0 var(--s2) (8 px), the rest for the prefix / suffix and the name
 *  cut in the middle; measured in `.m-lb`'s own step (`var(--xs)` mono). */
const LB_PX = 192;
const LB_FONT = 'xs';

/** v2.4 §6.3 DK7 one attachment label (plain text, never bytes): "ảnh · <name>", "<name>", "<name> · bản sao". */
function AttLabel({ a }: { a: NonNullable<StreamLine['att']>[number] }): ReactElement {
  const tr = useT();
  const key = a.kind === 'image' ? 'console.att.image' : a.copy ? 'console.att.copy' : null;
  const font = monoFont(LB_FONT);
  const frame = key ? tr(key, { name: '' }) : '';
  const name = midEllipsis(a.name, LB_PX - (frame ? textWidth(frame, font) : 0), font);
  return <span className="m-lb" title={a.name}>{key ? tr(key, { name }) : name}</span>;
}

/** v2.1 a PO line; v2.4 §6.3 the label row under the text, §5.3 MD4b "gửi khi lượt này xong" (a held message is never in
 *  the running turn, so that note wins over "đã gửi vào lượt đang chạy"); v2.6 §4.8 UP8 "giữ lại" while the update hold
 *  keeps it back (`po_written` clears it). */
function PoLine({ l }: { l: StreamLine }): ReactElement {
  const tr = useT();
  const note = l.afterModelChange ? tr('console.afterModelChange') : l.inTurn ? tr('console.inTurn') : null;
  return <div className="m-po">
    <span className="m-who">{tr('stream.you')} · {fmtHm(l.ts)}{note ? <span> · {note}</span> : null}
      {l.held ? <span className="m-hold"><Icon n="clock" s={11} />{tr('update.held')}</span> : null}</span>
    {l.text ? <span>{l.text}</span> : null}
    {l.att?.length ? <div className="m-lbs">{l.att.map((a, i) => <AttLabel key={i} a={a} />)}</div> : null}
  </div>;
}

function Line({ l }: { l: StreamLine }): ReactElement {
  const tr = useT();
  switch (l.kind) {
    case 'po': return <PoLine l={l} />;
    case 'system': return <div className="m-sys info"><Icon n="refresh" /><span>{l.text}</span></div>;
    case 'subagent': return <div className="m-evt">└ {l.text}</div>;
    default: return l.boundary ? <div className="m-div" role="separator"><span>{boundaryText(tr, l)}</span></div> : <div className="m-evt">{l.text}</div>;
  }
}

/** §14.5 one assistant text block, streaming or done: the same element either way (no remount at the swap). Memoized:
 *  a reveal frame of another block re-renders the list, never a finished message ("only the last block parses"). */
const TextBlock = memo(function TextBlock({ text, streaming, ended }: { text: string; streaming: boolean; ended: boolean }): ReactElement {
  const tr = useT();
  const live = streaming && !ended;
  return <div className={`m-orch m-text${live ? ' live' : ''}`}>
    <Markdown text={text} streaming={streaming} />
    {streaming ? null : <button type="button" className="m-copy" onClick={() => copyText(text)} title={tr('stream.copyMsg')} aria-label={tr('stream.copyMsg')}><Icon n="copy" s={13} /></button>}
  </div>;
});

/** one level deep: a tool call's nested objects (`diff`, `input`, `truncated`) are rebuilt with it */
const sameCall = (a: ToolCall, b: ToolCall): boolean => {
  const ka = Object.keys(a) as (keyof ToolCall)[];
  return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k] || (typeof a[k] === 'object' && typeof b[k] === 'object' && a[k] !== null && b[k] !== null
    && JSON.stringify(a[k]) === JSON.stringify(b[k])));
};
/** C4: `convoItems` rebuilds every item per render; a row redraws only when what it shows changed */
function sameItem(a: ConvItem, b: ConvItem): boolean {
  if (a.k !== b.k || a.key !== b.key) return false;
  switch (a.k) {
    case 'line': return a.line === (b as typeof a).line;
    case 'text': { const y = b as typeof a; return a.text === y.text && a.streaming === y.streaming && a.ended === y.ended; }
    case 'tool': return sameCall(a.call, (b as typeof a).call);
    case 'group': { const g = a.group, h = (b as typeof a).group;
      return g.state === h.state && g.ms === h.ms && g.open === h.open && g.calls.length === h.calls.length && g.calls.every((c, i) => sameCall(c, h.calls[i]!)); }
    default: return a.n === (b as typeof a).n;
  }
}

const Item = memo(function Item({ it, onTask }: { it: ConvItem; onTask?: (toolUseId: string) => void }): ReactElement {
  const tr = useT();
  switch (it.k) {
    case 'line': return <Line l={it.line} />;
    case 'text': return <TextBlock text={it.text} streaming={it.streaming} ended={it.ended} />;
    case 'tool': return <ToolRow call={it.call.name ? it.call : { ...it.call, name: tr('console.result') }} onTask={onTask} />;
    case 'group': return <ToolGroup group={it.group} />;
    default: return <ToolCount n={it.n} />;
  }
}, (a, b) => a.onTask === b.onTask && sameItem(a.it, b.it));

/** §14.5 S7 (F-M9) "Đang nghĩ… 4 s": the seconds tell slow from stuck. */
function Thinking({ since }: { since: number }): ReactElement {
  const tr = useT();
  const now = useClock(true);
  const ms = now - since;
  return <div className="m-think"><span>{tr('stream.thinking')}</span>{ms >= 1000 ? <span className="m-sec">{fmtElapsed(ms, tr)}</span> : null}</div>;
}

/** The shared list: lines + streaming blocks of one surface. `sub`: a subagent's surface (its text lines are Markdown). */
export function ConvList(p: { lines: readonly StreamLine[]; live?: Live; sub?: boolean; hideTools: boolean; offline?: boolean; color: string;
  onOlder?: () => void; onTask?: (toolUseId: string) => void;
  /** a function: gets whether blocks stream right now (the subagent's empty line) */
  tail?: ReactElement | null | ((streaming: boolean) => ReactElement) }): ReactElement {
  const tr = useT();
  const live = useLiveBlocks(p.live);
  const items = useMemo(() => convoItems(p.lines, live.blocks, { sub: !!p.sub, hideTools: p.hideTools }), [p.lines, live.blocks, p.sub, p.hideTools]);
  const streaming = !!live.blocks.length;
  // C4: one `onTask` for the list's life (the Inspector rebuilds its own each render), so the memoized rows hold
  const task = useRef(p.onTask);
  task.current = p.onTask;
  const onTaskStable = useCallback((id: string) => task.current?.(id), []), onTask = p.onTask ? onTaskStable : undefined;
  return <VirtualHist items={items} keyOf={it => it.key} seqOf={it => it.seq} growing={it => it.k === 'text' && it.streaming} render={it => <Item it={it} onTask={onTask} />}
    color={p.color} onTop={p.onOlder} newLabel={n => freshLabel(tr, n)}
    tail={<>{live.thinking != null ? <Thinking since={live.thinking} /> : null}
      {/* §14.5 S9 (F-M10) a red-bordered band, not a grey line that is easy to miss */}
      {p.offline && (streaming || live.thinking != null) ? <div className="m-lost" role="status"><Icon n="wifi" s={14} /><span>{tr('stream.offline')}</span></div> : null}
      {typeof p.tail === 'function' ? p.tail(streaming) : p.tail ?? null}</>} />;
}

/** §14.5 S11 the "Ẩn công cụ" switch at the head of Đang xem. */
export function HideTools({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }): ReactElement {
  const tr = useT();
  return <label className="hidetools"><Icon n="eyeOff" s={13} />{tr('stream.hideTools')}
    <input type="checkbox" role="switch" checked={on} onChange={e => onChange(e.currentTarget.checked)} /></label>;
}

/** `skel`: §4.14 N5-h a resumed session still starting — its first lines, then the "đang trả lời" skeleton under them. */
export function Conversation(p: { stream: StreamBuffer | undefined; live?: Live; hideTools: boolean; offline?: boolean; color: string; skel?: boolean;
  /** §4.7 UX-I11 a Thiết kế session the PO has not written to yet: its empty state under the lines. */
  designNew?: boolean;
  onOlder: () => void; onJumpEnd: () => void; onTask?: (toolUseId: string) => void }): ReactElement {
  const tr = useT();
  return <ConvList lines={p.stream?.lines ?? []} live={p.live} hideTools={p.hideTools} offline={p.offline} color={p.color} onTask={p.onTask}
    onOlder={() => { if (p.stream?.hasOlder) p.onOlder(); }}
    tail={<>{p.stream?.newer ? <button type="button" className="lnk" onClick={p.onJumpEnd}>{tr('console.newer')}</button> : null}
      {p.skel ? <div className="skel" aria-hidden="true"><i /><i /></div> : null}
      {p.designNew ? <div className="c-empty"><p>{tr('console.designNew.title')}</p><p>{tr('console.designNew.body')}</p></div> : null}</>} />;
}
