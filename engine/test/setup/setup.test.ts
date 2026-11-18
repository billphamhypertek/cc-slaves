import { describe, expect, test } from 'bun:test';
import type { GitSetup } from '../../../shared/protocol.ts';
import type { Account } from '../../src/accounts/registry.ts';
import * as setup from '../../src/setup/setup.ts';
import { installClaude, parseVersion, setupCheck, type Exec } from '../../src/setup/setup.ts';

const acct = (email: string): Account => ({ email, id: null, configDir: `/c/${email}`, keychainService: 'k', planTier: null, terminal: false });

function fakeExec(table: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const exec: Exec = async (argv, o) => {
    calls.push(argv);
    const key = Object.keys(table).find((k) => argv.join(' ').includes(k));
    const r = key ? table[key]! : { code: 0, stdout: '' };
    for (const l of (r.stdout ?? '').split('\n').filter(Boolean)) o?.onLine?.(l);
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { exec, calls };
}

describe('§6.1 F1 setup_check (v2 §6: Claude Code is the only dependency)', () => {
  test('parseVersion reads "2.1.325 (Claude Code)"', () => {
    expect(parseVersion('2.1.325 (Claude Code)\n')).toBe('2.1.325');
    expect(parseVersion('garbage')).toBeNull();
  });

  const git: GitSetup = { state: 'missing', version: null, detail: null, identity: { name: null, email: null }, gh: 'missing', ghUser: null, ghLogin: null };
  const base = { claudePath: () => '/u/claude', accounts: () => [acct('a@x')], loggedOut: () => new Set<string>(), poEmail: () => null, git: async () => git };

  test('v2 §7 SetupStatus has no ccSwitch / inCcSwitch; only `claude --version` runs (hf1116: + git, which never gates done)', async () => {
    const { exec, calls } = fakeExec({ '--version': { stdout: '2.1.325 (Claude Code)' } });
    const s = await setupCheck({ ...base, exec });
    expect(Object.keys(s).sort()).toEqual(['accounts', 'claude', 'done', 'git', 'poEmail']);
    expect(s.git).toBe(git);
    expect(s.done).toBe(true);
    expect(s.accounts).toEqual([{ email: 'a@x', loggedIn: true }]);
    expect(calls).toEqual([['/u/claude', '--version']]);
  });

  test('v2 §6 done = Claude Code ok ∧ ≥ 1 logged-in account', async () => {
    const ok = fakeExec({ '--version': { stdout: '2.1.325 (Claude Code)' } }).exec;
    const old = fakeExec({ '--version': { stdout: '2.1.324 (Claude Code)' } }).exec;
    expect((await setupCheck({ ...base, exec: ok })).done).toBe(true);
    expect((await setupCheck({ ...base, exec: old })).claude.ok).toBe(false);
    expect((await setupCheck({ ...base, exec: old })).done).toBe(false);
    expect((await setupCheck({ ...base, exec: ok, accounts: () => [] })).done).toBe(false);
    expect((await setupCheck({ ...base, exec: ok, loggedOut: () => new Set(['a@x']) })).done).toBe(false);
    expect((await setupCheck({ ...base, exec: ok, accounts: () => [acct('a@x'), acct('b@x')], loggedOut: () => new Set(['a@x']) })).done).toBe(true);
  });

  test('§6.1 missing claude → not done, nothing run', async () => {
    const { exec, calls } = fakeExec({});
    const s = await setupCheck({ ...base, exec, claudePath: () => null, accounts: () => [acct('d@x')], loggedOut: () => new Set(['d@x']), poEmail: () => 'po@x' });
    expect(s.claude).toEqual({ found: false, path: null, version: null, ok: false });
    expect(s.accounts).toEqual([{ email: 'd@x', loggedIn: false }]);
    expect(s.poEmail).toBe('po@x');
    expect(s.done).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('§6.1 F1b setup_install', () => {
  test('claude: runs the official install script, streams its lines', async () => {
    const { exec, calls } = fakeExec({ 'install.sh': { stdout: 'Downloading…\nInstalled' } });
    const lines: string[] = [];
    expect(await installClaude('claude', { exec, log: (l) => lines.push(l) })).toBe(true);
    expect(calls[0]).toEqual(['/bin/bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
    expect(lines).toContain('Installed');
  });
});

test('v2 §7 the CC Switch installer is gone from setup.ts', () => {
  expect(Object.keys(setup).filter((k) => /ccswitch/i.test(k))).toEqual([]);
});

describe('hotfix 2026-11-16 execIn: engine tools run with the login-shell env (Xcode license / DEVELOPER_DIR)', () => {
  test('the base env reaches the child; the call env wins over it; process.env is not leaked in', async () => {
    const exec = setup.execIn({ PATH: process.env.PATH, DEVELOPER_DIR: '/Library/Developer/CommandLineTools', HF_A: 'base' });
    const r = await exec(['/usr/bin/env'], { env: { HF_A: 'call' } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DEVELOPER_DIR=/Library/Developer/CommandLineTools\n');
    expect(r.stdout).toContain('HF_A=call\n');
    expect(r.stdout).not.toContain('HOME=');
  });
});
