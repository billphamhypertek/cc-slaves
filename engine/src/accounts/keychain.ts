// v2 §7 `keychain.ts` (§3.1-1, §3.2 SA4): the account's Keychain item name, the read used by quota / F16, and the delete
// used by "Xoá account". `/usr/bin/security` is always injected (tests use fakes, never the real Keychain).
import { execFileSync } from 'node:child_process';
import { DEFAULT_KEYCHAIN_SERVICE, keychainService } from './registry.ts';
import { isObj } from '../../../shared/json.ts';

/** §3.2 SA4: `security delete-generic-password` is repeated at most this many times. */
export const DELETE_MAX = 5;
/** errSecItemNotFound as `security` exits with it. */
const NOT_FOUND_CODE = 44;
const NOT_FOUND_RE = /could not be found/i;
/** The only shape ever deleted: one account dir's item. The bare default (terminal login) and any prefix never match. */
const ACCOUNT_SERVICE_RE = new RegExp(`^${DEFAULT_KEYCHAIN_SERVICE}-[0-9a-f]{8}$`);

/** §3.1-1 / §3.2 SA4: the item name of an account dir — the `dir` string verbatim (no trailing-'/' trim, no realpath). */
export const accountKeychainService = (dir: string): string => keychainService(dir);

/** `security <args>` → exit code + stderr. Only argv, never a shell. */
export type SecurityRun = (args: string[]) => { code: number; stderr: string };
/** `security <args>` → stdout; throws on a non-zero exit (quota read path). */
export type SecurityExec = (cmd: string, args: string[]) => string;

export const securityRun: SecurityRun = (args) => {
  const p = Bun.spawnSync(['/usr/bin/security', ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  return { code: p.exitCode ?? 1, stderr: p.stderr.toString() };
};

export const securityExec: SecurityExec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export type DeleteResult =
  | { deleted: number; result: 'gone' }
  /** DELETE_MAX deletes all succeeded: something keeps re-creating it, or there are > 5 copies. */
  | { deleted: number; result: 'cap' }
  | { deleted: number; result: 'error'; detail: string };

/**
 * §3.2 SA4: `security delete-generic-password -s <exact>` until "not found", at most DELETE_MAX calls. The name must be
 * exactly `Claude Code-credentials-<8 hex>`; anything else (prefix, wildcard, the default item) throws before any call.
 */
export function deleteKeychainItem(service: string, run: SecurityRun = securityRun): DeleteResult {
  if (!ACCOUNT_SERVICE_RE.test(service)) throw new Error(`refusing to delete Keychain item ${JSON.stringify(service)}: not one account dir's exact name`);
  let deleted = 0;
  for (let i = 0; i < DELETE_MAX; i++) {
    const r = run(['delete-generic-password', '-s', service]);
    if (r.code === 0) { deleted++; continue; }
    if (r.code === NOT_FOUND_CODE || NOT_FOUND_RE.test(r.stderr)) return { deleted, result: 'gone' };
    return { deleted, result: 'error', detail: r.stderr.trim() };
  }
  return { deleted, result: 'cap' };
}


/** `claudeAiOauth.accessToken` of a Keychain item, or null (missing item, not JSON, no Claude login — e.g. only `mcpOAuth`). */
export function readAccessToken(service: string, exec: SecurityExec = securityExec): string | null {
  try {
    const j: unknown = JSON.parse(exec('/usr/bin/security', ['find-generic-password', '-s', service, '-w']));
    const t = isObj(j) && isObj(j.claudeAiOauth) ? j.claudeAiOauth.accessToken : null;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/**
 * F16: does the account's Keychain item hold a Claude login? Only a yes/no leaves this function, never the token.
 * (`claude` rewrites `.claude.json` on every start, logged in or not, so that file's mtime alone proves nothing.)
 */
export function keychainHasLogin(account: { keychainService: string }, exec: SecurityExec = securityExec): boolean {
  return readAccessToken(account.keychainService, exec) !== null;
}
