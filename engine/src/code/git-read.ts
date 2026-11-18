// v2.3 §10.2 `git_changes` / `git_diff`: file lists and both sides of one file, for `{ branch }` (merge-base → tip),
// `{ commit }` (first parent → commit) and `{ dirty: src }` (HEAD of the source → disk). Content only from `cat-file blob`
// or the disk; `diff` only `--name-status` / `--numstat` between two commits; the web builds the diff from `{ old, new }`.
import type { GitBlob, GitChangesResult, GitDiffResult, GitFileChange, GitOf } from '../../../shared/protocol.ts';
import { baseBranch } from '../git/base.ts';
import { mergeTree } from '../git/merge-tree.ts';
import { gitAt, type Git } from '../git/run.ts';
import { gitError, laneBranches, must, projectGit, type GitCtx, type LaneOnBranch } from './git-ctx.ts';
import { badRepoPath, checkPath, forbidden } from './path.ts';
import { classify, readBytes, TEXT_MAX } from './read.ts';
import type { Root } from './src.ts';

/** git's empty tree: the "parent" of a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const SNIFF = 8 * 1024;

/** Resolves a `{ dirty: src }` source to its realpath root (`resolveSrc` of the fs layer). */
export type ResolveSrc = (src: Extract<GitOf, { dirty: unknown }>['dirty']) => Promise<Root>;

/** `status --porcelain --no-renames -z` → entries. */
export function parseStatus(out: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  for (const e of out.split('\0')) {
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), path = e.slice(3);
    if (xy === '??') files.push({ path, status: '?' });
    else if (CONFLICT_XY.has(xy)) files.push({ path, status: 'U', conflict: true });
    else files.push({ path, status: statusOf(xy.trim()[0] ?? 'M') });
  }
  return files;
}
const statusOf = (c: string): GitFileChange['status'] => (c === 'A' || c === 'D' || c === 'T' || c === 'U' ? c : 'M');

/** Uncommitted entries of `root` (`status` runs `-C <root>`, §10.2); throws on a git failure. */
export async function dirtyOf(ctx: GitCtx, root: string): Promise<GitFileChange[]> {
  const git = gitAt(root, { exec: ctx.exec });
  return parseStatus(must(await git.run({ sub: 'status', flags: ['--no-renames', '-z'] })));
}

interface Pair { git: Git; old: string; new: string; base?: string; branch?: string }

async function tipOf(git: Git, branch: string): Promise<string> {
  return must(await git.run({ sub: 'rev-parse', flags: ['--verify'], revs: [{ branch, peel: 'commit' }] })).trim();
}

async function baseName(git: Git): Promise<string> {
  const b = await baseBranch(git);
  if (b.kind === 'ok') return b.name;
  throw gitError(b.kind === 'none' ? { kind: 'unknown', reason: 'base branch not found' } : b);
}

async function firstParent(git: Git, commit: string): Promise<string> {
  const p = must(await git.run({ sub: 'log', flags: ['--max-count=1', '--format=%P'], revs: [{ commit }] })).trim().split(' ')[0];
  return p || EMPTY_TREE;
}

/** The two commits of a `{ branch }` / `{ commit }` view; `{ branch }` must be a lane branch of the project. */
async function pairOf(ctx: GitCtx, of: { branch: string } | { commit: string }, lanes: readonly LaneOnBranch[]): Promise<Pair> {
  const git = projectGit(ctx, lanes);
  if ('commit' in of) return { git, old: await firstParent(git, of.commit), new: of.commit };
  const base = await baseName(git);
  const tip = await tipOf(git, of.branch);
  const mb = must(await git.run({ sub: 'merge-base', revs: [{ branch: base }, { branch: of.branch }] })).trim();
  return { git, old: mb, new: tip, base, branch: of.branch };
}

function parseNumstat(out: string): Map<string, { add?: number; del?: number }> {
  const m = new Map<string, { add?: number; del?: number }>();
  for (const e of out.split('\0')) {
    const r = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(e);
    if (r) m.set(r[3]!, r[1] === '-' ? {} : { add: Number(r[1]), del: Number(r[2]) });
  }
  return m;
}

export async function gitChanges(ctx: GitCtx, of: GitOf, resolve: ResolveSrc): Promise<GitChangesResult> {
  if ('dirty' in of) return { files: await dirtyOf(ctx, (await resolve(of.dirty)).root) };
  const lanes = await laneBranches(ctx);
  const p = await pairOf(ctx, of, lanes);
  const revs = [{ commit: p.old }, { commit: p.new }];
  const names = must(await p.git.run({ sub: 'diff', flags: ['--name-status', '--no-renames', '-z'], revs })).split('\0');
  const nums = parseNumstat(must(await p.git.run({ sub: 'diff', flags: ['--numstat', '--no-renames', '-z'], revs })));
  let conflicts = new Set<string>();
  if (p.base && p.branch) {
    const mt = await mergeTree(p.git, p.base, p.branch);
    if (mt.kind === 'unknown' || mt.kind === 'forbidden') throw gitError(mt);
    if (mt.kind === 'conflict') conflicts = new Set(mt.files);
  }
  const files: GitFileChange[] = [];
  for (let i = 0; i + 1 < names.length; i += 2) {
    const path = names[i + 1]!;
    files.push({ path, status: statusOf(names[i]!), ...nums.get(path), ...(conflicts.has(path) ? { conflict: true } : {}) });
  }
  return { files };
}

const asText = (s: string): GitBlob => (s.slice(0, SNIFF).includes('\0') ? { kind: 'binary' } : { kind: 'text', text: s.replace(/\r\n/g, '\n') });

/** `<commit>:<path>` through `ls-tree -l` (type, size) then `cat-file blob`; absent / submodule / > 2 MB never read. */
async function blobAt(git: Git, commit: string, path: string): Promise<GitBlob> {
  const ls = must(await git.run({ sub: 'ls-tree', flags: ['-l', '-z', '--full-tree'], revs: [{ commit }], paths: [path] }));
  const m = /^\d+ (\w+) ([0-9a-f]{40}) +(\d+|-)\t/.exec(ls);
  if (!m) return { kind: 'absent' };
  if (m[1] !== 'blob') return { kind: 'binary' };
  if (Number(m[3]) > TEXT_MAX) return { kind: 'large' };
  return asText(must(await git.run({ sub: 'cat-file', flags: ['blob'], revs: [{ commit: m[2]! }] })));
}

function diskBlob(root: string, path: string): GitBlob {
  const c = checkPath(root, path, { allowMissing: true });
  if (!c.exists) return { kind: 'absent' };
  const r = classify(c.real, readBytes(c.real));
  if (r.kind === 'text') return { kind: 'text', text: r.text ?? '' };
  return { kind: r.kind === 'large' ? 'large' : 'binary' };
}

/** 1-based line ranges `<<<<<<<` … `>>>>>>>` of a trial-merged file. */
export function conflictHunks(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  text.split('\n').forEach((l, i) => {
    if (l.startsWith('<<<<<<<')) start = i + 1;
    else if (l.startsWith('>>>>>>>') && start > 0) { out.push({ start, end: i + 1 }); start = 0; }
  });
  return out;
}

async function conflictOf(p: Pair, path: string): Promise<GitDiffResult['conflict']> {
  if (!p.base || !p.branch) return undefined;
  const mt = await mergeTree(p.git, p.base, p.branch, { readMerged: [path], maxBytes: TEXT_MAX });
  if (mt.kind === 'unknown' || mt.kind === 'forbidden') throw gitError(mt);
  if (mt.kind !== 'conflict' || mt.merged?.[path] === undefined) return undefined;
  const raw = mt.merged[path];
  const merged: GitBlob = raw === null ? { kind: 'large' } : asText(raw);
  const last = must(await p.git.run({ sub: 'log', flags: ['--max-count=1', '--format=%H'], revs: [{ branch: p.base }], paths: [path] })).trim();
  return { hunks: merged.kind === 'text' ? conflictHunks(merged.text) : [], lastBaseCommit: last || null, merged };
}

export async function gitDiff(ctx: GitCtx, path: string, of: GitOf, resolve: ResolveSrc): Promise<GitDiffResult> {
  if (badRepoPath(path)) throw forbidden(); // before any git call
  const lanes = await laneBranches(ctx);
  if ('dirty' in of) {
    const r = await resolve(of.dirty);
    const git = projectGit(ctx, lanes);
    const own = r.base ? null : lanes.find((l) => l.root === r.root);
    if (!r.base && !own) throw gitError({ kind: 'unknown', reason: 'lane has no branch' });
    const head = own
      ? await tipOf(git, own.name)
      : must(await git.run({ sub: 'rev-parse', flags: ['--verify'], revs: [{ fixed: 'HEAD' }] })).trim();
    return { old: await blobAt(git, head, path), new: diskBlob(r.root, path) };
  }
  const p = await pairOf(ctx, of, lanes);
  const old = p.old === EMPTY_TREE ? { kind: 'absent' as const } : await blobAt(p.git, p.old, path);
  const conflict = await conflictOf(p, path);
  return { old, new: await blobAt(p.git, p.new, path), ...(conflict ? { conflict } : {}) };
}
