// v2 §8 IT: `claude auth login` lifecycle through a real pty (`script -q /dev/null`) against fake-claude (§3.2 SA1).
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyLayout, planLayout } from '../src/accounts/layout.ts';
import { activeLogin, authStatus, logout, startLogin, sweepAbandonedLogins, type LoginDeps, type LoginHandle, type Timers } from '../src/accounts/login.ts';
import { accountKeychainService } from '../src/accounts/keychain.ts';
import { AccountError, deleteAccountSafely, logoutAccount, type RemoveDeps } from '../src/accounts/remove.ts';
import { deleteAccount, getAccount, upsertAccount } from '../src/accounts/registry.ts';
import { openDb, type Db } from '../src/db.ts';

setDefaultTimeout(20_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
let tmp: string;
let db: Db;
let claude: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-it-acct-'));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json'); // never the real ~/.claude.json
  db = openDb(join(tmp, 'state.db'));
  claude = join(tmp, 'claude-bin');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(claude, 0o755);
});
afterEach(async () => {
  await activeLogin()?.cancel();
  db.close();
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

const deps = (env: Record<string, string> = {}, over: Partial<LoginDeps> = {}): LoginDeps => ({
  db, claudePath: claude, pollMs: 50, killGraceMs: 300,
  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'http://evil', HTTPS_PROXY: 'http://px', ...env },
  ...over,
});

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('until: timeout'); await Bun.sleep(25); }
}
const start = (d: LoginDeps, email?: string): LoginHandle => {
  const r = startLogin(d, email ? { email } : {});
  if (!r.ok) throw new Error('refused');
  return r.login;
};
const waitBrowser = async (l: LoginHandle) => { await until(() => l.state().kind === 'waiting_browser'); return l.state() as { url: string }; };
const go = (l: LoginHandle) => writeFileSync(join(l.dir, '.fake-auth-go'), '');

async function groupsAlive(pgids: number[]): Promise<string[]> {
  const out = await new Response(Bun.spawn(['ps', '-A', '-o', 'pid=,pgid=,stat=,command='], { stdout: 'pipe' }).stdout).text();
  return out.split('\n').filter((l) => {
    const [, pgid, stat] = l.trim().split(/\s+/);
    return pgids.includes(Number(pgid)) && !stat?.startsWith('Z');
  });
}

describe('v2 §8 IT login with fake-claude', () => {
  test('§8 success: BROWSER captures the link, env stripped, row written with dir + uuids', async () => {
    const trace = join(tmp, 'trace.json');
    const l = start(deps({ FAKE_CLAUDE_TRACE: trace }), 'pm@x.test');
    const s = await waitBrowser(l);
    expect(s.url).toStartWith('https://claude.ai/oauth/authorize');
    const t = JSON.parse(readFileSync(trace, 'utf8')) as { argv: string[]; envKeys: string[] };
    expect(t.argv).toEqual(['auth', 'login', '--claudeai', '--email', 'pm@x.test']);
    expect(t.envKeys.filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
    expect(t.envKeys).toContain('HTTPS_PROXY');
    go(l);
    expect(await l.done).toEqual({ kind: 'done', email: 'pm@x.test', accountUuid: 'acct-pm@x.test', orgUuid: 'org-pm@x.test' });
    expect(getAccount(db, 'pm@x.test')).toMatchObject({ dir: l.dir, id: l.id, plan: 'Max 20x' });
    expect(existsSync(join(tmp, 'home', 'login', l.id))).toBe(false);
    expect(await authStatus(l.dir, deps())).toEqual({ loggedIn: true, code: 0 });
    expect((await logout(l.dir, deps())).code).toBe(0);
    expect(await authStatus(l.dir, deps())).toEqual({ loggedIn: false, code: 1 });
  });

  test('§3.2 SA1 paste path: code#state typed into the pty reaches the child', async () => {
    const l = start(deps());
    await waitBrowser(l);
    await Bun.sleep(150);
    expect(l.submitCode('abc123#st4te')).toBe(true);
    expect((await l.done).kind).toBe('done');
    expect(readFileSync(join(l.dir, '.fake-auth-code'), 'utf8')).toBe('abc123#st4te');
  });

  test('§6 A7a timeout (fake clock) → timed_out, dir removed, processes gone', async () => {
    let fire: (() => void) | null = null;
    const timers: Timers = {
      setTimeout: (fn, ms) => (ms === 600_000 ? ((fire = fn), -1) : setTimeout(fn, ms)),
      clearTimeout: (h) => { if (h !== -1) clearTimeout(h as ReturnType<typeof setTimeout>); },
    };
    const pids = join(tmp, 'pids.json');
    const l = start(deps({ FAKE_CLAUDE_AUTH: 'never', FAKE_CLAUDE_AUTH_PIDS: pids }, { timers }));
    await waitBrowser(l);
    const fake = (JSON.parse(readFileSync(pids, 'utf8')) as { pid: number }).pid;
    fire!();
    expect(await l.done).toEqual({ kind: 'timed_out' });
    expect(existsSync(l.dir)).toBe(false);
    await until(() => { try { process.kill(fake, 0); return false; } catch { return true; } }, 3000);
  });

  test('§3.2 SA1 cancel: fake-claude forks a TERM+HUP-ignoring grandchild → ps has no process of either group', async () => {
    const pids = join(tmp, 'pids.json');
    const l = start(deps({ FAKE_CLAUDE_AUTH: 'fork', FAKE_CLAUDE_AUTH_PIDS: pids }));
    await waitBrowser(l);
    await until(() => existsSync(pids));
    const { pid: fake, children } = JSON.parse(readFileSync(pids, 'utf8')) as { pid: number; children: number[] };
    const ps = async (fmt: string, pid: number) => Number((await new Response(Bun.spawn(['ps', '-o', `${fmt}=`, '-p', String(pid)], { stdout: 'pipe' }).stdout).text()).trim());
    expect(await ps('pgid', fake)).toBe(fake); // BSD script: the child leads its own group
    const script = await ps('ppid', fake);
    expect(await ps('pgid', script)).toBe(script); // detached: script leads the other group
    const before = (await groupsAlive([fake, script])).join('\n');
    for (const pid of [script, fake, ...children]) expect(before).toContain(String(pid));
    expect(await l.cancel()).toEqual({ kind: 'cancelled' });
    await until(() => false === existsSync(l.dir), 1000);
    let alive: string[] = [];
    for (let i = 0; i < 40; i++) { alive = await groupsAlive([fake, script]); if (!alive.length) break; await Bun.sleep(50); }
    expect(alive).toEqual([]);
    for (const c of children) expect(() => process.kill(c, 0)).toThrow();
  });

  test('§6 A7c exit error → failed(exit) with the last line, dir removed', async () => {
    const l = start(deps({ FAKE_CLAUDE_AUTH: 'fail' }));
    const t = await l.done;
    expect(t).toMatchObject({ kind: 'failed', reason: 'exit' });
    expect((t as { detail: string }).detail).toContain('ECONNREFUSED');
    expect(existsSync(l.dir)).toBe(false);
  });

  test('§6 A7f add with a typed email ≠ real → email_mismatch; keep → row under the real email', async () => {
    const log = join(tmp, 'auth.log');
    const l = start(deps({ FAKE_CLAUDE_AUTH: 'wrong_email', FAKE_CLAUDE_AUTH_LOG: log }), 'pm@x.test');
    await waitBrowser(l);
    go(l);
    await until(() => l.state().kind === 'email_mismatch');
    expect(l.state()).toEqual({ kind: 'email_mismatch', email: 'other-pm@x.test', asked: 'pm@x.test' });
    expect(existsSync(l.dir)).toBe(true);
    expect(l.resolveMismatch('keep')).toBe(true);
    expect((await l.done).kind).toBe('done');
    expect(getAccount(db, 'other-pm@x.test')).toMatchObject({ dir: l.dir });
    expect(readFileSync(log, 'utf8')).toBe('login\n');
  });

  test('§6 A7f drop → logout ran in that dir, dir removed, no row', async () => {
    const log = join(tmp, 'auth.log');
    const l = start(deps({ FAKE_CLAUDE_AUTH: 'wrong_email', FAKE_CLAUDE_AUTH_LOG: log }), 'pm@x.test');
    await waitBrowser(l);
    go(l);
    await until(() => l.state().kind === 'email_mismatch');
    l.resolveMismatch('drop');
    expect(await l.done).toEqual({ kind: 'cancelled' });
    expect(readFileSync(log, 'utf8')).toBe('login\nlogout\n');
    expect(existsSync(l.dir)).toBe(false);
    expect(getAccount(db, 'other-pm@x.test')).toBeNull();
  });

  test('§6 A7e duplicate email → failed(duplicate), new dir removed, old row untouched', async () => {
    upsertAccount(db, { email: 'pm@x.test', dir: '/accts/000000000001' });
    const l = start(deps({ FAKE_CLAUDE_AUTH_EMAIL: 'pm@x.test' }));
    await waitBrowser(l);
    go(l);
    expect(await l.done).toEqual({ kind: 'failed', reason: 'duplicate', detail: 'pm@x.test' });
    expect(existsSync(l.dir)).toBe(false);
    expect(getAccount(db, 'pm@x.test')!.dir).toBe('/accts/000000000001');
  });

  test('§7 A3 a second concurrent login is refused', async () => {
    const l = start(deps({ FAKE_CLAUDE_AUTH: 'never' }), 'pm@x.test');
    expect(startLogin(deps())).toEqual({ ok: false, reason: 'busy', email: 'pm@x.test' });
    await l.cancel();
  });

  test('§8 restart mid-login: orphan dir (no row, >10 min) swept; shared targets in ~/.claude untouched', async () => {
    const claudeHome = join(tmp, 'claude');
    const dir = join(tmp, 'accts', 'abcabcabcabc');
    mkdirSync(join(tmp, 'accts'), { recursive: true });
    applyLayout(planLayout(claudeHome, dir));
    writeFileSync(join(claudeHome, 'projects', 'keep.jsonl'), 'x');
    writeFileSync(join(dir, '.claude.json'), '{}');
    const old = Date.now() / 1000 - 3600;
    utimesSync(dir, old, old);
    expect((await sweepAbandonedLogins({ db })).removed).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(claudeHome, 'projects', 'keep.jsonl'), 'utf8')).toBe('x');
  });

  test('§6 A5 imported v1 row (no dir) keeps role/caps after login', async () => {
    upsertAccount(db, { email: 'pm@x.test', role: 'orchestrator', week: 70, five: 90, hard: false, lanesMax: 2 });
    const l = start(deps({ FAKE_CLAUDE_AUTH_EMAIL: 'pm@x.test' }));
    await waitBrowser(l);
    go(l);
    expect((await l.done).kind).toBe('done');
    expect(getAccount(db, 'pm@x.test')).toMatchObject({ dir: l.dir, role: 'orchestrator', week: 70, five: 90, hard: false, lanesMax: 2 });
  });
});

describe('v2 §6 A6 IT re-login with fake-claude (the row dir is reused, never removed)', () => {
  const seeded = () => {
    const dir = join(tmp, 'accts', 'aaaaaaaaaaaa');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep'), 'x');
    upsertAccount(db, { email: 'pm@x.test', id: 'aaaaaaaaaaaa', dir, role: 'backup', status: 'logged_out' });
    return dir;
  };
  const relogin = (d: LoginDeps) => {
    const r = startLogin(d, { accountEmail: 'pm@x.test' });
    if (!r.ok) throw new Error('refused');
    return r.login;
  };

  test('§6 A6 success: --email = the row email, same dir, identity written, status cleared', async () => {
    const dir = seeded();
    const trace = join(tmp, 'trace.json');
    const l = relogin(deps({ FAKE_CLAUDE_TRACE: trace }));
    expect(l.dir).toBe(dir);
    await waitBrowser(l);
    expect((JSON.parse(readFileSync(trace, 'utf8')) as { argv: string[] }).argv).toEqual(['auth', 'login', '--claudeai', '--email', 'pm@x.test']);
    go(l);
    expect((await l.done).kind).toBe('done');
    expect(getAccount(db, 'pm@x.test')).toMatchObject({ dir, status: null, role: 'backup', accountUuid: 'acct-pm@x.test' });
    expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('x');
  });

  test('§6 A7d wrong email: logout ran in the row dir, failed(wrong_email), dir + row kept', async () => {
    const dir = seeded();
    const log = join(tmp, 'auth.log');
    const l = relogin(deps({ FAKE_CLAUDE_AUTH: 'wrong_email', FAKE_CLAUDE_AUTH_LOG: log }));
    await waitBrowser(l);
    go(l);
    expect(await l.done).toEqual({ kind: 'failed', reason: 'wrong_email', detail: 'other-pm@x.test' });
    expect(readFileSync(log, 'utf8')).toBe('login\nlogout\n');
    expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('x');
    expect(await authStatus(dir, deps())).toEqual({ loggedIn: false, code: 1 }); // the other account's login is gone
    expect(getAccount(db, 'pm@x.test')).toMatchObject({ dir, status: 'logged_out' });
  });

  test('§6 A7b cancel: processes killed, dir kept', async () => {
    const dir = seeded();
    const l = relogin(deps({ FAKE_CLAUDE_AUTH: 'never' }));
    await waitBrowser(l);
    expect(await l.cancel()).toEqual({ kind: 'cancelled' });
    expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('x');
    expect(getAccount(db, 'pm@x.test')!.dir).toBe(dir);
  });
});

const REPO = resolve(import.meta.dir, '../..');
const sec = () => {
  const calls: string[][] = [];
  return { calls, run: (a: string[]) => { calls.push(a); return { code: 44, stderr: 'The specified item could not be found in the keychain.' }; } };
};

describe('IMPORTANT-1 §6 §3.2 SA1 a login left by a crashed engine is killed at the next boot', () => {
  test('IMPORTANT-1 §6 SA1 startLogin records the script pid in ~/.cc-slaves/login/<id>/pid', async () => {
    const l = start(deps({ FAKE_CLAUDE_AUTH: 'never' }));
    const file = join(tmp, 'home', 'login', l.id, 'pid');
    expect(existsSync(file)).toBe(true); // written with the spawn, before the first child poll (a crash right after spawn)
    await waitBrowser(l);
    const script = Number(readFileSync(file, 'utf8').split('\n')[0]);
    const cmd = (await new Response(Bun.spawn(['ps', '-o', 'command=', '-p', String(script)], { stdout: 'pipe' }).stdout).text()).trim();
    expect(cmd).toStartWith('script -q /dev/null');
  });

  test('IMPORTANT-1 §6 "Engine khởi động lại": crash (pid file left, both groups alive) → the sweep kills both groups, then removes login/', async () => {
    const pids = join(tmp, 'pids.json');
    const runner = join(tmp, 'crash.ts');
    writeFileSync(runner, [
      `const { startLogin } = await import(${JSON.stringify(join(REPO, 'engine/src/accounts/login.ts'))});`,
      `const { openDb } = await import(${JSON.stringify(join(REPO, 'engine/src/db.ts'))});`,
      `const r = startLogin({ db: openDb(${JSON.stringify(join(tmp, 'crash.db'))}), claudePath: ${JSON.stringify(claude)}, pollMs: 50,`,
      `  env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_CLAUDE_AUTH: 'fork', FAKE_CLAUDE_AUTH_PIDS: ${JSON.stringify(pids)} } });`,
      'while (r.login.state().kind !== "waiting_browser") await Bun.sleep(20);',
      `while (!(await Bun.file(${JSON.stringify(pids)}).exists())) await Bun.sleep(20);`,
      'await Bun.sleep(300);',
      'process.exit(0);',
    ].join('\n'));
    const child = Bun.spawn([process.execPath, runner], { env: { ...process.env }, stdout: 'ignore', stderr: 'inherit' });
    expect(await child.exited).toBe(0);
    const { pid: fake, children } = JSON.parse(readFileSync(pids, 'utf8')) as { pid: number; children: number[] };
    const ps = async (fmt: string, pid: number) => Number((await new Response(Bun.spawn(['ps', '-o', `${fmt}=`, '-p', String(pid)], { stdout: 'pipe' }).stdout).text()).trim());
    const script = await ps('ppid', fake);
    expect((await groupsAlive([fake, script])).length).toBeGreaterThan(0); // the crash left them running
    const r = await sweepAbandonedLogins({ db, killGraceMs: 300 });
    expect(r.killed).toContain(script);
    let alive: string[] = [];
    for (let i = 0; i < 40; i++) { alive = await groupsAlive([fake, script]); if (!alive.length) break; await Bun.sleep(50); }
    expect(alive).toEqual([]);
    for (const c of children) expect(() => process.kill(c, 0)).toThrow();
    expect(existsSync(join(tmp, 'home', 'login'))).toBe(false);
  });

  test('IMPORTANT-1 §6 pid reuse: a recorded pid that is no longer script / claude auth is never killed', async () => {
    const other = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', detached: true });
    try {
      mkdirSync(join(tmp, 'home', 'login', 'abcabcabcabc'), { recursive: true });
      writeFileSync(join(tmp, 'home', 'login', 'abcabcabcabc', 'pid'), `${other.pid}\n`);
      const r = await sweepAbandonedLogins({ db, killGraceMs: 50 });
      expect(r.killed).toEqual([]);
      expect(() => process.kill(other.pid, 0)).not.toThrow();
      expect(existsSync(join(tmp, 'home', 'login'))).toBe(false);
    } finally { other.kill('SIGKILL'); }
  });
});

describe('IMPORTANT-2 §6 §7 the boot sweep never deletes a logged-in orphan; the rest go the safe-delete way', () => {
  const orphan = (id: string, identity: boolean) => {
    const claudeHome = join(tmp, 'claude');
    const dir = join(tmp, 'accts', id);
    mkdirSync(join(tmp, 'accts'), { recursive: true });
    applyLayout(planLayout(claudeHome, dir));
    writeFileSync(join(claudeHome, 'projects', 'keep.jsonl'), 'x');
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(identity ? { oauthAccount: { emailAddress: 'pm@x.test', accountUuid: 'u' } } : {}));
    const old = Date.now() / 1000 - 3600;
    utimesSync(dir, old, old);
    return dir;
  };

  test('IMPORTANT-2 §6 fresh state.db: a dir with oauthAccount is kept, logged, reported as an orphan; nothing logged out or deleted', async () => {
    const dir = orphan('abcdef012345', true);
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(join(dir, 'sessions', 'live.json'), '{}');
    utimesSync(dir, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
    const fresh = openDb(join(tmp, 'fresh-state.db'));
    const s = sec();
    const authLog = join(tmp, 'auth.log');
    const lines: string[] = [];
    const r = await sweepAbandonedLogins({ db: fresh, auth: deps({ FAKE_CLAUDE_AUTH_LOG: authLog }), securityRun: s.run, log: (l) => lines.push(l) });
    fresh.close();
    expect(r.removed).toEqual([]);
    expect(r.orphans).toEqual([{ dir, email: 'pm@x.test' }]);
    expect(existsSync(join(dir, 'sessions', 'live.json'))).toBe(true);
    expect(existsSync(authLog)).toBe(false);
    expect(s.calls).toEqual([]);
    expect(lines.join('\n')).toContain('pm@x.test');
  });

  test('IMPORTANT-2 §7 an identity-less orphan: claude auth logout in that dir → keychain item (exact name) → safe delete', async () => {
    const dir = orphan('abcdef000000', false);
    const s = sec();
    const authLog = join(tmp, 'auth.log');
    const r = await sweepAbandonedLogins({ db, auth: deps({ FAKE_CLAUDE_AUTH_LOG: authLog }), securityRun: s.run });
    expect(r.removed).toEqual([dir]);
    expect(readFileSync(authLog, 'utf8')).toBe('logout\n');
    expect(s.calls[0]).toEqual(['delete-generic-password', '-s', accountKeychainService(dir)]);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(tmp, 'claude', 'projects', 'keep.jsonl'), 'utf8')).toBe('x');
  });
});

describe('IMPORTANT-3 §6 A6 A8 A8L delete / logout refused while that account re-logs in; a finished re-login never revives a row', () => {
  const seeded = () => {
    const dir = join(tmp, 'accts', 'abcdef012345');
    mkdirSync(dir, { recursive: true });
    upsertAccount(db, { email: 'pm@x.test', id: 'abcdef012345', dir, status: 'logged_out' });
    return dir;
  };
  const rdeps = (s = sec()): RemoveDeps => ({
    db, auth: deps(), securityRun: s.run, lanesOn: () => [], isOrchestrator: () => false, onLoggedOut: () => {},
  });
  const relogin = async () => {
    const r = startLogin(deps({}), { accountEmail: 'pm@x.test' });
    if (!r.ok) throw new Error('refused');
    await waitBrowser(r.login);
    return r.login;
  };

  test('IMPORTANT-3 §6 A8 account_delete during that account\'s re-login → login_running; row, dir and keychain untouched', async () => {
    const dir = seeded();
    await relogin();
    const s = sec();
    const err = await deleteAccountSafely('pm@x.test', rdeps(s)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect((err as AccountError).code).toBe('login_running');
    expect(getAccount(db, 'pm@x.test')?.dir).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(s.calls).toEqual([]);
  });

  test('IMPORTANT-3 §6 A8L account_logout during that account\'s re-login → login_running; status unchanged', async () => {
    seeded();
    upsertAccount(db, { email: 'pm@x.test', status: null });
    await relogin();
    const err = await logoutAccount('pm@x.test', rdeps()).catch((e: unknown) => e);
    expect((err as AccountError).code).toBe('login_running');
    expect(getAccount(db, 'pm@x.test')?.status).toBeNull();
  });

  test('IMPORTANT-3 §6 A6 the row is gone when the re-login finishes → failed(no_account), no phantom row, that dir signed out', async () => {
    const dir = seeded();
    const l = await relogin();
    deleteAccount(db, 'pm@x.test');
    go(l);
    expect(await l.done).toMatchObject({ kind: 'failed', reason: 'no_account' });
    expect(getAccount(db, 'pm@x.test')).toBeNull();
    expect(await authStatus(dir, deps())).toEqual({ loggedIn: false, code: 1 });
  });

  test('IMPORTANT-3 §6 A6 the row now points at another dir → failed(no_account), the row keeps its new dir', async () => {
    seeded();
    const l = await relogin();
    const moved = join(tmp, 'accts', 'abcdef999999');
    upsertAccount(db, { email: 'pm@x.test', id: 'abcdef999999', dir: moved });
    go(l);
    expect(await l.done).toMatchObject({ kind: 'failed', reason: 'no_account' });
    expect(getAccount(db, 'pm@x.test')).toMatchObject({ dir: moved, id: 'abcdef999999' });
  });
});
