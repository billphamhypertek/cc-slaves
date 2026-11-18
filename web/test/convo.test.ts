// spec v2.2 §14.5 the conversation items of one Đang xem surface: text blocks (done + streaming, one key each), tool rows
// mapped from the §14.4 lines, read-only grouping, "Ẩn công cụ".
import { describe, expect, test } from 'bun:test';
import type { StreamLine } from '../../shared/protocol.ts';
import { convoItems, toolCall } from '../src/lib/convo.ts';
import { newBlock } from '../src/lib/partials.ts';

let n = 0;
const L = (over: Partial<StreamLine>): StreamLine => ({ seq: ++n, ts: n * 1000, kind: 'assistant', text: '', ...over });
const use = (tool: string, arg: string, id: string, over: Partial<StreamLine> = {}) => L({ kind: 'tool_use', tool, text: `${tool}: ${arg}`, toolUseId: id, ...over });
const res = (id: string, over: Partial<StreamLine> = {}) => L({ kind: 'tool_result', text: 'ok', result: 'ok\n', toolUseId: id, ...over });

describe('§14.5 tool rows from the §14.4 lines', () => {
  test('§14.5 tool_use + its tool_result (paired by toolUseId, even out of order) = one row with state, time, diff, result', () => {
    const a = use('Edit', '/r/web/src/lib/store.ts', 't1', { diff: { add: 12, del: 3 }, input: '{"file_path":"/r/web/src/lib/store.ts"}' });
    const b = use('Bash', 'bun test', 't2');
    const rb = res('t2', { isError: true, result: 'boom', ts: b.ts + 6200 });
    const ra = res('t1', { ts: a.ts + 500, truncated: true, totalLines: 1240 });
    const items = convoItems([a, b, rb, ra], [], { sub: false, hideTools: false });
    expect(items.map(i => i.k)).toEqual(['tool', 'tool']);
    const [e, x] = items as Extract<(typeof items)[number], { k: 'tool' }>[];
    expect(e!.call).toMatchObject({ id: 't1', name: 'Edit', arg: '/r/web/src/lib/store.ts', state: 'ok', ms: 500, diff: { add: 12, del: 3 }, truncated: { lines: 1240 } });
    expect(x!.call).toMatchObject({ id: 't2', state: 'error', ms: 6200, result: 'boom' });
  });

  test('§14.5 S5 the result line\'s exitCode reaches the call', () => {
    expect(toolCall(use('Bash', 'x', 't3'), res('t3', { isError: true, exitCode: 1 })).exitCode).toBe(1);
    expect('exitCode' in toolCall(use('Bash', 'x', 't4'), res('t4'))).toBe(false);
  });

  test('§14.5 a tool_use without result is running; an orphan result still shows', () => {
    expect(toolCall(use('Read', '/a', 't9'), null).state).toBe('running');
    expect(toolCall(null, res('t8')).name).toBe('');
  });

  test('§14.5 ≥ 3 read-only rows in a row fold into one group; Bash / MCP never', () => {
    const ls = [use('Read', '/a', 'r1'), use('Grep', 'x', 'r2'), use('Read', '/b', 'r3'), use('mcp__cc__lane_status', 'D2', 'm1'), use('Read', '/c', 'r4')];
    const items = convoItems(ls, [], { sub: false, hideTools: false });
    expect(items.map(i => i.k)).toEqual(['group', 'tool', 'tool']);
  });

  test('§14.5 S11 "Ẩn công cụ": each stretch becomes one count line, a failed tool stays', () => {
    const ls = [L({ text: 'đầu' }), use('Read', '/a', 'a'), use('Edit', '/b', 'b'), L({ text: 'giữa' }), use('Bash', 'x', 'c'), res('c', { isError: true })];
    const items = convoItems(ls, [], { sub: false, hideTools: true });
    expect(items.map(i => (i.k === 'count' ? `n${i.n}` : i.k))).toEqual(['text', 'n2', 'text', 'tool']);
    expect(new Set(items.map(i => i.key)).size).toBe(items.length);
  });
});

describe('§14.5 text items: done and streaming share the key', () => {
  test('§14.5 a streaming block is the last item, key = block key; its full line later has the same key', () => {
    const blk = { ...newBlock(null, 0), text: 'Xin chào bạn', shown: 4 };
    const live = convoItems([L({ kind: 'po', text: 'hi' })], [['msg1:1', blk]], { sub: false, hideTools: false });
    expect(live.at(-1)).toMatchObject({ k: 'text', key: 'msg1:1', text: 'Xin ', streaming: true });
    const done = convoItems([L({ kind: 'po', text: 'hi' }), L({ text: 'Xin chào bạn', key: 'msg1:1' })], [], { sub: false, hideTools: false });
    expect(done.at(-1)).toMatchObject({ k: 'text', key: 'msg1:1', streaming: false });
  });

  test('§14.5 an ended orphan block (no line) sorts by arrival, not under every later line, and is no longer streaming', () => {
    const po = L({ kind: 'po', text: 'hi' }), next = L({ kind: 'po', text: 'tiếp' });
    const cut = { ...newBlock(null, po.seq), text: 'chữ cắt', shown: 7, ended: true };
    const live = { ...newBlock(null, next.seq), text: 'đang', shown: 4 };
    const items = convoItems([po, next], [['m1:0', cut], ['m2:0', live]], { sub: false, hideTools: false });
    expect(items.map(i => i.key)).toEqual([`s${po.seq}`, 'm1:0', `s${next.seq}`, 'm2:0']);
    expect(items[1]).toMatchObject({ streaming: false, ended: true });
    expect(items[3]).toMatchObject({ streaming: true });
  });

  test('§14.5 VirtualHist keyOf: lines without key use "s" + seq (string), seqOf stays numeric', () => {
    const l = L({ kind: 'po', text: 'x' });
    const [it] = convoItems([l], [], { sub: false, hideTools: false });
    expect(it!.key).toBe(`s${l.seq}`);
    expect(it!.seq).toBe(l.seq);
  });

  test('§14.5 S8 in a sub\'s surface its text lines are Markdown text; in the lane they stay "└" lines', () => {
    const sub = L({ kind: 'subagent', text: 'sub nói', parentToolUseId: 'toolu_1', key: 'm2:0' });
    expect(convoItems([sub], [], { sub: true, hideTools: false })[0]!.k).toBe('text');
    expect(convoItems([sub], [], { sub: false, hideTools: false })[0]!.k).toBe('line');
  });
});
