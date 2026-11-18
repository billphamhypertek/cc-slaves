// v2.2 §5.5 skills operations on disk: add (folder link / copy, git), remove (unlink / Trash), and the K11 fixes
// (copy over a CC Switch link, unlink / re-point a broken link). Every op takes the roots, so tests run on temp dirs.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import type { Exec } from '../setup/setup.ts';
import type { SkillDirCheck } from '../../../shared/protocol.ts';
import { appDirOf, parseSkillMd, SKILL_NAME_RE } from './catalog.ts';
import { userSkillsDir, type SkillRoots } from './scan.ts';

export type SkillOpCode =
  | 'exists' | 'noSkillMd' | 'badName' | 'notFound' | 'refused' | 'notInSkills' | 'notAppLink' | 'notBroken' | 'notLink'
  | 'copyFailed' | 'badUrl' | 'gitFailed' | 'noSkillsInRepo' | 'noFolder';

export class SkillOpError extends Error {
  constructor(readonly code: SkillOpCode, detail = '') { super(detail ? `${code}: ${detail}` : code); }
}

const GIT_TIMEOUT_MS = 120_000;
/** `renamex_np(2)` flag: swap the two entries in one step (a dir cannot be renamed over a symlink, ENOTDIR). */
const RENAME_SWAP = 0x2;

const isEntry = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
const hasSkillMd = (dir: string) => existsSync(join(dir, 'SKILL.md'));

function checkName(name: string): string {
  if (!name || name === '.' || name === '..' || name.startsWith('.') || /[/\\\0]/.test(name)) throw new SkillOpError('badName', name);
  return name;
}

/** A free entry `~/.claude/skills/<name>` (a broken link counts as taken: never overwrite). */
function freeDest(r: SkillRoots, name: string): string {
  const dest = join(userSkillsDir(r), checkName(name));
  if (isEntry(dest)) throw new SkillOpError('exists', name);
  return dest;
}

/** An existing entry directly inside `~/.claude/skills`. */
function skillEntry(r: SkillRoots, path: string): string {
  if (dirname(path) !== userSkillsDir(r) || !basename(path) || basename(path).startsWith('.')) throw new SkillOpError('notInSkills', path);
  if (!isEntry(path)) throw new SkillOpError('notFound', path);
  return path;
}

/** rename, or copy + remove across volumes (the git temp dir may sit on another volume). */
function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}

/** A fresh temp entry beside `dest` that can never be a skill (dot-names are refused by `checkName`, skipped by the scan). */
const tmpBeside = (dest: string): string => join(dirname(dest), `.cc-slaves-tmp-${randomBytes(6).toString('hex')}`);

/** Copies `src` into a temp beside `dest`; a failure leaves no temp behind. */
function copyToTmp(src: string, dest: string): string {
  const tmp = tmpBeside(dest);
  try {
    cpSync(src, tmp, { recursive: true, verbatimSymlinks: true });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw new SkillOpError('copyFailed', (e as Error).message);
  }
  return tmp;
}

const openSwap = () => dlopen('/usr/lib/libSystem.B.dylib', { renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } }).symbols.renamex_np;
let swapFn: ReturnType<typeof openSwap> | null = null;
/** Atomically swaps two entries (macOS `renamex_np` RENAME_SWAP). */
function swapEntries(a: string, b: string): void {
  swapFn ??= openSwap();
  const c = (s: string) => Buffer.from(`${s}\0`);
  if (swapFn(c(a), c(b), RENAME_SWAP) !== 0) throw new SkillOpError('copyFailed', `swap ${a} ⇄ ${b}`);
}

// ---------- add ----------

const realOrNull = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/**
 * §5.5 K9 the checks of one skill folder before it is added as `~/.claude/skills/<dir>` — writes nothing. `dir` defaults
 * to the frontmatter `name` (a picked folder is linked / copied under its skill name); a git candidate passes its folder.
 */
export function checkSkillDir(r: SkillRoots, path: string, dir?: string): SkillDirCheck {
  const real = realOrNull(path);
  if (real === null) throw new SkillOpError('noFolder', path);
  const skillMd = hasSkillMd(real);
  const fallback = dir ?? basename(real);
  const md = skillMd ? parseSkillMd(readFileSync(join(real, 'SKILL.md'), 'utf8'), fallback) : { name: fallback, description: '' };
  const to = dir ?? md.name;
  const dest = join(userSkillsDir(r), to);
  const exists = isEntry(dest)
    ? { link: lstatSync(dest).isSymbolicLink() ? readlinkSync(dest) : null, same: realOrNull(dest) === real }
    : null;
  return { dir: to, name: md.name, description: md.description, skillMd, badChars: !SKILL_NAME_RE.test(md.name), exists };
}

/** §5.5 K9 a check that stops the add (missing SKILL.md, name ≠ folder, bad chars, name taken). */
const blocked = (c: SkillDirCheck): SkillOpCode | null =>
  !c.skillMd ? 'noSkillMd' : c.name !== c.dir || c.badChars ? 'badName' : c.exists ? 'exists' : null;

/** §5.5 add from a folder under its skill name: "Liên kết" (default, absolute symlink to its realpath) or "Chép". */
export function addFromFolder(r: SkillRoots, src: string, mode: 'link' | 'copy'): string {
  const real = realpathSync(src);
  const chk = checkSkillDir(r, real);
  const stop = blocked(chk);
  if (stop) throw new SkillOpError(stop, stop === 'noSkillMd' ? src : chk.dir);
  const dest = freeDest(r, chk.dir);
  mkdirSync(dirname(dest), { recursive: true });
  if (mode === 'link') symlinkSync(real, dest);
  else renameSync(copyToTmp(real, dest), dest);
  return dest;
}

export interface SkillClone { dir: string; candidates: { name: string; path: string }[] }

/** §5.5 add from git, step 1: `git clone --depth 1` into a temp dir → `SKILL.md` at the root or in `skills/*\/`. */
export async function cloneSkillRepo(url: string, exec: Exec): Promise<SkillClone> {
  if (!url.trim() || url.trim().startsWith('-')) throw new SkillOpError('badUrl', url);
  const dir = mkdtempSync(join(tmpdir(), 'cc-slaves-skill-'));
  try {
    const repo = join(dir, 'repo');
    const res = await exec(['env', 'GIT_TERMINAL_PROMPT=0', 'git', 'clone', '--depth', '1', '--quiet', '--', url.trim(), repo], { timeoutMs: GIT_TIMEOUT_MS });
    if (res.code !== 0) throw new SkillOpError('gitFailed', res.stderr.trim().split('\n')[0] ?? '');
    const candidates: SkillClone['candidates'] = [];
    if (hasSkillMd(repo)) {
      const fromRepo = basename(url.trim().replace(/\/+$/, '')).replace(/\.git$/, '');
      candidates.push({ name: parseSkillMd(readFileSync(join(repo, 'SKILL.md'), 'utf8'), fromRepo).name, path: repo });
    }
    const sub = join(repo, 'skills');
    if (existsSync(sub)) {
      for (const d of readdirSync(sub).sort()) if (hasSkillMd(join(sub, d))) candidates.push({ name: d, path: join(sub, d) });
    }
    if (candidates.length === 0) throw new SkillOpError('noSkillsInRepo', url);
    return { dir, candidates };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** §5.5 add from git, step 2: move the picked candidates to `~/.claude/skills/<name>`; any name taken → nothing written. */
export function installFromClone(r: SkillRoots, clone: SkillClone, names: readonly string[]): string[] {
  const picked = names.map((n) => {
    const c = clone.candidates.find((x) => x.name === n);
    if (!c) throw new SkillOpError('notFound', n);
    const stop = blocked(checkSkillDir(r, c.path, n));
    if (stop && stop !== 'exists') throw new SkillOpError(stop, n);
    return { from: c.path, to: freeDest(r, n) };
  });
  mkdirSync(userSkillsDir(r), { recursive: true });
  for (const p of picked) moveDir(p.from, p.to);
  return picked.map((p) => p.to);
}

export function disposeClone(clone: SkillClone): void {
  rmSync(clone.dir, { recursive: true, force: true });
}

// ---------- remove ----------

const two = (n: number) => String(n).padStart(2, '0');

/** §5.5 A5 `<home>/.Trash/<name> <HH.MM.SS>` (a taken name gets ` 2`, ` 3`, …); also v2.9 R12 (a deleted workflow pack). */
export function moveToTrash(home: string, path: string, at: Date): string {
  const trash = join(home, '.Trash');
  mkdirSync(trash, { recursive: true });
  const stem = `${basename(path)} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`;
  let dest = join(trash, stem);
  for (let i = 2; isEntry(dest); i++) dest = join(trash, `${stem} ${i}`);
  moveDir(path, dest);
  return dest;
}

/** §5.5 remove: link → unlink (target kept, A4); real folder → Trash (A5). Plugin / project skills: refused. */
export function removeSkill(r: SkillRoots, skill: { scope: string; path: string }, now: () => Date = () => new Date()): { trashed: string | null } {
  if (skill.scope !== 'user') throw new SkillOpError('refused', skill.scope);
  const path = skillEntry(r, skill.path);
  if (lstatSync(path).isSymbolicLink()) {
    unlinkSync(path);
    return { trashed: null };
  }
  return { trashed: moveToTrash(r.home, path, now()) };
}

// ---------- K11 fixes ----------

const linkIn = (r: SkillRoots, dir: string): string => {
  const path = skillEntry(r, join(userSkillsDir(r), checkName(dir)));
  if (!lstatSync(path).isSymbolicLink()) throw new SkillOpError('notLink', dir);
  return path;
};
/** §5.5 "Chép vào ~/.claude": copy the app folder to a temp beside it, then swap it in for the link in one step. */
export function copyOverAppLink(r: SkillRoots, dir: string): void {
  const path = join(userSkillsDir(r), checkName(dir));
  const real = isEntry(path) && lstatSync(path).isSymbolicLink() ? realOrNull(path) : null;
  if (!real || !appDirOf(realOrNull(r.home) ?? r.home, real)) throw new SkillOpError('notAppLink', dir);
  const tmp = copyToTmp(real, path);
  try { swapEntries(tmp, path); } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  unlinkSync(tmp);
}

/** §5.5 broken link "Gỡ link". */
export function unlinkBroken(r: SkillRoots, dir: string): void {
  const path = linkIn(r, dir);
  if (realOrNull(path) !== null) throw new SkillOpError('notBroken', dir);
  unlinkSync(path);
}

/** §5.5 broken link "Trỏ lại…": the link now points at `target` (a folder holding SKILL.md); swapped atomically. */
export function relinkSkill(r: SkillRoots, dir: string, target: string): void {
  const path = linkIn(r, dir);
  const real = realOrNull(target);
  if (!real || !hasSkillMd(real)) throw new SkillOpError('noSkillMd', target);
  const tmp = tmpBeside(path);
  symlinkSync(real, tmp);
  renameSync(tmp, path);
}
