// spec v2.7 §5.5-6 (trailer check at issue_done), §5.7-3/4 (revert target branch + trailer count, "not merged yet"),
// §13 "Unit commits.ts trên repo git tạm". Temp repos only (engine/test/git/_repo.ts), never this repo.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIssueCommits, headSha, onTarget, revertTarget } from '../../src/issues/commits.ts';
import { invalidateGitConfig } from '../../src/git/run.ts';
import { rejects } from '../_fixtures/rejects.ts';
import { execIn } from '../../src/setup/setup.ts';
import { commit, fixture, git, type Fixture } from '../git/_repo.ts';

setDefaultTimeout(30_000);
const exec = execIn(process.env);
let f: Fixture;
beforeEach(() => { f = fixture(); invalidateGitConfig(); });
afterEach(() => f.done());

const head = () => git(f.repo, 'rev-parse', 'HEAD');
const tagged = (file: string, key: string) => commit(f.repo, file, `${file}\n`, `${file}\n\nIssue: ${key}`);

describe('§5.5-6 checkIssueCommits', () => {
  test('§5.5-6 every commit since base carries `Issue: T-46` → ok with sha + lane branch', async () => {
    git(f.repo, 'checkout', '-q', '-b', 'fix-t46');
    const base = head();
    tagged('a', 'T-46');
    tagged('b', 'T-46');
    const r = await checkIssueCommits({ cwd: f.repo, baseSha: base, key: 'T-46', exec });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.commits).toHaveLength(2);
    expect(r.commits.map((c) => c.branch)).toEqual(['fix-t46', 'fix-t46']);
    expect(r.commits[0]!.sha).toBe(head());
  });

  test('§5.5-6 a commit without the trailer → refused, lists its hash and the amend fix', async () => {
    const base = head();
    tagged('a', 'T-47');
    commit(f.repo, 'b', 'b\n', 'b without trailer');
    const missing = head().slice(0, 7);
    const r = await checkIssueCommits({ cwd: f.repo, baseSha: base, key: 'T-47', exec });
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.missing).toEqual([head()]);
    expect(r.message).toContain(missing);
    expect(r.message).toContain('git commit --amend --no-edit --trailer "Issue: T-47"');
    expect(r.message).not.toContain('rebase');
  });

  test('§5.5-6 an older commit without the trailer → the rebase fix, and running it makes the check pass', async () => {
    const base = head();
    commit(f.repo, 'a', 'a\n', 'a without trailer');
    tagged('b', 'T-47');
    const r = await checkIssueCommits({ cwd: f.repo, baseSha: base, key: 'T-47', exec });
    if (r.kind !== 'refused') throw new Error(r.kind);
    const fix = /`(git rebase [^`]+)`/.exec(r.message)?.[1];
    expect(fix).toBeDefined();
    const run = Bun.spawnSync(['sh', '-c', fix!], { cwd: f.repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
    expect(run.exitCode).toBe(0);
    expect((await checkIssueCommits({ cwd: f.repo, baseSha: base, key: 'T-47', exec })).kind).toBe('ok');
  });

  test('§5.5-6 trailer is exact: `Issue: T-460` does not count for T-46', async () => {
    const base = head();
    tagged('a', 'T-460');
    const r = await checkIssueCommits({ cwd: f.repo, baseSha: base, key: 'T-46', exec });
    expect(r.kind).toBe('refused');
  });

  test('§5.5-6 / R-B7 the key inside a longer line, or lower-case `issue:`, does not count', async () => {
    const base = head();
    commit(f.repo, 'a', 'a\n', 'Issue: T-46 fixed\n\nsee Issue: T-46 here\nmore text');
    commit(f.repo, 'b', 'b\n', 'b\n\nissue: T-46');
    const r = await checkIssueCommits({ cwd: f.repo, baseSha: base, key: 'T-46', exec });
    expect(r.kind === 'refused' && r.missing.length).toBe(2);
  });

  test('§5.5-6 / R-B7 the match is the anchored line `^Issue: <key>$` (G0-2), not only a parsed trailer', async () => {
    const base = head();
    commit(f.repo, 'a', 'a\n', 'a\n\nIssue: T-46\n\nlast paragraph, not a trailer');
    expect((await checkIssueCommits({ cwd: f.repo, baseSha: base, key: 'T-46', exec })).kind).toBe('ok');
  });

  test('§5.5-6 merge commits are skipped (--no-merges)', async () => {
    const base = head();
    git(f.repo, 'checkout', '-q', '-b', 'side');
    tagged('s', 'T-46');
    git(f.repo, 'checkout', '-q', 'main');
    tagged('m', 'T-46');
    git(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge side (no trailer)', 'side');
    const r = await checkIssueCommits({ cwd: f.repo, baseSha: base, key: 'T-46', exec });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.commits).toHaveLength(2);
  });

  test('§5.5-6 commits before base_sha need no trailer (R-B2); none since base → ok, empty', async () => {
    commit(f.repo, 'old', 'old\n', 'old work');
    const r = await checkIssueCommits({ cwd: f.repo, baseSha: head(), key: 'T-46', exec });
    expect(r).toEqual({ kind: 'ok', commits: [] });
  });

  test('§5.5-6 not a git dir → skipped', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-nogit-')));
    try {
      expect(await checkIssueCommits({ cwd: dir, baseSha: 'a'.repeat(40), key: 'T-46', exec })).toEqual({ kind: 'skipped', reason: 'no_git' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('§5.5-6 / R-B2 null base_sha → skipped', async () => {
    expect(await checkIssueCommits({ cwd: f.repo, baseSha: null, key: 'T-46', exec })).toEqual({ kind: 'skipped', reason: 'no_base' });
  });

  test('§5.5-6 a key outside T-/B-<n> is a programming error', async () => {
    await rejects(checkIssueCommits({ cwd: f.repo, baseSha: head(), key: 'T-4$', exec })).toThrow('not T-<n>');
    for (const key of ['T-0', 'T-007', ' T-4']) await rejects(checkIssueCommits({ cwd: f.repo, baseSha: head(), key, exec })).toThrow('not T-<n>');
    await rejects(revertTarget({ cwd: f.repo, exec, key: 'B-01', specBranch: null, specDone: false, shas: [] })).toThrow('not T-<n>');
  });

  test('R-B2 headSha: HEAD of the lane cwd; null outside git', async () => {
    expect(await headSha({ cwd: f.repo, exec })).toBe(head());
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-nogit-')));
    try { expect(await headSha({ cwd: dir, exec })).toBeNull(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('§5.7-3/4 revert target + onTarget', () => {
  test('§5.7-4 spec not done, commits only on the spec branch → spec branch, count of trailer commits there', async () => {
    git(f.repo, 'checkout', '-q', '-b', 'v27');
    tagged('a', 'T-46');
    tagged('b', 'T-46');
    tagged('c', 'T-460');
    const shas = git(f.repo, 'log', '--format=%H', '-3').split('\n').slice(1);
    const r = await revertTarget({ cwd: f.repo, exec, key: 'T-46', specBranch: 'v27', specDone: false, shas });
    expect(r).toEqual({ kind: 'ok', branch: 'v27', shas: shas });
  });

  test('§5.7-4 / R-B7 a merge commit whose message has `Issue: T-46` is not counted (--no-merges)', async () => {
    git(f.repo, 'checkout', '-q', '-b', 'v27');
    git(f.repo, 'checkout', '-q', '-b', 'side');
    tagged('a', 'T-46');
    const sha = head();
    git(f.repo, 'checkout', '-q', 'v27');
    commit(f.repo, 'x', 'x\n', 'x');
    git(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge side\n\nIssue: T-46', 'side');
    const r = await revertTarget({ cwd: f.repo, exec, key: 'T-46', specBranch: 'v27', specDone: false, shas: [sha] });
    expect(r).toEqual({ kind: 'ok', branch: 'v27', shas: [sha] });
  });

  test('§5.7-4 spec done → main, even for a commit only on the spec branch', async () => {
    git(f.repo, 'checkout', '-q', '-b', 'v27');
    tagged('a', 'T-46');
    const sha = head();
    git(f.repo, 'checkout', '-q', 'main');
    const r = await revertTarget({ cwd: f.repo, exec, key: 'T-46', specBranch: 'v27', specDone: true, shas: [sha] });
    expect(r).toEqual({ kind: 'ok', branch: 'main', shas: [] });
  });

  test('§5.7-4 commits already on main → main even while the spec is not done', async () => {
    tagged('a', 'T-46');
    git(f.repo, 'branch', 'v27');
    const r = await revertTarget({ cwd: f.repo, exec, key: 'T-46', specBranch: 'v27', specDone: false, shas: [head()] });
    expect(r.kind === 'ok' && r.branch).toBe('main');
  });

  test('§5.7-4 issue outside a spec (no spec branch) → main', async () => {
    tagged('a', 'B-12');
    const r = await revertTarget({ cwd: f.repo, exec, key: 'B-12', specBranch: null, specDone: false, shas: [head()] });
    expect(r).toEqual({ kind: 'ok', branch: 'main', shas: [head()] });
  });

  test('§5.7-3 onTarget: true once merged into the branch, false while only on the lane branch', async () => {
    git(f.repo, 'checkout', '-q', '-b', 'fix-t46');
    tagged('a', 'T-46');
    const sha = head();
    expect(await onTarget({ cwd: f.repo, exec, sha, branch: 'main' })).toBe(false);
    git(f.repo, 'checkout', '-q', 'main');
    git(f.repo, 'merge', '-q', '--ff-only', 'fix-t46');
    expect(await onTarget({ cwd: f.repo, exec, sha, branch: 'main' })).toBe(true);
  });

  test('§5.7-3 onTarget: unknown branch / not a git dir → null (unknown, never a guess)', async () => {
    expect(await onTarget({ cwd: f.repo, exec, sha: head(), branch: 'nope' })).toBeNull();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-nogit-')));
    try { expect(await onTarget({ cwd: dir, exec, sha: head(), branch: 'main' })).toBeNull(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
