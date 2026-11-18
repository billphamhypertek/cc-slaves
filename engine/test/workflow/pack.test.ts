// spec v2.9 §5.1 / §5.4 V1 V2 V3 V11 / §6.1: reading, splitting and hashing a pack.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packRev, parsePack, readPackDir, splitFrontmatter } from '../../src/workflow/pack.ts';
import { basePack, fm, packWith } from './_packs.ts';

const codes = (files: Record<string, string>) => parsePack(files).errors.map((e) => e.code);

describe('§5.1 frontmatter split', () => {
  test('yaml between the two --- lines, body verbatim without the edge blank lines', () => {
    const s = splitFrontmatter('---\nname: x # c\n---\n\nline 1\n\n  line 2\n\n');
    expect(s).toEqual({ yaml: 'name: x # c', yamlLine: 2, body: 'line 1\n\n  line 2' });
  });
  test('no frontmatter → whole text is the body', () => {
    expect(splitFrontmatter('just text\n')).toEqual({ yaml: '', yamlLine: 1, body: 'just text' });
  });
  test('an unclosed frontmatter is V1', () => {
    const e = parsePack(packWith({ 'steps/build.md': '---\ntype: build\nbody' })).errors;
    expect(e).toEqual([{ code: 'V1', file: 'steps/build.md', step: 'build', msg: 'Frontmatter thiếu dòng `---` đóng' }]);
  });
});

describe('§5.4 V1 broken YAML', () => {
  test('the line of a parse error comes from the prefix scan (file line, not yaml line)', () => {
    const e = parsePack(packWith({ 'steps/design.md': fm('type: design\nname: x\nlabels: { group: a, waiting: b\nnext: { to: build }') })).errors;
    expect(e).toEqual([{ code: 'V1', file: 'steps/design.md', step: 'design', line: 4, msg: 'YAML hỏng ở dòng 4' }]);
  });
  test('a duplicate top-level key (Bun keeps the last silently)', () => {
    const e = parsePack(packWith({ 'steps/lane.md': fm('type: lane\ntype: build\nphases: [done]') })).errors;
    expect(e).toEqual([{ code: 'V1', file: 'steps/lane.md', step: 'lane', line: 3, msg: 'khoá `type` lặp ở dòng 3' }]);
  });
  test('a duplicate key one level down in a block map; the same key under two parents is fine', () => {
    const y = 'name: a\nrules:\n  priority_first: true\n  priority_first: false\nlabels:\n  name: x';
    expect(parsePack(packWith({ 'WORKFLOW.md': fm(y) })).errors.map((x) => x.msg)).toEqual(['khoá `priority_first` lặp ở dòng 5']);
    expect(codes(packWith({ 'WORKFLOW.md': fm('name: a\nrules:\n  priority_first: true\nkickoff:\n  priority_first: x') }))).toEqual([]);
  });
  test('a frontmatter that is not a key table', () => {
    expect(parsePack(packWith({ 'steps/general.md': fm('- a\n- b') })).errors.map((x) => x.msg)).toEqual(['Frontmatter phải là bảng khoá (`khoá: giá trị`)']);
  });
});

describe('§5.4 V2 V3 V11 files', () => {
  test('a valid pack parses with the steps sorted by id', () => {
    const r = parsePack(basePack());
    expect(r.errors).toEqual([]);
    expect(r.pack.steps.map((s) => s.id)).toEqual(['build', 'design', 'general', 'lane']);
    expect(r.pack.workflow?.body).toBe('Lời dặn chung.');
  });
  test('V2 no WORKFLOW.md', () => { expect(codes(packWith({ 'WORKFLOW.md': null }))).toEqual(['V2']); });
  test('V3 a step file name outside [a-z0-9-]{1,24}, or the reserved id done', () => {
    expect(codes(packWith({ 'steps/Plan.md': fm('type: design') }))).toEqual(['V3']);
    expect(codes(packWith({ 'steps/a-very-long-step-name-over-24.md': fm('type: design') }))).toEqual(['V3']);
    expect(codes(packWith({ 'steps/done.md': fm('type: design') }))).toEqual(['V3']);
  });
  test('V3 an id key that does not match the file name', () => {
    expect(parsePack(packWith({ 'steps/build.md': fm('id: builder\ntype: build\nnext: { to: done }') })).errors.map((x) => x.msg))
      .toEqual(['`id` builder không khớp tên file build']);
  });
  test('V11 a file outside §5.1; .layout.json is accepted and not a step', () => {
    expect(codes(packWith({ 'notes.txt': 'x' }))).toEqual(['V11']);
    expect(codes(packWith({ 'steps/sub/x.md': 'x' }))).toEqual(['V11']);
    expect(codes(packWith({ 'steps/x.txt': 'x' }))).toEqual(['V11']);
    expect(codes(packWith({ '.layout.json': '{}' }))).toEqual([]);
  });
});

describe('§6.1 rev', () => {
  test('sha256 over WORKFLOW.md + steps/*.md by name: order-independent, .layout.json ignored, any byte changes it', () => {
    const a = basePack();
    const rev = packRev(a);
    expect(rev).toMatch(/^[0-9a-f]{64}$/);
    expect(packRev(Object.fromEntries(Object.entries(a).reverse()))).toBe(rev);
    expect(packRev({ ...a, '.layout.json': '{"x":1}' })).toBe(rev);
    expect(packRev({ ...a, 'steps/lane.md': `${a['steps/lane.md']} ` })).not.toBe(rev);
    expect(packRev({ ...a, 'steps/lane2.md': a['steps/lane.md']! })).not.toBe(rev);
  });
});

describe('§5.1 / §10.3 reading a pack folder', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccs-pack-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };

  test('reads the §5.1 files, skips dot entries other than .layout.json, keeps strays for V11', () => {
    for (const [k, v] of Object.entries(basePack())) put(k, v);
    put('.layout.json', '{}'); put('.DS_Store', 'x'); put('.git/HEAD', 'x'); put('steps/.swp', 'x'); put('README.md', 'x');
    const r = readPackDir(dir);
    expect(r.errors).toEqual([]);
    expect(Object.keys(r.files).sort()).toEqual(['.layout.json', 'README.md', 'WORKFLOW.md', 'steps/build.md', 'steps/design.md', 'steps/general.md', 'steps/lane.md']);
    expect(codes(r.files)).toEqual(['V11']);
  });
  test('a symlink is never followed (V11)', () => {
    for (const [k, v] of Object.entries(basePack())) put(k, v);
    put('../outside.md', fm('type: general'));
    symlinkSync(join(dir, '..', 'outside.md'), join(dir, 'steps', 'evil.md'));
    const r = readPackDir(dir);
    expect(r.errors.map((e) => [e.code, e.file])).toEqual([['V11', 'steps/evil.md']]);
    expect(r.files['steps/evil.md']).toBeUndefined();
    rmSync(join(dir, '..', 'outside.md'));
  });
  test('v29-fw IMPORTANT-1 a stray file is listed by name only, never read', () => {
    for (const [k, v] of Object.entries(basePack())) put(k, v);
    for (let i = 0; i < 400; i++) put(`junk-${i}.log`, 'x'.repeat(4096));
    const r = readPackDir(dir);
    expect(r.errors).toEqual([]);
    expect(r.files['junk-7.log']).toBe('');
    expect(JSON.stringify(r).length).toBeLessThan(300 * 1024);
    expect(codes(r.files).filter((c) => c === 'V11')).toHaveLength(400);
  });
  test('v29-fw IMPORTANT-1 the §5.1 files past 256 KB in total: one V11 and reading stops', () => {
    for (const [k, v] of Object.entries(basePack())) put(k, v);
    for (const id of ['a1', 'a2', 'a3', 'a4']) put(`steps/${id}.md`, fm('type: design', 'y'.repeat(100 * 1024)));
    const r = readPackDir(dir);
    expect(r.errors).toEqual([{ code: 'V11', file: 'steps/a3.md', msg: 'Gói quá 256 KB' }]);
    expect(Object.keys(r.files).filter((p) => p.startsWith('steps/a'))).toEqual(['steps/a1.md', 'steps/a2.md']);
    expect(Object.keys(r.files)).not.toContain('steps/lane.md');
  });
  test('v29-fw MINOR-2 CRLF line ends and a leading BOM are normalised on read', () => {
    for (const [k, v] of Object.entries(basePack())) put(k, v);
    put('steps/build.md', `\uFEFF${fm('type: build\nname: Build\nnext: { to: done }', 'Build.').replace(/\n/g, '\r\n')}`);
    const r = readPackDir(dir);
    expect(r.files['steps/build.md']).toBe(fm('type: build\nname: Build\nnext: { to: done }', 'Build.'));
    expect(parsePack(r.files).pack.steps.find((s) => s.id === 'build')!.fm.name).toBe('Build');
  });
  test('a missing folder reads as no files (V2 follows)', () => {
    const r = readPackDir(join(dir, 'nope'));
    expect(r.files).toEqual({});
    expect(codes(r.files)).toEqual(['V2']);
  });
});
