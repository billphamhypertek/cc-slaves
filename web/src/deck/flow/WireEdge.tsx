// v2.1 §4.6 wire: the orthogonal path of the layout polyline, a static faint glow stroke where it means something, and
// the travelling dots as HTML spans moved by CSS `offset-path` (no SMIL, no React Flow `animated`, §5.2) — so every
// running dot is a CSS animation that `document.getAnimations()` sees. Dots exist only while the motion gate is open
// (the model gives none otherwise). v2.8 §4.3 (UX r2 N2): a lit wire draws its whole path grey (the shared trunk, in both
// themes) and only its own leg into the child in colour; `hot` (running / talking) is the 2 px wire of the light theme.
import { memo, type CSSProperties, type ReactElement } from 'react';
import { EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { C, type Dot, type WireData } from './model.ts';

function dotStyle(d: string, dot: Dot): CSSProperties {
  return {
    offsetPath: `path('${d}')`, width: dot.size, height: dot.size,
    background: `radial-gradient(circle,var(--dk-dot) 0 25%,${dot.color} 40%,transparent 72%)`,
    animationDuration: `${dot.dur}s`, animationDelay: `${dot.delay}s`,
    ...(dot.once ? { animationIterationCount: 1, animationFillMode: 'both' } : {}),
  };
}

function WirePaths({ w }: { w: WireData }): ReactElement {
  const leg = w.branch ?? w.d, dash = w.dashed ? '3 3' : undefined;
  return <>
    {w.branch ? <path d={w.d} fill="none" stroke={C.dark} strokeWidth={1} opacity={0.8} strokeDasharray={dash} className="wire" /> : null}
    {w.glow ? <path d={leg} fill="none" stroke={w.color} strokeWidth={w.width >= 2 ? 6 : 4} opacity=".12" className="wire-glow" /> : null}
    <path d={leg} fill="none" stroke={w.color} strokeWidth={w.width} opacity={w.opacity} strokeDasharray={dash} className={w.width > 1 ? 'wire hot' : 'wire'} />
  </>;
}

export function WireDots({ w }: { w: WireData }): ReactElement | null {
  if (!w.dots.length) return null;
  return <>{w.dots.map((dot, i) => <span key={i} className={`pk${dot.back ? ' b' : ''}`} style={dotStyle(w.d, dot)} />)}</>;
}

const WireEdge = memo(({ data }: EdgeProps) => {
  const w = data as WireData | undefined;
  if (!w) return null;
  return <><WirePaths w={w} />{w.dots.length ? <EdgeLabelRenderer><WireDots w={w} /></EdgeLabelRenderer> : null}</>;
});

/** §5.1 declared outside components. */
export const edgeTypes = { wire: WireEdge };
