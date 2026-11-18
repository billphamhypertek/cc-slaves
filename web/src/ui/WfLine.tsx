// v2.9 §4.7 the effective config at the head of a session (session list row, Điều phối head, lane Inspector): "Quy trình
// PO · Build · bản a1b2c3"; hover = the blocked skills + the rules on of that rev. No `wf` on the wire = nothing.
import type { ReactElement } from 'react';
import type { WfRef } from '../../../shared/workflows.ts';
import { useT } from '../lib/i18n.tsx';
import { wfLine } from '../lib/wf-tasks.ts';
import './wf-line.css';

export function WfLine({ wf }: { wf: WfRef | undefined }): ReactElement | null {
  const tr = useT();
  if (!wf) return null;
  const l = wfLine(tr, wf);
  return <span className="wfl mono" title={l.tip}>{l.text}</span>;
}
