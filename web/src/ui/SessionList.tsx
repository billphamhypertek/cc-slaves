// v2.1 §4.14 N5-d "Lịch sử phiên" popover (under the "Điều phối #n ▾" Inspector header, key H, menu item): Đang chạy n / 3
// (live), then Đã kết thúc (20 rows, then "Xem thêm"). Running row → Đang xem shows it; ended row → read-only view.
// Esc closes it like a menu (escapeStep 'sessList'); offline the list stays readable. v2.7 §5.0 a running row carries its
// kind ("Build · v2.5" / "Thiết kế" / "Chung"); "Đang chạy n / 3" counts as R34 does (Thiết kế / Build + a second Chung).
import { useState, type ReactElement } from 'react';
import { countedSessions, type ProjectIssues } from '../../../shared/issues.ts';
import type { OrchestratorView, SessionRowView, SessionsList } from '../../../shared/protocol.ts';
import { useT } from '../lib/i18n.tsx';
import { rowMeta, rowStatus, sessionLabel } from '../lib/sessions.ts';
import { orchKindLabel } from '../lib/traces.ts';
import { WfLine } from './WfLine.tsx';
import type { Rect } from '../lib/menu.ts';
import './sessions.css';

const LIST_PAGE = 20;

export interface SessionListProps {
  at: Rect; os: OrchestratorView[]; list: SessionsList | null; viewed: string | null;
  /** v2.7 the project's specs (the kind label names the spec); null = remote / none */
  pi: ProjectIssues | null;
  onPick: (r: SessionRowView) => void; onClose: () => void;
}

export function SessionList(p: SessionListProps): ReactElement {
  const tr = useT();
  const [shown, setShown] = useState(LIST_PAGE);
  const running = p.list?.running ?? [];
  const ended = p.list?.ended ?? [];
  const max = p.list?.max ?? 3;
  const row = (r: SessionRowView) => {
    const st = rowStatus(tr, r), live = r.state !== 'ended';
    const o = live ? p.os.find(x => x.sessionId === r.sessionId) : undefined, kind = o ? orchKindLabel(tr, o, p.os, p.pi) : null;
    return (
      <button key={r.sessionId} type="button" role="menuitem" className={`srow${live ? ' live' : ''}${r.sessionId === p.viewed ? ' on' : ''}`} onClick={() => p.onPick(r)}>
        <b>{sessionLabel(tr, r.seq, r.title)}{kind ? <span className="skind">{kind}</span> : null}</b>
        <span className="mono">{rowMeta(tr, r)}</span>
        <WfLine wf={r.wf} />
        {r.sessionId === p.viewed ? <em>{tr('session.viewing')}</em> : st ? <em className={st.ok ? '' : 'dim'}>{st.text}</em> : null}
      </button>
    );
  };
  return (
    <div className="slist-back" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="slist glass" role="menu" aria-label={tr('session.listAria')} style={{ left: p.at.x, top: p.at.y, width: p.at.w, maxHeight: p.at.h }}>
        {!p.list ? <p className="sh">{tr('session.listLoading')}</p> : <>
          <p className="sh">{tr('session.listRunning', { n: countedSessions(p.os.map(o => o.orchKind ?? 'general')), max })}</p>
          {running.map(row)}
          <p className="sh">{tr('session.listEnded')}</p>
          {ended.length ? ended.slice(0, shown).map(row) : <p className="sempty">{tr('session.listEmpty')}</p>}
          {ended.length > shown ? <button type="button" className="lnk" onClick={() => setShown(n => n + LIST_PAGE)}>{tr('session.listMore')}</button> : null}
        </>}
      </div>
    </div>
  );
}
