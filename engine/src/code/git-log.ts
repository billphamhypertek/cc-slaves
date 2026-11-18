// v2.3 §10.2 `git_branches` (base + `unpushed` / `baseError`, lane branches + `dirty`) and `git_log` (pages of 200,
// cached by the tip shas of the asked refs; with the Git tab hidden the engine serves the cache or nothing, never git).
import type { GitBranchesResult, GitCommit, GitLogResult, LaneBranch } from '../../../shared/protocol.ts';
import { baseBranch, unpushed } from '../git/base.ts';
import { dirtyOf } from './git-read.ts';
import { gitError, laneBranches, must, projectGit, type GitCtx, type LaneOnBranch } from './git-ctx.ts';
import { KeyedError } from '../errors.ts';

const PAGE = 200;

/** `stored(lane)` = the lane's last §4.15 measurement (with `measuring`), null = never measured. */
export async function gitBranches(ctx: GitCtx, stored: (lane: string) => LaneBranch | null): Promise<GitBranchesResult> {
  let lanes: LaneOnBranch[];
  try { lanes = await laneBranches(ctx); } catch (e) {
    if (e instanceof KeyedError && e.code === 'git_not_repo') return { base: null, lanes: [], notRepo: true }; // §7 G7 (R17)
    throw e;
  }
  const git = projectGit(ctx, lanes);
  const dirty = async (root: string) => { try { return { dirty: (await dirtyOf(ctx, root)).length }; } catch { return {}; } };
  const b = await baseBranch(git);
  let head: Pick<GitBranchesResult, 'base' | 'baseError'>;
  if (b.kind === 'ok') {
    const up = await unpushed(git, b.name);
    if (typeof up === 'object' && up !== null) throw gitError(up);
    head = { base: { name: b.name, unpushed: up, ...(await dirty(ctx.projectDir)) } };
  } else if (b.kind === 'none') head = { base: null, baseError: { kind: 'none' } };
  else head = { base: null, baseError: { kind: 'unknown', reason: b.reason, ...(b.kind === 'unknown' && b.program ? { program: b.program } : {}) } };
  const out = await mapPool(lanes, LANE_POOL, async (l) => {
    const info = stored(l.lane);
    return { lane: l.lane, name: l.name, branch: info ? { ...info, ...(await dirty(l.root)) } : null };
  });
  return { ...head, lanes: out };
}

/** §10.3 "≤ 2 s với 20 lane": at most 4 git commands in parallel. */
const LANE_POOL = 4;

/** `fn` over `items` with at most `n` running at once; results in the order of `items`. */
async function mapPool<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const SEP = '\x1f';
const FORMAT = `--format=%H${'%x1f'}%P${'%x1f'}%s${'%x1f'}%an${'%x1f'}%at${'%x1f'}%D`;

export function parseLog(out: string): GitCommit[] {
  const list: GitCommit[] = [];
  for (const rec of out.split('\0')) {
    const f = rec.replace(/^\n/, '').split(SEP);
    if (f.length < 6 || !/^[0-9a-f]{40}$/.test(f[0]!)) continue;
    const refs = f[5]!.split(', ').map((r) => r.replace(/^HEAD -> /, '')).filter((r) => r !== '' && r !== 'HEAD');
    list.push({ hash: f[0]!, parents: f[1] ? f[1].split(' ') : [], subject: f[2]!, author: f[3]!, at: Number(f[4]) * 1000, refs });
  }
  return list;
}

interface Entry { refsKey: string; tips: string; commits: GitCommit[]; more: boolean }

export interface LogReq { refs: readonly string[]; limit: number; before?: string | undefined }

/** One cache entry per project (the last asked ref set). */
export class GitLog {
  private readonly cache = new Map<string, Entry>();

  async page(projectId: string, ctx: GitCtx, q: LogReq, visible: boolean): Promise<GitLogResult> {
    const limit = Math.max(1, Math.min(PAGE, Math.floor(q.limit) || PAGE));
    const refsKey = [...q.refs].sort().join('\0');
    let e = this.cache.get(projectId);
    if (!visible) { // §10.2 research §1: no git while the Git tab is hidden
      if (!e || e.refsKey !== refsKey) throw new KeyedError('git_hidden', { key: 'errors.gitHidden' });
      return slice(e, q.before, limit, false);
    }
    const lanes = await laneBranches(ctx);
    const git = projectGit(ctx, lanes);
    const known = await allRefs(git, lanes); // also teaches the runner the base name
    const refs = q.refs.length ? q.refs : known;
    const tips = must(await git.run({ sub: 'for-each-ref', flags: ['--format=%(refname) %(objectname)'], revs: [{ fixed: 'refs/heads/' }] }))
      .split('\n').filter((l) => refs.some((r) => l.startsWith(`refs/heads/${r} `))).sort().join('\n');
    if (!e || e.refsKey !== refsKey || e.tips !== tips) { e = { refsKey, tips, commits: [], more: true }; this.cache.set(projectId, e); }
    const at = q.before === undefined ? 0 : e.commits.findIndex((c) => c.hash === q.before) + 1;
    const restart = q.before !== undefined && at === 0 && e.commits.length > 0;
    const need = (restart ? 0 : at) + limit;
    while (e.commits.length < need && e.more) {
      const got = parseLog(must(await git.run({
        sub: 'log', flags: ['-z', '--topo-order', '--decorate-refs=refs/heads/', FORMAT, `--skip=${e.commits.length}`, `--max-count=${PAGE}`],
        revs: refs.map((branch) => ({ branch })),
      })));
      e.commits.push(...got);
      e.more = got.length === PAGE;
    }
    return slice(e, restart ? undefined : q.before, limit, restart);
  }
}

async function allRefs(git: ReturnType<typeof projectGit>, lanes: readonly LaneOnBranch[]): Promise<string[]> {
  const b = await baseBranch(git);
  if (b.kind === 'unknown' || b.kind === 'forbidden') throw gitError(b);
  return [...(b.kind === 'ok' ? [b.name] : []), ...lanes.map((l) => l.name)];
}

function slice(e: Entry, before: string | undefined, limit: number, restart: boolean): GitLogResult {
  const at = before === undefined ? 0 : e.commits.findIndex((c) => c.hash === before) + 1;
  const commits = e.commits.slice(at, at + limit);
  return { commits, more: at + limit < e.commits.length || e.more, ...(restart ? { restart: true } : {}) };
}
