// hotfix 2026-11-16 (b) Git in onboarding (brief hf1116-git G1–G3): `git --version` classification, the Command Line
// Tools fallback rule, the identity check + argv, the offline gh state (`gh config get -h github.com user`). Fake exec only: nothing real runs here.
import { describe, expect, test } from 'bun:test';
import { identityIssue } from '../../../shared/git-identity.ts';
import { KeyedError } from '../../src/errors.ts';
import { classifyGit, CLT_DIR, CLT_GIT, cltFallback, gitCheck, gitInstall, setIdentity, type GitDeps } from '../../src/setup/git-setup.ts';
import type { Exec, ExecResult } from '../../src/setup/setup.ts';

const LICENSE = "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.";
const NO_TOOLS = 'xcode-select: note: No developer tools were found, requesting install. If developer tools are located at a non-default location on disk, use `sudo xcode-select --switch path/to/Xcode.app` to specify the Xcode that you wish to use for command line developer tools, and cancel the installation dialog.';
const BAD_PATH = 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun';

const res = (code: number, stdout = '', stderr = ''): ExecResult => ({ code, stdout, stderr });

type Row = ExecResult | ((env: Record<string, string> | undefined) => ExecResult) | 'throw';
function fake(table: Record<string, Row>) {
  const calls: { argv: string[]; env?: Record<string, string> }[] = [];
  const exec: Exec = async (argv, o) => {
    calls.push({ argv, ...(o?.env ? { env: o.env } : {}) });
    const k = Object.keys(table).find((x) => argv.join(' ') === x) ?? Object.keys(table).find((x) => argv.join(' ').startsWith(x));
    const r = k ? table[k]! : res(1, '', 'unexpected');
    if (r === 'throw') throw new Error('ENOENT');
    return typeof r === 'function' ? r(o?.env) : r;
  };
  return { exec, calls };
}
const deps = (exec: Exec, over: Partial<GitDeps> = {}): GitDeps => ({
  exec, env: { PATH: '/usr/bin' }, which: (n) => (n === 'git' ? '/usr/bin/git' : null), exists: () => true, ...over,
});

describe('hf1116 G1 classifyGit: `git --version` → ok / missing / license / error', () => {
  test('exit 0 → ok + version', () => {
    expect(classifyGit(res(0, 'git version 2.54.0 (Apple Git-157)\n'))).toEqual({ state: 'ok', version: '2.54.0', detail: null });
  });
  test('the Xcode license message (exit 69) → license', () => {
    expect(classifyGit(res(69, '', LICENSE)).state).toBe('license');
  });
  test('no developer tools / invalid active developer path / spawn failure → missing', () => {
    expect(classifyGit(res(1, '', NO_TOOLS)).state).toBe('missing');
    expect(classifyGit(res(1, '', BAD_PATH)).state).toBe('missing');
    expect(classifyGit(null).state).toBe('missing');
  });
  test('anything else → error with git\'s last line', () => {
    expect(classifyGit(res(128, '', 'warning: x\nfatal: something broke\n'))).toEqual({ state: 'error', version: null, detail: 'fatal: something broke' });
  });
});

describe('hf1116 G1 gitCheck: identity + gh, never throws', () => {
  const okGit = {
    '/usr/bin/git --version': res(0, 'git version 2.54.0 (Apple Git-157)\n'),
    '/usr/bin/git config --global user.name': res(0, 'Bill Pham\n'),
    '/usr/bin/git config --global user.email': res(0, 'bill@x-dev.test\n'),
  };
  test('R1 all set: identity read, gh ok + user from the offline `gh config get -h github.com user`', async () => {
    const { exec, calls } = fake({ ...okGit, '/gh config get -h github.com user': res(0, 'billpham\n') });
    const g = await gitCheck({ ...deps(exec, { env: { PATH: '/usr/bin', DEVELOPER_DIR: CLT_DIR } }), ghPath: '/gh', ghLogin: null });
    expect(g).toEqual({ state: 'ok', version: '2.54.0', detail: null, identity: { name: 'Bill Pham', email: 'bill@x-dev.test' }, gh: 'ok', ghUser: 'billpham', ghLogin: null });
    expect(calls.map((c) => c.argv[0])).not.toContain('/usr/bin/xcode-select'); // DEVELOPER_DIR set → no shim precheck
    expect(calls.filter((c) => c.argv[0] === '/gh').map((c) => c.argv.join(' '))).toEqual(['/gh config get -h github.com user']); // no network call
  });
  test('R1 gh config: exit 0 but an empty user → logged_out, no user', async () => {
    const { exec } = fake({ ...okGit, '/gh config get': res(0, '  \n') });
    const g = await gitCheck({ ...deps(exec, { env: { PATH: '/usr/bin', DEVELOPER_DIR: CLT_DIR } }), ghPath: '/gh', ghLogin: null });
    expect(g).toMatchObject({ gh: 'logged_out', ghUser: null });
  });
  test('identity unset (git config exit 1) → nulls; R1 gh config exit 1 (no key "user") → logged_out; no gh → missing', async () => {
    const { exec } = fake({ '/usr/bin/xcode-select -p': res(0, CLT_DIR), '/usr/bin/git --version': res(0, 'git version 2.54.0'), '/usr/bin/git config': res(1), '/gh config get -h github.com user': res(1, '', 'could not find key "user"') });
    const g = await gitCheck({ ...deps(exec), ghPath: '/gh', ghLogin: null });
    expect(g.identity).toEqual({ name: null, email: null });
    expect(g).toMatchObject({ gh: 'logged_out', ghUser: null });
    expect((await gitCheck({ ...deps(exec), ghPath: null, ghLogin: null })).gh).toBe('missing');
  });
  test('the /usr/bin/git shim with no active developer dir → missing without running git (no Apple dialog per poll)', async () => {
    const { exec, calls } = fake({ '/usr/bin/xcode-select -p': res(2, '', 'xcode-select: error: unable to get active developer directory') });
    const g = await gitCheck({ ...deps(exec), ghPath: null, ghLogin: null });
    expect(g.state).toBe('missing');
    expect(calls.map((c) => c.argv.join(' '))).toEqual(['/usr/bin/xcode-select -p']);
  });
  test('no git on the login PATH → missing; a throwing exec never throws out', async () => {
    expect((await gitCheck({ ...deps(fake({}).exec, { which: () => null }), ghPath: null, ghLogin: null })).state).toBe('missing');
    const { exec } = fake({ '/usr/bin/xcode-select': 'throw', '/usr/bin/git': 'throw', '/gh': 'throw' });
    const g = await gitCheck({ ...deps(exec), ghPath: '/gh', ghLogin: null });
    expect(g.state).toBe('missing');
    expect(g.gh).toBe('logged_out');
  });
  test('license → identity not read; the running gh login view is passed through', async () => {
    const { exec, calls } = fake({ '/usr/bin/xcode-select -p': res(0, '/Applications/Xcode.app/Contents/Developer'), '/usr/bin/git --version': res(69, '', LICENSE), '/gh config get': res(1) });
    const view = { state: 'waiting' as const, code: 'AB12-CD34', url: 'https://github.com/login/device', detail: null };
    const g = await gitCheck({ ...deps(exec), ghPath: '/gh', ghLogin: view });
    expect(g.state).toBe('license');
    expect(g.ghLogin).toEqual(view);
    expect(calls.some((c) => c.argv[0] === '/usr/bin/git' && c.argv.includes('config'))).toBe(false);
  });
});

describe('hf1116 G2 cltFallback: DEVELOPER_DIR only when unset and the Command Line Tools git works', () => {
  const cltOk = (env: Record<string, string> | undefined) => (env?.DEVELOPER_DIR === CLT_DIR ? res(0, 'git version 2.50.1') : res(69, '', LICENSE));
  test('license under the login env + CLT git runs with DEVELOPER_DIR → CLT_DIR', async () => {
    const { exec, calls } = fake({ '/usr/bin/xcode-select -p': res(0, '/Applications/Xcode.app/Contents/Developer'), '/usr/bin/git --version': res(69, '', LICENSE), [`${CLT_GIT} --version`]: cltOk });
    expect(await cltFallback(deps(exec))).toBe(CLT_DIR);
    expect(calls.at(-1)).toEqual({ argv: [CLT_GIT, '--version'], env: { DEVELOPER_DIR: CLT_DIR } });
  });
  test('missing works the same way', async () => {
    const { exec } = fake({ '/usr/bin/xcode-select -p': res(0, '/x'), '/usr/bin/git --version': res(1, '', BAD_PATH), [`${CLT_GIT} --version`]: cltOk });
    expect(await cltFallback(deps(exec))).toBe(CLT_DIR);
  });
  test('never when the login env already has DEVELOPER_DIR (nothing even runs)', async () => {
    const { exec, calls } = fake({ '/usr/bin/git --version': res(69, '', LICENSE), [`${CLT_GIT} --version`]: cltOk });
    expect(await cltFallback(deps(exec, { env: { PATH: '/usr/bin', DEVELOPER_DIR: '/Applications/Other.app' } }))).toBeNull();
    expect(calls).toEqual([]);
  });
  test('never when git is ok / error, when the CLT git is absent, or when it fails too', async () => {
    const ok = fake({ '/usr/bin/xcode-select -p': res(0, '/x'), '/usr/bin/git --version': res(0, 'git version 2.54.0') });
    expect(await cltFallback(deps(ok.exec))).toBeNull();
    const err = fake({ '/usr/bin/xcode-select -p': res(0, '/x'), '/usr/bin/git --version': res(128, '', 'fatal: odd') });
    expect(await cltFallback(deps(err.exec))).toBeNull();
    const lic = fake({ '/usr/bin/xcode-select -p': res(0, '/x'), '/usr/bin/git --version': res(69, '', LICENSE), [`${CLT_GIT} --version`]: res(1, '', BAD_PATH) });
    expect(await cltFallback(deps(lic.exec, { exists: () => false }))).toBeNull();
    expect(lic.calls.some((c) => c.argv[0] === CLT_GIT)).toBe(false);
    expect(await cltFallback(deps(lic.exec))).toBeNull();
  });
});

describe('hf1116 G3 git_identity_set: validation + argv (never a shell string)', () => {
  test('identityIssue: empty / newline / control / leading "-" / bad email', () => {
    expect(identityIssue('Bill Pham', 'bill@x-dev.test')).toBeNull();
    expect(identityIssue('  ', 'bill@x-dev.test')).toBe('name');
    expect(identityIssue('Bill\nPham', 'bill@x-dev.test')).toBe('name');
    expect(identityIssue('Bill\x07', 'bill@x-dev.test')).toBe('name');
    expect(identityIssue('-c core.x', 'bill@x-dev.test')).toBe('name');
    expect(identityIssue('Bill', 'bill@x')).toBe('email');
    expect(identityIssue('Bill', 'bill x@y-dev.test')).toBe('email');
    expect(identityIssue('Bill', 'bill@x-dev.test\n[core]')).toBe('email');
    expect(identityIssue('Bill', '')).toBe('email');
  });
  test('valid → two `git config --global` argv calls with the trimmed values', async () => {
    const { exec, calls } = fake({ '/usr/bin/git config --global': res(0) });
    await setIdentity(deps(exec), ' Bill Pham ', 'bill@x-dev.test ');
    expect(calls.map((c) => c.argv)).toEqual([
      ['/usr/bin/git', 'config', '--global', 'user.name', 'Bill Pham'],
      ['/usr/bin/git', 'config', '--global', 'user.email', 'bill@x-dev.test'],
    ]);
  });
  test('invalid → keyed bad_input, nothing runs; a git failure → keyed git_identity_failed', async () => {
    const { exec, calls } = fake({ '/usr/bin/git config --global': res(255, '', 'error: could not lock config file') });
    const e1 = await setIdentity(deps(exec), 'Bill', 'nope').catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(KeyedError);
    expect((e1 as KeyedError).key).toBe('errors.gitIdentityEmail');
    expect(calls).toEqual([]);
    const e2 = await setIdentity(deps(exec), 'Bill', 'bill@x-dev.test').catch((e: unknown) => e);
    expect((e2 as KeyedError).code).toBe('git_identity_failed');
    expect((e2 as KeyedError).params).toEqual({ detail: 'error: could not lock config file' });
  });
});

describe('hf1116 G3 git_install: `xcode-select --install` (never sudo)', () => {
  test('exit 0 → opened; "already installed" → not opened; other failure → keyed error', async () => {
    const a = fake({ '/usr/bin/xcode-select --install': res(0, 'xcode-select: note: install requested for command line developer tools') });
    expect(await gitInstall(a.exec)).toEqual({ opened: true });
    expect(a.calls.map((c) => c.argv)).toEqual([['/usr/bin/xcode-select', '--install']]);
    const b = fake({ '/usr/bin/xcode-select --install': res(1, '', 'xcode-select: error: command line tools are already installed, use "Software Update" in System Settings to install updates') });
    expect(await gitInstall(b.exec)).toEqual({ opened: false });
    const c = fake({ '/usr/bin/xcode-select --install': res(1, '', 'xcode-select: error: boom') });
    const e = await gitInstall(c.exec).catch((x: unknown) => x);
    expect((e as KeyedError).code).toBe('git_install_failed');
  });
});
