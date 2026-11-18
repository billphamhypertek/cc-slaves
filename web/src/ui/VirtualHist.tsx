// Virtualized conversation (§8.4: only the visible window is in the DOM; ≤ 500 lines in memory). v2.2 §14.5 C29: the only
// owner of scrolling. Heights are measured after render and cached by the item's string key (a streaming block keeps its
// height when its full line takes over); a growing item never gets shorter; up input unsticks at once; a ResizeObserver
// keeps a stuck view at the bottom; opening / closing a row keeps that row's top still. The row gap is the box's own CSS
// `row-gap` (hf1117-p1: a hard-coded copy drifted from styles.css and the window flipped every frame).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { gapOf, newCount, prepended, stickAfterScroll, unsticksOnKey, windowOf } from '../lib/vhist.ts';

const EST = 20, OVERSCAN = 600; // EST: an unmeasured row's own height (the gap comes on top)

export interface VirtualHistProps<T> {
  items: T[];
  keyOf(item: T): string;
  /** the line seq of an item (older page detection) */
  seqOf(item: T): number;
  render(item: T): ReactNode;
  /** a streaming item: its height only grows */
  growing?(item: T): boolean;
  tail?: ReactNode; // system bands, always after the last item
  color: string;
  onTop?(): void; // scrolled near the top → load an older page
  /** §14.5 S6 "↓ n dòng mới": shown while not stuck and something new arrived; `n` = items past the last one seen */
  newLabel?(n: number): string;
}

export function VirtualHist<T>(p: VirtualHistProps<T>): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>()); // each row's own offsetHeight, without the gap
  const gap = useRef(0);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const firstSeq = useRef<number | null>(null);
  const prevHeight = useRef(0);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const seen = useRef<number | null>(null); // seq of the last item while the view was at the bottom
  const [fresh, setFresh] = useState(false);
  const [, setTick] = useState(0);
  const el = box.current;
  const top = el?.scrollTop ?? 0, view = el?.clientHeight ?? 400;

  const hs = p.items.map(it => heights.current.get(p.keyOf(it)) ?? EST);
  const w = windowOf(hs, gap.current, top, view, OVERSCAN);

  /** measure the rendered rows; a growing row keeps its tallest height */
  const measure = (b: HTMLElement): boolean => {
    let changed = false;
    b.querySelectorAll<HTMLElement>(':scope > [data-vk]').forEach(n => {
      const k = n.dataset.vk!, hh = n.offsetHeight;
      if (heights.current.get(k) !== hh) { heights.current.set(k, hh); changed = true; }
    });
    return changed;
  };
  const lastSeq = () => (p.items.length ? p.seqOf(p.items[p.items.length - 1]!) : null);
  const toBottom = (b: HTMLElement) => { b.scrollTop = b.scrollHeight; lastTop.current = b.scrollTop; };
  /** a row the PO opened / closed: keep its top where it was, then stick only if that left the view at the bottom */
  const keepAnchor = (b: HTMLElement): boolean => {
    const a = anchor.current;
    if (!a) return false;
    anchor.current = null;
    const n = b.querySelector<HTMLElement>(`:scope > [data-vk="${CSS.escape(a.key)}"]`);
    if (!n) return false;
    b.scrollTop += n.getBoundingClientRect().top - a.top;
    lastTop.current = b.scrollTop;
    stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 1;
    return true;
  };

  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const changed = measure(b);
    const fs = p.items.length ? p.seqOf(p.items[0]!) : null;
    const older = prepended(firstSeq.current, fs);
    if (older && !stick.current) b.scrollTop += b.scrollHeight - prevHeight.current; // older page on top: keep the reading position
    firstSeq.current = fs;
    if (!keepAnchor(b) && stick.current) toBottom(b);
    else if (!stick.current && !older && b.scrollHeight > prevHeight.current) setFresh(true);
    if (stick.current) seen.current = lastSeq();
    prevHeight.current = b.scrollHeight;
    if (changed) setTick(t => t + 1);
  });

  // §14.5 heights change between renders (a row opens, highlight lands, fonts load): follow them
  useEffect(() => {
    const b = box.current;
    if (!b || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(es => {
      // the box resized (also once on observe, at mount, before the first paint): re-read its CSS row gap; cached heights
      // exclude the gap, so a new gap only needs a render
      const g = es.some(e => e.target === b) ? gapOf(getComputedStyle(b).rowGap) : gap.current;
      const changed = measure(b) || g !== gap.current;
      gap.current = g;
      if (!keepAnchor(b) && stick.current) toBottom(b);
      prevHeight.current = b.scrollHeight;
      if (changed) setTick(t => t + 1);
    });
    // N1 the box too: the composer growing shrinks it, and a stuck view stays on the newest row
    const watchRows = () => { ro.disconnect(); ro.observe(b); b.querySelectorAll(':scope > [data-vk]').forEach(n => ro.observe(n)); };
    watchRows();
    const mo = new MutationObserver(watchRows);
    mo.observe(b, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);

  const unstick = () => { stick.current = false; };
  const onScroll = () => {
    const b = box.current!;
    const dist = b.scrollHeight - b.scrollTop - b.clientHeight;
    stick.current = stickAfterScroll(stick.current, lastTop.current, b.scrollTop, dist);
    lastTop.current = b.scrollTop;
    if (stick.current) setFresh(false);
    if (b.scrollTop < 40) p.onTop?.();
    setTick(t => t + 1);
  };
  const jump = () => { const b = box.current!; stick.current = true; seen.current = lastSeq(); setFresh(false); toBottom(b); };

  return (
    <div className="hist" ref={box} onScroll={onScroll} style={{ '--c': p.color } as CSSProperties}
      onWheel={e => { if (e.deltaY < 0) unstick(); }}
      onKeyDown={e => { if (unsticksOnKey(e.key)) unstick(); }}
      // a press on the scrollbar (right of the content box) is a drag of the bar
      onPointerDown={e => { const b = box.current!; if (e.clientX - b.getBoundingClientRect().left > b.clientWidth) unstick(); }}
      onClickCapture={e => {
        const n = (e.target as HTMLElement).closest<HTMLElement>('[data-vk]');
        if (n && (e.target as HTMLElement).closest('button,summary')) anchor.current = { key: n.dataset.vk!, top: n.getBoundingClientRect().top };
      }}>
      {w.start ? <div style={{ height: w.padTop }} aria-hidden /> : null}
      {p.items.slice(w.start, w.end).map(it => {
        const k = p.keyOf(it), min = p.growing?.(it) ? heights.current.get(k) : undefined;
        return <div key={k} data-vk={k} style={{ display: 'flex', flexDirection: 'column', minHeight: min }}>{p.render(it)}</div>;
      })}
      {w.end < p.items.length ? <div style={{ height: w.padBottom }} aria-hidden /> : null}
      {p.tail}
      {fresh && p.newLabel ? <button type="button" className="hist-new" onClick={jump}>{p.newLabel(newCount(p.items.map(it => p.seqOf(it)), seen.current))}</button> : null}
    </div>
  );
}
