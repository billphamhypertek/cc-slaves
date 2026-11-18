// hf1116 T1: the terminal login (`~/.claude` + `~/.claude.json` + the default Keychain item) is a normal account.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_KEYCHAIN_SERVICE, dismissTerminal, getAccount, terminalDismissed, undismissTerminal, upsertAccount, usableAccounts } from '../../src/accounts/registry.ts';
import { syncTerminal } from '../../src/accounts/terminal.ts';
import { openDb, type Db } from '../../src/db.ts';

let tmp: string;
let db: Db;
let claudeHome: string;
let claudeJson: string;
const logins = new Set<string>();
const asked: string[] = [];
const hasLogin = (a: { email: string; keychainService: string }) => { asked.push(a.keychainService); return logins.has(a.email); };
const sync = () => syncTerminal(db, { claudeHome, claudeJson, hasLogin });
const identity = (email: string | null) => writeFileSync(claudeJson, JSON.stringify(email ? { oauthAccount: { emailAddress: email, accountUuid: `u-${email}`, organizationUuid: 'o', planDisplayName: 'Max 20x' } } : {}));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-term-'));
  db = openDb(join(tmp, 'state.db'));
  claudeHome = join(tmp, 'claude');
  claudeJson = join(tmp, 'claude.json');
  mkdirSync(claudeHome, { recursive: true });
  logins.clear();
  asked.length = 0;
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('hf1116 T1 detect the terminal login', () => {
  test('hf1116 T1 identity + default Keychain login → a normal usable account (dir = ~/.claude, terminal, default item, new-login defaults)', () => {
    identity('Term@X.test');
    logins.add('term@x.test');
    expect(sync()).toEqual({ added: 'term@x.test', lost: [] });
    expect(asked).toEqual([DEFAULT_KEYCHAIN_SERVICE]);
    expect(getAccount(db, 'term@x.test')).toMatchObject({ dir: claudeHome, terminal: true, accountUuid: 'u-Term@X.test', plan: 'Max 20x', role: null, week: null, lanesMax: null, paused: false });
    expect(usableAccounts(db)).toEqual([expect.objectContaining({ email: 'term@x.test', configDir: claudeHome, keychainService: DEFAULT_KEYCHAIN_SERVICE, terminal: true })]);
    expect(sync()).toEqual({ added: null, lost: [] }); // idempotent: nothing written twice
  });

  test('hf1116 T1 no identity file / no oauthAccount → nothing, and the Keychain is never asked', () => {
    expect(sync()).toEqual({ added: null, lost: [] });
    identity(null);
    expect(sync()).toEqual({ added: null, lost: [] });
    expect(asked).toEqual([]);
    expect(usableAccounts(db)).toEqual([]);
  });

  test('hf1116 T1 identity but no Keychain login → not added', () => {
    identity('term@x.test');
    expect(sync()).toEqual({ added: null, lost: [] });
    expect(getAccount(db, 'term@x.test')).toBeNull();
  });

  test('hf1116 T1 D25 the email already has its own cc-slaves dir → that row is kept as is, never duplicated nor marked terminal', () => {
    upsertAccount(db, { email: 'term@x.test', id: 'aaaaaaaaaaaa', dir: '/accts/aaaaaaaaaaaa', role: 'backup' });
    identity('term@x.test');
    logins.add('term@x.test');
    expect(sync()).toEqual({ added: null, lost: [] });
    expect(getAccount(db, 'term@x.test')).toMatchObject({ dir: '/accts/aaaaaaaaaaaa', terminal: false, role: 'backup' });
    expect(usableAccounts(db)).toHaveLength(1);
  });

  test('hf1116 T1 a dir-less (v1-imported) row of that email keeps its role / caps and becomes the terminal account', () => {
    upsertAccount(db, { email: 'term@x.test', role: 'orchestrator', week: 80 });
    identity('term@x.test');
    logins.add('term@x.test');
    expect(sync().added).toBe('term@x.test');
    expect(getAccount(db, 'term@x.test')).toMatchObject({ dir: claudeHome, terminal: true, role: 'orchestrator', week: 80 });
  });

  test('hf1116 T1 identity change (/login with another email in the terminal) → old row loses its dir, the new email becomes terminal', () => {
    identity('a@x.test');
    logins.add('a@x.test');
    sync();
    upsertAccount(db, { email: 'a@x.test', role: 'primary' });
    identity('b@x.test');
    logins.add('b@x.test');
    expect(sync()).toEqual({ added: 'b@x.test', lost: ['a@x.test'] });
    expect(getAccount(db, 'a@x.test')).toMatchObject({ dir: null, terminal: false, role: 'primary' });
    expect(getAccount(db, 'b@x.test')).toMatchObject({ dir: claudeHome, terminal: true });
    expect(usableAccounts(db).map((a) => a.email)).toEqual(['b@x.test']);
  });

  test('hf1116 T1 identity changed to an email that has no Keychain login yet → the old row still loses its dir', () => {
    identity('a@x.test');
    logins.add('a@x.test');
    sync();
    identity('b@x.test');
    expect(sync()).toEqual({ added: null, lost: ['a@x.test'] });
    expect(usableAccounts(db)).toEqual([]);
  });

  test('hf1116 T3 a dismissed terminal email is never re-added; clearing the dismissal lets it back', () => {
    identity('term@x.test');
    logins.add('term@x.test');
    dismissTerminal(db, 'Term@x.test');
    expect(terminalDismissed(db).has('term@x.test')).toBe(true);
    expect(sync()).toEqual({ added: null, lost: [] });
    expect(getAccount(db, 'term@x.test')).toBeNull();
    undismissTerminal(db, 'term@x.test');
    expect(terminalDismissed(db).size).toBe(0);
    expect(sync().added).toBe('term@x.test');
  });
});
