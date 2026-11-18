// spec v2.2 §14.5 "Cuộn và ảo hoá" (C29): the pure rules of ui/VirtualHist.tsx — the visible window, when the view
// sticks to the bottom, and when an older page was put on top.
import type { Tr } from '../../../shared/i18n/core.ts';

/** Within this many px of the bottom the view sticks (again). */
const STICK_PX = 30;
/** Keys that move the view up: the PO is reading, stop following at once (before the `scroll` event). */
const UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home']);
export const unsticksOnKey = (key: string): boolean => UP_KEYS.has(key);

/** After a `scroll` event: moving up unsticks; reaching the bottom while not moving up sticks again. */
export function stickAfterScroll(stick: boolean, prevTop: number, top: number, dist: number): boolean {
  if (top < prevTop && dist >= 1) return false;
  if (dist < STICK_PX && top >= prevTop) return true;
  return stick;
}

/** An older page went on top (the first item's seq dropped): keep the reading position. Uses `seqOf`, never the key. */
export const prepended = (prevFirst: number | null, first: number | null): boolean => prevFirst !== null && first !== null && first < prevFirst;

/** The box's computed `row-gap` in px (`"normal"` / unset = 0): the space flex puts between two rows. */
export const gapOf = (rowGap: string): number => parseFloat(rowGap) || 0;

/** `padTop` / `padBottom`: the spacer heights standing in for the rows above / below the window (each spacer gets one gap). */
export interface Win { start: number; end: number; padTop: number; padBottom: number }
/** The rendered slice of `heights` (each row's own px; the box adds `gap` between rows) for a viewport [top, top + view],
 *  `overscan` px on both sides. Spacers + rendered rows + gaps add up to exactly the full list's height. */
export function windowOf(heights: readonly number[], gap: number, top: number, view: number, overscan: number): Win {
  let y = 0, start = 0, end = heights.length, padTop = 0, padBottom = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i]! + gap;
    if (y + h < top - overscan) { start = i + 1; padTop = y + h; }
    if (y > top + view + overscan) { end = i; break; }
    y += h;
  }
  for (let i = end; i < heights.length; i++) padBottom += heights[i]! + gap;
  return { start, end, padTop: start ? padTop - gap : 0, padBottom: end < heights.length ? padBottom - gap : 0 };
}

/** §14.5 S6 how many items arrived past the last one seen at the bottom (`seen` = its seq; a streaming block counts once). */
export const newCount = (seqs: readonly number[], seen: number | null): number => (seen === null ? 0 : seqs.filter(s => s > seen).length);
/** §14.5 S6 "↓ 4 dòng mới"; "↓ mới" when only the block on screen grew. */
export const freshLabel = (tr: Tr, n: number): string => (n > 0 ? tr('stream.newerN', { n }) : tr('stream.newer'));
