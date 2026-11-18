// F1 first-run setup (v1 spec §6.1, v2 §6): the Claude Code check and its installer — the only dependency left (the CC
// Switch installer went in v2 T8). Every process call goes through an injected `exec`, so tests never install anything.
import type { GitSetup, SetupStatus } from '../../../shared/protocol.ts';
import type { Account } from '../accounts/registry.ts';
import { MIN_CLAUDE_VERSION, versionAtLeast } from '../session/process.ts';

export const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

export interface ExecResult { code: number; stdout: string; stderr: string }
/** `env` adds to the process env (v2.3 §10.2: merge-tree's temp object dir). */
export type Exec = (argv: string[], o?: { onLine?: (line: string) => void; timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult>;

/**
 * Real exec over the env `base` (+ the call's `env`): Bun.spawn, stdout+stderr lines streamed to `onLine`.
 * hotfix 2026-11-16: the engine passes the login-shell env — an app opened from Finder has no `~/.zshenv` vars, and
 * without the PO's `DEVELOPER_DIR` `/usr/bin/git` follows `xcode-select` into an Xcode whose license is not accepted.
 */
export function execIn(base: Record<string, string | undefined>): Exec {
  return (argv, o = {}) => run(argv, { ...base, ...o.env }, o);
}

async function run(argv: string[], env: Record<string, string | undefined>, o: Parameters<Exec>[1] = {}): Promise<ExecResult> {
  const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env });
  const timer = o.timeoutMs ? setTimeout(() => p.kill('SIGTERM'), o.timeoutMs) : null;
  const read = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let all = '';
    let buf = '';
    for await (const c of s) {
      const t = dec.decode(c, { stream: true });
      all += t;
      buf += t;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const l of parts) o.onLine?.(l);
    }
    if (buf) o.onLine?.(buf);
    return all;
  };
  const [stdout, stderr] = await Promise.all([read(p.stdout), read(p.stderr)]);
  const code = await p.exited;
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
}

export function parseVersion(s: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(s)?.[1] ?? null;
}

export interface CheckDeps {
  exec: Exec;
  /** `claude` on the login-shell PATH (§3.1), null when absent. */
  claudePath: () => string | null;
  accounts: () => Account[];
  /** Accounts the engine saw logged out (F16), not yet logged in again. */
  loggedOut: () => ReadonlySet<string>;
  poEmail: () => string | null;
  /** hotfix 2026-11-16 (b) git / identity / gh (git-setup.ts `gitCheck`); optional, never part of `done`. */
  git: () => Promise<GitSetup>;
}

export async function setupCheck(d: CheckDeps): Promise<SetupStatus> {
  const path = d.claudePath();
  const git = d.git();
  let claudeVersion: string | null = null;
  if (path) {
    const r = await d.exec([path, '--version'], { timeoutMs: 15_000 }).catch(() => null);
    claudeVersion = r && r.code === 0 ? parseVersion(r.stdout) : null;
  }
  const out = d.loggedOut();
  const accounts = d.accounts().map((a) => ({ email: a.email, loggedIn: !out.has(a.email) }));
  const claude = { found: path !== null, path, version: claudeVersion, ok: versionAtLeast(claudeVersion, MIN_CLAUDE_VERSION) };
  // v2 §6: done = Claude Code ok ∧ at least one logged-in account
  return { claude, accounts, poEmail: d.poEmail(), done: claude.ok && accounts.some((a) => a.loggedIn), git: await git };
}

export interface InstallDeps { exec: Exec; log: (line: string) => void }

/** §6.1 step 1: the official script, or `claude update` when present but old. */
export async function installClaude(what: 'claude' | 'claude_update', d: InstallDeps & { claudePath?: string | null }): Promise<boolean> {
  const argv = what === 'claude' ? ['/bin/bash', '-c', CLAUDE_INSTALL] : [d.claudePath ?? 'claude', 'update'];
  d.log(`$ ${what === 'claude' ? CLAUDE_INSTALL : 'claude update'}`);
  const r = await d.exec(argv, { onLine: d.log, timeoutMs: 15 * 60_000 }).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
  if (r.code !== 0) d.log(`Lỗi cài (mã ${r.code}) ${r.stderr.trim().split('\n').pop() ?? ''}`.trim());
  return r.code === 0;
}
