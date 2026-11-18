import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, fallbackPath, STRIP_ENV, stripEnv, loadLoginEnv, parseEnvOutput, type ShellRunner } from '../../src/session/env.ts';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ccs-env-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function exe(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o755);
  return p;
}

describe('parseEnvOutput', () => {
  test('KEY=value lines, multi-line values, rc noise before the first var dropped', () => {
    expect(parseEnvOutput('welcome!\nPATH=/a:/b\nMULTI=one\ntwo\nX=a=b\n')).toEqual({ PATH: '/a:/b', MULTI: 'one\ntwo', X: 'a=b' });
  });
});

describe('login-shell env (§3.1 I11, §7.1 N9)', () => {
  test('§3.1 I11 runs $SHELL -lic env once with a 10 s timeout and finds claude on that PATH', async () => {
    const binDir = join(tmp, 'local', 'bin');
    const claude = exe(binDir, 'claude');
    const calls: [string, string[], number][] = [];
    const runner: ShellRunner = async (sh, args, t) => {
      calls.push([sh, args, t]);
      return { ok: true, stdout: `PATH=/usr/bin:${binDir}\nHOME=${tmp}\nFOO=bar\n` };
    };
    const r = await loadLoginEnv({ shell: '/bin/zsh', runner, home: tmp });
    expect(calls).toEqual([['/bin/zsh', ['-lic', 'env'], 10_000]]);
    expect(r).toMatchObject({ shellFailed: false, claudePath: claude });
    expect(r.env.FOO).toBe('bar');
  });
  test('§7.1 N9 timeout/failure → fallback PATH (~/.local/bin, /opt/homebrew/bin, nvm default) + flag', async () => {
    const claude = exe(join(tmp, '.local', 'bin'), 'claude');
    mkdirSync(join(tmp, '.nvm', 'alias'), { recursive: true });
    writeFileSync(join(tmp, '.nvm', 'alias', 'default'), '24\n');
    mkdirSync(join(tmp, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'), { recursive: true });
    mkdirSync(join(tmp, '.nvm', 'versions', 'node', 'v24.2.0', 'bin'), { recursive: true });
    mkdirSync(join(tmp, '.nvm', 'versions', 'node', 'v24.10.1', 'bin'), { recursive: true });
    const r = await loadLoginEnv({ shell: '/bin/zsh', runner: async () => ({ ok: false, stdout: '', error: 'timeout' }), home: tmp, base: { PATH: '/usr/bin:/bin', KEEP: '1' } });
    expect(r.shellFailed).toBe(true);
    expect(r.reason).toContain('timeout');
    expect(r.env.PATH).toBe(`${join(tmp, '.local/bin')}:/opt/homebrew/bin:${join(tmp, '.nvm/versions/node/v24.10.1/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(r.env.KEEP).toBe('1');
    expect(r.claudePath).toBe(claude);
  });
  test('§7.1 N9 shell output without PATH counts as failure', async () => {
    const r = await loadLoginEnv({ shell: '/bin/zsh', runner: async () => ({ ok: true, stdout: 'garbage\n' }), home: tmp, base: {} });
    expect(r.shellFailed).toBe(true);
  });
  test('fallback PATH without nvm skips the node dir', () => {
    expect(fallbackPath(tmp)).toBe(`${join(tmp, '.local/bin')}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
  });
  test('claude missing → claudePath null', async () => {
    const r = await loadLoginEnv({ shell: '/bin/zsh', runner: async () => ({ ok: true, stdout: `PATH=${tmp}/none\n` }), home: tmp });
    expect(r.claudePath).toBeNull();
  });
  test('default runner really runs a shell (sh -c printing env)', async () => {
    const r = await loadLoginEnv({ shell: '/bin/sh', shellArgs: ['-c', 'echo PATH=/x; echo Y=2'], home: tmp });
    expect(r.env).toEqual({ PATH: '/x', Y: '2' });
  });
  test('default runner times out a hung shell', async () => {
    const t0 = Date.now();
    const r = await loadLoginEnv({ shell: '/bin/sh', shellArgs: ['-c', 'sleep 30'], timeoutMs: 200, home: tmp, base: {} });
    expect(r.shellFailed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('child env (§7.3)', () => {
  const login = { PATH: '/p', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: '/stale', A: 'b' };
  test('§7.3 strips ANTHROPIC_API_KEY, CLAUDECODE, CLAUDE_CODE_ENTRYPOINT; sets CLAUDE_CONFIG_DIR from the account', () => {
    expect(childEnv(login, { configDir: '/acc/config' })).toEqual({ PATH: '/p', A: 'b', CLAUDE_CONFIG_DIR: '/acc/config', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
  });
  test('v2.2 §5.1 claude.ai connectors never load: ENABLE_CLAUDEAI_MCP_SERVERS=false even when the login env says true', () => {
    expect(childEnv({ PATH: '/p', ENABLE_CLAUDEAI_MCP_SERVERS: 'true' }, { configDir: '/a' }).ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });
  test('§5.4 CLAUDE_CONFIG_DIR is always the account dir (no default-login account in v2); an inherited one is replaced', () => {
    expect(childEnv(login, { configDir: '/accts/0123456789ab' }).CLAUDE_CONFIG_DIR).toBe('/accts/0123456789ab');
    expect(childEnv({ PATH: '/p' }, { configDir: '/accts/0123456789ab' }).CLAUDE_CONFIG_DIR).toBe('/accts/0123456789ab');
  });
  test('hf1116 T2 terminal account: CLAUDE_CONFIG_DIR absent (an inherited one is stripped too), the rest as any account', () => {
    const env = childEnv({ ...login, CLAUDE_CONFIG_DIR: '/inherited' }, { configDir: '/Users/x/.claude', terminal: true });
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
    expect(env).toEqual({ PATH: '/p', A: 'b', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
  });
});

describe('v2 §7 shared strip list (login + session)', () => {
  const dirty = {
    PATH: '/p', HTTP_PROXY: 'http://px', HTTPS_PROXY: 'http://px', NO_PROXY: 'localhost', http_proxy: 'http://px',
    ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', ANTHROPIC_MODEL: 'm',
    ANTHROPIC_CUSTOM_HEADERS: 'h', ANTHROPIC_SOMETHING_NEW: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
    CLAUDE_CODE_SKIP_VERTEX_AUTH: '1', AWS_BEARER_TOKEN_BEDROCK: 'b', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CONFIG_DIR: '/stale', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9',
  };
  const kept = { PATH: '/p', HTTP_PROXY: 'http://px', HTTPS_PROXY: 'http://px', NO_PROXY: 'localhost', http_proxy: 'http://px', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9' };
  test('§7 login env: every ANTHROPIC_* and the named list are removed, proxies kept', () => {
    expect(stripEnv(dirty)).toEqual(kept);
  });
  test('§7 session childEnv uses the same strip list, then sets CLAUDE_CONFIG_DIR', () => {
    expect(childEnv(dirty, { configDir: '/accts/0123456789ab' })).toEqual({ ...kept, CLAUDE_CONFIG_DIR: '/accts/0123456789ab', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
  });
  test('§7 the named list is one constant', () => {
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR']) {
      expect(STRIP_ENV as readonly string[]).toContain(k);
    }
  });
  test('stripEnv does not mutate its input', () => {
    const e = { ANTHROPIC_API_KEY: 'k' };
    stripEnv(e);
    expect(e).toEqual({ ANTHROPIC_API_KEY: 'k' });
  });
});
