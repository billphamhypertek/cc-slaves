// Engine process boot (spec §7.1): single instance via engine.lock, per-start localhost token in
// the Keychain, Engine (composition root) on 127.0.0.1:47800, engine.json (pid, port, version — no token), graceful
// SIGTERM. Under launchd (KeepAlive) `engine_shutdown` boots the job out, otherwise launchd would restart it.
// `main.ts` runs it with the real Keychain; the e2e entry (`e2e/engine-entry.ts`) injects fakes for the outside world.
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Engine, type EngineOptions } from './engine.ts';
import { openUrl } from './accounts/browser.ts';
import { bootToken, securityCli, storeToken } from './keychain.ts';
import { acquireLock, writeEngineJson } from './lock.ts';
import { ensureHome, paths } from './paths.ts';
import { menubarBin, superviseMenubar, type MenubarSupervisor } from './menubar.ts';
import { MAC_PORT } from './server/http.ts';
import { ENGINE_VERSION } from './version.ts';

// §8.4: no renice — every spawned `claude` would inherit it and a non-root process cannot lower it back.

function staticDir(): string | null {
  if (process.env.CC_SLAVES_WEB_DIR) return process.env.CC_SLAVES_WEB_DIR;
  const dev = resolve(import.meta.dir, '../../web/dist');
  if (existsSync(dev)) return dev;
  const packaged = join(dirname(process.execPath), 'web');
  return existsSync(packaged) ? packaged : null;
}

export interface BootOverrides extends Partial<Omit<EngineOptions, 'version' | 'port' | 'token' | 'onShutdownRequest'>> {
  /** Default: the Keychain item via /usr/bin/security. */
  storeToken?: (token: string) => Promise<void>;
}

export async function runEngine(over: BootOverrides = {}): Promise<void> {
  ensureHome();
  const p = paths();
  const lock = acquireLock(p.engineLock);
  if (!lock.ok) {
    console.error(`cc-slaves engine đang chạy (pid ${lock.pid}) — thoát`);
    process.exit(3);
  }

  const { token, store } = bootToken();
  try {
    if (store || over.storeToken) await (over.storeToken ?? ((t: string) => Promise.resolve(storeToken(t))))(token);
  } catch (e) {
    console.error((e as Error).message);
    lock.release();
    process.exit(4);
  }

  let closing = false;
  let engine: Engine | null = null;
  let menubar: MenubarSupervisor | null = null;
  const shutdown = async (why: string, bootout = false): Promise<void> => {
    if (closing) return;
    closing = true;
    console.error(`cc-slaves engine dừng (${why})`);
    try { await engine?.stop(); } catch (e) { console.error(`dừng lỗi: ${(e as Error).message}`); }
    menubar?.stop();
    rmSync(p.engineJson, { force: true });
    lock.release();
    const label = process.env.CC_SLAVES_LAUNCHD_LABEL;
    if (bootout && label && typeof process.getuid === 'function') {
      // bootout sends SIGTERM to this job; we are already stopped, so just exit after it returns.
      Bun.spawn(['launchctl', 'bootout', `gui/${process.getuid()}/${label}`], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const port = process.env.CC_SLAVES_PORT !== undefined ? Number(process.env.CC_SLAVES_PORT) : MAC_PORT;
  const { storeToken: _st, ...opts } = over;
  try {
    engine = await Engine.start({
      // v2.2 §5.3 the real Keychain + default browser for MCP logins (the e2e entry overrides both)
      staticDir: staticDir(), mcpKeychain: securityCli(), openUrl: (u: string) => void openUrl(u, opts.browserExec),
      attachSweepMs: 3_600_000, // v2.4 §10.2 hourly
      ...opts, version: ENGINE_VERSION, port, token,
      onShutdownRequest: () => void shutdown('engine_shutdown', true),
    });
  } catch (e) {
    console.error(`cc-slaves engine không khởi động được: ${(e as Error).message}`);
    lock.release();
    process.exit(1);
  }
  writeEngineJson(p.engineJson, { pid: process.pid, port: engine.port, version: ENGINE_VERSION });
  // hf-bg2: only the app's launchd job owns the menu bar (dev runs, smoke and e2e start none).
  if (process.env.CC_SLAVES_LAUNCHD_LABEL) {
    const bin = menubarBin(process.env, process.execPath);
    if (existsSync(bin)) menubar = superviseMenubar({ bin, log: (l) => console.error(l) });
    else console.error(`không thấy menubar: ${bin}`);
  }
  console.error(`cc-slaves engine ${ENGINE_VERSION} trên 127.0.0.1:${engine.port}`);
}
