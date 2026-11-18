// v2.3 UX I4 (mockup G8 / G15 / G16): a clipped scroll list fades its last 20 px while more content is below, so the PO sees
// "there is more" while the scrollbars are dark at rest (§6.8 D54: they only light while the user scrolls).
// `gscroll` = the list overflows at all (M4: only then it keeps a floor).
// v2.4 m7 / m8: `up` also fades the first 20 px while content hides above (the chip strip, the session dialogs' body).
import { useCallback, useEffect, useRef, type RefCallback, type UIEvent } from 'react';

interface Scroller { scrollHeight: number; clientHeight: number; scrollTop: number; classList: { toggle(c: string, on: boolean): unknown } }

/** Sets `gscroll` / `gfade` (/ `gfade-up` with `up`) from the scroll box (1 px slack for sub-pixel scroll positions). */
export function syncFade(el: Scroller, up = false): void {
  const hidden = el.scrollHeight - el.clientHeight;
  el.classList.toggle('gscroll', hidden > 1);
  el.classList.toggle('gfade', hidden - el.scrollTop > 1);
  el.classList.toggle('gfade-up', up && hidden > 1 && el.scrollTop > 1);
}

/** The list's ref + scroll handler: re-checked on scroll, on resize and when its rows change. */
export function useFade<T extends HTMLElement>(up = false): { ref: RefCallback<T>; onScroll: (e: UIEvent<T>) => void } {
  const stop = useRef<(() => void) | null>(null);
  const ref = useCallback((el: T | null) => {
    stop.current?.();
    stop.current = null;
    if (!el) return;
    const sync = () => syncFade(el, up);
    sync();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(sync);
    ro?.observe(el);
    mo?.observe(el, { childList: true, subtree: true });
    stop.current = () => { ro?.disconnect(); mo?.disconnect(); };
  }, [up]);
  useEffect(() => () => stop.current?.(), []);
  return { ref, onScroll: e => syncFade(e.currentTarget, up) };
}
