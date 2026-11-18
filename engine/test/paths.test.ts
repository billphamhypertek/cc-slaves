import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ensureAccountsRoot, ensureHome, paths, writeFileSecure } from '../src/paths.ts';

const KEYS = ['CC_SLAVES_HOME', 'CLAUDE_HOME', 'CLAUDE_JSON', 'CC_SLAVES_ATTACH'] as const;
let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(join(tmpdir(), 'ccs-paths-'));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe('paths', () => {
  test('defaults point at the real home roots when env is unset', () => {
    for (const k of KEYS) delete process.env[k];
    const p = paths();
    expect(p.home).toBe(join(homedir(), '.cc-slaves'));
    expect(p.claudeHome).toBe(join(homedir(), '.claude'));
    expect(p.claudeJson).toBe(join(homedir(), '.claude.json'));
    expect(p.attachRoot).toBe(join(homedir(), 'Library', 'Caches', 'cc-slaves', 'attachments')); // v2.4 §6.5: no `.cc-slaves` in it
    expect(p.cloudflaredDir).toBe(join(homedir(), '.cloudflared'));
  });

  test('§10.2 A11 paths().attachRoot throws when CC_SLAVES_HOME is set but CC_SLAVES_ATTACH is missing', () => {
    process.env.CC_SLAVES_HOME = join(tmp, 'h');
    delete process.env.CC_SLAVES_ATTACH;
    const p = paths(); // every other path still resolves: only reading attachRoot throws
    expect(p.home).toBe(join(tmp, 'h'));
    expect(() => p.attachRoot).toThrow(/CC_SLAVES_ATTACH/);
    process.env.CC_SLAVES_ATTACH = join(tmp, 'att');
    expect(paths().attachRoot).toBe(join(tmp, 'att'));
  });

  test('§7.8 every storage path derives from CC_SLAVES_HOME', () => {
    process.env.CC_SLAVES_HOME = join(tmp, 'h');
    process.env.CLAUDE_HOME = join(tmp, 'cl');
    process.env.CLAUDE_JSON = join(tmp, 'cl.json');
    const p = paths();
    const h = join(tmp, 'h');
    expect(p.config).toBe(join(h, 'config.json'));
    expect(p.caps).toBe(join(h, 'caps.json'));
    expect(p.engineJson).toBe(join(h, 'engine.json'));
    expect(p.engineLock).toBe(join(h, 'engine.lock'));
    expect(p.stateDb).toBe(join(h, 'state.db'));
    expect(p.cloudflaredYml).toBe(join(h, 'cloudflared.yml'));
    expect(p.runLog('proj1', 'D2', 3)).toBe(join(h, 'logs', 'proj1', 'D2', 'run-3.jsonl'));
    expect(p.mcpConfig('sess-1')).toBe(join(h, 'mcp', 'sess-1.json'));
    expect(p.mcpLog('plugin:vercel@mkt:vercel')).toBe(join(h, 'logs', 'mcp-plugin%3Avercel%40mkt%3Avercel.log')); // v2.2 §5.2
    expect(p.mcpLog('user:a/../b')).toBe(join(h, 'logs', 'mcp-user%3Aa%2F..%2Fb.log'));
    expect(p.claudeHome).toBe(join(tmp, 'cl'));
    expect(p.claudeJson).toBe(join(tmp, 'cl.json'));
    expect(p.legacyCaps).toBe(join(tmp, 'cl', 'state', 'cc-lanes-caps.json'));
  });

  test('path helpers reject segments that escape the home', () => {
    process.env.CC_SLAVES_HOME = join(tmp, 'h');
    const p = paths();
    expect(() => p.runLog('../x', 'D2', 1)).toThrow();
    expect(() => p.runLog('p', 'a/b', 1)).toThrow();
    expect(() => p.mcpConfig('..')).toThrow();
  });

  test('§7.2 M18 ensureHome creates the home 0700 and re-tightens an existing one', () => {
    process.env.CC_SLAVES_HOME = join(tmp, 'h');
    ensureHome();
    expect(mode(join(tmp, 'h'))).toBe(0o700);
    chmodSync(join(tmp, 'h'), 0o755);
    ensureHome();
    expect(mode(join(tmp, 'h'))).toBe(0o700);
  });

  test('§5.5 ensureHome deletes the stale v2.1 engine-settings.json (per-session settings replaced it)', () => {
    process.env.CC_SLAVES_HOME = join(tmp, 'h');
    ensureHome();
    writeFileSync(join(tmp, 'h', 'engine-settings.json'), '{}');
    writeFileSync(join(tmp, 'h', 'config.json'), '{}');
    ensureHome();
    expect(readdirSync(join(tmp, 'h'))).toEqual(['config.json']);
  });

  test('§7.2 M18 writeFileSecure writes 0600 and creates parent dirs 0700', () => {
    const f = join(tmp, 'h', 'logs', 'p', 'D2', 'run-1.jsonl');
    writeFileSecure(f, 'hello');
    expect(readFileSync(f, 'utf8')).toBe('hello');
    expect(mode(f)).toBe(0o600);
    expect(mode(join(tmp, 'h', 'logs', 'p', 'D2'))).toBe(0o700);
  });

  test('writeFileSecure replaces atomically, tightens mode, leaves no tmp file', () => {
    const f = join(tmp, 'a.json');
    writeFileSync(f, 'old');
    chmodSync(f, 0o644);
    writeFileSecure(f, 'new');
    expect(readFileSync(f, 'utf8')).toBe('new');
    expect(mode(f)).toBe(0o600);
    expect(readdirSync(tmp)).toEqual(['a.json']);
  });
});

describe('accounts root (v2 §5.1)', () => {
  test('§5.1 accountsRoot defaults to ~/.cc-slaves-accounts, outside ~/.cc-slaves (§3.1-9)', () => {
    const saved = process.env.CC_SLAVES_ACCOUNTS;
    delete process.env.CC_SLAVES_ACCOUNTS;
    try {
      expect(paths().accountsRoot).toBe(join(homedir(), '.cc-slaves-accounts'));
    } finally {
      if (saved !== undefined) process.env.CC_SLAVES_ACCOUNTS = saved;
    }
  });

  test('§5.1 CC_SLAVES_ACCOUNTS overrides the root; ensureAccountsRoot creates it 0700', () => {
    const saved = process.env.CC_SLAVES_ACCOUNTS;
    process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
    try {
      expect(paths().accountsRoot).toBe(join(tmp, 'accts'));
      expect(ensureAccountsRoot()).toBe(join(tmp, 'accts'));
      expect(mode(join(tmp, 'accts'))).toBe(0o700);
    } finally {
      if (saved === undefined) delete process.env.CC_SLAVES_ACCOUNTS;
      else process.env.CC_SLAVES_ACCOUNTS = saved;
    }
  });
});
