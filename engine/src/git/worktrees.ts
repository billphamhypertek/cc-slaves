// spec v2.3 §10.2 "Nguồn hợp lệ": the worktrees of the project repo (`worktree list --porcelain`, run `-C <project dir>`),
// each as its realpath + branch. A lane source is valid only when its root is one of these roots (or the project dir);
// `lane/branch.ts` `laneBranchName` reads the lane's own branch from the same list. A listed path that is now a symlink
// keeps its listed form (it then matches no realpath): it no longer is the worktree git added (review IMPORTANT-1).
import { lstatSync, realpathSync } from 'node:fs';
import { okOut, type Git, type GitFailure } from './run.ts';

export interface Worktree { root: string; branch: string | null }

const real = (p: string) => { try { return lstatSync(p).isSymbolicLink() ? p : realpathSync.native(p); } catch { return p; } };

/** Main worktree first (git's order); `branch` null = detached. */
export async function worktrees(git: Git): Promise<Worktree[] | GitFailure> {
  const r = okOut(await git.run({ sub: 'worktree list', flags: ['--porcelain', '-z'] }));
  if (!('out' in r)) return r;
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of r.out.split('\0')) {
    if (line.startsWith('worktree ')) { cur = { root: real(line.slice(9)), branch: null }; list.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return list;
}
