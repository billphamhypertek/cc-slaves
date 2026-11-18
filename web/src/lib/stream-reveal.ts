// spec v2.2 §14.5 "Nhịp" (C27): how fast the streamed text of one block appears. Each block keeps {shown, rate, budget};
// the rate is set when a chunk arrives (never lowered while a backlog remains), one rAF loop drains every shown block.
// Proven by docs/ref/v2.2-pacing-sim.mjs (web/test/stream-reveal.test.ts reproduces its table).

/** A chunk drains within this many ms of its arrival … */
const DRAIN_MS = 250;
/** … or this many after `partial_end` / the full line. */
const END_DRAIN_MS = 150;
/** A slow frame never counts for more than this (no "dump" after a stall). */
const DT_CAP_MS = 50;
/** The target moves past the next whitespace when it is at most this many chars ahead (no half words). */
const WORD_AHEAD = 16;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface Reveal {
  /** what arrived so far */
  text: string;
  /** chars of `text` on screen (always a grapheme boundary) */
  shown: number;
  /** chars per ms */
  rate: number;
  /** fractional chars owed to the next frames */
  budget: number;
}
export type Part = { delta: string } | { full: string };

export const newReveal = (): Reveal => ({ text: '', shown: 0, rate: 0, budget: 0 });

const speedUp = (r: Reveal, drainMs: number) => { r.rate = Math.max(r.rate, (r.text.length - r.shown) / drainMs); };

/** §14.5 a chunk arrived (`delta` appends, `full` replaces): rate = max(rate, backlog / 250 ms). */
export function arrive(r: Reveal, part: Part): void {
  r.text = 'full' in part ? part.full : r.text + part.delta;
  r.shown = Math.min(r.shown, r.text.length);
  speedUp(r, DRAIN_MS);
}
/** §14.5 `partial_end` or the full line arrived: rate = max(rate, backlog / 150 ms). */
export const endReveal = (r: Reveal): void => speedUp(r, END_DRAIN_MS);

/** The first grapheme boundary at or after `i`. */
function graphemeEnd(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const s = GRAPHEMES.segment(text).containing(i);
  return !s || s.index === i ? i : s.index + s.segment.length;
}
const isSpace = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t';

/** One frame of `dtMs` for one block; returns whether `shown` moved. */
export function stepReveal(r: Reveal, dtMs: number): boolean {
  const len = r.text.length;
  if (r.shown >= len) { r.rate = 0; r.budget = 0; return false; }
  r.budget += r.rate * Math.min(dtMs, DT_CAP_MS);
  let target = Math.min(len, r.shown + Math.floor(r.budget));
  if (target <= r.shown) return false;
  for (let k = target; k <= target + WORD_AHEAD && k < len; k++) {
    if (isSpace(r.text[k])) { target = k + 1; break; }
  }
  target = Math.min(graphemeEnd(r.text, target), len);
  r.budget = Math.max(0, r.budget - (target - r.shown));
  r.shown = target;
  return true;
}

/** Reduced motion / a tab coming back: show all that arrived. */
function showAll(r: Reveal): boolean {
  const moved = r.shown < r.text.length;
  r.shown = r.text.length; r.rate = 0; r.budget = 0;
  return moved;
}

export interface RevealClock { now(): number; raf(cb: () => void): number; caf(id: number): void }
export interface RevealLoopOpts {
  clock: RevealClock;
  /** macOS reduced motion or `config.reducedMotion` (the deck's `motionPolicy().reduced`) */
  reduced: () => boolean;
  /** the keys whose shown text moved this frame — called at most once per frame (one React push) */
  onFrame: (keys: string[]) => void;
}
export interface RevealLoop {
  push(key: string, part: Part): void;
  /** a block already on screen (shown before its surface was paced): `shown` of `text` stays, only later text is paced */
  seed(key: string, text: string, shown: number): void;
  end(key: string): void;
  drop(key: string): void;
  /** the shown part of a block ('' when unknown) */
  text(key: string): string;
  /** tab hidden → the loop stops; visible again → every backlog shows in one push */
  setHidden(hidden: boolean): void;
}

/** §14.5 the single `requestAnimationFrame` loop for every block on screen. */
export function createRevealLoop(o: RevealLoopOpts): RevealLoop {
  const blocks = new Map<string, Reveal>();
  let frame: number | null = null, last = 0, hidden = false;
  const backlog = () => [...blocks.values()].some(b => b.shown < b.text.length);
  const tick = () => {
    frame = null;
    const now = o.clock.now(), dt = now - last; last = now;
    const reduced = o.reduced(), moved: string[] = [];
    for (const [k, b] of blocks) if (reduced ? showAll(b) : stepReveal(b, dt)) moved.push(k);
    if (moved.length) o.onFrame(moved);
    schedule();
  };
  const schedule = () => {
    if (frame !== null || hidden || !backlog()) return;
    frame = o.clock.raf(tick);
  };
  const start = () => { if (frame === null) last = o.clock.now(); schedule(); };
  return {
    push(key, part) {
      let b = blocks.get(key);
      if (!b) { b = newReveal(); blocks.set(key, b); }
      arrive(b, part); start();
    },
    seed(key, text, shown) { blocks.set(key, { text, shown: Math.min(shown, text.length), rate: 0, budget: 0 }); speedUp(blocks.get(key)!, DRAIN_MS); start(); },
    end(key) { const b = blocks.get(key); if (b) { endReveal(b); start(); } },
    drop(key) { blocks.delete(key); if (!backlog() && frame !== null) { o.clock.caf(frame); frame = null; } },
    text(key) { const b = blocks.get(key); return b ? b.text.slice(0, b.shown) : ''; },
    setHidden(h) {
      if (h === hidden) return;
      hidden = h;
      if (h) { if (frame !== null) o.clock.caf(frame); frame = null; return; }
      const moved = [...blocks].filter(([, b]) => showAll(b)).map(([k]) => k);
      if (moved.length) o.onFrame(moved);
    },
  };
}
