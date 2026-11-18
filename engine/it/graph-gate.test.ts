// v2.5 §5.4 / §8 Integration `/mcp-graph` over a real engine: fake-claude lanes, `fake-cbm` as the graph tool on a temp
// login PATH (never the real codebase-memory-mcp, Z5), temp homes. Control front warm at boot, one session front per
// claude process in its cwd (spawned with it, closed when it exits), auth / Origin / GET rules, initialize relayed with
// the tool's own `instructions`, `server/discover` answered locally, the three rules end to end.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { insertProject, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const CBM = resolve(import.meta.dir, '../../fake-cbm/src/index.ts');
const EMAILS = ['a@x.test', 'b@x.test'];
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let cbmLog: string;

interface Ev { ev: string; pid: number; cwd: string; method?: string; name?: string; env?: Record<string, string | null> }
const events = (): Ev[] => { try { return readFileSync(cbmLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev); } catch { return []; } };
const startsIn = (dir: string) => events().filter((e) => e.ev === 'start' && e.cwd === realpathSync(dir));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}
const wt = (n: string) => join(tmp, `wt-${n}`);
const tokenOf = (lane: string): string => {
  const sid = engine.lanes.get('p1', lane)!.sessionId;
  return /Bearer (\S+?)"/.exec(readFileSync(paths().mcpConfig(sid), 'utf8'))![1]!;
};
const post = (token: string | null, body: unknown, h: Record<string, string> = {}, method = 'POST') =>
  fetch(`http://127.0.0.1:${engine.port}/mcp-graph`, {
    method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...h },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
const rpc = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const j = await (await post(token, rpc(9, 'tools/call', { name, arguments: args }))).json() as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: j.result.isError === true, text: j.result.content[0]!.text };
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-graph-gate-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  const bin = join(tmp, 'bin');
  for (const d of [join(tmp, 'home'), join(tmp, 'claude'), join(tmp, 'shop'), bin, wt('D1'), wt('D2')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(bin, 'codebase-memory-mcp'), `#!/bin/sh\nexec "${process.execPath}" "${CBM}" "$@"\n`);
  chmodSync(join(bin, 'codebase-memory-mcp'), 0o755);
  cbmLog = join(tmp, 'cbm.log');
  writeFileSync(join(tmp, 'brief.md'), 'x');
  writeFileSync(paths().config, JSON.stringify({ maxLanesPerAccount: 1 }));
  const db = openDb(paths().stateDb);
  seedAccounts(EMAILS, { db });
  insertProject(db, { id: 'p1', name: 'Shop', path: join(tmp, 'shop') });
  const now = Math.floor(Date.now() / 1000);
  for (const e of EMAILS) upsertQuota(db, { account: e, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  const scn = join(tmp, 'scn.json');
  writeFileSync(scn, JSON.stringify({ steps: [{ waitUser: true }] }));
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 'graph-gate-token', staticDir: null, command: [process.execPath, FAKE], graphModule: true,
    loginEnv: {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, FAKE_CBM_LOG: cbmLog, FAKE_CBM_SLOW: 'trace_path', CBM_CACHE_DIR: '/leak', CLAUDE_CONFIG_DIR: '/leak' },
      claudePath: null, shellFailed: false, reason: null,
    },
    extraEnv: () => ({ FAKE_CLAUDE_SCENARIO: scn }),
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
  });
  for (const n of ['D1', 'D2']) await engine.lanes.start({ projectId: 'p1', name: n, cwd: wt(n), briefPath: join(tmp, 'brief.md') });
  await until(() => engine.lanes.listAll().filter((v) => v.state === 'idle' || v.state === 'running').length === 2, 'lanes up');
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§5.4 fronts', () => {
  test('a control front in the engine data dir (warm daemon), A1 env: no CBM_CACHE_DIR, no CLAUDE_CONFIG_DIR', async () => {
    await until(() => startsIn(paths().home).length > 0, 'control front');
    for (const e of events().filter((x) => x.ev === 'start')) expect(e.env).toEqual({ CBM_CACHE_DIR: null, CLAUDE_CONFIG_DIR: null });
  });
  test('two sessions → two fronts, each in its own cwd, spawned with the claude process (before any call)', async () => {
    await until(() => startsIn(wt('D1')).length === 1 && startsIn(wt('D2')).length === 1, 'session fronts');
    const msgs = events().filter((e) => e.ev === 'msg' && (e.cwd === realpathSync(wt('D1')) || e.cwd === realpathSync(wt('D2'))));
    expect(msgs).toEqual([]);
  });
});

describe('§5.4 / §5.7 the token knows the session (G2b)', () => {
  test('each lane token resolves to its own worktree cwd + graph; its MCP file has the cc-slaves graph entry for that token', () => {
    for (const n of ['D1', 'D2']) {
      const sid = engine.lanes.get('p1', n)!.sessionId, t = tokenOf(n);
      expect(engine.tokens.resolve(t)).toEqual({ sessionId: sid, role: 'lane', projectId: 'p1', cwd: wt(n), graph: true });
      const entry = JSON.parse(readFileSync(paths().mcpConfig(sid), 'utf8')).mcpServers['codebase-memory-mcp'];
      expect(entry).toEqual({ type: 'http', url: `http://127.0.0.1:${engine.port}/mcp-graph`, headers: { Authorization: `Bearer ${t}` } });
    }
  });
});

describe('§5.4 /mcp-graph', () => {
  test('no / unknown token → 401, a live token with no graph → 403, any Origin → 403; never WWW-Authenticate', async () => {
    engine.tokens.register('s-nograph', 'tok-nograph', { mcpIds: new Set(), cwd: wt('D1'), graph: false }, { role: 'lane', projectId: 'p1' });
    const cases: [string | null, Record<string, string>, number][] = [
      [null, {}, 401], ['nope', {}, 401], ['tok-nograph', {}, 403], [tokenOf('D1'), { origin: `http://127.0.0.1:${engine.port}` }, 403],
    ];
    for (const [t, h, status] of cases) {
      const r = await post(t, rpc(1, 'ping'), h);
      expect(r.status).toBe(status);
      expect(r.headers.get('www-authenticate')).toBeNull();
    }
    engine.tokens.revoke('s-nograph');
  });
  test('GET → 405; server/discover → -32601 from the gate (no front message)', async () => {
    const t = tokenOf('D1');
    expect((await post(t, null, {}, 'GET')).status).toBe(405);
    const r = await post(t, rpc('server-discover-probe-1', 'server/discover'), { 'mcp-protocol-version': '2026-07-28' });
    expect((await r.json() as { error: { code: number } }).error.code).toBe(-32601);
    expect(events().some((e) => e.method === 'server/discover')).toBe(false);
  });
  test('initialize relayed: the tool\'s own instructions ("Graph first…"); notifications/initialized → 202; tools/list relayed', async () => {
    for (const lane of ['D1', 'D2']) {
      const t = tokenOf(lane);
      const init = await (await post(t, rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: 'x' } }))).json() as { id: number; result: { instructions: string; serverInfo: { name: string } } };
      expect(init.id).toBe(1);
      expect(init.result.instructions).toStartWith('Graph first:');
      expect(init.result.serverInfo.name).toBe('codebase-memory-mcp');
      expect((await post(t, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
      const list = await (await post(t, rpc(2, 'tools/list'))).json() as { result: { tools: { name: string }[] } };
      expect(list.result.tools.map((x) => x.name)).toContain('search_graph');
    }
  });
  test('each session reaches its own front (its cwd)', async () => {
    for (const lane of ['D1', 'D2']) {
      const r = await tool(tokenOf(lane), 'search_graph', { name_pattern: 'x' });
      expect(r.isError).toBe(false);
      expect((JSON.parse(r.text) as { cwd: string }).cwd).toBe(realpathSync(wt(lane)));
    }
  });
  test('rule 1 delete_project and rule 2 (outside cwd, cross-repo) → tool errors, never reach the tool', async () => {
    const t = tokenOf('D1');
    expect((await tool(t, 'delete_project', { project_name: 'x' })).isError).toBe(true);
    expect((await tool(t, 'index_repository', { repo_path: wt('D2') })).isError).toBe(true);
    expect((await tool(t, 'index_repository', { repo_path: wt('D1'), mode: 'cross-repo-intelligence' })).isError).toBe(true);
    // the session fronts never get them (the engine's own index jobs run from its data dir, §5.5)
    expect(events().filter((e) => e.cwd !== realpathSync(paths().home) && (e.name === 'delete_project' || e.name === 'index_repository'))).toEqual([]);
  });
  test('rule 2 inside cwd → the engine queue replies at once (the lane is never held)', async () => {
    // the engine's own boot index of the project root (no .git → its root, §5.5) runs first: `ahead` counts it while it runs
    await until(() => engine.graphIndexes!.status(realpathSync(join(tmp, 'shop')))?.state === 'succeeded', 'boot index of the project root');
    const r = await tool(tokenOf('D1'), 'index_repository', { repo_path: wt('D1') });
    expect(JSON.parse(r.text)).toMatchObject({ state: 'queued', async: true, repo_path: realpathSync(wt('D1')), ahead: 0 });
  });
  test('the claude process exits (lane stopped) → its front closes; its token gets 403 (a stopped lane holds no front)', async () => {
    const pid = startsIn(wt('D2')).at(-1)!.pid;
    const t = tokenOf('D2');
    await engine.lanes.stop('p1', 'D2', 'now');
    await until(() => !alive(pid), 'D2 front closed');
    expect((await post(t, rpc(1, 'ping'))).status).toBe(403);
    expect(alive(startsIn(wt('D1')).at(-1)!.pid)).toBe(true);
  });
  test('"Tiếp tục" spawns claude again → a new front in the same cwd on the new token; the old token is gone (401)', async () => {
    const old = tokenOf('D2');
    const n = startsIn(wt('D2')).length;
    await engine.lanes.resume('p1', 'D2');
    await until(() => tokenOf('D2') !== old && startsIn(wt('D2')).length === n + 1, 'respawned front');
    expect((await post(old, rpc(1, 'ping'))).status).toBe(401);
    const fresh = tokenOf('D2');
    await post(fresh, rpc(1, 'initialize', { protocolVersion: '2025-11-25' }));
    const r = await tool(fresh, 'search_graph');
    expect((JSON.parse(r.text) as { cwd: string }).cwd).toBe(realpathSync(wt('D2')));
  });
  test('the gate reads "has graph" beside the token: a token of the same session with graph false → 403 though its front is alive', async () => {
    const sid = engine.lanes.get('p1', 'D1')!.sessionId, live = tokenOf('D1');
    engine.tokens.register(sid, 'tok-d1-nograph', { mcpIds: new Set(), cwd: wt('D1'), graph: false });
    expect(alive(startsIn(wt('D1')).at(-1)!.pid)).toBe(true);
    expect((await post('tok-d1-nograph', rpc(1, 'ping'))).status).toBe(403);
    engine.tokens.register(sid, live, { mcpIds: new Set(), cwd: wt('D1'), graph: true });
    expect((await post(live, rpc(1, 'ping'))).status).toBe(200);
  });
  test('engine stop closes every front', async () => {
    const pids = events().filter((e) => e.ev === 'start').map((e) => e.pid).filter(alive);
    expect(pids.length).toBeGreaterThanOrEqual(2);
    await engine.stop();
    await until(() => pids.every((p) => !alive(p)), 'all fronts closed');
  });
});
