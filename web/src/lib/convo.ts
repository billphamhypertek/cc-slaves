// spec v2.2 §14.5 the items of one Đang xem conversation (VirtualHist): Markdown text blocks — done lines and the blocks
// still streaming share one key (`<api_message_id>:<index>`, else 's' + seq) so the swap never remounts —, tool rows
// built from the §14.4 tool lines, grouped (≥ 3 read-only) or hidden ("Ẩn công cụ", S11). Pure.
import type { StreamLine } from '../../../shared/protocol.ts';
import { isOrphan, type PartialBlock } from './partials.ts';
import { groupTools, hideTools, type Row, type ToolCall } from './tool-rows.ts';

export type ConvItem =
  | { k: 'line'; key: string; seq: number; line: StreamLine }
  | { k: 'text'; key: string; seq: number; text: string; streaming: boolean; ended: boolean }
  | { k: 'tool'; key: string; seq: number; call: ToolCall }
  | { k: 'group'; key: string; seq: number; group: Extract<Row<ConvItem>, { k: 'group' }> }
  | { k: 'count'; key: string; seq: number; n: number };

/** Streaming blocks sort after every line. */
const LIVE_SEQ = Number.MAX_SAFE_INTEGER;
const lineKey = (l: StreamLine) => l.key ?? `s${l.seq}`;

/** §14.5 one tool row from its `tool_use` and `tool_result` lines (either may be missing). */
export function toolCall(use: StreamLine | null, result: StreamLine | null): ToolCall {
  const name = use?.tool ?? '';
  const arg = use && use.text.startsWith(`${name}: `) ? use.text.slice(name.length + 2) : '';
  return {
    id: use?.toolUseId ?? result?.toolUseId ?? `s${(use ?? result)!.seq}`,
    name, arg,
    state: !result ? 'running' : result.isError ? 'error' : 'ok',
    ms: use && result ? Math.max(0, result.ts - use.ts) : null,
    ...(use && !result ? { startedAt: use.ts } : {}),
    ...(use?.diff ? { diff: use.diff } : {}),
    ...(use?.input ? { input: use.input } : {}),
    ...(result ? { result: result.result ?? result.text } : {}),
    ...(result?.truncated ? { truncated: { lines: result.totalLines ?? 0 } } : {}),
    ...(result?.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  };
}

/** Lines → items: a tool_use takes its tool_result (by toolUseId; v2.1 lines without ids: the result right after). */
function baseItems(lines: readonly StreamLine[], sub: boolean): ConvItem[] {
  const out: ConvItem[] = [];
  const open = new Map<string, { i: number; use: StreamLine }>();
  let lastUse: { i: number; use: StreamLine } | null = null;
  for (const l of lines) {
    if (l.kind === 'tool_result') {
      const u = l.toolUseId !== undefined ? open.get(l.toolUseId) : lastUse && lastUse.i === out.length - 1 && lastUse.use.toolUseId === undefined ? lastUse : undefined;
      if (u) { out[u.i] = { ...(out[u.i] as Extract<ConvItem, { k: 'tool' }>), call: toolCall(u.use, l) }; if (l.toolUseId !== undefined) open.delete(l.toolUseId); lastUse = null; continue; }
      out.push({ k: 'tool', key: lineKey(l), seq: l.seq, call: toolCall(null, l) });
      continue;
    }
    if (l.kind === 'tool_use') {
      lastUse = { i: out.length, use: l };
      if (l.toolUseId !== undefined) open.set(l.toolUseId, lastUse);
      out.push({ k: 'tool', key: lineKey(l), seq: l.seq, call: toolCall(l, null) });
      continue;
    }
    lastUse = null;
    const isText = l.kind === (sub ? 'subagent' : 'assistant');
    out.push(isText ? { k: 'text', key: lineKey(l), seq: l.seq, text: l.text, streaming: false, ended: true } : { k: 'line', key: lineKey(l), seq: l.seq, line: l });
  }
  return out;
}

const toolOf = (it: ConvItem) => (it.k === 'tool' ? it.call : null);

/** §14.5 the items of one surface: its lines, then one item per block still streaming (`blocks` already of this surface). */
export function convoItems(lines: readonly StreamLine[], blocks: readonly [string, PartialBlock][], o: { sub: boolean; hideTools: boolean }): ConvItem[] {
  const items = baseItems(lines, o.sub);
  for (const [key, b] of blocks) {
    const orphan = isOrphan(b), seq = orphan ? b.at + 0.5 : LIVE_SEQ;
    const it: ConvItem = { k: 'text', key, seq, text: b.text.slice(0, b.shown), streaming: !(orphan && b.shown >= b.text.length), ended: b.ended };
    const i = orphan ? items.findIndex(x => x.seq > seq) : -1;
    if (i < 0) items.push(it); else items.splice(i, 0, it);
  }
  if (o.hideTools) {
    // a count line has no line of its own: it takes the key / seq of what is above it (the first item at the top)
    let prev = { key: 'top', seq: items[0]?.seq ?? 0 };
    return hideTools(items, toolOf).map(r => {
      if (r.k === 'item') { prev = r.item; return r.item; }
      return { k: 'count', key: `c:${prev.key}`, seq: prev.seq, n: r.n };
    });
  }
  return groupTools(items, toolOf).map(r => (r.k === 'item' ? r.item : { k: 'group', key: `g:${r.items[0]!.key}`, seq: r.items[0]!.seq, group: r }));
}
