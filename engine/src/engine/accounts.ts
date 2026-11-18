// Engine accounts (spec §6.16, v2 §6–§7): registry re-read, account views, sign-out / delete, the cutover card.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountView } from '../../../shared/protocol.ts';
import { keychainHasLogin } from '../accounts/quota.ts';
import { act, type Card, type SystemPayload } from '../cards/store.ts';
import { deleteAccountSafely, LOGGED_OUT_STATUS, logoutAccount, type DeleteOutcome, type RemoveDeps } from '../accounts/remove.ts';
import { DEFAULT_KEYCHAIN_SERVICE, listAccounts, normEmail, registryCaps, registryLaneConfig, usableAccounts } from '../accounts/registry.ts';
import { syncTerminal } from '../accounts/terminal.ts';
import { paths } from '../paths.ts';
import { resolveCaps } from '../config.ts';
import type { LaneState } from '../db.ts';
import { accountView } from '../server/views.ts';
import type { Engine } from '../engine.ts';

const OCCUPY: readonly LaneState[] = ['starting', 'running', 'idle', 'waiting_po', 'switching', 'draining'];
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * §6.16 unusable accounts: an open logged_out card (auth error, until the login is back), no Keychain login (F16), or
 * signed out from cc-slaves (v2 A8L registry status, until a re-login).
 */
export function loggedOut(eng: Engine): Set<string> {
  const cards = eng.cards.list({ status: 'open' }).filter((c) => c.kind === 'logged_out').map((c) => (c.payload as SystemPayload).key ?? '');
  const signedOut = listAccounts(eng.db).filter((a) => a.dir !== null && a.status === LOGGED_OUT_STATUS).map((a) => a.email);
  return new Set([...cards, ...eng.noLogin, ...signedOut]);
}

export function removeDeps(eng: Engine): RemoveDeps {
  return {
    db: eng.db, auth: eng.authDeps(), ...(eng.o.securityRun ? { securityRun: eng.o.securityRun } : {}), log: eng.log,
    lanesOn: (email) => eng.lanes.listAll().filter((v) => v.account === email && OCCUPY.includes(v.state)).map((v) => v.name),
    isOrchestrator: (email) => resolveCaps(eng.caps, email).role === 'orchestrator'
      || eng.projectRows().some((p) => p.orchestrator_account === email) || eng.orchestrators.onAccount(email),
    onLoggedOut: async (email) => {
      eng.lanes.accountLoggedOut(email);
      await eng.orchestrators.accountLoggedOut(email);
      eng.accountChanged(email);
    },
  };
}

/** A8L: sign out; the row stays (✗), lanes / orchestrator on it switch (F16, v1 §7.5). */
export async function signOutAccount(eng: Engine, email: string): Promise<AccountView | null> {
  await logoutAccount(email, eng.removeDeps());
  return eng.accountViews().find((a) => a.email === email.trim().toLowerCase()) ?? null;
}

/** A8: §7 safe delete (refused while lanes run / for the orchestrator); every client gets `account_removed`. */
export async function deleteAccount(eng: Engine, email: string): Promise<DeleteOutcome> {
  const out = await deleteAccountSafely(email, eng.removeDeps());
  eng.refreshAccounts();
  eng.hub.broadcast({ type: 'account_removed', email: out.email });
  return out;
}

export function readNoLogin(eng: Engine): Set<string> {
  const has = eng.o.hasLogin ?? keychainHasLogin;
  return new Set(eng.accounts.filter((a) => !has(a)).map((a) => a.email));
}

export function accountViews(eng: Engine): AccountView[] {
  const out = eng.loggedOut();
  const live = eng.lanes.listAll();
  const now = nowS();
  return eng.accounts.map((a) => {
    const sc = eng.sharedCfg.get(a.email);
    return accountView({
      account: a, caps: eng.caps, quota: eng.tracker.get(a.email), now, loggedOut: out.has(a.email),
      lanes: live.filter((v) => v.account === a.email && OCCUPY.includes(v.state)).length,
      sharedCfg: sc ? { ok: sc.ok, issues: sc.issues } : { ok: true, issues: [] },
      auth: eng.auth.get(a.email)?.state ?? null,
      track: eng.tracker.view(a, eng.config.quotaReading), // v2.7.1 §7.3
    });
  });
}

export function broadcastAccount(eng: Engine, email: string): void {
  const v = eng.accountViews().find((a) => a.email === email);
  if (v) eng.hub.broadcast({ type: 'account', account: v });
}

/** QuotaTracker numbers / status changed (§3.4 I3): re-check sessions, push the view, all-full episode (§8.3). */
export function accountChanged(eng: Engine, email: string): void {
  if (eng.stopped) return;
  eng.lanes.accountChanged(email);
  eng.orchestrators.accountChanged(email);
  eng.broadcastAccount(email);
  const views = eng.accountViews();
  if (views.length) void eng.notifier.accountsFull(views.every((v) => v.full));
}

/**
 * v2 §7: usable accounts (rows with `dir`), roles/caps and lane limits, all from the account table. Before the import
 * (a broken caps.json at the first v2 boot) `laneCaps` / `noNewLanes` stay config.json's (G1 IMPORTANT-1).
 */
export function readRegistry(eng: Engine): string[] {
  const { lost } = syncTerminalAccount(eng);
  eng.accounts = usableAccounts(eng.db);
  eng.caps = registryCaps(eng.db);
  if (eng.registryImported()) eng.config = { ...eng.config, ...registryLaneConfig(eng.db) };
  return lost;
}

/** hf1116 T1: the terminal login (`~/.claude.json` identity + default Keychain item) as a normal account row. */
function syncTerminalAccount(eng: Engine): ReturnType<typeof syncTerminal> {
  const { claudeHome, claudeJson } = paths();
  const has = eng.o.hasLogin ?? keychainHasLogin;
  return syncTerminal(eng.db, {
    claudeHome, claudeJson,
    hasLogin: (a) => has({ email: a.email, id: null, configDir: claudeHome, keychainService: DEFAULT_KEYCHAIN_SERVICE, planTier: null, terminal: true }),
  });
}

/** Re-read the registry: new / removed accounts, and logged_out cards whose account logged in again. */
export function refreshAccounts(eng: Engine): void {
  const before = JSON.stringify(eng.accounts);
  const known = new Set(eng.accounts.map((a) => a.email));
  const lost = eng.readRegistry();
  eng.checkAllSharedCfg(); // §5.5: a new account, or Claude Code made a real dir inside one since the last check
  if (JSON.stringify(eng.accounts) !== before) for (const v of eng.accountViews()) eng.hub.broadcast({ type: 'account', account: v });
  // §7.1-3: an account that just became usable (its row got `dir`) → lanes waiting (`no_account`) pick again.
  const added = eng.accounts.filter((a) => !known.has(a.email)).map((a) => a.email);
  const outBefore = eng.loggedOut();
  eng.noLogin = eng.readNoLogin();
  for (const c of eng.cards.list({ status: 'open' }).filter((x) => x.kind === 'logged_out')) {
    if (eng.loginRenewed(c)) eng.cards.resolveSystem(c.id);
  }
  // A login lost or back: waiting lanes / orchestrators re-pick, the account view updates.
  const after = eng.loggedOut();
  const changed = [...new Set([...outBefore, ...after])].filter((e) => outBefore.has(e) !== after.has(e));
  for (const e of new Set([...changed, ...added])) eng.accountChanged(e);
  // hf1116 T1: the terminal now logs in another email → sessions on the old one leave it (the A8L logout path)
  for (const e of lost) void eng.removeDeps().onLoggedOut(e);
  eng.syncCutover();
  eng.scheduleAuthCheck();
}

/**
 * v2 §7.1-3 I3c: no usable v2 account and ≥ 1 lane waiting `no_account` → one global "Chưa có account v2 · {n} lane
 * đang chờ" card (n kept current); it resolves itself once an account is usable or no lane waits for one.
 */
export function syncCutover(eng: Engine): void {
  if (eng.stopped || !eng.cards) return; // lane events can fire before the card store exists (constructor order)
  // IMPORTANT-2: an open F16 card for an email with no usable row (`dir`) — every v1 card after the upgrade — has a
  // button that can only fail (`no_account`); the cutover card's "Thêm account" covers it.
  const usable = new Set(eng.accounts.map((a) => a.email));
  for (const c of eng.cards.list({ status: 'open' })) {
    const k = c.kind === 'logged_out' ? (c.payload as SystemPayload).key : null;
    if (k && !usable.has(normEmail(k))) eng.cards.resolveSystem(c.id);
  }
  const n = eng.accounts.length > 0 ? 0
    : eng.lanes.listAll().filter((v) => v.state === 'waiting_quota' && v.waitReason === 'no_account').length;
  const open = eng.cards.findOpenSystem('cutover', CUTOVER_KEY);
  if (n === 0) { if (open) eng.cards.resolveSystem(open.id); return; }
  const actions = [act('cardText.act.addAccount', 'account_add')]; // the web opens A3; the card stays open
  if (open) eng.cards.updateSystem(open.id, { body: null, actions, params: { n } });
  else eng.cards.createSystem({ kind: 'cutover', key: CUTOVER_KEY, titleKey: 'cards.cutover', params: { n }, actions });
}

/** The account's login file was rewritten after the card (a re-login writes `<dir>/.claude.json`). */
export function loginRenewed(eng: Engine, c: Card): boolean {
  const email = (c.payload as SystemPayload).key;
  const a = eng.accounts.find((x) => x.email === email);
  if (!a) return false;
  const file = a.terminal ? paths().claudeJson : join(a.configDir, '.claude.json');
  let touched = false;
  try { touched = Math.floor(statSync(file).mtimeMs / 1000) > c.createdAt; } catch { /* missing */ }
  // `claude` rewrites .claude.json on every start, even logged out (smoke g6) → the Keychain must hold a login too
  return touched && (eng.o.hasLogin ?? keychainHasLogin)(a);
}

/** v2 §7.1-3 the single cutover card's key. */
const CUTOVER_KEY = 'cutover';
