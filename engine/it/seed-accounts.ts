// Test-only (IT + e2e/engine-entry.ts): make emails usable v2 accounts the way a real install ends up — the §7.1 import
// first (caps.json / config.json land in the account table exactly as at a first boot), then each email gets a row with
// `dir` = `<CC_SLAVES_ACCOUNTS>/<12-hex id>` holding a `.claude.json` with its `oauthAccount`. Idempotent: an email whose
// row already has `dir` keeps it (engine restarts in e2e re-run this).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPS_IMPORTED_KEY, getAccount, importAtBoot, newAccountId, upsertAccount, usableAccounts, type Account } from '../src/accounts/registry.ts';
import { loadCaps, loadConfig } from '../src/config.ts';
import { getMeta, openDb, type Db } from '../src/db.ts';
import { ensureHome, paths } from '../src/paths.ts';

export function seedAccounts(emails: readonly string[], o: { db?: Db; tier?: string } = {}): Account[] {
  ensureHome();
  const db = o.db ?? openDb(paths().stateDb);
  try {
    if (getMeta(db, CAPS_IMPORTED_KEY) === null) importAtBoot(db, loadCaps(), loadConfig());
    const root = paths().accountsRoot;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const email of emails) {
      if (getAccount(db, email)?.dir) continue;
      const id = newAccountId();
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({
        oauthAccount: { emailAddress: email, ...(o.tier ? { organizationRateLimitTier: o.tier } : {}) },
      }));
      upsertAccount(db, { email, id, dir, ...(o.tier ? { tier: o.tier } : {}) });
    }
    return usableAccounts(db);
  } finally {
    if (!o.db) db.close();
  }
}
