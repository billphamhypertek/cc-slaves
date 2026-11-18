// v2.7 §4.2-2 THE progress bar (UX r1 I5), one rule for the Deck head strip (`compact`, G5) and the Tasks tab: length 1;
// the green part = done / total; the striped part right after it = extra scope (source ≠ spec) not done / total; total =
// every issue except cancelled (`progressOf`, shared/issues.ts). Only a done spec (lifecycle Xong, `finished`) draws the
// neutral grey bar (R-B19 I3); a building spec whose issues are all done keeps the fill colour.
import type { ReactElement } from 'react';
import type { Progress } from '../../../shared/issues.ts';
import { useT } from '../lib/i18n.tsx';
import './tasks.css';

/** The two widths as fractions of the bar (0 when there is nothing to count). */
export function barParts(p: Progress): { done: number; scope: number } {
  return p.total ? { done: p.done / p.total, scope: p.scope / p.total } : { done: 0, scope: 0 };
}

const pct = (f: number) => `${+(f * 100).toFixed(3)}%`;

export function ProgressBar({ p, compact = false, finished = false }: { p: Progress; compact?: boolean; finished?: boolean }): ReactElement {
  const tr = useT();
  const { done, scope } = barParts(p);
  const label = tr('tasks.progress.aria', { done: p.done, total: p.total }) + (p.scope ? tr('tasks.progress.ariaScope', { n: p.scope }) : '');
  const cls = `tpg${compact ? ' cp' : ''}${finished ? ' dn' : ''}`;
  return (
    <span className={cls} role="img" aria-label={label} title={label}>
      {done ? <i className="f" style={{ width: pct(done) }} /> : null}
      {scope ? <i className="s" style={{ left: pct(done), width: pct(scope) }} /> : null}
    </span>
  );
}
