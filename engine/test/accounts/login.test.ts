import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeLogin, authDir, authEnv, authStatus, killGroups, startLogin, sweepAbandonedLogins, type LoginDeps, type PtyProc, type Timers,
} from '../../src/accounts/login.ts';
import { dismissTerminal, getAccount, terminalDismissed, upsertAccount } from '../../src/accounts/registry.ts';
import { openDb, type Db } from '../../src/db.ts';

const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
let tmp: string;
let db: Db;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-login-'));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  db = openDb(join(tmp, 'state.db'));
});
afterEach(async () => {
  await activeLogin()?.cancel();
  db.close();
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

/** Immediate timers: grace waits resolve at once; the 10-min timeout is captured, fired by the test. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  const t: Timers & { fire(ms: number): void } = {
    setTimeout(fn, ms) { const id = ++n; if (ms <= 3000 && ms !== 200) queueMicrotask(fn); else pending.set(id, { fn, ms }); return id; },
    clearTimeout(h) { pending.delete(h as number); },
    fire(ms) { for (const [id, p] of pending) if (p.ms === ms) { pending.delete(id); p.fn(); } },
  };
  return t;
}

function fakeProc(pid: number) {
  let exit!: (c: number) => void;
  const out: ((s: string) => void)[] = [];
  const written: string[] = [];
  const p: PtyProc & { exit(c: number): void; say(s: string): void; written: string[] } = {
    pid, write: (s) => { written.push(s); }, onOutput: (cb) => { out.push(cb); },
    exited: new Promise((r) => { exit = r; }), exit: (c) => exit(c), say: (s) => { for (const cb of out) cb(s); }, written,
  };
  return p;
}

function setup(over: Partial<LoginDeps> = {}) {
  const kills: [number, string][] = [];
  const spawned: { argv: string[]; env: Record<string, string> }[] = [];
  const procs: ReturnType<typeof fakeProc>[] = [];
  const timers = fakeTimers();
  let ids = 0;
  const deps: LoginDeps = {
    db, env: { PATH: '/p', ANTHROPIC_API_KEY: 'k', HTTPS_PROXY: 'http://px' }, claudePath: '/x/claude',
    spawn: (argv, env) => {
      spawned.push({ argv, env });
      const p = fakeProc(100 + procs.length * 10);
      procs.push(p);
      if (argv[2] === 'logout' || argv[2] === 'status') queueMicrotask(() => p.exit(0));
      return p;
    },
    kill: ((pid, sig) => { kills.push([pid, sig]); }),
    pgrep: async (ppid) => [ppid + 1],
    timers, newId: () => `abcdef00000${++ids}`, ...over,
  };
  return { deps, kills, spawned, procs, timers };
}

const writeIdentity = (dir: string, email: string) =>
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: 'u1', organizationUuid: 'o1', organizationRateLimitTier: 't', planDisplayName: 'Max' } }));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('until: timeout'); await Bun.sleep(2); }
}

describe('v2 §7 login.ts', () => {
  test('§7 argv in a pty-less fake: auth login --claudeai --email; env stripped + CLAUDE_CONFIG_DIR + BROWSER', () => {
    const { deps, spawned } = setup();
    const r = startLogin(deps, { email: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    expect(spawned[0]!.argv).toEqual(['/x/claude', 'auth', 'login', '--claudeai', '--email', 'a@x.test']);
    const env = spawned[0]!.env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://px');
    expect(env.CLAUDE_CONFIG_DIR).toBe(r.login.dir);
    expect(readFileSync(env.BROWSER!, 'utf8')).toContain('printf');
    expect(readFileSync(join(r.login.dir, 'CLAUDE.md'), 'utf8')).toBe(`@${join(tmp, 'claude', 'CLAUDE.md')}\n`);
  });

  test('§7 A3 a second login while one runs is refused (single-flight)', async () => {
    const { deps } = setup();
    const a = startLogin(deps, { email: 'a@x.test' });
    expect(a.ok).toBe(true);
    expect(startLogin(deps)).toEqual({ ok: false, reason: 'busy', email: 'a@x.test' });
    if (a.ok) await a.login.cancel();
    expect(startLogin(deps).ok).toBe(true);
  });

  test('§3.2 SA1 cancel: SIGTERM to the script group and the child group, then SIGKILL both; dir safe-deleted', async () => {
    const { deps, kills } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    expect(existsSync(r.login.dir)).toBe(true);
    expect(await r.login.cancel()).toEqual({ kind: 'cancelled' });
    expect(kills).toEqual([[-100, 'SIGTERM'], [-101, 'SIGTERM'], [-100, 'SIGKILL'], [-101, 'SIGKILL']]);
    expect(existsSync(r.login.dir)).toBe(false);
    expect(existsSync(join(tmp, 'home', 'login', r.login.id))).toBe(false);
    expect(activeLogin()).toBeNull();
  });

  test('§6 A7a timeout after 10 min → timed_out, groups killed, dir removed', async () => {
    const { deps, kills, timers } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    timers.fire(10 * 60_000);
    expect(await r.login.done).toEqual({ kind: 'timed_out' });
    expect(kills.length).toBe(4);
    expect(existsSync(r.login.dir)).toBe(false);
  });

  test('§7 URL from pty output → waiting_browser; submitCode writes code#state + CR to the pty', async () => {
    const { deps, procs } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    expect(r.login.submitCode('abc#def')).toBe(false);
    procs[0]!.say('\x1b[1mvisit: https://claude.ai/oauth/authorize?x=1\x1b[0m\r\n');
    expect(r.login.state()).toEqual({ kind: 'waiting_browser', url: 'https://claude.ai/oauth/authorize?x=1' });
    expect(r.login.submitCode('no-hash')).toBe(false);
    expect(r.login.submitCode(' abc#def ')).toBe(true);
    expect(procs[0]!.written).toEqual(['abc#def\r']);
  });

  test('smoke 2026-11-15: a pty chunk that ends mid-URL (and mid-escape) is not taken; the whole URL is', async () => {
    const { deps, procs } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    const full = 'https://claude.com/cai/oauth/authorize?code=true&code_challenge=IJR&code_challenge_method=S256&state=wt5';
    procs[0]!.say(`visit: ${full.slice(0, 60)}`);
    expect(r.login.state().kind).toBe('starting');
    procs[0]!.say(`${full.slice(60)}\x1b[`);
    procs[0]!.say('0m\r\n');
    expect(r.login.state()).toEqual({ kind: 'waiting_browser', url: full });
  });

  test('review M-1: a cursor escape after the URL ends it (no glued word); a long burst after the URL does not hide it', async () => {
    const { deps, procs } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    const u = 'https://claude.com/cai/oauth/authorize?code=true&state=wt5';
    procs[0]!.say(`${u}\x1b[1BPaste code here > `);
    expect(r.login.state()).toEqual({ kind: 'waiting_browser', url: u });
    await r.login.cancel();
  });

  test('review M-1: URL then a 20 000-char burst in one chunk → still seen', async () => {
    const { deps, procs } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    const u = 'https://claude.com/cai/oauth/authorize?code=true&state=wt6';
    procs[0]!.say(`${u}\r\n${'x'.repeat(20_000)}`);
    expect(r.login.state()).toEqual({ kind: 'waiting_browser', url: u });
    await r.login.cancel();
  });

  test('smoke 2026-11-15: BROWSER link (localhost) is the one to open; the pty link stays as codeUrl for "Dán mã"', async () => {
    const { deps, procs, timers } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    const manual = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1';
    const auto = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5852%2Fcallback&state=s2';
    procs[0]!.say(`If the browser didn't open, visit: ${manual}\r\n`);
    expect(r.login.state()).toEqual({ kind: 'waiting_browser', url: manual });
    writeFileSync(join(process.env.CC_SLAVES_HOME!, 'login', r.login.id, 'url'), `${auto}\n`);
    timers.fire(200);
    await until(() => (r.login.state() as { url?: string }).url === auto);
    expect(r.login.state()).toEqual({ kind: 'waiting_browser', url: auto, codeUrl: manual });
    procs[0]!.say('\r\n'); // pty noise re-matching the same link changes nothing
    expect(r.login.state()).toEqual({ kind: 'waiting_browser', url: auto, codeUrl: manual });
    await r.login.cancel();
  });

  test('§6 A7 "Thử lại": the terminal state is broadcast only after the old groups are killed and the slot is free', async () => {
    const { deps, procs, kills } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    const seen: { kind: string; kills: number; free: boolean; again: boolean }[] = [];
    r.login.onState((s) => {
      if (s.kind !== 'failed') return;
      const again = startLogin(deps); // an immediate retry from the listener (the UI's "Thử lại")
      seen.push({ kind: s.kind, kills: kills.filter(([, sig]) => sig === 'SIGKILL').length, free: again.ok, again: again.ok });
      if (again.ok) void again.login.cancel();
    });
    procs[0]!.exit(1);
    await r.login.done;
    expect(seen).toEqual([{ kind: 'failed', kills: 2, free: true, again: true }]);
  });

  test('§6 A7c exit ≠ 0 → failed(exit, last line), dir removed', async () => {
    const { deps, procs } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    procs[0]!.say('Error: connect ECONNREFUSED\n');
    procs[0]!.exit(1);
    expect(await r.login.done).toEqual({ kind: 'failed', reason: 'exit', detail: 'Error: connect ECONNREFUSED' });
    expect(existsSync(r.login.dir)).toBe(false);
  });

  test('§7 success → registry row with dir, id, uuids; v1 dir-less row keeps role/caps (A5)', async () => {
    upsertAccount(db, { email: 'a@x.test', role: 'orchestrator', week: 80, hard: true, lanesMax: 3 });
    const { deps, procs } = setup();
    const r = startLogin(deps, { email: 'A@x.test' });
    if (!r.ok) throw new Error('refused');
    writeIdentity(r.login.dir, 'a@x.test');
    procs[0]!.exit(0);
    expect(await r.login.done).toEqual({ kind: 'done', email: 'a@x.test', accountUuid: 'u1', orgUuid: 'o1' });
    const row = getAccount(db, 'a@x.test')!;
    expect(row).toMatchObject({ dir: r.login.dir, id: r.login.id, accountUuid: 'u1', orgUuid: 'o1', role: 'orchestrator', week: 80, hard: true, lanesMax: 3, tier: 't', plan: 'Max' });
    expect(existsSync(r.login.dir)).toBe(true);
  });

  test('§6 A7f add: typed email ≠ real → email_mismatch(real), dir held, no row, not terminal', async () => {
    const { deps, procs, spawned } = setup();
    const r = startLogin(deps, { email: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    writeIdentity(r.login.dir, 'b@x.test');
    procs[0]!.exit(0);
    await until(() => r.login.state().kind === 'email_mismatch');
    expect(r.login.state()).toEqual({ kind: 'email_mismatch', email: 'b@x.test', asked: 'a@x.test' });
    expect(spawned.length).toBe(1); // no logout yet
    expect(existsSync(r.login.dir)).toBe(true);
    expect(getAccount(db, 'b@x.test')).toBeNull();
    expect(activeLogin()).toBe(r.login); // A3 slot still held
  });

  test('§6 A7f keep → row under the real email with this dir; done', async () => {
    const { deps, procs } = setup();
    const r = startLogin(deps, { email: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    writeIdentity(r.login.dir, 'b@x.test');
    procs[0]!.exit(0);
    await until(() => r.login.state().kind === 'email_mismatch');
    expect(r.login.resolveMismatch('keep')).toBe(true);
    expect(await r.login.done).toEqual({ kind: 'done', email: 'b@x.test', accountUuid: 'u1', orgUuid: 'o1' });
    expect(getAccount(db, 'b@x.test')).toMatchObject({ dir: r.login.dir, id: r.login.id });
    expect(getAccount(db, 'a@x.test')).toBeNull();
    expect(existsSync(r.login.dir)).toBe(true);
  });

  test('§6 A7f keep when the real email already has a dir → failed(duplicate), logged out, dir removed', async () => {
    upsertAccount(db, { email: 'b@x.test', dir: '/old/dir' });
    const { deps, procs, spawned } = setup();
    const r = startLogin(deps, { email: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    writeIdentity(r.login.dir, 'b@x.test');
    procs[0]!.exit(0);
    await until(() => r.login.state().kind === 'email_mismatch');
    r.login.resolveMismatch('keep');
    expect(await r.login.done).toEqual({ kind: 'failed', reason: 'duplicate', detail: 'b@x.test' });
    expect(spawned[1]!.argv).toEqual(['/x/claude', 'auth', 'logout']);
    expect(existsSync(r.login.dir)).toBe(false);
    expect(getAccount(db, 'b@x.test')!.dir).toBe('/old/dir');
  });

  test('§6 A7f drop → logout in that dir, dir safe-deleted, cancelled, no row; resolve outside a mismatch → false', async () => {
    const { deps, procs, spawned } = setup();
    const r = startLogin(deps, { email: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    expect(r.login.resolveMismatch('drop')).toBe(false);
    writeIdentity(r.login.dir, 'b@x.test');
    procs[0]!.exit(0);
    await until(() => r.login.state().kind === 'email_mismatch');
    expect(r.login.resolveMismatch('drop')).toBe(true);
    expect(await r.login.done).toEqual({ kind: 'cancelled' });
    expect(spawned[1]!.argv).toEqual(['/x/claude', 'auth', 'logout']);
    expect(spawned[1]!.env.CLAUDE_CONFIG_DIR).toBe(r.login.dir);
    expect(existsSync(r.login.dir)).toBe(false);
    expect(getAccount(db, 'b@x.test')).toBeNull();
    expect(activeLogin()).toBeNull();
  });

  test('§6 A7f no answer for 10 min → timed_out, logged out, dir removed', async () => {
    const { deps, procs, spawned, timers } = setup();
    const r = startLogin(deps, { email: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    writeIdentity(r.login.dir, 'b@x.test');
    procs[0]!.exit(0);
    await until(() => r.login.state().kind === 'email_mismatch');
    timers.fire(10 * 60_000);
    expect(await r.login.done).toEqual({ kind: 'timed_out' });
    expect(spawned.some((s) => s.argv[2] === 'logout')).toBe(true);
    expect(existsSync(r.login.dir)).toBe(false);
  });

  test('§6 A7f cancel while the mismatch waits = drop (logout + dir removed)', async () => {
    const { deps, procs, spawned } = setup();
    const r = startLogin(deps, { email: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    writeIdentity(r.login.dir, 'b@x.test');
    procs[0]!.exit(0);
    await until(() => r.login.state().kind === 'email_mismatch');
    expect(await r.login.cancel()).toEqual({ kind: 'cancelled' });
    expect(spawned.some((s) => s.argv[2] === 'logout')).toBe(true);
    expect(existsSync(r.login.dir)).toBe(false);
  });

  test('§6 A7e email already a row with dir → failed(duplicate), dir removed, existing row untouched', async () => {
    upsertAccount(db, { email: 'a@x.test', dir: '/old/dir', role: 'backup' });
    const { deps, procs } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    writeIdentity(r.login.dir, 'a@x.test');
    procs[0]!.exit(0);
    expect(await r.login.done).toEqual({ kind: 'failed', reason: 'duplicate', detail: 'a@x.test' });
    expect(existsSync(r.login.dir)).toBe(false);
    expect(getAccount(db, 'a@x.test')!.dir).toBe('/old/dir');
  });

  test('§7 exit 0 without oauthAccount → failed(no_identity)', async () => {
    const { deps, procs } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    procs[0]!.exit(0);
    expect((await r.login.done).kind).toBe('failed');
  });

  test('§7 killGroups dedups known + pgrep children and kills groups (negative pids)', async () => {
    const kills: [number, string][] = [];
    const g = await killGroups(50, [51], { kill: (p, s) => { kills.push([p, s]); }, pgrep: async () => [51, 52], timers: fakeTimers(), graceMs: 3000 });
    expect(g).toEqual([50, 51, 52]);
    expect(kills.filter(([, s]) => s === 'SIGTERM').map(([p]) => p)).toEqual([-50, -51, -52]);
    expect(kills.filter(([, s]) => s === 'SIGKILL').map(([p]) => p)).toEqual([-50, -51, -52]);
  });

  test('§3.1-4 authStatus uses the exit code only; env is the shared stripped env', async () => {
    const { deps, spawned } = setup();
    expect(await authStatus('/a/abcdef000001', deps)).toEqual({ loggedIn: true, code: 0 });
    expect(spawned[0]!.argv).toEqual(['/x/claude', 'auth', 'status']);
    expect(authEnv({ ANTHROPIC_BASE_URL: 'u', CLAUDE_CONFIG_DIR: '/old', P: '1' }, '/d')).toEqual({ P: '1', CLAUDE_CONFIG_DIR: '/d' });
  });

  test('hf1116 T2 authStatus of the terminal account (dir null) runs with CLAUDE_CONFIG_DIR unset (an inherited one stripped)', async () => {
    const { deps, spawned } = setup({ env: { PATH: '/p', CLAUDE_CONFIG_DIR: '/stale' } });
    expect(await authStatus(authDir({ configDir: join(tmp, 'claude'), terminal: true }), deps)).toEqual({ loggedIn: true, code: 0 });
    expect('CLAUDE_CONFIG_DIR' in spawned[0]!.env).toBe(false);
    expect(authDir({ configDir: '/a/b', terminal: false })).toBe('/a/b');
  });

  test('hf1116 T3 add: a login that yields the terminal account email → failed(duplicate), new dir cleaned, terminal row untouched', async () => {
    upsertAccount(db, { email: 't@x.test', dir: join(tmp, 'claude'), terminal: true });
    const { deps, procs, spawned } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    writeIdentity(r.login.dir, 't@x.test');
    procs[0]!.exit(0);
    expect(await r.login.done).toEqual({ kind: 'failed', reason: 'duplicate', detail: 't@x.test' });
    expect(existsSync(r.login.dir)).toBe(false);
    expect(spawned[1]!.env.CLAUDE_CONFIG_DIR).toBe(r.login.dir); // the logout hits the new dir only, never the terminal
    expect(getAccount(db, 't@x.test')).toMatchObject({ dir: join(tmp, 'claude'), terminal: true });
  });

  test('hf1116 T3 add: a cc-slaves login of a dismissed terminal email clears the dismissal', async () => {
    dismissTerminal(db, 't@x.test');
    const { deps, procs } = setup();
    const r = startLogin(deps);
    if (!r.ok) throw new Error('refused');
    writeIdentity(r.login.dir, 't@x.test');
    procs[0]!.exit(0);
    expect((await r.login.done).kind).toBe('done');
    expect(terminalDismissed(db).size).toBe(0);
    expect(getAccount(db, 't@x.test')).toMatchObject({ dir: r.login.dir, terminal: false });
  });
});

describe('§8 boot sweep (restart mid-login)', () => {
  test('§8 dirs with no registry row and older than 10 min are safe-deleted; rows, fresh and non-id dirs stay', async () => {
    const root = join(tmp, 'accts');
    const old = Date.now() / 1000 - 3600;
    const mk = (n: string, age = old) => { const p = join(root, n); mkdirSync(p, { recursive: true }); utimesSync(p, age, age); return p; };
    const orphan = mk('aaaaaaaaaaaa');
    const fresh = mk('bbbbbbbbbbbb', Date.now() / 1000);
    const owned = mk('cccccccccccc');
    const byId = mk('dddddddddddd');
    const other = mk('not-an-id');
    mkdirSync(join(tmp, 'home', 'login', 'x'), { recursive: true });
    upsertAccount(db, { email: 'a@x.test', dir: owned });
    upsertAccount(db, { email: 'b@x.test', dir: '/elsewhere/dddddddddddd/' });
    expect(await sweepAbandonedLogins({ db })).toEqual({ killed: [], removed: [orphan], orphans: [] });
    for (const p of [fresh, owned, byId, other]) expect(existsSync(p)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(tmp, 'home', 'login'))).toBe(false);
  });
});

describe('v2 §6 A6 re-login (login.ts startLogin({accountEmail}))', () => {
  const seedRow = (email = 'a@x.test') => {
    const dir = join(tmp, 'accts', 'aaaaaaaaaaaa');
    mkdirSync(dir, { recursive: true });
    upsertAccount(db, { email, id: 'aaaaaaaaaaaa', dir, role: 'backup', week: 70, status: 'logged_out' });
    return dir;
  };

  test('§6 A6 reuses the row dir (no new id / dir), --email prefilled with the row email', () => {
    const dir = seedRow();
    let ids = 0;
    const { deps, spawned } = setup({ newId: () => { ids++; return 'bbbbbbbbbbbb'; } });
    const r = startLogin(deps, { accountEmail: 'A@x.test' });
    if (!r.ok) throw new Error('refused');
    expect(r.login.dir).toBe(dir);
    expect(r.login.id).toBe('aaaaaaaaaaaa');
    expect(r.login.mode).toBe('relogin');
    expect(ids).toBe(0);
    expect(existsSync(join(tmp, 'accts', 'bbbbbbbbbbbb'))).toBe(false);
    expect(spawned[0]!.argv).toEqual(['/x/claude', 'auth', 'login', '--claudeai', '--email', 'a@x.test']);
    expect(spawned[0]!.env.CLAUDE_CONFIG_DIR).toBe(dir);
  });

  test('§6 A6 unknown email or a row without dir → refused no_account', () => {
    upsertAccount(db, { email: 'v1@x.test', role: 'primary' });
    const { deps } = setup();
    expect(startLogin(deps, { accountEmail: 'v1@x.test' })).toEqual({ ok: false, reason: 'no_account', email: 'v1@x.test' });
    expect(startLogin(deps, { accountEmail: 'nobody@x.test' })).toEqual({ ok: false, reason: 'no_account', email: 'nobody@x.test' });
  });

  test('§6 A7b cancel on re-login → cancelled, dir and row kept', async () => {
    const dir = seedRow();
    writeFileSync(join(dir, 'keep'), 'x');
    const { deps } = setup();
    const r = startLogin(deps, { accountEmail: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    expect(await r.login.cancel()).toEqual({ kind: 'cancelled' });
    expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('x');
    expect(getAccount(db, 'a@x.test')).toMatchObject({ dir, status: 'logged_out' });
  });

  test('§6 A7a timeout on re-login → timed_out, dir kept ("account vẫn ✗")', async () => {
    const dir = seedRow();
    const { deps, timers } = setup();
    const r = startLogin(deps, { accountEmail: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    timers.fire(10 * 60_000);
    expect(await r.login.done).toEqual({ kind: 'timed_out' });
    expect(existsSync(dir)).toBe(true);
  });

  test('§6 A7c exit ≠ 0 on re-login → failed(exit), dir kept', async () => {
    const dir = seedRow();
    const { deps, procs } = setup();
    const r = startLogin(deps, { accountEmail: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    procs[0]!.exit(1);
    expect((await r.login.done).kind).toBe('failed');
    expect(existsSync(dir)).toBe(true);
  });

  test('§6 A7d wrong email on re-login → logout in the row dir, failed(wrong_email, real), dir + row kept', async () => {
    const dir = seedRow();
    const { deps, procs, spawned } = setup();
    const r = startLogin(deps, { accountEmail: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    writeIdentity(dir, 'b@x.test');
    procs[0]!.exit(0);
    expect(await r.login.done).toEqual({ kind: 'failed', reason: 'wrong_email', detail: 'b@x.test' });
    expect(spawned[1]!.argv).toEqual(['/x/claude', 'auth', 'logout']);
    expect(spawned[1]!.env.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(getAccount(db, 'a@x.test')).toMatchObject({ dir, status: 'logged_out' });
    expect(getAccount(db, 'b@x.test')).toBeNull();
  });

  test('hf1116 T3 re-login of the terminal account: CLAUDE_CONFIG_DIR unset, identity read from ~/.claude.json, ~/.claude kept', async () => {
    const home = join(tmp, 'claude');
    mkdirSync(home, { recursive: true });
    upsertAccount(db, { email: 't@x.test', dir: home, terminal: true, role: 'orchestrator' });
    const { deps, procs, spawned } = setup({ env: { PATH: '/p', CLAUDE_CONFIG_DIR: '/stale' } });
    const r = startLogin(deps, { accountEmail: 't@x.test' });
    if (!r.ok) throw new Error('refused');
    expect(r.login.mode).toBe('relogin');
    expect('CLAUDE_CONFIG_DIR' in spawned[0]!.env).toBe(false);
    writeFileSync(join(tmp, 'claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 't@x.test', accountUuid: 'tu' } }));
    procs[0]!.exit(0);
    expect(await r.login.done).toMatchObject({ kind: 'done', email: 't@x.test', accountUuid: 'tu' });
    expect(getAccount(db, 't@x.test')).toMatchObject({ dir: home, terminal: true, role: 'orchestrator', accountUuid: 'tu' });
    expect(existsSync(home)).toBe(true);
  });

  test('hf1116 T3 re-login of the terminal account into another email → failed(wrong_email) and NO logout (never signs the terminal out)', async () => {
    const home = join(tmp, 'claude');
    mkdirSync(home, { recursive: true });
    upsertAccount(db, { email: 't@x.test', dir: home, terminal: true });
    const { deps, procs, spawned } = setup();
    const r = startLogin(deps, { accountEmail: 't@x.test' });
    if (!r.ok) throw new Error('refused');
    writeFileSync(join(tmp, 'claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'b@x.test' } }));
    procs[0]!.exit(0);
    expect(await r.login.done).toEqual({ kind: 'failed', reason: 'wrong_email', detail: 'b@x.test' });
    expect(spawned.map((s) => s.argv[2])).toEqual(['login']);
    expect(existsSync(home)).toBe(true);
  });

  test('§6 A6 success → identity refreshed, status cleared, dir / role / caps unchanged', async () => {
    const dir = seedRow();
    const { deps, procs } = setup();
    const r = startLogin(deps, { accountEmail: 'a@x.test' });
    if (!r.ok) throw new Error('refused');
    writeIdentity(dir, 'a@x.test');
    procs[0]!.exit(0);
    expect(await r.login.done).toEqual({ kind: 'done', email: 'a@x.test', accountUuid: 'u1', orgUuid: 'o1' });
    expect(getAccount(db, 'a@x.test')).toMatchObject({ dir, id: 'aaaaaaaaaaaa', status: null, role: 'backup', week: 70, accountUuid: 'u1', plan: 'Max' });
  });
});
