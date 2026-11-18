// Engine account login (spec v2 §6 A3–A7): the one app-wide login, boot sweep and orphan login dirs.
import type { AccountLoginView } from '../../../shared/protocol.ts';
import { act, type SystemPayload } from '../cards/store.ts';
import { LOGIN_TIMEOUT_MS, logout, readIdentity, startLogin, sweepAbandonedLogins, type LoginHandle, type LoginState, type StartOptions } from '../accounts/login.ts';
import { accountKeychainService, deleteKeychainItem, securityRun as nodeSecurityRun } from '../accounts/keychain.ts';
import { AccountError, type RemoveDeps } from '../accounts/remove.ts';
import { getAccount, listAccounts, normEmail, upsertAccount } from '../accounts/registry.ts';
import { keychainHasLogin } from '../accounts/quota.ts';
import { paths } from '../paths.ts';
import { safeDeleteAccountDir } from '../accounts/layout.ts';
import type { Engine } from '../engine.ts';

// ---------- v2 accounts: login / logout / delete (§6 A3–A8, §7) ----------

export function authDeps(eng: Engine): RemoveDeps['auth'] {
  const claudePath = eng.login.claudePath;
  if (!claudePath) throw new AccountError('no_claude', { key: 'errors.noClaude' });
  return { env: eng.login.env, claudePath, ...(eng.o.authSpawn ? { spawn: eng.o.authSpawn } : {}) };
}

/** A3 / A6: start the one app-wide login; every state change is pushed as `account_login`. */
export function startAccountLogin(eng: Engine, opts: StartOptions): AccountLoginView {
  // B-I2: `claude auth login` without CLAUDE_CONFIG_DIR rewrites the terminal's own login → only once it is gone
  const term = opts.accountEmail !== undefined ? eng.accounts.find((a) => a.email === normEmail(opts.accountEmail!) && a.terminal) : undefined;
  if (term && (eng.o.hasLogin ?? keychainHasLogin)(term)) throw new AccountError('terminal_relogin', { key: 'errors.terminalRelogin' });
  const r = startLogin({ db: eng.db, ...eng.authDeps() }, opts);
  if (!r.ok) {
    if (r.reason === 'busy') throw new AccountError('login_busy', r.email ? { key: 'errors.loginBusyEmail', params: { email: r.email } } : { key: 'errors.loginBusy' });
    throw new AccountError('no_account', { key: 'errors.noAccountRelogin', params: { email: String(r.email) } });
  }
  const h = r.login;
  let deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let url: string | null = null, codeUrl: string | null = null;
  const push = (s: LoginState) => {
    if (s.kind === 'waiting_browser') { url = s.url; codeUrl = s.codeUrl ?? null; }
    if (s.kind === 'email_mismatch') deadline = Date.now() + LOGIN_TIMEOUT_MS; // A7f: the clock restarts for the choice
    eng.loginView = { ...loginView(h, s, url, deadline), codeUrl };
    eng.hub.broadcast({ type: 'account_login', login: eng.loginView });
  };
  h.onState(push);
  push(h.state());
  void h.done.then((t) => {
    if (t.kind !== 'done' || eng.stopped) return;
    eng.auth.set(t.email, { state: 'ok', at: Date.now() }); // final-rereview NEW-1: a login just proved it; no stale ✗ / ? after relogin
    // A6: the F16 card closes, waiting lanes are re-checked; A3: the new account becomes usable.
    for (const c of eng.cards.list({ status: 'open' }).filter((x) => x.kind === 'logged_out' && (x.payload as SystemPayload).key === t.email)) {
      eng.cards.resolveSystem(c.id);
    }
    eng.refreshAccounts();
    eng.accountChanged(t.email);
  });
  return eng.loginView!;
}

/** v2 §6 boot sweep: leftover login groups killed, identity-less orphans safe-deleted, logged-in ones → a card each. */
export async function sweepLogins(eng: Engine): Promise<void> {
  try {
    const r = await sweepAbandonedLogins({
      db: eng.db, log: eng.log, ...(eng.login.claudePath ? { auth: eng.authDeps() } : {}),
      securityRun: eng.o.securityRun ?? nodeSecurityRun,
    });
    for (const d of r.removed) eng.log(`đăng nhập dở dang: đã gỡ ${d}`);
    for (const { dir, email } of r.orphans) {
      if (eng.cards.findOpenSystem('account_orphan', dir)) continue;
      eng.cards.createSystem({
        kind: 'account_orphan', key: dir, titleKey: 'cards.accountOrphan', params: { email },
        bodyKey: 'cardText.body.orphan', bodyParams: { dir, email },
        actions: [act('cardText.act.adopt', 'account_orphan_adopt', { dir }), act('cardText.act.delete', 'account_orphan_delete', { dir })],
      });
    }
  } catch (e) { eng.log(`quét thư mục đăng nhập dở dang lỗi: ${(e as Error).message}`); }
}

/** The orphan dir of an `account_orphan` card, re-checked now: under the accounts root, no row on it, still logged in. */
export function orphanAt(eng: Engine, dir: string): { dir: string; email: string; who: NonNullable<ReturnType<typeof readIdentity>> } {
  const root = paths().accountsRoot.replace(/\/+$/, '');
  if (!/^[0-9a-f]{12}$/.test(dir.slice(root.length + 1)) || !dir.startsWith(`${root}/`)) throw new AccountError('bad_input', { key: 'errors.notAccountDir', params: { dir } });
  if (listAccounts(eng.db).some((a) => a.dir === dir)) throw new AccountError('bad_input', { key: 'errors.dirOwned', params: { dir } });
  const who = readIdentity(dir);
  if (!who) throw new AccountError('no_account', { key: 'errors.dirLoggedOut', params: { dir } });
  return { dir, email: who.email.trim().toLowerCase(), who };
}

/** §6 "Account mồ côi" → "Thêm lại": the row comes back with that dir + its identity (refused if the email has a dir). */
export function adoptOrphan(eng: Engine, dir: string): void {
  const o = eng.orphanAt(dir);
  if (getAccount(eng.db, o.email)?.dir) throw new AccountError('duplicate', { key: 'errors.orphanDuplicate', params: { email: o.email } });
  upsertAccount(eng.db, {
    email: o.email, id: dir.split('/').pop()!, dir, accountUuid: o.who.accountUuid, orgUuid: o.who.orgUuid, status: null,
    ...(o.who.tier ? { tier: o.who.tier } : {}), ...(o.who.plan ? { plan: o.who.plan } : {}),
  });
  eng.log(`account mồ côi ${o.email}: đã thêm lại (${dir})`);
  eng.refreshAccounts();
  eng.accountChanged(o.email);
}

/** §6 "Account mồ côi" → "Xoá": the §7 safe-delete steps (logout → Keychain item → guarded dir delete). */
export async function deleteOrphan(eng: Engine, dir: string): Promise<void> {
  const o = eng.orphanAt(dir);
  if (eng.login.claudePath) await logout(dir, eng.authDeps()).catch(() => null);
  const k = deleteKeychainItem(accountKeychainService(dir), eng.o.securityRun ?? nodeSecurityRun);
  if (k.result !== 'gone') eng.log(`xoá mục keychain của ${o.email}: ${k.result}`);
  safeDeleteAccountDir(dir, paths().accountsRoot);
  eng.log(`account mồ côi ${o.email}: đã xoá ${dir}`);
}

function loginView(h: LoginHandle, s: LoginState, url: string | null, deadline: number): AccountLoginView {
  return {
    id: h.id, mode: h.mode, email: h.email, state: s.kind, url, deadline,
    error: s.kind === 'failed' ? { reason: s.reason, detail: s.detail } : null,
    realEmail: s.kind === 'email_mismatch' || s.kind === 'done' ? s.email : null,
  };
}
