import { describe, expect, test } from 'bun:test';
import {
  DELETE_MAX, accountKeychainService, deleteKeychainItem, keychainHasLogin, type SecurityRun,
} from '../../src/accounts/keychain.ts';

const NOT_FOUND = { code: 44, stderr: 'security: SecItemDelete: The specified item could not be found in the keychain.' };

/** Fake `security`: deletes succeed `items` times, then "not found". Records every argv. */
function fakeRun(items: number, other?: { code: number; stderr: string }) {
  const calls: string[][] = [];
  let left = items;
  const run: SecurityRun = (args) => {
    calls.push(args);
    if (other) return other;
    if (left > 0) { left--; return { code: 0, stderr: '' }; }
    return NOT_FOUND;
  };
  return { run, calls };
}

describe('v2 §3.2 SA4 keychain.ts', () => {
  test('§3.1-1 fixed vectors: service = "Claude Code-credentials-" + sha256(dir)[0..8], dir verbatim', () => {
    const dir = '/Users/po/.cc-slaves-accounts/0123456789ab';
    const h = new Bun.CryptoHasher('sha256').update(dir).digest('hex').slice(0, 8);
    expect(accountKeychainService(dir)).toBe(`Claude Code-credentials-${h}`);
    // a trailing '/' is a different string → a different item (never normalised)
    expect(accountKeychainService(`${dir}/`)).not.toBe(accountKeychainService(dir));
    expect(accountKeychainService('/a')).toBe('Claude Code-credentials-6a50dc85');
  });

  test('§3.2 SA4 delete loops until "not found" (exit 44): 2 items → 3 calls, all with the exact name', () => {
    const { run, calls } = fakeRun(2);
    const svc = accountKeychainService('/r/0123456789ab');
    expect(deleteKeychainItem(svc, run)).toEqual({ deleted: 2, result: 'gone' });
    expect(calls).toEqual([0, 1, 2].map(() => ['delete-generic-password', '-s', svc]));
  });

  test('§3.2 SA4 "not found" by message alone also stops the loop', () => {
    const calls: string[][] = [];
    const run: SecurityRun = (a) => { calls.push(a); return { code: 1, stderr: 'The specified item could not be found in the keychain.' }; };
    expect(deleteKeychainItem(accountKeychainService('/r/0123456789ab'), run)).toEqual({ deleted: 0, result: 'gone' });
    expect(calls.length).toBe(1);
  });

  test('§3.2 SA4 cap: at most 5 calls even when every delete succeeds', () => {
    const { run, calls } = fakeRun(99);
    expect(DELETE_MAX).toBe(5);
    expect(deleteKeychainItem(accountKeychainService('/r/0123456789ab'), run)).toEqual({ deleted: 5, result: 'cap' });
    expect(calls.length).toBe(5);
  });

  test('§3.2 SA4 another error stops at once (no retry storm)', () => {
    const { run, calls } = fakeRun(0, { code: 51, stderr: 'User interaction is not allowed.' });
    expect(deleteKeychainItem(accountKeychainService('/r/0123456789ab'), run)).toEqual({ deleted: 0, result: 'error', detail: 'User interaction is not allowed.' });
    expect(calls.length).toBe(1);
  });

  test('§3.2 SA4 never a prefix / wildcard / the terminal default: anything but `<prefix>-<8 hex>` is refused before any call', () => {
    for (const bad of ['Claude Code-credentials', 'Claude Code-credentials-', 'Claude Code-credentials-*', 'Claude Code-credentials-abc',
      'Claude Code-credentials-0123456789', 'Claude Code-credentials-ABCDEF12', 'x Claude Code-credentials-01234567', '']) {
      const { run, calls } = fakeRun(1);
      expect(() => deleteKeychainItem(bad, run)).toThrow(/refusing/);
      expect(calls).toEqual([]);
    }
  });

  test('§3.2 SA4 argv is exactly [delete-generic-password, -s, <exact>]: no -l / -a / -D / -c search flags', () => {
    const { run, calls } = fakeRun(1);
    deleteKeychainItem(accountKeychainService('/r/0123456789ab'), run);
    for (const a of calls) {
      expect(a.length).toBe(3);
      expect(a.filter((x) => x.startsWith('-'))).toEqual(['-s']);
    }
  });

  test('F16 keychainHasLogin: item with claudeAiOauth.accessToken → true; missing item / only mcpOAuth → false', () => {
    const svc = 'Claude Code-credentials-01234567';
    const exec = (j: string | null) => (_c: string, a: string[]) => {
      expect(a).toEqual(['find-generic-password', '-s', svc, '-w']);
      if (j === null) throw new Error('not found');
      return j;
    };
    expect(keychainHasLogin({ keychainService: svc }, exec(JSON.stringify({ claudeAiOauth: { accessToken: 't' } })))).toBe(true);
    expect(keychainHasLogin({ keychainService: svc }, exec(JSON.stringify({ mcpOAuth: {} })))).toBe(false);
    expect(keychainHasLogin({ keychainService: svc }, exec(null))).toBe(false);
  });
});
