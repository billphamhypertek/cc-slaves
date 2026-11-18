// v2.2 §5.2 local MCP proxy, mounted at `/mcp-proxy/<id>` on the Mac port only (never the tunnel port, like `/mcp`).
// A lane's session MCP file points every remote http / sse server here with the session token; the proxy checks the
// token and the session's `mcpIds`, then forwards byte-transparently to the configured URL with the upstream token
// (`UpstreamAuth`, G3 OAuth) — so the real token never sits in a session file, argv or log. Never `WWW-Authenticate`:
// Claude Code must not start its own OAuth against the engine (§3-2).
import type { CatalogEntry } from './catalog.ts';
import { ProxyLog, type ProxyError } from './proxy-log.ts';
import type { TokenRegistry } from './server.ts';

/** The upstream token source: the engine's OAuth client (`McpOAuth`, §5.3). */
export interface UpstreamAuth {
  token(id: string): string | undefined;
  /** One refresh of `id`'s token; the proxy keeps at most one in flight per server. */
  refresh(id: string): Promise<'ok' | 'invalid_grant' | 'error'>;
  /** §5.2 / K13: the server needs a (new) login; `scope` = the missing scope of a 403 `insufficient_scope` (step-up). */
  markNeedsLogin(id: string, scope?: string): void;
}

/** Where `id` really lives: the configured URL, its extra (non-auth) headers, legacy HTTP+SSE or not. */
export interface Upstream { url: string; headers: Record<string, string>; legacySse: boolean }

/** The upstream of a remote http / sse catalog entry (`undefined`: no such id, or not a remote server). */
export function upstreamOf(catalog: readonly CatalogEntry[], id: string): Upstream | undefined {
  const e = catalog.find((x) => x.id === id);
  if (!e || (e.kind !== 'http' && e.kind !== 'sse') || typeof e.config.url !== 'string') return undefined;
  const raw = typeof e.config.headers === 'object' && e.config.headers !== null ? e.config.headers as Record<string, unknown> : {};
  const headers = Object.fromEntries(Object.entries(raw).filter(([k, v]) => typeof v === 'string' && k.toLowerCase() !== 'authorization')) as Record<string, string>;
  return { url: e.config.url, headers, legacySse: e.kind === 'sse' };
}

export interface McpProxyDeps {
  tokens: Pick<TokenRegistry, 'resolve' | 'mcpIds'>;
  upstream: (id: string) => Upstream | undefined;
  auth: UpstreamAuth;
  /** Connect + response headers limit (§5.2: 5 s); an open SSE stream has none. */
  headersTimeoutMs?: number;
  /** The engine's fetch (tests inject one: no network outside localhost). */
  fetch?: typeof fetch;
}

export interface McpProxy {
  /** The `/mcp-proxy/<id>[/<path>]` HTTP handler (lane side: Origin, session token, `mcpIds`). */
  handle(req: Request): Promise<Response>;
  /**
   * In-process forward of one request to `id` (the HTTP handler after its checks; G4b's probe directly, no session
   * token). Only method, headers and body of `req` are used, plus a `/mcp-proxy/<id>/<path>` sub-path if its URL has one.
   */
  forward(id: string, req: Request, signal: AbortSignal): Promise<Response>;
  log: ProxyLog;
}

const PROXY_PREFIX = '/mcp-proxy/';
export const HEADERS_TIMEOUT_MS = 5000;
/** §5.2 a POST body is kept for one resend after a refresh only up to this size. */
export const RESEND_MAX_BYTES = 4 * 1024 * 1024;

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
/** Never sent upstream: the lane's session token, our Host / Origin, framing Bun recomputes, compression Bun negotiates. */
const DROP_OUT = new Set([...HOP_BY_HOP, 'authorization', 'host', 'origin', 'cookie', 'content-length', 'accept-encoding']);
/** Never sent to the lane: an OAuth challenge (§3-2), framing / encoding Bun already undid. */
const DROP_IN = new Set([...HOP_BY_HOP, 'www-authenticate', 'content-length', 'content-encoding']);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function copyHeaders(from: Headers, drop: ReadonlySet<string>): Headers {
  const named = (from.get('connection') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = new Headers();
  from.forEach((v, k) => { if (!drop.has(k) && !named.includes(k)) out.append(k, v); });
  return out;
}

/** `scope` of a 403 `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`; null if it is not that. */
function insufficientScope(res: Response): string | null {
  const h = res.headers.get('www-authenticate') ?? '';
  if (!/error="?insufficient_scope"?/i.test(h)) return null;
  return /scope="([^"]*)"/i.exec(h)?.[1] ?? '';
}

/** `/mcp-proxy/<enc id>[/<path>]` → id + sub-path (with query); null when malformed. */
function parsePath(url: URL): { id: string; sub: string } | null {
  const rest = url.pathname.slice(PROXY_PREFIX.length);
  const slash = rest.indexOf('/');
  const enc = slash < 0 ? rest : rest.slice(0, slash);
  let id: string;
  try { id = decodeURIComponent(enc); } catch { return null; }
  if (!id) return null;
  return { id, sub: slash < 0 ? '' : rest.slice(slash) + url.search };
}

/** The upstream URL: the configured one, or `<path>` on the configured origin (never another host). */
function target(up: Upstream, sub: string): URL {
  const base = new URL(up.url);
  return sub ? new URL(base.origin + sub) : base;
}

const enc = new TextEncoder();

/**
 * §5.2 legacy HTTP+SSE: the `endpoint` event's URL (resolved against the configured URL) becomes the proxy path when it
 * is on the configured scheme + host + port; any other origin closes the stream (`onForeign`) — a token never goes there.
 * Events pass one by one as soon as complete (no other buffering).
 */
function rewriteEndpoint(body: ReadableStream<Uint8Array>, base: URL, proxyPath: string, onForeign: () => void): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  let buf = '';
  const block = (b: string): string | null => {
    if (!/^event:\s*endpoint\s*$/m.test(b)) return b;
    const data = /^data:\s?(.*?)\r?$/m.exec(b)?.[1] ?? '';
    let u: URL;
    try { u = new URL(data, base); } catch { return null; }
    if (u.origin !== base.origin) return null;
    return b.replace(/^data:.*?(\r?)$/m, `data: ${proxyPath}${u.pathname}${u.search}$1`);
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      buf += dec.decode(chunk, { stream: true });
      for (let m = /\r?\n\r?\n/.exec(buf); m; m = /\r?\n\r?\n/.exec(buf)) {
        const end = m.index + m[0].length;
        const out = block(buf.slice(0, end));
        buf = buf.slice(end);
        if (out === null) { onForeign(); c.terminate(); return; }
        c.enqueue(enc.encode(out));
      }
    },
    flush(c) { if (buf) c.enqueue(enc.encode(buf)); },
  }));
}

type Sent = { res: Response } | { fail: 'timeout' | 'network' | 'aborted' };

export function createMcpProxy(d: McpProxyDeps): McpProxy {
  const log = new ProxyLog();
  const refreshing = new Map<string, Promise<'ok' | 'invalid_grant' | 'error'>>();
  const timeoutMs = d.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  const fetchUp = d.fetch ?? fetch;

  /** One refresh per server at a time: concurrent 401s share it. */
  const refreshOnce = (id: string): Promise<'ok' | 'invalid_grant' | 'error'> => {
    let p = refreshing.get(id);
    if (!p) {
      p = d.auth.refresh(id).catch(() => 'error' as const).finally(() => refreshing.delete(id));
      refreshing.set(id, p);
    }
    return p;
  };

  const send = async (url: URL, method: string, headers: Headers, body: ArrayBuffer | null, token: string | undefined, signal: AbortSignal): Promise<Sent> => {
    const h = new Headers(headers);
    if (token !== undefined) h.set('authorization', `Bearer ${token}`);
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), timeoutMs);
    try {
      const res = await fetchUp(url, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.any([signal, timer.signal]) });
      return { res };
    } catch {
      return { fail: signal.aborted ? 'aborted' : timer.signal.aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(t);
    }
  };

  const forward = async (id: string, req: Request, signal: AbortSignal): Promise<Response> => {
    const t0 = performance.now();
    const own = new URL(req.url);
    const prefix = `${PROXY_PREFIX}${encodeURIComponent(id)}`;
    const sub = own.pathname.startsWith(`${prefix}/`) ? own.pathname.slice(prefix.length) + own.search : '';
    const line = (status: number, error?: ProxyError) =>
      log.add(id, { at: Date.now(), method: req.method, path: sub || '/', status, ms: Math.round(performance.now() - t0), ...(error ? { error } : {}) });
    const up = d.upstream(id);
    if (!up) { line(404, 'unknown_server'); return json(404, { error: 'unknown MCP server' }); }
    const url = target(up, sub);
    const headers = copyHeaders(req.headers, DROP_OUT);
    for (const [k, v] of Object.entries(up.headers)) headers.set(k, v);
    const body = req.body ? await req.arrayBuffer() : null;
    const token = d.auth.token(id);

    let sent = await send(url, req.method, headers, body, token, signal);
    if ('res' in sent && sent.res.status === 401) {
      if (token === undefined) {
        d.auth.markNeedsLogin(id);
        line(401, 'needs_login');
        return passOn(sent.res);
      }
      if (body !== null && body.byteLength > RESEND_MAX_BYTES) { line(401, 'needs_login'); return passOn(sent.res); }
      const r = await refreshOnce(id);
      if (r === 'invalid_grant') d.auth.markNeedsLogin(id);
      // invalid_grant → the lane sees the 401 (server "Cần đăng nhập lại"); a network / 5xx refresh keeps the token and
      // reads as an unreachable server (502), not as an auth failure (A3).
      if (r === 'invalid_grant') { line(401, 'needs_login'); return passOn(sent.res); }
      if (r === 'error') { void sent.res.body?.cancel(); line(502, 'network'); return json(502, { error: 'MCP token refresh failed' }); }
      void sent.res.body?.cancel();
      sent = await send(url, req.method, headers, body, d.auth.token(id), signal);
    }
    if ('fail' in sent) {
      if (sent.fail === 'timeout') { line(504, 'timeout'); return json(504, { error: 'MCP server timed out' }); }
      line(502, sent.fail === 'network' ? 'network' : undefined);
      return json(502, { error: 'MCP server unreachable' });
    }
    const res = sent.res;
    if (res.status === 403) {
      const scope = insufficientScope(res);
      if (scope !== null) { d.auth.markNeedsLogin(id, scope || undefined); line(403, 'insufficient_scope'); return passOn(res); }
    }
    line(res.status, res.status === 401 ? 'needs_login' : res.status >= 500 ? 'network' : undefined);
    if (up.legacySse && res.body && (res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
      const body2 = rewriteEndpoint(res.body, new URL(up.url), prefix, () => line(res.status, 'endpoint_foreign'));
      return new Response(body2, { status: res.status, headers: copyHeaders(res.headers, DROP_IN) });
    }
    return passOn(res);
  };

  const handle = async (req: Request): Promise<Response> => {
    // DNS-rebinding guard (as `/mcp`): a lane is a CLI and sends no Origin; any browser page does, localhost included.
    if (req.headers.get('origin') !== null) return json(403, { error: 'origin not allowed' });
    const p = parsePath(new URL(req.url));
    if (!p) return json(404, { error: 'not found' });
    const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    const token = auth?.[1];
    if (token === undefined || !d.tokens.resolve(token)) return json(401, { error: 'unauthorized' });
    if (!d.tokens.mcpIds(token).has(p.id)) {
      // C19: off for this lane / another project / not approved / unknown → never forwarded; logged when it is a server.
      if (d.upstream(p.id)) log.add(p.id, { at: Date.now(), method: req.method, path: p.sub || '/', status: 403, ms: 0, error: 'not_allowed' });
      return json(403, { error: 'MCP server not enabled for this session' });
    }
    return forward(p.id, req, req.signal);
  };

  return { handle, forward, log };
}

/** The upstream response as is (status, body stream), minus hop-by-hop headers and any `WWW-Authenticate`. */
function passOn(res: Response): Response {
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: copyHeaders(res.headers, DROP_IN) });
}
