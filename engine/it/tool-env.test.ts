// hotfix 2026-11-16 (0a42d6d, re-review N1): every engine-run tool (git, gh, setup) runs with the login-shell env,
// stripped like a session's — DEVELOPER_DIR reaches it; provider vars and a stale CLAUDE_CONFIG_DIR never do, and
// nothing leaks in from the engine's own process env.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.ts';

setDefaultTimeout(30_000);
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON', 'ANTHROPIC_BASE_URL'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-toolenv-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  process.env.ANTHROPIC_BASE_URL = 'http://leak.invalid'; // the engine process env must not reach a tool
  mkdirSync(join(tmp, 'web'), { recursive: true });
  writeFileSync(join(tmp, 'web', 'index.html'), '<!doctype html>');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  engine = await Engine.start({ // no `exec` / `gitExec` override: the real login-env exec is under test
    gh: null, version: 'test', port: 0, token: 'tok', staticDir: join(tmp, 'web'), command: ['false'],
    loginEnv: {
      env: {
        PATH: process.env.PATH ?? '', HOME: tmp, DEVELOPER_DIR: '/Library/Developer/CommandLineTools',
        ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CONFIG_DIR: '/stale', CLAUDE_CODE_USE_BEDROCK: '1',
      },
      claudePath: null, shellFailed: false, reason: null,
    },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    closeGraceMs: 100, accountsEveryMs: 0, quotaEveryMs: 0, log: () => {}, hasLogin: () => false,
  });
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

for (const which of ['exec', 'gitExec'] as const) {
  test(`hotfix 2026-11-16 engine.${which}: DEVELOPER_DIR from the login env; no provider var, no stale CLAUDE_CONFIG_DIR, no process.env leak`, async () => {
    const r = await engine[which](['/usr/bin/env']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DEVELOPER_DIR=/Library/Developer/CommandLineTools\n');
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK']) expect(r.stdout).not.toContain(`${k}=`);
  });
}
