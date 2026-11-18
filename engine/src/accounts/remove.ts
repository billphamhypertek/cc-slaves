// v2 §6 A8L / A8, §7 "Xoá account an toàn": sign an account out (row stays, ✗) or delete it (logout → Keychain item →
// guarded dir delete → row). Sessions and the lane registry are reached only through injected callbacks.
import type { Db } from '../db.ts';
import { KeyedError, type Msg } from '../errors.ts';
import { paths } from '../paths.ts';
import { accountKeychainService, deleteKeychainItem, securityRun, type DeleteResult, type SecurityRun } from './keychain.ts';
import { nodeLayoutFs, safeDeleteAccountDir, type LayoutFs } from './layout.ts';
import { activeLogin, logout, readIdentityFile, type LoginDeps } from './login.ts';
import { deleteAccount, dismissTerminal, getAccount, normEmail, upsertAccount } from './registry.ts';

/** Registry `status` of an account signed out from cc-slaves (A8L); cleared by a successful re-login (A6). */
export const LOGGED_OUT_STATUS = 'logged_out';

export class AccountError extends KeyedError {
  constructor(code: string, m: Msg) { super(code, m); this.name = 'AccountError'; }
}

export interface RemoveDeps {
  db: Db;
  /** `claude auth logout` (same pty / env helper as login). */
  auth: Pick<LoginDeps, 'env' | 'claudePath' | 'spawn' | 'kill' | 'pgrep' | 'timers' | 'killGraceMs'> & { cmdTimeoutMs?: number };
  securityRun?: SecurityRun;
  layoutFs?: LayoutFs;
  /** Names of the lanes occupying this account now (A8 "Đang chạy D2, D15"). */
  lanesOn(email: string): string[];
  /** A8 "Đang là Điều phối": the account is an orchestrator's (role, project home or live session). */
  isOrchestrator(email: string): boolean;
  /** F16: the account just lost its login → its lanes / orchestrator switch (v1 §7.5 handover). */
  onLoggedOut(email: string): void | Promise<void>;
  log?(line: string): void;
}

const usable = (d: RemoveDeps, email: string) => {
  const row = getAccount(d.db, email);
  if (!row) throw new AccountError('no_account', { key: 'errors.noAccount', params: { email: normEmail(email) } });
  return row;
};

/** IMPORTANT-3: the running login (A6 re-login) targets this dir → no logout / delete under it. */
const refuseDuringLogin = (dir: string | null) => {
  const l = activeLogin();
  if (l && dir !== null && l.dir === dir) throw new AccountError('login_running', { key: 'errors.loginRunning' });
};

const signOut = (dir: string, d: RemoveDeps) =>
  logout(dir, d.auth).catch((e: unknown) => { d.log?.(`claude auth logout lỗi (bỏ qua): ${(e as Error).message}`); return null; });

/** §6 A8L: `claude auth logout` (error ignored) → row stays, login ✗ → sessions on it switch like F16. */
export async function logoutAccount(email: string, d: RemoveDeps): Promise<void> {
  const row = usable(d, email);
  if (!row.dir) throw new AccountError('no_account', { key: 'errors.notSignedIn', params: { email: row.email } });
  // hf1116 T3: the terminal's own login is signed out in the terminal (`/logout`), never from here
  if (row.terminal) throw new AccountError('terminal_login', { key: 'errors.terminalLogout' });
  refuseDuringLogin(row.dir);
  upsertAccount(d.db, { email: row.email, status: LOGGED_OUT_STATUS }); // the picker skips it from here on
  await signOut(row.dir, d);
  await d.onLoggedOut(row.email);
}

export interface DeleteOutcome { email: string; dir: string | null; keychain: DeleteResult | null }

/**
 * §7 "Xoá account an toàn" 1–4. Refused while lanes run on it (A8 `lanes_running`) or it is the orchestrator's. A dir the
 * guard refuses (not `<accountsRoot>/<12 hex>`) aborts with the row kept. The row goes with its caps and saved quota
 * (§4.4: "quota đã lưu" is listed as deleted; history / memory / skills in `~/.claude` are never touched).
 */
export async function deleteAccountSafely(email: string, d: RemoveDeps): Promise<DeleteOutcome> {
  const row = usable(d, email);
  refuseDuringLogin(row.dir);
  const lanes = d.lanesOn(row.email);
  if (lanes.length) throw new AccountError('lanes_running', { key: 'errors.lanesRunning', params: { lanes: lanes.join(', ') } });
  if (d.isOrchestrator(row.email)) throw new AccountError('orchestrator', { key: 'errors.isOrchestrator' });
  let keychain: DeleteResult | null = null;
  // hf1116 T3: the terminal account loses only its row — no logout, no Keychain item, never `~/.claude`
  if (row.dir && !row.terminal) {
    await signOut(row.dir, d);
    try {
      keychain = deleteKeychainItem(accountKeychainService(row.dir), d.securityRun ?? securityRun);
    } catch (e) {
      keychain = { deleted: 0, result: 'error', detail: (e as Error).message };
    }
    if (keychain.result !== 'gone') d.log?.(`xoá mục keychain của ${row.email}: ${keychain.result}`);
    try {
      safeDeleteAccountDir(row.dir, paths().accountsRoot, d.layoutFs ?? nodeLayoutFs);
    } catch (e) {
      d.log?.(`từ chối xoá thư mục account: ${(e as Error).message}`);
      throw new AccountError('delete_refused', { key: 'errors.deleteRefused', params: { dir: String(row.dir) } });
    }
  }
  // B-M1: also an own-dir row of the email the terminal is signed in as, else the detection adds it straight back
  const termEmail = readIdentityFile(paths().claudeJson)?.email;
  const dismiss = row.terminal || (termEmail !== undefined && normEmail(termEmail) === row.email);
  d.db.transaction(() => {
    if (dismiss) dismissTerminal(d.db, row.email); // not added back by the detection
    deleteAccount(d.db, row.email);
    d.db.query('DELETE FROM quota WHERE account = ?').run(row.email);
  })();
  return { email: row.email, dir: row.terminal ? null : row.dir, keychain }; // `dir`: the folder deleted, if any
}
