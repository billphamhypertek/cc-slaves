// v2 account dir layout (spec v2 §5.1, §5.2, §5.5, §7 safe delete). The one module that owns the shared-entry list.
// Every link is absolute and ONE level (§3.1-3: multi-level links get silently replaced by Claude Code).
import { chmodSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { DIR_MODE, paths } from '../paths.ts';
import { homedir } from 'node:os';

/** §5.2 must be shared: each is a symlink `<acct>/<name> → <claudeHome>/<name>`. Same 11 names CC Switch links. */
export const SHARED_ENTRIES = [
  'projects', 'todos', 'plans', 'file-history', 'skills', 'agents', 'commands', 'rules', 'output-styles', 'plugins',
  'workflows',
] as const;

const NEVER_EXACT = new Set([
  '.claude.json', '.credentials.json', 'CLAUDE.md', 'settings.json', 'settings.local.json', 'sessions', 'session-env',
  'shell-snapshots', 'cache', 'statsig', 'backups', 'paste-cache', 'ide', 'mcp-needs-auth-cache.json',
  'stats-cache.json', '.DS_Store',
]);
/** `daemon*`, `.last-*`, `*.bak*` (§5.2). */
const NEVER_PATTERNS = [/^daemon/, /^\.last-/, /\.bak/];
/** §5.2 Claude Code runtime state of one install: sharing would let accounts overwrite each other. */
const PRIVATE = new Set(['teams', 'jobs', 'session-data', 'chrome', 'metrics', 'state', 'history.jsonl']);
const SHARED = new Set<string>(SHARED_ENTRIES);

export type EntryClass = 'shared' | 'never' | 'private' | 'unknown';

export function classifyEntry(name: string): EntryClass {
  if (SHARED.has(name)) return 'shared';
  if (NEVER_EXACT.has(name) || NEVER_PATTERNS.some((re) => re.test(name))) return 'never';
  if (PRIVATE.has(name)) return 'private';
  return 'unknown';
}

/** §5.2 entries of `~/.claude` outside the three lists: not shared by default, listed for the PO's toggle. */
export function unknownEntries(claudeEntries: readonly string[]): string[] {
  return claudeEntries.filter((n) => classifyEntry(n) === 'unknown').sort();
}

/** §5.2 Account › "Cấu hình chung": the 11 shared names (always) + every other `~/.claude` entry, minus noise. */
export function entryList(claudeEntries: readonly string[], extraShared: readonly string[]): { name: string; cls: EntryClass; shared: boolean }[] {
  const names = [...new Set([...SHARED_ENTRIES, ...claudeEntries])].filter((n) => n !== '.DS_Store').sort();
  return names.map((name) => {
    const cls = classifyEntry(name);
    return { name, cls, shared: cls === 'shared' || (cls === 'unknown' && extraShared.includes(name)) };
  });
}

export type Step =
  | { op: 'mkdir'; path: string; mode: number }
  | { op: 'symlink'; name: string; path: string; target: string };

export interface LayoutOptions {
  /** Unknown entries the PO switched to "Dùng chung" (§5.2). Only `unknown` names are accepted. */
  extraShared?: readonly string[];
}

function sharedNames(opts: LayoutOptions = {}): string[] {
  const extra = opts.extraShared ?? [];
  for (const n of extra) {
    if (!n || n === '.' || n === '..' || /[/\\\0]/.test(n)) throw new Error(`invalid shared entry name: ${JSON.stringify(n)}`);
    if (classifyEntry(n) !== 'unknown') throw new Error(`entry ${JSON.stringify(n)} cannot be shared (${classifyEntry(n)})`);
  }
  return [...SHARED_ENTRIES, ...extra];
}

function assertAbsolute(kind: string, p: string): void {
  if (!isAbsolute(p) || normalize(p) !== p || (p.length > 1 && p.endsWith('/'))) throw new Error(`${kind} must be a normalized absolute path: ${JSON.stringify(p)}`);
}

/**
 * Pure §5.1/§5.2 plan: `~/.claude` (0700 when created), every shared target inside it, the account dir 0700, then
 * one absolute link per shared entry. Never-shared and private entries are never named. Apply is idempotent.
 */
export function planLayout(claudeHome: string, accountDir: string, opts?: LayoutOptions): Step[] {
  assertAbsolute('claudeHome', claudeHome);
  assertAbsolute('accountDir', accountDir);
  const names = sharedNames(opts);
  return [
    { op: 'mkdir', path: claudeHome, mode: DIR_MODE },
    ...names.map((n): Step => ({ op: 'mkdir', path: join(claudeHome, n), mode: DIR_MODE })),
    { op: 'mkdir', path: accountDir, mode: DIR_MODE },
    ...names.map((n): Step => ({ op: 'symlink', name: n, path: join(accountDir, n), target: join(claudeHome, n) })),
  ];
}

type EntryKind = 'dir' | 'file' | 'link';

/** The only fs surface layout code uses, so tests can inject a fake. `kind` is lstat: it never follows a link. */
export interface LayoutFs {
  kind(p: string): EntryKind | null;
  readlink(p: string): string;
  readdir(p: string): string[];
  /** Creates a missing dir (parents too) and sets `mode` on the leaf. Only called when `p` is absent. */
  mkdir(p: string, mode: number): void;
  symlink(target: string, p: string): void;
  unlink(p: string): void;
  rmdir(p: string): void;
}

export const nodeLayoutFs: LayoutFs = {
  kind(p) {
    try {
      const st = lstatSync(p);
      return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  },
  readlink: (p) => readlinkSync(p),
  readdir: (p) => readdirSync(p),
  mkdir(p, mode) {
    mkdirSync(p, { recursive: true, mode });
    chmodSync(p, mode);
  },
  symlink: (target, p) => symlinkSync(target, p),
  unlink: (p) => unlinkSync(p),
  rmdir: (p) => rmdirSync(p),
};

export type Issue =
  | { kind: 'missing-target'; name: string; path: string }
  | { kind: 'target-not-dir'; name: string; path: string }
  | { kind: 'missing-link'; name: string; path: string }
  | { kind: 'wrong-target'; name: string; path: string; actual: string }
  /** A real dir/file where the link belongs (Claude Code created it): report only, never delete or merge (§5.5). */
  | { kind: 'real-entry'; name: string; path: string };

export interface ApplyResult {
  created: string[];
  conflicts: Issue[];
}

/** Runs a plan. Existing correct entries are skipped; anything else already there is reported, never overwritten. */
export function applyLayout(steps: readonly Step[], fs: LayoutFs = nodeLayoutFs): ApplyResult {
  const created: string[] = [];
  const conflicts: Issue[] = [];
  const link = steps.find((s) => s.op === 'symlink');
  const bad = link ? accountDirIssue(dirname(link.path), fs) : null;
  if (bad) return { created, conflicts: [bad] };
  for (const s of steps) {
    const k = fs.kind(s.path);
    if (s.op === 'mkdir') {
      if (k === null) {
        fs.mkdir(s.path, s.mode);
        created.push(s.path);
      } else if (k === 'file') {
        conflicts.push({ kind: 'target-not-dir', name: basename(s.path), path: s.path });
      }
      continue;
    }
    if (k === null) {
      fs.symlink(s.target, s.path);
      created.push(s.path);
    } else if (k === 'link') {
      const actual = fs.readlink(s.path);
      if (actual !== s.target) conflicts.push({ kind: 'wrong-target', name: s.name, path: s.path, actual });
    } else {
      conflicts.push({ kind: 'real-entry', name: s.name, path: s.path });
    }
  }
  return { created, conflicts };
}

/**
 * The account dir itself must be a real dir (or absent): a link would make every `<acct>/<name>` step resolve through
 * it (e.g. into `~/.claude`), a file blocks the layout. Either → one `real-entry` issue and no other step (G1 IMPORTANT-3).
 */
function accountDirIssue(accountDir: string, fs: LayoutFs): Issue | null {
  const k = fs.kind(accountDir);
  return k === 'link' || k === 'file' ? { kind: 'real-entry', name: basename(accountDir), path: accountDir } : null;
}

/** §5.5 read-only check of one account against the plan. */
export function checkLayout(
  claudeHome: string, accountDir: string, fs: LayoutFs = nodeLayoutFs, opts?: LayoutOptions,
): Issue[] {
  const issues: Issue[] = [];
  for (const s of planLayout(claudeHome, accountDir, opts)) {
    if (s.op !== 'symlink') continue;
    const tk = fs.kind(s.target);
    if (tk === null) issues.push({ kind: 'missing-target', name: s.name, path: s.target });
    else if (tk === 'file') issues.push({ kind: 'target-not-dir', name: s.name, path: s.target });
    const k = fs.kind(s.path);
    if (k === null) issues.push({ kind: 'missing-link', name: s.name, path: s.path });
    else if (k === 'link') {
      const actual = fs.readlink(s.path);
      if (actual !== s.target) issues.push({ kind: 'wrong-target', name: s.name, path: s.path, actual });
    } else issues.push({ kind: 'real-entry', name: s.name, path: s.path });
  }
  return issues;
}

export interface HealResult {
  fixed: Issue[];
  /** Left for the PO (`real-entry`, `target-not-dir`): the account is "cấu hình chung lỗi" and takes no new lane. */
  remaining: Issue[];
}

/**
 * §5.5 self-heal: create what is missing, re-point wrong/relative/multi-level links (unlink of a link never touches
 * its target). A real dir or file where a link belongs is reported and left exactly as it is.
 */
export function healLayout(
  claudeHome: string, accountDir: string, fs: LayoutFs = nodeLayoutFs, opts?: LayoutOptions,
): HealResult {
  const steps = planLayout(claudeHome, accountDir, opts);
  const bad = accountDirIssue(accountDir, fs);
  if (bad) return { fixed: [], remaining: [bad] };
  const before = checkLayout(claudeHome, accountDir, fs, opts);
  const { conflicts } = applyLayout(steps, fs);
  for (const c of conflicts) {
    if (c.kind !== 'wrong-target' || fs.kind(c.path) !== 'link') continue;
    fs.unlink(c.path);
    fs.symlink(join(claudeHome, c.name), c.path);
  }
  const remaining = checkLayout(claudeHome, accountDir, fs, opts);
  const key = (i: Issue) => `${i.kind}\0${i.path}`;
  const left = new Set(remaining.map(key));
  return { fixed: before.filter((i) => !left.has(key(i))), remaining };
}

/** §5.1 account dir name: 12 random hex, never renamed. */
const ACCOUNT_ID = /^[0-9a-f]{12}$/;

/** §7 safe delete step 4: the exact path must be `<accountsRoot>/<12 hex>`; anything else is refused. */
/** Dirs an accounts root must never be (MINOR-2): `~/.claude` or anything inside it, and `$HOME` itself. */
export interface DeleteGuard {
  claudeHome: string;
  userHome: string;
}
const defaultGuard = (): DeleteGuard => ({ claudeHome: paths().claudeHome, userHome: homedir() });
const isSameOrInside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

export function assertDeletableAccountDir(
  accountDir: string, accountsRoot: string, fs: LayoutFs = nodeLayoutFs, guard: DeleteGuard = defaultGuard(),
): void {
  const refuse = (why: string): never => {
    throw new Error(`refusing to delete ${JSON.stringify(accountDir)}: ${why}`);
  };
  // `normalize` keeps a trailing '/', and dirname/basename ignore it: refuse it explicitly (§3.2 SA4: no trailing '/').
  const clean = (p: string) => isAbsolute(p) && normalize(p) === p && !p.endsWith('/');
  if (!clean(accountsRoot)) {
    refuse(`bad accounts root ${JSON.stringify(accountsRoot)}`);
  }
  if (isSameOrInside(accountsRoot, normalize(guard.claudeHome)) || accountsRoot === normalize(guard.userHome).replace(/\/$/, '')) {
    refuse(`accounts root ${JSON.stringify(accountsRoot)} is ~/.claude, inside it, or $HOME`);
  }
  if (!clean(accountDir) || accountDir.split('/').includes('..')) {
    refuse('not a normalized absolute path');
  }
  if (dirname(accountDir) !== accountsRoot || !ACCOUNT_ID.test(basename(accountDir))) {
    refuse(`not <accounts root>/<12 hex id> under ${accountsRoot}`);
  }
  if (fs.kind(accountsRoot) !== 'dir') refuse('accounts root is not a real dir');
}

/**
 * §7 safe delete step 3–4: root check first, then a walk that uses lstat only. Links (and files) are unlinked, dirs
 * are emptied then removed; a link is never entered, so nothing under `~/.claude` can be reached. Missing = no-op.
 */
export function safeDeleteAccountDir(
  accountDir: string, accountsRoot: string, fs: LayoutFs = nodeLayoutFs, guard: DeleteGuard = defaultGuard(),
): void {
  assertDeletableAccountDir(accountDir, accountsRoot, fs, guard);
  const top = fs.kind(accountDir);
  if (top === null) return;
  if (top !== 'dir') throw new Error(`refusing to delete ${JSON.stringify(accountDir)}: not a real dir (${top})`);
  const remove = (p: string): void => {
    if (fs.kind(p) !== 'dir') {
      fs.unlink(p);
      return;
    }
    for (const child of fs.readdir(p)) remove(join(p, child));
    fs.rmdir(p);
  };
  remove(accountDir);
}
