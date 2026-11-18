// v2.7 §6 / R-B19 M7 why a Tasks button is locked, as a styled tooltip right of it (mockup IS13b). WKWebView may not show
// the native `title` of a disabled button, so the reason lives on a wrapper: the disabled button lets the pointer through
// (CSS `pointer-events:none`) and the wrapper shows the box. `position:fixed` keeps it clear of the rail's overflow clip.
import { useState, type ReactElement, type ReactNode } from 'react';
import './tasks.css';

/** the tooltip's max width (CSS `.ltipb`), used to keep it on screen */
export const TIP_W = 340;
const GAP = 8;

/** Right of the anchor, centred on it (CSS lifts it by half its height); flips left of it at the window edge, never past
 *  8 px from either side. */
export function tipPos(r: { left: number; right: number; top: number; bottom: number }, winW: number): { left: number; top: number } {
  const top = (r.top + r.bottom) / 2;
  const right = r.right + GAP;
  if (right + TIP_W <= winW - GAP) return { left: right, top };
  return { left: Math.max(GAP, Math.min(r.left - GAP - TIP_W, winW - GAP - TIP_W)), top };
}

/** `tip` null / undefined → the child alone (no wrapper). */
export function LockTip({ tip, children }: { tip: string | null | undefined; children: ReactNode }): ReactElement {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  if (!tip) return <>{children}</>;
  return (
    <span className="ltip" data-tip={tip} onMouseEnter={e => setAt(tipPos(e.currentTarget.getBoundingClientRect(), window.innerWidth))}
      onMouseLeave={() => setAt(null)}>
      {children}
      {at ? <span className="ltipb" role="tooltip" style={{ left: at.left, top: at.top }}>{tip}</span> : null}
    </span>
  );
}
