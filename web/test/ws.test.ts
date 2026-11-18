import { describe, expect, test } from 'bun:test';
import { EngineClient, backoffMs, wsUrl } from '../src/lib/ws.ts';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';

class FakeWs {
  static last: FakeWs | null = null;
  static all: FakeWs[] = [];
  readyState = 0;
  sent: ClientMsg[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWs.last = this; FakeWs.all.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  recv(m: ServerMsg) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

function clock() {
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let now = 0, id = 0;
  return {
    setTimeout: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn, id: ++id }); return id; },
    clearTimeout: (x: unknown) => { const i = timers.findIndex(t => t.id === x); if (i >= 0) timers.splice(i, 1); },
    now: () => now,
    advance(ms: number) { now += ms; timers.sort((a, b) => a.at - b.at); while (timers[0] && timers[0].at <= now) timers.shift()!.fn(); },
  };
}

/** Settled state right now (after a macrotask), so a never-settling promise fails the test instead of hanging the runner. */
const settled = async (p: Promise<unknown>) => Promise.race([p.then(v => ({ ok: v }), e => ({ err: e })), Bun.sleep(5).then(() => 'pending' as const)]);

function setup() {
  FakeWs.all = [];
  const c = clock();
  const msgs: ServerMsg[] = [];
  const statuses: string[] = [];
  const client = new EngineClient({
    url: 'ws://h/ws?token=t', WebSocketImpl: FakeWs as never, timers: c,
    onMessage: m => msgs.push(m), onStatus: s => statuses.push(`${s.status}:${s.attempt}`),
  });
  client.connect();
  return { c, msgs, statuses, client, ws: () => FakeWs.last! };
}

describe('§7.9 WS client', () => {
  test('wsUrl uses location host + /ws and the token (Tauri global wins over ?token=)', () => {
    expect(wsUrl({ protocol: 'http:', host: '127.0.0.1:47800', search: '?token=dev' }, undefined)).toBe('ws://127.0.0.1:47800/ws?token=dev');
    expect(wsUrl({ protocol: 'http:', host: 'h', search: '?token=dev' }, 'tauri')).toBe('ws://h/ws?token=tauri');
    expect(wsUrl({ protocol: 'https:', host: 'slaves.x', search: '' }, undefined)).toBe('wss://slaves.x/ws');
  });

  test('command id → promise resolved by matching ack', async () => {
    const { client, ws } = setup();
    ws().open();
    const p = client.send({ cmd: 'interrupt', target: { kind: 'orchestrator', projectId: 'p1' } });
    const sent = ws().sent[0]!;
    expect(sent.type).toBe('command');
    expect(sent.command.cmd).toBe('interrupt');
    ws().recv({ type: 'ack', id: sent.id, result: [1] });
    expect(await p).toEqual([1]);
  });

  test('command rejected by matching error with code + Vietnamese message', async () => {
    const { client, ws } = setup();
    ws().open();
    const p = client.send({ cmd: 'stop_all' });
    const id = ws().sent[0]!.id;
    ws().recv({ type: 'error', id, code: 'forbidden_remote', message: 'Không được từ xa' });
    await expect(p).rejects.toMatchObject({ code: 'forbidden_remote', message: 'Không được từ xa' });
  });

  test('§6A error key + params reach the CommandError', async () => {
    const { client, ws } = setup();
    ws().open();
    const p = client.send({ cmd: 'stop_all' });
    const id = ws().sent[0]!.id;
    ws().recv({ type: 'error', id, code: 'bad_input', message: 'Sai', key: 'common.cmdFailed', params: { n: 1 } });
    await expect(p).rejects.toMatchObject({ code: 'bad_input', message: 'Sai', key: 'common.cmdFailed', params: { n: 1 } });
  });

  test('ids are unique per command', () => {
    const { client, ws } = setup();
    ws().open();
    void client.send({ cmd: 'stop_all' }); void client.send({ cmd: 'stop_all' });
    expect(new Set(ws().sent.map(m => m.id)).size).toBe(2);
  });

  test('send while disconnected rejects immediately with code offline', async () => {
    const { client } = setup(); // socket created but not open yet
    expect(await settled(client.send({ cmd: 'stop_all' }))).toMatchObject({ err: { code: 'offline' } });
  });

  test('close rejects pending commands and reconnects with backoff, counting attempts', async () => {
    const { client, ws, c, statuses } = setup();
    ws().open();
    const p = client.send({ cmd: 'stop_all' });
    ws().close();
    expect(await settled(p)).toMatchObject({ err: { code: 'disconnected' } });
    expect(FakeWs.all).toHaveLength(1);
    c.advance(backoffMs(1) - 1);
    expect(FakeWs.all).toHaveLength(1);
    c.advance(1);
    expect(FakeWs.all).toHaveLength(2);
    ws().close();
    c.advance(backoffMs(2));
    expect(FakeWs.all).toHaveLength(3);
    ws().open();
    expect(statuses).toEqual(['connecting:0', 'open:0', 'reconnecting:1', 'reconnecting:2', 'open:0']);
  });

  test('backoff doubles and caps at 10 s', () => {
    expect(backoffMs(1)).toBe(500);
    expect(backoffMs(2)).toBe(1000);
    expect(backoffMs(10)).toBe(10_000);
  });

  test('server messages other than ack/error go to onMessage; bad JSON is dropped', () => {
    const { ws, msgs } = setup();
    ws().open();
    ws().onmessage?.({ data: '{not json' });
    ws().recv({ type: 'event', event: { type: 'toast', level: 'info', text: 'x' } });
    expect(msgs).toHaveLength(1);
  });

  test('dispose stops reconnecting', () => {
    const { client, ws, c } = setup();
    ws().open();
    client.dispose();
    c.advance(60_000);
    expect(FakeWs.all).toHaveLength(1);
  });
});
