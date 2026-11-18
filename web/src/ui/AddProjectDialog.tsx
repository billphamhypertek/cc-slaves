// Hot fix 2026-11-17 "Thêm project" progress: one row per step — a spinner at the start of the running row, a green tick
// when done, a red mark with the reason on failure (then "Đóng"). Same `.dep` rows as the wizard's checks.
import type { ReactElement } from 'react';
import { useT } from '../lib/i18n.tsx';
import { Icon } from './icons.tsx';
import type { AddStep } from './useAddProject.ts';

const mark = (st: AddStep['st']): ReactElement | null =>
  st === 'run' ? <span className="spin" /> : st === 'ok' ? <Icon n="check" s={15} /> : st === 'bad' ? <Icon n="x" s={15} /> : null;
const ic = { wait: 'na', run: 'na', ok: 'ok', bad: 'no' } as const;

export function AddProjectDialog({ steps, onClose }: { steps: AddStep[]; onClose: () => void }): ReactElement {
  const tr = useT();
  const failed = steps.some(s => s.st === 'bad');
  const running = steps.some(s => s.st === 'run');
  return (
    <div className="modal glass addp" role="dialog" aria-label={tr('addProject.aria')} aria-busy={running || undefined}>
      <div className="mh"><h2>{tr('addProject.title')}</h2>{failed ? <button className="x" onClick={onClose} aria-label={tr('common.close')}><Icon n="x" /></button> : null}</div>
      <div role="list">{steps.map(s => (
        <div key={s.key} role="listitem" className={`dep st-${s.st}`}>
          <span className={`ic ${ic[s.st]}`} aria-hidden="true">{mark(s.st)}</span><b>{s.label}</b>{s.note ? <small>{s.note}</small> : null}
        </div>))}</div>
      {failed ? <div className="mf"><button className="btn pri" onClick={onClose}>{tr('common.close')}</button></div> : null}
    </div>
  );
}
