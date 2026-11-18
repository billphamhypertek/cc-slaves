// Engine `claude auth status` check per account (spec v2 §6 A2, §3.1-4).
import { authDir, authStatus } from '../accounts/login.ts';
import { setLastAuthCheck } from '../accounts/registry.ts';
import type { AuthCheck } from '../server/views.ts';
import type { Engine } from '../engine.ts';

const nowS = () => Math.floor(Date.now() / 1000);

/** §6 A2: coalesce refreshAccounts bursts into one `auth status` round (never one per lane event). */
export function scheduleAuthCheck(eng: Engine): void {
  if (eng.stopped || eng.authTimer !== null) return;
  eng.authTimer = setTimeout(() => { eng.authTimer = null; void eng.checkAuth(); }, eng.o.authCheckDebounceMs ?? 1000);
}

/**
 * v2 §6 A2 / §3.1-4: `claude auth status` for every usable account in parallel, ≤ 5 s each, exit code only: 0 → ok,
 * ≠ 0 → out, timeout / spawn error → unknown (`?`). Writes `last_auth_check`; pushes `account` when the chip changes.
 * An account with no result is `checking` (→ `?`) while its first check runs. A known result is re-checked after
 * `authCheckEveryMs`.
 */
export async function checkAuth(eng: Engine): Promise<void> {
  const claudePath = eng.login.claudePath;
  if (eng.stopped || !claudePath) return;
  for (const k of eng.auth.keys()) if (!eng.accounts.some((a) => a.email === k)) eng.auth.delete(k);
  const every = eng.o.authCheckEveryMs ?? 300_000;
  const now = Date.now();
  const due = eng.accounts.filter((a) => {
    const r = eng.auth.get(a.email);
    return !r || (r.state !== 'checking' && every > 0 && now - r.at >= every);
  });
  const deps = { env: eng.login.env, claudePath, cmdTimeoutMs: eng.o.authCheckTimeoutMs ?? 5000, ...(eng.o.authSpawn ? { spawn: eng.o.authSpawn } : {}) };
  await Promise.all(due.map(async (a) => {
    if (eng.authBusy.has(a.email)) return;
    eng.authBusy.add(a.email);
    const before = eng.accountViews().find((v) => v.email === a.email)?.login;
    if (!eng.auth.has(a.email)) eng.auth.set(a.email, { state: 'checking', at: 0 });
    if (eng.accountViews().find((v) => v.email === a.email)?.login !== before) eng.broadcastAccount(a.email);
    let state: AuthCheck;
    try {
      const r = await authStatus(authDir(a), deps); // hf1116 T2: the terminal account runs it with CLAUDE_CONFIG_DIR unset
      state = r.code === null ? 'unknown' : r.code === 0 ? 'ok' : 'out';
    } catch { state = 'unknown'; } // spawn error
    eng.authBusy.delete(a.email);
    if (eng.stopped || !eng.accounts.some((x) => x.email === a.email)) return; // engine stopped / account removed
    const was = eng.accountViews().find((v) => v.email === a.email)?.login;
    eng.auth.set(a.email, { state, at: Date.now() });
    setLastAuthCheck(eng.db, a.email, nowS());
    if (eng.accountViews().find((v) => v.email === a.email)?.login !== was) eng.broadcastAccount(a.email);
  }));
}
