// spec v2.3 §10.1 "Cắt giữa": cut a path in the middle so it fits `px`, the tail (file name + extension) kept whole when it
// can and always longer than the head. Callers put the full path in `title`.

import { fontPx } from './mono-font.ts';

export type Measure = (text: string) => number;

const ELL = '…';
/** no canvas: a mono glyph advances 0.6 em (JetBrains Mono) */
const MONO_EM = 0.6;
const cache = new Map<string, Measure>();
/** canvas `measureText` in the row's font (e.g. `12px "JetBrains Mono"`), one context per font. */
function canvasMeasure(font: string): Measure {
  const hit = cache.get(font);
  if (hit) return hit;
  const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext?.('2d') : null;
  const m: Measure = ctx ? (t => { ctx.font = font; return ctx.measureText(t).width; }) : (t => t.length * fontPx(font) * MONO_EM);
  cache.set(font, m);
  return m;
}

/** v2.4 §6.3 the width of `text` in `font` (the label prefix / suffix around a cut name). */
export const textWidth = (text: string, font: string): number => canvasMeasure(font)(text);

/** the text as grapheme clusters (an emoji, a ZWJ family or an NFD letter + its combining marks is one), so a cut
 *  never splits a surrogate pair or leaves a mark glued to "…" (macOS readdir can return NFD names). */
const SEG = new Intl.Segmenter();
const graphemes = (text: string): string[] => Array.from(SEG.segment(text), s => s.segment);

/** `n` clusters kept: the tail takes the file name (or 2/3 of `n` when that is longer), the head the rest. A file name
 *  that alone does not fit keeps its own head too (`2026-11-02-bil…alerts-design.md`, §5.1): tail 2/3, head 1/3. */
function cut(g: readonly string[], n: number, base: number): string {
  const tail = base >= n ? Math.ceil((2 * n) / 3) : Math.max(Math.ceil((2 * n) / 3), base);
  return g.slice(0, n - tail).join('') + ELL + (tail ? g.slice(g.length - tail).join('') : '');
}

/** `measure` is either a font string (canvas) or a measurer (tests). */
export function midEllipsis(text: string, px: number, measure: string | Measure): string {
  const w = typeof measure === 'string' ? canvasMeasure(measure) : measure;
  if (w(text) <= px) return text;
  const g = graphemes(text);
  const base = g.length - g.lastIndexOf('/') - 1;
  for (let n = g.length - 1; n > 0; n--) {
    const out = cut(g, n, base);
    if (w(out) <= px) return out;
  }
  return ELL;
}
