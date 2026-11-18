// v2 §5.3: one-way copy of `~/.claude/settings.json` (+ `settings.local.json`) into every account dir. Copied, never
// symlinked (§3.1-3: Claude Code rewrites settings by tmp + rename). `env.CLAUDE_CONFIG_DIR` is dropped; files are
// 0600 (may hold secrets in `env`, §5.1). Nothing is ever written under `~/.claude`.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, watch as fsWatch } from 'node:fs';
import { join, resolve } from 'node:path';
import { paths, writeFileSecure } from '../paths.ts';

const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const;
const WATCH_DEBOUNCE_MS = 1000;

export interface MirrorDeps {
  /** Atomic 0600 write (default `writeFileSecure`: tmp + rename). */
  write?: (path: string, data: string) => void;
  /** Source dir for `ensureMirrored` (default `paths().claudeHome`). */
  claudeHome?: string;
}

export interface MirrorReport {
  written: string[];
  /** Source files that do not exist (their account copies are left alone). */
  missing: string[];
  errors: string[];
}

/** Per target: the source / target mtimes last seen in sync, so an unchanged pair costs two `stat`s. */
const memo = new Map<string, { src: string; tgt: string | null }>();

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const norm = (p: string) => resolve(p);

/** The copy as it should land in an account: the source JSON minus `env.CLAUDE_CONFIG_DIR`. Throws on broken JSON. */
function transform(raw: string): string {
  const j = JSON.parse(raw) as unknown;
  if (typeof j === 'object' && j !== null && !Array.isArray(j)) {
    const env = (j as Record<string, unknown>).env;
    if (typeof env === 'object' && env !== null && 'CLAUDE_CONFIG_DIR' in env) {
      delete (env as Record<string, unknown>).CLAUDE_CONFIG_DIR;
      return `${JSON.stringify(j, null, 2)}\n`;
    }
  }
  return raw;
}

/** mtime + size: an edit inside one mtime tick still changes the key in practice; the hash is the real check. */
const mtime = (p: string): string | null => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return null; } };

function mirrorOne(claudeHome: string, accountDir: string, file: string, deps: MirrorDeps, r: MirrorReport): void {
  const home = norm(claudeHome);
  const dir = norm(accountDir);
  if (dir === home || dir.startsWith(`${home}/`)) return; // never write into ~/.claude (a v1 lane on the default dir)
  if (!existsSync(dir)) return; // the account dir is created by the login flow, never here
  const src = join(home, file);
  const tgt = join(dir, file);
  const srcM = mtime(src);
  if (srcM === null) { r.missing.push(src); return; }
  const tgtM = mtime(tgt);
  const m = memo.get(tgt);
  if (m && m.src === srcM && m.tgt === tgtM) return;
  let want: string;
  try { want = transform(readFileSync(src, 'utf8')); } catch (e) { r.errors.push(`${src}: ${(e as Error).message}`); return; }
  let have: string | null = null;
  try { have = readFileSync(tgt, 'utf8'); } catch { /* no copy yet */ }
  if (have === null || sha(have) !== sha(want)) {
    try { (deps.write ?? writeFileSecure)(tgt, want); } catch (e) { r.errors.push(`${tgt}: ${(e as Error).message}`); return; }
    r.written.push(tgt);
  }
  memo.set(tgt, { src: srcM, tgt: mtime(tgt) });
}

/** §5.3 copy both settings files from `claudeHome` into each account dir (skip when unchanged). Never throws. */
export function mirrorSettings(claudeHome: string, accountDirs: readonly string[], deps: MirrorDeps = {}): MirrorReport {
  const r: MirrorReport = { written: [], missing: [], errors: [] };
  for (const file of SETTINGS_FILES) {
    for (const d of accountDirs) mirrorOne(claudeHome, d, file, deps, r);
  }
  r.missing = [...new Set(r.missing)];
  return r;
}

/** §5.3 pre-spawn check for one account (mtime + hash; copies only when different). Never throws. */
export function ensureMirrored(accountDir: string, deps: MirrorDeps = {}): MirrorReport {
  return mirrorSettings(deps.claudeHome ?? paths().claudeHome, [accountDir], deps);
}

const POLL_MS = 1000;

export interface WatchDeps extends MirrorDeps {
  watch?: (dir: string, cb: (filename: string | null) => void) => { close(): void };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  onMirror?: (r: MirrorReport) => void;
}

/**
 * §5.3 mirror every account 1 s after the last change to a settings file in `claudeHome`. Two triggers feed one
 * debounce: `fs.watch` on the dir (fast; the dir, not the file, because Claude Code replaces the file by rename) and a
 * 1 s stat poll of the two source files (Bun's macOS watch dropped 13/20 edits, measured 2026-11-15). Returns stop.
 */
export function watchSettings(claudeHome: string, accountDirs: () => readonly string[], deps: WatchDeps = {}): () => void {
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const watch = deps.watch ?? ((dir, cb) => fsWatch(dir, (_ev, f) => cb(f === null ? null : String(f))));
  const sources = SETTINGS_FILES.map((f) => join(claudeHome, f));
  const key = () => sources.map(mtime).join('|');
  let last = key();
  let timer: unknown = null;
  const fire = () => {
    timer = null;
    last = key();
    const r = mirrorSettings(claudeHome, accountDirs(), deps);
    deps.onMirror?.(r);
  };
  const bump = () => {
    if (timer !== null) clearT(timer);
    timer = setT(fire, WATCH_DEBOUNCE_MS);
  };
  let w: { close(): void } | null = null;
  try {
    w = watch(claudeHome, (f) => {
      if (f !== null && !(SETTINGS_FILES as readonly string[]).includes(f)) return;
      bump();
    });
  } catch { /* no ~/.claude yet: the poll still sees the files appear */ }
  const poll = setI(() => {
    const k = key();
    if (k !== last) { last = k; bump(); }
  }, POLL_MS);
  return () => {
    if (timer !== null) clearT(timer);
    timer = null;
    clearI(poll);
    w?.close();
  };
}
