// spec v2.7 §5.2-7 (auto import of docs/specs/*.md, state guessed once, path follow-up), §4.8 (group summary), §13 specs rows.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupSummary, scanSpecs, type KnownSpec } from '../../src/specs/scan.ts';
import { docDirs } from '../../src/workflow/runtime.ts';
import { PO } from '../_fixtures/po-pack.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ccs-scan-')); mkdirSync(join(root, 'docs/specs/done'), { recursive: true }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Quy trình PO: one doc step (`design`) over docs/specs, done/ (v2.9 §8). */
const scan = (known: readonly KnownSpec[]) => scanSpecs(root, known, docDirs(PO), PO.docsDone);
const PAD = `\n${'Nội dung spec đủ dài để vượt ngưỡng 200 byte. '.repeat(6)}\n`;
function spec(rel: string, title: string, status?: string, extraTop = 0): void {
  const top = Array.from({ length: extraTop }, (_, i) => `dòng ${i}`).join('\n');
  writeFileSync(join(root, rel), `# ${title}\n${top}\n${status ?? ''}\n${PAD}`);
}

describe('§5.2-7 scanSpecs: import + state guess', () => {
  test.each([
    ['**Trạng thái:** nháp', 'draft', false],
    ['Status: draft', 'draft', false],
    ['**Trạng thái:** Đã duyệt (rev 3)', 'approved', false],
    ['Status: Approved', 'approved', false],
    ['Trạng thái: chờ build', 'approved', false],
    ['Trạng thái: chờ implement', 'approved', false],
    ['Trạng thái: đang build G3', 'approved', true],
    ['Status: in progress', 'approved', true],
    ['Status: implement wave 2', 'approved', true],
    ['Trạng thái: đang làm', 'approved', true],
  ] as const)('§5.2-7 "%s" → %s (outside_build %s)', (line, state, outsideBuild) => {
    spec('docs/specs/a.md', 'Spec A', line);
    expect(scan([]).imports).toEqual([{ path: 'docs/specs/a.md', title: 'Spec A', state, outsideBuild, step: 'design' }]);
  });

  test.each(['Trạng thái: Done', 'Status: done', 'Trạng thái: xong', 'Trạng thái: Hoàn thành 15/11'])('§5.2-7 "%s" → skipped (not imported)', (line) => {
    spec('docs/specs/a.md', 'Spec A', line);
    expect(scan([]).imports).toEqual([]);
  });

  test('§5.2-7 no status line → draft; only the first status line counts', () => {
    spec('docs/specs/a.md', 'A');
    writeFileSync(join(root, 'docs/specs/b.md'), `# B\nTrạng thái: nháp\nStatus: done\n${PAD}`);
    expect(scan([]).imports.map((i) => [i.path, i.state])).toEqual([['docs/specs/a.md', 'draft'], ['docs/specs/b.md', 'draft']]);
  });

  test('§5.2-7 a status line after the first 20 lines is not read', () => {
    spec('docs/specs/a.md', 'A', 'Trạng thái: đã duyệt', 25);
    expect(scan([]).imports[0]!.state).toBe('draft');
  });

  test('§5.2-7 skips done/, non-.md, files < 200 bytes; not recursive', () => {
    spec('docs/specs/done/old.md', 'Old', 'Trạng thái: nháp');
    writeFileSync(join(root, 'docs/specs/tiny.md'), '# Tiny\n');
    writeFileSync(join(root, 'docs/specs/notes.txt'), `# Notes${PAD}`);
    mkdirSync(join(root, 'docs/specs/assets'));
    spec('docs/specs/assets/x.md', 'X');
    expect(scan([])).toEqual({ imports: [], moves: [], missing: [] });
  });

  test('§5.2-7 no `# ` line → title is the file name without .md', () => {
    writeFileSync(join(root, 'docs/specs/plain.md'), `no heading${PAD}`);
    expect(scan([]).imports[0]!.title).toBe('plain');
  });

  test('§5.2-7 no docs/specs dir → empty result', () => {
    rmSync(join(root, 'docs'), { recursive: true });
    expect(scan([])).toEqual({ imports: [], moves: [], missing: [] });
  });
});

describe('§5.2-7 scanSpecs: known rows (path only, never re-guessed)', () => {
  test('§5.2-7 a known row is never re-guessed nor re-imported, even after its status line changed', () => {
    spec('docs/specs/a.md', 'A', 'Trạng thái: done');
    expect(scan([{ id: 1, path: 'docs/specs/a.md', title: 'A' }])).toEqual({ imports: [], moves: [], missing: [] });
  });

  test('§5.2-7 file moved to done/ → move', () => {
    spec('docs/specs/a.md', 'A');
    renameSync(join(root, 'docs/specs/a.md'), join(root, 'docs/specs/done/a.md'));
    expect(scan([{ id: 7, path: 'docs/specs/a.md', title: 'A' }]))
      .toEqual({ imports: [], moves: [{ id: 7, from: 'docs/specs/a.md', to: 'docs/specs/done/a.md' }], missing: [] });
  });

  test('§5.2-7 renamed with the same `# ` title → move, not an import', () => {
    spec('docs/specs/b.md', 'Spec A');
    expect(scan([{ id: 7, path: 'docs/specs/a.md', title: 'Spec A' }]))
      .toEqual({ imports: [], moves: [{ id: 7, from: 'docs/specs/a.md', to: 'docs/specs/b.md' }], missing: [] });
  });

  test('§5.2-7 renamed into done/ with the same title → move', () => {
    spec('docs/specs/done/b.md', 'Spec A');
    expect(scan([{ id: 7, path: 'docs/specs/a.md', title: 'Spec A' }]).moves)
      .toEqual([{ id: 7, from: 'docs/specs/a.md', to: 'docs/specs/done/b.md' }]);
  });

  test('§5.2-7 a same-title file already owned by another row is not a rename target', () => {
    spec('docs/specs/b.md', 'Spec A');
    const r = scan([{ id: 7, path: 'docs/specs/a.md', title: 'Spec A' }, { id: 8, path: 'docs/specs/b.md', title: 'Spec A' }]);
    expect(r).toEqual({ imports: [], moves: [], missing: [7] });
  });

  test('§5.2-7 gone, different title → missing (row kept by the caller); a new file is imported', () => {
    spec('docs/specs/b.md', 'Other');
    expect(scan([{ id: 7, path: 'docs/specs/a.md', title: 'Spec A' }]))
      .toEqual({ imports: [{ path: 'docs/specs/b.md', title: 'Other', state: 'draft', outsideBuild: false, step: 'design' }], moves: [], missing: [7] });
  });

  test('§5.2-7 a symlinked docs/specs/*.md (may point out of the project) is not imported', () => {
    const out = mkdtempSync(join(tmpdir(), 'ccs-scan-out-'));
    try {
      writeFileSync(join(out, 'secret.md'), `# Secret\nTrạng thái: nháp\n${PAD}`);
      symlinkSync(join(out, 'secret.md'), join(root, 'docs/specs/zz.md'));
      expect(scan([])).toEqual({ imports: [], moves: [], missing: [] });
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  test('§5.2-7 a known row already in done/ stays put', () => {
    spec('docs/specs/done/a.md', 'A');
    expect(scan([{ id: 1, path: 'docs/specs/done/a.md', title: 'A' }])).toEqual({ imports: [], moves: [], missing: [] });
  });
});

describe('v2.9 §8 scanSpecs over a pack\'s doc folders', () => {
  test('v2.9 §8 a file is imported at the step owning its folder; a known row follows into <docs>/<docs_done>/', () => {
    mkdirSync(join(root, 'docs/plans/xong'), { recursive: true });
    spec('docs/plans/p.md', 'Plan P');
    spec('docs/specs/s.md', 'Spec S');
    spec('docs/plans/xong/q.md', 'Plan Q');
    const r = scanSpecs(root, [{ id: 3, path: 'docs/plans/q.md', title: 'Plan Q' }], [{ docs: 'docs/specs', step: 'spec' }, { docs: 'docs/plans', step: 'plan' }], 'xong');
    expect(r.imports.map((i) => [i.path, i.step])).toEqual([['docs/specs/s.md', 'spec'], ['docs/plans/p.md', 'plan']]);
    expect(r.moves).toEqual([{ id: 3, from: 'docs/plans/q.md', to: 'docs/plans/xong/q.md' }]);
  });
});

describe('§4.8 groupSummary', () => {
  test('§4.8 counts `- **G` lines of §"Nhóm việc" → "n nhóm · Gfirst–Glast"', () => {
    const text = '# S\n## 14. X\n- **G9** not here\n## 15. Nhóm việc\n- **G0** đo\n  - **G7** nested, not counted\n- **G1** a\n- **G4** b ‖ **G5** c\n- **G6** d\n## 16. Rủi ro\n- **G8** no\n';
    expect(groupSummary(text)).toBe('4 nhóm · G0–G6');
  });

  test('§4.8 one group → "1 nhóm · G0"; heading without number', () => {
    expect(groupSummary('### Nhóm việc\n- **G0** a\n')).toBe('1 nhóm · G0');
  });

  test('§4.8 no "Nhóm việc" section or no `- **G` line → null', () => {
    expect(groupSummary('# S\n- **G0** a\n')).toBeNull();
    expect(groupSummary('## Nhóm việc\ntext only\n## Next\n')).toBeNull();
  });
});
