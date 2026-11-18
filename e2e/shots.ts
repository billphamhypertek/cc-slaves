// Shared E2E_SHOTS=1 screenshot helper (v2 §6A, T9a ⑥): each frame at 1280×800 and 1024×640, and nothing may overflow
// sideways — neither the frame roots (dialogs, the inbox, panels) nor any table cell, button or clipping / scrolling box
// inside them (an `en` label longer than the Vietnamese one it was sized for widens the table, and `.tw-wrap` then
// scrolls sideways). Designed truncation (`text-overflow: ellipsis`) is allowed.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';

const SHOTS = !!process.env.E2E_SHOTS;
const SHOT_DIR = join(import.meta.dirname, '../docs/specs/assets/screens');
const ROOTS = '[role=dialog], #inbox, #inspector, #listview';

/** Every root, table cell, button and non-`visible` overflow box under `roots` whose content is wider than its box,
 *  every `.seg` on more than one row and every plain-text button label on more than one line. */
async function overflows(page: Page, roots = ROOTS): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const name = (e: Element) => `${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') ?? e.id ?? '') || (e.textContent ?? '').trim().slice(0, 40)}"`;
    for (const root of document.querySelectorAll(sel)) {
      for (const e of [root, ...root.querySelectorAll('*')]) {
        const el = e as HTMLElement, cs = getComputedStyle(el);
        if (el !== root && !el.matches('td, th, button') && cs.overflowX === 'visible') continue;
        if (!el.offsetParent && el !== root) continue; // hidden
        if (cs.textOverflow === 'ellipsis') continue;
        if (el.scrollWidth > el.clientWidth + 1) out.push(name(el));
      }
      // A longer label can also reflow instead of overflowing: a segmented control (`.seg`) breaking onto two rows, or
      // a plain-text button label wrapping onto a second line.
      const rows = (tops: number[], lh: number) => tops.sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1]! > lh * 0.6).length;
      const lh = (el: Element) => { const cs = getComputedStyle(el); return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2; };
      for (const seg of root.querySelectorAll('.seg')) {
        const bs = [...seg.querySelectorAll('button')].filter(b => (b as HTMLElement).offsetParent);
        if (bs.length > 1 && rows(bs.map(b => b.getBoundingClientRect().top), lh(seg)) > 1) out.push(`${name(seg)} wraps`);
      }
      for (const b of root.querySelectorAll('button')) {
        if (!(b as HTMLElement).offsetParent || [...b.children].some(c => !getComputedStyle(c).display.startsWith('inline') && c.tagName !== 'svg')) continue;
        const r = document.createRange();
        r.selectNodeContents(b);
        const tops = [...r.getClientRects()].filter(x => x.width > 0).map(x => x.top);
        if (tops.length && rows(tops, lh(b)) > 1) out.push(`${name(b)} label wraps`);
      }
    }
    return out;
  }, roots);
}

/** No-op unless E2E_SHOTS=1. Writes `<file>.png` and `<file>-1024.png` under docs/specs/assets/screens. */
export async function shot(page: Page, file: string, roots = ROOTS): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  for (const [w, h] of [[1280, 800], [1024, 640]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    expect(await overflows(page, roots), `${file} ${w}×${h} overflows`).toEqual([]);
    await page.screenshot({ path: join(SHOT_DIR, `${file}${w === 1024 ? '-1024' : ''}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}
