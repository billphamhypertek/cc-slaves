// v2.7 §5.3 / §5.5-6 over real HTTP with fake-claude lanes: lane_start {issue} → the lane's commits → issue_done; a lane
// that ends without issue_done hands its issue back. The commits are made by the test in the lane's temp repo.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { getLane, insertSession, listUndelivered } from '../src/db.ts';
import { IssueEvents } from '../src/issues/events.ts';
import { createIssue, getIssue, insertSpec, moveSpec, updateSpec } from '../src/issues/store.ts';
import { createMcpHandler, TokenRegistry } from '../src/mcp/server.ts';
import { paths } from '../src/paths.ts';
import { execIn } from '../src/setup/setup.ts';
import { reach, startArgs, turns, until, world, type World } from './_cards-setup.ts';

setDefaultTimeout(20_000);
let w: World | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
let events: IssueEvents | null = null;
afterEach(async () => { events?.stop(); await server?.stop(true); server = null; await w?.close(); w = null; });

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).stdout.trim();
const fileToken = (sid: string) =>
  (JSON.parse(readFileSync(paths().mcpConfig(sid), 'utf8')) as { mcpServers: { cc_slaves: { headers: { Authorization: string } } } })
    .mcpServers.cc_slaves.headers.Authorization.replace('Bearer ', '');

function setup() {
  let tokens!: TokenRegistry;
  w = world({
    scenario: () => ({ steps: turns(4) }), onMcpToken: (sid, sp) => tokens.register(sid, sp.token, sp),
    issues: (db, outbox) => (events = new IssueEvents({ db, send: (sid, text) => { outbox.enqueue(sid, text, null); }, running: () => false, hasRoom: () => true })),
  });
  const x = w;
  tokens = new TokenRegistry(x.db);
  insertSession(x.db, { id: 'bld', projectId: 'p1', kind: 'orchestrator', account: null });
  x.db.query("UPDATE session SET orch_kind = 'build' WHERE id = 'bld'").run();
  tokens.register('bld', 'tok-bld', { mcpIds: new Set(), cwd: '/w', graph: false });
  const s = insertSpec(x.db, { projectId: 'p1', path: 'docs/specs/v29.md', title: 'v2.9', origin: 'app' });
  moveSpec(x.db, s.id, 'approved');
  moveSpec(x.db, s.id, 'active');
  updateSpec(x.db, s.id, { buildSession: 'bld' });
  const t = createIssue(x.db, { projectId: 'p1', kind: 'task', specId: s.id, source: 'spec', title: 'xuất CSV' });
  createIssue(x.db, { projectId: 'p1', kind: 'task', specId: s.id, source: 'spec', title: 'còn lại' });
  const handler = createMcpHandler({
    tokens, tools: {
      lanes: x.m, cards: x.cards, usage: () => [], notify: () => {},
      issues: { db: x.db, exec: execIn(process.env), events: events!, rename: () => {}, closeWhenIdle: () => {}, missingPlugin: () => null, changed: () => {}, conflict: () => {}, startNext: async () => {} },
    },
  });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => handler(r) });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  let id = 0;
  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const r = ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    return { isError: r.isError === true, text: r.content[0]!.text };
  };
  return { x, t, call };
}

async function startOn(s: ReturnType<typeof setup>) {
  const a = startArgs(s.x, 'D2');
  git(a.cwd, 'init', '-q', '-b', 'v29');
  git(a.cwd, 'commit', '-q', '--allow-empty', '-m', 'base');
  const r = await s.call('tok-bld', 'lane_start', { name: 'D2', cwd: a.cwd, brief_path: a.briefPath, issue: s.t.key });
  expect(r).toMatchObject({ isError: false });
  await reach(s.x, 'D2', 'idle');
  const sid = getLane(s.x.db, 'p1', 'D2')!.sessionId!;
  await until(() => listUndelivered(s.x.db, sid).length === 0, 'the "Nhận" message delivered');
  return { cwd: a.cwd, laneTok: fileToken(sid) };
}

describe('v2.7 issues over MCP with fake-claude lanes', () => {
  test('§5.5-6 lane_start {issue} → lane commit with trailer → issue_done ok; without trailer refused with the fix text', async () => {
    const s = setup();
    const { cwd, laneTok } = await startOn(s);
    expect(getIssue(s.x.db, s.t.id)).toMatchObject({ state: 'doing', baseSha: git(cwd, 'rev-parse', 'HEAD') });
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'feat: csv');
    const refused = await s.call(laneTok, 'issue_done', { key: s.t.key, summary: 'xong' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`git commit --amend --no-edit --trailer "Issue: ${s.t.key}"`);
    git(cwd, 'commit', '-q', '--allow-empty', '--amend', '--no-edit', '--trailer', `Issue: ${s.t.key}`);
    const ok = await s.call(laneTok, 'issue_done', { key: s.t.key, summary: 'xong' });
    expect(ok).toMatchObject({ isError: false });
    expect(getIssue(s.x.db, s.t.id)!.state).toBe('done');
    const commits = s.x.db.query<{ sha: string; branch: string }, [number]>('SELECT sha, branch FROM issue_commit WHERE issue_id = ?').all(s.t.id);
    expect(commits).toEqual([{ sha: git(cwd, 'rev-parse', 'HEAD'), branch: 'v29' }]);
  });

  test('§5.3 lane idle → ready follow-up; lane finish without issue_done → issue back to todo + "trả về hàng" in the Build session outbox', async () => {
    const s = setup();
    await startOn(s);
    // §5.3 right after "lane D2 rảnh" (owner path, world notes): what the spec still has ready, to the Build session
    await until(() => listUndelivered(s.x.db, 'bld').some((m) => m.text === '[cc-slaves] docs/specs/v29.md còn sẵn sàng: T-2'), 'idle follow-up');
    expect(s.x.notes.some((n) => n.startsWith('[cc-slaves] lane D2 rảnh'))).toBe(true);
    await s.x.m.finish('p1', 'D2', true);
    await reach(s.x, 'D2', 'done');
    expect(getIssue(s.x.db, s.t.id)).toMatchObject({ state: 'todo', laneId: null });
    const out = listUndelivered(s.x.db, 'bld').map((m) => m.text);
    expect(out).toContain(`[cc-slaves] ${s.t.key} trả về hàng (lane D2 kết thúc)`);
  });
});
