// spec v2.9 §4.10 the author chat (360, in place of the property panel): head "Bản nháp — chưa lưu" + account · còn N % · model, the
// user's lines, Claude's short replies, the turn's activity line (gone when the turn ends), small grey system lines (Kiểm gói, đã
// lưu + Hoàn tác 30 s, dừng), the quota stop (Tiếp tục / Để sau, WF16f), the composer with Dừng while a turn runs (WF15a).
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Key, Tr } from '../../../shared/i18n/core.ts';
import type { AccountView } from '../../../shared/protocol.ts';
import type { DraftLine, DraftView } from '../../../shared/workflows.ts';
import { leftPct } from '../lib/format.ts';
import { issueText } from '../lib/workflow.ts';
import { Icon } from '../ui/icons.tsx';

export interface AuthorChatProps {
  tr: Tr;
  /** null = "Sửa bằng lời" just clicked: no draft yet, the first message starts it (WF15b) */
  draft: DraftView | null;
  /** the draft went away (Hoàn tác window passed): shown frozen (WF16h) */
  closed: boolean;
  accounts: readonly AccountView[];
  off: boolean;
  send: (text: string) => Promise<boolean>;
  onStop: () => void;
  onUndo: () => void;
  onQuota: (go: boolean) => void;
}

function lineText(tr: Tr, l: DraftLine): string {
  if (!l.key) return l.text;
  const p = l.params ?? {};
  if (l.key === 'workflow.author.saved' && !Number(p.projects) && !Number(p.docs)) return tr('workflow.author.savedShort', p);
  // §4.9 Kiểm gói in the UI's words: the engine sends the codes + its own text (for Claude) as JSON
  if (l.key === 'workflow.author.check') return tr('workflow.author.check', { msgs: (JSON.parse(String(p.issues ?? '[]')) as { code: string; msg: string }[]).map(i => issueText(tr, i)).join(' · ') });
  return tr(l.key as Key, p);
}

/** WF16c / WF16d Hoàn tác with the seconds left; past the window the button goes and the line says so (WF16h). */
function Undo({ tr, draft, closed, onUndo }: { tr: Tr; draft: DraftView | null; closed: boolean; onUndo: () => void }): ReactElement | null {
  const until = draft?.saved?.until ?? 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!until) return; const t = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(t); }, [until]);
  if (!draft?.saved) return null;
  const left = Math.ceil((until - now) / 1000);
  if (closed || left <= 0) return <div className="asys">{tr('workflow.author.undoExpired')}</div>;
  if (draft.saved.applied) return <div className="aundo"><button type="button" className="btn sm" disabled>{tr('workflow.author.undo')}</button><span>{tr('workflow.author.applied', { name: draft.saved.applied })}</span></div>;
  return <div className="aundo"><button type="button" className="btn sm" onClick={onUndo}>{tr('workflow.author.undo')}</button><span>{tr('workflow.author.undoLeft', { s: left })}</span></div>;
}

export function AuthorChat({ tr, draft, closed, accounts, off, send, onStop, onUndo, onQuota }: AuthorChatProps): ReactElement {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const lines = draft?.lines ?? [];
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [lines.length, draft?.state]);
  const state = closed ? 'closed' : draft?.state ?? 'pending';
  const running = state === 'running';
  const acct = draft?.account ? accounts.find(a => a.email === draft.account) : undefined;
  const pct = acct?.weekPct ?? null;
  const quota = draft?.quota ? tr('workflow.author.quotaOut') : pct === null ? null : leftPct(tr, 100 - pct);
  const sub = draft ? [draft.account, quota, draft.model].filter(Boolean).join(' · ') : tr('workflow.author.pendingSub');
  const title = !draft ? tr('workflow.author.pendingTitle') : draft.saved || closed ? tr('workflow.author.savedTitle') : tr('workflow.author.draftTitle');
  const canType = !off && (state === 'pending' || state === 'idle' || state === 'quota');
  const go = () => {
    const t = text.trim();
    if (!t || !canType || busy) return;
    setBusy(true);
    void send(t).then(ok => { if (ok) setText(''); }).finally(() => setBusy(false));
  };
  const place = state === 'running' ? 'placeRun' : state === 'saved' ? 'placeSaved' : state === 'closed' ? 'placeClosed' : state === 'pending' ? 'placePending' : 'placeIdle';
  return <div className="achat" role="region" aria-label={tr('workflow.author.chat')} data-draft={draft?.id} data-state={state}>
    <div className="pph"><span className="g"><Icon n="msg" /></span><span className="tt"><b>{title}</b><span>{sub}</span></span></div>
    <div className="alist" ref={list}>
      {lines.map((l, i) => l.kind === 'user' ? <div key={i} className="au">{l.text}</div>
        : l.kind === 'claude' ? <div key={i} className="ac">{l.text}</div>
          : l.kind === 'activity' ? <div key={i} className="aact"><Icon n="loader" s={12} />{lineText(tr, l)}</div>
            : <div key={i} className="asys">{lineText(tr, l)}</div>)}
      {running && !lines.some(l => l.kind === 'activity') ? <div className="aact"><Icon n="loader" s={12} />{tr('workflow.author.thinking')}</div> : null}
      <Undo tr={tr} draft={draft} closed={closed} onUndo={onUndo} />
      {draft?.quota && state === 'quota' ? <div className="aq">
        {draft.quota.to ? <button type="button" className="btn sm pri" disabled={off} onClick={() => onQuota(true)}>{tr('workflow.author.go')}</button> : null}
        <button type="button" className="btn sm" disabled={off} onClick={() => onQuota(false)}>{tr('workflow.author.laterBtn')}</button></div> : null}
      {draft?.resumeFailed ? <div className="asys">{tr('workflow.author.resumeFailed')}</div> : null}
    </div>
    <div className="acomp">
      <textarea className="fld" rows={2} value={text} disabled={!canType && !running} placeholder={tr(`workflow.author.${place}`)} aria-label={tr(`workflow.author.${place}`)}
        onChange={e => setText(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } }} />
      {running ? <button type="button" className="btn" disabled={off} onClick={onStop}><Icon n="stop" s={12} />{tr('workflow.author.stop')}</button>
        : <button type="button" className="btn ic" aria-label={tr('workflow.author.send')} title={tr('workflow.author.send')} disabled={!canType || busy || !text.trim()} onClick={go}>
          <Icon n={busy ? 'loader' : 'send'} s={14} /></button>}
    </div>
  </div>;
}
