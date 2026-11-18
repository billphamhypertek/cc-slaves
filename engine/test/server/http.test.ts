import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { networkInterfaces } from 'node:os';
import { startHttp } from '../../src/server/http.ts';
import type { WsHub } from '../../src/server/ws.ts';

let server: Server<unknown> | null = null;
afterEach(() => { void server?.stop(true); server = null; });

describe('§7.1 engine starting: the port is bound before the engine exists', () => {
  test('/ws and /healthz answer 503 until ready (no WS reaches a hub that does not exist yet); then normal', async () => {
    let ready = false;
    let opened = 0;
    const hub = { open: () => { opened++; }, close() {}, message: async () => {} } as unknown as WsHub;
    server = startHttp({ port: 0, token: () => 't', staticDir: null, mcp: async () => new Response('x'), mcpProxy: async () => new Response('proxy'), oauthCallback: async () => new Response('cb'), hub, ready: () => ready, health: () => ({ v: 1 }) });
    const base = `http://127.0.0.1:${server.port}`;
    const h = await fetch(`${base}/healthz`);
    expect(h.status).toBe(503);
    expect(await h.json()).toEqual({ starting: true });
    const up = () => fetch(`${base}/ws?token=t`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: base } });
    expect((await up()).status).toBe(503);
    expect(opened).toBe(0);
    ready = true;
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ v: 1 });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=t`, { headers: { origin: base } } as unknown as string[]);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('refused')); });
    await Bun.sleep(20);
    expect(opened).toBe(1);
    ws.close();
  });
});

async function rawGet(port: number, path: string, host: string, peer = '127.0.0.1'): Promise<string> {
  let out = '';
  const done = Promise.withResolvers<void>();
  const sock = await Bun.connect({
    hostname: peer, port,
    socket: { data: (_s, d) => { out += d.toString(); }, close: () => done.resolve(), error: () => done.resolve() },
  });
  sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  await Promise.race([done.promise, Bun.sleep(1000)]);
  sock.end();
  return out;
}

test('§8.3 R10 I5 a new WS connection starts not present (the web sends `presence`)', async () => {
  const conns: { present: boolean; channel: string }[] = [];
  const hub = { open: (c: { present: boolean; channel: string }) => { conns.push(c); }, close() {}, message: async () => {} } as unknown as WsHub;
  server = startHttp({ port: 0, token: () => 't', staticDir: null, mcp: async () => new Response('x'), mcpProxy: async () => new Response('proxy'), oauthCallback: async () => new Response('cb'), hub });
  const base = `http://127.0.0.1:${server.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=t`, { headers: { origin: base } } as unknown as string[]);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('refused')); });
  await Bun.sleep(20);
  expect(conns).toMatchObject([{ channel: 'mac', present: false }]);
  ws.close();
});

describe('§7.2 M3 DNS rebinding: only a loopback Host is served', () => {
  test('Host evil.test → 421 for /healthz, /ws and static; 127.0.0.1 / localhost → normal; /mcp keeps its own checks', async () => {
    const hub = { open() {}, close() {}, message: async () => {} } as unknown as WsHub;
    server = startHttp({ port: 0, token: () => 't', staticDir: null, mcp: async () => new Response('mcp'), mcpProxy: async () => new Response('proxy'), oauthCallback: async () => new Response('cb'), hub, health: () => ({ lanes: ['D2'] }) });
    const p = server.port!;
    for (const path of ['/healthz', '/ws?token=t', '/']) {
      const r = await rawGet(p, path, 'evil.test');
      expect(r.split('\r\n')[0]).toBe('HTTP/1.1 421 Misdirected Request');
      expect(r).not.toContain('D2');
    }
    expect((await rawGet(p, '/healthz', `evil.test:${p}`)).split('\r\n')[0]).toContain('421');
    expect(await rawGet(p, '/healthz', `127.0.0.1:${p}`)).toContain('"D2"');
    expect(await rawGet(p, '/healthz', `localhost:${p}`)).toContain('"D2"');
    expect(await rawGet(p, '/mcp', 'evil.test')).toContain('mcp');
  });
});

describe('v2.2 §5.3 /oauth/mcp/callback on the Mac port', () => {
  test('§5.3 GET reaches the OAuth callback; POST → 405; a foreign Host → 421 (never served to a rebinding page)', async () => {
    const hub = { open() {}, close() {}, message: async () => {} } as unknown as WsHub;
    server = startHttp({ port: 0, token: () => 't', staticDir: null, mcp: async () => new Response('mcp'), mcpProxy: async () => new Response('proxy'), oauthCallback: async () => new Response('cb-hit'), hub });
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/oauth/mcp/callback?state=x`)).text()).toBe('cb-hit');
    expect((await fetch(`${base}/oauth/mcp/callback`, { method: 'POST' })).status).toBe(405);
    expect((await rawGet(server.port!, '/oauth/mcp/callback?state=x', 'evil.test')).split('\r\n')[0]).toContain('421');
  });
});

describe('v2.5 §5.4 /mcp-graph on the Mac port', () => {
  test('a loopback peer reaches the gate; a non-loopback peer (even with a loopback Host) → 403, never the gate; foreign Host → 421', async () => {
    const hub = { open() {}, close() {}, message: async () => {} } as unknown as WsHub;
    let hits = 0;
    server = startHttp({ hostname: '0.0.0.0', port: 0, token: () => 't', staticDir: null, mcp: async () => new Response('mcp'), mcpProxy: async () => new Response('proxy'), oauthCallback: async () => new Response('cb'), mcpGraph: async () => { hits++; return new Response('graph-hit'); }, hub });
    const p = server.port!;
    expect(await rawGet(p, '/mcp-graph', `127.0.0.1:${p}`)).toContain('graph-hit');
    expect((await rawGet(p, '/mcp-graph', 'evil.test')).split('\r\n')[0]).toContain('421');
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (lan) {
      const r = await rawGet(p, '/mcp-graph', `127.0.0.1:${p}`, lan);
      expect(r.split('\r\n')[0]).toContain('403');
    }
    expect(hits).toBe(1);
  });
  test('no gate mounted → 404', async () => {
    const hub = { open() {}, close() {}, message: async () => {} } as unknown as WsHub;
    server = startHttp({ port: 0, token: () => 't', staticDir: null, mcp: async () => new Response('mcp'), mcpProxy: async () => new Response('proxy'), oauthCallback: async () => new Response('cb'), hub });
    expect((await fetch(`http://127.0.0.1:${server.port}/mcp-graph`, { method: 'POST' })).status).toBe(404);
  });
});
