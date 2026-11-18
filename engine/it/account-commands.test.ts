// v2 §6 A3–A8 / §7 IT: the account_* WS commands against a real engine, fake-claude (sessions + `auth …` in a real pty),
// a fake `security` and a fake Keychain yes/no. Never the real home, Keychain or any API.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AccountLoginView, AccountView, CardView, Command, ServerMsg, Snapshot } from '../../shared/protocol.ts';
import { accountKeychainService } from '../src/accounts/keychain.ts';
import { activeLogin } from '../src/accounts/login.ts';
import { getAccount } from '../src/accounts/registry.ts';
import { openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { route } from '../src/server/router.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';   // orchestrator role, home of the project's orchestrator
const P = 'p@x.test';   // primary, runs lane D2
const Q = 'q@x.test';   // primary, where D2 moves
const TOKEN = 'acct-token';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const logins = new Set<string>([O, P, Q]);
const security: string[][] = [];

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let authEnv: Record<string, string>;
let projectId: string;
const dirs: Record<string, string> = {};

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}

interface Client { msgs: ServerMsg[]; cmd(c: Command): Promise<ServerMsg>; close(): void; events<T>(type: string): T[] }
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
    events: <T,>(type: string) => msgs.filter((m) => m.type === 'event' && m.event.type === type).map((m) => (m as unknown as { event: T }).event),
  };
}
const logins$ = (c: Client) => c.events<{ login: AccountLoginView }>('account_login').map((e) => e.login);
const view = (email: string): AccountView | undefined => engine.accountViews().find((a) => a.email === email);
const card = (email: string): CardView | undefined =>
  engine.snapshot('mac').cards.find((x) => x.kind === 'logged_out' && x.status === 'open' && x.title.startsWith(email.split('@')[0]!));
const lane = () => engine.lanes.get(projectId, 'D2');

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-acct-cmd-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude', 'projects'), { recursive: true });
  writeFileSync(join(tmp, 'claude', 'projects', 'canary.jsonl'), 'keep');
  writeFileSync(paths().caps, JSON.stringify({ default: { week: 99 }, [O]: { role: 'orchestrator', week: 99 }, [P]: { role: 'primary', week: 99 }, [Q]: { role: 'primary', week: 99 } }));
  const db = openDb(paths().stateDb);
  for (const a of seedAccounts([O, P, Q], { db })) dirs[a.email] = a.configDir;
  const now = Math.floor(Date.now() / 1000);
  for (const a of [O, P, Q]) upsertQuota(db, { account: a, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  const claude = join(tmp, 'claude-bin');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(claude, 0o755);
  authEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  const scn = (i: number) => {
    const f = join(tmp, `scn-${i}.json`);
    writeFileSync(f, JSON.stringify({ steps: [{ waitUser: true }, { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } }, { waitUser: true }] }));
    return f;
  };
  let spawn = 0;
  engine = await Engine.start({
    gh: null, // never the real gh (network)
    version: 'test', port: 0, token: TOKEN, staticDir: null, command: ['bun', FAKE],
    loginEnv: { env: authEnv, claudePath: claude, shellFailed: false, reason: null },
    extraEnv: () => ({ FAKE_CLAUDE_SCENARIO: scn(++spawn) }),
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {},
    hasLogin: (a) => logins.has(a.email),
    securityRun: (args) => { security.push(args); return security.length % 2 === 1 ? { code: 0, stderr: '' } : { code: 44, stderr: 'could not be found' }; },
    authCheckTimeoutMs: 30_000, // final-rereview NEW-1: this file tests the protocol, not the auth check; a loaded machine must not time it out
  });
  // hf1116 G2: on a Mac whose Xcode license blocks git, the boot CLT fallback copies the login env (adds DEVELOPER_DIR) —
  // the per-test FAKE_CLAUDE_AUTH_EMAIL must go into the env the engine actually spawns `claude auth` with
  authEnv = engine.login.env;
  // the boot `auth status` check runs in the background (`?` while it runs); the snapshot assertions below expect its result
  await until(() => engine.accountViews().every((v) => v.login !== 'unknown'), 'boot auth check settled');
  const projectDir = join(tmp, 'shop');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  const c = await connect();
  const r = await c.cmd({ cmd: 'project_add', name: 'Shop', path: projectDir, orchestratorAccount: O });
  projectId = (r as { result: { id: string } }).result.id;
  await c.cmd({ cmd: 'project_resume', id: projectId }); // hf1116 H2: an added project waits for "Bắt đầu"
  c.close();
  await until(() => engine.orchestrators.get(projectId)?.view().account === O, 'orchestrator on O');
  const wt = join(tmp, 'wt-d2');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(tmp, 'brief.md'), 'x');
  await engine.lanes.start({ projectId, name: 'D2', cwd: wt, briefPath: join(tmp, 'brief.md'), account: P });
  await until(() => ['running', 'idle'].includes(lane()?.state ?? ''), 'D2 up');
});

afterAll(async () => {
  await activeLogin()?.cancel();
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('v2 §7 protocol: account_* over WS', () => {
  test('§7 snapshot: protocol 2, login null, AccountView carries id + login', async () => {
    const c = await connect();
    const s = (c.msgs[0] as { snapshot: Snapshot }).snapshot;
    expect(s.engine.protocol).toBe(7); // v2.2 C31 bump (v2 D24 → 4); v2.7 → 6; v2.7.1 → 7
    expect(s.login).toBeNull();
    expect(s.accounts.find((a) => a.email === P)).toMatchObject({ id: dirs[P]!.split('/').pop(), login: 'ok' });
    c.close();
  });

  test('§7 N7 the remote channel refuses every account_* command (nothing runs)', async () => {
    const h = buildHandlers(engine, { channel: 'remote', watch: null, present: false, send: () => {} });
    const cmds: Command[] = [
      { cmd: 'account_add' }, { cmd: 'account_login', email: P }, { cmd: 'account_login_cancel' }, { cmd: 'account_paste_code', code: 'a#b' },
      { cmd: 'account_login_resolve', choice: 'keep' }, { cmd: 'account_logout', email: P }, { cmd: 'account_delete', email: Q },
    ];
    for (const command of cmds) expect(await route(h, { channel: 'remote' }, { type: 'command', id: 'r', command })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
    expect(activeLogin()).toBeNull();
    expect(getAccount(engine.db, Q)).not.toBeNull();
    expect(view(P)!.login).toBe('ok');
  });

  test('§6 A8 account_delete refused while a lane runs on it ("Đang chạy D2") and for the orchestrator ("Đang là Điều phối")', async () => {
    const c = await connect();
    expect(await c.cmd({ cmd: 'account_delete', email: P })).toMatchObject({ type: 'error', code: 'lanes_running', message: 'Đang chạy D2' });
    expect(await c.cmd({ cmd: 'account_delete', email: O })).toMatchObject({ type: 'error', code: 'orchestrator', message: 'Đang là Điều phối' });
    expect(existsSync(dirs[P]!)).toBe(true);
    expect(existsSync(dirs[O]!)).toBe(true);
    expect(security).toEqual([]);
    c.close();
  });

  test('§6 A8L account_logout with a running lane → lane switches to another account (F16), row stays ✗, card offers Đăng nhập lại', async () => {
    const c = await connect();
    const r = await c.cmd({ cmd: 'account_logout', email: P });
    expect(r).toMatchObject({ type: 'ack', result: { email: P, login: 'out' } });
    await until(() => lane()?.account === Q, 'D2 moved to q@');
    expect(getAccount(engine.db, P)).toMatchObject({ dir: dirs[P], status: 'logged_out' });
    expect(card(P)).toMatchObject({ actions: [{ id: 'account_relogin', label: 'Đăng nhập lại' }] });
    expect(c.events<{ account: AccountView }>('account').some((e) => e.account.email === P && e.account.login === 'out')).toBe(true);
    c.close();
  });

  test('§6 F16 card action account_relogin → A6 in the same dir → done → card closed, login ok', async () => {
    const c = await connect();
    const id = card(P)!.id;
    expect(await c.cmd({ cmd: 'card_action', id, action: 'account_relogin' })).toMatchObject({ type: 'ack' });
    await until(() => logins$(c).some((l) => l.state === 'waiting_browser'), 'waiting_browser');
    const w = logins$(c).find((l) => l.state === 'waiting_browser')!;
    expect(w).toMatchObject({ mode: 'relogin', email: P, url: expect.stringContaining('oauth') });
    expect(w.deadline).toBeGreaterThan(Date.now() + 9 * 60_000);
    writeFileSync(join(dirs[P]!, '.fake-auth-go'), '');
    await until(() => logins$(c).some((l) => l.state === 'done'), 'done');
    await until(() => view(P)?.login === 'ok', 'p@ ok');
    expect(engine.cards.get(id)!.status).not.toBe('open');
    expect(getAccount(engine.db, P)).toMatchObject({ dir: dirs[P], status: null });
    rmSync(join(dirs[P]!, '.fake-auth-go')); // fake-claude's signal file: the next login in this dir must wait again
    c.close();
  });

  test('§6 A4 account_login + account_paste_code (code#state into the pty) → done; A3 a second login is refused while one runs', async () => {
    const c = await connect();
    expect(await c.cmd({ cmd: 'account_login', email: P })).toMatchObject({ type: 'ack', result: { mode: 'relogin', email: P } });
    expect(await c.cmd({ cmd: 'account_add' })).toMatchObject({ type: 'error', code: 'login_busy', message: `Đang đăng nhập ${P}` });
    await until(() => logins$(c).some((l) => l.state === 'waiting_browser'), 'waiting_browser');
    await Bun.sleep(150);
    expect(await c.cmd({ cmd: 'account_paste_code', code: 'bad' })).toMatchObject({ type: 'error', code: 'bad_input' });
    expect(await c.cmd({ cmd: 'account_paste_code', code: 'abc#st4te' })).toMatchObject({ type: 'ack' });
    await until(() => logins$(c).some((l) => l.state === 'done'), 'done');
    expect(readFileSync(join(dirs[P]!, '.fake-auth-code'), 'utf8')).toBe('abc#st4te');
    c.close();
  });

  test('§6 A7b account_login_cancel on a re-login → cancelled, dir kept; nothing to cancel after', async () => {
    authEnv.FAKE_CLAUDE_AUTH = 'never';
    const c = await connect();
    try {
      await c.cmd({ cmd: 'account_login', email: P });
      await until(() => logins$(c).some((l) => l.state === 'waiting_browser'), 'waiting_browser');
      expect(await c.cmd({ cmd: 'account_login_cancel' })).toMatchObject({ type: 'ack', result: { kind: 'cancelled' } });
      expect(existsSync(join(dirs[P]!, '.claude.json'))).toBe(true);
      expect(getAccount(engine.db, P)!.dir).toBe(dirs[P]!);
      expect(await c.cmd({ cmd: 'account_login_cancel' })).toMatchObject({ type: 'error', code: 'no_login' });
    } finally { delete authEnv.FAKE_CLAUDE_AUTH; c.close(); }
  });

  test('§6 A7f account_add with a typed email ≠ real → email_mismatch event; resolve keep → new usable account', async () => {
    authEnv.FAKE_CLAUDE_AUTH_EMAIL = 'real@x.test';
    const c = await connect();
    try {
      const r = await c.cmd({ cmd: 'account_add', email: 'typed@x.test' });
      expect(r).toMatchObject({ type: 'ack', result: { mode: 'add', email: 'typed@x.test' } });
      await until(() => logins$(c).some((l) => l.state === 'waiting_browser'), 'waiting_browser');
      const dir = join(tmp, 'accts', (r as { result: AccountLoginView }).result.id);
      writeFileSync(join(dir, '.fake-auth-go'), '');
      await until(() => logins$(c).some((l) => l.state === 'email_mismatch'), 'email_mismatch');
      expect(logins$(c).find((l) => l.state === 'email_mismatch')).toMatchObject({ realEmail: 'real@x.test', email: 'typed@x.test' });
      expect(await c.cmd({ cmd: 'account_login_resolve', choice: 'keep' })).toMatchObject({ type: 'ack' });
      await until(() => view('real@x.test') !== undefined, 'real@ usable');
      dirs['real@x.test'] = dir;
      expect(existsSync(join(dir, 'projects'))).toBe(true); // §5.1 layout: a link into ~/.claude/projects
    } finally { delete authEnv.FAKE_CLAUDE_AUTH_EMAIL; c.close(); }
  });

  test('§6 A7f resolve drop → logout + dir removed, no row', async () => {
    authEnv.FAKE_CLAUDE_AUTH_EMAIL = 'other@x.test';
    const c = await connect();
    try {
      const r = await c.cmd({ cmd: 'account_add', email: 'typed2@x.test' });
      await until(() => logins$(c).some((l) => l.state === 'waiting_browser'), 'waiting_browser');
      const dir = join(tmp, 'accts', (r as { result: AccountLoginView }).result.id);
      writeFileSync(join(dir, '.fake-auth-go'), '');
      await until(() => logins$(c).some((l) => l.state === 'email_mismatch'), 'email_mismatch');
      expect(await c.cmd({ cmd: 'account_login_resolve', choice: 'drop' })).toMatchObject({ type: 'ack' });
      await until(() => logins$(c).some((l) => l.state === 'cancelled'), 'cancelled');
      await until(() => !existsSync(dir), 'dir removed');
      expect(getAccount(engine.db, 'other@x.test')).toBeNull();
    } finally { delete authEnv.FAKE_CLAUDE_AUTH_EMAIL; c.close(); }
  });

  test('§6 A8L logout of an account with no session (no F16 card) → still ✗ and never picked (registry status)', async () => {
    logins.add('real@x.test'); // its Keychain item still holds a login (claude auth logout may leave it)
    engine.refreshAccounts();
    expect(view('real@x.test')!.login).toBe('ok');
    const c = await connect();
    expect(await c.cmd({ cmd: 'account_logout', email: 'real@x.test' })).toMatchObject({ type: 'ack', result: { login: 'out' } });
    expect(card('real@x.test')).toBeUndefined();
    expect(engine.loggedOut().has('real@x.test')).toBe(true);
    engine.refreshAccounts(); // the Keychain yes/no is re-read: the fake still says yes, the status keeps it out
    expect(view('real@x.test')!.login).toBe('out');
    c.close();
  });

  test('§7 account_delete: logout → keychain loop with the exact name → dir removed (canary in ~/.claude/projects survives) → row gone + account_removed', async () => {
    const email = 'real@x.test';
    const dir = dirs[email]!;
    const c = await connect();
    const r = await c.cmd({ cmd: 'account_delete', email });
    expect(r).toMatchObject({ type: 'ack', result: { email, dir, keychain: { deleted: 1, result: 'gone' } } });
    expect(security).toEqual([0, 1].map(() => ['delete-generic-password', '-s', accountKeychainService(dir)]));
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(tmp, 'claude', 'projects', 'canary.jsonl'), 'utf8')).toBe('keep');
    expect(getAccount(engine.db, email)).toBeNull();
    expect(view(email)).toBeUndefined();
    await until(() => c.events<{ email: string }>('account_removed').some((e) => e.email === email), 'account_removed');
    c.close();
  });

  test('§6 A8L logout of the orchestrator account → the orchestrator moves off it (v1 §7.5 handover)', async () => {
    const c = await connect();
    expect(await c.cmd({ cmd: 'account_logout', email: O })).toMatchObject({ type: 'ack' });
    await until(() => { const a = engine.orchestrators.get(projectId)?.view().account; return a !== undefined && a !== null && a !== O; }, 'orchestrator moved');
    expect(view(O)!.login).toBe('out');
    c.close();
  });

  test('§7 F16 keychain item missing (deleted outside the app) → AccountView.login out', () => {
    logins.delete(Q);
    engine.refreshAccounts();
    expect(view(Q)!.login).toBe('out');
    logins.add(Q);
    engine.refreshAccounts();
    expect(view(Q)!.login).toBe('ok');
  });
});
