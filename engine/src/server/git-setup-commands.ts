// hotfix 2026-11-16 (b) Git setup commands (Mac only: none is in REMOTE_ALLOWED). Every item is optional; each one ends
// with a fresh `setup` broadcast, so the wizard / Settings / Git tab rows follow the engine.
import type { GhLoginView } from '../../../shared/protocol.ts';
import type { Engine } from '../engine.ts';
import { startGhLogin, type GhLoginDeps, type GhLoginHandle } from '../setup/gh-login.ts';
import { gitInstall, setIdentity } from '../setup/git-setup.ts';
import { CommandError, type Handlers } from './router.ts';

type GitSetupCmd = 'git_install' | 'git_identity_set' | 'gh_login' | 'gh_login_cancel';

/** `gh`: the process seam for tests (spawn / kill / grace); production passes nothing. */
export function gitSetupHandlers(e: Engine, gh: Pick<GhLoginDeps, 'spawn' | 'kill' | 'graceMs'> = {}): Pick<Handlers, GitSetupCmd> {
  return {
    git_install: () => gitInstall(e.gitExec),
    git_identity_set: async (c) => {
      if (typeof c.name !== 'string' || typeof c.email !== 'string') throw new CommandError('bad_input', { key: 'errors.gitIdentityEmail' });
      await setIdentity({ exec: e.gitExec, env: e.login.env }, c.name, c.email);
      return e.runSetupCheck();
    },
    gh_login: (): GhLoginView => {
      if (!e.ghPath) throw new CommandError('gh_missing', { key: 'errors.ghMissing' });
      const cur = e.ghLogin;
      if (cur && cur.view().state !== 'failed') return cur.view(); // one login at a time
      let h: GhLoginHandle | null = null;
      h = startGhLogin({
        ...gh, ghPath: e.ghPath, env: e.login.env,
        onChange: (v, ok) => {
          if (e.ghLogin !== h) return; // a cancelled / replaced login reports nothing
          if (v === null) e.ghLogin = null;
          e.patchGhLogin(v);
          if (ok) void e.runSetupCheck().catch(() => {});
        },
      });
      e.ghLogin = h;
      e.patchGhLogin(h.view());
      return h.view();
    },
    gh_login_cancel: async () => {
      const h = e.ghLogin;
      e.ghLogin = null;
      e.patchGhLogin(null);
      await h?.cancel();
    },
  };
}
