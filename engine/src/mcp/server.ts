// Engine MCP endpoint (spec §7.7, §7.2 N1): Streamable HTTP, JSON responses only (no SSE stream), handwritten
// JSON-RPC 2.0 — initialize, notifications/initialized, ping, tools/list, tools/call. A fetch handler mountable at
// `/mcp` on the Mac port 47800 only (never the tunnel port). The caller is whoever owns the bearer token.
import type { Db } from '../db.ts';
import { callTool, findTool, listTools, sessionToolText } from './tools.ts';
import type { Identity, Role, ToolDeps } from './tool-kit.ts';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const SERVER_INFO = { name: 'cc-slaves', version: '1.0.0' };

const NO_IDS: ReadonlySet<string> = new Set();

/** What one spawn writes beside its token: the proxied remote ids (v2.2 §5.1) + the session's cwd and graph (v2.5 §5.4). */
export type TokenSpawn = Pick<Identity, 'cwd' | 'graph'> & { mcpIds: ReadonlySet<string> };

/** Per-session bearer tokens (fed by LaneManager `onMcpToken` / the orchestrator spawn). One live token per session. */
export class TokenRegistry {
  private readonly byToken = new Map<string, Identity>();
  private readonly bySession = new Map<string, string>();
  private readonly ids = new Map<string, ReadonlySet<string>>();

  constructor(private readonly db: Db) {}

  /**
   * Role and project come from the `session` row, unless given (a session not yet in the db). The spawn's facts are fixed
   * until the next spawn / resume: v2.2 §5.1 `mcpIds` = the remote catalog ids written into its MCP file (the proxy's
   * allow-list); v2.5 §5.4 `cwd` + `graph` = the session's working dir and whether its file has the graph entry.
   */
  register(sessionId: string, token: string, spawn: TokenSpawn, who?: { role: Role; projectId: string }): void {
    let ident = who;
    if (!ident) {
      const r = this.db.query<{ kind: Role; project_id: string }, [string]>('SELECT kind, project_id FROM session WHERE id = ?').get(sessionId);
      if (!r) throw new Error(`MCP token for unknown session ${sessionId}`);
      ident = { role: r.kind, projectId: r.project_id };
    }
    this.revoke(sessionId);
    this.byToken.set(token, { sessionId, ...ident, cwd: spawn.cwd, graph: spawn.graph });
    this.bySession.set(sessionId, token);
    this.ids.set(token, spawn.mcpIds);
  }

  revoke(sessionId: string): void {
    const t = this.bySession.get(sessionId);
    if (t !== undefined) { this.byToken.delete(t); this.ids.delete(t); }
    this.bySession.delete(sessionId);
  }

  resolve(token: string): Identity | null { return this.byToken.get(token) ?? null; }

  /** v2.2 §5.1 the MCP ids this token may reach through `/mcp-proxy/<id>` (unknown token → none). */
  mcpIds(token: string): ReadonlySet<string> { return this.ids.get(token) ?? NO_IDS; }

  /** v2.2 K13 the live sessions whose MCP file has the remote server `id`. */
  sessionsWith(id: string): string[] {
    return [...this.bySession].filter(([, t]) => this.ids.get(t)?.has(id)).map(([s]) => s);
  }
}

export interface McpHandlerDeps { tokens: TokenRegistry; tools: ToolDeps }

type Id = string | number | null;
interface RpcMsg { jsonrpc?: unknown; id?: Id; method?: unknown; params?: unknown }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });

export function createMcpHandler(d: McpHandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    // DNS-rebinding guard: Claude Code sends no Origin; a browser always does.
    if (req.headers.get('origin') !== null) return json(403, { error: 'origin not allowed' });
    const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    const who = auth ? d.tokens.resolve(auth[1]!) : null;
    if (!who) return json(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, { allow: 'POST' });

    let body: unknown;
    try { body = JSON.parse(await req.text()); } catch { return json(400, rpcError(null, -32700, 'Parse error')); }
    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as unknown[];
    if (msgs.length === 0) return json(400, rpcError(null, -32600, 'Invalid Request'));
    const out: unknown[] = [];
    for (const m of msgs) {
      const r = await handle(d, who, m);
      if (r !== null) out.push(r);
    }
    if (out.length === 0) return new Response(null, { status: 202 });
    return json(200, batch ? out : out[0]);
  };
}

async function handle(d: McpHandlerDeps, who: Identity, raw: unknown): Promise<unknown> {
  if (typeof raw !== 'object' || raw === null) return rpcError(null, -32600, 'Invalid Request');
  const m = raw as RpcMsg;
  const isRequest = m.id !== undefined && m.id !== null;
  if (typeof m.method !== 'string') return isRequest ? rpcError(m.id!, -32600, 'Invalid Request') : null; // a response from the client
  if (!isRequest) return null; // notifications (notifications/initialized, cancelled …) need no answer
  const id = m.id!;
  const p = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>;
  switch (m.method) {
    case 'initialize': {
      const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
        instructions: 'Công cụ cc-slaves. Người gọi được xác định qua token của session.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: listTools(who.role, sessionToolText(d.tools.issues.db, who.sessionId)) });
    case 'tools/call': {
      const t = typeof p.name === 'string' ? findTool(p.name) : undefined;
      if (!t) return rpcError(id, -32602, `Unknown tool: ${String(p.name)}`);
      return rpcResult(id, await callTool(d.tools, who, t, p.arguments));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${m.method}`);
  }
}
