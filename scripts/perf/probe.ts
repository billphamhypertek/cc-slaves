// Perf audit page probe, injected with `page.addInitScript(installProbe, storm)` before the app loads (WebKit + Chromium).
// window.__perf: React commits (a DevTools-hook stub: commit count, components rendered / mounted per commit, root
// actualDuration — dev build only), rAF frame times, input → next paint per pointerdown / keydown / wheel (rAF then a
// MessageChannel post = after the paint), WS message → next paint, Chromium-only longtask / LoAF / layout-shift / event.
// Self-contained: Playwright serializes the function, so it may not use anything from outside its body.

interface Fiber { tag: number; type: unknown; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null; actualDuration?: number }
interface Timed { at: number; ms: number }
export interface Perf {
  commits: number; rendered: number; mounted: number; renderMs: number; byName: Record<string, number>; mountBy: Record<string, number>;
  frames: number[]; inputs: (Timed & { type: string; what: string })[]; ws: { ms: number; len: number; net: number | null }[];
  longtasks: Timed[]; loaf: (Timed & { block: number; style: number; scripts: string[] })[]; shifts: { at: number; v: number; src: string[] }[];
  events: (Timed & { name: string })[]; walk: boolean; storm: number; reset(): void;
}
type LoafEntry = PerformanceEntry & { blockingDuration: number; styleAndLayoutStart: number;
  scripts?: { sourceFunctionName?: string; invoker?: string; sourceURL?: string; duration: number }[] };
type ShiftEntry = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Element | null }[] };

export function installProbe(storm: number): void {
  const fresh = () => ({ commits: 0, rendered: 0, mounted: 0, renderMs: 0, byName: {}, mountBy: {}, frames: [], inputs: [], ws: [], longtasks: [], loaf: [], shifts: [], events: [] });
  const P: Perf = { ...fresh(), walk: true, storm, reset: () => { Object.assign(P, fresh()); } };
  const w = window as unknown as { __perf: Perf; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown; WebSocket: typeof WebSocket };
  w.__perf = P;
  const NAMED = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
  const nameOf = (f: Fiber): string => {
    const t = f.type as { displayName?: string; name?: string; type?: { displayName?: string; name?: string } } | string | null;
    if (typeof t === 'string') return t;
    return t?.displayName ?? t?.name ?? t?.type?.displayName ?? t?.type?.name ?? '?';
  };
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE: () => {}, onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      P.commits++;
      P.renderMs += root.current.actualDuration ?? 0;
      if (!P.walk) return;
      // a subtree is new when its fiber has no alternate (mounted); untouched when `child` is the alternate's (bailed out)
      const stack: [Fiber, boolean][] = [[root.current, false]];
      while (stack.length) {
        const [f, inMount] = stack.pop()!;
        const mount = inMount || f.alternate === null;
        if (NAMED.has(f.tag) && (mount || (f.flags & 1) === 1)) {
          const n = nameOf(f);
          P.rendered++; P.byName[n] = (P.byName[n] ?? 0) + 1;
          if (mount) { P.mounted++; P.mountBy[n] = (P.mountBy[n] ?? 0) + 1; }
        }
        if (f.sibling) stack.push([f.sibling, inMount]);
        if (f.child && (mount || f.child !== f.alternate?.child)) stack.push([f.child, mount]);
      }
    },
  };
  const afterPaint = (cb: (t: number) => void) => requestAnimationFrame(() => {
    const c = new MessageChannel();
    c.port1.onmessage = () => cb(performance.now());
    c.port2.postMessage(0);
  });
  const loop = (t: number) => { P.frames.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  for (const type of ['pointerdown', 'keydown', 'wheel']) addEventListener(type, e => {
    const t0 = e.timeStamp, el = e.target instanceof Element ? e.target.closest('button,[role=button],.react-flow__node,textarea,a') ?? e.target : null;
    const what = e instanceof KeyboardEvent ? e.key : el ? String(el.className) : '';
    afterPaint(t => P.inputs.push({ type, what: what.slice(0, 40), ms: t - t0, at: t0 }));
  }, { capture: true, passive: true });
  // the prod build drops `?f=` (DEV only): the probe adds the frame and the storm rate to the engine URL itself
  const Ws = w.WebSocket;
  class ProbeWs extends Ws {
    constructor(url: string | URL, protocols?: string | string[]) {
      const s = String(url), f = new URLSearchParams(location.search).get('f');
      const add = [f && !/[?&]f=/.test(s) ? `f=${f}` : '', P.storm ? `storm=${P.storm}` : ''].filter(Boolean);
      super(add.length ? `${s}${s.includes('?') ? '&' : '?'}${add.join('&')}` : s, protocols);
      this.addEventListener('message', (e: MessageEvent<unknown>) => {
        const t0 = performance.now(), raw = String(e.data), m = /⏱(\d+)/.exec(raw);
        afterPaint(t => P.ws.push({ ms: t - t0, len: raw.length, net: m ? Date.now() - Number(m[1]) : null }));
      });
    }
  }
  w.WebSocket = ProbeWs;
  const sup = PerformanceObserver.supportedEntryTypes;
  const obs = <E extends PerformanceEntry>(type: string, fn: (e: E) => void, extra: Record<string, number> = {}) => {
    if (sup.includes(type)) new PerformanceObserver(l => { for (const e of l.getEntries()) fn(e as E); }).observe({ type, buffered: true, ...extra });
  };
  obs('longtask', e => P.longtasks.push({ at: e.startTime, ms: e.duration }));
  obs<LoafEntry>('long-animation-frame', e => P.loaf.push({ at: e.startTime, ms: e.duration, block: e.blockingDuration,
    style: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
    scripts: (e.scripts ?? []).slice(0, 3).map(s => `${(s.sourceFunctionName || s.invoker || '').slice(0, 40)}@${(s.sourceURL ?? '').split('/').pop()}:${Math.round(s.duration)}`) }));
  obs<ShiftEntry>('layout-shift', e => {
    if (!e.hadRecentInput) P.shifts.push({ at: e.startTime, v: e.value, src: (e.sources ?? []).map(s => String(s.node ? s.node.id || s.node.className || s.node.nodeName : null).slice(0, 40)) });
  });
  obs<PerformanceEntry & { interactionId?: number }>('event', e => { if (e.interactionId) P.events.push({ name: e.name, ms: e.duration, at: e.startTime }); }, { durationThreshold: 16 });
}
