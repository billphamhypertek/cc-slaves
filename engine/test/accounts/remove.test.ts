import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountKeychainService, type SecurityRun } from '../../src/accounts/keychain.ts';
import type { PtyProc } from '../../src/accounts/login.ts';
import { getAccount, terminalDismissed, upsertAccount } from '../../src/accounts/registry.ts';
import { AccountError, deleteAccountSafely, logoutAccount, type RemoveDeps } from '../../src/accounts/remove.ts';
import { getQuota, openDb, upsertQuota, type Db } from '../../src/db.ts';
import { rejects } from '../_fixtures/rejects.ts';

const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
let tmp: string;
let db: Db;
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-remove-'));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json'); // never the real ~/.claude.json
  db = openDb(join(tmp, 'state.db'));
  dir = join(tmp, 'accts', 'aaaaaaaaaaaa');
  mkdirSync(dir, { recursive: true });
  upsertAccount(db, { email: 'a@x.test', id: 'aaaaaaaaaaaa', dir, role: 'primary', week: 90 });
});
afterEach(() => {
  db.close();
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

function setup(over: Partial<RemoveDeps> = {}) {
  const steps: string[] = [];
  const securityCalls: string[][] = [];
  let left = 1;
  const run: SecurityRun = (args) => {
    securityCalls.push(args);
    steps.push(`security ${args[0]}`);
    if (left > 0) { left--; return { code: 0, stderr: '' }; }
    return { code: 44, stderr: 'could not be found' };
  };
  const spawn = (argv: string[], env: Record<string, string>): PtyProc => {
    steps.push(`claude ${argv.slice(1).join(' ')} @${env.CLAUDE_CONFIG_DIR}`);
    return { pid: 1, write() {}, onOutput() {}, exited: Promise.resolve(0) };
  };
  const loggedOut: string[] = [];
  const deps: RemoveDeps = {
    db, auth: { env: { PATH: '/p' }, claudePath: '/x/claude', spawn }, securityRun: run,
    lanesOn: () => [], isOrchestrator: () => false,
    onLoggedOut: (e) => { loggedOut.push(e); steps.push(`switch ${e}`); },
    ...over,
  };
  return { deps, steps, securityCalls, loggedOut };
}

describe('v2 §6 A8L logoutAccount', () => {
  test('§6 A8L logout: claude auth logout in the dir → row stays with status logged_out → sessions switch (F16 path)', async () => {
    const { deps, steps, loggedOut } = setup();
    await logoutAccount('A@x.test', deps);
    expect(steps).toEqual([`claude auth logout @${dir}`, 'switch a@x.test']);
    expect(loggedOut).toEqual(['a@x.test']);
    expect(getAccount(db, 'a@x.test')).toMatchObject({ dir, status: 'logged_out', role: 'primary', week: 90 });
    expect(existsSync(dir)).toBe(true);
  });

  test('§6 A8L a failing `claude auth logout` is ignored (still logged out here)', async () => {
    const spawn = (): PtyProc => ({ pid: 1, write() {}, onOutput() {}, exited: Promise.reject(new Error('spawn ENOENT')) });
    const { deps, loggedOut } = setup();
    await logoutAccount('a@x.test', { ...deps, auth: { ...deps.auth, spawn } });
    expect(loggedOut).toEqual(['a@x.test']);
    expect(getAccount(db, 'a@x.test')!.status).toBe('logged_out');
  });

  test('§6 A8L unknown / dir-less account → no_account', async () => {
    upsertAccount(db, { email: 'v1@x.test', role: 'backup' });
    const { deps } = setup();
    await rejects(logoutAccount('nobody@x.test', deps)).toMatchObject({ code: 'no_account' });
    await rejects(logoutAccount('v1@x.test', deps)).toMatchObject({ code: 'no_account' });
  });
});

describe('v2 §7 "Xoá account an toàn" deleteAccountSafely', () => {
  test('§7 1–4 order: logout → keychain loop (exact name) → safe delete of the dir → row + saved quota removed', async () => {
    const claude = join(tmp, 'claude', 'projects');
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, 'canary.jsonl'), 'keep');
    symlinkSync(claude, join(dir, 'projects'));
    upsertQuota(db, { account: 'a@x.test', fivePct: 1, weekPct: 2, fiveResetsAt: null, weekResetsAt: null, source: 'api', fetchedAt: 1, status: 'ok' });
    const { deps, steps, securityCalls } = setup();
    const r = await deleteAccountSafely('a@x.test', deps);
    expect(steps).toEqual([`claude auth logout @${dir}`, 'security delete-generic-password', 'security delete-generic-password']);
    expect(securityCalls).toEqual([0, 1].map(() => ['delete-generic-password', '-s', accountKeychainService(dir)]));
    expect(r).toEqual({ email: 'a@x.test', dir, keychain: { deleted: 1, result: 'gone' } });
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(claude, 'canary.jsonl'), 'utf8')).toBe('keep'); // link unlinked, never entered
    expect(getAccount(db, 'a@x.test')).toBeNull();
    expect(getQuota(db, 'a@x.test')).toBeNull();
  });

  test('§6 A8 refused while lanes run on it: lanes_running "Đang chạy D2, D15", nothing touched', async () => {
    const { deps, steps } = setup({ lanesOn: (e) => (e === 'a@x.test' ? ['D2', 'D15'] : []) });
    const err = await deleteAccountSafely('a@x.test', deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ code: 'lanes_running', message: 'Đang chạy D2, D15' });
    expect(steps).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(getAccount(db, 'a@x.test')).not.toBeNull();
  });

  test('§6 A8 refused for the orchestrator account: "Đang là Điều phối", nothing touched', async () => {
    const { deps, steps } = setup({ isOrchestrator: (e) => e === 'a@x.test' });
    await rejects(deleteAccountSafely('a@x.test', deps)).toMatchObject({ code: 'orchestrator', message: 'Đang là Điều phối' });
    expect(steps).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test('§7-4 a dir outside the accounts root is refused: row kept, nothing deleted', async () => {
    const outside = join(tmp, 'elsewhere', 'bbbbbbbbbbbb');
    mkdirSync(outside, { recursive: true });
    upsertAccount(db, { email: 'b@x.test', dir: outside });
    const { deps } = setup();
    await rejects(deleteAccountSafely('b@x.test', deps)).toMatchObject({ code: 'delete_refused' });
    expect(existsSync(outside)).toBe(true);
    expect(getAccount(db, 'b@x.test')).not.toBeNull();
  });

  test('§7.1 a dir-less v1 row is just removed (no logout / keychain call)', async () => {
    upsertAccount(db, { email: 'v1@x.test', role: 'backup' });
    const { deps, steps } = setup();
    expect(await deleteAccountSafely('v1@x.test', deps)).toEqual({ email: 'v1@x.test', dir: null, keychain: null });
    expect(steps).toEqual([]);
    expect(getAccount(db, 'v1@x.test')).toBeNull();
  });

  test('§7 unknown account → no_account', async () => {
    const { deps } = setup();
    await rejects(deleteAccountSafely('nobody@x.test', deps)).toMatchObject({ code: 'no_account' });
  });
});

describe('hf1116 T3 the terminal account is never harmed', () => {
  const seedTerminal = () => {
    const home = join(tmp, 'claude');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'settings.json'), '{}');
    upsertAccount(db, { email: 't@x.test', dir: home, terminal: true });
    upsertQuota(db, { account: 't@x.test', fivePct: 1, weekPct: 2, fiveResetsAt: 1, weekResetsAt: 2, source: 'api', fetchedAt: 1, status: 'ok' });
    return home;
  };

  test('hf1116 T3 logout refused with errors.terminalLogout; nothing runs, the row is unchanged', async () => {
    seedTerminal();
    const { deps, steps } = setup();
    await rejects(logoutAccount('t@x.test', deps)).toMatchObject({ code: 'terminal_login', key: 'errors.terminalLogout' });
    expect(steps).toEqual([]);
    expect(getAccount(db, 't@x.test')).toMatchObject({ terminal: true, status: null });
  });

  test('hf1116 T3 delete removes only the row + saved quota: no auth logout, no Keychain call, ~/.claude kept, email dismissed', async () => {
    const home = seedTerminal();
    const { deps, steps, securityCalls } = setup();
    expect(await deleteAccountSafely('t@x.test', deps)).toEqual({ email: 't@x.test', dir: null, keychain: null });
    expect(steps).toEqual([]);
    expect(securityCalls).toEqual([]);
    expect(existsSync(join(home, 'settings.json'))).toBe(true);
    expect(getAccount(db, 't@x.test')).toBeNull();
    expect(getQuota(db, 't@x.test')).toBeNull();
    expect(terminalDismissed(db).has('t@x.test')).toBe(true);
  });

  test('hf1116 B-M1 deleting an own-dir account whose email is the terminal identity dismisses it too (it does not come back)', async () => {
    writeFileSync(join(tmp, 'claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'A@x.test', accountUuid: 'u' } }));
    const { deps } = setup();
    await deleteAccountSafely('a@x.test', deps);
    expect(getAccount(db, 'a@x.test')).toBeNull();
    expect(terminalDismissed(db).has('a@x.test')).toBe(true);
  });

  test('hf1116 B-M1 deleting an own-dir account of another email leaves the dismissed list alone', async () => {
    writeFileSync(join(tmp, 'claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 't@x.test', accountUuid: 'u' } }));
    const { deps } = setup();
    await deleteAccountSafely('a@x.test', deps);
    expect(terminalDismissed(db).size).toBe(0);
  });

  test('hf1116 T3 delete of the terminal account is still refused while lanes run on it', async () => {
    seedTerminal();
    const { deps } = setup({ lanesOn: () => ['D2'] });
    await rejects(deleteAccountSafely('t@x.test', deps)).toMatchObject({ code: 'lanes_running' });
    expect(terminalDismissed(db).size).toBe(0);
  });
});
