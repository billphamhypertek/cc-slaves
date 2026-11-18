// v2.8 PO 17/11: the favicon's pale cyan / yellow wash out on the light theme; the light theme shows logo-light.svg instead.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const lum = (h: string): number => {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const css = readFileSync('web/src/styles.css', 'utf8');
const light = css.match(/:root\[data-theme=light\]\{([^}]*)\}/)![1]!;
const v = (n: string): string => light.match(new RegExp(`--${n}:(#[0-9a-f]{6})`))![1]!;

describe('light brand logo', () => {
  test('the light theme swaps the logo', () => {
    expect(css).toContain(':root[data-theme=light] .logo{background-image:url(/logo-light.svg)}');
  });
  test('same glyph as the favicon, every stroke ≥ 3:1 on the light --bg and --bg-2', () => {
    const fav = readFileSync('web/public/favicon.svg', 'utf8'), lt = readFileSync('web/public/logo-light.svg', 'utf8');
    const shape = (s: string): string => s.replace(/stroke="#[0-9a-f]{6}"/g, '');
    expect(shape(lt)).toBe(shape(fav));
    const strokes = [...lt.matchAll(/stroke="(#[0-9a-f]{6})"/g)].map(m => m[1]!);
    expect(strokes.length).toBe(3);
    for (const s of strokes) for (const bg of [v('bg'), v('bg-2')]) expect(ratio(s, bg)).toBeGreaterThanOrEqual(3);
  });
});
