// hf-bg2 (PO 18/11): one LaunchAgent, one Login Items entry. The engine job supervises the menu bar as its child: start
// it, restart it after an unexpected exit, SIGTERM it on shutdown. It stays in the engine's process group, so launchd's
// bootout / SIGKILL of the job also ends it (measured 18/11) and an engine crash never leaves a second menu bar behind.
// "Thoát hẳn" leaves the group itself (menubar `start_quit`) so it outlives the engine stop it is reporting.
import { dirname, join } from 'node:path';

/** Restart delay: the old menubar agent's launchd ThrottleInterval. */
export const MENUBAR_BACKOFF_MS = 5000;

/** `CC_SLAVES_MENUBAR_BIN`, else `cc-slaves-menubar` next to the engine binary (`Contents/Resources` in the bundle). */
export function menubarBin(env: Record<string, string | undefined>, execPath: string): string {
  return env.CC_SLAVES_MENUBAR_BIN || join(dirname(execPath), 'cc-slaves-menubar');
}

export interface MenubarSupervisor {
  /** SIGTERM the child, never restart it again. No SIGKILL: a menu bar in "Thoát hẳn" ignores SIGTERM on purpose. */
  stop(): void;
}

export function superviseMenubar(opts: { bin: string; log: (line: string) => void; backoffMs?: number }): MenubarSupervisor {
  const backoff = opts.backoffMs ?? MENUBAR_BACKOFF_MS;
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const start = (): void => {
    if (stopped) return; // a restart that was waiting when stop() came
    try {
      proc = Bun.spawn([opts.bin], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
    } catch (e) {
      opts.log(`menubar không chạy được: ${(e as Error).message}`);
      setTimeout(start, backoff);
      return;
    }
    void proc.exited.then((code) => {
      if (stopped) return;
      opts.log(`menubar thoát (${code}) — chạy lại sau ${backoff} ms`);
      setTimeout(start, backoff);
    });
  };
  start();
  return {
    stop() {
      stopped = true;
      proc?.kill('SIGTERM');
    },
  };
}
