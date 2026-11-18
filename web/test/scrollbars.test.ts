// v2.4 §6.8 D54 / §13: the auto-hide scrollbar helper, on a fake document (no DOM in `bun test`, R36 M3).
import { describe, expect, test } from 'bun:test';
import { IDLE_MS, INPUT_MS, install } from '../src/lib/scrollbars.ts';

type Fn = (e: { target: unknown }) => void;
interface Box { dataset: { sb?: string }; parent: Box | null; contains(n: unknown): boolean }
const box = (parent: Box | null = null): Box => {
  const b: Box = { dataset: {}, parent, contains: n => { for (let x = n as Box | null; x; x = x.parent) if (x === b) return true; return false; } };
  return b;
};

function fakeDoc() {
  const fns = new Map<string, Fn[]>();
  let t = 0, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const body = box();
  const doc = {
    body,
    documentElement: box(),
    addEventListener: (type: string, fn: Fn, opts: { capture: boolean; passive: boolean }) => {
      expect(opts).toEqual({ capture: true, passive: true });
      const list = fns.get(type) ?? [];
      list.push(fn);
      fns.set(type, list);
    },
  };
  const clock = {
    now: () => t,
    set: (fn: () => void, ms: number) => { seq += 1; timers.set(seq, { at: t + ms, fn }); return seq; },
    clear: (id: number | undefined) => { if (id !== undefined) timers.delete(id); },
  };
  const fire = (type: string, target: unknown) => { for (const f of fns.get(type) ?? []) f({ target }); };
  const advance = (ms: number) => {
    t += ms;
    for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.fn(); }
  };
  return { doc, clock, fns, fire, advance, body };
}

describe('§6.8 D54 scrollbars.install', () => {
  test('§6.8 a user scroll lights exactly the scrolled box (not its parent)', () => {
    const f = fakeDoc(), outer = box(f.body), el = box(outer);
    install(f.doc, f.clock);
    f.fire('wheel', el);
    f.fire('scroll', el);
    expect(el.dataset.sb).toBe('on');
    expect(outer.dataset.sb).toBeUndefined();
  });
  test('§6.8 scrolling again within 800 ms keeps it on (the timer moves); 800 ms quiet → off', () => {
    const f = fakeDoc(), el = box(f.body);
    install(f.doc, f.clock);
    f.fire('pointerdown', el); f.fire('scroll', el);
    f.advance(IDLE_MS - 100);
    f.fire('scroll', el); // a later scroll of a lit box needs no new input
    f.advance(IDLE_MS - 100);
    expect(el.dataset.sb).toBe('on');
    f.advance(100);
    expect(el.dataset.sb).toBe('off');
  });
  test('§6.8 R36 I2 programmatic scroll without input → stays off', () => {
    const f = fakeDoc(), el = box(f.body);
    install(f.doc, f.clock);
    f.fire('scroll', el);
    expect(el.dataset.sb).toBeUndefined();
  });
  test('§6.8 R36 I2 input more than 1 s before, or in another box, does not light it', () => {
    const f = fakeDoc(), el = box(f.body), other = box(f.body);
    install(f.doc, f.clock);
    f.fire('wheel', el);
    f.advance(INPUT_MS + 1);
    f.fire('scroll', el);
    expect(el.dataset.sb).toBeUndefined();
    f.fire('pointerdown', other);
    f.fire('scroll', el);
    expect(el.dataset.sb).toBeUndefined();
  });
  test('§6.8 R36 I2 a key in a child of the box, or with focus on body, lights it', () => {
    const f = fakeDoc(), el = box(f.body), btn = box(el), el2 = box(f.body);
    install(f.doc, f.clock);
    f.fire('keydown', btn); f.fire('scroll', el);
    expect(el.dataset.sb).toBe('on');
    f.fire('keydown', f.body); f.fire('scroll', el2);
    expect(el2.dataset.sb).toBe('on');
  });
  test('§6.8 a scroll whose target is the document (no dataset) is ignored without throwing', () => {
    const f = fakeDoc();
    install(f.doc, f.clock);
    f.fire('wheel', f.doc);
    expect(() => f.fire('scroll', f.doc)).not.toThrow();
    expect(() => f.fire('scroll', null)).not.toThrow();
  });
  test('§6.8 install(doc) twice → still one set of listeners', () => {
    const f = fakeDoc();
    install(f.doc, f.clock);
    install(f.doc, f.clock);
    expect([...f.fns].map(([k, v]) => `${k}:${v.length}`).sort()).toEqual(['keydown:1', 'pointerdown:1', 'scroll:1', 'wheel:1']);
  });
});
