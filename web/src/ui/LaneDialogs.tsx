// Lane dialogs (v1 §6.8): stop (safe on click / now = choose + confirm, v2.1 §4.12) and "Chuyển hết lane đi" (F24). Kept from the v1 UnitPanel (v2.1 §5.1).
import { useState, type ReactElement } from 'react';
import type { LaneView } from '../../../shared/protocol.ts';
import { shortEmail } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { Icon } from './icons.tsx';

/** §4.12 T10 (N2-e): "Dừng an toàn" runs on click (3 steps from "⋯"); "Dừng ngay" is chosen first, then confirmed with the
 *  footer button (4). The subtitle names the work that stops (task · n subagent). */
export function StopDialog({ lane, sub, onPick, onClose }: { lane: string; sub: string | null; onPick: (mode: 'drain' | 'now') => void; onClose: () => void }): ReactElement {
  const tr = useT();
  const [mode, setMode] = useState<'drain' | 'now'>('drain');
  return (
    <div className="modal glass" role="dialog" aria-label={tr('unit.stopAria')}>
      <div className="mh"><h2>{tr('unit.stopTitle', { lane })}</h2><button className="x" onClick={onClose} aria-label={tr('common.close')}><Icon n="x" /></button></div>
      {sub ? <p style={{ margin: 0, color: 'var(--fg-2)' }}>{sub}</p> : null}
      <button className={`choice${mode === 'drain' ? ' def' : ''}`} aria-pressed={mode === 'drain'} onClick={() => onPick('drain')}><b>{tr('unit.drain')}</b><span>{tr('unit.drainNote')}</span></button>
      <button className={`choice bad${mode === 'now' ? ' def' : ''}`} aria-pressed={mode === 'now'} onClick={() => setMode('now')}><b>{tr('unit.now')}</b><span>{tr('unit.nowNote')}</span></button>
      <div className="mf"><button className="btn" onClick={onClose}>{tr('unit.cancel')}</button><button className={mode === 'now' ? 'btn bad' : 'btn pri'} onClick={() => onPick(mode)}>{tr(mode === 'now' ? 'unit.now' : 'unit.drain')}</button></div>
    </div>
  );
}

export function MoveAllDialog({ account, lanes, onYes, onClose }: { account: string; lanes: LaneView[]; onYes: () => void; onClose: () => void }): ReactElement {
  const tr = useT();
  return (
    <div className="modal glass" role="dialog" aria-label={tr('unit.moveAria')}>
      <div className="mh"><h2>{tr('unit.moveTitle', { account: shortEmail(account) })}</h2><button className="x" onClick={onClose} aria-label={tr('common.close')}><Icon n="x" /></button></div>
      <p style={{ margin: 0, color: 'var(--fg-2)' }}>{tr('unit.moveNote')}</p>
      <div>{lanes.map(l => <div key={`${l.projectId}:${l.name}`} className="dep"><span className="ic na"><Icon n="swap" s={15} /></span><b>{l.name}</b><small>{l.task ? `${l.task} ` : ''}{tr('unit.moveAuto')}</small></div>)}</div>
      <div className="mf"><button className="btn" onClick={onClose}>{tr('unit.cancel')}</button><button className="btn pri" onClick={onYes}>{tr('unit.moveYes', { n: lanes.length })}</button></div>
    </div>
  );
}
