// v2.2 §5.2 / §8 "Integration › Proxy": `/mcp-proxy/<id>` mounted on the real Mac HTTP server, against `fake-mcp`
// (three transports). The upstream token comes from an `UpstreamAuth` double (G3 brings the real OAuth client).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { startFakeMcp, type FakeMcp } from '../../fake-mcp/src/server.ts';
import type { CatalogEntry } from '../src/mcp/catalog.ts';
import { createMcpProxy, HEADERS_TIMEOUT_MS, RESEND_MAX_BYTES, upstreamOf, type McpProxy, type UpstreamAuth } from '../src/mcp/proxy.ts';
import { LOG_RING } from '../src/mcp/proxy-log.ts';
import { CardStore, type SystemPayload } from '../src/cards/store.ts';
import { openDb } from '../src/db.ts';
import { McpLoginCards } from '../src/engine/mcp-login.ts';
import { McpOAuth } from '../src/mcp/oauth.ts';
import { TokenRegistry } from '../src/mcp/server.ts';
import type { Db } from '../src/db.ts';
import { paths } from '../src/paths.ts';
import { buildArgs } from '../src/session/args.ts';
import { writeSessionFiles } from '../src/session/files.ts';
import { startHttp } from '../src/server/http.ts';
import type { WsHub } from '../src/server/ws.ts';

const LANE = 'lane-session-token';
const OTHER = 'other-session-token';
const SECRET = 'UPSTREAM-SECRET-7f3c9a';

/** Test double of G3's OAuth client: a token, a refresh that (optionally) rotates it on the fake server. */
class FakeAuth implements UpstreamAuth {
  refreshes = 0;
  marked: { id: string; scope: string | undefined }[] = [];
  constructor(public current: string | undefined, private readonly onRefresh: () => Promise<'ok' | 'invalid_grant' | 'error'> = () => Promise.resolve('ok')) {}
  token(): string | undefined { return this.current; }
  async refresh(): Promise<'ok' | 'invalid_grant' | 'error'> { this.refreshes += 1; return this.onRefresh(); }
  markNeedsLogin(id: string, scope?: string): void { this.marked.push({ id, scope }); }
}

let tmp: string;
let savedHome: string | undefined;
let fake: FakeMcp;
let catalog: CatalogEntry[];
let server: Server<unknown> | null = null;
let proxy: McpProxy;
let base: string;

const entry = (id: string, kind: 'http' | 'sse', path: string, projectId?: string): CatalogEntry =>
  ({ id, name: id.split(':').at(-1)!, source: projectId ? 'project' : 'user', kind, config: { type: kind, url: `${fake.origin}${path}` }, forLanes: true, ...(projectId ? { projectId } : {}) });

function setup(auth: UpstreamAuth, headersTimeoutMs?: number): void {
  const tokens = new TokenRegistry({} as Db);
  const who = { role: 'lane' as const, projectId: 'p1' };
  tokens.register('s1', LANE, { mcpIds: new Set(['user:v3', 'user:v2', 'user:legacy', 'user:gone']), cwd: '/w', graph: false }, who);
  tokens.register('s2', OTHER, { mcpIds: new Set(['project:p2:x']), cwd: '/w', graph: false }, { role: 'lane', projectId: 'p2' });
  proxy = createMcpProxy({ tokens, upstream: (id) => upstreamOf(catalog, id), auth, ...(headersTimeoutMs ? { headersTimeoutMs } : {}) });
  server = startHttp({ port: 0, token: () => 'ws', staticDir: null, mcp: async () => new Response('mcp'), mcpProxy: (r) => proxy.handle(r), oauthCallback: async () => new Response('cb'), hub: {} as WsHub });
  base = `http://127.0.0.1:${server.port}`;
}

const url = (id: string, sub = '') => `${base}/mcp-proxy/${encodeURIComponent(id)}${sub}`;
const rpc = (method: string, params: unknown = {}, id: number | null = 1) => JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params });
const post = (id: string, body: string, headers: Record<string, string> = {}, token = LANE) =>
  fetch(url(id), { method: 'POST', body, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });

/** Reads SSE events (block + arrival time) until `n` events, the end, or `ms`. */
async function events(res: { body: ReadableStream<Uint8Array> | null }, n: number, ms = 5000): Promise<{ text: string; at: number }[]> {
  const out: { text: string; at: number }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const end = Date.now() + ms;
  try {
    while (out.length < n && Date.now() < end) {
      const r = await Promise.race([reader.read(), Bun.sleep(end - Date.now()).then(() => null)]);
      if (!r || r.done) break;
      buf += dec.decode(r.value, { stream: true });
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) { out.push({ text: buf.slice(0, i), at: Date.now() }); buf = buf.slice(i + 2); }
    }
  } catch { /* stream errored: the caller checks what arrived */ }
  void reader.cancel().catch(() => {});
  return out;
}
const dataOf = (ev: { text: string }) => JSON.parse(/^data: (.*)$/m.exec(ev.text)![1]!);
const seenSince = (n: number) => fake.seen.slice(n);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-mcp-proxy-'));
  savedHome = process.env.CC_SLAVES_HOME;
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  fake = startFakeMcp();
  catalog = [entry('user:v3', 'http', '/v3/mcp'), entry('user:v2', 'http', '/v2/mcp'), entry('user:legacy', 'sse', '/sse'), entry('project:p2:x', 'http', '/v3/mcp', 'p2')];
});
afterEach(() => {
  void server?.stop(true);
  server = null;
  Object.assign(fake.knobs, { headerDelayMs: 0, requireToken: null, forbidScope: null, failStatus: null, endpointOrigin: null });
});
afterAll(() => {
  fake.stop();
  if (savedHome === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('§5.2 transports', () => {
  test('§3-7 2026-07-28 streamable: server/discover, initialize, tools/list forwarded byte-for-byte, Mcp-* both ways', async () => {
    setup(new FakeAuth(undefined));
    const n = fake.seen.length;
    const body = rpc('server/discover');
    const r = await post('user:v3', body, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover', 'mcp-param-x-odd': 'kept' });
    expect(r.status).toBe(200);
    expect(r.headers.get('mcp-protocol-version')).toBe('2026-07-28');
    expect(((await r.json()) as any).result.supportedVersions).toEqual(['2026-07-28']);
    const got = seenSince(n)[0]!;
    expect(got.body).toBe(body);
    expect(got.path).toBe('/v3/mcp');
    expect(got.headers['mcp-method']).toBe('server/discover');
    expect(got.headers['mcp-param-x-odd']).toBe('kept'); // §8: an unknown Mcp-Param-* passes
    expect(got.headers.accept).toBe('application/json, text/event-stream');
    expect(got.headers.authorization).toBeUndefined(); // the lane's session token never leaves; no upstream token yet
    const tools = (await (await post('user:v3', rpc('tools/list'))).json()) as any;
    expect(tools.result.tools[0].name).toBe('tick');
  });

  test('§3-10 2025-11-25: MCP-Session-Id back to the lane, GET SSE stream with Last-Event-ID, DELETE', async () => {
    setup(new FakeAuth(undefined));
    const init = await post('user:v2', rpc('initialize', { protocolVersion: '2025-11-25' }));
    const sid = init.headers.get('mcp-session-id')!;
    expect(sid).toMatch(/[0-9a-f-]{36}/);
    expect((await post('user:v2', rpc('tools/list'), { 'mcp-session-id': sid })).status).toBe(200);
    const get = await fetch(url('user:v2'), { headers: { authorization: `Bearer ${LANE}`, accept: 'text/event-stream', 'mcp-session-id': sid, 'last-event-id': '41' } });
    expect(get.headers.get('content-type')).toBe('text/event-stream');
    const first = await events(get, 1);
    expect(dataOf(first[0]!).params.resumedAfter).toBe(41);
    const del = await fetch(url('user:v2'), { method: 'DELETE', headers: { authorization: `Bearer ${LANE}`, 'mcp-session-id': sid } });
    expect(del.status).toBe(204);
    expect((await post('user:v2', rpc('tools/list'), { 'mcp-session-id': sid })).status).toBe(404);
  });

  test('§5.2 legacy HTTP+SSE: same-origin endpoint rewritten to the proxy path; POST there answers on the stream', async () => {
    setup(new FakeAuth(undefined));
    const res = await fetch(url('user:legacy'), { headers: { authorization: `Bearer ${LANE}`, accept: 'text/event-stream' } });
    const [ep] = await events(res.clone(), 1);
    const path = /^data: (.*)$/m.exec(ep!.text)![1]!;
    expect(path).toMatch(/^\/mcp-proxy\/user%3Alegacy\/messages\?sessionId=[0-9a-f-]{36}$/);
    const reader = events(res, 2, 3000);
    const p = await fetch(`${base}${path}`, { method: 'POST', body: rpc('tools/list', {}, 7), headers: { authorization: `Bearer ${LANE}`, 'content-type': 'application/json' } });
    expect(p.status).toBe(202);
    const evs = await reader;
    expect(evs.map((e) => e.text).find((t) => t.includes('"id":7'))).toContain('"tick"');
  });

  test('§8 SSE is not buffered: tick events arrive as they are sent', async () => {
    setup(new FakeAuth(undefined));
    const res = await post('user:v3', rpc('tools/call', { name: 'tick', arguments: { n: 5, ms: 200 } }));
    const evs = await events(res, 6);
    expect(evs).toHaveLength(6);
    const delays = evs.slice(0, 5).map((e) => e.at - dataOf(e).params.sentAt);
    process.stdout.write(`SSE arrival delay through proxy (ms): ${delays.join(', ')}\n`);
    expect(Math.max(...delays)).toBeLessThan(50);
    expect(evs[4]!.at - evs[0]!.at).toBeGreaterThanOrEqual(700);
  });

  test('§5.2 lane disconnect aborts the upstream request', async () => {
    setup(new FakeAuth(undefined));
    const sid = (await post('user:v2', rpc('initialize'))).headers.get('mcp-session-id')!;
    const before = fake.cancelled();
    const ac = new AbortController();
    const get = await fetch(url('user:v2'), { signal: ac.signal, headers: { authorization: `Bearer ${LANE}`, accept: 'text/event-stream', 'mcp-session-id': sid } });
    expect(get.status).toBe(200);
    ac.abort();
    const end = Date.now() + 3000;
    while (fake.cancelled() === before && Date.now() < end) await Bun.sleep(20);
    expect(fake.cancelled()).toBe(before + 1);
  });
});

describe('§5.2 lane side checks', () => {
  test('§5.2 a wrong or missing session token → 401 without WWW-Authenticate, upstream never called', async () => {
    setup(new FakeAuth(undefined));
    const n = fake.seen.length;
    for (const r of [await post('user:v3', rpc('initialize'), {}, 'nope'), await fetch(url('user:v3'), { method: 'POST', body: rpc('initialize') })]) {
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBeNull();
    }
    expect(seenSince(n)).toHaveLength(0);
  });

  test('§5.2 any Origin (even http://127.0.0.1:3000) → 403, upstream never called', async () => {
    setup(new FakeAuth(undefined));
    const n = fake.seen.length;
    for (const origin of ['http://127.0.0.1:3000', 'null', 'https://evil.test']) {
      expect((await post('user:v3', rpc('initialize'), { origin })).status).toBe(403);
    }
    expect(seenSince(n)).toHaveLength(0);
  });

  test('§5.2 C19 valid token + id outside the session mcpIds (other project, off, unknown) → 403, never forwarded, logged', async () => {
    setup(new FakeAuth(undefined));
    const n = fake.seen.length;
    for (const id of ['project:p2:x', 'user:off', 'plugin:x@y:z']) expect((await post(id, rpc('initialize'))).status).toBe(403);
    expect((await post('user:v3', rpc('initialize'), {}, OTHER)).status).toBe(403);
    expect(seenSince(n)).toHaveLength(0);
    expect(proxy.log.lines('project:p2:x').at(-1)).toMatchObject({ status: 403, error: 'not_allowed' });
    expect(proxy.log.lines('plugin:x@y:z')).toHaveLength(0); // an unknown id never creates a log
  });

  test('§5.2 the configured URL only: a sub-path cannot reach another host', async () => {
    setup(new FakeAuth(undefined));
    const n = fake.seen.length;
    const r = await fetch(url('user:v3', '//evil.test/x'), { method: 'POST', body: rpc('ping'), headers: { authorization: `Bearer ${LANE}` } });
    expect(r.status).toBe(404); // fake-mcp's own 404: the request stayed on its origin
    expect(seenSince(n)).toHaveLength(1);
    expect(seenSince(n)[0]!.path).toEndWith('/evil.test/x');
  });
});

describe('§5.2 upstream outcomes', () => {
  test('§5.2 public server: forwarded without Authorization, runs normally', async () => {
    setup(new FakeAuth(undefined));
    const n = fake.seen.length;
    expect((await post('user:v3', rpc('initialize'))).status).toBe(200);
    expect(seenSince(n)[0]!.headers.authorization).toBeUndefined();
  });

  test('§5.2 an upstream token replaces the lane Authorization', async () => {
    setup(new FakeAuth(SECRET));
    fake.knobs.requireToken = SECRET;
    const n = fake.seen.length;
    expect((await post('user:v3', rpc('initialize'))).status).toBe(200);
    expect(seenSince(n)[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  test('§5.2 no token + upstream 401 → 401 without WWW-Authenticate, server "Cần đăng nhập"', async () => {
    const auth = new FakeAuth(undefined);
    setup(auth);
    fake.knobs.requireToken = 'x';
    const r = await post('user:v3', rpc('initialize'));
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect(auth.marked).toEqual([{ id: 'user:v3', scope: undefined }]);
    expect(proxy.log.lines('user:v3').at(-1)).toMatchObject({ status: 401, error: 'needs_login' });
  });

  test('§5.2 no headers within the limit → 504 "Lỗi mạng", token kept, no refresh', async () => {
    expect(HEADERS_TIMEOUT_MS).toBe(5000);
    const auth = new FakeAuth(SECRET);
    setup(auth, 300);
    fake.knobs.headerDelayMs = 1000;
    const t0 = Date.now();
    const r = await post('user:v3', rpc('initialize'));
    expect(r.status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(900);
    expect(auth.current).toBe(SECRET);
    expect(auth.refreshes).toBe(0);
    expect(proxy.log.lines('user:v3').at(-1)).toMatchObject({ status: 504, error: 'timeout' });
  });

  test('§5.2 403 insufficient_scope → 403 to the lane, no refresh, markNeedsLogin(id, scope)', async () => {
    const auth = new FakeAuth(SECRET);
    setup(auth);
    fake.knobs.forbidScope = 'files:write';
    const r = await post('user:v3', rpc('initialize'));
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect(auth.refreshes).toBe(0);
    expect(auth.marked).toEqual([{ id: 'user:v3', scope: 'files:write' }]);
  });
  test('§8 403 insufficient_scope → "Cần đăng nhập lại (thiếu quyền)" + K13 card (real OAuth client + card store)', async () => {
    const cards = new CardStore({ db: openDb(':memory:'), sessions: { writeControl: () => true, askOpen: () => {}, askClose: () => {}, deliver: () => {} } });
    const k13: { c: McpLoginCards | null } = { c: null };
    const oauth = new McpOAuth({
      keychain: () => ({ code: 44, stdout: '', stderr: 'could not be found' }), redirectBase: () => base, open: () => {},
      server: (id) => { const u = upstreamOf(catalog, id); return u ? { id, name: id.split(':')[1]!, url: u.url } : undefined; },
      onChange: (id) => k13.c?.sync(id),
    });
    k13.c = new McpLoginCards({ cards, view: (id) => oauth.view(id), name: () => 'v3', missing: () => [{ name: 'D2', projectId: 'p1' }] });
    setup(oauth);
    fake.knobs.forbidScope = 'files:write';
    try {
      expect((await post('user:v3', rpc('initialize'))).status).toBe(403);
      expect(oauth.view('user:v3')!.needsLogin).toEqual({ reason: 'insufficient_scope', scope: 'files:write' });
      const card = cards.findOpenSystem('mcp_login', 'user:v3', null)!;
      expect(card.projectId).toBeNull();
      expect((card.payload as SystemPayload).title).toBe('MCP v3 cần đăng nhập lại (thiếu quyền: files:write) · D2 đang thiếu công cụ này');
    } finally { oauth.stop(); }
  });

  test('§5.2 401 → one refresh → resend with the new token (body kept)', async () => {
    const auth: FakeAuth = new FakeAuth('old', () => { auth.current = 'new'; return Promise.resolve('ok'); });
    setup(auth);
    fake.knobs.requireToken = 'new';
    const n = fake.seen.length;
    const body = rpc('tools/list', {}, 9);
    const r = await post('user:v3', body);
    expect(r.status).toBe(200);
    expect(auth.refreshes).toBe(1);
    const s = seenSince(n);
    expect(s.map((x) => x.headers.authorization)).toEqual(['Bearer old', 'Bearer new']);
    expect(s[1]!.body).toBe(body);
  });

  test('§5.2 two concurrent 401s share one refresh', async () => {
    const auth: FakeAuth = new FakeAuth('old', async () => { await Bun.sleep(100); auth.current = 'new'; return 'ok'; });
    setup(auth);
    fake.knobs.requireToken = 'new';
    const rs = await Promise.all([post('user:v3', rpc('tools/list')), post('user:v3', rpc('initialize')), post('user:v3', rpc('ping'))]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(auth.refreshes).toBe(1);
  });

  test('§5.2 refresh invalid_grant → 401 without WWW-Authenticate, "Cần đăng nhập lại"', async () => {
    const auth = new FakeAuth('old', () => Promise.resolve('invalid_grant'));
    setup(auth);
    fake.knobs.requireToken = 'never';
    const r = await post('user:v3', rpc('initialize'));
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect(auth.refreshes).toBe(1);
    expect(auth.marked).toEqual([{ id: 'user:v3', scope: undefined }]);
  });

  test('§5.2 a POST body over 4 MB is not resent after a 401 (no refresh)', async () => {
    const auth = new FakeAuth('old');
    setup(auth);
    fake.knobs.requireToken = 'new';
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(RESEND_MAX_BYTES) } });
    const r = await post('user:v3', big);
    expect(r.status).toBe(401);
    expect(auth.refreshes).toBe(0);
  });

  test('§5.2 5xx and network errors → error to the lane, token kept', async () => {
    const auth = new FakeAuth(SECRET);
    setup(auth);
    fake.knobs.failStatus = 503;
    expect((await post('user:v3', rpc('initialize'))).status).toBe(503);
    const dead = startFakeMcp();
    dead.stop();
    catalog.push({ ...entry('user:gone', 'http', '/v3/mcp'), config: { type: 'http', url: `${dead.origin}/v3/mcp` } });
    try {
      const r = await post('user:gone', rpc('initialize'));
      expect(r.status).toBe(502);
      expect(proxy.log.lines('user:gone').at(-1)).toMatchObject({ status: 502, error: 'network' });
    } finally { catalog.pop(); }
    expect(auth.current).toBe(SECRET);
    expect(auth.refreshes).toBe(0);
  });

  test('§5.2 legacy endpoint on another host → stream closed, no endpoint reaches the lane, server error logged', async () => {
    setup(new FakeAuth(SECRET));
    fake.knobs.endpointOrigin = 'http://evil.test:1234';
    const res = await fetch(url('user:legacy'), { headers: { authorization: `Bearer ${LANE}`, accept: 'text/event-stream' } });
    const evs = await events(res, 1, 1500);
    expect(evs).toHaveLength(0);
    expect(proxy.log.lines('user:legacy').at(-1)).toMatchObject({ error: 'endpoint_foreign' });
  });
  test('§8 a GET SSE stream through the proxy survives one token refresh', async () => {
    const auth: FakeAuth = new FakeAuth('old', () => { auth.current = 'new'; return Promise.resolve('ok'); });
    setup(auth);
    fake.knobs.requireToken = 'old';
    const sid = (await post('user:v2', rpc('initialize'))).headers.get('mcp-session-id')!;
    const get = await fetch(url('user:v2'), { headers: { authorization: `Bearer ${LANE}`, accept: 'text/event-stream', 'mcp-session-id': sid } });
    expect(get.status).toBe(200);
    const reader = events(get, 2, 3000);
    fake.knobs.requireToken = 'new'; // the AS rotated: the old token is dead upstream
    expect((await post('user:v2', rpc('tools/list', {}, 5), { 'mcp-session-id': sid })).status).toBe(200);
    expect(auth.refreshes).toBe(1);
    fake.push({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    expect((await reader).map((e) => e.text).join('\n')).toContain('notifications/tools/list_changed');
  });
});

describe('§5.2 secrets and log', () => {
  test('§8 the upstream token is never in the session MCP file, argv or the proxy log; sse entries keep their type', async () => {
    setup(new FakeAuth(SECRET));
    fake.knobs.requireToken = SECRET;
    for (const id of ['user:v3', 'user:legacy']) await post(id, rpc('initialize'));
    const files = writeSessionFiles('sess-x', { port: 47800, projectId: 'p1', catalog });
    const mcpFile = readFileSync(files.mcpPath, 'utf8');
    expect(JSON.parse(mcpFile).mcpServers.legacy).toMatchObject({ type: 'sse', url: 'http://127.0.0.1:47800/mcp-proxy/user%3Alegacy' });
    const argv = buildArgs({ sessionId: 'sess-x', resume: false, settingsPath: files.settingsPath, mcpConfigPath: files.mcpPath, appendSystemPrompt: '', addDirs: [] });
    const logs = readdirSync(paths().logsDir).filter((f) => f.startsWith('mcp-')).map((f) => readFileSync(join(paths().logsDir, f), 'utf8'));
    expect(logs.length).toBeGreaterThan(0);
    for (const text of [mcpFile, argv.join(' '), ...logs, JSON.stringify(proxy.log.lines('user:v3'))]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(LANE);
    }
  });

  test('§5.2 log ring: 200 lines in memory and file, method / path / status / ms, never a body', async () => {
    setup(new FakeAuth(undefined));
    for (let i = 0; i < LOG_RING + 5; i++) await post('user:v3', rpc('tools/list', { marker: 'BODY-MARK' }));
    expect(proxy.log.lines('user:v3')).toHaveLength(LOG_RING);
    const file = readFileSync(paths().mcpLog('user:v3'), 'utf8').trim().split('\n');
    expect(file.length).toBeLessThanOrEqual(2 * LOG_RING);
    expect(file.length).toBeGreaterThanOrEqual(LOG_RING);
    expect(JSON.parse(file.at(-1)!)).toMatchObject({ method: 'POST', path: '/', status: 200 });
    expect(typeof JSON.parse(file.at(-1)!).ms).toBe('number');
    expect(file.join('\n')).not.toContain('BODY-MARK');
  });
});
