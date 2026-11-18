// spec v2.3 §10.1 "Cắt giữa" + §11 Web-unit "`midEllipsis` (giữ đuôi, đủ trong `title`)".
import { describe, expect, test } from 'bun:test';
import { midEllipsis, textWidth } from '../src/lib/mid-ellipsis.ts';

/** a stubbed mono measurer: 10 px per character */
const mono = (t: string) => t.length * 10;

describe('§10.1 midEllipsis', () => {
  test('fits → unchanged', () => {
    expect(midEllipsis('engine/src/a.ts', 150, mono)).toBe('engine/src/a.ts');
  });
  test('§10.1 keeps the tail (file name + extension) whole and longer than the head', () => {
    const out = midEllipsis('engine/src/server/handlers/git-branches.ts', 200, mono);
    expect(mono(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith('git-branches.ts')).toBe(true);
    const [head, tail] = out.split('…');
    expect(tail!.length).toBeGreaterThan(head!.length);
    expect(out).toBe('engi…git-branches.ts');
  });
  test('§10.1 the tail wins when even the file name does not fit', () => {
    const out = midEllipsis('src/a-very-long-component-file-name.tsx', 100, mono);
    expect(mono(out)).toBeLessThanOrEqual(100);
    const [head, tail] = out.split('…');
    expect(out.endsWith('.tsx')).toBe(true);
    expect(tail!.length).toBeGreaterThan(head!.length);
  });
  test('§5.1 a bare name (tree row) or a file name longer than the room keeps its head and its tail', () => {
    const out = midEllipsis('2026-11-02-billing-usage-alerts-design.md', 200, mono);
    expect(out).toBe('2026-1…rts-design.md');
    expect(midEllipsis('src/a-very-long-component-file-name.tsx', 100, mono)).toBe('src…me.tsx');
  });
  test('uses the most of the width (no needless cut)', () => {
    expect(mono(midEllipsis('abcdefghijklmnopqrstuvwxyz', 100, mono))).toBe(100);
  });
  test('too narrow for anything → just the ellipsis', () => {
    expect(midEllipsis('abcdef', 5, mono)).toBe('…');
  });
});

describe('§10.1 midEllipsis cuts on grapheme clusters (web review M1)', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  test('§10.1 an emoji name never leaves a lone surrogate, at any width', () => {
    const name = 'docs/🚀🚀-release-🎉-notes-👩‍👩‍👧-final.md';
    for (let px = 10; px <= 400; px += 1) {
      const out = midEllipsis(name, px, mono);
      expect(lone.test(out)).toBe(false);
      expect(out).not.toMatch(/‍…|…‍/); // no half of a ZWJ family
    }
  });
  test('§10.1 an NFD Vietnamese name (macOS readdir) never glues a combining mark to "…"', () => {
    const name = 'tài-liệu-hướng-dẫn-cài-đặt-ứng-dụng.md'.normalize('NFD');
    for (let px = 10; px <= 400; px += 1) expect(midEllipsis(name, px, mono)).not.toMatch(/…[̀-ͯ]/u);
    const out = midEllipsis(name, 200, mono);
    expect(mono(out)).toBeLessThanOrEqual(200);
    expect(out.normalize('NFC')).toBe('tài-l…ng-dụng.md'); // whole letters on both sides of the cut
  });
});

describe('§6.7 D53 textWidth without a canvas', () => {
  test('§6.7 D53 the per-character fallback follows the font size (0.6 em mono), no hand-written 7.2', () => {
    expect(textWidth('abcd', '11px "JetBrains Mono"')).toBeCloseTo(4 * 6.6);
    expect(textWidth('abcd', '13px "JetBrains Mono"')).toBeCloseTo(4 * 7.8);
  });
});
