// v2.5 §5.5 "Cần dựng lại" (orchestrator ruling 18/11 07:05): the git HEAD commit time of a project root, read with one
// `git log -1 --format=%ct`, cached while the git dir's HEAD / logs/HEAD keep their mtime. Stub exec, temp dirs only.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHeads } from '../../src/graph/head.ts';
import type { ExecResult } from '../../src/setup/setup.ts';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-ghead-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const ROOT = join(tmp, 'repo'); const GITDIR = join(ROOT, '.git'); const PLAIN = join(tmp, 'plain');
mkdirSync(join(GITDIR, 'logs'), { recursive: true }); mkdirSync(PLAIN);
writeFileSync(join(GITDIR, 'HEAD'), 'ref: refs/heads/main\n'); writeFileSync(join(GITDIR, 'logs', 'HEAD'), 'x\n');

let execs: string[][]; let ct: ExecResult; let heads: GitHeads;
const exec = async (argv: string[]): Promise<ExecResult> => {
  execs.push(argv);
  if (argv.includes('rev-parse')) return argv[2] === ROOT ? { code: 0, stdout: `true\n${GITDIR}\n`, stderr: '' } : { code: 128, stdout: '', stderr: 'not a git repository' };
  if (argv.includes('log')) return ct;
  throw new Error(`unexpected ${argv.join(' ')}`);
};
const logs = () => execs.filter((a) => a.includes('log')).length;

beforeEach(() => { execs = []; ct = { code: 0, stdout: '1763470000\n', stderr: '' }; heads = new GitHeads(exec); });

describe('GitHeads', () => {
  test('a git root → git + the HEAD commit time in ms (one rev-parse, one log)', async () => {
    expect(await heads.read(ROOT)).toEqual({ git: true, at: 1763470000_000 });
    expect(execs).toEqual([['git', '-C', ROOT, 'rev-parse', '--is-inside-work-tree', '--absolute-git-dir'], ['git', '-C', ROOT, 'log', '-1', '--format=%ct']]);
  });
  test('no git → not git, no commit time, no log run', async () => {
    expect(await heads.read(PLAIN)).toEqual({ git: false });
    expect(logs()).toBe(0);
  });
  test('a repo with no commit (log exits 128) / an unreadable answer → git, no commit time', async () => {
    ct = { code: 128, stdout: '', stderr: 'does not have any commits yet' };
    expect(await heads.read(ROOT)).toEqual({ git: true });
    ct = { code: 0, stdout: 'junk\n', stderr: '' };
    utimesSync(join(GITDIR, 'logs', 'HEAD'), new Date(), new Date(Date.now() + 5_000));
    expect(await heads.read(ROOT)).toEqual({ git: true });
  });
  test('cached while HEAD and logs/HEAD keep their mtime; a new commit (logs/HEAD touched) → read again', async () => {
    await heads.read(ROOT);
    ct = { code: 0, stdout: '1763479999\n', stderr: '' };
    expect(await heads.read(ROOT)).toEqual({ git: true, at: 1763470000_000 });
    expect(logs()).toBe(1);
    utimesSync(join(GITDIR, 'logs', 'HEAD'), new Date(), new Date(Date.now() + 10_000));
    expect(await heads.read(ROOT)).toEqual({ git: true, at: 1763479999_000 });
    expect(logs()).toBe(2);
  });
  test('inside the git dir itself (rev-parse says false) → not git', async () => {
    const h = new GitHeads(async () => ({ code: 0, stdout: `false\n${GITDIR}\n`, stderr: '' }));
    expect(await h.read(GITDIR)).toEqual({ git: false });
  });
  test('an exec that throws → not git', async () => {
    const h = new GitHeads(async () => { throw new Error('spawn'); });
    expect(await h.read(ROOT)).toEqual({ git: false });
  });
});
