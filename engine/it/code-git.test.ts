// v2.3 §11 Integration: a real git repo in a temp dir + a fake-claude lane on its own worktree, over the engine's WS.
// Worktree + 2 commits → git_changes; main edits the same line → conflicts; lane Edit → code_changed with paths; lane
// Bash → code_changed without paths. The PO's git config never leaks in (GIT_CONFIG_GLOBAL=/dev/null).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, EngineEvent, GitBranchesResult, GitChangesResult, ServerMsg } from '../../shared/protocol.ts';
import { getLane, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const TOKEN = 'test-token-code';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
type Step = Record<string, unknown>;

let tmp: string, repo: string, wt: string, projectId: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let scenario: Step[] = [];

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

const tool = (id: string, name: string, input: Record<string, unknown>): Step => ({ emit: [
  { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
  { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
] });
const result: Step = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } };
const ORCH_STEPS: Step[] = [{ waitUser: true }, tool('o-bash', 'Bash', { command: 'make' }), result, { waitUser: true }];

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
const ack = <T>(m: ServerMsg): T => { if (m.type !== 'ack') throw new Error(JSON.stringify(m)); return m.result as T; };

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-code-it-')));
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
  commit(wt, 'README', 'lane\n');
  commit(wt, 'd1.txt', 'one\ntwo\n');
  writeFileSync(join(wt, 'src.ts'), 'x\n');
  mkdirSync(join(tmp, 'web'), { recursive: true });
  writeFileSync(join(tmp, 'web', 'index.html'), '<!doctype html>');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(db, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  // Only the lane's first message carries EDIT (the orchestrator never sees it): Edit, then (after BASH) Bash.
  // Then CFG → a second Bash. `scenario` is swapped to ORCH_STEPS before the orchestrator starts.
  scenario = [{ waitUser: 'EDIT' }, tool('t-edit', 'Edit', { file_path: join(wt, 'src.ts') }), result, { waitUser: 'BASH' }, tool('t-bash', 'Bash', { command: 'make' }), result,
    { waitUser: 'CFG' }, tool('t-cfg', 'Bash', { command: 'git config filter.x.clean cat' }), result, { waitUser: true }];
  engine = await Engine.start({
    version: 'test', port: 0, token: TOKEN, staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}) }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => { const f = join(tmp, `scn-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify({ steps: scenario })); return { FAKE_CLAUDE_SCENARIO: f }; },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    gh: async () => null, branchPollMs: 0,
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

describe('§11 Integration: Code + Git over the engine', () => {
  test('§11 worktree + 2 commits → git_changes; main edits the same line → conflicts in git_branches and git_changes', async () => {
    const c = await connect();
    projectId = ack<{ id: string }>(await c.cmd({ cmd: 'project_add', name: 'Shop', path: repo })).id;
    await engine.lanes.start({ projectId, name: 'D1', cwd: wt, briefPath: '/b/D1.md' });
    const ch = ack<GitChangesResult>(await c.cmd({ cmd: 'git_changes', projectId, of: { branch: 'lane/d1' } }));
    expect(ch.files).toEqual([{ path: 'README', status: 'M', add: 1, del: 1 }, { path: 'd1.txt', status: 'A', add: 2, del: 0 }]);

    commit(repo, 'README', 'MAIN\n');
    const ch2 = ack<GitChangesResult>(await c.cmd({ cmd: 'git_changes', projectId, of: { branch: 'lane/d1' } }));
    expect(ch2.files.find((f) => f.path === 'README')?.conflict).toBe(true);
    await engine.branches.measure(getLane(engine.db, projectId, 'D1')!);
    const br = ack<GitBranchesResult>(await c.cmd({ cmd: 'git_branches', projectId }));
    expect(br.base).toMatchObject({ name: 'main', unpushed: null });
    expect(br.lanes).toHaveLength(1);
    expect(br.lanes[0]).toMatchObject({ lane: 'D1', name: 'lane/d1', branch: { state: 'unmerged', ahead: 2, behind: 1, conflicts: ['README'], dirty: 1 } });
    c.close();
  });

  test('§11 lane Edit → code_changed with the path; lane Bash → code_changed without paths (Mac connection)', async () => {
    const c = await connect();
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'idle', 'D1 idle');
    await engine.lanes.message(projectId, 'D1', 'EDIT please', 'po');
    const lane = { kind: 'lane' as const, laneId: 'D1' };
    await until(() => c.events('code_changed').some((e) => e.paths !== undefined), 'code_changed after Edit');
    expect(c.events('code_changed')).toContainEqual({ type: 'code_changed', projectId, src: lane, paths: ['src.ts'] });
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'idle', 'D1 idle again');
    await engine.lanes.message(projectId, 'D1', 'BASH please', 'po');
    await until(() => c.events('code_changed').some((e) => e.paths === undefined), 'code_changed after Bash');
    expect(c.events('code_changed').filter((e) => e.paths === undefined)).toEqual([{ type: 'code_changed', projectId, src: lane }]);
    c.close();
  });

  test('§10.2 (d) orchestrator Bash → code_changed for the base source, without paths', async () => {
    const c = await connect();
    scenario = ORCH_STEPS;
    await engine.orchestrators.start(projectId, 'go');
    await until(() => c.events('code_changed').some((e) => e.src.kind === 'base'), 'code_changed after orchestrator Bash', 5_000);
    expect(c.events('code_changed')).toEqual([{ type: 'code_changed', projectId, src: { kind: 'base' } }]);
    c.close();
  });

  test('§10.2 lane Bash after a repo config adds filter.x.clean → code_changed drops the cached config scan → git_changes unknown program', async () => {
    const c = await connect();
    ack<GitChangesResult>(await c.cmd({ cmd: 'git_changes', projectId, of: { branch: 'lane/d1' } })); // scan cached (60 s)
    git(wt, 'config', 'filter.x.clean', 'cat');
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'idle', 'D1 idle');
    await engine.lanes.message(projectId, 'D1', 'CFG please', 'po');
    await until(() => c.events('code_changed').length > 0, 'code_changed after lane Bash');
    expect(await c.cmd({ cmd: 'git_changes', projectId, of: { branch: 'lane/d1' } })).toMatchObject({ type: 'error', code: 'git_unknown', key: 'errors.gitProgram', params: { key: 'filter.x.clean' } });
    c.close();
  });
});
