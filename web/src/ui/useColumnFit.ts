// v2.4 §6.2 I1 + §6.7 R32 the Đang xem room at a short window: Chờ PO takes at most 30 % of the left column (styles in
// ui/inbox.css), so this only measures the Đang xem parts, hands lib/model.ts `columnFit` the numbers and returns whether the
// chip strip caps at one row.
import { useLayoutEffect, useState, type RefObject } from 'react';
import { columnFit } from '../lib/model.ts';

const px = (v: string) => parseFloat(v) || 0;
const outer = (el: Element | null) => {
  if (!el) return 0;
  const cs = getComputedStyle(el);
  return el.getBoundingClientRect().height + px(cs.marginTop) + px(cs.marginBottom);
};

/** a lane's facts block scrolls on its own (F-I8): what must stay on screen is its facts (down to the last fact row or the
 *  folded line) + the sticky Subagent head under them (v2.1 UX-I6), not the whole subagent list. */
function laneNeed(info: Element): number {
  const facts = [...info.querySelectorAll('.lhead .kv, .lhead .kvsum')].at(-1);
  if (!facts) return info.scrollHeight;
  const head = info.querySelector('.subsec .log-h'), top = info.getBoundingClientRect().top - info.scrollTop;
  return facts.getBoundingClientRect().bottom - top + (head ? head.getBoundingClientRect().height : 0);
}

/** the chip strip at one and at two rows, measured from its first chip, its row gap and its bottom pad (D53: no px copy of
 *  attach.css) */
function trayRows(tray: Element): { one: number; two: number } {
  const chip = tray.firstElementChild, cs = getComputedStyle(tray);
  const h = chip ? chip.getBoundingClientRect().height : 0, pad = px(cs.paddingTop) + px(cs.paddingBottom);
  return { one: h + pad, two: 2 * h + px(cs.rowGap) + pad };
}

/** `mode` Điều phối (its head never scrolls) or a lane (facts + Subagent head, no conversation floor, m-2 N2-a); null = off.
 *  `key` changes when the observed nodes may be replaced (another view / session state). */
export function useColumnFit(box: RefObject<HTMLElement | null>, mode: 'orch' | 'lane' | null, key: string): boolean {
  const [trayOne, setTrayOne] = useState(false);
  useLayoutEffect(() => {
    const sec = box.current;
    if (!sec || !mode) { setTrayOne(false); return; }
    const measure = () => {
      const info = sec.querySelector('.iinfo'), tray = sec.querySelector('.tray'), hist = sec.querySelector('.hist');
      const hs = hist ? getComputedStyle(hist) : null, rows = tray ? trayRows(tray) : { one: 0, two: 0 };
      const full = tray ? Math.min(tray.scrollHeight, rows.two) : 0; // the strip at its full 2 rows
      const composer = [...sec.querySelectorAll(':scope > .aline, :scope > .inrow')].reduce((n, el) => n + outer(el), 0)
        + (tray ? full - tray.clientHeight : 0);
      const f = columnFit({
        room: sec.clientHeight,
        info: outer(sec.querySelector(':scope > .ih'))
          + (info ? (mode === 'lane' ? laneNeed(info) : info.scrollHeight) + info.getBoundingClientRect().height - info.clientHeight : 0),
        composer, tray: full, one: rows.one, histPad: hs ? px(hs.paddingTop) + px(hs.paddingBottom) : 0,
        ...(mode === 'lane' ? { floor: 0 } : {}),
      });
      setTrayOne(f.trayOne);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sec);
    for (const el of sec.querySelectorAll(':scope > .iinfo, :scope > .iinfo > *, :scope > .inrow, :scope > .hist')) ro.observe(el);
    return () => { ro.disconnect(); };
  }, [mode, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return trayOne;
}
