// v2.3 §10.2 "Nguồn hợp lệ" + §5.3 khoá sửa. A lane source is valid only when the realpath of its cwd is the project dir
// or is listed by `git worktree list --porcelain` of the project repo (a lane started with `cwd=/Users/<po>` is not a
// source). A listed root must also be a real linked worktree of the project: `<root>/.git` a regular file (lstat) whose
// `gitdir:` realpath is `<common dir>/worktrees/<id>`, and that dir's `gitdir` file names `<root>/.git` back (review
// IMPORTANT-1: a worktree dir, or one of its parents, swapped for a symlink to `~`). The edit lock compares realpaths by
// directory, not by the lane being viewed (v2.1 lets a done lane and a live lane share one cwd; a lane may run in a sub-dir
// or through a symlink).
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { LaneState, OrchestratorState, Src } from '../../../shared/protocol.ts';
import { KeyedError } from '../errors.ts';
import { forbidden } from './path.ts';

/** What E3 wires from engine state; every fs command reads it fresh. */
export interface CodeFsDeps {
  /** The project's dir, null = no such project. */
  projectDir(projectId: string): string | null;
  /** cwd of the project's lane `name` (db row), null = no such lane. */
  laneCwd(projectId: string, name: string): string | null;
  /** Worktree paths of the repo at `projectDir` (`git worktree list --porcelain`, E1's runner). */
  worktreeRoots(projectDir: string): Promise<string[]>;
  /** `ls-files -o -i --exclude-standard --directory -z` run in `root`: root-relative, dirs end in `/`; null = not a git repo. */
  ignored(root: string): Promise<string[] | null>;
  /** Live lanes + orchestrator of the project for §5.3, read right before a write. */
  lockState(projectId: string): LockState;
}

export interface LockState { lanes: { name: string; state: LaneState; cwd: string }[]; orchestrator: OrchestratorState | null }

export interface Root { root: string; base: boolean }

const realOrNull = (p: string) => { try { return realpathSync.native(p); } catch { return null; } };

export async function resolveSrc(deps: CodeFsDeps, projectId: string, src: Src): Promise<Root> {
  const dir = deps.projectDir(projectId);
  if (dir === null) throw new KeyedError('no_project', { key: 'errors.noProject' });
  const base = realOrNull(dir);
  if (base === null) throw forbidden();
  if (src.kind === 'base') return { root: base, base: true };
  const cwd = deps.laneCwd(projectId, src.laneId);
  const root = cwd === null ? null : realOrNull(cwd);
  if (root === null) throw forbidden();
  if (root === base) return { root, base: false };
  const roots = (await deps.worktreeRoots(dir)).map(realOrNull);
  if (!roots.includes(root) || !linkedWorktree(root, base)) throw forbidden();
  return { root, base: false };
}

const readOrNull = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const isFile = (p: string) => { try { return lstatSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };

/** `gitdir: <path>` of a `.git` file (a relative path resolves against the file's dir). */
function gitdirOf(gitFile: string): string | null {
  const m = /^gitdir: (.+?)\r?\n?$/.exec(readOrNull(gitFile) ?? '');
  return m ? resolve(dirname(gitFile), m[1]!) : null;
}

/** Realpath of the git common dir of the repo holding `base` (nearest `.git` up): that dir, or (a linked worktree) its `commondir`. */
function commonDirOf(base: string): string | null {
  let top = base;
  while (!isDir(join(top, '.git')) && !isFile(join(top, '.git')) && dirname(top) !== top) top = dirname(top);
  const dotGit = join(top, '.git');
  if (isDir(dotGit)) return realOrNull(dotGit);
  const gd = isFile(dotGit) ? gitdirOf(dotGit) : null;
  const rel = gd === null ? null : readOrNull(join(gd, 'commondir'));
  return gd === null ? null : realOrNull(rel === null ? gd : resolve(gd, rel.trim()));
}

/** §10.2 `root` (a realpath) is a linked worktree of the repo at `base`, with no component swapped since `git worktree add`. */
function linkedWorktree(root: string, base: string): boolean {
  const dotGit = join(root, '.git');
  if (!isFile(dotGit)) return false;
  const gd = gitdirOf(dotGit);
  const admin = gd === null ? null : realOrNull(gd);
  const common = commonDirOf(base);
  if (admin === null || common === null || dirname(admin) !== join(common, 'worktrees')) return false;
  return readOrNull(join(admin, 'gitdir'))?.trim() === dotGit;
}

/** v2.1 `LaneState` not live: the lane holds no session in its cwd. */
const DEAD: ReadonlySet<LaneState> = new Set(['done', 'stopped', 'broken']);
const ORCH_FREE: ReadonlySet<OrchestratorState> = new Set(['idle', 'stopped']);

const within = (a: string, b: string) => a === b || a.startsWith(b + sep);

/** §5.3 ③ ④: throws `lane_running` when a live lane's cwd equals / is inside / contains the root, or (project dir) the orchestrator is busy. */
export function checkLock(r: Root, st: LockState): void {
  for (const l of st.lanes) {
    if (DEAD.has(l.state)) continue;
    const c = realOrNull(l.cwd) ?? resolve(l.cwd);
    if (within(c, r.root) || within(r.root, c)) {
      throw new KeyedError('lane_running', { key: 'errors.codeLaneRunning', params: { lane: l.name } });
    }
  }
  if (r.base && st.orchestrator !== null && !ORCH_FREE.has(st.orchestrator)) {
    throw new KeyedError('lane_running', { key: 'errors.codeOrchestratorRunning' });
  }
}
