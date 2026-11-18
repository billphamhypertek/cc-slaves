// v2.1 §4.12 "⋯" menu behaviour kept pure (ui/ActionMenu.tsx renders it): placement inside the deck area, the submenu
// flipping left without covering its parent, and the ↑ ↓ Enter Esc / → ← keyboard model.
import type { MenuItem } from './actions.ts';

/** v1 U12 close duration (the 180 ms open is CSS only, styles.css `.amenu`): the menu unmounts after it. */
export const MENU_CLOSE_MS = 140;
const GAP = 4, SUB_GAP = 2;

export interface Rect { x: number; y: number; w: number; h: number }
type Size = { w: number; h: number };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Placed box: `h` = its height, capped to the area so a long menu scrolls inside it (§4.12 "không vượt ra ngoài vùng bàn"). */
export interface Placed { x: number; y: number; h: number }

/** Below the anchor, left edges aligned; right-aligned / upward when that would leave the area; always inside it. */
export function placeMenu(anchor: Rect, size: Size, area: Rect): Placed {
  const right = area.x + area.w, bottom = area.y + area.h, h = Math.min(size.h, area.h);
  let x = anchor.x, y = anchor.y + anchor.h + GAP;
  if (x + size.w > right) x = anchor.x + anchor.w - size.w;
  if (y + h > bottom) y = anchor.y - h - GAP;
  return { x: clamp(x, area.x, right - size.w), y: clamp(y, area.y, bottom - h), h };
}

/** Right of the parent at the row's top; flips to the parent's left (never over it) when the right side is short. */
export function placeSub(parent: Rect, rowY: number, size: Size, area: Rect): Placed {
  const right = area.x + area.w, bottom = area.y + area.h, h = Math.min(size.h, area.h);
  let x = parent.x + parent.w + SUB_GAP;
  if (x + size.w > right) x = Math.max(area.x, parent.x - size.w - SUB_GAP);
  return { x, y: clamp(rowY, area.y, bottom - h), h };
}

/** `i` = active main item; `sub` = index of the open submenu parent (null = closed); `si` = active submenu item. */
export interface MenuNav { i: number; sub: number | null; si: number }
export interface NavOut { nav: MenuNav; run?: MenuItem; close?: true }

const wrap = (i: number, n: number) => (i + n) % n;
const runnable = (it: MenuItem | undefined) => (it && !it.disabled && it.act ? it : undefined);

/** One key on the open menu → the next state (null = key not handled, let it through). */
/** UX-M8 N2-c / N2-f / N2-g the open menu shows its keys: Enter on the first item (active when it opens), ⌘. on Ngắt lượt
 *  (menuKey runs it for this menu's lane / session, not the composer target). Submenus and items with a key keep theirs. */
export const INTERRUPT_KEY = '⌘.';
export function withHints(items: MenuItem[]): MenuItem[] {
  // a radio menu (v2.8 §4.1) opens on its checked item, not the first: no Enter hint there
  return items.map((it, i) => (it.kbd || it.submenu || it.checked !== undefined ? it : i === 0 && !it.disabled ? { ...it, kbd: 'Enter' } : it.id === 'interrupt' ? { ...it, kbd: INTERRUPT_KEY } : it));
}

export function menuKey(items: MenuItem[], nav: MenuNav, key: string): NavOut | null {
  if (nav.sub !== null) {
    const subs = items[nav.sub]?.submenu?.items ?? [];
    switch (key) {
      case 'ArrowDown': return { nav: { ...nav, si: wrap(nav.si + 1, subs.length) } };
      case 'ArrowUp': return { nav: { ...nav, si: wrap(nav.si - 1, subs.length) } };
      case 'ArrowLeft': case 'Escape': return { nav: { i: nav.i, sub: null, si: 0 } };
      case 'Enter': case ' ': { const r = runnable(subs[nav.si]); return r ? { nav, run: r } : { nav }; }
      default: return null;
    }
  }
  const cur = items[nav.i];
  switch (key) {
    case 'ArrowDown': return { nav: { ...nav, i: wrap(nav.i + 1, items.length) } };
    case 'ArrowUp': return { nav: { ...nav, i: wrap(nav.i - 1, items.length) } };
    case 'Home': return { nav: { ...nav, i: 0 } };
    case 'End': return { nav: { ...nav, i: items.length - 1 } };
    case 'Escape': case 'Tab': return { nav, close: true };
    case INTERRUPT_KEY: { const r = runnable(items.find(it => it.kbd === INTERRUPT_KEY)); return r ? { nav, run: r } : null; }
    case 'ArrowRight': case 'Enter': case ' ':
      if (cur?.submenu && !cur.disabled) return { nav: { i: nav.i, sub: nav.i, si: 0 } };
      if (key === 'ArrowRight') return { nav };
      { const r = runnable(cur); return r ? { nav, run: r } : { nav }; }
    default: return null;
  }
}

/** §4.14 the "Lịch sử phiên" list under the Inspector header. `tx` = the drawer's current translateX (mid-slide below
 *  1280 px): the rects are shifted back to where the drawer ends up, so the list is never drawn off-screen. */
export function histRect(box: Rect, head: Rect, tx: number): Rect {
  const y = head.y + head.h;
  return { x: box.x - tx + 8, y: y + 4, w: box.w - 16, h: Math.max(160, box.y + box.h - y - 12) };
}
