// v2.1 §4.3 state object: the v1.1 disc at 36 px in a 46 px cell, colours from the --dk-* theme variables (model.ts `C`).
// v2.8 §4.3: the glow parts carry `hl` and the status ring `rs`, so light hides the glow and thickens the ring in CSS.
// Ported from the mockup `glyph()`.
// Animated parts carry a class (`a-spin`, `a-orb`, `a-wave`, `a-blink`, `a-swf`) only while the motion gate is open
// (`live`): when paused the markup itself has no animated class, so `document.getAnimations()` is empty (§5.2, G7).
// hf1117-p4 (perf-audit C5): an animated layer is its own SVG inside an HTML `<span class="gl">`, so the loop is a
// composited transform / opacity (no SVG style + layout per frame); only running states spin. No filter anywhere.
import { createElement, memo, type ReactElement } from 'react';
import { C, type Glyph as GlyphState } from './model.ts';

const seg = (r: number, n: number, col: string, w = 2.2, rot = 0): ReactElement => {
  const c = 2 * Math.PI * r, d = (c / n) * 0.72, g = (c / n) * 0.28;
  return <circle cx="18" cy="18" r={r} fill="none" stroke={col} strokeWidth={w} strokeDasharray={`${d.toFixed(2)} ${g.toFixed(2)}`}
    transform={rot ? `rotate(${rot} 18 18)` : undefined} className={w === 2.2 ? 'rs' : undefined} />;
};
const halo = (col: string) => <circle cx="18" cy="18" r="11" fill="none" stroke={col} strokeWidth="5" opacity=".12" className="hl" />;
const core = (col: string, r = 3.5) => <><circle cx="18" cy="18" r={r} fill={col} /><circle cx="18" cy="18" r={r + 2.5} fill={col} opacity=".15" className="hl" /></>;
const rim = (col = 'var(--dk-ring)', op = 1) => <circle cx="18" cy="18" r="16" fill="none" stroke={col} strokeWidth="1" opacity={op} />;

export interface GlyphProps { state: GlyphState; live: boolean; orbit?: number }

/** One drawing layer, painted in order: still, or `[loop class, el]` (drawn in its own `.gl` wrapper while live). */
type Layer = ReactElement | [string, ReactElement];
/** the orbit: one white dot per subagent on the rim */
const dots = (n: number) => <>{Array.from({ length: n }, (_, i) => {
  const t = (i / n) * 2 * Math.PI;
  return <circle key={i} cx={(18 + 16 * Math.cos(t)).toFixed(1)} cy={(18 + 16 * Math.sin(t)).toFixed(1)} r="1.8" fill={C.white} />;
})}</>;
const wave = (col: string) => <circle cx="18" cy="18" r="13" fill="none" stroke={col} strokeWidth="1" />;

function body(s: GlyphState, orbit: number): Layer[] {
  switch (s) {
    case 'running': return [rim(), halo(C.run), ['a-spin', seg(11, 6, C.run)], core(C.run), ...(orbit ? [['a-orb', dots(orbit)] as Layer] : [])];
    case 'waiting_po': return [rim(), ['a-wave', wave(C.wait)], <>{halo(C.wait)}{seg(11, 6, C.wait)}{core(C.wait)}{orbit ? dots(orbit) : null}</>];
    case 'starting': return [['a-spin', <g opacity=".6">{seg(16, 12, C.acc, 1.2)}</g>], <circle cx="18" cy="18" r="3" fill={C.acc} opacity=".45" />];
    case 'idle': return [<>{rim()}<g opacity=".55"><circle cx="18" cy="18" r="11" fill="none" stroke={C.acc} strokeWidth="2.2" /><circle cx="29" cy="18" r="1.6" fill={C.acc} /></g><circle cx="18" cy="18" r="3" fill={C.acc} opacity=".6" /></>];
    case 'waiting_quota': return [<>{rim()}{seg(11, 6, C.gry)}<circle cx="18" cy="18" r="3.5" fill={C.gry} /></>];
    case 'switching': return [rim(), ['a-swf', seg(11, 6, C.acc)], <circle cx="18" cy="18" r="3.5" fill={C.acc} opacity=".7" />];
    case 'draining': return [<>{rim()}{halo(C.amb)}{seg(11, 3, C.amb)}{core(C.amb)}</>];
    // hotfix 2026-11-16 held (lane or root): a pause sign in grey, nothing animates
    case 'paused': return [<>{rim()}<rect x="13" y="12" width="3.4" height="12" rx="1" fill={C.gry} /><rect x="19.6" y="12" width="3.4" height="12" rx="1" fill={C.gry} /></>];
    case 'stopped': return [<>{rim()}<circle cx="18" cy="18" r="3" fill={C.gry} opacity=".6" /></>];
    case 'broken': return [rim(), ['a-blink', seg(11, 9, C.err, 2.2, 14)], core(C.err)];
    case 'done': return [<>{rim()}<circle cx="18" cy="18" r="11" fill="none" stroke={C.gry} strokeWidth="2" />
      <path d="M12.5 18.5l3.6 3.6 7.4-7.6" fill="none" stroke="var(--dk-task)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>];
    case 'root': return [<>{rim(C.acc, 0.5)}{halo(C.acc)}{seg(11, 8, C.acc)}{core(C.acc, 4.5)}</>];
    case 'root_run': return [<>{rim(C.acc, 0.5)}{halo(C.acc)}</>, ['a-spin', seg(11, 8, C.acc)], core(C.acc, 4.5)];
    case 'root_quota': return [<>{rim()}{seg(11, 8, C.gry)}<circle cx="18" cy="18" r="4.5" fill={C.gry} /></>];
    case 'root_down': return [rim(), ['a-blink', seg(11, 9, C.err, 2.2, 14)], <circle cx="18" cy="18" r="4.5" fill={C.err} />];
    case 'root_ask': return [rim(C.acc, 0.5), ['a-wave', wave(C.wait)], <>{halo(C.wait)}{seg(11, 8, C.wait)}{core(C.wait, 4.5)}</>];
    case 'root_start': return [['a-spin', <g opacity=".6">{seg(16, 12, C.acc, 1.2)}</g>], <circle cx="18" cy="18" r="3.5" fill={C.acc} opacity=".45" />];
  }
}

const svg = (key: number, kids: ReactElement[]) => createElement('svg', { key, width: 36, height: 36, viewBox: '0 0 36 36', overflow: 'visible' }, ...kids);

export const Glyph = memo(function Glyph({ state, live, orbit = 0 }: GlyphProps): ReactElement {
  // consecutive still layers share one SVG; a live loop gets its own SVG in a `.gl` span (paused → one SVG, no span)
  const out: ReactElement[] = [];
  let still: ReactElement[] = [];
  const flush = () => { if (still.length) out.push(svg(out.length, still)); still = []; };
  for (const l of body(state, orbit)) {
    if (Array.isArray(l) && live) { flush(); out.push(<span key={out.length} className={`gl ${l[0]}`}>{svg(0, [l[1]])}</span>); }
    else still.push(Array.isArray(l) ? l[1] : l);
  }
  flush();
  return <span className={`so so-${state}`} aria-hidden="true">{out}</span>;
});
