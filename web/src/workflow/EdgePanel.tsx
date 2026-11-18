// spec v2.9 §4.4 the panel of an edge (WF3c): "Chuyển khi" fixed by the pair of types (§5.3), "Bắt đầu bước sau" (only doc → doc /
// doc → build: bấm Bắt đầu or tự chạy), and the Tasks groups this chain makes (§4.7).
import type { ReactElement } from 'react';
import type { Tr } from '../../../shared/i18n/core.ts';
import { DONE_ID, type StartMode, type WorkflowEdit } from '../../../shared/workflows.ts';
import { stepById, stepName, tasksFlow, type WfModel, type WfStep } from '../lib/workflow.ts';
import { FieldHead, Tag } from './StepPanel.tsx';

export interface EdgePanelProps { tr: Tr; m: WfModel; s: WfStep; ro: boolean; edit: (edits: WorkflowEdit[]) => void }

export function EdgePanel({ tr, m, s, ro, edit }: EdgePanelProps): ReactElement {
  const to = s.next && s.next.to !== DONE_ID ? stepById(m, s.next.to) : undefined;
  const drain = s.type === 'build';
  const startable = s.type === 'design' && !!to && (to.type === 'design' || to.type === 'build');
  const low = (x: string) => x.toLocaleLowerCase('vi');
  const start = s.next?.start ?? 'button';
  const set = (v: StartMode) => { if (s.next && v !== start) edit([{ path: s.path, key: 'next', value: { to: s.next.to, start: v } }]); };
  const opts: { v: StartMode; label: string; hint: string }[] = to ? [
    { v: 'button', label: tr('workflow.edgeP.button'), hint: tr('workflow.edgeP.buttonHint', {
      waiting: s.labels.waiting ?? tr('workflow.flow.waiting', { step: low(stepName(tr, to)) }),
      start: s.labels.start ?? tr('workflow.flow.start', { step: low(stepName(tr, to)) }) }) },
    { v: 'auto', label: tr('workflow.edgeP.auto'), hint: tr('workflow.edgeP.autoHint', { step: stepName(tr, to) }) },
  ] : [];
  return <div className="ppb" data-panel="edge">
    <div className="fg">
      <FieldHead label={tr('workflow.edgeP.when')} tag={<Tag tr={tr} k="hard" />} />
      <div className="fst">{tr(drain ? 'workflow.edgeP.drain' : 'workflow.edgeP.approve')}</div>
      <div className="fnote">{tr(drain ? 'workflow.edgeP.drainHint' : 'workflow.edgeP.approveHint')}</div>
    </div>
    {startable ? <div className="fg">
      <FieldHead label={tr('workflow.edgeP.start')} tag={<Tag tr={tr} k="hard" />} />
      {ro || s.readOnly.includes('next') ? <div className="rot">{opts.find(o => o.v === start)?.label}</div>
        : <div className="rad" role="radiogroup" aria-label={tr('workflow.edgeP.start')}>{opts.map(o =>
          <button key={o.v} type="button" role="radio" aria-checked={start === o.v} className={start === o.v ? 'on' : ''} onClick={() => set(o.v)}>
            <i /><span>{o.label}<small>{o.hint}</small></span></button>)}</div>}
    </div> : null}
    <div className="fg">
      <FieldHead label={tr('workflow.edgeP.tasks')} />
      <div className="prev">{tasksFlow(tr, m)}</div>
    </div>
  </div>;
}
