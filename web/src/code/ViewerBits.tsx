// spec v2.3 §5.3 the edit parts of the viewer: the head's right side ("Sửa" on / greyed with its reason; while editing
// "Huỷ" · "Lưu ⌘S") and the one footer line: save refused (red), a session ran in the dir while editing (yellow), editing
// (yellow, C6), "Đã lưu 14:22" (C19), the lock reason after a click on the greyed "Sửa" with "Nhắn D15…" (C8); §7 C16 offline:
// the band over the Code view, "Lưu" / "Nhắn …" locked, the red "Mất kết nối · chưa lưu được" line while editing.
import type { ReactElement } from 'react';
import { errText, useT } from '../lib/i18n.tsx';
import { fmtHm } from '../lib/format.ts';
import { Icon } from '../ui/icons.tsx';
import type { OpenFile } from './code-tabs.ts';

/** why editing is off for the shown file (text), and the lane to message when it is a lane's live session */
export interface EditGate { reason: string | null; lane: string | null }

export function EditButtons(p: { f: OpenFile; gate: EditGate; saveOff: string | null; onEdit: () => void; onLocked: () => void; onCancel: () => void; onSave: () => void }): ReactElement {
  const tr = useT();
  if (p.f.edit) {
    return (
      <>
        <button type="button" className="hb gh" onClick={p.onCancel}>{tr('code.cancel')}</button>
        <button type="button" className="btn sm pri" aria-disabled={p.saveOff ? true : undefined} title={p.saveOff ?? undefined}
          onClick={() => { if (!p.saveOff) p.onSave(); }}>{tr('code.save')} <kbd>⌘S</kbd></button>
      </>
    );
  }
  const off = p.gate.reason;
  return (
    <button type="button" className={`hb${off ? ' dis' : ''}`} aria-disabled={off ? true : undefined} title={off ?? tr('code.edit.hint')}
      onClick={() => (off ? p.onLocked() : p.onEdit())}><Icon n="pencil" s={13} />{tr('code.edit')}</button>
  );
}

/** §7 C16 the band over the Code view while the engine is unreachable: the time of the data shown. */
export function OffBand({ dataAt }: { dataAt: number | null }): ReactElement {
  const tr = useT();
  return <div className="coff" role="status"><Icon n="wifi" s={12} />{tr('code.offline', { hm: dataAt ? fmtHm(dataAt) : '—' })}</div>;
}

export interface FootProps {
  f: OpenFile;
  /** the session holding the dir now */
  lock: EditGate;
  /** the PO clicked the greyed "Sửa" (C8) */
  lockShown: EditGate | null;
  /** §7 C16 the engine is unreachable: nothing can be saved or sent */
  offline: boolean;
  onAsk: (lane: string) => void;
}

export function ViewerFoot({ f, lock, lockShown, offline, onAsk }: FootProps): ReactElement | null {
  const tr = useT();
  const ran = (who: string | null) => (who ? tr('code.foot.ranLane', { lane: who }) : tr('code.foot.ranOrch'));
  if (f.edit && offline) return <div className="vf bv"><Icon n="wifi" s={13} /><span>{tr('code.foot.offline')}</span></div>;
  if (f.saveErr) return <div className="vf bv"><Icon n="alert" s={13} /><span>{tr('code.foot.saveErr', { reason: errText(tr, f.saveErr) })}</span></div>;
  if (f.edit && f.ran) return <div className="vf wv"><Icon n="alert" s={13} /><span>{ran(f.ran.who)}</span></div>;
  // a session started while editing: saving may overwrite it; a restored buffer of a locked source: the lock reason (C29)
  if (f.edit && lock.reason) return f.edit.free ? <div className="vf wv"><Icon n="alert" s={13} /><span>{ran(lock.lane || null)}</span></div>
    : <div className="vf wv"><Icon n="lock" s={13} /><span>{lock.reason}</span></div>;
  if (f.edit) return <div className="vf wv"><Icon n="pencil" s={13} /><span>{tr('code.foot.editing')}</span></div>;
  if (f.savedAt !== null) return <div className="vf"><Icon n="checkCircle" s={13} /><span>{tr('code.foot.saved', { time: fmtHm(f.savedAt) })}</span></div>;
  if (lockShown?.reason) {
    const lane = lockShown.lane;
    return (
      <div className="vf wv"><Icon n="lock" s={13} /><span>{lockShown.reason}</span>
        {lane ? <button type="button" className="btn sm" aria-disabled={offline ? true : undefined} onClick={() => { if (!offline) onAsk(lane); }}><Icon n="msg" s={13} />{tr('code.msgLane', { lane })}</button> : null}</div>
    );
  }
  return null;
}
