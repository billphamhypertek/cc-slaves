// spec v2.3 §10.2 v2.1 `measureBranch` on the shared runner / §11 "measureBranch của v2.1 dùng runner; lane/continue.ts không".
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { invalidateGitConfig } from '../../src/git/run.ts';
import { measureBranch } from '../../src/lane/branch.ts';
import { execIn, type Exec } from '../../src/setup/setup.ts';
import { commit, fixture, git, hits, looseObjects, trap, type Fixture } from './_repo.ts';

setDefaultTimeout(30_000);
let f: Fixture;
beforeEach(() => { f = fixture(); invalidateGitConfig(); });
afterEach(() => f.done());

const GLOBAL = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never'];
/** main and lane/x both edit line 1 of f.txt; lane/x also adds g.txt. */
function conflicted(): void {
  commit(f.repo, 'f.txt', 'a\nb\n');
  git(f.repo, 'branch', 'lane/x');
  commit(f.repo, 'f.txt', 'MAIN\nb\n');
  git(f.repo, 'checkout', '-q', 'lane/x');
  commit(f.repo, 'f.txt', 'LANE\nb\n');
  commit(f.repo, 'g.txt', 'g\n');
  git(f.repo, 'checkout', '-q', 'main');
}

describe('§10.2 measureBranch on the runner', () => {
  test('§10.2 every git call of measureBranch goes through the runner (global flags, -C repo, --end-of-options refs/heads/…)', async () => {
    conflicted();
    const calls: string[][] = [];
    const m = await measureBranch(f.repo, 'lane/x', { exec: async (a, o) => { calls.push(a); return execIn(process.env)(a, o); }, now: () => 1 });
    expect(m.info.state).toBe('unmerged');
    expect(calls.length).toBeGreaterThan(5);
    for (const a of calls) expect(a.slice(0, 11)).toEqual(['git', ...GLOBAL, '-C', f.repo]);
    const mt = calls.find((a) => a.includes('merge-tree'))!;
    expect(mt.slice(11)).toEqual(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', '--end-of-options', 'refs/heads/main', 'refs/heads/lane/x']);
  });

  test('§10.2 unmerged with a conflict → the conflicted file list is exposed; numbers from --numstat', async () => {
    conflicted();
    const m = await measureBranch(f.repo, 'lane/x', { exec: execIn(process.env), now: () => 1 });
    expect(m.info).toMatchObject({ state: 'unmerged', ahead: 2, behind: 1, files: 2, add: 2, del: 1, conflicts: ['f.txt'] });
    expect(m.tip).toBe(git(f.repo, 'rev-parse', 'lane/x'));
  });

  test('§10.2 merge-tree failing (exit > 1) → unknown, never "unmerged clean" / "merged"', async () => {
    conflicted();
    const fail: Exec = async (a, o) => (a.includes('merge-tree') ? { code: 2, stdout: '', stderr: 'fatal: x' } : execIn(process.env)(a, o));
    const u = (await measureBranch(f.repo, 'lane/x', { exec: fail, now: () => 1 })).info;
    expect(u).toMatchObject({ state: 'unknown', reason: 'fatal: x' });
    expect(u.conflicts).toBeUndefined(); // §10.2 `unknown` never carries a (clean) conflict list
    expect(u.behind).toBeUndefined();
  });

  test('§10.2 the lane branch moves during the measure → marked moved, numbers discarded', async () => {
    conflicted();
    let once = false;
    const racing: Exec = async (a, o) => {
      const r = await execIn(process.env)(a, o);
      if (!once && a.includes('merge-tree')) { once = true; git(f.repo, 'branch', '-f', 'lane/x', 'main'); }
      return r;
    };
    const m = await measureBranch(f.repo, 'lane/x', { exec: racing, now: () => 1 });
    expect(m.moved).toBe(true);
    expect(m.info.state).toBe('unknown');
    expect(m.info.conflicts).toBeUndefined();
    expect(m.tip).toBeUndefined();
  });

  test('§10.2 the base moves during the measure → moved', async () => {
    conflicted();
    let once = false;
    const racing: Exec = async (a, o) => {
      const r = await execIn(process.env)(a, o);
      if (!once && a.includes('--is-ancestor')) { once = true; commit(f.repo, 'z.txt', 'z\n'); }
      return r;
    };
    expect((await measureBranch(f.repo, 'lane/x', { exec: racing, now: () => 1 })).moved).toBe(true);
  });

  test('§11 merge driver / textconv / diff.external in local config → unknown naming the key, no hit, object store unchanged', async () => {
    conflicted();
    writeAttrs();
    git(f.repo, 'config', '--local', 'merge.x.driver', trap(f, 'driver', 'exit 0'));
    git(f.repo, 'config', '--local', 'diff.external', trap(f, 'external', 'exit 0'));
    const before = looseObjects(f.repo);
    const m = await measureBranch(f.repo, 'lane/x', { exec: execIn(process.env), now: () => 1 });
    expect(m.info.state).toBe('unknown');
    expect(m.info.reason).toContain('merge.x.driver');
    expect(hits(f)).toEqual([]);
    expect(looseObjects(f.repo)).toBe(before);
  });

  test('§11 lane/continue.ts keeps its own exec (the write path) and never imports the runner', () => {
    const src = readFileSync(resolve(import.meta.dir, '../../src/lane/continue.ts'), 'utf8');
    expect(src).not.toMatch(/git\/run/);
    expect(src).toMatch(/d\.exec\(\['git', '-C', repo/);
  });
});

function writeAttrs(): void { writeFileSync(join(f.repo, '.git', 'info', 'attributes'), '* merge=x\n'); }
