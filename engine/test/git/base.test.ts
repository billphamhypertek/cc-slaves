// spec v2.3 §10.2 "Nhánh gốc" (V10) / §11 "nhánh gốc".
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import { baseBranch, unpushed } from '../../src/git/base.ts';
import { gitAt, invalidateGitConfig } from '../../src/git/run.ts';
import { measureBranch } from '../../src/lane/branch.ts';
import { execIn, type Exec } from '../../src/setup/setup.ts';
import { commit, fixture, git, type Fixture } from './_repo.ts';

setDefaultTimeout(30_000);
let f: Fixture;
beforeEach(() => { f = fixture(); invalidateGitConfig(); });
afterEach(() => f.done());

/** A clone of the fixture repo: `origin/HEAD` → `origin/main`, local `main`. */
function clone(): string {
  const origin = join(f.root, 'origin.git');
  Bun.spawnSync(['git', 'clone', '-q', '--bare', f.repo, origin]);
  const c = join(f.root, 'clone');
  Bun.spawnSync(['git', 'clone', '-q', origin, c]);
  return c;
}
const at = (dir: string, exec: Exec = execIn(process.env)) => gitAt(dir, { exec });

describe('§10.2 V10 base branch ①②③', () => {
  test('§10.2 ① origin/HEAD → origin/main with a local main → main; unpushed counts local commits not on origin', async () => {
    const c = clone();
    for (let i = 0; i < 5; i++) commit(c, `n${i}.txt`, `${i}\n`);
    const g = at(c);
    expect(await baseBranch(g)).toEqual({ kind: 'ok', name: 'main' });
    expect(await unpushed(g, 'main')).toBe(5);
  });

  test('§10.2 ① wins over ②: origin/HEAD → main while the project dir has `feature` checked out → main', async () => {
    const c = clone();
    git(c, 'checkout', '-q', '-b', 'feature');
    expect(await baseBranch(at(c))).toEqual({ kind: 'ok', name: 'main' });
  });

  test('§11 main local 5 commits ahead of origin, the lane merged into it → lane "merged", unpushed = 5', async () => {
    const c = clone();
    git(c, 'branch', 'lane/x');
    git(c, 'checkout', '-q', 'lane/x');
    commit(c, 'l.txt', 'lane\n');
    git(c, 'checkout', '-q', 'main');
    git(c, 'merge', '-q', '--ff-only', 'lane/x'); // 1 commit
    for (let i = 0; i < 4; i++) commit(c, `n${i}.txt`, `${i}\n`); // + 4 = 5 not pushed
    const m = await measureBranch(c, 'lane/x', { exec: execIn(process.env), now: () => 1 });
    expect(m.info).toMatchObject({ base: 'main', state: 'merged' });
    expect(await unpushed(at(c), 'main')).toBe(5);
  });

  test('§10.2 tag `main` ≠ branch `main` → the branch is used', async () => {
    const first = git(f.repo, 'rev-parse', 'HEAD');
    commit(f.repo, 'x.txt', 'x\n');
    git(f.repo, 'tag', 'main', first);
    git(f.repo, 'branch', 'lane/x', 'refs/heads/main');
    const m = await measureBranch(f.repo, 'lane/x', { exec: execIn(process.env), now: () => 1 });
    expect(m.info).toMatchObject({ base: 'main', state: 'merged' }); // vs the tag it would be "unmerged" (ahead 1)
  });

  test('§10.2 ② no remote, branch master → master; unpushed null (no remote ref)', async () => {
    git(f.repo, 'branch', '-m', 'main', 'master');
    const g = at(f.repo);
    expect(await baseBranch(g)).toEqual({ kind: 'ok', name: 'master' });
    expect(await unpushed(g, 'master')).toBeNull();
  });

  test('§10.2 ② origin/HEAD → origin/develop with no local develop → the checked-out branch', async () => {
    const c = clone();
    git(c, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(c, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    git(c, 'checkout', '-q', '-b', 'feature');
    expect(await baseBranch(at(c))).toEqual({ kind: 'ok', name: 'feature' });
  });

  test('§10.2 ③ detached HEAD (no origin/HEAD) → none (baseError)', async () => {
    git(f.repo, 'checkout', '-q', '--detach');
    expect(await baseBranch(at(f.repo))).toEqual({ kind: 'none' });
    const m = await measureBranch(f.repo, 'lane/x', { exec: execIn(process.env), now: () => 1 });
    expect(m.info).toMatchObject({ state: 'unknown', base: null });
  });

  test('§10.2 git failing (exit 128) → unknown, not "none"', async () => {
    const fail: Exec = async (argv, o) => argv.includes('symbolic-ref') ? { code: 128, stdout: '', stderr: 'fatal: bad' } : execIn(process.env)(argv, o);
    expect(await baseBranch(at(f.repo, fail))).toMatchObject({ kind: 'unknown' });
  });
});
