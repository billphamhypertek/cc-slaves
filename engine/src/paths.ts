// Every on-disk location the engine touches (spec §7.8). Roots come from env so tests never touch the real home.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** One path segment taken from data (project id, lane name, session id): no separators, no dot-dirs. */
function segment(kind: string, s: string): string {
  if (!s || s === '.' || s === '..' || /[/\\\0]/.test(s)) throw new Error(`invalid ${kind} path segment: ${JSON.stringify(s)}`);
  return s;
}

export interface Paths {
  home: string;
  /** v2 §5.1 account config dirs; outside `home` because of the v1 N7 deny rules (§3.1-9). */
  accountsRoot: string;
  /** v2.4 §10.2 A11 attachment copies; outside `home` (the deny rules cover all of it). Throws when `CC_SLAVES_HOME` is
   * overridden but `CC_SLAVES_ATTACH` is not (a test that forgot the variable would sweep the PO's real folder). */
  readonly attachRoot: string;
  /** `~/.cloudflared` (spec §7.2 N7 deny rules, v2.4 §10.2 A9 blocked roots). */
  cloudflaredDir: string;
  claudeHome: string;
  claudeJson: string;
  config: string;
  caps: string;
  engineJson: string;
  engineLock: string;
  stateDb: string;
  cloudflaredYml: string;
  logsDir: string;
  mcpDir: string;
  /** cc-lanes prototype caps, imported on first run (§3.4). */
  legacyCaps: string;
  runLog(projectId: string, lane: string, n: number): string;
  mcpConfig(sessionId: string): string;
  /** v2.2 §5.5 `settings/<session>.json` (the `--settings` file of one session). */
  sessionSettings(sessionId: string): string;
  /** v2.2 §5.2 `logs/mcp-<id>.log`, the proxy log of one MCP server (id URI-encoded: ids carry `:` / `@`). */
  mcpLog(id: string): string;
}

/** Resolved on every call so a test can change env between cases. */
export function paths(): Paths {
  const env = process.env;
  const h = homedir();
  const home = env.CC_SLAVES_HOME || join(h, '.cc-slaves');
  const claudeHome = env.CLAUDE_HOME || join(h, '.claude');
  const logsDir = join(home, 'logs');
  const mcpDir = join(home, 'mcp');
  return {
    home,
    accountsRoot: env.CC_SLAVES_ACCOUNTS || join(h, '.cc-slaves-accounts'),
    get attachRoot(): string {
      if (env.CC_SLAVES_ATTACH) return env.CC_SLAVES_ATTACH;
      if (env.CC_SLAVES_HOME) throw new Error('CC_SLAVES_HOME is set but CC_SLAVES_ATTACH is not (spec v2.4 §10.2 A11)');
      return join(h, 'Library', 'Caches', 'cc-slaves', 'attachments');
    },
    cloudflaredDir: join(h, '.cloudflared'),
    claudeHome,
    claudeJson: env.CLAUDE_JSON || join(h, '.claude.json'),
    config: join(home, 'config.json'),
    caps: join(home, 'caps.json'),
    engineJson: join(home, 'engine.json'),
    engineLock: join(home, 'engine.lock'),
    stateDb: join(home, 'state.db'),
    cloudflaredYml: join(home, 'cloudflared.yml'),
    logsDir,
    mcpDir,
    legacyCaps: join(claudeHome, 'state', 'cc-lanes-caps.json'),
    runLog: (projectId, lane, n) => {
      if (!Number.isInteger(n) || n < 1) throw new Error(`invalid run number: ${n}`);
      return join(logsDir, segment('project', projectId), segment('lane', lane), `run-${n}.jsonl`);
    },
    mcpConfig: (sessionId) => join(mcpDir, `${segment('session', sessionId)}.json`),
    sessionSettings: (sessionId) => join(home, 'settings', `${segment('session', sessionId)}.json`),
    mcpLog: (id) => join(logsDir, `mcp-${segment('mcp id', encodeURIComponent(id))}.log`),
  };
}

/** mkdir -p with 0700 on the leaf; an existing leaf is re-tightened (M18). */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}

/** v2 §5.1 creates `~/.cc-slaves-accounts` 0700 and returns its path. */
export function ensureAccountsRoot(): string {
  const { accountsRoot } = paths();
  ensureDir(accountsRoot);
  return accountsRoot;
}

/** Creates `~/.cc-slaves` 0700 and returns its path. */
export function ensureHome(): string {
  const { home } = paths();
  ensureDir(home);
  rmSync(join(home, 'engine-settings.json'), { force: true }); // v2.2 §5.5: per-session `settings/<session>.json` replaced it
  return home;
}

/** Atomic 0600 write: tmp file in the same dir (created 0600, fsync) then rename over the target. */
export function writeFileSecure(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', FILE_MODE);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  chmodSync(tmp, FILE_MODE); // umask can only remove bits; keep it explicit anyway
  renameSync(tmp, path);
}
