// v2.4 §6.8 D54 auto-hide scrollbars: the look is one block in styles.css (`--sb-c` + `[data-sb]`); this helper only marks the box
// the user is scrolling. One capture listener per event type on the document, none per box. R36 I2: a scroll lights the bar only
// after a user input (wheel / key / pointer) in that box or its subtree ≤ 1 s before; an app scroll (VirtualHist sticking to the
// bottom while a turn streams, the chip strip following its newest chip, a lane switch) stays dark.

/** quiet time after the last scroll before the bar fades out (§6.8) */
export const IDLE_MS = 800;
/** how long a user input may come before the scroll it causes (R36 I2) */
export const INPUT_MS = 1000;

interface Marked { dataset: { sb?: string } }
interface Node0 { contains?(n: unknown): boolean }
interface Doc { body?: unknown; documentElement?: unknown; addEventListener(type: string, fn: (e: { target: unknown }) => void, opts: { capture: boolean; passive: boolean }): void }
export interface Clock { now(): number; set(fn: () => void, ms: number): unknown; clear(id: unknown): void }

const realClock: Clock = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: id => clearTimeout(id as ReturnType<typeof setTimeout>),
};
const installed = new WeakSet<object>();
const opts = { capture: true, passive: true };

/** Wires the document once (a second call is a no-op). `clock` is for tests. */
export function install(doc: Doc, clock: Clock = realClock): void {
  if (installed.has(doc)) return;
  installed.add(doc);
  const timers = new WeakMap<object, unknown>();
  let input: { at: number; target: unknown } = { at: -Infinity, target: null };
  const onInput = (e: { target: unknown }) => { input = { at: clock.now(), target: e.target }; };
  const byUser = (el: Node0): boolean => {
    if (clock.now() - input.at > INPUT_MS) return false;
    const t = input.target;
    return t === doc || t === doc.body || t === doc.documentElement || el.contains?.(t) === true;
  };
  for (const type of ['wheel', 'keydown', 'pointerdown']) doc.addEventListener(type, onInput, opts);
  doc.addEventListener('scroll', e => {
    const el = e.target;
    if (typeof el !== 'object' || el === null || !('dataset' in el)) return;
    const box = el as Marked & Node0;
    if (box.dataset.sb !== 'on') {
      if (!byUser(box)) return;
      box.dataset.sb = 'on';
    }
    clock.clear(timers.get(box));
    timers.set(box, clock.set(() => { box.dataset.sb = 'off'; }, IDLE_MS));
  }, opts);
}
