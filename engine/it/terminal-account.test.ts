// hf1116 IT: the terminal login (`~/.claude` + `~/.claude.json` + the default Keychain item) is a normal account. Real engine,
// fake-claude sessions, a fake Keychain yes/no, a recorded `security` and a recorded `auth` pty. Never the real home.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, ServerMsg } from '../../shared/protocol.ts';
import type { PtyProc } from '../src/accounts/login.ts';
import { DEFAULT_KEYCHAIN_SERVICE, getAccount, terminalDismissed } from '../src/accounts/registry.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test'; // a cc-slaves account: the project's orchestrator
const T = 'term@x.test'; // the terminal login
const N = 'next@x.test', N2 = 'after@x.test'; // B-I3: the terminal signs in as another email (twice)
const TOKEN = 'term-token';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const security: string[][] = [];
const keychainAsked: string[] = [];
const authCalls: { argv: string[]; env: Record<string, string> }[] = [];

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let projectId: string;
let trace: string;

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}

async function cmd(command: Command): Promise<ServerMsg> {
  const port = engine.port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${port}` } } as unknown as string[]);
  const msgs: ServerMsg[] = [];
  ws.onmessage = (m) => msgs.push(JSON.parse(String(m.data)) as ServerMsg);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  await until(() => msgs.some((m) => m.type === 'snapshot'), 'snapshot');
  ws.send(JSON.stringify({ type: 'command', id: 'c1', command }));
  const isReply = (m: ServerMsg) => (m.type === 'ack' || m.type === 'error') && m.id === 'c1';
  await until(() => msgs.some(isReply), `reply to ${command.cmd}`);
  ws.close();
  return msgs.find(isReply)!;
}

const lane = () => engine.lanes.get(projectId, 'D2');

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-term-it-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude', 'projects'), { recursive: true });
  writeFileSync(join(tmp, 'claude', 'settings.json'), '{"canary":1}');
  writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: { emailAddress: T, accountUuid: 'tu', planDisplayName: 'Max 20x' } }));
  writeFileSync(paths().caps, JSON.stringify({ default: { week: 99 }, [O]: { role: 'orchestrator', week: 99 } }));
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  db.close();
  const claude = join(tmp, 'claude-bin');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(claude, 0o755);
  trace = join(tmp, 'trace-T.json');
  const scn = join(tmp, 'scn.json');
  writeFileSync(scn, JSON.stringify({ steps: [{ waitUser: true }, { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } }, { waitUser: true }] }));
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: TOKEN, staticDir: null, command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: tmp, CLAUDE_CONFIG_DIR: '/stale/inherited' }, claudePath: claude, shellFailed: false, reason: null },
    extraEnv: (a) => ({ FAKE_CLAUDE_SCENARIO: scn, ...(a.email === T ? { FAKE_CLAUDE_TRACE: trace } : {}) }),
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {},
    hasLogin: (a) => { keychainAsked.push(`${a.email} ${a.keychainService}`); return [O, T, N, N2].includes(a.email); },
    securityRun: (args) => { security.push(args); return { code: 44, stderr: 'could not be found' }; },
    authSpawn: (argv, env): PtyProc => { authCalls.push({ argv, env }); return { pid: 1, write() {}, onOutput() {}, exited: Promise.resolve(0) }; },
  });
  const projectDir = join(tmp, 'shop');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  const r = await cmd({ cmd: 'project_add', name: 'Shop', path: projectDir, orchestratorAccount: O });
  projectId = (r as { result: { id: string } }).result.id;
  await cmd({ cmd: 'project_resume', id: projectId }); // hf1116 H2: an added project waits for "Bắt đầu"
  const wt = join(tmp, 'wt-d2');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(tmp, 'brief.md'), 'x');
  await engine.lanes.start({ projectId, name: 'D2', cwd: wt, briefPath: join(tmp, 'brief.md'), account: T });
  await until(() => ['running', 'idle'].includes(lane()?.state ?? ''), 'D2 up on the terminal account');
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('hf1116 the terminal login is a normal account', () => {
  test('hf1116 T1 boot with a terminal login → listed like any account (terminal flag, default Keychain item, plan)', () => {
    expect(engine.accountViews().map((a) => a.email).sort()).toEqual([O, T]);
    expect(engine.accountViews().find((a) => a.email === T)).toMatchObject({ terminal: true, plan: 'Max 20x', role: 'primary', loggedOut: false });
    expect(engine.accountViews().find((a) => a.email === O)).toMatchObject({ terminal: false });
    expect(keychainAsked).toContain(`${T} ${DEFAULT_KEYCHAIN_SERVICE}`);
    expect(getAccount(engine.db, T)).toMatchObject({ dir: paths().claudeHome, terminal: true });
  });

  test('hf1116 T2 a lane spawns on it with CLAUDE_CONFIG_DIR absent and no --add-dir', () => {
    const t = JSON.parse(readFileSync(trace, 'utf8')) as { argv: string[]; envKeys: string[] };
    expect(t.envKeys).not.toContain('CLAUDE_CONFIG_DIR'); // the inherited /stale one is stripped and never set again
    expect(t.argv).not.toContain('--add-dir');
    expect(lane()?.account).toBe(T);
  });

  test('hf1116 T2 `claude auth status` of the terminal account runs without CLAUDE_CONFIG_DIR; the other with its dir', async () => {
    await until(() => authCalls.length >= 2, 'boot auth checks');
    const byDir = authCalls.map((c) => c.env.CLAUDE_CONFIG_DIR ?? null);
    expect(byDir).toContain(null);
    expect(byDir).toContain(getAccount(engine.db, O)!.dir);
    await until(() => engine.accountViews().find((a) => a.email === T)?.login === 'ok', 'T login ok');
  });

  test('hf1116 T3 account_logout refused with the terminal message; nothing signed out', async () => {
    const r = await cmd({ cmd: 'account_logout', email: T });
    expect(r).toMatchObject({ type: 'error', code: 'terminal_login', message: 'Đây là đăng nhập của Claude Code trong terminal. Đăng xuất trong terminal (`/logout`) nếu bạn muốn.' });
    expect(authCalls.some((c) => c.argv.includes('logout'))).toBe(false);
    expect(getAccount(engine.db, T)).toMatchObject({ status: null });
  });

  test('hf1116 B-I2 account_login of the terminal account is refused while its login works; no claude auth login runs', async () => {
    const r = await cmd({ cmd: 'account_login', email: T });
    expect(r).toMatchObject({ type: 'error', code: 'terminal_relogin', message: 'Đăng nhập của terminal vẫn còn hiệu lực. Muốn đổi account thì dùng `/login` trong terminal.' });
    expect(authCalls.some((c) => c.argv.includes('login'))).toBe(false);
    expect(engine.loginView).toBeNull();
  });

  test('hf1116 T3 delete keeps ~/.claude + the Keychain untouched, removes only the row, and the next refresh does not re-add it', async () => {
    await engine.lanes.stop(projectId, 'D2', 'now');
    await until(() => lane()?.state === 'stopped', 'D2 stopped');
    expect(await cmd({ cmd: 'account_delete', email: T })).toMatchObject({ type: 'ack', result: { email: T, dir: null, keychain: null } });
    expect(security).toEqual([]);
    expect(authCalls.some((c) => c.argv.includes('logout'))).toBe(false);
    expect(readFileSync(join(paths().claudeHome, 'settings.json'), 'utf8')).toBe('{"canary":1}');
    expect(existsSync(join(paths().claudeHome, 'projects'))).toBe(true);
    expect(getAccount(engine.db, T)).toBeNull();
    expect(terminalDismissed(engine.db).has(T)).toBe(true);
    engine.refreshAccounts();
    expect(engine.accountViews().map((a) => a.email)).toEqual([O]);
  });

  test('hf1116 B-I3 the terminal signs in as another email → refreshAccounts() → its lanes leave the old email', async () => {
    writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: { emailAddress: N, accountUuid: 'nu' } }));
    engine.refreshAccounts();
    expect(getAccount(engine.db, N)).toMatchObject({ terminal: true });
    const wt = join(tmp, 'wt-d3');
    mkdirSync(wt, { recursive: true });
    await engine.lanes.start({ projectId, name: 'D3', cwd: wt, briefPath: join(tmp, 'brief.md'), account: N });
    await until(() => ['running', 'idle'].includes(engine.lanes.get(projectId, 'D3')?.state ?? ''), 'D3 up on the terminal account');
    writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: { emailAddress: N2, accountUuid: 'n2' } }));
    engine.refreshAccounts();
    await until(() => engine.lanes.get(projectId, 'D3')?.account !== N, 'D3 leaves the old terminal email', 5000);
    expect(getAccount(engine.db, N2)).toMatchObject({ terminal: true });
  });
});
