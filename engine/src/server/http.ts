// Mac web server (spec §7.2 N1): 127.0.0.1:47800 — static `web/dist` (SPA fallback), `/mcp` (sessions' engine MCP),
// `/mcp-proxy/<id>` (v2.2 §5.2, sessions' remote MCP servers), `/mcp-graph` (v2.5 §5.4, sessions' graph tool; loopback peers only), `/oauth/mcp/callback` (v2.2 §5.3, the browser's OAuth
// redirect; Mac port + loopback peers only, never a tunnel mount),
// `/ws` (localhost token + app Origin), `/attach*` (v2.4 §10.2: Bearer token, app Origin on writes), `/healthz`. The tunnel port 47801 (JWT + paired device) is group 5.
import { timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import type { ServerMsg } from '../../../shared/protocol.ts';
import type { Conn, WsHub } from './ws.ts';

export const MAC_PORT = 47800;
const TOKEN_PROTOCOL_PREFIX = 'ccs-token.';
const appOrigins = (port: number): string[] => [`http://127.0.0.1:${port}`, 'tauri://localhost'];

export interface HttpDeps {
  hostname?: string;
  port: number;
  token: () => string;
  staticDir: string | null;
  mcp: (req: Request) => Promise<Response>;
  /** v2.9 §5.9 `/mcp-draft` the author session's `draft_save` (Mac port only, loopback peers only). Absent → 404. */
  mcpDraft?: (req: Request) => Promise<Response>;
  /** v2.2 §5.2 `/mcp-proxy/<id>` (Mac port only, loopback peers only). */
  mcpProxy: (req: Request) => Promise<Response>;
  /** v2.5 §5.4 `/mcp-graph` (Mac port only, loopback peers only). Absent → 404. */
  mcpGraph?: (req: Request) => Promise<Response>;
  /** v2.2 §5.3 `GET /oauth/mcp/callback` (Mac port only, loopback peers only). */
  oauthCallback: (req: Request) => Promise<Response>;
  /** v2.4 §10.2 `/attach*` (Mac listener only; never mounted on a tunnel listener, §8). Absent → 404. */
  attach?: (req: Request) => Promise<Response>;
  hub: WsHub;
  /** False while the engine is still starting: `/ws` and `/healthz` answer 503 (no WS before the hub exists). */
  ready?: () => boolean;
  /** `/healthz` body (menu bar); default `{ ok: true }`. */
  health?: () => unknown;
  /** Default: appOrigins(actual port). */
  origins?: () => string[];
}

interface WsData { conn: Conn | null; protocol: string | null }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Token from `Authorization: Bearer`, `?token=`, or a `ccs-token.<token>` WebSocket subprotocol (browsers can't set headers). */
function wsToken(req: Request): { token: string | null; protocol: string | null } {
  const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (auth) return { token: auth[1]!, protocol: null };
  const q = new URL(req.url).searchParams.get('token');
  if (q) return { token: q, protocol: null };
  for (const p of (req.headers.get('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim())) {
    if (p.startsWith(TOKEN_PROTOCOL_PREFIX)) return { token: p.slice(TOKEN_PROTOCOL_PREFIX.length), protocol: p };
  }
  return { token: null, protocol: null };
}

function staticFile(dir: string, pathname: string): Response {
  const root = resolve(dir);
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { return new Response('bad path', { status: 400 }); }
  const file = resolve(root, `.${rel}`);
  if (file !== root && !file.startsWith(root + sep)) return new Response('not found', { status: 404 });
  const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
  // SPA: `/`, `/c/<id>` and any extension-less route → index.html; a missing asset with an extension → 404.
  const target = isFile(file) ? file : !extname(rel) || rel.startsWith('/c/') ? join(root, 'index.html') : null;
  if (!target || !isFile(target)) return new Response('not found', { status: 404 });
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  return new Response(Bun.file(target), { headers: { 'content-type': type, 'x-content-type-options': 'nosniff' } });
}

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const loopbackHost = (host: string | null, port: number): boolean =>
  host === `127.0.0.1:${port}` || host === `localhost:${port}`;

export function startHttp(d: HttpDeps): Server<WsData> {
  const server: Server<WsData> = Bun.serve<WsData>({
    hostname: d.hostname ?? '127.0.0.1',
    port: d.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // M3: a DNS-rebinding page reaches us with its own Host; only loopback names are served (`/mcp` has its own checks)
      if (url.pathname !== '/mcp' && !loopbackHost(req.headers.get('host'), server.port ?? d.port)) {
        return new Response('misdirected request', { status: 421 });
      }
      if ((url.pathname === '/healthz' || url.pathname === '/ws') && d.ready && !d.ready()) {
        return Response.json({ starting: true }, { status: 503, headers: { 'retry-after': '1', 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/healthz') return Response.json(d.health?.() ?? { ok: true }, { headers: { 'cache-control': 'no-store' } });
      if (url.pathname === '/mcp') return d.mcp(req);
      if (url.pathname === '/mcp-draft' && d.mcpDraft) {
        if (!LOOPBACK_IPS.has(srv.requestIP(req)?.address ?? '')) return new Response('forbidden', { status: 403 });
        return d.mcpDraft(req);
      }
      if (url.pathname.startsWith('/mcp-proxy/')) {
        if (!LOOPBACK_IPS.has(srv.requestIP(req)?.address ?? '')) return new Response('forbidden', { status: 403 });
        return d.mcpProxy(req);
      }
      if (url.pathname === '/mcp-graph') {
        if (!LOOPBACK_IPS.has(srv.requestIP(req)?.address ?? '')) return new Response('forbidden', { status: 403 });
        return d.mcpGraph ? d.mcpGraph(req) : new Response('not found', { status: 404 });
      }
      if (url.pathname === '/oauth/mcp/callback') {
        if (!LOOPBACK_IPS.has(srv.requestIP(req)?.address ?? '')) return new Response('forbidden', { status: 403 });
        if (req.method !== 'GET') return new Response('method not allowed', { status: 405, headers: { 'cache-control': 'no-store' } });
        return d.oauthCallback(req);
      }
      if (url.pathname === '/attach' || url.pathname.startsWith('/attach/')) {
        // Bearer only: a `?token=` would sit in a URL an `<img>` or a log could leak (§10.2).
        const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
        if (!bearer || !sameSecret(bearer, d.token())) return new Response('unauthorized', { status: 401 });
        const origins = d.origins?.() ?? appOrigins(server.port ?? d.port);
        if (req.method !== 'GET' && !origins.includes(req.headers.get('origin') ?? '')) return new Response('origin not allowed', { status: 403 });
        return d.attach ? d.attach(req) : new Response('not found', { status: 404 });
      }
      if (url.pathname === '/ws') {
        const { token, protocol } = wsToken(req);
        if (token === null || !sameSecret(token, d.token())) return new Response('unauthorized', { status: 401 });
        const origins = d.origins?.() ?? appOrigins(server.port ?? d.port);
        if (!origins.includes(req.headers.get('origin') ?? '')) return new Response('origin not allowed', { status: 403 });
        const ok = srv.upgrade(req, { data: { conn: null, protocol }, ...(protocol ? { headers: { 'sec-websocket-protocol': protocol } } : {}) });
        return ok ? undefined : new Response('upgrade failed', { status: 400 });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
      if (!d.staticDir || !existsSync(d.staticDir)) return new Response('Giao diện chưa được build (web/dist)', { status: 404 });
      return staticFile(d.staticDir, url.pathname);
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const conn: Conn = { channel: 'mac', watch: null, present: false, send: (m: ServerMsg) => { ws.send(JSON.stringify(m)); } };
        ws.data.conn = conn;
        d.hub.open(conn);
      },
      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        if (ws.data.conn) void d.hub.message(ws.data.conn, typeof msg === 'string' ? msg : msg.toString('utf8'));
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.conn) d.hub.close(ws.data.conn);
      },
    },
  });
  return server;
}
