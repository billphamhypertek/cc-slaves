// spec v2.9 §4.2 the few strokes the Quy trình screen needs that the shared set (ui/icons.tsx, first paint) does not have:
// kept in this lazy chunk so the first paint does not grow. Same 24 × 24 Lucide-style strokes as the shared set.
import type { ReactElement } from 'react';
import { Icon } from '../ui/icons.tsx';
import type { StepType } from '../../../shared/workflows.ts';

const P = {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
} as const;

export function WfIcon({ n, s = 16 }: { n: keyof typeof P; s?: number }): ReactElement {
  return <svg className="i" width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: P[n] }} />;
}

/** §4.2 the icon of a step type (node, palette, panel head). */
export function TypeIcon({ type, s = 16 }: { type: StepType | null; s?: number }): ReactElement {
  const n = type === 'build' ? 'branch' : type === 'general' ? 'msg' : type === 'lane' ? 'user' : 'file';
  return <Icon n={n} s={s} />;
}
