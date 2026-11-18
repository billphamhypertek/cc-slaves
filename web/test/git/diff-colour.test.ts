// spec v2.3 §6.2 / §5.2 / §10.3 the diff body at scale: fixed rows through `windowOf` (web review M2) and the syntax colours of
// each side (R15: the §5.2 palette through the file's Lezer language, none above the large-file line limit).
import { describe, expect, test } from 'bun:test';
import { canColour, DIFF_ROW_PX, DIFF_VIRTUAL_AFTER, diffWindow, lineSegs, paintSegs, segsOf, type Seg } from '../../src/git/diff.ts';
import { highlightSides } from '../../src/git/diff-hl.ts';

describe('§10.3 M2 diff window', () => {
  test('§10.3 every row up to the threshold; past it only the rows in view (+ overscan), padded to the full height', () => {
    expect(diffWindow(DIFF_VIRTUAL_AFTER, 0, 800)).toEqual({ start: 0, end: DIFF_VIRTUAL_AFTER, padTop: 0, padBottom: 0 });
    const n = 80_000, w = diffWindow(n, 40_000 * DIFF_ROW_PX, 800);
    expect(w.end - w.start).toBeLessThan(200);
    expect(w.start).toBeGreaterThan(39_900);
    expect(w.padTop).toBe(w.start * DIFF_ROW_PX);
    expect(w.padTop + (w.end - w.start) * DIFF_ROW_PX + w.padBottom).toBe(n * DIFF_ROW_PX);
  });
});

describe('§5.2 R15 diff colours', () => {
  test('§5.2 a range splits at line ends into per-line segments (offsets inside each line)', () => {
    const text = 'ab /* x\ny */ c\nd';
    expect(lineSegs(text, [{ from: 0, to: 2, c: 0 }, { from: 3, to: 12, c: 3 }])).toEqual([[[0, 2, 0], [3, 7, 3]], [[0, 4, 3]], []]);
  });
  test('§5.2 paintSegs: plain text between coloured runs, nothing lost', () => {
    expect(paintSegs('const a = 1', [[0, 5, 0], [10, 11, 2]])).toEqual([{ t: 'const', c: 0 }, { t: ' a = ', c: null }, { t: '1', c: 2 }]);
    expect(paintSegs('x', undefined)).toEqual([{ t: 'x', c: null }]);
  });
  test('§5.2 a deleted row takes the old side\'s line a, an added / kept row the new side\'s line b', () => {
    const sides: Seg[][][] = [[[], [[0, 1, 0]]], [[[0, 1, 1]], [], [[0, 1, 2]]]];
    expect(segsOf({ k: 'd', a: 2, b: null, t: 'x' }, sides)).toEqual([[0, 1, 0]]);
    expect(segsOf({ k: 'a', a: null, b: 3, t: 'x' }, sides)).toEqual([[0, 1, 2]]);
    expect(segsOf({ k: 'c', a: 2, b: 1, t: 'x' }, sides)).toEqual([[0, 1, 1]]);
    expect(segsOf({ k: 'c', a: 1, b: 1, t: 'x' }, undefined)).toBeUndefined();
  });
  test('§5.2 no colour above the large-file limit (a line > 20 000 chars)', () => {
    expect(canColour('a\n'.repeat(1000))).toBe(true);
    expect(canColour(`a\n${'x'.repeat(20_001)}\nb`)).toBe(false);
  });
  test('§5.2 a .ts file: keyword → palette 0 (accent), string → 1 (ok), comment → 3 (fg-3 italic); unknown ext → null', async () => {
    const h = await highlightSides('src/a.ts', ['// hi\nconst s = "x";\n']);
    expect(h).not.toBeNull();
    const [lines] = h!.sides;
    const text = ['// hi', 'const s = "x";'];
    const at = (l: number, c: number) => paintSegs(text[l]!, lines![l]).filter(p => p.c === c).map(p => p.t);
    expect(at(0, 3)).toEqual(['// hi']);
    expect(at(1, 0)).toEqual(['const']);
    expect(at(1, 1)).toEqual(['"x"']);
    expect(h!.styles[0]).toEqual({ color: 'var(--cd-kw)' });
    expect(h!.styles[3]).toEqual({ color: 'var(--cd-cm)', fontStyle: 'italic' });
    expect(await highlightSides('notes.unknownext', ['x'])).toBeNull();
  });
});
