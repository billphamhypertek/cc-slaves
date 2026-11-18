// v2.1 §4.14 N5-e / N5-i an ended orchestrator session in Đang xem, read only: meta (when, accounts, tok · $, how it ended,
// last context), "Chạy tiếp…" / "Mở handoff" (Mac only), the "Không chạy tiếp được" band with its alternatives, the lane
// line ("D7 xong 12:40 · D9 → #3 lúc 14:22") and the session's own conversation. No composer.
import { useEffect, useState, type ReactElement } from 'react';
import { displayTokens, type Channel, type ResumePreview, type SessionRowView } from '../../../shared/protocol.ts';
import type { StreamBuffer } from '../lib/console.ts';
import { fmtCost, fmtDayHm, fmtHm, fmtTok, shortEmail } from '../lib/format.ts';
import { reasonText, useT } from '../lib/i18n.tsx';
import { canRun } from '../lib/remote.ts';
import { chipText } from '../lib/model.ts';
import { endHow, sinceText } from '../lib/sessions.ts';
import { Conversation } from './Conversation.tsx';
import { Icon } from './icons.tsx';

export interface SessionViewProps {
  row: SessionRowView | null; channel: Channel; offline: boolean;
  stream: StreamBuffer | undefined;
  /** "Chạy tiếp…" (no `from`) or a new session from its handoff / last 50 lines. */
  onResume: (from?: 'handoff' | 'tail') => void;
  onOpenHandoff: (path: string) => void;
  /** Mac only: `session_resume_preview` for the lane line ("Từ lúc dừng"). */
  loadPreview: () => Promise<ResumePreview | null>;
  onOlder: () => void; onJumpEnd: () => void;
  /** v2.2 §14.5 S11 "Ẩn công cụ" */
  hideTools: boolean;
}

export function SessionView(p: SessionViewProps): ReactElement {
  const tr = useT();
  const r = p.row, sid = r?.sessionId ?? null;
  const [pv, setPv] = useState<ResumePreview | null>(null);
  const mac = canRun(p.channel, 'session_resume');
  useEffect(() => {
    setPv(null);
    if (!sid || !mac) return;
    let live = true;
    void p.loadPreview().then(x => { if (live) setPv(x); });
    return () => { live = false; };
  }, [sid, mac]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return <div className="ohead"><div className="skel"><i /><i /><i /></div></div>;
  const n = r.seq ?? '?';
  const tok = displayTokens(r.tokens);
  const accounts = [r.accountFirst, r.accountLast].filter((a, i, all): a is string => !!a && all.indexOf(a) === i).map(shortEmail).join(' → ') || '—';
  const span = r.endedAt ? `${fmtDayHm(r.startedAt, tr)} → ${fmtHm(r.endedAt)}` : fmtDayHm(r.startedAt, tr);
  const since = pv ? sinceText(tr, pv.sinceStop) : null;
  const cant = r.resumable === false ? reasonText(tr, tr('session.expired'), r.reason) : null;
  const dis = p.offline;
  return (
    <>
      <div className="iinfo">
        <div className="ohead ended">
          <div className="row"><h2>{tr('session.head', { n })}</h2><span className="pill">{tr('session.endedPill')}</span></div>
          {/* v2.4 §4.1 MD12 the model · effort it last ran heads the meta line, plain text */}
          <div className="meta mono">{r.modelName || r.model ? <><span title={tr('model.chipEnded')}>{chipText(tr, r)}</span>{' · '}</> : null}{[span, accounts, tr('inspector.tok', { n: fmtTok(tok, tr) }), fmtCost(r.costUsd, tr)].join(' · ')}</div>
          <div className="meta mono">{tr('session.meta2', { how: endHow(tr, r), ctx: r.ctxLast != null ? `${fmtTok(r.ctxLast, tr)}` : '—' })}</div>
          {/* UX-I7 N5-i: not resumable → the new-session button is the main one, "Chạy tiếp…" stays dimmed, the reason box below */}
          {mac ? <div className="acts">
            {cant ? r.handoffPath
              ? <button type="button" className="btn sm pri" disabled={dis} onClick={() => p.onResume('handoff')}><Icon n="code" s={14} /> {tr('session.fromHandoff', { n })}</button>
              : <button type="button" className="btn sm pri" disabled={dis} onClick={() => p.onResume('tail')}><Icon n="code" s={14} /> {tr('session.fromTail')}</button> : null}
            <button type="button" className={`btn sm${cant ? '' : ' pri'}`} disabled={dis || !!cant} onClick={() => p.onResume()}><Icon n="send" s={14} /> {tr('session.resume')}</button>
            {r.handoffPath ? <button type="button" className="btn sm" disabled={dis} onClick={() => p.onOpenHandoff(r.handoffPath!)}><Icon n="code" s={14} /> {tr('session.openHandoff')}</button> : null}
          </div> : null}
          {cant ? <div className="preview bad" role="status"><Icon n="alert" s={14} /><span>{cant}</span></div> : null}
        </div>
        {since ? <dl className="kv"><dt>{tr('session.lanesDt')}</dt><dd>{since}</dd></dl> : null}
        <div className="log-h"><span>{tr('session.convHead')}</span></div>
      </div>
      <Conversation stream={p.stream} hideTools={p.hideTools} color="var(--fg-3)" onOlder={p.onOlder} onJumpEnd={p.onJumpEnd} />
      <div className="note"><Icon n="info" s={14} /><span>{tr(mac ? 'session.readOnly' : 'session.readOnlyRemote')}</span></div>
    </>
  );
}
