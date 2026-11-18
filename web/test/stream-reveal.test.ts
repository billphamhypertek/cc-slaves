// spec v2.2 §14.5 "Nhịp" (C27) + §14.7: the per-block pacing model reproduces the table of docs/ref/v2.2-pacing-sim.mjs
// (fixed dt, Vietnamese text with combining marks), and the single rAF driver obeys reduced motion / hidden tab.
import { describe, expect, test } from 'bun:test';
import { arrive, createRevealLoop, endReveal, newReveal, stepReveal, type RevealClock } from '../src/lib/stream-reveal.ts';

const SEG = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WORDS = 'Đây là đoạn văn tiếng Việt có dấu ệ ổ ữ để kiểm tra nhịp hiện chữ khi stream ';
const mkText = (n: number) => { let s = ''; while (s.length < n) s += WORDS; return s.slice(0, n); };
/** the sim's text again, every "ệ" spelt NFD (e + U+0323 + U+0302) — three code units, one grapheme. */
const mkNfd = (n: number) => mkText(n * 2).normalize('NFD').slice(0, n);

/** a chunk may end inside a grapheme (a token split before its combining mark): what counts is the text that arrived. */
const onBoundary = (s: string, i: number) => i === s.length || SEG.segment(s).containing(i)?.index === i;
interface Arrival { t: number; n: number }
interface Run { frames: number; ms: number; afterLastMs: number; maxLagMs: number; mono: boolean; cut: boolean }
/** The sim's `run()` driven by the real model: arrivals before each frame, then one `stepReveal(dt)`. */
function run(o: { text: string; fps: number; arrivals: Arrival[]; endAt?: number; dt?: number }): Run {
  const { text, fps, arrivals } = o;
  const dt = o.dt ?? 1000 / fps;
  const r = newReveal(); const arrT: number[] = [];
  let arrived = 0, ai = 0, t = 0, frames = 0, lastArr = 0, maxLag = 0, mono = true, cut = false, ended = false;
  while (t < 20_000) {
    while (ai < arrivals.length && arrivals[ai]!.t <= t) {
      const a = arrivals[ai++]!;
      for (let k = 0; k < a.n; k++) arrT[arrived + k] = a.t;
      const next = Math.min(text.length, arrived + a.n);
      arrive(r, { delta: text.slice(arrived, next) }); arrived = next; lastArr = a.t;
    }
    if (!ended && o.endAt != null && t >= o.endAt) { ended = true; endReveal(r); }
    const before = r.shown;
    stepReveal(r, dt);
    if (r.shown < before) mono = false;
    if (!onBoundary(text.slice(0, arrived), r.shown)) cut = true;
    for (let i = before; i < r.shown; i++) maxLag = Math.max(maxLag, t - arrT[i]!);
    frames++; t += dt;
    if (ai >= arrivals.length && r.shown >= text.length) break;
  }
  return { frames, ms: Math.round(frames * dt), afterLastMs: Math.round(frames * dt - lastArr), maxLagMs: Math.round(maxLag), mono, cut };
}
const burst = (n: number): Arrival[] => [{ t: 0, n }];
const steady = (per: number, every: number, dur: number): Arrival[] => { const a: Arrival[] = []; for (let t = 0; t < dur; t += every) a.push({ t, n: per }); return a; };
/** the sim's seeded jitter: 1–120 chars every 10–200 ms for 5 s (Park–Miller, seed 7). */
function jitter(seed = 7): { arrivals: Arrival[]; total: number } {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const arrivals: Arrival[] = []; let t = 0, total = 0;
  while (t < 5000) { const k = 1 + Math.floor(rnd() * 120); arrivals.push({ t, n: k }); total += k; t += 10 + rnd() * 190; }
  return { arrivals, total };
}
const ok = { mono: true, cut: false };

describe('§14.5 Nhịp — the sim table (docs/ref/v2.2-pacing-sim.mjs)', () => {
  test('§14.5 burst 600 chars → done after 15 frames / 250 ms at 60 fps, max lag 233 ms; 27 frames at 120 fps', () => {
    expect(run({ text: mkText(600), fps: 60, arrivals: burst(600) })).toEqual({ frames: 15, ms: 250, afterLastMs: 250, maxLagMs: 233, ...ok });
    expect(run({ text: mkText(600), fps: 120, arrivals: burst(600) })).toEqual({ frames: 27, ms: 225, afterLastMs: 225, maxLagMs: 217, ...ok });
  });
  test('§14.5 burst 2 000 chars → 15 frames at 60 fps, 29 at 120 fps', () => {
    expect(run({ text: mkText(2000), fps: 60, arrivals: burst(2000) })).toEqual({ frames: 15, ms: 250, afterLastMs: 250, maxLagMs: 233, ...ok });
    expect(run({ text: mkText(2000), fps: 120, arrivals: burst(2000) })).toEqual({ frames: 29, ms: 242, afterLastMs: 242, maxLagMs: 233, ...ok });
  });
  test('§14.5 steady 40 chars / 50 ms for 3 s → 188 frames, 183 ms after the last chunk, max lag 200 ms', () => {
    expect(run({ text: mkText(2400), fps: 60, arrivals: steady(40, 50, 3000) })).toEqual({ frames: 188, ms: 3133, afterLastMs: 183, maxLagMs: 200, ...ok });
    expect(run({ text: mkText(2400), fps: 120, arrivals: steady(40, 50, 3000) }).frames).toBe(361);
  });
  test('§14.5 steady 5 chars / 30 ms for 2 s → 122 frames, 53 ms after the last chunk, max lag 93 ms', () => {
    expect(run({ text: mkText(335), fps: 60, arrivals: steady(5, 30, 2000) })).toEqual({ frames: 122, ms: 2033, afterLastMs: 53, maxLagMs: 93, ...ok });
    expect(run({ text: mkText(335), fps: 120, arrivals: steady(5, 30, 2000) }).frames).toBe(242);
  });
  test('§14.5 600 chars + partial_end at once → 9 frames / 150 ms (≤ 9 frames, §14.7)', () => {
    expect(run({ text: mkText(600), fps: 60, arrivals: burst(600), endAt: 0 })).toEqual({ frames: 9, ms: 150, afterLastMs: 150, maxLagMs: 133, ...ok });
    expect(run({ text: mkText(600), fps: 120, arrivals: burst(600), endAt: 0 }).frames).toBe(18);
  });
  test('§14.5 600 chars then 1 char at 200 ms → done 50 ms after it, no char later than 250 ms', () => {
    const r = run({ text: mkText(601), fps: 60, arrivals: [{ t: 0, n: 600 }, { t: 200, n: 1 }] });
    expect(r).toEqual({ frames: 15, ms: 250, afterLastMs: 50, maxLagMs: 233, ...ok });
  });
  test('§14.5 seeded jitter 1–120 chars / 10–200 ms for 5 s → 303 frames, max lag 223 ms ≤ 250', () => {
    const { arrivals, total } = jitter();
    expect(run({ text: mkText(total), fps: 60, arrivals })).toEqual({ frames: 303, ms: 5050, afterLastMs: 211, maxLagMs: 223, ...ok });
  });
  test('§14.7 other seeds: max lag ≤ 250 ms, monotonic, never mid-grapheme', () => {
    for (const seed of [1, 42, 9001, 123457]) {
      const { arrivals, total } = jitter(seed);
      const r = run({ text: mkNfd(total), fps: 60, arrivals });
      expect(r.maxLagMs).toBeLessThanOrEqual(250);
      expect({ mono: r.mono, cut: r.cut }).toEqual(ok);
    }
  });
  test('§14.7 NFD "ệ" (combining marks) is never split, in a burst and in a steady stream', () => {
    const text = mkNfd(600);
    expect(text.normalize('NFC')).not.toBe(text);
    for (const arrivals of [burst(600), steady(7, 20, 2000)]) {
      const r = run({ text, fps: 60, arrivals });
      expect({ mono: r.mono, cut: r.cut }).toEqual(ok);
    }
  });
  test('§14.7 dt = 200 ms counts as 50 ms (a slow frame does not dump the backlog)', () => {
    const r = newReveal(); arrive(r, { delta: 'x'.repeat(1000) });
    stepReveal(r, 200);
    expect(r.shown).toBe(200); // 1000 / 250 ms × 50 ms
  });
  test('§14.5 rate is set on arrival and never drops while a backlog remains; empty backlog → rate 0, budget 0', () => {
    const r = newReveal(); arrive(r, { delta: 'a'.repeat(500) });
    expect(r.rate).toBe(2);
    stepReveal(r, 50);
    arrive(r, { delta: 'b' }); // backlog 401 / 250 < 2 → keep 2
    expect(r.rate).toBe(2);
    for (let i = 0; i < 20; i++) stepReveal(r, 50);
    expect(r.shown).toBe(501);
    expect({ rate: r.rate, budget: r.budget }).toEqual({ rate: 0, budget: 0 });
  });
  test('§14.5 a word is not shown in halves: the target moves past the next space ≤ 16 chars ahead', () => {
    const r = newReveal(); arrive(r, { delta: 'abc defghijkl mnopqrstuvwxyz0123456789 end' });
    r.rate = 1; stepReveal(r, 2); // budget 2 → "ab" → next space at 3 → "abc "
    expect(r.text.slice(0, r.shown)).toBe('abc ');
    r.rate = 1; stepReveal(r, 1);
    expect(r.text.slice(0, r.shown)).toBe('abc defghijkl ');
    r.rate = 1; stepReveal(r, 1); // next space is 25 chars ahead → plain grapheme step
    expect(r.shown).toBe(15);
  });
  test('§14.5 `full` replaces the text; shown never passes what arrived', () => {
    const r = newReveal(); arrive(r, { full: 'xin chào' }); arrive(r, { delta: ' bạn' });
    expect(r.text).toBe('xin chào bạn');
    stepReveal(r, 50);
    expect(r.shown).toBeLessThanOrEqual(r.text.length);
  });
});

/** A fake clock: `raf` queues, `tick(ms)` advances time and runs one frame. */
function fakeClock(): RevealClock & { tick(ms: number): void; pending(): number; calls: number } {
  let t = 0, id = 0; const q = new Map<number, () => void>();
  const c = {
    calls: 0,
    now: () => t,
    raf: (cb: () => void) => { c.calls++; q.set(++id, cb); return id; },
    caf: (i: number) => { q.delete(i); },
    tick(ms: number) { t += ms; const cbs = [...q.values()]; q.clear(); for (const cb of cbs) cb(); },
    pending: () => q.size,
  };
  return c;
}

describe('§14.5 one rAF loop for every shown block', () => {
  test('§14.5 two keys share one frame; React is pushed at most once per frame', () => {
    const clock = fakeClock(); const frames: string[][] = [];
    const loop = createRevealLoop({ clock, reduced: () => false, onFrame: k => frames.push(k) });
    loop.push('m1:0', { delta: 'một hai ba bốn năm sáu bảy tám chín mười '.repeat(5) });
    loop.push('m1:1', { delta: 'one two three four five six seven eight '.repeat(5) });
    expect(clock.pending()).toBe(1);
    clock.tick(16);
    expect(frames).toEqual([['m1:0', 'm1:1']]);
    for (let i = 0; i < 30; i++) clock.tick(16);
    expect(loop.text('m1:0')).toBe('một hai ba bốn năm sáu bảy tám chín mười '.repeat(5));
    expect(clock.pending()).toBe(0); // backlog gone → the loop stops (v2.1 G7 "để yên → 0 việc")
  });
  test('§14.5 partial_end drains within 150 ms of real frames', () => {
    const clock = fakeClock();
    const loop = createRevealLoop({ clock, reduced: () => false, onFrame: () => {} });
    loop.push('k', { delta: 'x '.repeat(300) }); loop.end('k');
    for (let i = 0; i < 9; i++) clock.tick(1000 / 60);
    expect(loop.text('k')).toBe('x '.repeat(300));
  });
  test('§14.7 reduced motion → every frame shows all that arrived', () => {
    const clock = fakeClock();
    const loop = createRevealLoop({ clock, reduced: () => true, onFrame: () => {} });
    loop.push('k', { delta: 'chữ '.repeat(200) });
    clock.tick(16);
    expect(loop.text('k')).toBe('chữ '.repeat(200));
  });
  test('§14.7 hidden tab → the loop stops (no requestAnimationFrame); back → the whole backlog shows at once', () => {
    const clock = fakeClock(); const frames: string[][] = [];
    const loop = createRevealLoop({ clock, reduced: () => false, onFrame: k => frames.push(k) });
    loop.setHidden(true);
    loop.push('k', { delta: 'ẩn '.repeat(100) });
    expect(clock.calls).toBe(0);
    loop.setHidden(false);
    expect(loop.text('k')).toBe('ẩn '.repeat(100));
    expect(frames).toEqual([['k']]);
    expect(clock.pending()).toBe(0);
  });
  test('§14.5 a hidden tab mid-stream cancels the scheduled frame', () => {
    const clock = fakeClock();
    const loop = createRevealLoop({ clock, reduced: () => false, onFrame: () => {} });
    loop.push('k', { delta: 'a '.repeat(400) });
    expect(clock.pending()).toBe(1);
    loop.setHidden(true);
    expect(clock.pending()).toBe(0);
  });
  test('§14.5 a slow frame (dt 200 ms) only counts 50 ms', () => {
    const clock = fakeClock();
    const loop = createRevealLoop({ clock, reduced: () => false, onFrame: () => {} });
    loop.push('k', { delta: 'x'.repeat(1000) });
    clock.tick(16); const a = loop.text('k').length;
    clock.tick(200);
    expect(loop.text('k').length - a).toBe(200);
  });
  test('§14.5 drop forgets a block; text of an unknown key is empty', () => {
    const clock = fakeClock();
    const loop = createRevealLoop({ clock, reduced: () => false, onFrame: () => {} });
    loop.push('k', { delta: 'abc' }); loop.drop('k');
    expect(loop.text('k')).toBe('');
    expect(clock.pending()).toBe(0);
  });
  test('§14.5 seed: text already on screen never shrinks; only the later part is paced', () => {
    const clock = fakeClock();
    const loop = createRevealLoop({ clock, reduced: () => false, onFrame: () => {} });
    loop.seed('k', 'đã hiện ', 8);
    expect(loop.text('k')).toBe('đã hiện ');
    loop.push('k', { delta: 'x'.repeat(600) });
    clock.tick(1000 / 60);
    const n = loop.text('k').length;
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(608);
  });
});
