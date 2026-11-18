// Fake MCP server for integration tests (spec v2.2 §8 "Integration › fake-mcp"): one Bun.serve on 127.0.0.1 speaking the
// three transports the proxy must carry (§3-7, §3-10):
//   /v3/mcp   2026-07-28 streamable HTTP, stateless (`server/discover`, no session, no GET stream)
//   /v2/mcp   2025-11-25 streamable HTTP with `MCP-Session-Id`, a GET SSE stream and DELETE
//   /sse      legacy HTTP+SSE (2024-11-05): GET opens the stream, its `endpoint` event names the POST URL
// Every transport answers `initialize`, `tools/list` and one tool, `tick` ({ n, ms }: n progress events `ms` apart over SSE
// when the client accepts it). Knobs (mutable at any time) inject the failures the proxy must handle.
// Extension point for G3: `routes` runs first on every request — the fake OAuth AS (PRM, AS metadata, DCR, PKCE, rotating
// refresh) mounts there and sets `knobs.requireToken` to the access token it issued.

interface FakeMcpKnobs {
  /** Delay before the response headers (the proxy's 5 s connect + headers timeout). */
  headerDelayMs: number;
  /** Set: every MCP request needs `Authorization: Bearer <this>`, else 401 with a `resource_metadata` challenge. */
  requireToken: string | null;
  /** Set: 403 `insufficient_scope` naming this scope. */
  forbidScope: string | null;
  /** Set: answer every MCP request with this status (5xx tests). */
  failStatus: number | null;
  /** Set: the legacy `endpoint` event points at this origin (`http://evil.test:1234`) instead of a relative path. */
  endpointOrigin: string | null;
}

interface SeenRequest { method: string; path: string; headers: Record<string, string>; body: string }

export interface FakeMcpOptions {
  /** G3 hook (the fake OAuth AS, ./oauth-as.ts): answer a request before the MCP routes (undefined = fall through). */
  routes?: (req: Request, url: URL, body: string) => Promise<Response | undefined>;
}

export interface FakeMcp {
  port: number;
  origin: string;
  knobs: FakeMcpKnobs;
  /** Every request that reached the server, in order (headers lower-cased). */
  seen: SeenRequest[];
  /** SSE streams the client cancelled (lane disconnect → upstream aborted). */
  cancelled: () => number;
  /** Pushes one JSON-RPC notification on every open GET / legacy stream. */
  push: (msg: unknown) => void;
  stop: () => void;
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const TOOL = { name: 'tick', description: 'Emits n progress events ms apart', inputSchema: { type: 'object', properties: { n: { type: 'number' }, ms: { type: 'number' } } } };
const INFO = { name: 'fake-mcp', version: '1.0.0' };
const enc = new TextEncoder();
const sse = (event: string | null, data: unknown, id?: number): string =>
  `${event ? `event: ${event}\n` : ''}${id !== undefined ? `id: ${id}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Stream { push: (chunk: string) => void; close: () => void }

export function startFakeMcp(o: FakeMcpOptions = {}): FakeMcp {
  const knobs: FakeMcpKnobs = { headerDelayMs: 0, requireToken: null, forbidScope: null, failStatus: null, endpointOrigin: null };
  const seen: SeenRequest[] = [];
  const v2Sessions = new Set<string>();
  const legacy = new Map<string, Stream>();
  const getStreams = new Set<Stream>();
  let cancelled = 0;

  /** A text/event-stream response; `start` gets a pusher. Cancel (client gone) counts and stops the producer. */
  const stream = (start: (s: Stream) => void, headers: Record<string, string> = {}): Response => {
    let open = true;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        start({
          push: (chunk) => { if (open) c.enqueue(enc.encode(chunk)); },
          close: () => { if (open) { open = false; c.close(); } },
        });
      },
      cancel() { open = false; cancelled += 1; },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', ...headers } });
  };

  const result = (m: Rpc, protocolVersion: string): unknown => {
    switch (m.method) {
      case 'server/discover':
        return { jsonrpc: '2.0', id: m.id, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: INFO } };
      case 'initialize':
        return { jsonrpc: '2.0', id: m.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: INFO } };
      case 'tools/list':
        return { jsonrpc: '2.0', id: m.id, result: { tools: [TOOL] } };
      case 'tools/call':
        return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'done' }] } };
      default:
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${String(m.method)}` } };
    }
  };

  /** `tick` over SSE: n notifications `ms` apart, then the result. */
  const tick = (m: Rpc, headers: Record<string, string> = {}): Response => {
    const n = Number(m.params?.arguments && (m.params.arguments as Record<string, unknown>).n) || 3;
    const ms = Number(m.params?.arguments && (m.params.arguments as Record<string, unknown>).ms) || 100;
    return stream((s) => {
      let i = 0;
      const step = (): void => {
        if (i < n) {
          s.push(sse(null, { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: i, sentAt: Date.now() } }, i));
          i += 1;
          setTimeout(step, ms);
          return;
        }
        s.push(sse(null, result(m, ''), i));
        s.close();
      };
      step();
    }, headers);
  };

  const gate = (req: Request): Response | null => {
    if (knobs.failStatus !== null) return json(knobs.failStatus, { error: 'injected' });
    if (knobs.requireToken !== null && req.headers.get('authorization') !== `Bearer ${knobs.requireToken}`) {
      return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="http://${req.headers.get('host') ?? ''}/.well-known/oauth-protected-resource"` });
    }
    if (knobs.forbidScope !== null) {
      return json(403, { error: 'forbidden' }, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${knobs.forbidScope}"` });
    }
    return null;
  };

  const v3 = (req: Request, m: Rpc): Response => {
    if (req.method !== 'POST') return json(405, { error: 'stateless: POST only' }, { allow: 'POST' });
    if (m.method === 'tools/call' && (req.headers.get('accept') ?? '').includes('text/event-stream')) return tick(m);
    if (m.id === undefined || m.id === null) return new Response(null, { status: 202 });
    return json(200, result(m, '2026-07-28'), { 'mcp-protocol-version': '2026-07-28' });
  };

  const v2 = (req: Request, m: Rpc): Response => {
    const sid = req.headers.get('mcp-session-id');
    if (req.method === 'POST' && m.method === 'initialize') {
      const id = crypto.randomUUID();
      v2Sessions.add(id);
      return json(200, result(m, '2025-11-25'), { 'mcp-session-id': id });
    }
    if (sid === null || !v2Sessions.has(sid)) return json(404, { error: 'unknown session' });
    if (req.method === 'DELETE') { v2Sessions.delete(sid); return new Response(null, { status: 204 }); }
    if (req.method === 'GET') {
      const last = Number(req.headers.get('last-event-id') ?? '-1');
      return stream((s) => {
        getStreams.add(s);
        s.push(sse(null, { jsonrpc: '2.0', method: 'notifications/message', params: { resumedAfter: last } }, last + 1));
      });
    }
    if (m.method === 'tools/call' && (req.headers.get('accept') ?? '').includes('text/event-stream')) return tick(m);
    if (m.id === undefined || m.id === null) return new Response(null, { status: 202 });
    return json(200, result(m, '2025-11-25'));
  };

  const legacySse = (req: Request, url: URL, m: Rpc): Response => {
    if (url.pathname === '/sse' && req.method === 'GET') {
      const id = crypto.randomUUID();
      const path = `/messages?sessionId=${id}`;
      return stream((s) => {
        legacy.set(id, s);
        s.push(sse('endpoint', knobs.endpointOrigin ? `${knobs.endpointOrigin}${path}` : path));
      });
    }
    const s = legacy.get(url.searchParams.get('sessionId') ?? '');
    if (url.pathname !== '/messages' || req.method !== 'POST' || !s) return json(404, { error: 'unknown legacy session' });
    if (m.id !== undefined && m.id !== null) s.push(sse('message', result(m, '2024-11-05')));
    return new Response('Accepted', { status: 202 });
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      seen.push({ method: req.method, path: url.pathname + url.search, headers, body });
      const extra = await o.routes?.(req, url, body);
      if (extra) return extra;
      if (knobs.headerDelayMs > 0) await Bun.sleep(knobs.headerDelayMs);
      const blocked = gate(req);
      if (blocked) return blocked;
      let m: Rpc = {};
      if (body) { try { m = JSON.parse(body) as Rpc; } catch { return json(400, { error: 'parse error' }); } }
      if (url.pathname === '/v3/mcp') return v3(req, m);
      if (url.pathname === '/v2/mcp') return v2(req, m);
      if (url.pathname === '/sse' || url.pathname === '/messages') return legacySse(req, url, m);
      return json(404, { error: 'not found' });
    },
  });
  const port = server.port ?? 0;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    knobs,
    seen,
    cancelled: () => cancelled,
    push: (msg) => {
      for (const s of getStreams) s.push(sse(null, msg));
      for (const s of legacy.values()) s.push(sse('message', msg));
    },
    stop: () => { void server.stop(true); },
  };
}
