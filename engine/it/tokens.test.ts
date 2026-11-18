// v2.1 §5.3 W9 W10 end to end: fake-claude turns with `usage` → lane / orchestrator `tokens`, today / 5 h stats rebuilt
// from state.db after an engine restart, and subagent delivery (local = every lane of the watched project, remote =
// watched target only). Temp homes, fake keychain / exec; never the real ~/.cc-slaves, the Keychain or any API.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { displayTokens, type Command, type EngineEvent, type ServerMsg, type Snapshot, type SubagentView, type Target, type TokenCounts } from '../../shared/protocol.ts';
import { openDb, sessionTokens, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import type { Conn } from '../src/server/ws.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const USAGE = JSON.parse(readFileSync(resolve(import.meta.dir, '../../fake-claude/scenarios/usage-turns.json'), 'utf8')) as { steps: object[] };
const O = 'o@x.test';
const TOKEN = 'test-token-tok';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const T = (input: number, output: number, cacheWrite: number, cacheRead: number): TokenCounts => ({ input, output, cacheWrite, cacheRead });
const ORCH_T1 = T(110, 25, 50, 1000), ORCH_T2 = T(2, 2, 2, 2), LANE_T1 = T(7, 3, 0, 500);
const CUT_DIE = T(40, 6, 0, 300), CUT_STOP = T(9, 4, 2, 80), CUT_KILL = T(3, 1, 0, 20); // cut short: died / engine stopped / lane stopped now
const usageLine = (id: string, t: TokenCounts) => ({ emit: { type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: '…' }],
  usage: { input_tokens: t.input, output_tokens: t.output, cache_creation_input_tokens: t.cacheWrite, cache_read_input_tokens: t.cacheRead } } } });
const sum = (...xs: TokenCounts[]) => xs.reduce((a, b) => T(a.input + b.input, a.output + b.output, a.cacheWrite + b.cacheWrite, a.cacheRead + b.cacheRead));

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let scenario: object = { steps: [] };
/** Scenarios for the next spawns, in order (then `scenario`). */
let queue: object[] = [];
let projectId: string;
let wt: string;

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}

interface Client { msgs: ServerMsg[]; cmd(c: Command): Promise<ServerMsg>; close(): void; events<K extends EngineEvent['type']>(type: K): Extract<EngineEvent, { type: K }>[] }
let n = 0;
async function connect(): Promise<Client> {
  const port = engine.port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${port}` } } as unknown as string[]);
  const msgs: ServerMsg[] = [];
  ws.onmessage = (m) => msgs.push(JSON.parse(String(m.data)) as ServerMsg);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  await until(() => msgs.some((m) => m.type === 'snapshot'), 'snapshot');
  return {
    msgs,
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

/** A remote (v3) connection on the hub itself: the engine has no remote listener yet, the delivery rule is the hub's. */
function remote(watch: Target | null): { conn: Conn; subs: () => { target: Target; subagents: SubagentView[] }[] } {
  const got: ServerMsg[] = [];
  const conn: Conn = { channel: 'remote', watch, present: false, send: (m) => { got.push(m); } };
  engine.hub.open(conn);
  return { conn, subs: () => got.flatMap((m) => (m.type === 'event' && m.event.type === 'subagents' ? [m.event] : [])) };
}

const startEngine = () => Engine.start({
  gh: null, // never the real gh (network)
  version: 'test', port: 0, token: TOKEN, staticDir: join(tmp, 'web'), command: ['bun', FAKE],
  loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
  extraEnv: () => {
    const f = join(tmp, `scn-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(queue.shift() ?? scenario));
    return { FAKE_CLAUDE_SCENARIO: f };
  },
  quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
  caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
  exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
  fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
  notify: { osascript: () => {}, postGchat: async () => {} },
  session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
  statsEveryMs: 0, statsThrottleMs: 50,
  log: () => {}, hasLogin: () => true,
});

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-tok-it-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'shop', '.git'), { recursive: true });
  mkdirSync(join(tmp, 'web'), { recursive: true });
  writeFileSync(join(tmp, 'web', 'index.html'), '<!doctype html>');
  wt = join(tmp, 'wt-D1');
  mkdirSync(wt, { recursive: true });
  for (const d of ['wt-D2', 'wt-D3', 'wt-D4']) mkdirSync(join(tmp, d), { recursive: true });
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(db, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  engine = await startEngine();
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§5.3 W10 tokens from fake-claude usage', () => {
  test('§5.3 W10 two orchestrator turns: provisional within the turn, exact result.usage after, cumulative over turns', async () => {
    const c = await connect();
    scenario = USAGE;
    const r = await c.cmd({ cmd: 'project_add', name: 'Shop', path: join(tmp, 'shop') });
    projectId = (r as { result: { id: string } }).result.id;
    await c.cmd({ cmd: 'project_resume', id: projectId }); // hf1116 H2: an added project waits for "Bắt đầu"
    const orchTokens = () => c.events('orchestrator').filter((e) => e.orchestrator.projectId === projectId).map((e) => e.orchestrator.tokens);
    // turn 1 (the engine's first message): the two lines of msg_u1 count once, last usage wins → 100/20/50/1000
    await until(() => orchTokens().some((t) => t?.output === 20), 'provisional tokens within the turn');
    expect(orchTokens().find((t) => t?.output === 20)).toEqual(T(100, 20, 50, 1000));
    await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'turn 1 done');
    expect(engine.orchestrators.get(projectId)!.view().tokens).toEqual(ORCH_T1); // result.usage replaced the provisional sum
    expect(await c.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId }, text: 'tiếp' })).toMatchObject({ type: 'ack' });
    await until(() => orchTokens().at(-1)?.input === 112 && engine.orchestrators.get(projectId)?.view().state === 'idle', 'turn 2 done');
    const snap = (c.msgs.find((m) => m.type === 'snapshot') as { snapshot: Snapshot }).snapshot;
    expect(snap.stats).toBeDefined();
    const live = engine.snapshot('mac');
    expect(live.orchestrators.find((o) => o.projectId === projectId)!.tokens).toEqual(sum(ORCH_T1, ORCH_T2));
    expect(displayTokens(live.orchestrators.find((o) => o.projectId === projectId)!.tokens!)).toBe(112 + 27 + 52); // W4 no cacheRead
    expect(live.stats!.projects[projectId]).toEqual({ tokensToday: sum(ORCH_T1, ORCH_T2), costTodayUsd: 0.03 });
    await until(() => c.events('stats').some((e) => e.stats.projects[projectId]?.tokensToday.input === 112), 'stats event pushed');
    c.close();
  });

  test('§5.3 W9 subagents: local connection gets every lane of its watched project, remote keeps watched-only', async () => {
    const mac = await connect();
    const O_T: Target = { kind: 'orchestrator', projectId };
    const D1: Target = { kind: 'lane', projectId, name: 'D1' };
    expect(await mac.cmd({ cmd: 'watch', target: O_T })).toMatchObject({ type: 'ack' }); // project selected, lane not
    const remOrch = remote(O_T), remLane = remote(D1);
    scenario = { steps: [
      { waitUser: true },
      { emit: [
        { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_l1', role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id: 'toolu_sa1', name: 'Task', input: { description: 'tìm', subagent_type: 'Explore', prompt: 'tìm' } }], usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 400 } } },
        { type: 'system', subtype: 'task_started', task_id: 'sa1', tool_use_id: 'toolu_sa1', description: 'tìm', subagent_type: 'Explore' },
        { type: 'system', subtype: 'task_progress', task_id: 'sa1', usage: { total_tokens: 1234 }, tool_uses: 1, last_tool_name: 'Bash' },
        { type: 'system', subtype: 'task_started', task_id: 'sa2', tool_use_id: 'toolu_sa2', description: 'hỏng', subagent_type: 'Plan' },
        { type: 'system', subtype: 'task_notification', task_id: 'sa2', status: 'failed' },
      ] },
      { sleep: 1500 },
      { emit: [
        { type: 'system', subtype: 'task_updated', task_id: 'sa1', status: 'completed' },
        { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.005, model_usage_since_last_result: { 'claude-fake': { costUSD: 0.005 } }, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 500 }, permission_denials: [] },
      ] },
    ] };
    await engine.lanes.start({ projectId, name: 'D1', cwd: wt, briefPath: '/b/D1.md' });
    const macSubs = () => mac.events('subagents').filter((e) => e.target.kind === 'lane' && e.target.name === 'D1');
    await until(() => macSubs().some((e) => e.subagents[0]?.totalTokens === 1234), 'local gets D1 subagents while watching the orchestrator');
    await until(() => macSubs().some((e) => e.subagents[1]?.status === 'failed'), 'sa2 failed');
    expect(macSubs().at(-1)!.subagents[0]).toMatchObject({ taskId: 'sa1', subagentType: 'Explore', status: 'running', endedAt: null, lastTool: 'Bash' });
    expect(remOrch.subs()).toEqual([]); // remote watching the orchestrator: not D1's
    expect(remLane.subs().at(-1)?.subagents[0]?.taskId).toBe('sa1'); // remote watching D1: yes
    // a local connection that watches after the fact gets the current lists at once (pushSubagents)
    const late = await connect();
    expect(late.events('subagents')).toEqual([]);
    expect(await late.cmd({ cmd: 'watch', target: O_T })).toMatchObject({ type: 'ack' });
    // pushed synchronously by the watch handler, so it is there with the ack (before sa1 changes again)
    expect(late.events('subagents').map((e) => e.subagents.map((x) => `${x.taskId}:${x.status}`))).toEqual([['sa1:running', 'sa2:failed']]);
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'idle', 'D1 turn done');
    await until(() => macSubs().at(-1)!.subagents.length === 1, 'the turn result drops the failed subagent (§4.5)');
    const ended = macSubs().at(-1)!.subagents[0]!;
    expect(ended.taskId).toBe('sa1');
    expect(ended.status).toBe('completed');
    expect(typeof ended.endedAt).toBe('number');
    expect(engine.laneView(projectId, 'D1')!.tokens).toEqual(LANE_T1);
    engine.hub.close(remOrch.conn); engine.hub.close(remLane.conn);
    mac.close(); late.close();
  });

  test('§5.3 a turn cut short keeps its reported tokens: process died (D2) and engine stopping mid-turn (D3, next test)', async () => {
    await until(() => engine.hub.size === 0, 'no client connected');
    const orig = engine.tokenStats.bind(engine);
    let statsCalls = 0;
    engine.tokenStats = (n?: number) => { statsCalls++; return orig(n); };
    scenario = { steps: [] }; // respawns after the death report nothing
    queue = [{ steps: [{ waitUser: true }, usageLine('msg_cut1', CUT_DIE), { sleep: 100 }, { die: {} }] }];
    await engine.lanes.start({ projectId, name: 'D2', cwd: join(tmp, 'wt-D2'), briefPath: '/b/D2.md' });
    await until(() => engine.db.query("SELECT 1 FROM event e JOIN lane l ON l.session_id = e.session_id WHERE l.name = 'D2' AND e.type = 'usage'").get() !== null, 'D2 cut usage stored');
    expect(engine.laneView(projectId, 'D2')!.tokens).toEqual(CUT_DIE);
    queue = [{ steps: [{ waitUser: true }, usageLine('msg_cut3', CUT_KILL), { sleep: 60_000 }] }];
    await engine.lanes.start({ projectId, name: 'D4', cwd: join(tmp, 'wt-D4'), briefPath: '/b/D4.md' });
    await until(() => engine.laneView(projectId, 'D4')?.tokens?.input === CUT_KILL.input, 'D4 provisional tokens');
    await engine.lanes.stop(projectId, 'D4', 'now'); // killed mid-turn
    await until(() => engine.lanes.get(projectId, 'D4')?.state === 'stopped', 'D4 stopped');
    expect(sessionTokens(engine.db, [engine.lanes.get(projectId, 'D4')!.sessionId])).toEqual(CUT_KILL); // stored, not only in memory
    queue = [{ steps: [{ waitUser: true }, usageLine('msg_cut2', CUT_STOP), { sleep: 60_000 }] }];
    await engine.lanes.start({ projectId, name: 'D3', cwd: join(tmp, 'wt-D3'), briefPath: '/b/D3.md' });
    await until(() => engine.laneView(projectId, 'D3')?.tokens?.input === CUT_STOP.input, 'D3 provisional tokens');
    await Bun.sleep(120); // > statsThrottleMs
    expect(statsCalls).toBe(0); // MINOR-1: lane events with no client connected run no stats query
    engine.tokenStats = orig;
    expect(engine.snapshot('mac').stats!.projects[projectId]!.tokensToday).toEqual(sum(ORCH_T1, ORCH_T2, LANE_T1, CUT_DIE, CUT_STOP, CUT_KILL));
  });

  test('§5.3 restart: lane / orchestrator tokens and today / 5 h stats are rebuilt from state.db', async () => {
    const before = engine.snapshot('mac');
    await engine.stop();
    scenario = { steps: [] };
    engine = await startEngine();
    const after = engine.snapshot('mac');
    expect(after.lanes.find((l) => l.name === 'D1')!.tokens).toEqual(LANE_T1);
    expect(after.orchestrators.find((o) => o.projectId === projectId)!.tokens).toEqual(sum(ORCH_T1, ORCH_T2));
    expect(after.lanes.find((l) => l.name === 'D2')!.tokens).toEqual(CUT_DIE);
    expect(after.lanes.find((l) => l.name === 'D3')!.tokens).toEqual(CUT_STOP); // engine stopped mid-turn
    expect(after.lanes.find((l) => l.name === 'D4')!.tokens).toEqual(CUT_KILL);
    expect(after.stats!.projects[projectId]!.tokensToday).toEqual(sum(ORCH_T1, ORCH_T2, LANE_T1, CUT_DIE, CUT_STOP, CUT_KILL));
    expect(after.stats!.projects[projectId]!.costTodayUsd).toBeCloseTo(0.035);
    expect(after.stats!.tokens5h).toEqual(sum(ORCH_T1, ORCH_T2, LANE_T1, CUT_DIE, CUT_STOP, CUT_KILL));
    expect(after.stats!.tokens5h).toEqual(before.stats!.tokens5h);
  });
});
