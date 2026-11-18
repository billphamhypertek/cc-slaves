// hf1116 T1 (PO 2026-11-16): the login Claude Code already has in the terminal (`~/.claude`, identity in `~/.claude.json`,
// the default Keychain item) is listed as a normal account. One email = one account (D25): an email with its own
// cc-slaves dir keeps that row. The PO's "Xoá" on it is remembered (`terminalDismissed`) so it is not added back.
import type { Db } from '../db.ts';
import { readIdentityFile } from './login.ts';
import { DEFAULT_KEYCHAIN_SERVICE, getAccount, listAccounts, normEmail, terminalDismissed, upsertAccount } from './registry.ts';

export interface TerminalDeps {
  claudeHome: string;
  /** The home-level `.claude.json` (`paths().claudeJson`), where the default login keeps `oauthAccount`. */
  claudeJson: string;
  /** Keychain check of the default item; asked only when the identity file names an email. */
  hasLogin(a: { email: string; keychainService: string }): boolean;
}

/** `added`: the email that just became the terminal account; `lost`: terminal rows whose login the terminal replaced. */
export interface TerminalSync { added: string | null; lost: string[] }

export function syncTerminal(db: Db, d: TerminalDeps): TerminalSync {
  const who = readIdentityFile(d.claudeJson);
  const out: TerminalSync = { added: null, lost: [] };
  if (!who) return out; // no identity (or unreadable): keep what is there; a lost login shows through the Keychain check
  const email = normEmail(who.email);
  db.transaction(() => {
    for (const r of listAccounts(db)) {
      if (!r.terminal || r.email === email) continue;
      upsertAccount(db, { email: r.email, dir: null, terminal: false }); // like a v1 row: no usable dir until a login
      out.lost.push(r.email);
    }
    const row = getAccount(db, email);
    if (row?.terminal && row.dir === d.claudeHome) return;
    if (row?.dir && !row.terminal) return; // D25: its own cc-slaves dir wins
    if (terminalDismissed(db).has(email) || !d.hasLogin({ email, keychainService: DEFAULT_KEYCHAIN_SERVICE })) return;
    // identity fields only: role / caps / lanes stay NULL = the defaults a new login gets (a v1 row keeps its own)
    upsertAccount(db, {
      email, dir: d.claudeHome, terminal: true, accountUuid: who.accountUuid, orgUuid: who.orgUuid,
      ...(who.tier ? { tier: who.tier } : {}), ...(who.plan ? { plan: who.plan } : {}),
    });
    out.added = email;
  })();
  return out;
}
