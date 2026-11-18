// v2.9 §5.9 the draft folder: layout, the §5.1 files only (a stray one is V11), the diff the canvas tags read.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DraftDisk, diffFiles, type DraftMeta } from '../../src/workflow/drafts.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const meta = (base: Record<string, string> = {}): DraftMeta => ({ id: '0123abcd-0000', fromId: null, baseRev: null, base, sessionId: 's', started: false, account: null, model: null, lines: [] });

describe('DraftDisk', () => {
  test('create: pack/ = base, the three examples, the // deny settings, meta', () => {
    const root = mkdtempSync(join(tmpdir(), 'drafts-'));
    dirs.push(root);
    const disk = new DraftDisk(root);
    disk.create(meta({ 'WORKFLOW.md': 'a' }));
    const d = disk.dir('0123abcd-0000');
    expect(readFileSync(join(d, 'pack', 'WORKFLOW.md'), 'utf8')).toBe('a');
    for (const s of ['po', 'spec-plan', 'direct']) expect(existsSync(join(d, 'examples', s, 'WORKFLOW.md'))).toBe(true);
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toContain(`Edit(/${d}/examples/**)`);
    expect(disk.loadAll().map((m) => m.id)).toEqual(['0123abcd-0000']);
  });

  test('read: only §5.1 files; a stray file is V11, never in the files', () => {
    const root = mkdtempSync(join(tmpdir(), 'drafts-'));
    dirs.push(root);
    const disk = new DraftDisk(root);
    disk.create(meta({ 'WORKFLOW.md': 'a', 'steps/lane.md': 'b' }));
    writeFileSync(join(disk.packDir('0123abcd-0000'), 'notes.txt'), 'x');
    writeFileSync(join(disk.dir('0123abcd-0000'), 'outside.md'), 'x');
    const r = disk.read('0123abcd-0000');
    expect(Object.keys(r.files).sort()).toEqual(['WORKFLOW.md', 'steps/lane.md']);
    expect(r.errors).toEqual([expect.objectContaining({ code: 'V11', file: 'notes.txt' })]);
  });

  test('rel: a tool path as the pack path, through the macOS /private real path too', () => {
    const disk = new DraftDisk('/var/h/workflow-drafts');
    expect(disk.rel('0123abcd-0000', '/private/var/h/workflow-drafts/0123abcd-0000/pack/steps/plan.md')).toBe('steps/plan.md');
    expect(disk.rel('0123abcd-0000', '/var/h/workflow-drafts/0123abcd-0000/pack/WORKFLOW.md')).toBe('WORKFLOW.md');
    expect(disk.rel('0123abcd-0000', '/elsewhere/x.md')).toBe('x.md');
  });

  test('a bad id never reaches the disk', () => {
    expect(() => new DraftDisk('/tmp').dir('../x')).toThrow();
  });
});

test('diffFiles: added / changed / removed, .layout.json ignored', () => {
  expect(diffFiles({ 'WORKFLOW.md': 'a', 'steps/x.md': 'x', '.layout.json': '1' }, { 'WORKFLOW.md': 'b', 'steps/y.md': 'y', '.layout.json': '2' }))
    .toEqual({ added: ['steps/y.md'], changed: ['WORKFLOW.md'], removed: ['steps/x.md'] });
});
