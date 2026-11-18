// hotfix 2026-11-16 (b) Git in onboarding (docs/ref/hf1116-ux.md): the pure model of the optional Git block (wizard step
// 1, Cài đặt › Git, the Git tab when git is missing / blocked). Nothing here gates "Tiếp" or `SetupStatus.done`.
import type { GitSetup, SetupStatus } from '../../../shared/protocol.ts';
import type { Tr } from '../../../shared/i18n/core.ts';

/** G3: after "Cài Command Line Tools" the row polls `setup_check` every 5 s, for at most 30 min (or until git is ok). */
export const INSTALL_POLL_MS = 5_000;
export const INSTALL_MAX_MS = 30 * 60_000;
export const LICENSE_CMD = 'sudo xcodebuild -license accept';

export type GitRow = 'ok' | 'installing' | 'missing' | 'license' | 'error';

/** The Git row: an install started `installAt` (ms) shows "Đang cài…" until git works or 30 min pass. */
export function gitRow(g: GitSetup, installAt: number | null, now: number): GitRow {
  if (g.state === 'ok') return 'ok';
  if (installAt !== null && now - installAt < INSTALL_MAX_MS && g.state === 'missing') return 'installing';
  return g.state;
}

export const polling = (g: GitSetup, installAt: number | null, now: number) => gitRow(g, installAt, now) === 'installing';

export const identityOk = (g: GitSetup) => !!g.identity.name && !!g.identity.email;

/** All three rows ✓ → the block folds to one line (progressive disclosure). */
export const gitAllOk = (g: GitSetup) => g.state === 'ok' && identityOk(g) && g.gh === 'ok';

/** "Git sẵn sàng · 2.54.0 · Bill Pham · GitHub octo" (no user known → the line without it). */
export function readyLine(tr: Tr, g: GitSetup): string {
  const p = { version: g.version ?? '', name: g.identity.name ?? '', user: g.ghUser ?? '' };
  return g.ghUser ? tr('gitSetup.ready', p) : tr('gitSetup.readyNoGh', p);
}

/** Sensible default (step budget: email prefilled): the git identity, else the PO email, else the first logged-in account. */
export function identityPrefill(s: Pick<SetupStatus, 'git' | 'poEmail' | 'accounts'>): { name: string; email: string } {
  const email = s.git.identity.email ?? s.poEmail ?? s.accounts.find(a => a.loggedIn)?.email ?? '';
  return { name: s.git.identity.name ?? '', email };
}
