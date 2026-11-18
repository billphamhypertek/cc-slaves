// v2.9 §5.9 `/mcp-draft`: the draft token only, no Origin, one tool `draft_save`.
import { expect, test } from 'bun:test';
import { createDraftMcpHandler } from '../../src/mcp/draft-server.ts';

const calls: [string, string | undefined][] = [];
const h = createDraftMcpHandler({ draftOfToken: (t) => (t === 'good' ? 'd1' : null), save: (id, name) => { calls.push([id, name]); return name ? 'Đã lưu "x".' : 'Chưa lưu: không'; } });
const rpc = (body: unknown, auth = 'Bearer good', extra: Record<string, string> = {}) =>
  h(new Request('http://127.0.0.1/mcp-draft', { method: 'POST', headers: { authorization: auth, ...extra }, body: JSON.stringify(body) }));

test('unknown token → 401; an Origin → 403', async () => {
  expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'Bearer bad')).status).toBe(401);
  expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'Bearer good', { origin: 'http://evil' })).status).toBe(403);
});

test('tools/list = draft_save only; tools/call reaches save with the token\'s draft', async () => {
  const l = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as { result: { tools: { name: string }[] } };
  expect(l.result.tools.map((t) => t.name)).toEqual(['draft_save']);
  const c = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'draft_save', arguments: { name: 'X' } } })).json() as { result: { isError: boolean } };
  expect(c.result.isError).toBe(false);
  expect(calls).toEqual([['d1', 'X']]);
  const bad = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lane_start', arguments: {} } })).json() as { error: { code: number } };
  expect(bad.error.code).toBe(-32602);
});
