// spec v2.2 §14.5 "Cuộn và ảo hoá" (C29): VirtualHist's pure rules.
import { describe, expect, test } from 'bun:test';
import { makeT } from '../../shared/i18n/index.ts';
import { freshLabel, gapOf, newCount, prepended, stickAfterScroll, unsticksOnKey, windowOf, type Win } from '../src/lib/vhist.ts';

/** a flex column with `gap` between children (the `.hist` box): its content height */
const column = (kids: readonly number[], gap: number): number => kids.reduce((a, b) => a + b, 0) + gap * Math.max(0, kids.length - 1);
/** what VirtualHist puts in the box for a window: top spacer, the rendered rows, bottom spacer */
const kids = (rows: readonly number[], w: Win): number[] => [
  ...(w.start > 0 ? [w.padTop] : []), ...rows.slice(w.start, w.end), ...(w.end < rows.length ? [w.padBottom] : []),
];

describe('§14.5 C29 VirtualHist', () => {
  test('F-M9 S6 "↓ 4 dòng mới": items past the last one seen while stuck; a streaming block counts once; nothing seen yet = 0', () => {
    expect(newCount([1, 2, 5, 9, Number.MAX_SAFE_INTEGER], 2)).toBe(3);
    expect(newCount([1, 2], 2)).toBe(0);
    expect(newCount([1, 2], null)).toBe(0);
    const vi = makeT('vi'), en = makeT('en');
    expect(freshLabel(vi, 4)).toBe('↓ 4 dòng mới');
    expect(freshLabel(vi, 0)).toBe('↓ mới'); // the block on screen grew, no new row
    expect(freshLabel(en, 1)).toBe('↓ 1 new');
  });
  test('§14.5 PageUp / ↑ / Home unstick at once; other keys do not', () => {
    expect(['PageUp', 'ArrowUp', 'Home'].map(unsticksOnKey)).toEqual([true, true, true]);
    expect(['PageDown', 'ArrowDown', 'End', 'a'].map(unsticksOnKey)).toEqual([false, false, false, false]);
  });

  test('§14.5 S6 a scroll up unsticks even within 30 px of the bottom; back at the bottom going down sticks again', () => {
    expect(stickAfterScroll(true, 1000, 990, 10)).toBe(false);
    expect(stickAfterScroll(false, 900, 980, 20)).toBe(true);
    expect(stickAfterScroll(false, 900, 950, 50)).toBe(false);
    expect(stickAfterScroll(true, 1000, 990, 0)).toBe(true); // content shrank under a stuck view (clamped), still at the bottom
  });

  test('§14.5 an older page on top is told by seqOf (numeric), not by the string key', () => {
    expect(prepended(120, 20)).toBe(true);
    expect(prepended(20, 20)).toBe(false);
    expect(prepended(null, 20)).toBe(false);
  });

  test('§8.4 only the visible window (+ overscan) is rendered; the rest is padding', () => {
    const w = windowOf(Array(100).fill(30), 0, 1500, 300, 60);
    expect(w.start).toBeGreaterThan(0);
    expect(w.end).toBeLessThan(100);
    expect(column(kids(Array(100).fill(30), w), 0)).toBe(3000);
  });

  test('hf1117-p1 the row gap is the box\'s computed row-gap; "normal" / empty = 0', () => {
    expect(gapOf('10px')).toBe(10);
    expect(gapOf('4.5px')).toBe(4.5);
    expect(gapOf('normal')).toBe(0);
    expect(gapOf('')).toBe(0);
  });

  test.each([4, 6, 10])('hf1117-p1 gap %ipx: spacers + rendered rows + gaps == the full list, at every scroll position', gap => {
    const rows = Array.from({ length: 80 }, (_, i) => 18 + (i * 7) % 40);
    const full = column(rows, gap);
    for (let top = 0; top < full; top += 97) expect(column(kids(rows, windowOf(rows, gap, top, 400, 300)), gap)).toBe(full);
  });

  test.each([4, 6, 10])('hf1117-p1 gap %ipx: a stuck view measuring its rows settles on one window (no flip)', gap => {
    const real = Array.from({ length: 60 }, (_, i) => 20 + (i * 13) % 50), cache = new Map<number, number>();
    const seen: string[] = [];
    let top = 1e9;
    for (let pass = 0; pass < 8; pass++) {
      const rows = real.map((h, i) => cache.get(i) ?? 26);
      const w = windowOf(rows, gap, top, 400, 300);
      top = Math.max(0, column(kids(rows, w), gap) - 400); // the layout effect sticks it to the bottom
      for (let i = w.start; i < w.end; i++) cache.set(i, real[i]!); // measure() of the rendered rows
      seen.push(`${w.start}-${w.end}-${top}`);
    }
    expect(new Set(seen.slice(-4)).size).toBe(1);
  });
});
