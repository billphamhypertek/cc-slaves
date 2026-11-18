// v2.3 §10.2 "Đường dẫn": a web path is relative, resolved with `realpathSync.native` (keeps the on-disk case of `.git`
// on APFS), must stay inside the source root, and no segment may be `.git` in any case. Opens use `O_NOFOLLOW`, then the fd's
// `fstat` must match the `lstat` just checked (dev + ino) — closes the swap-between-check-and-open window.
import { closeSync, constants, fstatSync, openSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { KeyedError } from '../errors.ts';

export const forbidden = () => new KeyedError('forbidden', { key: 'errors.codeForbidden' });
/** §5.4 "File đã bị xoá": the path is inside the root but nothing is there. */
const gone = () => new KeyedError('gone', { key: 'errors.codeGone' });

/** §10.2 every segment, case-insensitive (`.GIT` on APFS is the same dir). */
export const isGitSegment = (name: string) => name.toLowerCase() === '.git';

const hasGitSegment = (rel: string) => rel.split(/[\\/]/).some(isGitSegment);

/** §10.2 a repo path for git (never joined to a dir): relative, no NUL, no `..` or `.git` segment. */
export const badRepoPath = (rel: unknown): boolean =>
  typeof rel !== 'string' || rel === '' || rel.includes('\0') || isAbsolute(rel) || hasGitSegment(rel) || rel.split(/[\\/]/).includes('..');

const isErrno = (e: unknown, code: string) => (e as NodeJS.ErrnoException | null)?.code === code;

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);

/** Root-relative form of a real path inside `root` ('' = the root), `/`-separated. */
export const relOf = (root: string, real: string) => relative(root, real).split(sep).join('/');

export interface Checked {
  /** The realpath (or, for a missing file with `allowMissing`, realpath of the parent + the name). */
  real: string;
  /** `root` + the web path, not resolved: what `lstat` checks for "is this a symlink" (§5.3 ②). */
  joined: string;
  exists: boolean;
}

/**
 * `root` must already be a realpath. `rel` '' = the root itself. Throws `forbidden` on an absolute path, `..` out of the
 * root, a symlink out of the root, a `.git` segment (before and after resolving) or a NUL byte; `gone` when nothing is there.
 */
export function checkPath(root: string, rel: string, o: { allowMissing?: boolean } = {}): Checked {
  if (typeof rel !== 'string' || rel.includes('\0') || isAbsolute(rel) || hasGitSegment(rel)) throw forbidden();
  const joined = join(root, rel);
  if (!inside(root, joined)) throw forbidden();
  let real: string;
  let exists = true;
  try {
    real = realpathSync.native(joined);
  } catch (e) {
    if (!isErrno(e, 'ENOENT')) throw e;
    exists = false;
    try { real = join(realpathSync.native(dirname(joined)), basename(joined)); } catch { throw forbidden(); }
  }
  if (!inside(root, real) || hasGitSegment(relOf(root, real))) throw forbidden();
  if (!exists && !o.allowMissing) throw gone();
  return { real, joined, exists };
}

/** Opens `real` read-only without following a final symlink; the fd must be the file `lst` described. Returns the fd. */
export function openChecked(real: string, lst: Stats): number {
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (isErrno(e, 'ELOOP') || isErrno(e, 'ENOENT')) throw forbidden();
    throw e;
  }
  const st = fstatSync(fd);
  if (st.dev !== lst.dev || st.ino !== lst.ino) { closeSync(fd); throw forbidden(); }
  return fd;
}
