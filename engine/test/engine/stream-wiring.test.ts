// v2.2 §14.4 engine stream wiring: the block ledger always records, the hub broadcasts only to watchers, a mid-stream
// watch gets the held text as `full` first, the full line carries the stamped key.
import { describe, expect, test } from 'bun:test';
import type { EngineEvent, ServerMsg, Target } from '../../../shared/protocol.ts';
import { insertProject, insertSession, openDb } from '../../src/db.ts';
import type { Engine } from '../../src/engine.ts';
import { sendHeld, stream, wire } from '../../src/engine/events.ts';
import { LineStore } from '../../src/server/lines.ts';
import { Outbox, PREFIX } from '../../src/outbox.ts';
import { WsHub, type Conn } from '../../src/server/ws.ts';
import { BlockLedger } from '../../src/stream/blocks.ts';
import { parseLine } from '../../src/stream/parser.ts';

const T: Target = { kind: 'lane', projectId: 'p', name: 'D1' };
const ev = (o: object) => parseLine(JSON.stringify(o));
const se = (event: object) => ev({ type: 'stream_event', api_message_id: 'm', parent_tool_use_id: null, event });

function setup() {
  const db = openDb(':memory:');
  insertProject(db, { id: 'p', name: 'P', path: '/p' });
  insertSession(db, { id: 's1', projectId: 'p', kind: 'lane', account: null });
  const hub = new WsHub({ snapshot: () => ({}) as never, handlers: () => ({}) as never });
  const eng = { hub, blocks: new BlockLedger<Target>(), lines: new LineStore(db), inTurnSent: new Map(), outbox: new Outbox(db),
    config: {}, targetOfSession: () => T } as unknown as Engine;
  const conn = (watch: Target | null) => {
    const got: EngineEvent[] = [];
    const c: Conn = { channel: 'mac', watch, present: true, send: (m: ServerMsg) => { if (m.type === 'event') got.push(m.event); } };
    hub.open(c);
    return { c, got };
  };
  const feed = (...es: object[]) => { for (const e of es) stream(eng, T, 's1', ev(e)); };
  return { eng, conn, feed, db };
}

const OPEN = [se({ type: 'message_start', message: { id: 'm' } }), se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })];
const D = (text: string) => se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

describe('§14.4 engine stream wiring', () => {
  test('§14.4 unwatched: no broadcast, but recorded — a later watch gets full before the next delta', () => {
    const { eng, conn } = setup();
    const late = conn(null);
    let sent = 0;
    const real = eng.hub.broadcast.bind(eng.hub);
    eng.hub.broadcast = (e) => { sent++; real(e); };
    for (const e of [...OPEN, D('Xin '), D('chào')]) stream(eng, T, 's1', e);
    expect(sent).toBe(0); // v2.1 "idle → 0 work": nothing is even built for the hub
    expect(late.got).toEqual([]);
    late.c.watch = T;
    sendHeld(eng, late.c);
    stream(eng, T, 's1', D('!'));
    expect(late.got).toEqual([
      { type: 'partial', target: T, key: 'm:0', parent: null, full: 'Xin chào' },
      { type: 'partial', target: T, key: 'm:0', parent: null, delta: '!' },
    ]);
  });
  test('§14.4 watched: delta broadcast with key; a watch of another target gets nothing held', () => {
    const { eng, conn } = setup();
    const w = conn(T), other = conn({ kind: 'lane', projectId: 'p', name: 'D2' });
    for (const e of [...OPEN, D('a')]) stream(eng, T, 's1', e);
    sendHeld(eng, other.c);
    expect(w.got).toEqual([{ type: 'partial', target: T, key: 'm:0', parent: null, delta: 'a' }]);
    expect(other.got).toEqual([]);
  });
  test('§14.4 the full assistant line is stored + broadcast with the stamped key', () => {
    const { eng, conn } = setup();
    const w = conn(T);
    for (const e of [...OPEN, D('a')]) stream(eng, T, 's1', e);
    stream(eng, T, 's1', ev({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'a' }] } }));
    const line = w.got.find((g) => g.type === 'stream') as { lines: { key?: string; text: string }[] };
    expect(line.lines[0]).toMatchObject({ key: 'm:0', text: 'a' });
    expect(eng.lines.page(['s1'])[0]!.key).toBe('m:0');
  });
  test('§14.4 a result ends the turn: watchers get partial_end for the open block; a later watch gets nothing held', () => {
    const { eng, conn } = setup();
    const w = conn(T);
    for (const e of [...OPEN, D('a')]) stream(eng, T, 's1', e);
    stream(eng, T, 's1', ev({ type: 'result', subtype: 'success', is_error: false, result: '' }));
    expect(w.got.at(-1)).toEqual({ type: 'partial_end', target: T, key: 'm:0' });
    const late = conn(T);
    sendHeld(eng, late.c);
    expect(late.got).toEqual([]);
  });
  test('§14.4 a process that dies mid-block (session_exit / session_ended, no result): partial_end + thinking off, nothing held after', () => {
    for (const [src, exit] of [
      ['lanes', { type: 'session_exit', projectId: 'p', name: 'D1', sessionId: 's1' }],
      ['orchestrators', { type: 'session_exit', projectId: 'p', sessionId: 's1' }],
      ['orchestrators', { type: 'session_ended', projectId: 'p', sessionId: 's1', reason: 'kill', expireAsks: false }],
    ] as const) {
      const { eng, conn } = setup();
      const ls: Record<string, (e: unknown) => void> = {};
      Object.assign(eng, Object.fromEntries(['lanes', 'orchestrators', 'cards'].map((k) => [k, { on: (f: (e: unknown) => void) => { ls[k] = f; } }])));
      wire(eng);
      const w = conn(T);
      const think = se({ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } });
      for (const e of [...OPEN, D('a'), think]) stream(eng, T, 's1', e);
      ls[src]!(exit);
      expect(w.got.filter((g) => g.type === 'partial_end' || (g.type === 'thinking' && !g.on))).toEqual([
        { type: 'partial_end', target: T, key: 'm:0' },
        { type: 'thinking', target: T, parent: null, on: false },
      ]);
      const late = conn(T);
      sendHeld(eng, late.c);
      expect(late.got).toEqual([]);
    }
  });
});

describe('v2.4 §10.2 echoed rows, po_line target, §6.3 missing line', () => {
  const lines = (got: EngineEvent[]) => got.flatMap((g) => (g.type === 'stream' ? g.lines : []));
  const replay = (uuid: string, content: string) => Object.assign(ev({ type: 'user', isReplay: true, uuid, message: { role: 'user', content } }), { ours: true });
  test('§10.2 the replay of an echoed row adds no line; a plain row\'s replay is its po line (R3 without "[PO] ")', () => {
    const { eng, conn } = setup();
    const w = conn(T);
    const echoed = eng.outbox.enqueue('s1', 'kèm ảnh', PREFIX.po, { echoed: true });
    const plain = eng.outbox.enqueue('s1', 'chữ', PREFIX.po);
    stream(eng, T, 's1', replay(echoed.uuid, '[PO] kèm ảnh'));
    stream(eng, T, 's1', replay(plain.uuid, '[PO] chữ'));
    expect(lines(w.got).map((l) => [l.kind, l.text])).toEqual([['po', 'chữ']]);
  });
  test('G3d ⑥ a po_line for a session not routed yet (a replacer) is stored under that session and names it in the target', () => {
    const { eng, conn, db } = setup();
    insertSession(db, { id: 's2', projectId: 'p', kind: 'orchestrator', account: null });
    const ls: Record<string, (e: unknown) => void> = {};
    Object.assign(eng, Object.fromEntries(['lanes', 'orchestrators', 'cards'].map((k) => [k, { on: (f: (e: unknown) => void) => { ls[k] = f; } }])));
    wire(eng);
    const other = conn({ kind: 'orchestrator', projectId: 'p', sessionId: 's1' });
    const mine = conn({ kind: 'orchestrator', projectId: 'p', sessionId: 's2' });
    ls.orchestrators!({ type: 'po_line', projectId: 'p', sessionId: 's2', line: { kind: 'po', text: 'x', parentToolUseId: null } });
    expect(eng.lines.page(['s2']).map((l) => l.text)).toEqual(['x']);
    expect(eng.lines.page(['s1'])).toEqual([]);
    expect(other.got.filter((g) => g.type === 'stream')).toEqual([]);
    expect(mine.got.filter((g) => g.type === 'stream').map((g) => (g as { target: Target }).target)).toEqual([{ kind: 'orchestrator', projectId: 'p', sessionId: 's2' }]);
  });
  test('§6.3 A4 the outbox reporting missing attachments → one engine line in that session\'s conversation', () => {
    const { eng, conn } = setup();
    const ls: Record<string, (e: unknown) => void> = {};
    Object.assign(eng, Object.fromEntries(['lanes', 'orchestrators', 'cards'].map((k) => [k, { on: (f: (e: unknown) => void) => { ls[k] = f; } }])));
    let report: ((sid: string, uuid: string, names: string[]) => void) | null = null;
    eng.outbox.onAttachMissing = (f) => { report = f; };
    wire(eng);
    const w = conn(T);
    report!('s1', 'u', ['a.txt', 'b.png']);
    expect(lines(w.got).map((l) => [l.kind, l.text])).toEqual([['engine', 'Không gửi được a.txt, b.png: file không còn trên máy.']]);
  });
  test('R14 a pending §4.3 line is written before the boundary line', () => {
    const { eng } = setup();
    const ls: Record<string, (e: unknown) => void> = {};
    Object.assign(eng, Object.fromEntries(['lanes', 'orchestrators', 'cards'].map((k) => [k, { on: (f: (e: unknown) => void) => { ls[k] = f; } }])));
    wire(eng);
    ls.orchestrators!({ type: 'model_change', projectId: 'p', sessionId: 's1',
      from: { modelName: 'Fable 5.2', effort: null }, to: { modelName: 'Sonnet 5.5', effort: null } });
    ls.orchestrators!({ type: 'boundary', projectId: 'p', sessionId: 's1', boundary: { type: 'end', seq: 1, at: 0 } });
    const got = eng.lines.page(['s1']);
    expect(got.length).toBe(2);
    expect(got[0]!.text).toContain('Sonnet 5.5');
    expect(got[1]!.boundary).toBeTruthy();
  });
});
