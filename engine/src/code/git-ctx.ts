// v2.3 §10.2 shared ground of the Git commands: which lanes of a project have their own worktree + branch (the only
// branch names the runner accepts, with the base), the runner for the project dir, and git failures → keyed errors.
import { realpathSync } from 'node:fs';
import { KeyedError } from '../errors.ts';
import { gitAt, okOut, type Git, type GitFailure, type GitResult } from '../git/run.ts';
import { worktrees } from '../git/worktrees.ts';
import type { Exec } from '../setup/setup.ts';
import { forbidden } from './path.ts';

export interface GitCtx {
  exec: Exec;
  /** project.path as stored (every command but `status` of `{ dirty }` runs `-C` here). */
  projectDir: string;
  /** Lanes of the project, oldest first (db rows). */
  lanes: readonly { name: string; cwd: string }[];
}

/** A lane in its own worktree: `name` = its branch. Several lanes on one worktree → the newest one. */
export interface LaneOnBranch { lane: string; name: string; root: string }

const real = (p: string) => { try { return realpathSync.native(p); } catch { return null; } };

/** git's own words for a dir outside any repo (first stderr line, `okOut`). */
const NOT_REPO = /^fatal: not a git repository/i;

/** Throws the git failure as a keyed error: `forbidden` (a name / commit / path the runner refused), `not_repo` (§7 G7, R17:
 *  the web reads this code, never git's text) or `unknown`. */
export function gitError(f: GitFailure): KeyedError {
  if (f.kind === 'forbidden') return forbidden();
  if (NOT_REPO.test(f.reason)) return new KeyedError('git_not_repo', { key: 'errors.gitNotRepo' });
  if (f.kind === 'unknown' && f.program) return new KeyedError('git_unknown', { key: 'errors.gitProgram', params: { key: f.program } });
  return new KeyedError('git_unknown', { key: 'errors.gitUnknown', params: { reason: f.reason } });
}

/** ok + exit 0 → stdout, else throws `gitError`. */
export function must(r: GitResult): string {
  const o = okOut(r);
  if (!('out' in o)) throw gitError(o);
  return o.out;
}

export async function laneBranches(ctx: GitCtx): Promise<LaneOnBranch[]> {
  const list = await worktrees(gitAt(ctx.projectDir, { exec: ctx.exec }));
  if (!Array.isArray(list)) throw gitError(list);
  const byRoot = new Map<string, LaneOnBranch>();
  for (const w of list.slice(1)) if (w.branch !== null) byRoot.set(w.root, { lane: '', name: w.branch, root: w.root });
  const out = new Map<string, LaneOnBranch>();
  for (const l of ctx.lanes) {
    const r = real(l.cwd);
    const w = r === null ? undefined : byRoot.get(r);
    if (w) out.set(w.root, { ...w, lane: l.name }); // later (newer) rows win
  }
  return [...out.values()];
}

/** The project-dir runner, knowing every lane branch (the base is learnt by `baseBranch`). */
export const projectGit = (ctx: GitCtx, lanes: readonly LaneOnBranch[]): Git =>
  gitAt(ctx.projectDir, { exec: ctx.exec, branches: lanes.map((l) => l.name) });
