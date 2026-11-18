// Chờ PO block (v2.1 §4.11b top of the left column; v1 U1, U7/F14) as v2.4 §6.7 D52 rows: one row per card, ordered by
// lib/cards.ts; answers go through UndoQueue; a row click selects the card and opens its detail box (App).
import { useLayoutEffect, useRef, type ReactElement } from 'react';
import type { CardView, Channel } from '../../../shared/protocol.ts';
import { useFade } from '../lib/fade.ts';
import { orderCards, type CardAnswer, type ClickGuard, type UndoQueue } from '../lib/cards.ts';
import { inboxMode } from '../lib/inspector.ts';
import { useT } from '../lib/i18n.tsx';
import { CardRow } from './Card.tsx';
import { Icon } from './icons.tsx';

export interface InboxProps {
  cards: CardView[];
  focusId: number | null;
  channel: Channel | null;
  offline: boolean;
  /** v2.1 §4.14 running sessions per project id (sources name the session when > 1). */
  sessions?: Record<string, number>;
  undo: UndoQueue;
  guard: ClickGuard;
  newIds: Set<number>;
  /** §6.7 select the card + its lane / Điều phối and open its detail box */
  onOpen: (id: number) => void;
  onAction: (c: CardView, action: string) => void;
}
export interface InboxBlockProps extends InboxProps {
  /** §4.11 Q / "˄": folded to one line by the PO */
  folded: boolean;
  /** "Đã xử lý n ▸" open (answered cards shown while nothing is pending) */
  resolvedOpen: boolean;
  onToggle: () => void;
  onResolved: () => void;
}

/** The ordered rows: pending (oldest first), then "Không cần anh làm gì" + the resolved ones. */
function CardList(p: InboxProps): ReactElement {
  const tr = useT();
  const { pending, resolved } = orderCards(p.cards);
  const sig = [...pending, ...resolved].map(c => `${c.id}:${c.status}`).join(',');
  const last = useRef(sig);
  // U1: after any layout shift of the list, ignore clicks on rows and their buttons for 1 s.
  useLayoutEffect(() => {
    if (last.current !== sig) p.guard.shifted();
    last.current = sig;
  }, [sig, p.guard]);
  const g = p.guard;
  const render = (c: CardView) => {
    const u = p.undo.get(c.id);
    return (
      <CardRow key={c.id} c={c} tr={tr} focused={c.id === p.focusId} isNew={p.newIds.has(c.id)} channel={p.channel} offline={p.offline}
        sessions={(c.projectId ? p.sessions?.[c.projectId] : undefined) ?? 1}
        undo={u ? { label: u.label, left: p.undo.remaining(c.id) } : null}
        onChoose={g.wrap((label: string, answer: CardAnswer) => p.undo.choose(c.id, label, answer))}
        onUndo={() => p.undo.undo(c.id)}
        onAction={g.wrap((a: string) => p.onAction(c, a))}
        onOpen={g.wrap(() => p.onOpen(c.id))} />
    );
  };
  return <>
    {pending.map(render)}
    {pending.length && resolved.length ? <div className="cdiv">{tr('inbox.noAction')}</div> : null}
    {resolved.map(render)}
  </>;
}

/** §4.11b: never hidden. Cards → "Chờ PO n" + rows (max 56 % of the column, 46 % narrow; scroll, bottom fade); nothing
 *  pending (or folded by Q) → one line "Chờ PO 0 · ✓ Không có việc chờ PO" (+ "Đã xử lý n ▸"). */
export function Inbox(p: InboxBlockProps): ReactElement {
  const tr = useT();
  const fade = useFade<HTMLDivElement>(); // R43 I2 the 16 px fade band only while the rows overflow
  const { pending, resolved } = orderCards(p.cards);
  // UX-M7 N1-k a card in its 5 s undo is answered: it no longer counts as waiting
  const inUndo = p.undo.ids(), n = pending.filter(c => !inUndo.has(c.id)).length;
  const mode = inboxMode({ cards: p.cards, folded: p.folded, resolvedOpen: p.resolvedOpen });
  const head = <><b>{tr('inbox.title')}</b><span className={`cnt ${n ? '' : 'zero'}`}>{n}</span></>;
  if (mode === 'line') return (
    <aside id="inbox" className="glass line" aria-label={tr('inbox.title')}>
      <header>{head}
        {n ? <span className="sp" /> : <span className="none"><Icon n="check" s={13} /> {tr('inspector.inbox.none')}</span>}
        {!n && resolved.length ? <button type="button" className="lnk res" onClick={p.onResolved}>{tr('inspector.inbox.resolvedN', { n: resolved.length })}</button> : null}
        {n ? <button type="button" className="fold" onClick={p.onToggle} title={tr('inspector.inbox.expandQ')} aria-label={tr('inspector.inbox.expandQ')} aria-expanded={false}>˅</button> : null}
      </header>
    </aside>
  );
  return (
    <aside id="inbox" className="glass" aria-label={tr('inbox.title')}>
      <header>{head}<span className="sp" />
        <button type="button" className="fold" onClick={p.onToggle} title={tr('inspector.inbox.foldQ')} aria-label={tr('inspector.inbox.foldQ')} aria-expanded>˄</button></header>
      <div className="cards" ref={fade.ref} onScroll={fade.onScroll}><CardList {...p} /></div>
    </aside>
  );
}
