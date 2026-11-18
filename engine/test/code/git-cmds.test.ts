// v2.3 §10.2 git_branches / git_changes / git_diff / git_log on real temp repos (no PO config: see _repo.ts).
import { rejects } from '../_fixtures/rejects.ts';
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LaneBranch, Src } from '../../../shared/protocol.ts';
import { gitBranches, GitLog, parseLog } from '../../src/code/git-log.ts';
import { conflictHunks, gitChanges, gitDiff, parseStatus } from '../../src/code/git-read.ts';
import type { GitCtx } from '../../src/code/git-ctx.ts';
import { invalidateGitConfig } from '../../src/git/run.ts';
import { measureBranch } from '../../src/lane/branch.ts';
import { execIn, type Exec } from '../../src/setup/setup.ts';
import { commit, fixture, git, hits, trap, type Fixture } from '../git/_repo.ts';

setDefaultTimeout(30_000);
let f: Fixture;
let wt: string;
beforeEach(() => {
  f = fixture();
  invalidateGitConfig();
  wt = join(f.root, 'wt-d1');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'lane/d1', wt, 'main');
  commit(wt, 'a.txt', 'one\ntwo\n');
  commit(wt, 'README', 'base\nlane\n');
});
afterEach(() => f.done());

const ctx = (exec: Exec = execIn(process.env)): GitCtx => ({ exec, projectDir: f.repo, lanes: [{ name: 'D1', cwd: wt }] });
const resolve = async (s: Src) => (s.kind === 'base' ? { root: realpathSync(f.repo), base: true } : { root: realpathSync(wt), base: false });
const counting = () => { const calls: string[][] = []; const exec: Exec = (a, o) => { calls.push(a); return execIn(process.env)(a, o); }; return { calls, exec }; };

describe('§10.2 git_changes / git_diff', () => {
  test('§10.2 { branch }: worktree + 2 commits → both files with status and +/−', async () => {
    const r = await gitChanges(ctx(), { branch: 'lane/d1' }, resolve);
    expect(r.files).toEqual([{ path: 'README', status: 'M', add: 1, del: 0 }, { path: 'a.txt', status: 'A', add: 2, del: 0 }]);
  });

  test('§10.2 main edits the same line → the file is flagged conflict; git_diff carries hunks, last base commit, merged text', async () => {
    commit(f.repo, 'README', 'MAIN\n');
    const r = await gitChanges(ctx(), { branch: 'lane/d1' }, resolve);
    expect(r.files.find((x) => x.path === 'README')).toMatchObject({ conflict: true });
    expect(r.files.find((x) => x.path === 'a.txt')?.conflict).toBeUndefined();
    const d = await gitDiff(ctx(), 'README', { branch: 'lane/d1' }, resolve);
    expect(d.old).toEqual({ kind: 'text', text: 'base\n' }); // merge-base side
    expect(d.new).toEqual({ kind: 'text', text: 'base\nlane\n' });
    expect(d.conflict?.lastBaseCommit).toBe(git(f.repo, 'rev-parse', 'main'));
    expect(d.conflict?.merged.kind).toBe('text');
    expect(d.conflict?.hunks.length).toBe(1);
  });

  test('§10.2 conflict merged > 2 MB in BYTES (multi-byte text, < 2 Mi chars) → large, the merged blob never read whole', async () => {
    const big = `${'é'.repeat(1_500_000)}\n`; // 1.5 M chars, 3 MB
    commit(f.repo, 'big.txt', `${big}base\n`);
    git(wt, 'merge', '-q', 'main');
    commit(wt, 'big.txt', `${big}lane\n`);
    commit(f.repo, 'big.txt', `${big}MAIN\n`);
    const { calls, exec } = counting();
    const d = await gitDiff(ctx(exec), 'big.txt', { branch: 'lane/d1' }, resolve);
    expect(d.conflict?.merged).toEqual({ kind: 'large' });
    expect(d.conflict?.hunks).toEqual([]);
    expect(calls.filter((a) => a.includes('cat-file')).length).toBe(0);
  });

  test('§10.2 merge-tree failing alone (exit > 1) → git_changes / git_diff of the branch are unknown, never "no conflict"', async () => {
    commit(f.repo, 'README', 'MAIN\n');
    const fail: Exec = async (a, o) => (a.includes('merge-tree') ? { code: 2, stdout: '', stderr: 'fatal: x' } : execIn(process.env)(a, o));
    await rejects(gitChanges(ctx(fail), { branch: 'lane/d1' }, resolve)).toMatchObject({ code: 'git_unknown', params: { reason: 'fatal: x' } });
    await rejects(gitDiff(ctx(fail), 'README', { branch: 'lane/d1' }, resolve)).toMatchObject({ code: 'git_unknown' });
  });

  test('§10.2 { commit }: first parent → commit; a root commit has an absent old side', async () => {
    const head = git(wt, 'rev-parse', 'HEAD');
    expect((await gitChanges(ctx(), { commit: head }, resolve)).files).toEqual([{ path: 'README', status: 'M', add: 1, del: 0 }]);
    const root = git(f.repo, 'rev-list', '--max-parents=0', 'main');
    expect(await gitDiff(ctx(), 'README', { commit: root }, resolve)).toEqual({ old: { kind: 'absent' }, new: { kind: 'text', text: 'base\n' } });
  });

  test('§10.2 { dirty: src }: status of the lane worktree; diff = branch tip vs disk', async () => {
    writeFileSync(join(wt, 'a.txt'), 'one\nTWO\n');
    writeFileSync(join(wt, 'new.txt'), 'x');
    const r = await gitChanges(ctx(), { dirty: { kind: 'lane', laneId: 'D1' } }, resolve);
    expect(r.files).toEqual([{ path: 'a.txt', status: 'M' }, { path: 'new.txt', status: '?' }]);
    const d = await gitDiff(ctx(), 'a.txt', { dirty: { kind: 'lane', laneId: 'D1' } }, resolve);
    expect(d).toEqual({ old: { kind: 'text', text: 'one\ntwo\n' }, new: { kind: 'text', text: 'one\nTWO\n' } });
    expect((await gitDiff(ctx(), 'new.txt', { dirty: { kind: 'lane', laneId: 'D1' } }, resolve)).old).toEqual({ kind: 'absent' });
  });

  test('§10.2 a branch the engine does not know, a bad commit, `..` / .git paths → forbidden, git never runs the call', async () => {
    const { calls, exec } = counting();
    await rejects(gitChanges(ctx(exec), { branch: 'main2' }, resolve)).toMatchObject({ code: 'forbidden' });
    await rejects(gitChanges(ctx(exec), { commit: '--output=/tmp/x' }, resolve)).toMatchObject({ code: 'forbidden' });
    const before = calls.length;
    await rejects(gitDiff(ctx(exec), '../x', { branch: 'lane/d1' }, resolve)).toMatchObject({ code: 'forbidden' });
    await rejects(gitDiff(ctx(exec), '.GIT/config', { branch: 'lane/d1' }, resolve)).toMatchObject({ code: 'forbidden' });
    expect(calls.length).toBe(before);
    expect(calls.some((a) => a.some((x) => x.includes('--output')))).toBe(false);
  });

  test('§10.2 parsers: porcelain -z (conflict XY), merge markers', () => {
    expect(parseStatus('UU c.txt\0 M m.txt\0D  d.txt\0?? n/\0')).toEqual([
      { path: 'c.txt', status: 'U', conflict: true }, { path: 'm.txt', status: 'M' }, { path: 'd.txt', status: 'D' }, { path: 'n/', status: '?' },
    ]);
    expect(conflictHunks('a\n<<<<<<< x\nb\n=======\nc\n>>>>>>> y\nd\n')).toEqual([{ start: 2, end: 6 }]);
  });
});

describe('§10.2 git_branches', () => {
  const measured = async (): Promise<LaneBranch> => (await measureBranch(f.repo, 'lane/d1', { exec: execIn(process.env), now: () => 1 })).info;

  test('§10.2 base + unpushed + lane LaneBranch with behind / conflicts / dirty (V15)', async () => {
    commit(f.repo, 'README', 'MAIN\n');
    git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    writeFileSync(join(wt, 'dirty.txt'), 'x');
    const info = await measured();
    const r = await gitBranches(ctx(), (lane) => (lane === 'D1' ? info : null));
    expect(r.base).toEqual({ name: 'main', unpushed: 1, dirty: 0 });
    expect(r.lanes).toHaveLength(1);
    expect(r.lanes[0]).toMatchObject({ lane: 'D1', name: 'lane/d1' });
    expect(r.lanes[0]!.branch).toMatchObject({ state: 'unmerged', ahead: 2, behind: 1, conflicts: ['README'], dirty: 1 });
  });

  test('§10.2 detached HEAD, no origin/HEAD → baseError none', async () => {
    git(f.repo, 'checkout', '-q', '--detach');
    const r = await gitBranches(ctx(), () => null);
    expect(r).toMatchObject({ base: null, baseError: { kind: 'none' } });
    expect(r.lanes[0]!.branch).toBeNull();
  });

  test('§7 G7 R17 project dir not a git repo → git_branches says notRepo (never an error); other git reads → git_not_repo', async () => {
    const plain: GitCtx = { exec: execIn(process.env), projectDir: f.root, lanes: [] };
    expect(await gitBranches(plain, () => null)).toEqual({ base: null, lanes: [], notRepo: true });
    await rejects(gitChanges(plain, { dirty: { kind: 'base' } }, async () => ({ root: f.root, base: true }))).toMatchObject({ code: 'git_not_repo', key: 'errors.gitNotRepo' });
  });

  test('§7 G7 R17 a git failure that is not "not a git repository" stays git_unknown', async () => {
    const broken: Exec = async () => ({ code: 128, stdout: '', stderr: 'fatal: unable to read tree' });
    await rejects(gitBranches({ exec: broken, projectDir: f.repo, lanes: [] }, () => null)).toMatchObject({ code: 'git_unknown', params: { reason: 'fatal: unable to read tree' } });
  });

  test('§10.3 git_branches: lane `status` calls at most 4 in flight (and > 1), rows keep the lane order', async () => {
    const lanes = [{ name: 'D1', cwd: wt }];
    for (let i = 2; i <= 8; i++) {
      const w = join(f.root, `wt-d${i}`);
      git(f.repo, 'worktree', 'add', '-q', '-b', `lane/d${i}`, w, 'main');
      for (let k = 0; k < i; k++) writeFileSync(join(w, `dirty${k}.txt`), 'x'); // lane i: i dirty files
      lanes.push({ name: `D${i}`, cwd: w });
    }
    writeFileSync(join(wt, 'dirty0.txt'), 'x');
    let inFlight = 0, max = 0;
    const gated: Exec = async (a, o) => {
      if (!a.includes('status') || a.includes(f.repo)) return execIn(process.env)(a, o);
      inFlight++; max = Math.max(max, inFlight);
      const n = Number(/wt-d(\d+)$/.exec(a[a.indexOf('-C') + 1]!)?.[1]);
      await Bun.sleep(10 * (9 - n)); // the earlier lane finishes later
      try { return await execIn(process.env)(a, o); } finally { inFlight--; }
    };
    const info = await measured();
    const r = await gitBranches({ exec: gated, projectDir: f.repo, lanes }, () => info);
    expect(max).toBe(4);
    expect(r.lanes.map((l) => [l.lane, l.branch?.dirty])).toEqual(lanes.map((l, i) => [l.name, i + 1]));
  });

  test('§10.2 a lane whose cwd is not a worktree of the repo is not a lane branch', async () => {
    const r = await gitBranches({ exec: execIn(process.env), projectDir: f.repo, lanes: [{ name: 'X', cwd: f.root }] }, () => null);
    expect(r.lanes).toEqual([]);
  });

  test('§10.2 repo configuring a program (merge driver, local) → unknown with the key, never clean; no program ran', async () => {
    git(f.repo, 'config', 'merge.x.driver', trap(f, 'merge'));
    writeFileSync(join(f.repo, '.gitattributes'), '* merge=x\n');
    const info = (await measureBranch(f.repo, 'lane/d1', { exec: execIn(process.env), now: () => 1 })).info;
    expect(info.state).toBe('unknown');
    expect(info.conflicts).toBeUndefined();
    await rejects(gitBranches(ctx(), () => info)).toMatchObject({ code: 'git_unknown', key: 'errors.gitProgram', params: { key: 'merge.x.driver' } });
    await rejects(gitChanges(ctx(), { branch: 'lane/d1' }, resolve)).toMatchObject({ code: 'git_unknown' });
    await rejects(gitChanges(ctx(), { dirty: { kind: 'base' } }, resolve)).toMatchObject({ code: 'git_unknown' });
    await rejects(gitDiff(ctx(), 'README', { branch: 'lane/d1' }, resolve)).toMatchObject({ code: 'git_unknown' });
    await rejects(new GitLog().page('p', ctx(), { refs: [], limit: 10 }, true)).toMatchObject({ code: 'git_unknown' });
    expect(hits(f)).toEqual([]);
  });
});

describe('§10.2 git_log', () => {
  test('§10.2 base + lane branches, newest first, labels, pages via before', async () => {
    const log = new GitLog();
    const p1 = await log.page('p', ctx(), { refs: [], limit: 2 }, true);
    expect(p1.commits.map((c) => c.subject)).toEqual(['README', 'a.txt']);
    expect(p1.commits[0]).toMatchObject({ refs: ['lane/d1'], author: 't', parents: [git(wt, 'rev-parse', 'HEAD~1')] });
    expect(p1.more).toBe(true);
    const p2 = await log.page('p', ctx(), { refs: [], limit: 2, before: p1.commits[1]!.hash }, true);
    expect(p2.commits.map((c) => c.subject)).toEqual(['README']);
    expect(p2.commits[0]!.refs).toEqual(['main']);
    expect(p2.more).toBe(false);
  });

  test('§10.2 cached by tip shas: same tips → no `log` call; a new commit → fresh page', async () => {
    const log = new GitLog();
    const { calls, exec } = counting();
    await log.page('p', ctx(exec), { refs: ['lane/d1'], limit: 5 }, true);
    const logs = () => calls.filter((a) => a.includes('log')).length;
    expect(logs()).toBe(1);
    await log.page('p', ctx(exec), { refs: ['lane/d1'], limit: 5 }, true);
    expect(logs()).toBe(1);
    commit(wt, 'c.txt', 'c');
    expect((await log.page('p', ctx(exec), { refs: ['lane/d1'], limit: 5 }, true)).commits[0]!.subject).toBe('c.txt');
    expect(logs()).toBe(2);
  });

  test('§10.2 Git tab hidden → no git call at all: the cache, or git_hidden', async () => {
    const log = new GitLog();
    const { calls, exec } = counting();
    await rejects(log.page('p', ctx(exec), { refs: [], limit: 5 }, false)).toMatchObject({ code: 'git_hidden' });
    expect(calls).toEqual([]);
    const shown = await log.page('p', ctx(), { refs: [], limit: 5 }, true);
    expect(await log.page('p', ctx(exec), { refs: [], limit: 5 }, false)).toEqual(shown);
    expect(calls).toEqual([]);
  });

  test('§10.2 parseLog: decorations without HEAD, epoch ms', () => {
    const h = 'a'.repeat(40);
    expect(parseLog(`${h}\x1f\x1fsubj\x1fme\x1f10\x1fHEAD -> main, lane/x\0`)).toEqual([{ hash: h, parents: [], subject: 'subj', author: 'me', at: 10_000, refs: ['main', 'lane/x'] }]);
  });
});
