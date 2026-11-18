// hotfix 2026-11-16 (b) IT: Git in onboarding through the real engine. A fake `git` (Xcode license unless DEVELOPER_DIR is
// set, then the real git) and a fake `gh` on the login PATH of a temp dir; GIT_CONFIG_GLOBAL is a temp file — never the
// real ~/.gitconfig, never a real `xcode-select --install` or `gh auth login`.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, ServerMsg, SetupStatus } from '../../shared/protocol.ts';
import { Engine } from '../src/engine.ts';
import { CLT_DIR, CLT_GIT } from '../src/setup/git-setup.ts';

setDefaultTimeout(30_000);
const TOKEN = 'git-setup-token';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const LICENSE = "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window.";
const hasClt = existsSync(CLT_GIT);

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let stopped = false; // the last case stops the engine itself (F1)
const logs: string[] = [];
let gitconfig: string;

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}

/** One WS connection: send commands, keep every message (the `setup` broadcasts too). */
async function client() {
  const port = engine.port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${port}` } } as unknown as string[]);
  const msgs: ServerMsg[] = [];
  ws.onmessage = (m) => msgs.push(JSON.parse(String(m.data)) as ServerMsg);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  await until(() => msgs.some((m) => m.type === 'snapshot'), 'snapshot');
  let n = 0;
  const send = async (command: Command) => {
    const id = `c${++n}`;
    ws.send(JSON.stringify({ type: 'command', id, command }));
    const isReply = (m: ServerMsg) => (m.type === 'ack' || m.type === 'error') && m.id === id;
    await until(() => msgs.some(isReply), `reply to ${command.cmd}`);
    return msgs.find(isReply)!;
  };
  const setups = () => msgs.flatMap((m) => (m.type === 'event' && m.event.type === 'setup' ? [m.event.setup] : []));
  return { send, setups, close: () => ws.close() };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-git-it-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude', 'projects'), { recursive: true });
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  gitconfig = join(tmp, 'gitconfig');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ -z "$DEVELOPER_DIR" ]; then echo ${JSON.stringify(LICENSE)} >&2; exit 69; fi\nexec /usr/bin/git "$@"\n`);
  const flag = join(tmp, 'gh-logged'), approve = join(tmp, 'gh-approve');
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    'case "$1 $2" in',
    // R1: the offline state read (gh 2.92.0 measured: logged in → the user; never logged in → exit 1). `auth status` would
    // call GitHub: the fake fails it loudly so a regression back to it shows as logged_out.
    `  "config get") if [ "$*" = 'config get -h github.com user' ] && [ -f '${flag}' ]; then echo 'octo-cat'; exit 0; fi; echo 'could not find key "user"' >&2; exit 1;;`,
    "  \"auth status\") echo 'network call in the poll' >&2; exit 9;;",
    `  "auth login") echo "$@" > '${tmp}/gh-argv'; echo; echo '! First copy your one-time code: 3E86-1480'; echo 'Open this URL to continue in your web browser: https://github.com/login/device';`,
    `    while [ ! -f '${approve}' ]; do sleep 0.05; done; touch '${flag}'; exit 0;;`,
    '  *) echo "[]"; exit 0;;',
    'esac',
  ].join('\n'));
  chmodSync(join(bin, 'git'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  engine = await Engine.start({
    version: 'test', port: 0, token: TOKEN, staticDir: null, command: ['true'],
    loginEnv: { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, GIT_CONFIG_GLOBAL: gitconfig }, claudePath: null, shellFailed: false, reason: null },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    accountsEveryMs: 0, quotaEveryMs: 0, branchPollMs: 0, statsEveryMs: 0,
    log: (l) => logs.push(l), hasLogin: () => false,
  });
  await until(() => engine.setup !== null, 'boot setup check');
});

afterAll(async () => {
  if (!stopped) await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('hf1116 (b) Git setup through the engine', () => {
  test.if(hasClt)('G2 boot: Xcode license under the login env + the CLT git works → DEVELOPER_DIR set for engine git and sessions, one log line', () => {
    expect(engine.login.env.DEVELOPER_DIR).toBe(CLT_DIR);
    expect(logs.filter((l) => l.includes('DEVELOPER_DIR'))).toEqual([`git: Xcode chặn git → dùng Command Line Tools (DEVELOPER_DIR=${CLT_DIR})`]);
    expect(engine.setup!.git.state).toBe('ok');
    expect(engine.setup!.done).toBe(false); // no claude / account: git never makes it done
  });

  test.if(hasClt)('G1 + G3 identity: unset → set through git_identity_set (temp GIT_CONFIG_GLOBAL) → read back; a bad email is refused', async () => {
    expect(engine.setup!.git.identity).toEqual({ name: null, email: null });
    const c = await client();
    const bad = await c.send({ cmd: 'git_identity_set', name: 'Bill', email: 'nope' });
    expect(bad).toMatchObject({ type: 'error', code: 'bad_input', key: 'errors.gitIdentityEmail' });
    const r = await c.send({ cmd: 'git_identity_set', name: 'Bill Pham', email: 'bill@x-dev.test' });
    expect(r.type).toBe('ack');
    expect((r as { result: SetupStatus }).result.git.identity).toEqual({ name: 'Bill Pham', email: 'bill@x-dev.test' });
    expect(readFileSync(gitconfig, 'utf8')).toContain('name = Bill Pham');
    c.close();
  });

  test('G3 gh login: logged_out → code + device URL in the setup broadcast → approved → gh ok + user; argv', async () => {
    const c = await client();
    await c.send({ cmd: 'setup_check' });
    expect(c.setups().at(-1)!.git.gh).toBe('logged_out');
    const r = await c.send({ cmd: 'gh_login' });
    expect(r.type).toBe('ack');
    await until(() => c.setups().some((s) => s.git.ghLogin?.url), 'code + URL in a setup broadcast');
    expect(c.setups().find((s) => s.git.ghLogin?.url)!.git.ghLogin).toEqual({ state: 'waiting', code: '3E86-1480', url: 'https://github.com/login/device', detail: null });
    expect(readFileSync(join(tmp, 'gh-argv'), 'utf8').trim()).toBe('auth login --web --git-protocol https --hostname github.com');
    writeFileSync(join(tmp, 'gh-approve'), '');
    await until(() => c.setups().at(-1)?.git.gh === 'ok', 'gh ok after approval');
    expect(c.setups().at(-1)!.git).toMatchObject({ gh: 'ok', ghUser: 'octo-cat', ghLogin: null });
    c.close();
  });

  test('G3 gh login cancel: the waiting gh is killed, the row clears', async () => {
    rmSync(join(tmp, 'gh-approve'), { force: true });
    rmSync(join(tmp, 'gh-logged'), { force: true });
    const c = await client();
    await c.send({ cmd: 'gh_login' });
    await until(() => c.setups().some((s) => s.git.ghLogin?.state === 'waiting'), 'waiting');
    const r = await c.send({ cmd: 'gh_login_cancel' });
    expect(r.type).toBe('ack');
    expect(engine.ghLogin).toBeNull();
    expect(c.setups().at(-1)!.git.ghLogin).toBeNull();
    const ps = Bun.spawnSync(['pgrep', '-f', `${tmp}/bin/gh auth login`]);
    expect(ps.stdout.toString().trim()).toBe('');
    c.close();
  });

  // Last case: it stops the shared engine.
  test('F1 engine stop with a gh login waiting: the gh process group is gone after stop()', async () => {
    rmSync(join(tmp, 'gh-approve'), { force: true });
    const c = await client();
    await c.send({ cmd: 'gh_login' });
    await until(() => c.setups().some((s) => s.git.ghLogin?.state === 'waiting'), 'waiting');
    const pgrep = () => Bun.spawnSync(['pgrep', '-f', `${tmp}/bin/gh auth login`]).stdout.toString().trim();
    expect(pgrep()).not.toBe('');
    c.close();
    stopped = true;
    await engine.stop();
    expect(pgrep()).toBe('');
  });
});
