import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProductFile, PRODUCT_DIRS } from './measure';

/** Git adapters of `check:structure`: the working copy (tracked + untracked, not ignored) and one file of a ref. */

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  return r;
};
const ok = (cwd: string, args: string[]): Buffer => {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout;
};

/** Product files of the working copy, including untracked ones a commit would add; deleted files are skipped. */
export function workingTree(root: string): Map<string, string> {
  const paths = ok(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...PRODUCT_DIRS])
    .toString('utf8').split('\0').filter((p) => p !== '');
  const out = new Map<string, string>();
  for (const p of [...new Set(paths)].filter(isProductFile).sort()) {
    try { out.set(p, readFileSync(join(root, p), 'utf8')); } catch { /* deleted in the working copy */ }
  }
  return out;
}

export const topLevel = (cwd: string): string => ok(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();

/** `git merge-base <a> <b>`, or undefined when either does not resolve or they share no history. */
export function mergeBase(root: string, a: string, b: string): string | undefined {
  const r = git(root, ['merge-base', a, b]);
  return r.status === 0 ? r.stdout.toString('utf8').trim() : undefined;
}

/** One file of a ref (`git show <ref>:<path>`), or undefined when the ref or the file does not exist there. */
export function refFile(root: string, ref: string, path: string): string | undefined {
  const r = git(root, ['show', `${ref}:${path}`]);
  return r.status === 0 ? r.stdout.toString('utf8') : undefined;
}
