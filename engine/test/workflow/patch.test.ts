// spec v2.9 §10.2 / §15 A6: the canvas writes one key at a time; patchFrontmatter rewrites only that key's line / block and
// keeps key order, comments and the body; a key it cannot read for sure is read-only.
import { describe, expect, test } from 'bun:test';
import { builtinFiles } from '../../src/workflow/builtin/index.ts';
import { patchBody, patchFrontmatter, readOnlyKeys } from '../../src/workflow/patch.ts';
import { splitFrontmatter } from '../../src/workflow/pack.ts';

const DESIGN = `---
# bước đầu
type: design
name: Thiết kế   # tên trên canvas
docs: docs/specs
labels: { group: Đang thiết kế, waiting: Chờ build }
skills_deny:
  - { skill: superpowers:writing-plans, reason: "vì \\"plan\\"" }
  - superpowers:executing-plans
next: { to: build, start: button }
---
Thân giữ nguyên.

  thụt lề {{tools}}
`;
const fmOf = (text: string) => Bun.YAML.parse(splitFrontmatter(text)!.yaml) as Record<string, unknown>;
const ok = (r: ReturnType<typeof patchFrontmatter>): string => {
  if (!r.ok) throw new Error(r.reason);
  return r.text;
};

describe('§10.2 patchFrontmatter', () => {
  test('a one-line key: only that line changes, its inline comment stays', () => {
    const out = ok(patchFrontmatter(DESIGN, 'name', 'Soạn spec'));
    expect(out).toBe(DESIGN.replace('name: Thiết kế   # tên trên canvas', 'name: Soạn spec   # tên trên canvas'));
  });
  test('a flow map: rewritten in flow style, the rest of the file byte-identical', () => {
    const out = ok(patchFrontmatter(DESIGN, 'labels', { group: 'Đang soạn', waiting: 'Chờ plan', start: 'Bắt đầu plan' }));
    expect(out).toBe(DESIGN.replace('labels: { group: Đang thiết kế, waiting: Chờ build }', 'labels: { group: Đang soạn, waiting: Chờ plan, start: Bắt đầu plan }'));
  });
  test('a block list: the whole block replaced in block style, the next key and the body untouched', () => {
    const value = [{ skill: 'superpowers:brainstorming', reason: 'có: hai chấm # và "ngoặc"' }, 'mine'];
    const out = ok(patchFrontmatter(DESIGN, 'skills_deny', value));
    expect(out).toContain('skills_deny:\n  - { skill: superpowers:brainstorming, reason: "có: hai chấm # và \\"ngoặc\\"" }\n  - mine\nnext: { to: build, start: button }\n---\nThân giữ nguyên.\n\n  thụt lề {{tools}}\n');
    expect(fmOf(out).skills_deny).toEqual(value);
    expect(Object.keys(fmOf(out))).toEqual(['type', 'name', 'docs', 'labels', 'skills_deny', 'next']);
    expect(out.startsWith('---\n# bước đầu\ntype: design\n')).toBe(true);
  });
  test('a new key goes last, before the closing ---; undefined deletes the key and its block', () => {
    const added = ok(patchFrontmatter(DESIGN, 'kickoff', { new: 'Mở {project}' }));
    expect(added).toContain('next: { to: build, start: button }\nkickoff: { new: "Mở {project}" }\n---\n');
    const gone = ok(patchFrontmatter(DESIGN, 'skills_deny', undefined));
    expect(gone).toBe(DESIGN.replace(/skills_deny:\n(?: {2}- .*\n)+/, ''));
  });
  test('scalars: plain when safe, quoted when YAML would read them otherwise', () => {
    for (const v of ['true', '12', 'a: b', '# x', '- x', 'x #y', '', ' lề', 'null', '[x]', "it's", 'a,b', '{x}']) {
      expect(fmOf(ok(patchFrontmatter(DESIGN, 'name', v))).name).toBe(v);
    }
    expect(ok(patchFrontmatter(DESIGN, 'name', 'superpowers:x'))).toContain('\nname: superpowers:x   # tên');
    const n = ok(patchFrontmatter('---\nrules: { max_doc_sessions: 3 }\n---\n', 'rules', { priority_first: false, max_doc_sessions: 4 }));
    expect(n).toBe('---\nrules: { priority_first: false, max_doc_sessions: 4 }\n---\n');
  });
  test('a value YAML would read back differently is refused (the result is parsed back and compared)', () => {
    expect(patchFrontmatter(DESIGN, 'rules', { max_doc_sessions: Number.NaN })).toEqual({ ok: false, reason: 'Không ghi được khoá `rules` an toàn: sửa trong file' });
  });
  test('a block map stays a block map', () => {
    const out = ok(patchFrontmatter(builtinFiles('po')['steps/build.md']!, 'kickoff', { new: 'a', resume: 'b' }));
    expect(out).toContain('\nkickoff:\n  new: a\n  resume: b\nskills_deny:\n');
  });
  test('a file with no frontmatter gets one; an unclosed one is refused', () => {
    expect(ok(patchFrontmatter('Chỉ có thân.\n', 'type', 'general'))).toBe('---\ntype: general\n---\nChỉ có thân.\n');
    expect(patchFrontmatter('---\ntype: x\n', 'type', 'general')).toEqual({ ok: false, reason: 'Frontmatter thiếu dòng `---` đóng' });
  });
  test('a key whose YAML it cannot read for sure is read-only and refused', () => {
    const odd = `---
type: lane
description: |
  nhiều dòng
base: &b { a: 1 }
copy: *b
tagged: !!str x
phases: [queue,
  done]
skills_deny:
  # chú thích giữa khối
  - x
plain: một dòng
  tiếp dòng
name: Lane
---
`;
    expect(readOnlyKeys(odd)).toEqual(['description', 'base', 'copy', 'tagged', 'phases', 'skills_deny', 'plain']);
    expect(patchFrontmatter(odd, 'phases', ['done'])).toEqual({ ok: false, reason: 'Khoá `phases` viết kiểu không sửa được trên canvas: sửa trong file' });
    expect(ok(patchFrontmatter(odd, 'name', 'L'))).toBe(odd.replace('name: Lane', 'name: L'));
    expect(readOnlyKeys(DESIGN)).toEqual([]);
    for (const f of Object.values(builtinFiles('po'))) expect(readOnlyKeys(f)).toEqual([]);
  });
  test('v29-fw MINOR-3 an inline comment on a block item makes the key read-only (a rewrite would drop it)', () => {
    const t = '---\nskills_deny:\n  - a   # one\n  - b\nname: x\n---\n';
    expect(readOnlyKeys(t)).toEqual(['skills_deny']);
    expect(patchFrontmatter(t, 'skills_deny', ['a', 'c']).ok).toBe(false);
    expect(readOnlyKeys('---\nlabels:\n  group: a # g\n---\n')).toEqual(['labels']);
  });
});

describe('§10.2 patchBody', () => {
  test('the frontmatter bytes are kept, the body is written verbatim', () => {
    expect(patchBody(DESIGN, 'Mới\n\n  dòng 2')).toBe(`${DESIGN.slice(0, DESIGN.indexOf('Thân'))}Mới\n\n  dòng 2\n`);
    expect(patchBody('không có frontmatter', 'x')).toBe('x\n');
  });
});
