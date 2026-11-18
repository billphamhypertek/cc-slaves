// v2.1 §4.15 §3 / Engine: measure a lane's own branch against the project base — only measures, never merges (W22).
// Every git call goes through the v2.3 §10.2 runner (`git/run.ts`), `-C <project repo>`, under one 5 s budget.
// merged = `merge-base --is-ancestor` (plain merge) or a clean `merge-tree` giving exactly `<base>^{tree}`
// (squash / rebase). Known limit: squash, then base edits the same lines → conflict → "unmerged"; a merged PR (`gh`) wins.
// v2.3 §10.2: the base is a local branch (`git/base.ts`), the pre-merge check also yields the conflicted files, and a
// measurement during which the base or the lane branch moved is marked `moved` (the caller discards it).
import { realpathSync } from 'node:fs';
import type { LaneBranch } from '../../../shared/protocol.ts';
import { countUnmergedDone, getLane, getLaneBranch, getLaneById, setLaneBranch, trackedBranchLanes, type Db, type Lane } from '../db.ts';
import { baseBranch } from '../git/base.ts';
import { mergeTree } from '../git/merge-tree.ts';
import { gitAt, GIT_TIMEOUT_MS, okOut, type Git, type GitResult } from '../git/run.ts';
import { worktrees } from '../git/worktrees.ts';
import type { Exec } from '../setup/setup.ts';

export const BRANCH_TIMEOUT_MS = GIT_TIMEOUT_MS;

export type GhLookup = (repo: string, branch: string) => Promise<LaneBranch['pr'] | null>;
export interface MeasureOpts { exec: Exec; gh?: GhLookup; now?: () => number; timeoutMs?: number }
/** `tip`: the lane branch commit measured (v2.3 §10.2 (c) "đo nhánh thấy commit mới"); `moved`: discard this measure. */
export interface Measure { info: LaneBranch; tip?: string; moved?: true }

class GitFail extends Error {}
const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

/** ok → the result (any exit); unknown / forbidden → `GitFail(reason)`. */
async function must(p: Promise<GitResult>): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await p;
  if (r.kind !== 'ok') throw new GitFail(r.reason);
  return r;
}
const failOf = (r: { code: number; stderr: string }) => new GitFail(firstLine(r.stderr) || `git exit ${r.code}`);
async function out(p: Promise<GitResult>): Promise<string> {
  const r = okOut(await p);
  if (!('out' in r)) throw new GitFail(r.reason);
  return r.out.trim();
}

async function baseOf(git: Git): Promise<string> {
  const b = await baseBranch(git);
  if (b.kind === 'ok') return b.name;
  throw new GitFail(b.kind === 'none' ? 'base branch not found' : b.reason);
}
/** The commit a local branch points at; null = no such branch. */
async function tip(git: Git, name: string): Promise<string | null> {
  const r = await must(git.run({ sub: 'rev-parse', flags: ['--verify', '--quiet'], revs: [{ branch: name, peel: 'commit' }] }));
  if (r.code === 1) return null;
  if (r.code !== 0) throw failOf(r);
  return r.stdout.trim();
}

/** `git diff --numstat` lines → files / added / deleted (binary files count as a file with 0 lines). */
function parseNumstat(s: string): { files: number; add: number; del: number } {
  let files = 0, add = 0, del = 0;
  for (const l of s.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(l);
    if (!m) continue;
    files++;
    add += Number(m[1]) || 0;
    del += Number(m[2]) || 0;
  }
  return { files, add, del };
}

export async function measureBranch(repo: string, laneBranch: string | null, o: MeasureOpts): Promise<Measure> {
  const now = o.now ?? Date.now;
  const zero = { ahead: 0, files: 0, add: 0, del: 0 };
  if (laneBranch === null) return { info: { name: null, base: null, state: 'none', ...zero, measuredAt: now() } };
  const git = gitAt(repo, { exec: o.exec, timeoutMs: o.timeoutMs ?? BRANCH_TIMEOUT_MS, branches: [laneBranch] });
  let base: string | null = null;
  try {
    base = await baseOf(git);
    const baseSha = await tip(git, base);
    if (baseSha === null) throw new GitFail(`base ${base} not found`);
    const laneSha = await tip(git, laneBranch);
    if (laneSha === null) return { info: { name: laneBranch, base, state: 'gone', ...zero, measuredAt: now() } };
    const pr = o.gh ? await o.gh(repo, laneBranch).catch(() => null) : null;
    const withPr = pr ? { pr } : {};
    const done = async (info: LaneBranch): Promise<Measure> => {
      const moved = (await tip(git, base!)) !== baseSha || (await tip(git, laneBranch)) !== laneSha;
      return moved ? { info: unknown(laneBranch, 'branch moved during the measure', now()), moved: true } : { info, tip: laneSha };
    };
    const merged = { name: laneBranch, base, state: 'merged' as const, ...zero, ...withPr, measuredAt: now() };
    const anc = await must(git.run({ sub: 'merge-base', flags: ['--is-ancestor'], revs: [{ branch: laneBranch }, { branch: base }] }));
    if (anc.code === 0) return await done(merged);
    if (anc.code !== 1) throw failOf(anc);
    // squash / rebase: merging the branch into base changes nothing → its content is already there.
    const mt = await mergeTree(git, base, laneBranch);
    if (mt.kind === 'unknown' || mt.kind === 'forbidden') throw new GitFail(mt.reason);
    if (mt.kind === 'clean' && mt.tree === await out(git.run({ sub: 'rev-parse', flags: ['--verify'], revs: [{ branch: base, peel: 'tree' }] }))) return await done(merged);
    if (pr?.state === 'merged') return await done(merged); // §4.15 known limit: the second source
    const range = (dots: '..' | '...') => [{ range: [{ branch: base! }, { branch: laneBranch }], dots }] as const;
    const ahead = Number(await out(git.run({ sub: 'rev-list', flags: ['--count'], revs: range('..') }))) || 0;
    // v2.3 §10.2 (V15) commits on base the branch lacks
    const behind = Number(await out(git.run({ sub: 'rev-list', flags: ['--count'], revs: [{ range: [{ branch: laneBranch }, { branch: base }], dots: '..' }] }))) || 0;
    const stat = parseNumstat(await out(git.run({ sub: 'diff', flags: ['--numstat'], revs: range('...') })));
    const conflicts = mt.kind === 'conflict' ? mt.files : [];
    return await done({ name: laneBranch, base, state: 'unmerged', ahead, behind, ...stat, conflicts, ...withPr, measuredAt: now() });
  } catch (err) {
    const reason = err instanceof GitFail ? err.message : String(err);
    return { info: { name: laneBranch, base, state: 'unknown', ...zero, reason, measuredAt: now() } };
  }
}

/**
 * The lane's own branch, read from `git worktree list` of the project repo: its worktree's branch; `null` = no own branch
 * (the lane runs in the repo itself, or detached); `unresolved` = the worktree is not listed (removed) or git failed.
 */
export async function laneBranchName(repo: string, cwd: string, exec: Exec, timeoutMs = BRANCH_TIMEOUT_MS): Promise<{ name: string | null } | { unresolved: true; reason?: string }> {
  const list = await worktrees(gitAt(repo, { exec, timeoutMs }));
  if (!Array.isArray(list)) return { unresolved: true, reason: list.reason };
  const want = real(cwd);
  const i = list.findIndex((w) => w.root === want);
  if (i === 0) return { name: null }; // the main worktree = the project repo itself
  if (i > 0) return { name: list[i]!.branch };
  return real(repo) === want ? { name: null } : { unresolved: true };
}
const real = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };

export interface TrackerDeps {
  db: Db; exec: Exec; gh?: GhLookup; now?: () => number; timeoutMs?: number;
  /** The project repo (project.path); null = project gone. */
  repoOf: (projectId: string) => string | null;
  /** A lane's `branch` changed (measuring started / finished): re-send its view + the project's unmerged count. */
  onChange: (projectId: string, name: string) => void;
  /** v2.3 §10.2 (c) a measure saw a new commit: on the lane branch (`name`) or on the base (`name` null). */
  onCommit?: (projectId: string, name: string | null) => void;
}

const STALE_MS = 60_000;

/**
 * §4.15 Engine triggers around `measureBranch`: one measurement per lane at a time, the old numbers stay visible while a
 * new one runs (`measuring`), every result is stored on the lane row (survives a restart), base moves re-measure.
 */
export class BranchTracker {
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly baseSha = new Map<string, string>();
  /** Lane id → the branch commit of its last kept measure (memory only: the first measure after a boot never fires). */
  private readonly tips = new Map<number, string>();
  constructor(private readonly d: TrackerDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  info(laneId: number): LaneBranch | null {
    const i = getLaneBranch(this.d.db, laneId).info;
    if (!i) return null;
    return this.inflight.has(laneId) ? { ...i, measuring: true } : { ...i, measuring: false };
  }

  unmergedCount(projectId: string): number { return countUnmergedDone(this.d.db, projectId); }

  measure(lane: Lane): Promise<void> {
    const running = this.inflight.get(lane.id);
    if (running) return running;
    const p = this.run(lane).finally(() => {
      this.inflight.delete(lane.id);
      this.d.onChange(lane.projectId, lane.name);
    });
    this.inflight.set(lane.id, p);
    this.d.onChange(lane.projectId, lane.name); // "đang đo…" with the old numbers
    return p;
  }

  /** §4.15 done-lane view opened: re-measure only when the last measurement is older than 60 s. */
  measureIfStale(lane: Lane, maxAgeMs = STALE_MS): Promise<void> {
    const i = getLaneBranch(this.d.db, lane.id).info;
    if (i && this.now() - i.measuredAt < maxAgeMs) return Promise.resolve();
    return this.measure(lane);
  }

  private async run(lane: Lane): Promise<void> {
    const repo = this.d.repoOf(lane.projectId);
    const timeoutMs = this.d.timeoutMs ?? BRANCH_TIMEOUT_MS;
    const opts: MeasureOpts = { exec: this.d.exec, now: () => this.now(), timeoutMs, ...(this.d.gh ? { gh: this.d.gh } : {}) };
    if (!repo) { setLaneBranch(this.d.db, lane.id, { info: unknown(null, 'project gone', this.now()) }); return; }
    const found = await laneBranchName(repo, lane.cwd, this.d.exec, timeoutMs);
    let name: string | null;
    if ('name' in found) { name = found.name; setLaneBranch(this.d.db, lane.id, { name }); }
    else {
      const stored = getLaneBranch(this.d.db, lane.id).name;
      if (stored === undefined) { setLaneBranch(this.d.db, lane.id, { info: unknown(null, found.reason ?? 'branch not found', this.now()) }); return; }
      name = stored;
    }
    let m = await measureBranch(repo, name, opts);
    if (m.moved) m = await measureBranch(repo, name, opts); // §10.2 a sha moved mid-measure: discard, measure once more
    if (m.moved) return;
    setLaneBranch(this.d.db, lane.id, { info: m.info });
    const prev = this.tips.get(lane.id);
    if (m.tip === undefined) return;
    this.tips.set(lane.id, m.tip);
    if (prev !== undefined && prev !== m.tip) this.d.onCommit?.(lane.projectId, lane.name);
  }

  /**
   * §4.15 the base branch moved (5-min poll while a client is connected): every tracked lane of that project is measured
   * again. The first poll of a project only records its base commit.
   */
  async pollBases(): Promise<void> {
    const byProject = new Map<string, Lane[]>();
    for (const l of trackedBranchLanes(this.d.db)) {
      const list = byProject.get(l.projectId);
      if (list) list.push(l); else byProject.set(l.projectId, [l]);
    }
    for (const [projectId, lanes] of byProject) {
      const repo = this.d.repoOf(projectId);
      if (!repo) continue;
      const sha = await baseCommit(repo, this.d.exec, this.d.timeoutMs ?? BRANCH_TIMEOUT_MS);
      if (sha === null) continue;
      const prev = this.baseSha.get(projectId);
      this.baseSha.set(projectId, sha);
      if (prev === undefined || prev === sha) continue;
      this.d.onCommit?.(projectId, null);
      for (const l of lanes) await this.measure(getLaneById(this.d.db, l.id) ?? l);
    }
  }

  /** Lane by name, for callers that only hold a view. */
  lane(projectId: string, name: string): Lane | null { return getLane(this.d.db, projectId, name); }
}

const unknown = (name: string | null, reason: string, at: number): LaneBranch =>
  ({ name, base: null, state: 'unknown', ahead: 0, files: 0, add: 0, del: 0, reason, measuredAt: at });

/** The commit the project base points at now; null = cannot tell (no repo, timeout). */
async function baseCommit(repo: string, exec: Exec, timeoutMs = BRANCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const git = gitAt(repo, { exec, timeoutMs });
    return await tip(git, await baseOf(git));
  } catch { return null; }
}

/** `gh pr list --head <branch>` run in the repo (newest first): merged wins over open over closed. Null when gh has nothing. */
export function ghLookup(exec: Exec, ghPath: string, timeoutMs = BRANCH_TIMEOUT_MS): GhLookup {
  return async (repo, branch) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const r = await Promise.race([
      // gh finds the GitHub repo from its cwd (Exec has no cwd option → a one-line sh `cd`).
      exec(['/bin/sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', repo, ghPath, 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state', '--limit', '5'], { timeoutMs }),
      new Promise<null>((res) => { timer = setTimeout(() => res(null), timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!r || r.code !== 0) return null;
    try {
      const prs = JSON.parse(r.stdout) as { number: number; state: string }[];
      const pick = prs.find((p) => p.state === 'MERGED') ?? prs.find((p) => p.state === 'OPEN') ?? prs[0];
      return pick ? { number: pick.number, state: pick.state.toLowerCase() as 'open' | 'merged' | 'closed' } : null;
    } catch { return null; }
  };
}

type LaneMark = { state: string; phase: string | null };
const finished = (l: LaneMark) => l.state === 'done' || l.phase === 'done';

/**
 * §4.15 Engine: measure when the lane reports done (`lane_set_phase done`) or enters done (`lane_finish`). `prev`
 * undefined = the first view since the engine started: measure a finished lane that has no measurement yet.
 */
export function branchTrigger(prev: LaneMark | undefined, next: LaneMark, measured: boolean): boolean {
  if (!prev) return finished(next) && !measured;
  return (prev.phase !== 'done' && next.phase === 'done') || (prev.state !== 'done' && next.state === 'done');
}
