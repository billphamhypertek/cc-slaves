import { beforeEach, describe, expect, test } from 'bun:test';
import { CardStore, type CardSessions } from '../../src/cards/store.ts';
import { insertLane, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { lanePin, workflowOf } from '../../src/workflow/runtime.ts';
import { LaneError, type LaneView } from '../../src/lane/manager.ts';
import { createMcpHandler, TokenRegistry } from '../../src/mcp/server.ts';
import { TOOLS } from '../../src/mcp/tools.ts';
import type { McpLanes } from '../../src/mcp/tool-kit.ts';
import { issuePorts } from '../_fixtures/issue-ports.ts';

const view = (name: string, sessionId: string): LaneView => ({
  projectId: 'p1', name, laneId: 1, sessionId, cwd: `/nowhere/${name}`, state: 'running', account: 'a@x', phase: 'code',
  failCount: 0, lastError: null, openCards: [], switchPending: false, sawAssistant: true, costUsd: null, alive: true, turnStartedAt: null, contextPct: null, waitReason: null, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
});

let db: Db;
let calls: { fn: string; args: unknown[] }[];
let notes: unknown[][];
let handler: (r: Request) => Promise<Response>;
let tokens: TokenRegistry;
let cards: CardStore;

beforeEach(() => {
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'P1', path: '/r/p1' });
  insertSession(db, { id: 'orch', projectId: 'p1', kind: 'orchestrator', account: null });
  insertSession(db, { id: 'sD2', projectId: 'p1', kind: 'lane', account: null });
  insertSession(db, { id: 'sD3', projectId: 'p1', kind: 'lane', account: null });
  calls = [];
  notes = [];
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }); return Promise.resolve(); };
  const lanes: McpLanes = {
    list: () => [{ ...view('D2', 'sD2'), run: { model: 'claude-sonnet-5-5', modelName: 'Sonnet 5.5', effort: 'high' } }, view('D3', 'sD3')],
    start: async (o) => { calls.push({ fn: 'start', args: [o] }); if (o.name === 'dup') throw new LaneError('name_taken', 'Tên lane dup đã có trong project'); return view(o.name, 'new'); },
    message: rec('message'), interrupt: rec('interrupt'), stop: rec('stop'), resume: rec('resume'), finish: rec('finish'),
    setPhase: rec('setPhase'),
    result: () => 'kết quả cuối', tail: (_p, _n, n) => Array.from({ length: n ?? 2 }, (_, i) => `l${i}`),
    bySession: (sid) => (sid === 'sD2' ? view('D2', 'sD2') : sid === 'sD3' ? view('D3', 'sD3') : null),
  };
  const sessions: CardSessions = { writeControl: () => true, askOpen: (s, id) => { calls.push({ fn: 'askOpen', args: [s, id] }); }, askClose: () => {}, deliver: () => {} };
  cards = new CardStore({ db, sessions });
  tokens = new TokenRegistry(db);
  tokens.register('orch', 'tok-orch', sp());
  tokens.register('sD2', 'tok-d2', sp());
  tokens.register('sD3', 'tok-d3', sp());
  handler = createMcpHandler({ tokens, tools: { lanes, cards, usage: () => [{ email: 'a@x', five: 10 }], notify: (...a) => notes.push(a), issues: issuePorts(db) } });
});

let rid = 0;
/** What a spawn writes beside its token (v2.5 §5.4): remote ids, cwd, graph. */
function sp(mcpIds: ReadonlySet<string> = new Set(), o: { cwd?: string; graph?: boolean } = {}) { return { mcpIds, cwd: o.cwd ?? '/w', graph: o.graph ?? false }; }
async function rpc(token: string | null, method: string, params?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handler(new Request('http://127.0.0.1:47800/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, ...(params === undefined ? {} : { params }) }),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as { result?: any; error?: any } : null };
}
const call = async (token: string, name: string, args: Record<string, unknown> = {}) =>
  (await rpc(token, 'tools/call', { name, arguments: args })).body!.result as { isError?: boolean; content: { type: string; text: string }[] };
const textOf = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe('MCP JSON-RPC transport (§7.7, Streamable HTTP)', () => {
  test('initialize → protocol version echoed when supported, tools capability, server info', async () => {
    const r = await rpc('tok-orch', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } });
    expect(r.status).toBe(200);
    expect(r.body!.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cc-slaves' } });
    const old = await rpc('tok-orch', 'initialize', { protocolVersion: '1999-01-01' });
    expect(old.body!.result.protocolVersion).toBe('2025-06-18');
  });

  test('notifications/initialized → 202 with no body; ping → {}; unknown method → -32601', async () => {
    const res = await handler(new Request('http://127.0.0.1/mcp', {
      method: 'POST', headers: { authorization: 'Bearer tok-orch', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect((await rpc('tok-orch', 'ping')).body!.result).toEqual({});
    expect((await rpc('tok-orch', 'resources/list')).body!.error.code).toBe(-32601);
  });

  test('§7.7 unknown or missing bearer token → 401, nothing runs', async () => {
    expect((await rpc('nope', 'tools/list')).status).toBe(401);
    expect((await rpc(null, 'tools/list')).status).toBe(401);
    expect((await rpc('nope', 'tools/call', { name: 'lane_start', arguments: { name: 'X', cwd: '/w', brief_path: '/b' } })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('v2.2 §5.1 mcpIds: the remote ids written at spawn ride with the token; a re-spawn replaces them; revoke / unknown → none', () => {
    tokens.register('sD2', 'tok-a', sp(new Set(['user:linear', 'local:p1:miro'])));
    expect([...tokens.mcpIds('tok-a')].sort()).toEqual(['local:p1:miro', 'user:linear']);
    tokens.register('sD2', 'tok-b', sp(new Set(['user:linear'])));
    expect([...tokens.mcpIds('tok-a')]).toEqual([]);
    expect([...tokens.mcpIds('tok-b')]).toEqual(['user:linear']);
    expect([...tokens.mcpIds('tok-orch')]).toEqual([]);
    tokens.revoke('sD2');
    expect([...tokens.mcpIds('tok-b')]).toEqual([]);
  });

  test('v2.5 §5.4 the cwd + "has graph" of the spawn ride with the token (db role / project kept); a re-spawn replaces them', () => {
    tokens.register('sD2', 'tok-a', sp(new Set(), { cwd: '/w/shop/.wt/D2', graph: true }));
    expect(tokens.resolve('tok-a')).toEqual({ sessionId: 'sD2', role: 'lane', projectId: 'p1', cwd: '/w/shop/.wt/D2', graph: true });
    tokens.register('sD2', 'tok-b', sp(new Set(), { cwd: '/w/other', graph: false }));
    expect([tokens.resolve('tok-a'), tokens.resolve('tok-b')]).toEqual([null, { sessionId: 'sD2', role: 'lane', projectId: 'p1', cwd: '/w/other', graph: false }]);
    tokens.register('sX', 'tok-x', sp(new Set(), { cwd: '/w/x', graph: true }), { role: 'orchestrator', projectId: 'p2' });
    expect(tokens.resolve('tok-x')).toEqual({ sessionId: 'sX', role: 'orchestrator', projectId: 'p2', cwd: '/w/x', graph: true });
  });

  test('v2.2 K13 sessionsWith(id): only live sessions whose mcpIds hold the server', () => {
    tokens.register('sD2', 'tok-a', sp(new Set(['user:linear'])));
    tokens.register('sB3', 'tok-b', sp(new Set(['user:linear', 'user:x'])), { role: 'lane', projectId: 'p1' });
    expect(tokens.sessionsWith('user:linear').sort()).toEqual(['sB3', 'sD2']);
    expect(tokens.sessionsWith('user:x')).toEqual(['sB3']);
    tokens.revoke('sB3');
    expect(tokens.sessionsWith('user:x')).toEqual([]);
  });

  test('a re-issued token for the same session revokes the old one', async () => {
    tokens.register('sD2', 'tok-d2-new', sp());
    expect((await rpc('tok-d2', 'tools/list')).status).toBe(401);
    expect((await rpc('tok-d2-new', 'tools/list')).status).toBe(200);
  });

  test('browser requests (Origin header) are refused 403; GET → 405; bad JSON → -32700', async () => {
    expect((await rpc('tok-orch', 'tools/list', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await handler(new Request('http://127.0.0.1/mcp', { headers: { authorization: 'Bearer tok-orch' } }))).status).toBe(405);
    const bad = await handler(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { authorization: 'Bearer tok-orch' }, body: '{' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe('MCP tools and role gating (§7.7)', () => {
  test('§7.7 / v2.7 §10.1 tools/list: orchestrator every tool but issue_done / issue_revert_conflict; lane lane_set_phase + po_ask + its issue tools', async () => {
    const o = (await rpc('tok-orch', 'tools/list')).body!.result.tools.map((t: { name: string }) => t.name);
    expect(o).toEqual(['lanes_list', 'lane_start', 'lane_message', 'lane_interrupt', 'lane_stop', 'lane_resume', 'lane_finish',
      'lane_result', 'lane_tail', 'lane_set_phase', 'accounts_usage', 'po_ask', 'notify',
      'issue_create', 'issue_get', 'issues_list', 'issue_link', 'issue_assign', 'issue_update', 'issue_drop',
      'spec_draft', 'spec_approve', 'spec_amend', 'spec_set_branch', 'spec_close', 'spec_output_add']);
    expect(TOOLS.map((t) => t.name).filter((n) => n !== 'issue_done' && n !== 'issue_revert_conflict')).toEqual(o);
    // v2.4 §5.6 lane_start says model / effort stay empty unless asked
    expect(TOOLS.find((t) => t.name === 'lane_start')!.description).toContain('model / effort: bỏ trống trừ khi brief hoặc PO yêu cầu');
    const l = (await rpc('tok-d2', 'tools/list')).body!.result.tools as { name: string; inputSchema: { properties: object; required?: string[] } }[];
    expect(l.map((t) => t.name)).toEqual(['lane_set_phase', 'po_ask', 'issue_create', 'issue_get', 'issues_list', 'issue_link', 'issue_done', 'issue_revert_conflict']);
    expect(Object.keys(l[0]!.inputSchema.properties)).not.toContain('name'); // a lane sets only its own phase
  });

  test('v2.9 §6.1 a lane on another rev: tools/list gives that rev\'s phases; lane_set_phase outside them → refused', async () => {
    const DIRECT = workflowOf('builtin:direct');
    db.query('UPDATE session SET workflow_rev = ? WHERE id = ?').run(DIRECT.rev, 'orch');
    lanePin(db, 'p1', insertLane(db, { projectId: 'p1', name: 'D2', cwd: '/w/d2', sessionId: 'sD2', briefPath: '/b.md', state: 'running' }).id, 'sD2', 'orch');
    const l = (await rpc('tok-d2', 'tools/list')).body!.result.tools as { name: string; description: string; inputSchema: { properties: { phase: { enum: string[] } } } }[];
    expect(l[0]!.inputSchema.properties.phase.enum).toEqual(['queue', 'code', 'review', 'done']);
    expect(l[0]!.description).toContain('(queue/code/review/done)');
    const o = (await rpc('tok-orch', 'tools/list')).body!.result.tools as { name: string; inputSchema: { properties: { phase?: { enum: string[] } } } }[];
    expect(o.find((t) => t.name === 'lane_set_phase')!.inputSchema.properties.phase!.enum).toEqual(['queue', 'code', 'review', 'done']);
    db.query('UPDATE session SET workflow_rev = ? WHERE id = ?').run(workflowOf('builtin:po').rev, 'orch');
    const r = await call('tok-orch', 'lane_set_phase', { name: 'D2', phase: 'gate' });
    expect([r.isError, textOf(r)]).toEqual([true, 'lane D2 không có phase gate: phase phải là một trong queue/code/review/done']);
    expect(calls).toEqual([]);
  });

  test('§7.7 a lane calling lane_start → tool error with a Vietnamese reason; manager untouched', async () => {
    const r = await call('tok-d2', 'lane_start', { name: 'X', cwd: '/w/x', brief_path: '/b.md' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Lane không được gọi lane_start');
    expect(calls).toEqual([]);
  });

  test('§7.7 lane_set_phase from a lane sets ITS OWN phase; a `name` arg naming another lane is ignored', async () => {
    const r = await call('tok-d2', 'lane_set_phase', { name: 'D3', phase: 'review', note: 'xong code' });
    expect(r.isError).toBeUndefined();
    expect(calls).toEqual([{ fn: 'setPhase', args: ['p1', 'D2', { phase: 'review', note: 'xong code' }] }]);
  });

  test('§7.7 orchestrator lane_set_phase needs `name`; bad phase → schema error', async () => {
    expect(textOf(await call('tok-orch', 'lane_set_phase', { phase: 'code' }))).toContain('name');
    const bad = await call('tok-orch', 'lane_set_phase', { name: 'D2', phase: 'party' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('phase');
    await call('tok-orch', 'lane_set_phase', { name: 'D3', phase: 'gate', task: 'T4' });
    expect(calls).toEqual([{ fn: 'setPhase', args: ['p1', 'D3', { phase: 'gate', task: 'T4' }] }]);
  });

  test('§7.7 po_ask: `from` arg ignored — the card source is the caller session; id returned at once', async () => {
    const r = await call('tok-d2', 'po_ask', { from: 'Điều phối', question: 'Chọn DB?', options: [{ label: 'SQLite' }], recommended: 'SQLite' });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(textOf(r)) as { card_id: number };
    const c = cards.get(out.card_id)!;
    expect(c.sessionId).toBe('sD2');
    expect((c.payload as { source: string }).source).toBe('D2');
    expect(calls).toEqual([{ fn: 'askOpen', args: ['sD2', out.card_id] }]);
    const o = JSON.parse(textOf(await call('tok-orch', 'po_ask', { question: 'Gộp chưa?', options: [] }))) as { card_id: number };
    expect((cards.get(o.card_id)!.payload as { source: string }).source).toBe('orchestrator') // §6A G5-fix: ORCH_SOURCE, rendered as the role name;
    expect(o.card_id).toBe(out.card_id + 1);
  });

  test('§7.7 po_ask with 5 options → tool error, no card', async () => {
    const r = await call('tok-d2', 'po_ask', { question: 'q', options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` })) });
    expect(r.isError).toBe(true);
    expect(cards.list()).toEqual([]);
  });

  test('§7.7 lane_start passes the caller project, never a project arg; LaneError → tool error text', async () => {
    const ok = await call('tok-orch', 'lane_start', { name: 'D9', cwd: '/w/d9', brief_path: '/b.md', model: 'opus', projectId: 'p2' });
    expect(ok.isError).toBeUndefined();
    expect(calls[0]).toEqual({ fn: 'start', args: [{ projectId: 'p1', name: 'D9', cwd: '/w/d9', briefPath: '/b.md', model: 'opus', ownerSession: 'orch' }] }); // §4.14 owner = caller
    const dup = await call('tok-orch', 'lane_start', { name: 'dup', cwd: '/w/x', brief_path: '/b.md' });
    expect(dup.isError).toBe(true);
    expect(textOf(dup)).toBe('Tên lane dup đã có trong project');
    expect(textOf(await call('tok-orch', 'lane_start', { name: 'D9' }))).toContain('cwd');
  });

  test('§7.7 the rest of the orchestrator tools reach the manager / sinks', async () => {
    await call('tok-orch', 'lane_message', { name: 'D2', text: 'làm tiếp' });
    await call('tok-orch', 'lane_interrupt', { name: 'D2' });
    await call('tok-orch', 'lane_stop', { name: 'D2', mode: 'drain' });
    await call('tok-orch', 'lane_resume', { name: 'D2' });
    await call('tok-orch', 'lane_finish', { name: 'D2', force: true });
    expect(calls.map((c) => [c.fn, ...c.args])).toEqual([
      ['message', 'p1', 'D2', 'làm tiếp', 'orchestrator'], ['interrupt', 'p1', 'D2'], ['stop', 'p1', 'D2', 'drain'],
      ['resume', 'p1', 'D2'], ['finish', 'p1', 'D2', true],
    ]);
    expect((await call('tok-orch', 'lane_stop', { name: 'D2', mode: 'later' })).isError).toBe(true);
    expect(JSON.parse(textOf(await call('tok-orch', 'lane_result', { name: 'D2' })))).toEqual({ result: 'kết quả cuối' });
    expect(JSON.parse(textOf(await call('tok-orch', 'lane_tail', { name: 'D2', n: 3 })))).toEqual({ lines: ['l0', 'l1', 'l2'] });
    expect(JSON.parse(textOf(await call('tok-orch', 'accounts_usage')))).toEqual({ accounts: [{ email: 'a@x', five: 10 }] });
    await call('tok-orch', 'notify', { level: 'warn', text: 'chú ý' });
    expect(notes).toEqual([['p1', 'warn', 'chú ý']]);
    const ls = JSON.parse(textOf(await call('tok-orch', 'lanes_list'))) as { lanes: { name: string; worktree: boolean; model: string | null; effort: string | null }[] };
    expect(ls.lanes.map((l) => [l.name, l.worktree])).toEqual([['D2', false], ['D3', false]]);
    // v2.4 §5.6 lanes_list: the real model / effort, null until read
    expect(ls.lanes.map((l) => [l.model, l.effort])).toEqual([['claude-sonnet-5-5', 'high'], [null, null]]);
  });

  test('unknown tool → JSON-RPC -32602; lane calling notify → tool error', async () => {
    expect((await rpc('tok-orch', 'tools/call', { name: 'rm_rf', arguments: {} })).body!.error.code).toBe(-32602);
    expect((await call('tok-d3', 'notify', { level: 'info', text: 'x' })).isError).toBe(true);
    expect(notes).toEqual([]);
  });
});
