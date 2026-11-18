// v2 §5.2 / §5.5 / §6 A9 shared config: the per-account check + self-heal state, "Gộp vào ~/.claude" (merge a real
// `<acct>/<name>` dir into `~/.claude/<name>`, never overwrite, never delete), the unknown-entry toggle (off = unlink our
// link only) and the non-recursive watch of the `~/.claude` root. Every fs call goes through an injectable surface.
import { linkSync, lstatSync, readdirSync, renameSync, watch } from 'node:fs';
import { join } from 'node:path';
import { classifyEntry, healLayout, nodeLayoutFs, SHARED_ENTRIES, unknownEntries, type Issue, type LayoutFs } from './layout.ts';
import { DIR_MODE } from '../paths.ts';

export interface MergeFs extends LayoutFs {
  rename(from: string, to: string): void;
  /** Hard link; throws EEXIST when `to` exists (never replaces, unlike rename). */
  link(from: string, to: string): void;
}
export const nodeMergeFs: MergeFs = { ...nodeLayoutFs, rename: (a, b) => renameSync(a, b), link: (a, b) => linkSync(a, b) };

const isExists = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'EEXIST';

export interface SharedOpts { extraShared?: readonly string[] }

export type MergePlan =
  | { ok: true; name: string; files: string[]; clashes: [] }
  | { ok: false; name: string; reason: 'clash'; files: string[]; clashes: string[] }
  | { ok: false; name: string; reason: 'not_shared' | 'not_real_dir' | 'target_not_dir'; files: []; clashes: [] };

const validName = (n: string) => !!n && n !== '.' && n !== '..' && !/[/\\\0]/.test(n);

function isSharedName(name: string, opts: SharedOpts): boolean {
  if (!validName(name)) return false;
  if ((SHARED_ENTRIES as readonly string[]).includes(name)) return true;
  return classifyEntry(name) === 'unknown' && (opts.extraShared ?? []).includes(name);
}

/** Leaves (files, links) and dirs under `root`, relative, lstat only (a link inside is moved as a link, never followed). */
function walk(root: string, fs: LayoutFs, rel = ''): { files: string[]; dirs: string[] } {
  const out = { files: [] as string[], dirs: [] as string[] };
  for (const n of fs.readdir(rel ? join(root, rel) : root).sort()) {
    const r = rel ? `${rel}/${n}` : n;
    if (fs.kind(join(root, r)) === 'dir') {
      out.dirs.push(r);
      const sub = walk(root, fs, r);
      out.files.push(...sub.files);
      out.dirs.push(...sub.dirs);
    } else out.files.push(r);
  }
  return out;
}

/**
 * §5.5 dry run: the files under `<acct>/<name>` that would move into `<claudeHome>/<name>`. A clash is any path that
 * already exists at the destination as something it cannot merge with (same file name, or a dir vs a file) → refuse.
 */
export function planMerge(claudeHome: string, accountDir: string, name: string, opts: SharedOpts = {}, fs: LayoutFs = nodeMergeFs): MergePlan {
  const none = { files: [] as [], clashes: [] as [] };
  if (!isSharedName(name, opts)) return { ok: false, name, reason: 'not_shared', ...none };
  const src = join(accountDir, name);
  const dst = join(claudeHome, name);
  if (fs.kind(src) !== 'dir') return { ok: false, name, reason: 'not_real_dir', ...none };
  const dk = fs.kind(dst);
  if (dk !== null && dk !== 'dir') return { ok: false, name, reason: 'target_not_dir', ...none };
  const { files, dirs } = walk(src, fs);
  const clashes: string[] = [];
  if (dk === 'dir') {
    // `dirs` is parent-first, so a path under a clashing dir is skipped (lstat under a file is ENOTDIR).
    const under = (p: string) => clashes.some((c) => p.startsWith(`${c}/`));
    for (const d of dirs) { if (under(d)) continue; const k = fs.kind(join(dst, d)); if (k !== null && k !== 'dir') clashes.push(d); }
    for (const f of files) if (!under(f) && fs.kind(join(dst, f)) !== null) clashes.push(f);
  }
  clashes.sort();
  if (clashes.length) return { ok: false, name, reason: 'clash', files, clashes };
  return { ok: true, name, files, clashes: [] };
}

/** §6 A9C one clash: the account copy and the `~/.claude` copy (folder, full path, mtime ms; null = unreadable). */
export interface ClashCopy {
  file: string;
  account: { dir: string; path: string; mtime: number | null };
  shared: { dir: string; path: string; mtime: number | null };
}
const nodeMtime = (p: string): number | null => { try { return Math.round(lstatSync(p).mtimeMs); } catch { return null; } };

/** G4 UX I2: both copies of every clash of a plan (paths built from the plan's own list, never from a client). */
export function clashCopies(claudeHome: string, accountDir: string, plan: MergePlan, mtime: (p: string) => number | null = nodeMtime): ClashCopy[] {
  if (plan.ok || plan.reason !== 'clash') return [];
  const a = join(accountDir, plan.name), s = join(claudeHome, plan.name);
  return plan.clashes.map((file) => ({
    file,
    account: { dir: a, path: join(a, file), mtime: mtime(join(a, file)) },
    shared: { dir: s, path: join(s, file), mtime: mtime(join(s, file)) },
  }));
}

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export type MergeResult = { ok: true; name: string; moved: string[]; backup: string } | Exclude<MergePlan, { ok: true }>;

/**
 * §5.5 "Gộp vào ~/.claude": re-plans (refuses on any clash, nothing touched), moves each file, renames the emptied dir
 * to `<name>.cc-slaves-bak-<UTC ts>` (kept, never deleted) and puts the one-level link in its place.
 */
export function mergeShared(
  claudeHome: string, accountDir: string, name: string, o: SharedOpts & { now?: () => number; fs?: MergeFs } = {},
): MergeResult {
  const fs = o.fs ?? nodeMergeFs;
  const plan = planMerge(claudeHome, accountDir, name, o, fs);
  if (!plan.ok) return plan;
  const src = join(accountDir, name);
  const dst = join(claudeHome, name);
  if (fs.kind(dst) === null) fs.mkdir(dst, DIR_MODE);
  for (const d of walk(src, fs).dirs) if (fs.kind(join(dst, d)) === null) fs.mkdir(join(dst, d), DIR_MODE);
  // MINOR-1: exclusive create, then unlink: a same-name file that appeared after the plan stops the merge (never overwritten).
  // A link is re-created as a link (macOS link(2) follows symlinks, measured 2026-11-15).
  const moved: string[] = [];
  for (const f of plan.files) {
    const a = join(src, f);
    const b = join(dst, f);
    try {
      if (fs.kind(a) === 'link') fs.symlink(fs.readlink(a), b);
      else fs.link(a, b);
    } catch (e) {
      if (!isExists(e)) throw e;
      return { ok: false, name, reason: 'clash', files: plan.files.filter((x) => !moved.includes(x)), clashes: [f] };
    }
    fs.unlink(a);
    moved.push(f);
  }
  const base = `${src}.cc-slaves-bak-${stamp((o.now ?? Date.now)())}`;
  let backup = base;
  for (let i = 1; fs.kind(backup) !== null; i++) backup = `${base}-${i}`;
  fs.rename(src, backup);
  fs.symlink(dst, src);
  return { ok: true, name, moved: plan.files, backup };
}

/** §5.2 toggle off: unlink `<acct>/<name>` only when it is our link to `<claudeHome>/<name>`; the target is never touched. */
export function unshareEntry(claudeHome: string, accountDir: string, name: string, fs: LayoutFs = nodeLayoutFs): boolean {
  if (!validName(name) || classifyEntry(name) !== 'unknown') throw new Error(`entry ${JSON.stringify(name)} is not an unknown entry`);
  const p = join(accountDir, name);
  if (fs.kind(p) !== 'link' || fs.readlink(p) !== join(claudeHome, name)) return false;
  fs.unlink(p);
  return true;
}

/** §5.2 unknown entries of `~/.claude` not in `seen` (a new one gets the "dùng chung cho mọi account?" card). */
export function newUnknownEntries(claudeEntries: readonly string[], seen: readonly string[]): string[] {
  const s = new Set(seen);
  return unknownEntries(claudeEntries).filter((n) => !s.has(n));
}

interface SharedCfgIssue { kind: Issue['kind']; name: string; path: string }
export interface SharedCfgCheck { ok: boolean; issues: SharedCfgIssue[]; ms: number }

/**
 * §5.5 last check per account: `healLayout` fixes what it may; anything left flags the account ("cấu hình chung lỗi"),
 * which then gets no new lane (the engine feeds `flagged()` to the picker like a paused account).
 */
export class SharedCfgState {
  private readonly last = new Map<string, SharedCfgCheck>();
  constructor(private readonly d: { claudeHome: () => string; extraShared: () => readonly string[]; fs?: LayoutFs }) {}

  check(a: { email: string; configDir: string }): SharedCfgCheck {
    const t0 = performance.now();
    let issues: SharedCfgIssue[];
    try {
      const { remaining } = healLayout(this.d.claudeHome(), a.configDir, this.d.fs ?? nodeLayoutFs, { extraShared: this.d.extraShared() });
      issues = remaining.map((i) => ({ kind: i.kind, name: i.name, path: i.path }));
    } catch { // a bad dir / extraShared name: flag the account rather than spawn into an unchecked layout
      issues = [{ kind: 'real-entry', name: '', path: a.configDir }];
    }
    const r = { ok: issues.length === 0, issues, ms: performance.now() - t0 };
    this.last.set(a.email, r);
    return r;
  }

  get(email: string): SharedCfgCheck | null { return this.last.get(email) ?? null; }
  forget(email: string): void { this.last.delete(email); }
  flagged(): Set<string> {
    return new Set([...this.last].filter(([, r]) => !r.ok).map(([e]) => e));
  }
}

export interface RootWatchDeps {
  debounceMs?: number;
  /** Poll of the root's entry list: Bun's fs.watch misses most events on macOS (measured 22–30 of 30 missed). */
  pollMs?: number;
  watch?: (dir: string, cb: () => void) => { close(): void };
  readdir?: (dir: string) => string[];
}

/**
 * §5.5 non-recursive watch of the `~/.claude` root (fs.watch + a poll of its entry names), debounced. Returns the stop
 * function; a missing root is still polled, so it is seen once it appears.
 */
export function watchClaudeRoot(dir: string, onChange: () => void, d: RootWatchDeps = {}): () => void {
  const list = d.readdir ?? ((p: string) => readdirSync(p));
  const sig = () => { try { return list(dir).sort().join('\0'); } catch { return '\u0001missing'; } };
  let last = sig();
  let t: ReturnType<typeof setTimeout> | null = null;
  const bump = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; last = sig(); onChange(); }, d.debounceMs ?? 300);
  };
  let w: { close(): void } | null = null;
  try {
    w = (d.watch ?? ((p, cb) => { const x = watch(p, { recursive: false }, cb); x.on('error', () => {}); return x; }))(dir, bump);
  } catch { /* no root yet: the poll sees it appear */ }
  const poll = setInterval(() => { if (sig() !== last) bump(); }, d.pollMs ?? 1000);
  return () => { if (t) clearTimeout(t); clearInterval(poll); w?.close(); };
}
