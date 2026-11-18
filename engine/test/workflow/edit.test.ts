// spec v2.9 §10.2 `workflow_edit`: canvas edits applied by key through patch.ts (nothing written), each md file read back
// with its read-only keys, the §5.4 findings of the result, a refused key reported and its file unchanged.
import { describe, expect, test } from 'bun:test';
import { applyEdits } from '../../src/workflow/edit.ts';
import { basePack, fm } from './_packs.ts';

describe('§10.2 applyEdits', () => {
  test('no edit = the files read back + their findings', () => {
    const r = applyEdits(basePack(), []);
    expect(r.files).toEqual(basePack());
    expect(r.errors).toEqual([]);
    expect(r.docs['steps/design.md']).toEqual({ fm: { type: 'design', name: 'Thiết kế', docs: 'docs/specs', next: { to: 'build', start: 'button' } }, body: 'Viết spec. {{tools}}', readOnly: [] });
    expect(r.failed).toEqual([]);
  });

  test('a key, a body and a dropped key change only their own line; comments stay', () => {
    const files = basePack({ 'steps/design.md': fm('type: design   # loại\nname: Thiết kế\ndocs: docs/specs\nnext: { to: build, start: button }', 'Cũ.') });
    const r = applyEdits(files, [
      { path: 'steps/design.md', key: 'name', value: 'Soạn' },
      { path: 'steps/design.md', body: 'Mới.\n\n{{tools}}' },
      { path: 'steps/design.md', key: 'docs' },
    ]);
    expect(r.files['steps/design.md']).toBe('---\ntype: design   # loại\nname: Soạn\nnext: { to: build, start: button }\n---\nMới.\n\n{{tools}}\n');
    expect(r.docs['steps/design.md']!.fm).toEqual({ type: 'design', name: 'Soạn', next: { to: 'build', start: 'button' } });
    expect(files['steps/design.md']).toContain('docs: docs/specs'); // the input map is not mutated
  });

  test('a whole file: a new step from an empty text + keys, a removed one; findings follow (V6 on a dangling next)', () => {
    const r = applyEdits(basePack(), [
      { path: 'steps/plan.md', text: '' },
      { path: 'steps/plan.md', key: 'type', value: 'design' },
      { path: 'steps/plan.md', key: 'name', value: 'Plan' },
      { path: 'steps/plan.md', key: 'next', value: { to: 'build', start: 'button' } },
      { path: 'steps/design.md', key: 'next', value: { to: 'plan', start: 'auto' } },
      { path: 'steps/build.md', text: null },
    ]);
    expect(r.files['steps/plan.md']).toBe('---\ntype: design\nname: Plan\nnext: { to: build, start: button }\n---\n');
    expect(r.files['steps/build.md']).toBeUndefined();
    expect(r.errors.map((e) => e.code)).toContain('V6');
  });

  test('a key written in a form the canvas cannot rewrite: refused, file unchanged, listed read-only', () => {
    const files = basePack({ 'steps/build.md': fm('type: build\nname: Build\nkickoff:\n  new: |\n    nhiều dòng\nnext: { to: done }', 'B.') });
    const r = applyEdits(files, [{ path: 'steps/build.md', key: 'kickoff', value: { new: 'x' } }]);
    expect(r.failed.map((f) => [f.path, f.key])).toEqual([['steps/build.md', 'kickoff']]);
    expect(r.failed[0]!.reason).toContain('sửa trong file');
    expect(r.files['steps/build.md']).toBe(files['steps/build.md']);
    expect(r.docs['steps/build.md']!.readOnly).toEqual(['kickoff']);
  });

  test('a broken YAML file reads back with fm null and is a V1 finding', () => {
    const r = applyEdits(basePack({ 'steps/build.md': '---\ntype: [build\n---\nB.' }), []);
    expect(r.docs['steps/build.md']!.fm).toBeNull();
    expect(r.errors.some((e) => e.code === 'V1' && e.file === 'steps/build.md')).toBe(true);
  });
});
