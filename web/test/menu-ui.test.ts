// v2.1 T9 §4.12 menu behaviour kept pure: placement inside the deck area, submenu flip, ↑ ↓ Enter Esc, ContextMenu / ⇧F10,
// the 1 s move guard on "⋯", open / close timings.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { MenuItem } from '../src/lib/actions.ts';
import { histRect, MENU_CLOSE_MS, menuKey, placeMenu, placeSub, type MenuNav } from '../src/lib/menu.ts';
import { isMenuKey } from '../src/lib/keys.ts';
import { menuAllowed, MoveGuard } from '../src/deck/flow/guard.ts';
import { menuHandlers } from '../src/deck/flow/nodes.tsx';

const AREA = { x: 424, y: 52, w: 1016, h: 848 };
const it = (id: string, over: Partial<MenuItem> = {}): MenuItem => ({ id, label: id, g: 0, act: { t: 'acc', a: 'view', email: id }, ...over });

describe('§4.12 placement: inside the deck area, submenu flips left without covering the parent', () => {
  test('§4.12 default: below the "⋯", left edges aligned', () => {
    expect(placeMenu({ x: 600, y: 300, w: 20, h: 20 }, { w: 220, h: 200 }, AREA)).toEqual({ x: 600, y: 324, h: 200 });
  });
  test('§4.12 near the right edge: right-aligned to the anchor, never past the area', () => {
    const p = placeMenu({ x: 1400, y: 300, w: 20, h: 20 }, { w: 220, h: 200 }, AREA);
    expect(p.x + 220).toBeLessThanOrEqual(AREA.x + AREA.w);
    expect(p).toEqual({ x: 1200, y: 324, h: 200 });
  });
  test('§4.12 near the bottom: opens upward; taller than the area: clamped to its top', () => {
    expect(placeMenu({ x: 600, y: 800, w: 20, h: 20 }, { w: 220, h: 200 }, AREA)).toEqual({ x: 600, y: 596, h: 200 });
    expect(placeMenu({ x: 600, y: 300, w: 20, h: 20 }, { w: 220, h: 2000 }, AREA).y).toBe(AREA.y);
  });
  test('§4.12 near the left edge (deck starts at 424): pushed inside', () => {
    expect(placeMenu({ x: 300, y: 300, w: 20, h: 20 }, { w: 220, h: 200 }, AREA).x).toBe(AREA.x);
  });
  test('§4.12 submenu: right of the parent when it fits', () => {
    const parent = { x: 600, y: 300, w: 220, h: 240 };
    expect(placeSub(parent, 380, { w: 260, h: 200 }, AREA)).toEqual({ x: 822, y: 380, h: 200 });
  });
  test('§4.12 submenu flips left when no room on the right, and does not cover the parent', () => {
    const parent = { x: 1100, y: 300, w: 220, h: 240 }, size = { w: 260, h: 200 };
    const p = placeSub(parent, 380, size, AREA);
    expect(p.x + size.w).toBeLessThanOrEqual(parent.x);
    expect(p).toEqual({ x: 838, y: 380, h: 200 });
  });
  test('§4.12 submenu row near the bottom: shifted up to stay inside', () => {
    expect(placeSub({ x: 600, y: 600, w: 220, h: 240 }, 820, { w: 260, h: 200 }, AREA).y).toBe(AREA.y + AREA.h - 200);
  });
  test('§4.12 menu taller than the deck area: y = area top, height capped to the area (scrolls inside)', () => {
    expect(placeMenu({ x: 600, y: 300, w: 20, h: 20 }, { w: 220, h: 2000 }, AREA)).toEqual({ x: 600, y: AREA.y, h: AREA.h });
    expect(placeSub({ x: 600, y: 300, w: 220, h: 240 }, 380, { w: 288, h: 1040 }, AREA)).toEqual({ x: 822, y: AREA.y, h: AREA.h });
  });
  test('§4.12 open / close 180 / 140 ms (v1 U12): the CSS drop runs 180 ms, the unmount waits the 140 ms close', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.amenu{animation:mo-drop 180ms');
    expect(css).toContain(`.amenu-layer.leaving .amenu{animation:mo-drop ${MENU_CLOSE_MS}ms`);
    expect(MENU_CLOSE_MS).toBe(140);
  });
});

describe('§4.12 keyboard: ↑ ↓ Enter Esc, → / ← for the submenu', () => {
  const sub = it('switch', { act: undefined, submenu: { head: 'h', items: [it('a'), it('b', { disabled: 'why' }), it('c')] } });
  const items = [it('msg'), it('dim', { disabled: 'Mất kết nối' }), sub, it('last')];
  const at = (i: number, s: number | null = null, si = 0): MenuNav => ({ i, sub: s, si });
  test('§4.12 ↓ / ↑ move and wrap; disabled items are still reachable (their reason is read out)', () => {
    expect(menuKey(items, at(0), 'ArrowDown')!.nav.i).toBe(1);
    expect(menuKey(items, at(3), 'ArrowDown')!.nav.i).toBe(0);
    expect(menuKey(items, at(0), 'ArrowUp')!.nav.i).toBe(3);
  });
  test('§4.12 Enter runs the item; Enter on a disabled item does nothing', () => {
    expect(menuKey(items, at(0), 'Enter')!.run!.id).toBe('msg');
    expect(menuKey(items, at(1), 'Enter')!.run).toBeUndefined();
  });
  test('§4.12 Enter / → on "▸" opens the submenu on its first item; ← / Esc close only the submenu', () => {
    expect(menuKey(items, at(2), 'Enter')!.nav).toEqual(at(2, 2, 0));
    expect(menuKey(items, at(2), 'ArrowRight')!.nav).toEqual(at(2, 2, 0));
    expect(menuKey(items, at(2, 2, 2), 'ArrowLeft')!.nav).toEqual(at(2));
    const esc = menuKey(items, at(2, 2, 1), 'Escape')!;
    expect(esc.nav).toEqual(at(2));
    expect(esc.close).toBeUndefined();
  });
  test('§4.12 inside the submenu ↓ wraps and Enter runs the sub item', () => {
    expect(menuKey(items, at(2, 2, 2), 'ArrowDown')!.nav.si).toBe(0);
    expect(menuKey(items, at(2, 2, 2), 'Enter')!.run!.id).toBe('c');
    expect(menuKey(items, at(2, 2, 1), 'Enter')!.run).toBeUndefined();
  });
  test('§4.12 Esc on the menu closes it; other keys are not handled', () => {
    expect(menuKey(items, at(0), 'Escape')!.close).toBe(true);
    expect(menuKey(items, at(0), 'x')).toBeNull();
  });
});

describe('§4.11 opening keys and the §4.12 click guard', () => {
  const k = (key: string, shiftKey = false) => ({ key, shiftKey });
  test('§4.11 ContextMenu key and ⇧F10 open the menu of a focused node; F10 alone does not', () => {
    expect(isMenuKey(k('ContextMenu'))).toBe(true);
    expect(isMenuKey(k('F10', true))).toBe(true);
    expect(isMenuKey(k('F10'))).toBe(false);
    expect(isMenuKey(k('Enter'))).toBe(false);
  });
  test('§4.12 a "⋯" click within 1 s after the node moved is ignored; the keyboard is never guarded', () => {
    const g = new MoveGuard();
    g.update([{ id: 'lane:D2', x: 0, y: 0 }], 0);
    g.update([{ id: 'lane:D2', x: 0, y: 70 }], 10_000);
    expect(menuAllowed(g, 'lane:D2', 10_500, 'pointer')).toBe(false);
    expect(menuAllowed(g, 'lane:D2', 10_500, 'key')).toBe(true);
    expect(menuAllowed(g, 'lane:D2', 11_000, 'pointer')).toBe(true);
  });
  test('§4.11 node handlers: right-click and ⇧F10 open the node menu at the node, other keys pass through', () => {
    const calls: [string, unknown, string][] = [];
    const h = menuHandlers({ menu: (n, el, via) => calls.push([n, el, via]) }, 'lane:D2');
    const el = { tag: 'node' } as unknown as Element;
    let prevented = 0;
    const ev = (key = '', shiftKey = false) => ({ key, shiftKey, currentTarget: el, preventDefault: () => { prevented++; }, stopPropagation() {} });
    h.onContextMenu(ev());
    h.onKeyDown(ev('F10', true));
    h.onKeyDown(ev('ContextMenu'));
    h.onKeyDown(ev('Enter'));
    expect(calls).toEqual([['lane:D2', el, 'pointer'], ['lane:D2', el, 'key'], ['lane:D2', el, 'key']]);
    expect(prevented).toBe(3);
  });
});

describe('§4.14 "Cửa sổ < 1280 px": the history list lands where the drawer ends up, not where it is mid-slide', () => {
  test('§4.14 drawer closed (translateX -424) → list on-screen under the header', () => {
    const box = { x: 12 - 424, y: 68, w: 400, h: 700 }, head = { x: 12 - 424, y: 68, w: 400, h: 40 };
    expect(histRect(box, head, -424)).toEqual({ x: 20, y: 112, w: 384, h: 648 });
  });
  test('§4.14 wide (no transform) → same rect as before', () => {
    const box = { x: 12, y: 68, w: 400, h: 700 }, head = { x: 12, y: 68, w: 400, h: 40 };
    expect(histRect(box, head, 0)).toEqual({ x: 20, y: 112, w: 384, h: 648 });
  });
});
