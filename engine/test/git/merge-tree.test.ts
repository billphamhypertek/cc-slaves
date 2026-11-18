// spec v2.3 §10.2 "Đo trước merge" + "merge-tree không ghi vào repo" / §11 "đo trước merge khớp git merge thật", research §7.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeTree } from '../../src/git/merge-tree.ts';
import { gitAt, invalidateGitConfig } from '../../src/git/run.ts';
import { execIn, type Exec } from '../../src/setup/setup.ts';
import { commit, fixture, git, looseObjects, sh, type Fixture } from './_repo.ts';

setDefaultTimeout(30_000);
let f: Fixture;
beforeEach(() => { f = fixture(); invalidateGitConfig(); });
afterEach(() => f.done());

const g = (exec: Exec = execIn(process.env)) => gitAt(f.repo, { exec, branches: ['main', 'lane'] });

/** f.txt on main + a lane branch; `attrs` committed on main before the fork (null = none). */
function setup(attrs: string | null, base = 'a\nb\nc\nd\ne\n'): void {
  if (attrs !== null) commit(f.repo, '.gitattributes', attrs);
  commit(f.repo, 'f.txt', base);
  git(f.repo, 'branch', 'lane');
}
function onLane(file: string, body: string): void {
  git(f.repo, 'checkout', '-q', 'lane');
  commit(f.repo, file, body);
  git(f.repo, 'checkout', '-q', 'main');
}
/** The real `git merge` exit in the project dir (run after the measure; aborted / reset after). */
function realMerge(): number {
  const r = sh(f.repo, 'merge', '--no-edit', '-q', 'lane');
  sh(f.repo, 'merge', '--abort');
  sh(f.repo, 'reset', '-q', '--hard');
  return r.code === 0 ? 0 : 1;
}
async function measured(): Promise<number> {
  const r = await mergeTree(g(), 'main', 'lane');
  if (r.kind === 'clean') return 0;
  if (r.kind === 'conflict') return 1;
  throw new Error(`merge-tree ${r.kind}: ${r.reason}`);
}

describe('§11 pre-merge measure matches a real git merge (8 cases, research §7)', () => {
  const cases: [string, string | null, string, string][] = [
    ['no attributes, different lines → clean', null, 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'],
    ['no attributes, same line → conflict', null, 'A1\nb\nc\nd\ne\n', 'A2\nb\nc\nd\ne\n'],
    ['f.txt -merge, different lines → conflict', 'f.txt -merge\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'],
    ['f.txt binary, different lines → conflict', 'f.txt binary\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'],
    ['f.txt merge=union, same line → clean', 'f.txt merge=union\n', 'A1\nb\nc\nd\ne\n', 'A2\nb\nc\nd\ne\n'],
    ['f.txt merge=text, same line → conflict', 'f.txt merge=text\n', 'A1\nb\nc\nd\ne\n', 'A2\nb\nc\nd\ne\n'],
  ];
  for (const [name, attrs, mainBody, laneBody] of cases) {
    test(`§10.2 V24 ${name}`, async () => {
      setup(attrs);
      commit(f.repo, 'f.txt', mainBody);
      onLane('f.txt', laneBody);
      const got = await measured(); // measure first: a clean real merge moves main
      expect(got).toBe(realMerge());
    });
  }

  test('§10.2 V24 lane adds .gitattributes -merge (main has none) → same as git merge (clean)', async () => {
    setup(null);
    commit(f.repo, 'f.txt', 'A\nb\nc\nd\ne\n');
    git(f.repo, 'checkout', '-q', 'lane');
    writeFileSync(join(f.repo, '.gitattributes'), 'f.txt -merge\n');
    writeFileSync(join(f.repo, 'f.txt'), 'a\nb\nc\nd\nE\n');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-q', '-m', 'lane attrs');
    git(f.repo, 'checkout', '-q', 'main');
    const got = await measured();
    const want = realMerge();
    expect(want).toBe(0);
    expect(got).toBe(want);
  });

  test('§10.2 V24 uncommitted .gitattributes -merge in the project dir → same as git merge (conflict)', async () => {
    setup(null);
    commit(f.repo, 'f.txt', 'A\nb\nc\nd\ne\n');
    onLane('f.txt', 'a\nb\nc\nd\nE\n');
    writeFileSync(join(f.repo, '.gitattributes'), 'f.txt -merge\n');
    const got = await measured();
    const want = realMerge();
    expect(want).toBe(1);
    expect(got).toBe(want);
  });
});

describe('§10.2 merge-tree result mapping', () => {
  test('§10.2 conflict → the conflicted file list (-z, --name-only), tree sha', async () => {
    setup(null);
    commit(f.repo, 'f.txt', 'A1\nb\nc\nd\ne\n');
    commit(f.repo, 'g.txt', 'main\n');
    onLane('f.txt', 'A2\nb\nc\nd\ne\n');
    onLane('g.txt', 'lane\n');
    onLane('h.txt', 'only lane\n');
    const r = await mergeTree(g(), 'main', 'lane');
    expect(r).toMatchObject({ kind: 'conflict', files: ['f.txt', 'g.txt'] });
    expect(r.kind === 'conflict' && r.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  test('§10.2 clean → kind clean + the merged tree', async () => {
    setup(null);
    onLane('h.txt', 'x\n');
    const r = await mergeTree(g(), 'main', 'lane');
    expect(r.kind).toBe('clean');
  });

  test('§10.2 any exit other than 0 / 1 → unknown "never clean" (GitHub Desktop bug, research §2)', async () => {
    setup(null);
    const tree = git(f.repo, 'rev-parse', 'HEAD^{tree}');
    for (const code of [2, 128, 129, -1]) { // a tree on stdout does not make a failed run clean
      const fake: Exec = async (argv, o) => argv.includes('merge-tree') ? { code, stdout: `${tree}\0`, stderr: 'fatal: boom' } : execIn(process.env)(argv, o);
      expect(await mergeTree(g(fake), 'main', 'lane')).toMatchObject({ kind: 'unknown' });
    }
  });

  test('§10.2 exit 0 with unparsable output → unknown, not clean', async () => {
    setup(null);
    const fake: Exec = async (argv, o) => argv.includes('merge-tree') ? { code: 0, stdout: 'garbage', stderr: '' } : execIn(process.env)(argv, o);
    expect(await mergeTree(g(fake), 'main', 'lane')).toMatchObject({ kind: 'unknown' });
  });

  test('§10.2 a timeout → unknown', async () => {
    setup(null);
    const hang: Exec = async (argv, o) => argv.includes('merge-tree') ? new Promise(() => {}) : execIn(process.env)(argv, o);
    expect(await mergeTree(gitAt(f.repo, { exec: hang, branches: ['main', 'lane'], timeoutMs: 400 }), 'main', 'lane')).toMatchObject({ kind: 'unknown', reason: 'timeout' });
  });

  test('§10.2 repo configured to run a program → unknown naming the key', async () => {
    setup(null);
    git(f.repo, 'config', '--local', 'merge.x.driver', 'true');
    expect(await mergeTree(g(), 'main', 'lane')).toMatchObject({ kind: 'unknown', program: 'merge.x.driver' });
  });

  test('§10.2 a branch the engine does not know → forbidden', async () => {
    setup(null);
    expect(await mergeTree(gitAt(f.repo, { exec: execIn(process.env), branches: ['main'] }), 'main', 'lane')).toMatchObject({ kind: 'forbidden' });
  });
});

describe('§10.2 merge-tree never writes into the repo', () => {
  test('§10.2 object store count unchanged after a conflicted merge-tree; temp object dir removed', async () => {
    setup(null);
    commit(f.repo, 'f.txt', 'A1\nb\nc\nd\ne\n');
    onLane('f.txt', 'A2\nb\nc\nd\ne\n');
    const before = looseObjects(f.repo);
    const tmpBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('ccs-mt-')).length;
    const calls: string[][] = [];
    const r = await mergeTree(g(async (a, o) => { calls.push(a); return execIn(process.env)(a, o); }), 'main', 'lane', { readMerged: ['f.txt'] });
    expect(r.kind).toBe('conflict');
    expect(looseObjects(f.repo)).toBe(before);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('ccs-mt-')).length).toBe(tmpBefore);
    // control: the same merge-tree without the env writes objects (the measurement of research §7 still holds)
    sh(f.repo, 'merge-tree', '--write-tree', 'refs/heads/main', 'refs/heads/lane');
    expect(looseObjects(f.repo)).toBeGreaterThan(before);
  });

  test('§10.2 conflict.merged read with the same env carries conflict markers', async () => {
    setup(null);
    commit(f.repo, 'f.txt', 'A1\nb\nc\nd\ne\n');
    onLane('f.txt', 'A2\nb\nc\nd\ne\n');
    const r = await mergeTree(g(), 'main', 'lane', { readMerged: ['f.txt'] });
    expect(r.kind === 'conflict' && r.merged?.['f.txt']).toContain('<<<<<<< refs/heads/main');
  });

  test('§10.2 the temp object dir is removed even when git fails', async () => {
    setup(null);
    const fake: Exec = async (argv, o) => argv.includes('merge-tree') ? { code: 128, stdout: '', stderr: 'fatal' } : execIn(process.env)(argv, o);
    let dir = '';
    const spyExec: Exec = async (argv, o) => { const e = o?.env?.GIT_OBJECT_DIRECTORY; if (e) dir = e; return fake(argv, o); };
    await mergeTree(g(spyExec), 'main', 'lane');
    expect(dir).not.toBe('');
    expect(existsSync(dir)).toBe(false);
  });
});
