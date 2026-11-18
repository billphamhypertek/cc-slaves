import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlockLedger, HELD_MAX } from '../../src/stream/blocks.ts';
import { parseLine, type PartialEvent, type StreamEvent } from '../../src/stream/parser.ts';

const ev = (o: object): StreamEvent => parseLine(JSON.stringify(o));
const M = 'msg_A';
const se = (event: object, parent: string | null = null, id = M) =>
  ev({ type: 'stream_event', api_message_id: id, parent_tool_use_id: parent, event });
const start = (index: number, type: string, id = M, parent: string | null = null) =>
  se({ type: 'content_block_start', index, content_block: { type } }, parent, id);
const delta = (index: number, text: string, id = M, parent: string | null = null) =>
  se({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, parent, id);
const stop = (index: number, id = M) => se({ type: 'content_block_stop', index }, null, id);
const msgStart = (id = M, parent: string | null = null) => se({ type: 'message_start', message: { id } }, parent, id);
const msgStop = (id = M) => se({ type: 'message_stop' }, null, id);
const asst = (block: object, id = M) => ev({ type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', content: [block] } });

/** feed events in order; returns every assistant's stamped keys and every output */
function run(events: StreamEvent[], l = new BlockLedger<string>()) {
  const keys: (string | undefined)[][] = [];
  const out: unknown[] = [];
  for (const e of events) {
    if (e.kind === 'stream_event') out.push(...l.event('s1', 'T', e));
    else keys.push(l.stamp('s1', e));
  }
  return { keys, out, l };
}

describe('§14.4 block ledger + key', () => {
  test('§14.4 key = <api_message_id>:<index>; text delta → partial with key + parent; stop → partial_end', () => {
    const r = run([msgStart(), start(0, 'text'), delta(0, 'Xin'), stop(0)]);
    expect(r.out).toEqual([
      { type: 'partial', key: 'msg_A:0', parent: null, delta: 'Xin' },
      { type: 'partial_end', key: 'msg_A:0' },
    ]);
  });
  test('§14.4 subagent delta carries parent = parent_tool_use_id', () => {
    const r = run([msgStart('m2', 'toolu_9'), start(0, 'text', 'm2', 'toolu_9'), delta(0, 'x', 'm2', 'toolu_9')]);
    expect(r.out).toEqual([{ type: 'partial', key: 'm2:0', parent: 'toolu_9', delta: 'x' }]);
  });
  test('§14.4 thinking start / stop → thinking on / off, no content', () => {
    const r = run([msgStart(), start(0, 'thinking'), se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } }), stop(0)]);
    expect(r.out).toEqual([{ type: 'thinking', parent: null, on: true }, { type: 'thinking', parent: null, on: false }]);
  });
  test('§14.4 stamping order 1: assistant before content_block_stop (measured §3-15)', () => {
    const r = run([msgStart(), start(0, 'text'), delta(0, 'a'), asst({ type: 'text', text: 'a' }), stop(0)]);
    expect(r.keys).toEqual([['msg_A:0']]);
  });
  test('§14.4 stamping order 2: assistant after content_block_stop', () => {
    const r = run([msgStart(), start(0, 'text'), delta(0, 'a'), stop(0), asst({ type: 'text', text: 'a' })]);
    expect(r.keys).toEqual([['msg_A:0']]);
  });
  test('§14.4 stamping order 3: assistant after the next block\'s content_block_start (same type)', () => {
    const r = run([msgStart(), start(0, 'text'), delta(0, 'a'), stop(0), start(1, 'text'), asst({ type: 'text', text: 'a' }),
      delta(1, 'b'), asst({ type: 'text', text: 'b' }), stop(1)]);
    expect(r.keys).toEqual([['msg_A:0'], ['msg_A:1']]);
  });
  test('§14.4 stamping matches by type: tool_use block 1 is not taken by the text of block 0', () => {
    const r = run([msgStart(), start(0, 'text'), start(1, 'tool_use'), asst({ type: 'tool_use', id: 't', name: 'Bash', input: {} }), asst({ type: 'text', text: 'a' })]);
    expect(r.keys).toEqual([['msg_A:1'], ['msg_A:0']]);
  });
  test('§14.4 no block found (ledger cleared / engine restarted) → no key', () => {
    expect(run([asst({ type: 'text', text: 'a' }, 'msg_unknown')]).keys).toEqual([[undefined]]);
  });
  test('§14.4 stream_event without api_message_id → nothing (no key possible)', () => {
    const l = new BlockLedger<string>();
    expect(l.event('s1', 'T', ev({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } }) as PartialEvent)).toEqual([]);
  });
  test('§3-15 real-log fixture thinking + text → the text line is stamped msg…:1, deltas join to the full text', () => {
    const evs = readFileSync(join(import.meta.dir, '../_fixtures/stream-thinking-text.jsonl'), 'utf8').trim().split('\n').map(parseLine);
    const r = run(evs);
    const id = 'msg_011Ch3opnqnEwfDQ1sYc6bML';
    expect(r.keys).toEqual([[`${id}:0`], [`${id}:1`]]);
    const text = (evs.find(e => e.kind === 'assistant' && JSON.stringify(e.message).includes('"text"')) as { message: { content: { text: string }[] } }).message.content[0]!.text;
    const parts = r.out.filter((o): o is { type: 'partial'; delta: string } => (o as { type: string }).type === 'partial');
    expect(parts.every(p => (p as unknown as { key: string }).key === `${id}:1`)).toBe(true);
    expect(parts.map(p => p.delta).join('')).toBe(text);
  });
});

describe('§14.4 held text for a mid-stream watch', () => {
  test('§14.4 open() returns the held text as full (unwatched events still recorded)', () => {
    const { l } = run([msgStart(), start(0, 'text'), delta(0, 'Xin '), delta(0, 'chào')]);
    expect(l.open(() => true)).toEqual([{ meta: 'T', out: { type: 'partial', key: 'msg_A:0', parent: null, full: 'Xin chào' } }]);
  });
  test('§14.4 open() filters by target meta', () => {
    const { l } = run([msgStart(), start(0, 'text'), delta(0, 'x')]);
    expect(l.open(m => m === 'other')).toEqual([]);
  });
  test('§14.4 a stopped block not yet saved → full then partial_end; an open thinking block → thinking on', () => {
    const { l } = run([msgStart(), start(0, 'text'), delta(0, 'x'), stop(0), start(1, 'thinking')]);
    expect(l.open(() => true).map(o => o.out)).toEqual([
      { type: 'partial', key: 'msg_A:0', parent: null, full: 'x' },
      { type: 'partial_end', key: 'msg_A:0' },
      { type: 'thinking', parent: null, on: true },
    ]);
  });
  test('§14.4 held text cleared once the full line with that key is stamped', () => {
    const { l } = run([msgStart(), start(0, 'text'), delta(0, 'x'), asst({ type: 'text', text: 'x' })]);
    expect(l.open(() => true)).toEqual([]);
  });
  test('§14.4 held text over 256 KB is dropped: no full on watch, later deltas not sent', () => {
    const big = 'ệ'.repeat(Math.ceil(HELD_MAX / 3)); // 3 UTF-8 bytes each → just over 256 KB
    const r = run([msgStart(), start(0, 'text'), delta(0, 'a'), delta(0, big), delta(0, 'z')]);
    expect(HELD_MAX).toBe(256 * 1024);
    expect(r.l.open(() => true)).toEqual([]);
    expect(r.out).toEqual([{ type: 'partial', key: 'msg_A:0', parent: null, delta: 'a' }]);
  });
  test('§14.4 exactly 256 KB is still held', () => {
    const r = run([msgStart(), start(0, 'text'), delta(0, 'a'.repeat(HELD_MAX))]);
    expect(r.l.open(() => true)).toHaveLength(1);
  });
  test('§14.4 message dropped at message_stop once every block is stamped', () => {
    const { l } = run([msgStart(), start(0, 'text'), delta(0, 'x'), stop(0), msgStop(), asst({ type: 'text', text: 'x' })]);
    expect(l.size).toBe(0);
  });
  test('§14.4 a new message_start of the same parent drops the older message (bounded ledger)', () => {
    const { l } = run([msgStart('m1'), start(0, 'text', 'm1'), delta(0, 'x', 'm1'), msgStart('m2')]);
    expect(l.open(() => true)).toEqual([]);
    expect(l.size).toBe(1);
  });
  test('§14.4 turn end (result): open text blocks get partial_end, the session is forgotten, nothing held', () => {
    const { l } = run([msgStart(), start(0, 'text'), delta(0, 'x'), start(1, 'text'), stop(1)]);
    expect(l.end('s1')).toEqual([{ meta: 'T', out: { type: 'partial_end', key: 'msg_A:0' } }]);
    expect(l.open(() => true)).toEqual([]);
    expect(l.size).toBe(0);
  });
  test('§14.4 turn end inside a thinking block: thinking off (never a stuck "Đang nghĩ…"), a stopped one gets none', () => {
    const { l } = run([msgStart(), start(0, 'thinking'), stop(0), start(1, 'thinking')]);
    expect(l.end('s1')).toEqual([{ meta: 'T', out: { type: 'thinking', parent: null, on: false } }]);
  });
  test('§14.4 turn end in a sub message: thinking off carries the sub parent', () => {
    const { l } = run([msgStart('m9', 'toolu_9'), start(0, 'thinking', 'm9', 'toolu_9')]);
    expect(l.end('s1')).toEqual([{ meta: 'T', out: { type: 'thinking', parent: 'toolu_9', on: false } }]);
  });
});
