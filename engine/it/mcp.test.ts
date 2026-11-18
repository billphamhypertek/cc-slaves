import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getLane, insertSession, listUndelivered } from '../src/db.ts';
import { paths } from '../src/paths.ts';
import { createMcpHandler, TokenRegistry } from '../src/mcp/server.ts';
import { reach, startArgs, turns, until, world, type World } from './_cards-setup.ts';
import { issuePorts } from '../test/_fixtures/issue-ports.ts';

setDefaultTimeout(20_000);
let w: World | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => { await server?.stop(true); server = null; await w?.close(); w = null; });

function serve(x: World, tokens: TokenRegistry) {
  const handler = createMcpHandler({ tokens, tools: { lanes: x.m, cards: x.cards, usage: () => [], notify: () => {}, issues: issuePorts(x.db) } });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => (new URL(r.url).pathname === '/mcp' ? handler(r) : new Response(null, { status: 404 })) });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  let id = 0;
  return async (token: string, name: string, args: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const r = ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    return { isError: r.isError === true, text: r.content[0]!.text };
  };
}

/** The token a lane would send: read from its own `--mcp-config` file. */
const fileToken = (sid: string) =>
  (JSON.parse(readFileSync(paths().mcpConfig(sid), 'utf8')) as { mcpServers: { cc_slaves: { headers: { Authorization: string } } } })
    .mcpServers.cc_slaves.headers.Authorization.replace('Bearer ', '');

describe('engine MCP over real HTTP (§7.7)', () => {
  test('§7.7 orchestrator lane_start → a fake-claude lane runs; lane po_ask → card + waiting_po → answer → outbox message replayed', async () => {
    let tokens!: TokenRegistry;
    w = world({ scenario: () => ({ steps: turns(4) }), onMcpToken: (sid, sp) => tokens.register(sid, sp.token, sp) });
    const x = w;
    tokens = new TokenRegistry(x.db);
    insertSession(x.db, { id: 'orch', projectId: 'p1', kind: 'orchestrator', account: null });
    tokens.register('orch', 'tok-orch', { mcpIds: new Set(), cwd: '/w', graph: false });
    const call = serve(x, tokens);

    const a = startArgs(x, 'D2');
    const started = await call('tok-orch', 'lane_start', { name: 'D2', cwd: a.cwd, brief_path: a.briefPath });
    expect(started).toMatchObject({ isError: false });
    await reach(x, 'D2', 'idle');
    const sid = getLane(x.db, 'p1', 'D2')!.sessionId!;
    const laneTok = fileToken(sid);

    // gating over the wire: the lane token cannot start lanes
    expect(await call(laneTok, 'lane_start', { name: 'D3', cwd: a.cwd, brief_path: a.briefPath })).toMatchObject({ isError: true });

    const asked = await call(laneTok, 'po_ask', { question: 'Chọn DB?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], from: 'Điều phối' });
    expect(asked.isError).toBe(false);
    const cardId = (JSON.parse(asked.text) as { card_id: number }).card_id;
    expect(x.cards.get(cardId)).toMatchObject({ sessionId: sid, status: 'open', payload: { source: 'D2' } });
    await reach(x, 'D2', 'waiting_po');
    expect(x.m.get('p1', 'D2')!.openCards).toEqual([cardId]);

    await x.cards.answer(cardId, { option: 'SQLite', note: 'cho nhẹ' });
    const text = `PO trả lời #${cardId}: SQLite — cho nhẹ`;
    const row = () => x.db.query<{ delivered_at: number | null; prefix: string | null }, [string, string]>(
      'SELECT delivered_at, prefix FROM outbox WHERE session_id = ? AND text LIKE ?').get(sid, `%${text}`);
    await until(() => (row()?.delivered_at ?? null) !== null, 'answer replayed');
    expect(listUndelivered(x.db, sid)).toEqual([]);
    await until(() => x.m.result('p1', 'D2') === 'Xong lượt 2.', 'turn on the answer');
    await reach(x, 'D2', 'idle');
    expect(x.m.get('p1', 'D2')!.openCards).toEqual([]);

    // lane_set_phase from the lane names itself, even with a forged name
    expect(await call(laneTok, 'lane_set_phase', { name: 'D9', phase: 'review' })).toMatchObject({ isError: false });
    expect(getLane(x.db, 'p1', 'D2')!.phase).toBe('review');
  });
});
