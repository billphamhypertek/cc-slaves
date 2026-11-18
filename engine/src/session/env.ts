// Environment for every child `claude` (spec §3.1 I11, §7.1 N9, §7.3). A GUI/launchd app only has the system PATH,
// so the engine reads the login shell's env once (`$SHELL -lic env`, 10 s cap) and remembers the absolute `claude`.
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One shell word for `sh -c` (hook commands, pasteable commands, pty input): `'…'` with every `'` escaped. */
export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export type Env = Record<string, string>;
type ShellResult = { ok: true; stdout: string } | { ok: false; stdout: string; error: string };
export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<ShellResult>;

export interface LoginEnv {
  env: Env;
  /** Absolute path of `claude` on env.PATH; null when not found (F1 shows it). */
  claudePath: string | null;
  /** true → fallback PATH in use; F13 shows "không lấy được môi trường shell". */
  shellFailed: boolean;
  reason: string | null;
}

const SHELL_TIMEOUT_MS = 10_000;
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const defaultShellRunner: ShellRunner = async (shell, args, timeoutMs) => {
  let proc;
  try {
    proc = Bun.spawn([shell, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  } catch (e) {
    return { ok: false, stdout: '', error: (e as Error).message };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (timedOut) return { ok: false, stdout, error: `timeout sau ${timeoutMs} ms` };
    return code === 0 ? { ok: true, stdout } : { ok: false, stdout, error: `shell thoát mã ${code}` };
  } finally {
    clearTimeout(timer);
  }
};

/** `env` output → map. A line without `KEY=` continues the previous value; noise before the first var is dropped. */
export function parseEnvOutput(out: string): Env {
  const env: Env = {};
  let last: string | null = null;
  for (const line of out.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(line);
    if (m) { env[m[1]!] = m[2]!; last = m[1]!; } else if (last !== null && line !== '') env[last] += `\n${line}`;
  }
  return env;
}

const verKey = (v: string) => v.replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
const cmpVer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** nvm's default node bin dir: `~/.nvm/alias/default` (e.g. `24` or `v24.1.0`) → highest matching installed version. */
function nvmDefaultBin(home: string): string | null {
  const nvm = join(home, '.nvm');
  let alias: string;
  try { alias = readFileSync(join(nvm, 'alias', 'default'), 'utf8').trim().replace(/^v/, ''); } catch { return null; }
  if (!alias) return null;
  let versions: string[];
  try { versions = readdirSync(join(nvm, 'versions', 'node')); } catch { return null; }
  const match = versions
    .filter((v) => { const s = v.replace(/^v/, ''); return s === alias || s.startsWith(`${alias}.`); })
    .sort((a, b) => cmpVer(verKey(b), verKey(a)))[0];
  if (!match) return null;
  const bin = join(nvm, 'versions', 'node', match, 'bin');
  return existsSync(bin) ? bin : null;
}

export function fallbackPath(home: string): string {
  const nvm = nvmDefaultBin(home);
  return [join(home, '.local/bin'), '/opt/homebrew/bin', ...(nvm ? [nvm] : []), SYSTEM_PATH].join(':');
}

export function findOnPath(name: string, pathVar: string | undefined): string | null {
  for (const dir of (pathVar ?? '').split(':')) {
    if (!dir) continue;
    const p = join(dir, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

export interface LoadOptions {
  shell?: string;
  /** Default `['-lic', 'env']`. */
  shellArgs?: string[];
  runner?: ShellRunner;
  timeoutMs?: number;
  home?: string;
  /** Env the fallback starts from (default process.env). */
  base?: Env;
}

export async function loadLoginEnv(o: LoadOptions = {}): Promise<LoginEnv> {
  const home = o.home ?? homedir();
  const shell = o.shell ?? process.env.SHELL ?? '/bin/zsh';
  const run = o.runner ?? defaultShellRunner;
  const r = await run(shell, o.shellArgs ?? ['-lic', 'env'], o.timeoutMs ?? SHELL_TIMEOUT_MS);
  const parsed = r.ok ? parseEnvOutput(r.stdout) : {};
  let env: Env;
  let reason: string | null = null;
  if (r.ok && parsed.PATH) {
    env = parsed;
  } else {
    reason = r.ok ? `${shell} không trả về PATH` : r.error;
    const b: Env = {};
    for (const [k, v] of Object.entries(o.base ?? process.env)) if (v !== undefined) b[k] = v;
    env = { ...b, PATH: fallbackPath(home) };
  }
  return { env, claudePath: findOnPath('claude', env.PATH), shellFailed: reason !== null, reason };
}

/**
 * v2 §7: the ONE list of variables that could pull a login or a session to another account / provider. Shared by the
 * session `childEnv` and `accounts/login.ts`. Every `ANTHROPIC_*` is removed too (prefix rule, see `stripEnv`).
 * Proxy variables (`HTTP(S)_PROXY`, `NO_PROXY`) are kept.
 */
export const STRIP_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR',
] as const;
const STRIP_PREFIX = 'ANTHROPIC_';
const STRIP_SET = new Set<string>(STRIP_ENV);

/** v2 §7 copy of `env` without `ANTHROPIC_*` and `STRIP_ENV`; the caller sets `CLAUDE_CONFIG_DIR` again. */
export function stripEnv(env: Env): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith(STRIP_PREFIX) && !STRIP_SET.has(k)) out[k] = v;
  return out;
}

/**
 * §7.3 child env: the stripped login env (v2 §7); v2 §5.4: CLAUDE_CONFIG_DIR = the account dir — except the terminal
 * account (hf1116 T2): it is `~/.claude` itself, reached only with CLAUDE_CONFIG_DIR unset (the Keychain item name
 * hashes that variable, so setting it to `~/.claude` would miss the default item).
 */
export function childEnv(login: Env, account: { configDir: string; terminal?: boolean }): Env {
  const env = stripEnv(login);
  if (!account.terminal) env.CLAUDE_CONFIG_DIR = account.configDir;
  // v2.2 §5.1 / §3-1 (measured G0): claude.ai connectors differ per account → never in a session.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return env;
}
