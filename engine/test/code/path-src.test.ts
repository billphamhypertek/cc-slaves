// v2.3 §10.2 "Đường dẫn" + "Nguồn hợp lệ" / §11 engine unit "đường dẫn", "nguồn lane có cwd ngoài git worktree list".
import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPath, openChecked } from '../../src/code/path.ts';
import { readBytes } from '../../src/code/read.ts';
import { gitAt } from '../../src/git/run.ts';
import { worktrees } from '../../src/git/worktrees.ts';
import { execIn } from '../../src/setup/setup.ts';
import { createCodeFs } from '../../src/code/fs.ts';
import { BASE, codeFs, codeOf, fixture, tmp } from './_helpers.ts';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // the real runner (`execIn(process.env)`) spawns with process.env
process.env.GIT_CONFIG_NOSYSTEM = '1';
function git(cwd: string, ...a: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...a], { env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}
/** Test-local stand-in for E1's runner: realpaths of `git worktree list --porcelain`. */
const worktreeList = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n')
  .filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));

describe('§10.2 Đường dẫn', () => {
  const f = fixture();
  mkdirSync(join(f.dir, '.git'));
  writeFileSync(join(f.dir, '.git', 'config'), '[core]\n');
  writeFileSync(join(f.dir, 'a.txt'), 'a\n');
  writeFileSync(join(f.dir, '.env'), 'K=1\n');
  const outside = tmp('ccs-out-');
  writeFileSync(join(outside, 'secret'), 's\n');
  symlinkSync(join(outside, 'secret'), join(f.dir, 'out-link'));
  symlinkSync(join(f.dir, '.git'), join(f.dir, 'gitdir-link'));
  const fs = codeFs(f);
  const read = (path: string) => codeOf(fs.read({ projectId: 'p1', src: BASE, path }));

  test('§10.2 ../ → forbidden', async () => { expect(await read('../x')).toBe('forbidden'); });
  test('§10.2 a/../../x → forbidden', async () => { expect(await read('a/../../x')).toBe('forbidden'); });
  test('§10.2 absolute path → forbidden', async () => { expect(await read(join(f.dir, 'a.txt'))).toBe('forbidden'); });
  test('§10.2 symlink out of the root → forbidden', async () => { expect(await read('out-link')).toBe('forbidden'); });
  test('§10.2 .git/config → forbidden', async () => { expect(await read('.git/config')).toBe('forbidden'); });
  test('§10.2 .GIT/config (APFS) → forbidden', async () => { expect(await read('.GIT/config')).toBe('forbidden'); });
  test('§10.2 symlink into .git (realpath segment) → forbidden', async () => { expect(await read('gitdir-link/config')).toBe('forbidden'); });
  test('§10.2 a lone .Git dir (no .git beside it) is hidden from fs_list and forbidden', async () => {
    const g = fixture();
    mkdirSync(join(g.dir, '.Git'));
    writeFileSync(join(g.dir, '.Git', 'x'), 'x');
    const gfs = codeFs(g);
    expect((await gfs.list({ projectId: 'p1', src: BASE, dir: '', showIgnored: true })).entries).toEqual([]);
    expect(await codeOf(gfs.read({ projectId: 'p1', src: BASE, path: '.Git/x' }))).toBe('forbidden');
  });
  test('§10.2 NUL in path → forbidden', async () => { expect(await read('a.txt\0')).toBe('forbidden'); });
  test('§10.2 .env reads (V21: no longer forbidden)', async () => {
    expect((await fs.read({ projectId: 'p1', src: BASE, path: '.env' })).text).toBe('K=1\n');
  });
  test('§10.2 unknown project → no_project', async () => {
    expect(await codeOf(fs.read({ projectId: 'nope', src: BASE, path: 'a.txt' }))).toBe('no_project');
  });
});

describe('§10.2 O_NOFOLLOW + fstat vs lstat (dev + ino)', () => {
  test('§11 file swapped for a symlink between check and open → forbidden', () => {
    const d = tmp();
    writeFileSync(join(d, 'f'), 'x');
    writeFileSync(join(d, 'g'), 'y');
    const { real } = checkPath(d, 'f');
    const lst = lstatSync(real);
    renameSync(join(d, 'f'), join(d, 'f.old'));
    symlinkSync(join(d, 'g'), join(d, 'f'));
    expect(() => openChecked(real, lst)).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });
  test('§11 file swapped for another regular file between check and open → forbidden', () => {
    const d = tmp();
    writeFileSync(join(d, 'f'), 'x');
    writeFileSync(join(d, 'g'), 'y');
    const { real } = checkPath(d, 'f');
    const lst = lstatSync(real);
    renameSync(join(d, 'g'), join(d, 'f'));
    expect(() => openChecked(real, lst)).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });
  test('§11 symlink to the very inode checked (dev + ino match) → forbidden by O_NOFOLLOW alone', () => {
    const d = tmp();
    writeFileSync(join(d, 'f'), 'x');
    const { real } = checkPath(d, 'f');
    const lst = lstatSync(real);
    renameSync(join(d, 'f'), join(d, 'f.old'));
    symlinkSync(join(d, 'f.old'), join(d, 'f'));
    expect(() => openChecked(real, lst)).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });
  test('§11 parent dir swapped for a symlink out of the root between check and read → forbidden', () => {
    const d = tmp();
    const out = tmp('ccs-out-');
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'x.txt'), 'in\n');
    writeFileSync(join(out, 'x.txt'), 'OUTSIDE\n');
    const { real } = checkPath(d, 'sub/x.txt');
    renameSync(join(d, 'sub'), join(d, 'sub-moved'));
    symlinkSync(out, join(d, 'sub'));
    expect(() => readBytes(real)).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });
  test('§10.2 unchanged file opens', () => {
    const d = tmp();
    writeFileSync(join(d, 'f'), 'x');
    const { real } = checkPath(d, 'f');
    expect(typeof openChecked(real, lstatSync(real))).toBe('number');
  });
});

describe('§10.2 Nguồn hợp lệ', () => {
  test('§11 lane cwd outside git worktree list (temp home) → forbidden for fs_list / fs_read / fs_write', async () => {
    const f = fixture();
    const home = tmp('ccs-home-');
    writeFileSync(join(home, 'id_rsa'), 'k\n');
    f.lanes.D1 = home;
    const fs = codeFs(f);
    const src = { kind: 'lane', laneId: 'D1' } as const;
    expect(await codeOf(fs.list({ projectId: 'p1', src, dir: '', showIgnored: true }))).toBe('forbidden');
    expect(await codeOf(fs.read({ projectId: 'p1', src, path: 'id_rsa' }))).toBe('forbidden');
    expect(await codeOf(fs.write({ projectId: 'p1', src, path: 'id_rsa', text: 'x', eol: 'lf', bom: false, baseHash: '' }))).toBe('forbidden');
  });
  test('§10.2 unknown lane → forbidden', async () => {
    expect(await codeOf(codeFs(fixture()).read({ projectId: 'p1', src: { kind: 'lane', laneId: 'X' }, path: 'a' }))).toBe('forbidden');
  });
  test('§11 real git worktree add: lane worktree reads, a sibling dir does not', async () => {
    const root = tmp('ccs-wt-');
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'lane/d1', join(root, 'wt-d1'));
    writeFileSync(join(root, 'wt-d1', 'a.txt'), 'lane\n');
    mkdirSync(join(root, 'not-wt'));
    writeFileSync(join(root, 'not-wt', 'a.txt'), 'evil\n');
    const f = fixture(repo);
    f.lanes = { D1: join(root, 'wt-d1'), D2: join(root, 'not-wt') };
    const fs = createWithRealWorktrees(f);
    expect((await fs.read({ projectId: 'p1', src: { kind: 'lane', laneId: 'D1' }, path: 'a.txt' })).text).toBe('lane\n');
    expect(await codeOf(fs.read({ projectId: 'p1', src: { kind: 'lane', laneId: 'D2' }, path: 'a.txt' }))).toBe('forbidden');
    expect((await fs.read({ projectId: 'p1', src: BASE, path: 'a.txt' })).text).toBe('base\n');
  });
  test('§10.2 lane whose cwd = project dir is a valid source', async () => {
    const f = fixture();
    writeFileSync(join(f.dir, 'a.txt'), 'x\n');
    f.lanes.D1 = f.dir;
    f.worktrees = [];
    expect((await codeFs(f).read({ projectId: 'p1', src: { kind: 'lane', laneId: 'D1' }, path: 'a.txt' })).text).toBe('x\n');
  });
});

/** A real repo `<t>/repo` (one commit) + `git worktree add <t>/<rel>`; the fs uses E1's real `worktrees()` runner. */
function laneRepo(rel: string) {
  const t = tmp('ccs-wt-');
  const repo = join(t, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(t, rel, '..'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'lane/x', join(t, rel));
  const f = fixture(repo);
  const fs = createCodeFs({
    projectDir: (id) => (id === 'p1' ? repo : null), laneCwd: (_id, n) => f.lanes[n] ?? null, ignored: () => Promise.resolve([]),
    lockState: () => f.lock,
    worktreeRoots: async (dir) => { const l = await worktrees(gitAt(dir, { exec: execIn(process.env) })); return Array.isArray(l) ? l.map((w) => w.root) : []; },
  });
  const home = join(t, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'SECRET\n');
  return { t, repo, f, fs, home };
}
const LANE = { kind: 'lane', laneId: 'x' } as const;

describe('§10.2 Nguồn hợp lệ: a listed worktree must be a real linked worktree of the project', () => {
  test('§11 P1 worktree dir swapped for a symlink to home → forbidden (list / read / write)', async () => {
    const { t, f, fs, home } = laneRepo('wt');
    rmSync(join(t, 'wt'), { recursive: true });
    symlinkSync(home, join(t, 'wt'));
    f.lanes.x = home;
    expect(await codeOf(fs.read({ projectId: 'p1', src: LANE, path: '.ssh/id_rsa' }))).toBe('forbidden');
    expect(await codeOf(fs.list({ projectId: 'p1', src: LANE, dir: '', showIgnored: true }))).toBe('forbidden');
    expect(await codeOf(fs.write({ projectId: 'p1', src: LANE, path: '.ssh/id_rsa', text: 'x', eol: 'lf', bom: false, baseHash: '' }))).toBe('forbidden');
  });
  test('§11 P1 parent dir of the worktree swapped for a symlink (a/po, a → users) → forbidden', async () => {
    const { t, f, fs, home } = laneRepo('a/po');
    mkdirSync(join(t, 'users'));
    renameSync(home, join(t, 'users', 'po'));
    rmSync(join(t, 'a'), { recursive: true });
    symlinkSync(join(t, 'users'), join(t, 'a'));
    f.lanes.x = join(t, 'a', 'po');
    expect(await codeOf(fs.read({ projectId: 'p1', src: LANE, path: '.ssh/id_rsa' }))).toBe('forbidden');
  });
  test('§11 P1 parent swap + a forged .git file (gitdir: <common>/worktrees/po) in the target → forbidden', async () => {
    const { t, repo, f, fs, home } = laneRepo('a/po');
    const gitFile = readFileSync(join(t, 'a', 'po', '.git'), 'utf8');
    mkdirSync(join(t, 'users'));
    renameSync(home, join(t, 'users', 'po'));
    writeFileSync(join(t, 'users', 'po', '.git'), gitFile);
    rmSync(join(t, 'a'), { recursive: true });
    symlinkSync(join(t, 'users'), join(t, 'a'));
    f.lanes.x = join(t, 'a', 'po');
    expect(gitFile).toContain(join(repo, '.git', 'worktrees'));
    expect(await codeOf(fs.read({ projectId: 'p1', src: LANE, path: '.ssh/id_rsa' }))).toBe('forbidden');
  });
  test('§10.2 a listed dir whose .git is a symlink to a real worktree .git file → forbidden', async () => {
    const { t, f } = laneRepo('wt');
    const fake = join(t, 'fake');
    mkdirSync(fake);
    writeFileSync(join(fake, 'a.txt'), 'evil\n');
    symlinkSync(join(t, 'wt', '.git'), join(fake, '.git'));
    f.lanes.x = fake;
    f.worktrees = [f.dir, fake];
    expect(await codeOf(codeFs(f).read({ projectId: 'p1', src: LANE, path: 'a.txt' }))).toBe('forbidden');
  });
  test('§10.2 a listed dir whose .git file points outside <common>/worktrees/ → forbidden', async () => {
    const { t, f } = laneRepo('wt');
    const fake = join(t, 'fake');
    mkdirSync(join(fake, 'g'), { recursive: true });
    writeFileSync(join(fake, 'a.txt'), 'evil\n');
    writeFileSync(join(fake, '.git'), `gitdir: ${join(fake, 'g')}\n`);
    writeFileSync(join(fake, 'g', 'gitdir'), `${join(fake, '.git')}\n`); // a self-made admin dir that names it back
    f.lanes.x = fake;
    f.worktrees = [f.dir, fake];
    expect(await codeOf(codeFs(f).read({ projectId: 'p1', src: LANE, path: 'a.txt' }))).toBe('forbidden');
  });
  test('§10.2 project dir = a sub-dir of the repo: its linked worktree still reads (common dir found up the tree)', async () => {
    const { t, repo, f } = laneRepo('wt');
    mkdirSync(join(repo, 'pkg'));
    writeFileSync(join(t, 'wt', 'a.txt'), 'lane\n');
    const fs = createCodeFs({
      projectDir: () => join(repo, 'pkg'), laneCwd: () => join(t, 'wt'), ignored: () => Promise.resolve([]), lockState: () => f.lock,
      worktreeRoots: () => Promise.resolve([repo, join(t, 'wt')]),
    });
    expect((await fs.read({ projectId: 'p1', src: LANE, path: 'a.txt' })).text).toBe('lane\n');
  });
  test('§11 the untouched linked worktree still reads (via the real runner)', async () => {
    const { t, f, fs } = laneRepo('a/po');
    writeFileSync(join(t, 'a', 'po', 'a.txt'), 'lane\n');
    f.lanes.x = join(t, 'a', 'po');
    expect((await fs.read({ projectId: 'p1', src: LANE, path: 'a.txt' })).text).toBe('lane\n');
  });
});

function createWithRealWorktrees(f: ReturnType<typeof fixture>) {
  f.worktrees = worktreeList(f.dir);
  return codeFs(f);
}
