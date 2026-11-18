// Files the engine hands to every session (spec §7.2 N7, §7.3, v2.2 §5.1 / §5.5): per-session settings + MCP config.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readdirSync, rmSync } from 'node:fs';
import { DEFAULT_KEYCHAIN_SERVICE } from '../accounts/registry.ts';
import { KEYCHAIN_SERVICE, MCP_KEYCHAIN_SERVICE } from '../keychain.ts';
import { sessionMcp, type CatalogEntry, type SessionGraph } from '../mcp/catalog.ts';
import { paths, writeFileSecure } from '../paths.ts';
import type { CompiledStep } from '../workflow/compile.ts';
import { removeSkillDeny, skillSettings, writeSkillDeny } from './skills.ts';

const DENY_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob'] as const;

/** Claude Code path-rule form: `~/x` under home, `//abs` otherwise. */
function rulePath(dir: string): string {
  const h = homedir();
  return dir === h || dir.startsWith(`${h}/`) ? `~${dir.slice(h.length)}` : `/${dir}`;
}

const base = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1);

/**
 * §7.2 N7 deny rules on the engine home and cloudflared dir. Bash rules match the command TEXT, not the resolved path
 * (residual risk: spec §12): the full path, the `~/…` form when under home, and the bare dir name only when it is a
 * dot-dir (`.cc-slaves`, `.cloudflared`) — a short plain name such as `h` would deny almost every command (MINOR-4).
 */
export function denyRules(engineHome: string, cloudflaredDir: string, accountsRoot?: string): string[] {
  const out: string[] = [];
  for (const dir of [engineHome, cloudflaredDir]) {
    for (const t of DENY_TOOLS) out.push(`${t}(${rulePath(dir)}/**)`);
    out.push(`Bash(*${dir}*)`);
    const rel = rulePath(dir);
    if (rel.startsWith('~/')) out.push(`Bash(*${rel}*)`);
    if (base(dir).startsWith('.') && base(dir).length > 1) out.push(`Bash(*${base(dir)}*)`);
  }
  // I3: the engine WS token lives in the Keychain; `security` reads it without a prompt. Text match only (spec §12).
  // v2.2 §5.3 A2: the MCP OAuth records live in the Keychain too (`cc-slaves-mcp`).
  out.push(`Bash(*${KEYCHAIN_SERVICE}*)`, `Bash(*${MCP_KEYCHAIN_SERVICE}*)`, 'Bash(*find-generic-password*)');
  // v2 §7: each account's own login file, the Keychain delete verb and Claude Code's credential items. Only
  // `.claude.json` — never the root or `<id>/projects|plans/` (sessions write memory / plans there, §3.2 SA2).
  if (accountsRoot) {
    for (const t of ['Read', 'Edit', 'Write'] as const) out.push(`${t}(${rulePath(accountsRoot)}/*/.claude.json)`);
    out.push(`Bash(*${base(accountsRoot)}*/.claude.json*)`);
  }
  out.push('Bash(*delete-generic-password*)', `Bash(*${DEFAULT_KEYCHAIN_SERVICE}*)`);
  return out;
}

export type TokenGen = () => string;
const randomToken: TokenGen = () => randomBytes(32).toString('base64url');

/** v2.2 §5.5 what this session turns off: skill names (`skillOverrides`) and plugin keys (`enabledPlugins`). */
interface LanesOff { skills: readonly string[]; plugins: readonly string[] }

export interface SessionSetup {
  port: number;
  projectId: string;
  /** v2.2 §5.1 the engine's MCP catalog (none → only `cc_slaves`). */
  catalog?: readonly CatalogEntry[];
  off?: LanesOff;
  /** v2.5 §5.7 the graph of this session (engine `graphSetup`; absent = the module does not manage the tool). */
  graph?: SessionGraph;
  /** v2.9 §6.1 the step the session is pinned to: its skill block (absent = none). */
  step?: Pick<CompiledStep, 'deny' | 'gate'>;
}

/** `graph` = the MCP file has the engine's graph entry (v2.5 §5.7). */
export interface SessionFiles { mcpPath: string; settingsPath: string; token: string; mcpIds: ReadonlySet<string>; graph: boolean }

/** v2.5 §5.4 what a spawn hands the engine beside its token (`onMcpToken`): the file's facts + the session's cwd. */
export type SessionSpawn = Pick<SessionFiles, 'token' | 'mcpIds' | 'graph'> & { cwd: string };

/**
 * Writes the two files of one session (both 0600): `mcp/<session>.json` = the catalog set of the project + the engine's
 * `cc_slaves` with a fresh bearer token (v2.2 §5.1, §7.3), and `settings/<session>.json` = the §7.2 N7 deny rules +
 * the v2.9 §10.1 skill block of the session's step + the §5.5 lane switches (one file per session, not a shared one), and the
 * step's `skill-deny/<session>.tsv` the hook reads.
 */
export function writeSessionFiles(sessionId: string, s: SessionSetup, token: TokenGen = randomToken): SessionFiles {
  const t = token();
  const mcp = sessionMcp(s.catalog ?? [], s.projectId, s.port, t, s.graph ?? null);
  const mcpPath = paths().mcpConfig(sessionId);
  writeFileSecure(mcpPath, `${JSON.stringify({ mcpServers: mcp.servers }, null, 2)}\n`);
  const skill = s.step ? skillSettings(sessionId, s.step) : null;
  const settings: Record<string, unknown> = {
    permissions: { deny: [...denyRules(paths().home, paths().cloudflaredDir, paths().accountsRoot), ...skill?.deny ?? []] },
  };
  if (skill) settings.hooks = skill.hooks;
  if (s.step) writeSkillDeny(sessionId, s.step);
  if (s.off?.skills.length) settings.skillOverrides = Object.fromEntries(s.off.skills.map((n) => [n, 'off']));
  if (s.off?.plugins.length) settings.enabledPlugins = Object.fromEntries(s.off.plugins.map((k) => [k, false]));
  const settingsPath = paths().sessionSettings(sessionId);
  writeFileSecure(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { mcpPath, settingsPath, token: t, mcpIds: mcp.mcpIds, graph: s.graph?.on === true };
}

/** A session ended (lane done, orchestrator replaced): its MCP, settings and skill-deny files go (MINOR-3; the token is revoked too). */
export function removeSessionFiles(sessionId: string): void {
  rmSync(paths().mcpConfig(sessionId), { force: true });
  rmSync(paths().sessionSettings(sessionId), { force: true });
  removeSkillDeny(sessionId);
}

/**
 * §8.4 next run number for `logs/<project>/<lane>/run-N.jsonl`: one past the highest of `current` (in memory / the
 * run table) and the files already on disk, so a new engine boot never appends into an older run's log.
 */
export function nextRunN(projectId: string, lane: string, current: number): number {
  let max = current;
  try {
    for (const f of readdirSync(dirname(paths().runLog(projectId, lane, 1)))) {
      const m = /^run-(\d+)\.jsonl$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* no log dir yet */ }
  return max + 1;
}
