// v2 §6 "Engine khởi động lại" / §8 IT over a real engine: stop() cancels the running login (both process groups), and
// the boot sweep keeps a logged-in orphan dir behind an "Account mồ côi" card whose actions re-add or safely delete it.
// fake-claude in a real pty, a fake `security`; temp dirs only (never the real home, Keychain or any API).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CardView } from '../../shared/protocol.ts';
import { accountKeychainService } from '../src/accounts/keychain.ts';
import { activeLogin } from '../src/accounts/login.ts';
import { getAccount } from '../src/accounts/registry.ts';
import { openDb } from '../src/db.ts';
import { Engine, type EngineOptions } from '../src/engine.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { route } from '../src/server/router.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;
let claude: string;
let engine: Engine | null = null;
const security: string[][] = [];

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(20); }
}
async function groupsAlive(pgids: number[]): Promise<string[]> {
  const out = await new Response(Bun.spawn(['ps', '-A', '-o', 'pid=,pgid=,stat=,command='], { stdout: 'pipe' }).stdout).text();
  return out.split('\n').filter((l) => {
    const [, pgid, stat] = l.trim().split(/\s+/);
    return pgids.includes(Number(pgid)) && !stat?.startsWith('Z');
  });
}
const opts = (env: Record<string, string>): EngineOptions => ({
  gh: null, // never the real gh (network)
  version: 'test', port: 0, token: 't', staticDir: null, command: ['bun', FAKE],
  loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, claudePath: claude, shellFailed: false, reason: null },
  quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
  caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
  exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
  fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
  notify: { osascript: () => {}, postGchat: async () => {} },
  session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
  log: () => {}, hasLogin: () => true,
  securityRun: (args) => { security.push(args); return { code: 44, stderr: 'could not be found' }; },
});

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-login-rec-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude', 'projects'), { recursive: true });
  claude = join(tmp, 'claude-bin');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(claude, 0o755);
});
afterAll(async () => {
  await activeLogin()?.cancel();
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('IMPORTANT-1 §6 SA1 Engine.stop() cancels the running login', () => {
  test('IMPORTANT-1 §6 SA1 login waiting for the browser → engine stop → no process of either group, login slot free', async () => {
    const pids = join(tmp, 'pids.json');
    const e = await Engine.start(opts({ FAKE_CLAUDE_AUTH: 'fork', FAKE_CLAUDE_AUTH_PIDS: pids }));
    e.startAccountLogin({});
    await until(() => activeLogin()?.state().kind === 'waiting_browser' && existsSync(pids), 'waiting_browser');
    const { pid: fake, children } = JSON.parse(readFileSync(pids, 'utf8')) as { pid: number; children: number[] };
    const script = Number((await new Response(Bun.spawn(['ps', '-o', 'ppid=', '-p', String(fake)], { stdout: 'pipe' }).stdout).text()).trim());
    expect((await groupsAlive([fake, script])).length).toBeGreaterThan(0);
    await e.stop();
    expect(activeLogin()).toBeNull();
    let alive: string[] = [];
    for (let i = 0; i < 40; i++) { alive = await groupsAlive([fake, script]); if (!alive.length) break; await Bun.sleep(50); }
    expect(alive).toEqual([]);
    for (const c of children) expect(() => process.kill(c, 0)).toThrow();
  });
});

describe('§6 A7 "Thử lại" right after a failed login', () => {
  test('§6 A7c fail → the `failed` broadcast comes after the old groups are dead; an immediate startLogin is accepted', async () => {
    const pids = join(tmp, 'pids-fail.json');
    const e = await Engine.start(opts({ FAKE_CLAUDE_AUTH: 'fail_fork', FAKE_CLAUDE_AUTH_PIDS: pids }));
    try {
      e.startAccountLogin({});
      await until(() => existsSync(pids), 'pids file');
      const { pid: fake, children } = JSON.parse(readFileSync(pids, 'utf8')) as { pid: number; children: number[] };
      await until(() => e.loginView?.state === 'failed', 'failed', 15_000);
      // the very first observation of `failed`: old groups must already be gone and the slot free
      const alive = await groupsAlive([fake]);
      let retry = 'ok';
      try { e.startAccountLogin({}); } catch (err) { retry = (err as { code?: string }).code ?? String(err); }
      expect({ alive, retry }).toEqual({ alive: [], retry: 'ok' });
      for (const c of children) expect(() => process.kill(c, 0)).toThrow();
      await until(() => e.loginView?.state === 'failed' && activeLogin() === null, 'second failed', 15_000);
    } finally {
      await activeLogin()?.cancel();
      await e.stop();
    }
  });
});

describe('IMPORTANT-2 §6 §7 boot: a logged-in orphan dir is kept behind an "Account mồ côi" card', () => {
  const orphan = (id: string, email: string) => {
    const dir = join(tmp, 'accts', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `u-${email}`, planDisplayName: 'Max 20x' } }));
    writeFileSync(join(dir, 'keep'), 'x');
    const old = Date.now() / 1000 - 3600;
    utimesSync(dir, old, old);
    return dir;
  };
  const orphanCards = (): CardView[] => engine!.snapshot('mac').cards.filter((c) => c.kind === 'account_orphan' && c.status === 'open');
  const act = (id: number, action: string) =>
    route(buildHandlers(engine!, { channel: 'mac', watch: null, present: true, send: () => {} }), { channel: 'mac' }, { type: 'command', id: 'a', command: { cmd: 'card_action', id, action } });
  let keepDir: string;
  let dropDir: string;

  test('IMPORTANT-2 §6 fresh state.db + two logged-in orphans → both dirs kept, one card each "Account mồ côi <email> — thêm lại / xoá"', async () => {
    keepDir = orphan('abcdef000001', 'pm@x.test');
    dropDir = orphan('abcdef000002', 'qa@x.test');
    engine = await Engine.start(opts({}));
    expect(existsSync(join(keepDir, 'keep')) && existsSync(join(dropDir, 'keep'))).toBe(true);
    expect(orphanCards().map((c) => c.title).sort()).toEqual(['Account mồ côi pm@x.test — thêm lại / xoá', 'Account mồ côi qa@x.test — thêm lại / xoá']);
    expect(orphanCards()[0]!.actions?.map((a) => a.label)).toEqual(['Thêm lại', 'Xoá']);
    expect(security).toEqual([]);
  });

  test('IMPORTANT-2 §6 card "Thêm lại" → the row comes back with that dir + identity; the card closes', async () => {
    const c = orphanCards().find((x) => x.title.includes('pm@'))!;
    expect(await act(c.id, 'account_orphan_adopt')).toMatchObject({ type: 'ack' });
    const db = openDb(join(tmp, 'home', 'state.db'));
    expect(getAccount(db, 'pm@x.test')).toMatchObject({ dir: keepDir, id: 'abcdef000001', accountUuid: 'u-pm@x.test', plan: 'Max 20x' });
    db.close();
    expect(engine!.accountViews().map((a) => a.email)).toContain('pm@x.test');
    expect(orphanCards().map((x) => x.title)).toEqual(['Account mồ côi qa@x.test — thêm lại / xoá']);
  });

  test('IMPORTANT-2 §7 card "Xoá" → logout → keychain item (exact name) → dir removed; ~/.claude untouched', async () => {
    writeFileSync(join(tmp, 'claude', 'projects', 'canary.jsonl'), 'keep');
    const c = orphanCards()[0]!;
    expect(await act(c.id, 'account_orphan_delete')).toMatchObject({ type: 'ack' });
    expect(existsSync(dropDir)).toBe(false);
    expect(security[0]).toEqual(['delete-generic-password', '-s', accountKeychainService(dropDir)]);
    expect(readFileSync(join(tmp, 'claude', 'projects', 'canary.jsonl'), 'utf8')).toBe('keep');
    expect(orphanCards()).toEqual([]);
  });
});
