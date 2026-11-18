// v2.5 §5.5 Integration: the index queue, automatic indexing and the automatic clean-up over a real engine — fake-claude
// lanes, `fake-cbm` with a shared temp state dir as the graph tool (never the real codebase-memory-mcp, Z5), temp homes.
// Boot (module ready): the project root with no index is indexed by a sync request on its own front; the stale lane row of
// a deleted worktree is cleaned (delete_project), an orphan outside the book is not. A spawn in a worktree with no index →
// indexed; a lane's index_repository → the queue's reply, status:true answered by the engine; a lane done whose worktree is
// gone → its index deleted, its book row dropped.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
let state: string;

interface Ev { ev: string; pid: number; cwd: string; method?: string; name?: string; args?: Record<string, unknown> }
interface Project { name: string; root_path: string }
const events = (): Ev[] => { try { return readFileSync(cbmLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev); } catch { return []; } };
const projects = (): Project[] => { try { return JSON.parse(readFileSync(join(state, 'projects.json'), 'utf8')) as Project[]; } catch { return []; } };
const roots = () => projects().map((p) => p.root_path);
async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(20); }
}
const shop = () => join(tmp, 'shop');
const wt = (n: string) => join(tmp, `wt-${n}`);
const book = () => engine.db.query<{ root_path: string; origin: string }, []>('SELECT root_path, origin FROM graph_index ORDER BY root_path').all();
const tokenOf = (lane: string): string => {
  const sid = engine.lanes.get('p1', lane)!.sessionId;
  return /Bearer (\S+?)"/.exec(readFileSync(paths().mcpConfig(sid), 'utf8'))![1]!;
};
const tool = async (token: string, name: string, args: Record<string, unknown>) => {
  const r = await fetch(`http://127.0.0.1:${engine.port}/mcp-graph`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json() as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: j.result.isError === true, body: JSON.parse(j.result.content[0]!.text) as Record<string, unknown> };
};

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-graph-queue-')));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  const bin = join(tmp, 'bin');
  state = join(tmp, 'cbm-state');
  for (const d of [join(tmp, 'home'), join(tmp, 'claude'), join(shop(), '.git'), bin, state, wt('D1'), join(wt('D1'), 'pkg'), wt('D2')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(bin, 'codebase-memory-mcp'), `#!/bin/sh\nexec "${process.execPath}" "${CBM}" "$@"\n`);
  chmodSync(join(bin, 'codebase-memory-mcp'), 0o755);
  cbmLog = join(tmp, 'cbm.log');
  // the tool's cache already holds: the index of a deleted lane worktree (in the book) and of a deleted dir outside it
  writeFileSync(join(state, 'projects.json'), JSON.stringify([
    { name: 'old-wt', root_path: join(tmp, 'wt-old'), nodes: 1, edges: 1, size_bytes: 5 },
    { name: 'user-dir', root_path: join(tmp, 'user-gone'), nodes: 1, edges: 1, size_bytes: 7 },
  ]));
  writeFileSync(join(tmp, 'brief.md'), 'x');
  writeFileSync(paths().config, JSON.stringify({ maxLanesPerAccount: 1 }));
  const db = openDb(paths().stateDb);
  seedAccounts(EMAILS, { db });
  insertProject(db, { id: 'p1', name: 'Shop', path: shop() });
  db.run('INSERT INTO graph_index (root_path, project_id, origin) VALUES (?, ?, ?)', [join(tmp, 'wt-old'), 'p1', 'lane']);
  const now = Math.floor(Date.now() / 1000);
  for (const e of EMAILS) upsertQuota(db, { account: e, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  const scn = join(tmp, 'scn.json');
  writeFileSync(scn, JSON.stringify({ steps: [{ waitUser: true }] }));
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 'graph-queue-token', staticDir: null, command: [process.execPath, FAKE], graphModule: true,
    loginEnv: {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, FAKE_CBM_LOG: cbmLog, FAKE_CBM_STATE: state, FAKE_CBM_INDEX_MS: '150' },
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
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§5.5 boot (module ready)', () => {
  test('the project root with no index → indexed by a synchronous request on its own front (not the control front, no async)', async () => {
    await until(() => roots().includes(shop()), 'shop indexed');
    const idx = events().filter((e) => e.name === 'index_repository' && e.args?.repo_path === shop());
    expect(idx).toHaveLength(1);
    expect(idx[0]!.args).toEqual({ repo_path: shop(), format: 'json' });
    const control = events().find((e) => e.ev === 'start' && e.cwd === realpathSync(paths().home))!.pid;
    expect(idx[0]!.pid).not.toBe(control);
    expect(book()).toContainEqual({ root_path: shop(), origin: 'project' });
  });
  test('clean-up: the deleted worktree in the book (lane row) → delete_project + row dropped; the orphan outside the book stays', async () => {
    await until(() => !roots().includes(join(tmp, 'wt-old')), 'old-wt deleted');
    expect(roots()).toContain(join(tmp, 'user-gone'));
    expect(events().filter((e) => e.name === 'delete_project').map((e) => e.args?.project)).toEqual(['old-wt']);
    await until(() => !book().some((r) => r.root_path === join(tmp, 'wt-old')), 'book row dropped');
  });
});

describe('§5.5 lanes', () => {
  test('a spawn in a worktree with no index → that cwd is indexed (book: lane)', async () => {
    for (const n of ['D1', 'D2']) await engine.lanes.start({ projectId: 'p1', name: n, cwd: wt(n), briefPath: join(tmp, 'brief.md') });
    await until(() => roots().includes(wt('D1')) && roots().includes(wt('D2')), 'worktrees indexed');
    expect(book()).toEqual(expect.arrayContaining([{ root_path: wt('D1'), origin: 'lane' }, { root_path: wt('D2'), origin: 'lane' }]));
  });
  test('index_repository from a lane → the queue reply at once; status:true is answered by the engine until succeeded', async () => {
    const t = tokenOf('D1');
    const r = await tool(t, 'index_repository', { repo_path: join(wt('D1'), 'pkg') });
    expect(r.body).toMatchObject({ state: 'queued', async: true, repo_path: join(wt('D1'), 'pkg'), ahead: 0 });
    const seen = new Set<unknown>();
    const end = Date.now() + 15_000;
    for (let st: unknown; st !== 'succeeded';) {
      if (Date.now() > end) throw new Error('pkg never succeeded');
      st = (await tool(t, 'index_repository', { repo_path: join(wt('D1'), 'pkg'), status: true })).body.state;
      seen.add(st);
      await Bun.sleep(20);
    }
    expect(roots()).toContain(join(wt('D1'), 'pkg'));
    // the session front never got the status calls: the engine answered them
    expect(events().filter((e) => e.cwd === wt('D1') && e.name === 'index_repository')).toEqual([]);
  });
  test('a lane done whose worktree is gone → its index deleted through the queue, its book row dropped', async () => {
    await engine.lanes.stop('p1', 'D2', 'now');
    await until(() => engine.lanes.get('p1', 'D2')!.state === 'stopped', 'D2 stopped');
    rmSync(wt('D2'), { recursive: true, force: true });
    expect(roots()).toContain(wt('D2')); // a stopped lane is not done: nothing cleaned yet
    await engine.lanes.finish('p1', 'D2', true);
    await until(() => !roots().includes(wt('D2')), 'D2 index deleted');
    await until(() => !book().some((r) => r.root_path === wt('D2')), 'D2 row dropped');
    expect(roots()).toContain(wt('D1'));
    expect(existsSync(wt('D1'))).toBe(true);
  });
});
