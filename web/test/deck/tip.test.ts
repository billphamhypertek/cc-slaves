// v1.1 §4.4 tooltip: never over a card or a HUD box, never past the window, never wider than 320 px (re-review N1).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { placeTip, tipSize, TIP_MAX_W, TIP_STEP } from '../../src/deck/model.ts';
import type { Rect } from '../../src/deck/model.ts';

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const est = (t: string) => t.length * 7; // 7 px per glyph: the 838-px "Lane: L1 … L30" line is ~120 glyphs

describe('§4.4 tooltip text', () => {
  test('§4.4 tooltip width is capped at 320 px and long lines wrap (height grows)', () => {
    const long = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join(', '); // 838 px-class line
    const s = tipSize(['acc003@', `Lane: ${long}`], est);
    expect(TIP_MAX_W).toBe(320);
    expect(s.w).toBeLessThanOrEqual(320);
    expect(s.h).toBeGreaterThan(2 * 18 + 16);
    const short = tipSize(['D2 · Đang chạy'], est);
    // v2.4 §6.7 D53 .dtip: var(--xs)/1.5 → 18 px a line (the --xs step from the mono-font home: 12 px without a DOM, hot fix
    // 2026-11-16); padding var(--s3) var(--s4) (7 / 10) + 1 px border → 16 px tall, 22 px wide (T12a: a pad smaller than the
    // real one left the 5-line tip taller than placed, so it ran past the window bottom at 1024)
    expect(short).toEqual({ w: Math.ceil(est('D2 · Đang chạy')) + 22, h: 18 + 16 });
    const css = readFileSync(new URL('../../src/deck/flow/flow.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.dtip\{[^}]*padding:var\(--s3\) var\(--s4\);border:1px solid[^}]*font:500 var\(--xs\)\/1\.5/);
    expect(TIP_STEP).toBe('xs'); // DeckView's measure font + the line height read the same step as the CSS above
  });
});

describe('§4.4 placeTip', () => {
  const vp1280 = { w: 1280, h: 800 }, vp1024 = { w: 1024, h: 640 };
  // v1 HUD at 1280: top bar, inbox on the right, console docked at the bottom
  const hud1280: Rect[] = [{ x: 0, y: 0, w: 1280, h: 56 }, { x: 960, y: 72, w: 304, h: 420 }, { x: 16, y: 520, w: 1248, h: 264 }];
  const hud1024: Rect[] = [{ x: 0, y: 0, w: 1024, h: 56 }, { x: 16, y: 372, w: 992, h: 252 }];

  test('§4.4 T12a 1024: drawer (0–424) + open account panel (712–1024): a 274-px tip lands in the gap between them', () => {
    const vp = { w: 1024, h: 768 }, size = { w: 274, h: 90 };
    const obs: Rect[] = [{ x: 0, y: 56, w: 424, h: 712 }, { x: 712, y: 90, w: 312, h: 678 }];
    for (const [x, y] of [[600, 300], [480, 500], [700, 140]] as const) {
      const [l, t] = placeTip(x, y, size, obs, vp), box = { x: l, y: t, ...size };
      for (const o of obs) expect(overlaps(box, o)).toBe(false);
      expect(l).toBeGreaterThanOrEqual(424);
      expect(l + size.w).toBeLessThanOrEqual(712);
      expect(Math.abs(t - y)).toBeLessThan(size.h + 20); // stays next to the pointer row
    }
  });
  test('§4.4 a HUD box is an obstacle like a card (tip near the console goes above the pointer)', () => {
    const size = { w: 200, h: 48 }, [l, t] = placeTip(500, 490, size, hud1280, vp1280);
    for (const r of hud1280) expect(overlaps({ x: l, y: t, ...size }, r)).toBe(false);
  });
  test('§4.4 the 838-px-wide input is clamped inside the viewport at 1280 and 1024 (DKN account tip)', () => {
    for (const [vp, hud] of [[vp1280, hud1280], [vp1024, hud1024]] as const) {
      const size = { w: 838, h: 48 }, [l, t] = placeTip(662, 300, size, hud, vp);
      expect(l).toBeGreaterThanOrEqual(4);
      expect(t).toBeGreaterThanOrEqual(4);
      expect(l + size.w).toBeLessThanOrEqual(vp.w - 4);
      expect(t + size.h).toBeLessThanOrEqual(vp.h - 4);
    }
  });
  test('§4.4 a capped DKN tip at 1280 lands inside the viewport and off #inbox / #console', () => {
    const size = tipSize(['acc003@', 'còn 40 %', '30 lane: L1, L2, L3 … +27'], est);
    for (const [x, y] of [[900, 300], [900, 480], [662, 500], [100, 500]] as const) {
      const [l, t] = placeTip(x, y, size, hud1280, vp1280), box = { x: l, y: t, ...size };
      expect(l).toBeGreaterThanOrEqual(4);
      expect(l + size.w).toBeLessThanOrEqual(vp1280.w - 4);
      expect(t + size.h).toBeLessThanOrEqual(vp1280.h - 4);
      for (const r of hud1280) expect(overlaps(box, r)).toBe(false);
    }
  });
});
