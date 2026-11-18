// v2.1 §4.15 Engine end to end: a real lane (fake-claude) on a real git worktree reports done → measured, not counted;
// lane_finish → counted ("n chưa merge"); done_lanes_list over WS; done-lane view opened when stale → re-measured.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, DoneLanesPage, EngineEvent, ServerMsg } from '../../shared/protocol.ts';
import { getLane, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const TOKEN = 'test-token-br';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
type Step = Record<string, unknown>;
const result = (text: string): Step => ({ emit: { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } });
const turns = (k: number): Step[] => Array.from({ length: k }, (_, i) => [{ waitUser: true }, result(`ok ${i}`)]).flat();

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let repo: string;
let wt: string;
let projectId: string;
const gh: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function commit(cwd: string, file: string, body: string): void { writeFileSync(join(cwd, file), body); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', file); }

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}
interface Client { cmd(c: Command): Promise<ServerMsg>; close(): void; events<K extends EngineEvent['type']>(type: K): Extract<EngineEvent, { type: K }>[] }
let n = 0;
async function connect(): Promise<Client> {
  const port = engine.port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${port}` } } as unknown as string[]);
  const msgs: ServerMsg[] = [];
  ws.onmessage = (m) => msgs.push(JSON.parse(String(m.data)) as ServerMsg);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  await until(() => msgs.some((m) => m.type === 'snapshot'), 'snapshot');
  return {
    async cmd(command) {
      const id = `c${++n}`;
      ws.send(JSON.stringify({ type: 'command', id, command }));
      const isReply = (m: ServerMsg) => (m.type === 'ack' || m.type === 'error') && m.id === id;
      await until(() => msgs.some(isReply), `reply to ${command.cmd}`);
      return msgs.find(isReply)!;
    },
    close: () => ws.close(),
    events: (type) => msgs.filter((m) => m.type === 'event' && m.event.type === type).map((m) => (m as unknown as { event: never }).event),
  };
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-branch-it-')));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  repo = join(tmp, 'shop');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  commit(repo, 'README', 'base\n');
  wt = join(tmp, 'wt-D1');
  git(repo, 'worktree', 'add', '-q', '-b', 'lane/d1', wt, 'main');
  commit(wt, 'd1.txt', 'one\ntwo\n');
  mkdirSync(join(tmp, 'web'), { recursive: true });
  writeFileSync(join(tmp, 'web', 'index.html'), '<!doctype html>');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(db, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  engine = await Engine.start({
    version: 'test', port: 0, token: TOKEN, staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}) }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => { const f = join(tmp, `scn-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify({ steps: turns(6) })); return { FAKE_CLAUDE_SCENARIO: f }; },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    gh: async (_r, b) => { gh.push(b); return null; }, // never the real gh (network)
    branchPollMs: 0,
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0, statsEveryMs: 0,
    log: () => {}, hasLogin: () => true,
  });
});
afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§4.15 Engine branch measurement, end to end', () => {
  test('§4.15 reported done → LaneView.branch measured but not counted; lane_finish → "1 chưa merge"; done_lanes_list', async () => {
    const c = await connect();
    const r = await c.cmd({ cmd: 'project_add', name: 'Shop', path: repo });
    projectId = (r as { result: { id: string } }).result.id;
    await engine.lanes.start({ projectId, name: 'D1', cwd: wt, briefPath: '/b/D1.md' });
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'idle', 'D1 idle');
    const d1 = () => c.events('lane').filter((e) => e.lane.name === 'D1').map((e) => e.lane);
    expect(d1().every((l) => l.branch === null)).toBe(true); // nothing measured while it codes

    await engine.lanes.setPhase(projectId, 'D1', { phase: 'done', note: 'xong' }); // what the lane's lane_set_phase runs
    await until(() => d1().some((l) => l.branch?.state === 'unmerged' && !l.branch.measuring), 'measured after "báo xong"');
    expect(d1().at(-1)!.branch).toMatchObject({ name: 'lane/d1', base: 'main', state: 'unmerged', ahead: 1, files: 1, add: 2, del: 0 });
    expect(engine.projectView(projectId)!.unmerged).toBe(0); // §4.15 reported done never counts
    expect(gh).toContain('lane/d1');

    await engine.lanes.finish(projectId, 'D1', true);
    await until(() => c.events('project').some((e) => e.project.id === projectId && e.project.unmerged === 1), 'counted after lane_finish');
    const id = getLane(engine.db, projectId, 'D1')!.id;
    await until(() => engine.branches.info(id)?.measuring === false, 'lane_finish measurement settled');
    expect(engine.snapshot('mac').projects.find((p) => p.id === projectId)!.unmerged).toBe(1);

    const page = await c.cmd({ cmd: 'done_lanes_list', projectId, limit: 6 });
    expect(page.type).toBe('ack');
    const res = (page as { result: DoneLanesPage }).result;
    expect(res).toMatchObject({ total: 1, unmerged: 1, unknown: 0, next: null });
    expect(res.lanes.map((l) => [l.name, l.state, l.branch?.state])).toEqual([['D1', 'done', 'unmerged']]);
    const other = (await c.cmd({ cmd: 'done_lanes_list', projectId, session: 'not-its-owner', limit: 6 })) as { result: DoneLanesPage };
    expect(other.result.lanes).toEqual([]); // §4.15 `session` filter reaches the query; counts stay project-wide
    expect(other.result.total).toBe(1);
    expect((await c.cmd({ cmd: 'done_lanes_list', projectId: 'nope' })).type).toBe('error');
    c.close();
  });

  test('§4.15 done-lane view opened: fresh (< 60 s) → no re-measure; stale + squash merged → merged, count back to 0', async () => {
    const c = await connect();
    git(repo, 'merge', '-q', '--squash', 'lane/d1'); git(repo, 'commit', '-q', '-m', 'squash D1');
    const target = { kind: 'lane' as const, projectId, name: 'D1' };
    expect(await c.cmd({ cmd: 'watch', target })).toMatchObject({ type: 'ack' });
    await Bun.sleep(300);
    expect(c.events('lane').some((e) => e.lane.name === 'D1' && e.lane.branch?.measuring)).toBe(false);
    const id = getLane(engine.db, projectId, 'D1')!.id;
    engine.db.query("UPDATE lane SET branch_json = json_set(branch_json, '$.measuredAt', 0) WHERE id = ?").run(id);
    expect(await c.cmd({ cmd: 'watch', target: null })).toMatchObject({ type: 'ack' });
    expect(await c.cmd({ cmd: 'watch', target })).toMatchObject({ type: 'ack' });
    await until(() => c.events('lane').some((e) => e.lane.name === 'D1' && e.lane.branch?.state === 'merged'), 'merged after re-measure');
    // §4.15 Trạng thái "đang đo…": pushed first, with the old numbers
    expect(c.events('lane').find((e) => e.lane.name === 'D1' && e.lane.branch?.measuring)?.lane.branch).toMatchObject({ state: 'unmerged', ahead: 1, measuredAt: 0 });
    await until(() => c.events('project').some((e) => e.project.id === projectId && e.project.unmerged === 0), 'count 0');
    c.close();
  });
});
