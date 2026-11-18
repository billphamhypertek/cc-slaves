// v2.5 §5.4 the `/mcp-graph` gate over a fake session front: auth (401 / 403, never WWW-Authenticate), Origin 403, GET
// 405, `server/discover` answered locally, notifications 202, the three rules of `tools/call`, the 120 s read limit.
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrontGone, FrontTimeout, type RpcNote, type RpcReply, type RpcRequest } from '../../src/graph/front.ts';
import { createGraphGate, type GraphPort } from '../../src/graph/relay.ts';

const root = mkdtempSync(join(tmpdir(), 'ccs-relay-'));
const CWD = join(root, 'wt');
mkdirSync(join(CWD, 'pkg'), { recursive: true });
mkdirSync(join(root, 'other'), { recursive: true });
mkdirSync(join(root, 'wt-other'), { recursive: true }); // a sibling sharing the cwd's prefix (review-e MINOR-4)
symlinkSync(join(root, 'other'), join(CWD, 'escape'));

class FakePort implements GraphPort {
  readonly cwd = CWD;
  calls: RpcRequest[] = [];
  notes: RpcNote[] = [];
  answer: (m: RpcRequest) => Promise<RpcReply> = async (m) => ({ jsonrpc: '2.0', id: m.id, result: { echo: m.method, params: m.params ?? null } });
  call(m: RpcRequest, timeoutMs: number): Promise<RpcReply> { this.calls.push(m); this.lastTimeout = timeoutMs; return this.answer(m); }
  notify(m: RpcNote): void { this.notes.push(m); }
  lastTimeout = 0;
}

let port: FakePort;
let ready: boolean;
let queued: { token: string; root: string; args: unknown }[];
let seen: Map<string, Record<string, unknown>>;
const gate = () => createGraphGate({
  known: (t) => t === 'tok' || t === 'nograph',
  session: (t) => (t === 'tok' ? port : null),
  ready: () => ready,
  index: (token, root, args) => { queued.push({ token, root, args }); return { ahead: queued.length - 1 }; },
  indexed: (root) => seen.get(root) ?? null,
});
beforeEach(() => { port = new FakePort(); ready = true; queued = []; seen = new Map(); });

const post = (body: unknown, h: Record<string, string> = { authorization: 'Bearer tok' }, method = 'POST') =>
  gate()(new Request('http://127.0.0.1:1/mcp-graph', { method, headers: { 'content-type': 'application/json', ...h }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }));
const call = (name: string, args: Record<string, unknown> = {}) => post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
const toolText = async (r: Response) => {
  const j = await r.json() as { id: unknown; result: { isError?: boolean; content: { text: string }[] } };
  return { id: j.id, isError: j.result.isError === true, text: j.result.content[0]!.text };
};

describe('§5.4 auth and transport', () => {
  test('no / unknown token → 401, a live token whose session has no graph → 403; never WWW-Authenticate', async () => {
    for (const h of [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic tok' }] as Record<string, string>[]) {
      const r = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, h);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBeNull();
    }
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer nograph' });
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect(port.calls).toEqual([]);
  });
  test('any Origin → 403 before the token is even read; nothing forwarded', async () => {
    for (const origin of ['http://127.0.0.1:47800', 'https://evil.example', 'null']) {
      expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer tok', origin })).status).toBe(403);
    }
    expect(port.calls).toEqual([]);
  });
  test('GET (the SSE probe) → 405; bad JSON → 400 parse error', async () => {
    expect((await post(null, { authorization: 'Bearer tok' }, 'GET')).status).toBe(405);
    const r = await gate()(new Request('http://127.0.0.1:1/mcp-graph', { method: 'POST', headers: { authorization: 'Bearer tok' }, body: '{' }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
  test('G0 `server/discover` is answered by the gate (-32601), never forwarded — even when the module is down', async () => {
    ready = false;
    const r = await post({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover' });
    expect(await r.json()).toEqual({ jsonrpc: '2.0', id: 'server-discover-probe-1', error: { code: -32601, message: 'Method not found' } });
    expect(port.calls).toEqual([]);
  });
  test('initialize / tools/list / prompts/list / ping are forwarded unchanged and the reply is returned as is', async () => {
    port.answer = async (m) => ({ jsonrpc: '2.0', id: m.id, result: { instructions: 'Graph first: …', m: m.method } });
    for (const method of ['initialize', 'tools/list', 'prompts/list', 'ping']) {
      const params = method === 'initialize' ? { protocolVersion: '2025-11-25' } : undefined;
      const r = await post({ jsonrpc: '2.0', id: `x-${method}`, method, ...(params ? { params } : {}) });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ jsonrpc: '2.0', id: `x-${method}`, result: { instructions: 'Graph first: …', m: method } });
    }
    expect(port.calls.map((c) => c.method)).toEqual(['initialize', 'tools/list', 'prompts/list', 'ping']);
    expect(port.calls[0]!.params).toEqual({ protocolVersion: '2025-11-25' });
  });
  test('a notification is passed to the front → 202 with no body; a batch answers only its requests', async () => {
    const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe('');
    expect(port.notes).toEqual([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    const b = await post([{ jsonrpc: '2.0', method: 'notifications/cancelled' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
    expect(await b.json()).toEqual([{ jsonrpc: '2.0', id: 2, result: { echo: 'ping', params: null } }]);
  });
  test('a non-tool request whose front fails → a JSON-RPC error with the "thử lại sau" text', async () => {
    port.answer = () => Promise.reject(new FrontGone());
    const j = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json() as RpcReply;
    expect(j.id).toBe(3);
    expect(j.error?.message).toContain('Graph đang cập nhật');
  });
});

describe('§5.4 the three rules of tools/call', () => {
  test('rule 1: delete_project → tool error, never forwarded (A7)', async () => {
    const t = await toolText(await call('delete_project', { project_name: 'x' }));
    expect(t).toEqual({ id: 7, isError: true, text: 'Index do cc-slaves quản lý — lane không xoá được index' });
    expect(port.calls).toEqual([]);
  });
  test('rule 2: index_repository outside the session cwd (also through a symlink) → tool error, never forwarded', async () => {
    for (const repo_path of [join(root, 'other'), join(root, 'wt-other'), join(CWD, 'escape'), join(CWD, '..', 'other'), '/', join(root, 'missing')]) {
      const t = await toolText(await call('index_repository', { repo_path }));
      expect(t.isError).toBe(true);
      expect(t.text).toContain('chỉ index được thư mục của session');
    }
    expect((await toolText(await call('index_repository', {}))).isError).toBe(true);
    expect(port.calls).toEqual([]);
  });
  test('rule 2: cross-repo-intelligence or target_projects → tool error (Z19)', async () => {
    for (const args of [{ repo_path: CWD, mode: 'cross-repo-intelligence' }, { repo_path: CWD, target_projects: ['*'] }]) {
      const t = await toolText(await call('index_repository', args));
      expect(t).toMatchObject({ isError: true });
      expect(t.text).toContain('không hỗ trợ qua cc-slaves');
    }
    expect(port.calls).toEqual([]);
  });
  test('rule 2: the cwd itself or a dir in it → the engine queue (real path), mode / persistence kept; the queue reply at once', async () => {
    const a = await toolText(await call('index_repository', { repo_path: CWD, mode: 'fast', persistence: true, async: false }));
    const b = await toolText(await call('index_repository', { repo_path: join(CWD, 'pkg') }));
    expect(port.calls).toEqual([]);
    expect(queued).toEqual([
      { token: 'tok', root: realpathSync(CWD), args: { mode: 'fast', persistence: true } },
      { token: 'tok', root: realpathSync(join(CWD, 'pkg')), args: {} },
    ]);
    expect(a.isError).toBe(false);
    expect(JSON.parse(a.text)).toEqual({ state: 'queued', async: true, repo_path: realpathSync(CWD), ahead: 0, hint: expect.stringContaining('status:true') });
    expect(JSON.parse(b.text)).toMatchObject({ state: 'queued', ahead: 1, hint: expect.stringContaining('dùng grep') });
  });
  test('rule 2: `status:true` of a dir the engine queued → the engine answers; a dir it never saw → forwarded unchanged', async () => {
    seen.set(realpathSync(CWD), { state: 'running', repo_path: realpathSync(CWD), started_at: 'x' });
    const t = await toolText(await call('index_repository', { repo_path: CWD, status: true }));
    expect(JSON.parse(t.text)).toEqual({ state: 'running', repo_path: realpathSync(CWD), started_at: 'x' });
    expect(port.calls).toEqual([]);
    await call('index_repository', { repo_path: join(CWD, 'pkg'), status: true });
    expect((port.calls[0]!.params as { arguments: unknown }).arguments).toEqual({ repo_path: join(CWD, 'pkg'), status: true });
  });
  test('rule 3: module not ready → every tools/call is a tool error "Graph đang cập nhật", not an HTTP error', async () => {
    ready = false;
    for (const name of ['search_graph', 'delete_project', 'index_repository']) {
      const r = await call(name, { repo_path: CWD });
      expect(r.status).toBe(200);
      const t = await toolText(r);
      expect(t.isError).toBe(true);
      expect(t.text).toBe('Graph đang cập nhật — dùng grep / đọc file, thử lại sau khoảng 1 phút');
    }
    expect(port.calls).toEqual([]);
  });
  test('any other tool is forwarded with its arguments untouched (Z9: other projects, manage_adr)', async () => {
    const args = { project: 'someone-else', query: 'x' };
    const r = await call('manage_adr', args);
    expect(await r.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { echo: 'tools/call', params: { name: 'manage_adr', arguments: args } } });
  });
  test('120 s read limit: the call gets the limit; a timeout → tool error "hết giờ"; a dead front → tool error', async () => {
    await call('search_graph');
    expect(port.lastTimeout).toBe(120_000);
    port.answer = () => Promise.reject(new FrontTimeout());
    expect(await toolText(await call('search_graph'))).toMatchObject({ isError: true, text: expect.stringContaining('hết giờ') });
    port.answer = () => Promise.reject(new FrontGone());
    expect(await toolText(await call('search_graph'))).toMatchObject({ isError: true, text: expect.stringContaining('Graph đang cập nhật') });
  });
});
