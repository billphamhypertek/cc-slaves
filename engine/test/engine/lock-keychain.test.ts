import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, writeEngineJson } from '../../src/lock.ts';
import { bootToken } from '../../src/keychain.ts';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ccs-lock-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('§7.1 single instance (engine.lock)', () => {
  test('§7.1 a live holder refuses the second instance', () => {
    const f = join(tmp, 'engine.lock');
    const a = acquireLock(f);
    expect(a.ok).toBe(true);
    const b = acquireLock(f);
    expect(b).toEqual({ ok: false, pid: process.pid });
    if (a.ok) a.release();
    expect(existsSync(f)).toBe(false);
  });
  test('§7.1 a stale lock (dead pid) is taken over', () => {
    const f = join(tmp, 'engine.lock');
    writeFileSync(f, '999999');
    const a = acquireLock(f, { alive: () => false });
    expect(a.ok).toBe(true);
    expect(readFileSync(f, 'utf8').trim()).toBe(String(process.pid));
  });
  test('§7.1 engine.json holds pid, port, version only, mode 0600', () => {
    const f = join(tmp, 'engine.json');
    writeEngineJson(f, { pid: 1, port: 47800, version: '0.1.0' });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ pid: 1, port: 47800, version: '0.1.0' });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe('CC_SLAVES_TOKEN_OVERRIDE (test-only knob, live smoke §10)', () => {
  test('§10 smoke: a long override is used as-is and the Keychain write is skipped', () => {
    const t = 'x'.repeat(43);
    expect(bootToken({ CC_SLAVES_TOKEN_OVERRIDE: t })).toEqual({ token: t, store: false });
  });
  test('§10 smoke: unset / short override → fresh random token stored in the Keychain', () => {
    for (const env of [{}, { CC_SLAVES_TOKEN_OVERRIDE: 'short' }]) {
      const r = bootToken(env);
      expect(r.store).toBe(true);
      expect(r.token.length).toBeGreaterThanOrEqual(43);
    }
  });
});
