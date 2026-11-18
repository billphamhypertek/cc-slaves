// v2.5 §5.4 `/mcp-graph`: the sessions' graph tool, relayed to the session's own front. Same transport rules as `/mcp`
// (JSON replies, no SSE; any Origin → 403) and `/mcp-proxy/` (loopback peers only — checked in http.ts; 401 / 403
// without WWW-Authenticate). `server/discover` is answered here (G0 §1: no front needed). Three rules on `tools/call`:
// no `delete_project` (A7); `index_repository` only inside the session cwd, never cross-repo, and it goes to the engine's
// index queue (§5.5; the lane gets the queue's reply at once, `status:true` of a dir the engine queued is answered here);
// module down → a tool error, never an HTTP one (A6: the lane goes on with grep).
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isObj } from '../../../shared/json.ts';
import { FrontTimeout, type RpcNote, type RpcReply, type RpcRequest } from './front.ts';
import type { IndexArgs } from './queue.ts';

const READ_LIMIT_MS = 120_000;
const DOWN = 'Graph đang cập nhật — dùng grep / đọc file, thử lại sau khoảng 1 phút';
const NO_DELETE = 'Index do cc-slaves quản lý — lane không xoá được index';
const OUTSIDE = 'cc-slaves chỉ index được thư mục của session (repo_path phải nằm trong cwd của session)';
const CROSS_REPO = 'index_repository với cross-repo-intelligence / target_projects không hỗ trợ qua cc-slaves';
const TIMEOUT = 'Graph không trả lời sau 120 s (hết giờ) — dùng grep / đọc file, thử lại sau';
const HINT = 'Index do cc-slaves xếp hàng; hỏi lại bằng index_repository {repo_path, status:true}. Trong lúc chờ, lệnh đọc trên thư mục này có thể báo chưa có index — dùng grep.';

/** The session's front as the gate uses it (front.ts `SessionFront`). */
export interface GraphPort {
  readonly cwd: string;
  call(m: RpcRequest, timeoutMs: number): Promise<RpcReply>;
  notify(m: RpcNote): void;
}

export interface GraphGateDeps {
  /** A live session token (TokenRegistry). */
  known(token: string): boolean;
  /** The front of a live session whose MCP set has the graph; null → 403. */
  session(token: string): GraphPort | null;
  /** Rule 3: false while the module is installing / updating or its control front is down. */
  ready(): boolean;
  /** Rule 2 a valid index of `root` (a real path inside the session cwd) → the engine queue. */
  index(token: string, root: string, args: IndexArgs): { ahead: number };
  /** `status:true` of `root` in the tool's words; null = the engine never queued it (forward). */
  indexed(root: string): Record<string, unknown> | null;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rpcError = (id: RpcReply['id'], code: number, message: string): RpcReply => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolError = (id: RpcReply['id'], text: string): RpcReply => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
const toolJson = (id: RpcReply['id'], v: unknown): RpcReply => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(v) }] } });

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };
function inside(dir: string, cwd: string): boolean {
  const d = real(resolve(cwd, dir)); const c = real(cwd);
  return d !== null && c !== null && (d === c || d.startsWith(c + sep));
}

export function createGraphGate(d: GraphGateDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.headers.get('origin') !== null) return json(403, { error: 'origin not allowed' });
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token || !d.known(token)) return json(401, { error: 'unauthorized' });
    const port = d.session(token);
    if (!port) return json(403, { error: 'no graph for this session' });
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    let body: unknown;
    try { body = JSON.parse(await req.text()); } catch { return json(400, rpcError(null, -32700, 'Parse error')); }
    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as unknown[];
    if (msgs.length === 0) return json(400, rpcError(null, -32600, 'Invalid Request'));
    const out: RpcReply[] = [];
    for (const m of msgs) {
      const r = await handle(d, token, port, m);
      if (r) out.push(r);
    }
    if (out.length === 0) return new Response(null, { status: 202 });
    return json(200, batch ? out : out[0]);
  };
}

async function handle(d: GraphGateDeps, token: string, port: GraphPort, raw: unknown): Promise<RpcReply | null> {
  if (!isObj(raw) || typeof raw.method !== 'string') return rpcError(null, -32600, 'Invalid Request');
  const id = raw.id;
  if (id === undefined || id === null) { port.notify(raw as unknown as RpcNote); return null; }
  if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, -32600, 'Invalid Request');
  const m: RpcRequest = { jsonrpc: '2.0', id, method: raw.method, ...(raw.params !== undefined ? { params: raw.params } : {}) };
  if (m.method === 'server/discover') return rpcError(id, -32601, 'Method not found');
  if (m.method === 'tools/call') {
    if (!d.ready()) return toolError(id, DOWN);
    const p = isObj(m.params) ? m.params : {};
    const refused = rule(p.name, isObj(p.arguments) ? p.arguments : {}, port.cwd);
    if (refused) return toolError(id, refused);
    const args = isObj(p.arguments) ? p.arguments : {};
    if (p.name === 'index_repository' && typeof args.repo_path === 'string') {
      const root = real(resolve(port.cwd, args.repo_path)) ?? resolve(port.cwd, args.repo_path);
      if (args.status === true) { const v = d.indexed(root); if (v) return toolJson(id, v); }
      else {
        const job: IndexArgs = { ...(args.mode !== undefined ? { mode: args.mode } : {}), ...(args.persistence !== undefined ? { persistence: args.persistence } : {}) };
        const { ahead } = d.index(token, root, job); // the lane is never held by an index run
        return toolJson(id, { state: 'queued', async: true, repo_path: root, ahead, hint: HINT });
      }
    }
  }
  try {
    return await port.call(m, READ_LIMIT_MS);
  } catch (e) {
    const text = e instanceof FrontTimeout ? TIMEOUT : DOWN;
    return m.method === 'tools/call' ? toolError(id, text) : rpcError(id, -32000, text);
  }
}

/** Rules 1 and 2; null = forward. */
function rule(name: unknown, args: Record<string, unknown>, cwd: string): string | null {
  if (name === 'delete_project') return NO_DELETE;
  if (name !== 'index_repository' || args.status === true) return null;
  if (args.mode === 'cross-repo-intelligence' || args.target_projects !== undefined) return CROSS_REPO;
  return typeof args.repo_path === 'string' && inside(args.repo_path, cwd) ? null : OUTSIDE;
}
