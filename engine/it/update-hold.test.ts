// v2.6 §5.4 (E1a) the update hold end to end: real engine + Mac WS + fake-claude, temp homes, random port. A turn
// running → `engine.update.busy` + `update_commit {ok:false}`; the turn ends → busy empty, commit ok; the holding WS
// closes → released, every connection told. Never the real ~/.cc-slaves, Keychain or any API.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, EngineInfo, ServerMsg } from '../../shared/protocol.ts';
import { openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const TOKEN = 'test-token-upd';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
type Step = Record<string, unknown>;
const assistant = (text: string): Step => ({ emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] } } });
const result = (text: string): Step => ({ emit: { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } });

let tmp: string; let saved: Record<string, string | undefined>; let engine: Engine; let stdinLog: string;
let scenario: object = { steps: [] };

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}
interface Client { msgs: ServerMsg[]; cmd(c: Command): Promise<ServerMsg>; close(): void; infos(): EngineInfo[] }
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
    infos: () => msgs.flatMap((m) => (m.type === 'event' && m.event.type === 'engine' ? [m.event.engine] : m.type === 'snapshot' ? [m.snapshot.engine] : [])),
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-upd-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'shop', '.git'), { recursive: true });
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  stdinLog = join(tmp, 'stdin.log');
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(db, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  engine = await start();
});

let spawn = 0;
const start = () => Engine.start({
  gh: null, version: 'test', port: 0, token: TOKEN, staticDir: null, command: ['bun', FAKE],
  loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
  extraEnv: () => {
    const f = join(tmp, `scn-${++spawn}.json`);
    writeFileSync(f, JSON.stringify(scenario));
    return { FAKE_CLAUDE_SCENARIO: f, FAKE_CLAUDE_STDIN_LOG: stdinLog };
  },
  quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
  caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
  exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
  fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
  notify: { osascript: () => {}, postGchat: async () => {} },
  session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
  updateTickMs: 20, log: () => {}, hasLogin: (a) => a.email === O,
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

test('§5.4 hold on a running turn: busy + commit refused; turn ends → busy empty, commit ok; holder WS closes → released', async () => {
  const app = await connect();
  const web = await connect();
  expect(web.infos()[0]!.update).toEqual({ hold: false, since: null, busy: [], held: 0 });
  scenario = { steps: [{ waitUser: true }, assistant('a1'), result('r1'), { waitUser: true }, assistant('đang làm'), { sleep: 1200 }, result('xong'), { waitUser: true }] };
  const added = await app.cmd({ cmd: 'project_add', name: 'Shop', path: join(tmp, 'shop') });
  const projectId = (added as { result: { id: string } }).result.id;
  await app.cmd({ cmd: 'project_resume', id: projectId });
  await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'orchestrator idle');
  const sid = engine.orchestrators.get(projectId)!.currentSessionId;

  expect(await web.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId }, text: 'làm việc' })).toMatchObject({ type: 'ack' });
  await until(() => existsSync(stdinLog) && readFileSync(stdinLog, 'utf8').includes('[PO] làm việc'), 'PO text written');
  await until(() => engine.orchestrators.get(projectId)!.turnStartedAt !== null, 'turn running');

  expect(await app.cmd({ cmd: 'update_hold', on: true })).toMatchObject({ type: 'ack' });
  await until(() => web.infos().some((i) => i.update?.hold === true), 'hold reaches the web');
  const held = web.infos().find((i) => i.update?.hold)!.update!;
  expect(held.busy).toEqual([{ projectId, kind: 'orchestrator', name: sid, turnStartedAt: expect.any(Number) as number }]);
  expect(await app.cmd({ cmd: 'update_commit' })).toMatchObject({ type: 'ack', result: { ok: false, busy: [{ projectId, kind: 'orchestrator' }] } });
  expect(await web.cmd({ cmd: 'update_commit' })).toMatchObject({ type: 'error', code: 'not_holding' });

  await until(() => web.infos().at(-1)!.update?.hold === true && web.infos().at(-1)!.update!.busy.length === 0, 'turn end reaches the web', 8000);
  expect(await app.cmd({ cmd: 'update_commit' })).toMatchObject({ type: 'ack', result: { ok: true } });
  expect(await web.cmd({ cmd: 'update_hold', on: false })).toMatchObject({ type: 'ack' }); // not the holder: no effect
  expect(engine.update.view().hold).toBe(true);

  app.close();
  await until(() => web.infos().at(-1)!.update?.hold === false, 'release reaches the web');
  expect(engine.update.view()).toEqual({ hold: false, since: null, busy: [], held: 0 });
  web.close();
});

test('§5.4-1/5 (E1b) idle → update_ready + backup to the holder only; a PO message is held (held 1), written once the holder WS closes', async () => {
  const app = await connect();
  const web = await connect();
  mkdirSync(join(tmp, 'shop2', '.git'), { recursive: true });
  scenario = { steps: [{ waitUser: true }, assistant('a1'), result('r1'), { waitUser: true }, assistant('a2'), result('r2'), { waitUser: true }] };
  const added = await app.cmd({ cmd: 'project_add', name: 'Shop2', path: join(tmp, 'shop2') });
  const projectId = (added as { result: { id: string } }).result.id;
  await app.cmd({ cmd: 'project_resume', id: projectId });
  await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'orchestrator idle');

  expect(await app.cmd({ cmd: 'update_hold', on: true })).toMatchObject({ type: 'ack' });
  const readyOf = (c: Client) => c.msgs.flatMap((m) => (m.type === 'event' && m.event.type === 'update_ready' ? [m.event.backup] : []));
  await until(() => readyOf(app).length === 1, 'update_ready to the app');
  const backup = readyOf(app)[0]!;
  expect(backup.startsWith(join(tmp, 'home', 'backups', 'state-test-'))).toBe(true);
  expect(existsSync(backup)).toBe(true);
  expect(readyOf(web)).toEqual([]);

  expect(await web.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId }, text: 'giữ tin' })).toMatchObject({ type: 'ack' });
  await until(() => web.infos().at(-1)!.update?.held === 1, 'held 1 reaches the web');
  await Bun.sleep(200);
  expect(readFileSync(stdinLog, 'utf8')).not.toContain('[PO] giữ tin');
  expect(engine.orchestrators.get(projectId)!.view().state).toBe('idle');

  app.close();
  await until(() => readFileSync(stdinLog, 'utf8').includes('[PO] giữ tin'), 'held message written after the release');
  web.close();
});

test('§4.8 / §10.3 (E3) a PO message during the hold: echoed with `held`; written → `po_written`, label gone from history; later sends unlabelled', async () => {
  const app = await connect();
  const web = await connect();
  mkdirSync(join(tmp, 'shop3', '.git'), { recursive: true });
  scenario = { steps: [{ waitUser: true }, assistant('a1'), result('r1'), { waitUser: true }, assistant('a2'), result('r2'), { waitUser: true }, assistant('a3'), result('r3'), { waitUser: true }] };
  const added = await app.cmd({ cmd: 'project_add', name: 'Shop3', path: join(tmp, 'shop3') });
  const projectId = (added as { result: { id: string } }).result.id;
  await app.cmd({ cmd: 'project_resume', id: projectId });
  await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'orchestrator idle');
  const target = { kind: 'orchestrator', projectId } as const;
  await web.cmd({ cmd: 'watch', target });
  const poLines = () => web.msgs.flatMap((m) => (m.type === 'event' && m.event.type === 'stream' ? m.event.lines.filter((l) => l.kind === 'po') : []));
  const history = async () => ((await web.cmd({ cmd: 'history', target })) as { result: { kind: string; text: string; held?: true }[] }).result.filter((l) => l.kind === 'po');

  await app.cmd({ cmd: 'update_hold', on: true });
  await web.cmd({ cmd: 'send', target, text: 'nhãn giữ' });
  await until(() => poLines().some((l) => l.text === 'nhãn giữ'), 'held line echoed');
  const line = poLines().find((l) => l.text === 'nhãn giữ')!;
  expect(line.held).toBe(true);
  expect((await history()).find((l) => l.text === 'nhãn giữ')?.held).toBe(true);

  app.close();
  const written = () => web.msgs.flatMap((m) => (m.type === 'event' && m.event.type === 'po_written' ? [m.event] : []));
  await until(() => written().length === 1, 'po_written to the watcher');
  expect(written()[0]).toEqual({ type: 'po_written', target, seqs: [line.seq] });
  await until(() => readFileSync(stdinLog, 'utf8').includes('[PO] nhãn giữ'), 'held line written');
  expect((await history()).find((l) => l.text === 'nhãn giữ')!.held).toBeUndefined();

  await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'turn done');
  await web.cmd({ cmd: 'send', target, text: 'không giữ' });
  await until(() => readFileSync(stdinLog, 'utf8').includes('[PO] không giữ'), 'plain send written');
  await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'turn 3 done');
  expect(poLines().filter((l) => l.text === 'không giữ').map((l) => l.held)).toEqual([undefined]); // shown at replay, never labelled
  expect(written().length).toBe(1);
  expect((await history()).find((l) => l.text === 'không giữ')).toEqual({ kind: 'po', text: 'không giữ', parentToolUseId: null, seq: expect.any(Number), ts: expect.any(Number) } as never);
  web.close();
});

test('§5.4-8 (E3) the engine restarts while a PO line is held: the next boot shows it unlabelled', async () => {
  const app = await connect();
  const web = await connect();
  mkdirSync(join(tmp, 'shop4', '.git'), { recursive: true });
  scenario = { steps: [{ waitUser: true }, assistant('a1'), result('r1'), { waitUser: true }] };
  const added = await app.cmd({ cmd: 'project_add', name: 'Shop4', path: join(tmp, 'shop4') });
  const projectId = (added as { result: { id: string } }).result.id;
  await app.cmd({ cmd: 'project_resume', id: projectId });
  await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'orchestrator idle');
  const target = { kind: 'orchestrator', projectId } as const;
  await app.cmd({ cmd: 'update_hold', on: true });
  await web.cmd({ cmd: 'send', target, text: 'qua khởi động' });
  const held = (r: ServerMsg) => (r as { result: { text: string; held?: true }[] }).result.find((l) => l.text === 'qua khởi động')?.held;
  expect(held(await web.cmd({ cmd: 'history', target }))).toBe(true);
  web.close();
  app.close();
  await engine.stop();
  engine = await start();
  const again = await connect();
  expect(held(await again.cmd({ cmd: 'history', target }))).toBeUndefined();
  again.close();
});
