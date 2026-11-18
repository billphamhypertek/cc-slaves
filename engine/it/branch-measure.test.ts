// v2.1 §4.15 §3 / Engine: branch / merge measurement on real temp git repos (no network; `gh` is injected).
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchTrigger, laneBranchName, measureBranch, type GhLookup } from '../src/lane/branch.ts';
import { execIn, type Exec } from '../src/setup/setup.ts';

setDefaultTimeout(30_000); // real git spawns (~50 ms each on this Mac)
let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function commit(cwd: string, file: string, body: string, msg = file): void {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
}
/** A lane worktree on its own branch `lane/x`, with two commits (a.txt, b.txt). */
function laneWorktree(name = 'lane/x'): string {
  const wt = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', name, wt, 'main');
  commit(wt, 'a.txt', 'one\ntwo\n');
  commit(wt, 'b.txt', 'three\n');
  return wt;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-branch-')));
  repo = join(root, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  commit(repo, 'README', 'base\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const m = async (branch: string | null, o: { exec?: Exec; gh?: GhLookup; timeoutMs?: number } = {}) =>
  (await measureBranch(repo, branch, { exec: o.exec ?? execIn(process.env), now: () => 1000, ...(o.gh ? { gh: o.gh } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) })).info;

describe('§4.15 Engine measureBranch', () => {
  test('§4.15 unmerged: commits ahead + files / +add / −del vs base', async () => {
    laneWorktree();
    const b = await m('lane/x');
    expect(b).toMatchObject({ name: 'lane/x', base: 'main', state: 'unmerged', ahead: 2, files: 2, add: 3, del: 0, measuredAt: 1000 });
  });

  test('§4.15 merged (fast-forward) → merged', async () => {
    laneWorktree();
    git(repo, 'merge', '-q', '--ff-only', 'lane/x');
    expect(await m('lane/x')).toMatchObject({ state: 'merged', ahead: 0, files: 0 });
  });

  test('§4.15 §3 squash merge → merged (merge-tree compares trees, not commits)', async () => {
    laneWorktree();
    git(repo, 'merge', '-q', '--squash', 'lane/x');
    git(repo, 'commit', '-q', '-m', 'squash');
    expect(await m('lane/x')).toMatchObject({ state: 'merged' });
  });

  test('§4.15 §3 rebase merge → merged (base moved on, lane commits replayed)', async () => {
    commit(repo, 'other.txt', 'base moved\n'); // base gets its own commit after the fork point
    const wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'lane/x', wt, 'main~1');
    commit(wt, 'a.txt', 'one\n');
    commit(wt, 'b.txt', 'two\n');
    git(repo, 'cherry-pick', 'main..lane/x'); // what "rebase and merge" leaves on base
    expect(await m('lane/x')).toMatchObject({ state: 'merged' });
  });

  test('§4.15 branch deleted → gone', async () => {
    laneWorktree();
    git(repo, 'worktree', 'remove', '--force', join(root, 'wt'));
    git(repo, 'branch', '-D', 'lane/x');
    expect(await m('lane/x')).toMatchObject({ name: 'lane/x', state: 'gone' });
  });

  test('§4.15 §3 no own branch → none', async () => {
    expect(await m(null)).toMatchObject({ name: null, state: 'none' });
  });

  test('§4.15 Trạng thái: repo not a git repo → unknown + reason', async () => {
    const b = (await measureBranch(join(root, 'nope'), 'lane/x', { exec: execIn(process.env), now: () => 1 })).info;
    expect(b.state).toBe('unknown');
    expect(b.reason).toBeTruthy();
  });

  test('§4.15 Trạng thái: locked repo (git refuses) → unknown + reason', async () => {
    laneWorktree();
    const locked: Exec = async () => ({ code: 128, stdout: '', stderr: "fatal: Unable to create '/r/.git/index.lock': File exists." });
    const b = await m('lane/x', { exec: locked });
    expect(b.state).toBe('unknown');
    expect(b.reason).toContain('index.lock');
  });

  test('§4.15 Trạng thái: git over the 5 s budget → unknown "timeout"', async () => {
    const hang: Exec = () => new Promise(() => {});
    const t0 = Date.now();
    const b = await m('lane/x', { exec: hang, timeoutMs: 50 });
    expect(b).toMatchObject({ state: 'unknown', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('§4.15 v2.3 §10.2 V10 base = the local branch origin/HEAD names', async () => {
    const origin = join(root, 'origin.git');
    Bun.spawnSync(['git', 'clone', '-q', '--bare', repo, origin]);
    const clone = join(root, 'clone');
    Bun.spawnSync(['git', 'clone', '-q', origin, clone]);
    git(clone, 'branch', 'lane/y');
    const b = (await measureBranch(clone, 'lane/y', { exec: execIn(process.env), now: () => 1 })).info;
    expect(b).toMatchObject({ base: 'main', state: 'merged' }); // v2.3 §10.2 V10: origin/HEAD → the local branch
  });

  test('§4.15 known limit: squash then base edits the same lines → unmerged without PR, merged with pr? merged', async () => {
    laneWorktree();
    git(repo, 'merge', '-q', '--squash', 'lane/x');
    git(repo, 'commit', '-q', '-m', 'squash');
    commit(repo, 'a.txt', 'ONE\ntwo\n', 'base edits the squashed lines');
    expect(await m('lane/x')).toMatchObject({ state: 'unmerged' }); // the known false "chưa merge"
    const gh: GhLookup = async (r, br) => (r === repo && br === 'lane/x' ? { number: 42, state: 'merged' } : null);
    expect(await m('lane/x', { gh })).toMatchObject({ state: 'merged', pr: { number: 42, state: 'merged' } });
  });

  test('§4.15 an open PR is reported but does not make the branch merged', async () => {
    laneWorktree();
    const b = await m('lane/x', { gh: async () => ({ number: 7, state: 'open' }) });
    expect(b).toMatchObject({ state: 'unmerged', pr: { number: 7, state: 'open' } });
  });

  test('§4.15 a failing gh lookup never turns the measurement into unknown', async () => {
    laneWorktree();
    const b = await m('lane/x', { gh: async () => { throw new Error('gh: not logged in'); } });
    expect(b.state).toBe('unmerged');
    expect(b.pr).toBeUndefined();
  });
});

describe('§4.15 Engine laneBranchName (from the project repo, never the live worktree)', () => {
  test('§4.15 lane worktree on its own branch → that branch', async () => {
    const wt = laneWorktree('lane/q');
    expect(await laneBranchName(repo, wt, execIn(process.env))).toEqual({ name: 'lane/q' });
  });
  test('§4.15 §3 lane running straight in the repo → no own branch', async () => {
    expect(await laneBranchName(repo, repo, execIn(process.env))).toEqual({ name: null });
  });
  test('§4.15 detached worktree → no own branch', async () => {
    const wt = join(root, 'det');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
    expect(await laneBranchName(repo, wt, execIn(process.env))).toEqual({ name: null });
  });
  test('§4.15 worktree not listed (removed) → unresolved', async () => {
    expect(await laneBranchName(repo, join(root, 'gone-wt'), execIn(process.env))).toEqual({ unresolved: true });
  });
  test('§4.15 git runs with -C <repo>, never with the lane cwd', async () => {
    const seen: string[][] = [];
    const spy: Exec = async (argv, o) => { seen.push(argv); return execIn(process.env)(argv, o); };
    const wt = laneWorktree();
    await laneBranchName(repo, wt, spy);
    await measureBranch(repo, 'lane/x', { exec: spy, now: () => 1 });
    expect(seen.length).toBeGreaterThan(3);
    for (const a of seen) { expect(a[0]).toBe('git'); expect(a).toContain(repo); expect(a).not.toContain(wt); }
  });
});

describe('§4.15 Engine measurement triggers', () => {
  const idle = { state: 'idle' as const, phase: 'code' };
  test('§4.15 lane reports done (lane_set_phase done) → measure', () => {
    expect(branchTrigger(idle, { state: 'idle', phase: 'done' }, false)).toBe(true);
  });
  test('§4.15 lane enters done (lane_finish) → measure', () => {
    expect(branchTrigger({ state: 'idle', phase: 'done' }, { state: 'done', phase: 'done' }, true)).toBe(true);
  });
  test('§4.15 no transition → no measurement (a running lane, a second view of a done lane)', () => {
    expect(branchTrigger(idle, { state: 'running', phase: 'code' }, false)).toBe(false);
    expect(branchTrigger({ state: 'done', phase: 'done' }, { state: 'done', phase: 'done' }, true)).toBe(false);
  });
  test('§4.15 first view after an engine restart: a done / reported lane never measured → measure; measured → no', () => {
    expect(branchTrigger(undefined, { state: 'done', phase: 'done' }, false)).toBe(true);
    expect(branchTrigger(undefined, { state: 'done', phase: 'done' }, true)).toBe(false);
    expect(branchTrigger(undefined, { state: 'running', phase: 'code' }, false)).toBe(false);
  });
});
