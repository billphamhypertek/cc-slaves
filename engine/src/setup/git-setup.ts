// hotfix 2026-11-16 (b) Git in onboarding (docs/ref/hf1116-ux.md): git / identity / gh state for SetupStatus.git, the
// Command Line Tools fallback at boot, `git_identity_set` and `git_install`. Every item is optional (never part of
// `done`); every process call goes through the injected login-env `exec`, with short timeouts, and the check never throws.
import { existsSync } from 'node:fs';
import { identityIssue } from '../../../shared/git-identity.ts';
import type { GhLoginView, GitSetup } from '../../../shared/protocol.ts';
import { KeyedError } from '../errors.ts';
import { findOnPath, type Env } from '../session/env.ts';
import { parseVersion, type Exec, type ExecResult } from './setup.ts';

export const CLT_DIR = '/Library/Developer/CommandLineTools';
export const CLT_GIT = `${CLT_DIR}/usr/bin/git`;
const XCODE_SELECT = '/usr/bin/xcode-select';
/** The xcrun shim: with no developer dir it opens Apple's install dialog itself, so it is never run blind. */
const SHIM_GIT = '/usr/bin/git';
const T_MS = 10_000;

const LICENSE = /xcode.*license|license agreements?/i;
const MISSING = /no developer tools|invalid active developer path|missing xcrun|requesting install|xcode-select --install/i;

export interface GitProbe { state: GitSetup['state']; version: string | null; detail: string | null }

export interface GitDeps {
  /** The login-env runner (`execIn(stripEnv(login.env))`). */
  exec: Exec;
  /** The login env: its PATH finds git, its DEVELOPER_DIR is never overridden. */
  env: Env;
  which?: (name: string) => string | null;
  exists?: (path: string) => boolean;
}

const lastLine = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 200) ?? null;
const run = (d: GitDeps, argv: string[], env?: Record<string, string>) =>
  d.exec(argv, { timeoutMs: T_MS, ...(env ? { env } : {}) }).catch(() => null);
const gitPath = (d: GitDeps) => (d.which ?? ((n: string) => findOnPath(n, d.env.PATH)))('git');

/** `git --version` → ok / missing (no developer tools; spawn failed) / license (Xcode's license) / error. */
export function classifyGit(r: ExecResult | null): GitProbe {
  if (!r) return { state: 'missing', version: null, detail: null };
  if (r.code === 0) return { state: 'ok', version: parseVersion(r.stdout), detail: null };
  const out = `${r.stdout}\n${r.stderr}`;
  if (LICENSE.test(out)) return { state: 'license', version: null, detail: null };
  if (MISSING.test(out)) return { state: 'missing', version: null, detail: null };
  return { state: 'error', version: null, detail: lastLine(out) };
}

async function probeGit(d: GitDeps): Promise<GitProbe & { git: string | null }> {
  const git = gitPath(d);
  if (!git) return { ...classifyGit(null), git };
  if (git === SHIM_GIT && !d.env.DEVELOPER_DIR) {
    const sel = await run(d, [XCODE_SELECT, '-p']);
    if (!sel || sel.code !== 0) return { ...classifyGit(null), git };
  }
  return { ...classifyGit(await run(d, [git, '--version'])), git };
}

async function configGet(d: GitDeps, git: string, key: string): Promise<string | null> {
  const r = await run(d, [git, 'config', '--global', key]);
  return r && r.code === 0 ? r.stdout.trim() || null : null;
}

export async function gitCheck(d: GitDeps & { ghPath: string | null; ghLogin: GhLoginView | null }): Promise<GitSetup> {
  const p = await probeGit(d);
  const ok = p.state === 'ok' && p.git !== null;
  const identity = ok ? { name: await configGet(d, p.git!, 'user.name'), email: await configGet(d, p.git!, 'user.email') } : { name: null, email: null };
  let gh: GitSetup['gh'] = 'missing';
  let ghUser: string | null = null;
  if (d.ghPath) {
    // Orchestrator ruling R1: offline (hosts.yml only, no network in the 5 s poll). Measured gh 2.92.0: logged in → the
    // user, exit 0; never logged in → `could not find key "user"`, exit 1.
    const r = await run(d, [d.ghPath, 'config', 'get', '-h', 'github.com', 'user']);
    ghUser = (r && r.code === 0 && r.stdout.trim()) || null;
    gh = ghUser ? 'ok' : 'logged_out';
  }
  return { state: p.state, version: p.version, detail: p.detail, identity, gh, ghUser, ghLogin: d.ghLogin };
}

/**
 * G2 at boot: git blocked by Xcode's license (or missing) under the login env, and the Command Line Tools git works with
 * DEVELOPER_DIR → that dir, to set in the login env. Never when the login env already has a DEVELOPER_DIR.
 */
export async function cltFallback(d: GitDeps): Promise<string | null> {
  if (d.env.DEVELOPER_DIR) return null;
  const p = await probeGit(d);
  if (p.state !== 'license' && p.state !== 'missing') return null;
  if (!(d.exists ?? existsSync)(CLT_GIT)) return null;
  const r = await run(d, [CLT_GIT, '--version'], { DEVELOPER_DIR: CLT_DIR });
  return r && r.code === 0 ? CLT_DIR : null;
}

/** `git config --global user.name / user.email` (argv only), after the shared identity check. */
export async function setIdentity(d: GitDeps, name: string, email: string): Promise<void> {
  const issue = identityIssue(name, email);
  if (issue) throw new KeyedError('bad_input', { key: issue === 'name' ? 'errors.gitIdentityName' : 'errors.gitIdentityEmail' });
  const git = gitPath(d) ?? 'git';
  for (const [k, v] of [['user.name', name.trim()], ['user.email', email.trim()]] as const) {
    const r = await run(d, [git, 'config', '--global', k, v]);
    if (!r || r.code !== 0) throw new KeyedError('git_identity_failed', { key: 'errors.gitIdentityFailed', params: { detail: (r && lastLine(`${r.stdout}\n${r.stderr}`)) ?? '' } });
  }
}

/** `xcode-select --install` opens Apple's dialog and returns at once; "already installed" → not opened. Never sudo. */
export async function gitInstall(exec: Exec): Promise<{ opened: boolean }> {
  const r = await exec([XCODE_SELECT, '--install'], { timeoutMs: T_MS }).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
  if (r.code === 0) return { opened: true };
  const out = `${r.stdout}\n${r.stderr}`;
  if (/already installed/i.test(out)) return { opened: false };
  throw new KeyedError('git_install_failed', { key: 'errors.gitInstallFailed', params: { detail: lastLine(out) ?? String(r.code) } });
}
