// v2.3 §10.2 fs_list / fs_find, §5.1 cây + ⌘P, §9.2 V21 (show ignored), §11 "file bị .gitignore … có cờ ignored đúng".
import { describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuzzyScore } from '../../src/code/fuzzy.ts';
import { BASE, codeFs, codeOf, fixture } from './_helpers.ts';

function tree() {
  const f = fixture();
  for (const d of ['.git', 'src', 'src/lib', 'node_modules', 'node_modules/x', 'docs']) mkdirSync(join(f.dir, d));
  for (const p of ['.git/config', 'src/app.ts', 'src/lib/auth.ts', 'node_modules/x/index.js', 'docs/readme.md', 'b.txt', 'A.md', '.env', 'debug.log'])
    writeFileSync(join(f.dir, p), 'x');
  f.ignored = ['node_modules/', '.env', 'debug.log'];
  return f;
}
const list = (f: ReturnType<typeof tree>, dir: string, showIgnored: boolean) => codeFs(f).list({ projectId: 'p1', src: BASE, dir, showIgnored });
const find = (f: ReturnType<typeof tree>, query: string, showIgnored = false) => codeFs(f).find({ projectId: 'p1', src: BASE, query, showIgnored });

describe('§10.2 fs_list', () => {
  test('§5.1 dirs first, by name; .git hidden; ignored hidden by default', async () => {
    const r = await list(tree(), '', false);
    expect(r.entries.map((e) => e.name)).toEqual(['docs', 'src', 'A.md', 'b.txt']);
    expect(r.more).toBe(0);
  });
  test('§9.2 V21 showIgnored → ignored entries listed with ignored: true (.env included, .git never)', async () => {
    const r = await list(tree(), '', true);
    expect(r.entries.map((e) => [e.name, e.ignored])).toEqual([
      ['docs', false], ['node_modules', true], ['src', false], ['.env', true], ['A.md', false], ['b.txt', false], ['debug.log', true],
    ]);
  });
  test('§9.2 V21 inside an ignored dir every entry is ignored', async () => {
    expect((await list(tree(), 'node_modules', true)).entries).toEqual([{ name: 'x', type: 'dir', size: expect.any(Number) as number, ignored: true }]);
  });
  test('§10.2 entry: name, type, size; symlink typed symlink', async () => {
    const f = tree();
    writeFileSync(join(f.dir, 'src', 'big.ts'), 'y'.repeat(1234));
    symlinkSync(join(f.dir, 'b.txt'), join(f.dir, 'src', 'ln'));
    const r = await list(f, 'src', false);
    expect(r.entries.find((e) => e.name === 'big.ts')).toEqual({ name: 'big.ts', type: 'file', size: 1234, ignored: false });
    expect(r.entries.find((e) => e.name === 'ln')?.type).toBe('symlink');
  });
  test('§5.1 not a git repo → node_modules and .DS_Store count as ignored', async () => {
    const f = tree(); f.ignored = null;
    writeFileSync(join(f.dir, '.DS_Store'), '');
    expect((await list(f, '', false)).entries.map((e) => e.name)).toEqual(['docs', 'src', '.env', 'A.md', 'b.txt', 'debug.log']);
  });
  test('§5.1 > 2 000 entries → first 2 000 + more', async () => {
    const f = fixture(); mkdirSync(join(f.dir, 'many'));
    for (let i = 0; i < 2003; i++) writeFileSync(join(f.dir, 'many', `f${String(i).padStart(4, '0')}`), '');
    const r = await list(f, 'many', false);
    expect([r.entries.length, r.more, r.entries[0]?.name]).toEqual([2000, 3, 'f0000']);
  });
  test('§10.2 .git / ../ / file as dir → forbidden', async () => {
    const f = tree();
    expect(await codeOf(list(f, '.GIT', true))).toBe('forbidden');
    expect(await codeOf(list(f, '..', true))).toBe('forbidden');
    expect(await codeOf(list(f, 'b.txt', true))).toBe('forbidden');
  });
});

describe('§10.2 fs_find', () => {
  test('§5.1 fuzzy by path, best match first, ignored + .git hidden', async () => {
    const r = await find(tree(), 'auth');
    expect(r.paths[0]).toBe('src/lib/auth.ts');
    expect((await find(tree(), 'config')).paths).toEqual([]);
    expect((await find(tree(), 'index')).paths).toEqual([]);
  });
  test('§9.2 V21 showIgnored → ignored files found', async () => {
    expect((await find(tree(), 'index', true)).paths).toEqual(['node_modules/x/index.js']);
    expect((await find(tree(), '.env', true)).paths[0]).toBe('.env');
  });
  test('§5.1 ≤ 50 results', async () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) writeFileSync(join(f.dir, `note-${i}.md`), '');
    expect((await find(f, 'note')).paths.length).toBe(50);
  });
  test('§5.1 empty query → no results', async () => { expect((await find(tree(), '  ')).paths).toEqual([]); });
  test('§5.1 fuzzy: basename hit beats a scattered match; no subsequence → null', () => {
    expect(fuzzyScore('sla', 'src/lib/app.ts')).not.toBeNull();
    expect(fuzzyScore('zz', 'src/app.ts')).toBeNull();
    expect(fuzzyScore('app', 'src/app.ts')!).toBeGreaterThan(fuzzyScore('app', 'a/p/p/x.ts')!);
    expect(fuzzyScore('auth', 'src/lib/auth.ts')!).toBeGreaterThan(fuzzyScore('auth', 'a-utils/three/hello.ts')!);
  });
});
