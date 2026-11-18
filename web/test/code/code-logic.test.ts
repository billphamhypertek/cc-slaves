// spec v2.3 §5.1 / §5.2 / §10.2 the pure parts of the Code mode: tree rows, keyboard steps, session memory, the fs
// requests the web sends (fake transport), "Hiện file bị bỏ qua" per project, the file kinds of the viewer and chip picks.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import '../../../shared/i18n/index.ts';
import { makeT } from '../../../shared/i18n/core.ts';
import type { FsEntry, FsReadResult } from '../../../shared/protocol.ts';
import { fileIcon, isMd, langOf, largeRest, roReason, wrapFor, type LangId } from '../../src/code/file-view.ts';
import { fsApi, keySrc, setShowIgnored, showIgnoredOf, srcKey, srcKeyOf, wireSrc, type FsCmd } from '../../src/code/fs.ts';
import { pickedSrc, type CodeSrc } from '../../src/code/src.ts';
import { ancestors, withPath, rememberedOpen, rememberOpen, rowKey, stepImage, stepSel, treeRows, type DirState, type TreeModel } from '../../src/code/tree-model.ts';
import { fmtBytes } from '../../src/lib/format.ts';

const f = (name: string, ignored = false): FsEntry => ({ name, type: 'file', size: 10, ignored });
const d = (name: string, ignored = false): FsEntry => ({ name, type: 'dir', size: 0, ignored });
const ok = (entries: FsEntry[], more = 0): DirState => ({ k: 'ok', list: { entries, more } });
const model = (dirs: Record<string, DirState>, open: string[] = []): TreeModel => ({ dirs: new Map(Object.entries(dirs)), open: new Set(open) });

describe('§5.1 tree rows', () => {
  test('§5.1 closed dirs hide their children; an open dir lists its entries one level deeper, in the engine order', () => {
    const m = model({ '': ok([d('docs'), d('engine'), f('README.md')]), engine: ok([d('src'), f('package.json')]) }, ['engine']);
    expect(treeRows(m).map(r => (r.k === 'entry' ? `${r.depth}:${r.path}${r.dir ? '/' : ''}${r.open ? '+' : ''}` : r.k))).toEqual(
      ['0:docs/', '0:engine/+', '1:engine/src/', '1:engine/package.json', '0:README.md']);
  });
  test('§5.1 a dir over 2 000 entries → its 2 000 + one "more" row with the count left, at that depth', () => {
    const m = model({ '': ok([d('big')]), big: ok([f('a.ts')], 4_321) }, ['big']);
    expect(treeRows(m).at(-1)).toEqual({ k: 'more', depth: 1, n: 4_321 });
    expect(treeRows(model({ '': ok([d('big')]), big: ok([f('a.ts')], 1) }, ['big'])).at(-1)).toEqual({ k: 'more', depth: 1, n: 1 });
    expect(treeRows(model({ '': ok([d('big')]), big: ok([f('a.ts')]) }, ['big'])).some(r => r.k === 'more')).toBe(false);
  });
  test('§5.1 an open dir still being read → a loading row; a failed read → an error row naming the dir (retry)', () => {
    expect(treeRows(model({ '': ok([d('a'), d('b')]), a: { k: 'loading' }, b: { k: 'error' } }, ['a', 'b'])).filter(r => r.k !== 'entry'))
      .toEqual([{ k: 'loading', depth: 1 }, { k: 'error', depth: 1, dir: 'b' }]);
  });
  test('§5.1 the ignored flag reaches the row (dimmed when "Hiện file bị bỏ qua" is on)', () => {
    expect(treeRows(model({ '': ok([d('node_modules', true), f('.env', true), f('a.ts')]) })).map(r => r.k === 'entry' && r.ignored)).toEqual([true, true, false]);
  });
  test('§5.1 first open: only the path to the open file is open', () => {
    expect(ancestors('docs/specs/a.md')).toEqual(['docs', 'docs/specs']);
    expect(ancestors('README.md')).toEqual([]);
  });
  test('§5.1 I1 reveal: the open set gains the missing dirs down to the file; nothing to add → null (no re-render)', () => {
    expect([...withPath(new Set(['docs']), 'docs/specs/a.md')!]).toEqual(['docs', 'docs/specs']);
    expect(withPath(new Set(['docs', 'docs/specs']), 'docs/specs/a.md')).toBeNull();
    expect(withPath(new Set(), 'README.md')).toBeNull();
    expect(withPath(new Set(), null)).toBeNull();
  });
  test('§5.1 ↑↓ step over entry rows only, clamped at both ends; no row yet → first / last', () => {
    const rows = treeRows(model({ '': ok([d('a'), f('b'), f('c')], 9), a: { k: 'loading' } }, ['a']));
    expect(stepSel(rows, 'a', 1)).toBe('b');
    expect(stepSel(rows, 'c', 1)).toBe('c');
    expect(stepSel(rows, 'a', -1)).toBe('a');
    expect(stepSel(rows, null, 1)).toBe('a');
    expect(stepSel(rows, null, -1)).toBe('c');
    expect(stepSel([], null, 1)).toBeNull();
  });
  test('§5.1 / §11 row keys: Enter on a file opens it, Enter on a dir toggles it, ↑↓ step, ←→ only fold the right way', () => {
    const rows = treeRows(model({ '': ok([d('a'), f('b')]), a: ok([]) }, ['a']));
    const dir = rows.find(r => r.k === 'entry' && r.dir)!, file = rows.find(r => r.k === 'entry' && !r.dir)!;
    if (dir.k !== 'entry' || file.k !== 'entry') throw new Error('rows');
    const run = (key: string, row: typeof dir) => {
      const got: string[] = [];
      const taken = rowKey(key, row, rows, { open: x => got.push(`open ${x}`), toggle: x => got.push(`toggle ${x}`), focus: x => got.push(`focus ${x}`) });
      return [taken, ...got];
    };
    expect(run('Enter', file)).toEqual([true, 'open b']);
    expect(run('Enter', dir)).toEqual([true, 'toggle a']);
    expect(run('ArrowDown', dir)).toEqual([true, 'focus b']);
    expect(run('ArrowUp', file)).toEqual([true, 'focus a']);
    expect(run('ArrowLeft', dir)).toEqual([true, 'toggle a']); // open → ← closes
    expect(run('ArrowRight', dir)).toEqual([true]); // already open: taken, nothing done
    expect(run('ArrowRight', { ...dir, open: false })).toEqual([true, 'toggle a']);
    expect(run('ArrowRight', file)).toEqual([true]);
    expect(run('a', file)).toEqual([false]); // other keys fall through (typing, ⌘P)
  });
  test('§5.1 the Tree hands its rows\' keys to rowKey with the open / toggle props (Enter on a file = onOpen)', () => {
    const src = readFileSync(new URL('../../src/code/Tree.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const keys: RowHandlers = \{ open: p\.onOpen, toggle: p\.onToggle, focus:/);
    expect(src).toMatch(/if \(!rowKey\(e\.key, r, rows, keys\)\) return;\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
  });
  test('§5.1 open / closed remembered per (project, source), a copy (later edits do not leak)', () => {
    expect(rememberedOpen('p:lane:Z')).toBeNull();
    const s = new Set(['docs']);
    rememberOpen('p:lane:Z', s);
    s.add('engine');
    expect([...rememberedOpen('p:lane:Z')!]).toEqual(['docs']);
    expect(rememberedOpen('p:base')).toBeNull();
  });
});

describe('v2.7 §4.10 ← / → through the images of a folder', () => {
  const e = (name: string, type: 'file' | 'dir' = 'file') => ({ name, type, ignored: false }) as Parameters<typeof stepImage>[1][number];
  const ents = [e('shots', 'dir'), e('IS1.png'), e('notes.md'), e('IS2.png'), e('IS3.webp')];
  test('§4.10 next / previous image skips dirs and other files; none past either end', () => {
    expect(stepImage('docs/s', ents, 'docs/s/IS1.png', 1)).toBe('docs/s/IS2.png');
    expect(stepImage('docs/s', ents, 'docs/s/IS2.png', 1)).toBe('docs/s/IS3.webp');
    expect(stepImage('docs/s', ents, 'docs/s/IS2.png', -1)).toBe('docs/s/IS1.png');
    expect(stepImage('docs/s', ents, 'docs/s/IS1.png', -1)).toBeNull();
    expect(stepImage('docs/s', ents, 'docs/s/IS3.webp', 1)).toBeNull();
    expect(stepImage('', [e('a.png'), e('b.png')], 'a.png', 1)).toBe('b.png');
    expect(stepImage('docs/s', ents, 'docs/s/notes.md', 1)).toBeNull();
  });
});

describe('§10.2 fs requests (fake transport)', () => {
  const sent: FsCmd[] = [];
  const send = (c: FsCmd) => { sent.push(c); return Promise.resolve({ entries: [], more: 0 }); };
  test('§10.2 list / find / read carry project, source, root-relative path and the ignore switch (read: no switch)', async () => {
    sent.length = 0;
    const lane = fsApi(send, 'p1', wireSrc({ lane: 'D15' }), true);
    await lane.list('engine/src');
    await lane.find('auth');
    await fsApi(send, 'p1', wireSrc({ lane: null }), false).read('README.md');
    expect(sent).toEqual([
      { cmd: 'fs_list', projectId: 'p1', src: { kind: 'lane', laneId: 'D15' }, dir: 'engine/src', showIgnored: true },
      { cmd: 'fs_find', projectId: 'p1', src: { kind: 'lane', laneId: 'D15' }, query: 'auth', showIgnored: true },
      { cmd: 'fs_read', projectId: 'p1', src: { kind: 'base' }, path: 'README.md' },
    ]);
  });
  test('§10.2 fs_write carries project, source, path, text, eol, bom, baseHash (+ recreate)', async () => {
    sent.length = 0;
    await fsApi(send, 'p1', wireSrc({ lane: 'D2' }), false).write({ path: 'a.ts', text: 'x', eol: 'crlf', bom: true, baseHash: 'h', recreate: true });
    expect(sent).toEqual([{ cmd: 'fs_write', projectId: 'p1', src: { kind: 'lane', laneId: 'D2' }, path: 'a.ts', text: 'x', eol: 'crlf', bom: true, baseHash: 'h', recreate: true }]);
  });
  test('source keys both ways', () => {
    expect(srcKey({ lane: null })).toBe('base');
    expect(srcKey({ lane: 'D7' })).toBe('lane:D7');
    expect(keySrc('lane:D7')).toEqual({ kind: 'lane', laneId: 'D7' });
    expect(keySrc('base')).toEqual({ kind: 'base' });
    expect(srcKeyOf({ kind: 'lane', laneId: 'D7' })).toBe('lane:D7');
    expect(srcKeyOf({ kind: 'base' })).toBe('base');
  });
  test('§5.1 "Hiện file bị bỏ qua": off by default, remembered per project, broken storage → off', () => {
    const m = new Map<string, string>();
    const ks = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(showIgnoredOf('p1', ks)).toBe(false);
    setShowIgnored('p1', true, ks);
    expect(showIgnoredOf('p1', ks)).toBe(true);
    expect(showIgnoredOf('p2', ks)).toBe(false);
    setShowIgnored('p1', false, ks);
    expect(showIgnoredOf('p1', ks)).toBe(false);
    m.set('ccs.code.showIgnored', '{bad');
    expect(showIgnoredOf('p1', ks)).toBe(false);
  });
});

describe('§5.2 file kinds', () => {
  test('§5.2 every listed extension is highlighted; any other is plain text', () => {
    const want: Record<string, LangId> = { 'a.ts': 'ts', 'a.tsx': 'tsx', 'a.js': 'js', 'a.jsx': 'jsx', 'a.json': 'json', 'a.md': 'md', 'a.css': 'css',
      'a.html': 'html', 'a.py': 'py', 'a.rs': 'rs', 'a.go': 'go', 'a.yaml': 'yaml', 'a.yml': 'yaml', 'a.toml': 'toml', 'a.sh': 'sh', 'a.sql': 'sql', 'x/A.TS': 'ts' };
    for (const [p, l] of Object.entries(want)) expect(langOf(p)).toBe(l);
    for (const p of ['a.txt', 'Makefile', '.env', 'a.lock', 'dir.ts/file']) expect(langOf(p)).toBeNull();
  });
  test('§5.2 .md / .mdx get "Đọc" | "Nguồn"; "Ngắt dòng" on for md source, off for code', () => {
    expect([isMd('a.md'), isMd('a.mdx'), isMd('a.ts'), isMd('md')]).toEqual([true, true, false, false]);
    expect([wrapFor('README.md'), wrapFor('a.ts')]).toEqual([true, false]);
  });
  test('§5.2 V20 / C20 / C21 / C10 why "Sửa" is off', () => {
    const r = (o: Partial<FsReadResult>): FsReadResult => ({ kind: 'text', size: 1, hash: 'h', ...o });
    expect(roReason(r({}))).toBeNull();
    expect(roReason(r({ readOnly: 'not_utf8' }))).toBe('notUtf8');
    expect(roReason(r({ readOnly: 'mixed_eol' }))).toBe('mixedEol');
    expect(roReason(r({ kind: 'binary' }))).toBe('binary');
    expect(roReason(r({ kind: 'large' }))).toBe('large');
    expect(roReason(r({ kind: 'image' }))).toBe('image');
  });
  test('§5.2 large: bytes left after the 2 MB head; a long-line file under 2 MB has none', () => {
    expect(largeRest({ size: 3.4 * 1024 * 1024 })).toBeCloseTo(1.4 * 1024 * 1024, 0);
    expect(largeRest({ size: 900_000 })).toBe(0);
  });
  test('§5.2 sizes: B, KB, MB with one decimal under 10 (vi comma, en dot)', () => {
    const vi = makeT('vi'), en = makeT('en');
    expect([fmtBytes(820, vi), fmtBytes(2150, vi), fmtBytes(186_000, vi), fmtBytes(3.4 * 1024 * 1024, vi)]).toEqual(['820 B', '2,1 KB', '182 KB', '3,4 MB']);
    expect(fmtBytes(2150, en)).toBe('2.1 KB');
  });
  test('tree / ⌘P icons by kind', () => {
    expect([fileIcon('a.md'), fileIcon('a.ts'), fileIcon('logo.svg'), fileIcon('logo.icns'), fileIcon('Makefile')]).toEqual(['file', 'fileCode', 'image', 'binary', 'fileCode']);
  });
});

describe('§4.2 / V3 chip pick', () => {
  const follow: CodeSrc = { lane: null, note: { k: 'noWorktree', lane: 'D7' } };
  test('V3 a pick holds while Đang xem keeps its source; the band goes with it', () => {
    expect(pickedSrc(follow, 'base', { from: 'base', lane: 'D15' }, new Set(['D15']))).toEqual({ lane: 'D15', note: null });
  });
  test('V3 a new Đang xem source drops the pick; a picked worktree that is gone drops it too', () => {
    expect(pickedSrc(follow, 'lane:D2', { from: 'base', lane: 'D15' }, new Set(['D15']))).toBe(follow);
    expect(pickedSrc(follow, 'base', { from: 'base', lane: 'D15' }, new Set())).toBe(follow);
    expect(pickedSrc(follow, 'base', { from: 'base', lane: null }, new Set())).toEqual({ lane: null, note: null });
    expect(pickedSrc(follow, 'base', null, new Set())).toBe(follow);
  });
});
