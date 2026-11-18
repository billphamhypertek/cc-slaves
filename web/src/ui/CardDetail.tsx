// v2.4 §6.7 D52 the detail box of one Chờ PO card (CP2 ask, CP2b permission, CP6 remote): a modal with the full text and
// every action. Choosing an answer closes it (the row shows the 5 s undo); a button that opens an account dialog closes
// it first (App / appIntents.boxAction). Offline: read only. Remote: `cardActions` hides what the engine would refuse.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { CardView, Channel } from '../../../shared/protocol.ts';
import { isPending, k13Why, keyAnswer, orderedOptions, permLabel, rowTone, type CardAnswer } from '../lib/cards.ts';
import { fmtHm } from '../lib/format.ts';
import { actionLabel, cardBody, cardTitle, useT, type Tr } from '../lib/i18n.tsx';
import { cardSource } from '../lib/labels.ts';
import { cardActions } from '../lib/remote.ts';
import { cardChip } from '../lib/sessions.ts';
import { KIND_ICON, resolvedLabel } from './Card.tsx';
import { Icon } from './icons.tsx';
import { Rich } from './Rich.tsx';

export interface CardDetailProps {
  c: CardView;
  channel: Channel | null;
  offline: boolean;
  projectName?: string;
  sessions: number;
  onChoose: (label: string, answer: CardAnswer) => void;
  onAction: (action: string) => void;
  onClose: () => void;
}

function AskBody({ c, p, tr }: { c: CardView; p: CardDetailProps; tr: Tr }): ReactElement {
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const opts = orderedOptions(c);
  return <>
    {opts.length ? <div className="ops">{opts.map((o, j) => (
      <button key={o.label} type="button" className="opt" disabled={p.offline}
        onClick={() => { const k = keyAnswer(tr, c, j + 1); if (k) p.onChoose(k.label, k.answer); }}>
        <kbd>⌥{j + 1}</kbd><span><b>{o.label}</b>{o.description ? <span className="od">{o.description}</span> : null}</span>
        {o.label === c.recommended ? <span className="tag">{tr('inbox.rec')}</span> : null}
      </button>))}</div> : null}
    {opts.length && !other ? <div className="row2">
      <button type="button" className="lnk" disabled={p.offline} onClick={() => setOther(true)}>{tr('inbox.other')}</button><span>{tr('inbox.box.otherNote')}</span>
    </div> : <div className="other">
      <textarea aria-label={tr('inbox.answerAria')} placeholder={tr('inbox.answerPh')} value={text} disabled={p.offline} onChange={e => setText(e.target.value)} />
      <button type="button" className="btn sm pri" disabled={p.offline || !text.trim()} onClick={() => p.onChoose(text.trim(), { other: text.trim() })}>{tr('inbox.send')}</button>
    </div>}
  </>;
}

function PermBody({ c, p, tr }: { c: CardView; p: CardDetailProps; tr: Tr }): ReactElement {
  const [reason, setReason] = useState('');
  const deny = () => p.onChoose(permLabel(tr, 'deny'), reason.trim() ? { behavior: 'deny', reason: reason.trim() } : { behavior: 'deny' });
  const bt = (n: number, label: string, run: () => void, icon?: 'check' | 'x') => (
    <button type="button" className="btn sm" disabled={p.offline} onClick={run}>{icon ? <Icon n={icon} s={13} /> : null}{label}<kbd>⌥{n}</kbd></button>);
  return <>
    {/* U2: allow and deny share one button style, no "Đề xuất" */}
    <div className="bts">
      {bt(1, permLabel(tr, 'allow'), () => p.onChoose(permLabel(tr, 'allow'), { behavior: 'allow' }), 'check')}
      {c.canAllowAlways ? bt(2, permLabel(tr, 'allow_always'), () => p.onChoose(permLabel(tr, 'allow_always'), { behavior: 'allow_always' })) : null}
      {bt(3, permLabel(tr, 'deny'), deny, 'x')}
    </div>
    <input className="field" placeholder={tr('inbox.denyPh')} aria-label={tr('inbox.denyAria')} value={reason} disabled={p.offline} onChange={e => setReason(e.target.value)} />
    <div className="row2"><Icon n="clock" s={13} />{tr('inbox.autoDeny')}</div>
  </>;
}

function SystemBody({ c, p, tr }: { c: CardView; p: CardDetailProps; tr: Tr }): ReactElement {
  const actions = cardActions(c, p.channel);
  return <>
    {c.kind === 'mcp_login' && p.channel === 'remote' ? <div className="row2 k13r"><Icon n="lock" s={13} /><span><b>{tr('inbox.k13.remote')}</b> {tr('inbox.k13.remoteWhy')}</span></div> : null}
    {actions.length ? <div className="bts">{actions.map((a, i) => (
      <button key={a.id} type="button" className={`btn sm${i === 0 ? ' pri' : ''}`} disabled={p.offline} onClick={() => p.onAction(a.id)}>{actionLabel(tr, a)}</button>))}</div> : null}
  </>;
}

/** The full text under the question: the permission's whole command (mono), K13's why line, a system body, an ask's context. */
function context(tr: Tr, c: CardView): { text: string; mono: boolean } | null {
  if (c.kind === 'permission') { const t = c.context ?? (c.params?.main as string | undefined); return t ? { text: t, mono: true } : null; }
  if (c.kind === 'mcp_login') return { text: [k13Why(tr, c), c.params?.lanes].filter(Boolean).join('\n'), mono: true };
  const t = c.kind === 'ask' ? c.context : cardBody(tr, c);
  return t ? { text: t, mono: false } : null;
}

function doneNote(tr: Tr, c: CardView): string {
  if (c.status === 'answered') return `${tr('inbox.answered')} ${resolvedLabel(tr, c)}`;
  return c.status === 'cancelled' ? `${tr('inbox.cancelled')} ${tr('inbox.cancelledNote')}` : `${tr('inbox.expired')} ${tr('inbox.expiredNote')}`;
}

export function CardDetail(p: CardDetailProps): ReactElement {
  const { c } = p;
  const tr = useT();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, [c.id]);
  const open = isPending(c);
  // the question line: an ask's question; a permission without its command ("D2 xin chạy: Bash", the command sits below)
  const q = c.kind === 'ask' ? c.question ?? cardTitle(tr, c)
    : c.kind === 'permission' && c.titleKey === 'cards.permission' ? cardTitle(tr, { ...c, titleKey: 'cards.permissionBare' }) : cardTitle(tr, c);
  const ctx = context(tr, c);
  const answerable = open && (c.kind === 'ask' || c.kind === 'permission');
  return (
    <div id="cardbox" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div ref={box} className={`modal cpm${p.offline ? ' off' : ''}`} role="dialog" aria-modal="true" aria-labelledby="cardbox-q" tabIndex={-1} data-id={c.id}>
        <header className={`mh ${rowTone(c)}`}>
          <span className="ki"><Icon n={KIND_ICON[c.kind]} s={15} /></span>
          <span className="src">{cardChip(tr, c, cardSource(tr, c, p.projectName), p.sessions)}</span>
          <span className="tm">{fmtHm(c.createdAt)}</span>
          <button type="button" className="ia x" aria-label={tr('common.close')} data-tip={tr('common.close')} onClick={p.onClose}><Icon n="x" s={14} /></button>
        </header>
        <div className="mb">
          <div className="q2" id="cardbox-q"><Rich text={q} /></div>
          {ctx ? <div className={`ctx${ctx.mono ? ' mono' : ''}`}>{ctx.text}</div> : null}
          {!open ? <div className="row2">{doneNote(tr, c)}</div>
            : c.kind === 'ask' ? <AskBody c={c} p={p} tr={tr} />
              : c.kind === 'permission' ? <PermBody c={c} p={p} tr={tr} /> : <SystemBody c={c} p={p} tr={tr} />}
        </div>
        {p.offline ? <div className="mro"><Icon n="wifi" s={12} /><span>{tr('inbox.box.offline')}</span></div> : null}{/* R43 M1 why it is read only */}
        <footer className="ft"><span className="hint">{tr(answerable ? 'inbox.box.hint' : 'inbox.box.hintEsc')}</span></footer>
      </div>
    </div>
  );
}
