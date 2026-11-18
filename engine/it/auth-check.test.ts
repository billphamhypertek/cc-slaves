// v2 §6 A2 "Đang tải" / §3.1-4: the login chip comes from `claude auth status` (exit code only), run for every usable
// account in parallel at boot, at most N s each: 0 → ✓, ≠ 0 → ✗, timeout → ?. Boot never waits for it. fake-claude
// stands in for `claude` (per-account `.fake-auth-status` knob); temp homes, no Keychain, no network.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getAccount } from '../src/accounts/registry.ts';
import { Engine } from '../src/engine.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const OK = 'ok@x.test';
const OUT = 'out@x.test';
const SLOW = 'slow@x.test';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let authLog: string;
const pushed: { email: string; login: string }[] = [];

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await Bun.sleep(20);
  }
}
const login = (email: string) => engine.accountViews().find((v) => v.email === email)?.login;
const statusCalls = () => { try { return readFileSync(authLog, 'utf8').split('\n').filter((l) => l === 'status').length; } catch { return 0; } };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-authchk-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'web'), { recursive: true });
  writeFileSync(join(tmp, 'web', 'index.html'), '<!doctype html>');
  const claude = join(tmp, 'claude-bin');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(claude, 0o755);
  authLog = join(tmp, 'auth.log');
  const accts = seedAccounts([OK, OUT, SLOW]);
  const dir = (e: string) => accts.find((a) => a.email === e)!.configDir;
  writeFileSync(join(dir(OUT), '.fake-auth-status'), JSON.stringify({ code: 1 }));
  writeFileSync(join(dir(SLOW), '.fake-auth-status'), JSON.stringify({ delayMs: 6000 }));
  engine = await Engine.start({
    gh: null, // never the real gh (network)
    version: 'test', port: 0, token: 'tok', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_AUTH_LOG: authLog }, claudePath: claude, shellFailed: false, reason: null },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
    authCheckTimeoutMs: 1500, authCheckEveryMs: 0, authCheckDebounceMs: 50,
  });
  const b = engine.hub.broadcast.bind(engine.hub);
  engine.hub.broadcast = (m) => {
    if (m.type === 'account') pushed.push({ email: m.account.email, login: m.account.login });
    b(m);
  };
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

test('§6 A2 boot does not wait for `auth status`: the slow account shows ? (checking) right after start', () => {
  // No wall-clock bound: Bun's recursive fs.watch start blocks up to ~1 s under load (boot runs several); an awaited
  // check would have written last_auth_check (timeout 1.5 s) — mutation `await e.checkAuth()` turns this red.
  expect(login(SLOW)).toBe('unknown');
  expect(getAccount(engine.db, SLOW)!.lastAuthCheck).toBeNull();
});

test('§3.1-4 exit 0 → ok, exit 1 → out (pushed), last_auth_check written', async () => {
  await until(() => login(OK) === 'ok' && login(OUT) === 'out', 'ok + out');
  expect(getAccount(engine.db, OK)!.lastAuthCheck).toBeGreaterThan(0);
  expect(getAccount(engine.db, OUT)!.lastAuthCheck).toBeGreaterThan(0);
  await until(() => pushed.some((p) => p.email === OUT && p.login === 'out'), 'out pushed');
});

test('§6 A2 timeout → unknown (?), last_auth_check written; no re-run per refreshAccounts burst', async () => {
  await until(() => getAccount(engine.db, SLOW)!.lastAuthCheck !== null, 'slow check finished (timeout)', 5000);
  expect(login(SLOW)).toBe('unknown');
  expect(statusCalls()).toBe(3);
  for (let i = 0; i < 5; i++) engine.refreshAccounts();
  await Bun.sleep(300);
  expect(statusCalls()).toBe(3); // known results, authCheckEveryMs 0 → nothing re-run
});

test('final-rereview NEW-1: a successful relogin clears a cached ✗ at once (no wait for authCheckEveryMs)', async () => {
  await until(() => login(OUT) === 'out', 'out');
  const dir = getAccount(engine.db, OUT)!.dir!;
  rmSync(join(dir, '.fake-auth-status')); // the token is good again; with authCheckEveryMs 0 nothing re-runs by itself
  engine.startAccountLogin({ accountEmail: OUT });
  writeFileSync(join(dir, '.fake-auth-go'), '');
  await until(() => login(OUT) === 'ok', 'out → ok after relogin', 5000);
  rmSync(join(dir, '.fake-auth-go'));
});
