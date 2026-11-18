// One Chờ PO row — v2.4 §6.7 D52 (CP1 / CP3): kind glyph · source · one line · time · ≤ 2 icon buttons or "›"; in its
// 5 s undo the row says what was chosen + "Hoàn tác (n)". Everything else lives in the detail box (CardDetail.tsx).
// Hook-free: the list passes `tr`, so the row is a plain function of its props.
import type { CSSProperties, ReactElement } from 'react';
import { isOrchSource, type CardView, type Channel } from '../../../shared/protocol.ts';
import { issueRow, keyAnswer, permLabel, rowActions, rowText, rowTone, type CardAnswer, type IssueRowLayout, type RowAct } from '../lib/cards.ts';
import { fmtHm } from '../lib/format.ts';
import { actionLabel, cardBody, type Tr } from '../lib/i18n.tsx';
import { cardChip } from '../lib/sessions.ts';
import { Icon, type IconName } from './icons.tsx';
import { Rich } from './Rich.tsx';
import './inbox.css';

export interface CardRowProps {
  c: CardView;
  tr: Tr;
  focused: boolean;
  isNew: boolean;
  channel: Channel | null;
  offline: boolean;
  /** v2.1 §4.14 running sessions of the card's project: > 1 → the source names the session ("#2 · D2"). */
  sessions: number;
  undo: { label: string; left: number } | null;
  onChoose: (label: string, answer: CardAnswer) => void;
  onUndo: () => void;
  onAction: (action: string) => void;
  /** select the card (+ its lane / Điều phối) and open its detail box */
  onOpen: () => void;
}

/** §6.7 kind glyph (row + box header). */
export const KIND_ICON: Record<CardView['kind'], IconName> = {
  permission: 'shieldQ', ask: 'msgQ', broken: 'octAlert', orchestrator_down: 'octAlert', logged_out: 'logOut', cc_updated: 'info',
  shared_cfg: 'folderSync', shared_cfg_new: 'folderSync', account_orphan: 'userX', cutover: 'userPlus', mcp_login: 'key',
  issues_new: 'info', superpowers_off: 'octAlert', revert_conflict: 'octAlert',
};
const ACT_ICON: Record<string, IconName> = {
  view_log: 'file', lane_resume: 'refresh', restart_orchestrator: 'refresh', orchestrator_restart: 'refresh', account_relogin: 'logIn',
  mcp_login: 'logIn', setup_check: 'refresh', dismiss: 'check', shared_cfg_merge: 'gitMerge', account_add: 'userPlus',
};

/** §6.7 the source chip: the lane, Điều phối (also its down card), "#n · …" with > 1 session; v2.7 the issue key of
 *  issues_new (one issue, orange) / revert_conflict, "Engine" on superpowers_off; other system cards: none. */
function rowSource(tr: Tr, c: CardView, sessions: number): string | null {
  const key = typeof c.params?.key === 'string' ? c.params.key : null;
  if (c.kind === 'issues_new' || c.kind === 'revert_conflict') return key;
  if (c.kind === 'superpowers_off') return tr('labels.src.engine');
  const lane = c.source ?? (c.kind === 'broken' && typeof c.params?.name === 'string' ? c.params.name : null); // the engine's cards.laneBroken {name}
  const who = c.kind === 'orchestrator_down' ? tr('common.role.orchestrator') : c.kind === 'ask' || c.kind === 'permission' || c.kind === 'broken'
    ? isOrchSource(lane) ? tr('common.role.orchestrator') : lane : null;
  return who ? cardChip(tr, c, who, sessions) : null;
}

/** §6.7 a resolved row's right side: the answer, "Đã huỷ" / "Đã hết hạn", a handled system card "Đã xử lý". */
export function resolvedLabel(tr: Tr, c: CardView): string {
  if (c.status === 'cancelled') return tr('inbox.cancelled');
  if (c.status === 'expired') return tr('inbox.expired');
  const a = c.answer as { option?: string; other?: string; behavior?: string } | null | undefined;
  if (a?.behavior) return permLabel(tr, a.behavior === 'allow' || a.behavior === 'allow_always' ? a.behavior : 'deny');
  return a?.option ?? a?.other ?? tr('inbox.row.handled');
}

/** A plain function (not a component) so the row stays one element tree (unit tests walk it). */
function rowButton(a: RowAct, c: CardView, p: CardRowProps, i: number): ReactElement {
  const { tr } = p;
  let label: string, icon: IconName, tip: string, run: () => void, locked = false;
  if (a.t === 'answer') {
    const k = keyAnswer(tr, c, a.b === 'allow' ? 1 : 3)!;
    label = k.label; icon = a.b === 'allow' ? 'check' : 'x'; tip = `${label} ⌥${a.b === 'allow' ? 1 : 3}`;
    run = () => p.onChoose(k.label, k.answer);
  } else if (a.t === 'act') {
    const def = c.actions?.find(x => x.id === a.id);
    label = def ? actionLabel(tr, def) : a.id; icon = a.locked ? 'lock' : ACT_ICON[a.id] ?? 'chevR'; locked = a.locked;
    tip = locked ? tr('inbox.row.macOnly') : label;
    run = () => p.onAction(a.id);
  } else {
    label = tr('inbox.row.open'); icon = 'chevR'; tip = label; run = p.onOpen;
  }
  return (
    <button key={i} type="button" className={`ia${a.t === 'open' ? ' op' : ''}${locked ? ' lock' : ''}`} aria-label={label} data-tip={tip}
      disabled={locked || p.offline} onClick={e => { e.stopPropagation(); run(); }}><Icon n={icon} s={14} /></button>
  );
}

/** v2.7 §4.2-4 / §7.3 / §5.7-5 the issue cards' text buttons: "Xem", the second line (or "trả lời trên Mac" on remote, §8). */
function issueButtons(l: IssueRowLayout, c: CardView, p: CardRowProps): ReactElement | null {
  const { tr } = p, label = (id: string) => { const d = c.actions?.find(x => x.id === id); return d ? actionLabel(tr, d) : id; };
  const run = (id: string) => (e: { stopPropagation(): void }) => { e.stopPropagation(); p.onAction(id); };
  if (!l || l.k === 'none') return null;
  if (l.k === 'xem') return <span className="ra"><button type="button" className="rb acc" disabled={p.offline} onClick={run('issues_view')}>{label('issues_view')}</button></span>;
  return (
    <span className="sub">
      {l.acts.map(a => <button key={a.id} type="button" className={`rb ${a.tone}`} disabled={p.offline} onClick={run(a.id)}>
        {a.alt ? <kbd>⌥{a.alt}</kbd> : null}{a.id === 'open_skills' ? <Icon n="plug" s={13} /> : null}{label(a.id)}</button>)}
      {l.note === 'body' ? <span className="nt">{cardBody(tr, c)}</span> : l.note === 'macOnly' ? <span className="nt">{tr('inbox.row.answerOnMac')}</span> : null}
    </span>
  );
}

export function CardRow(p: CardRowProps): ReactElement {
  const { c, tr } = p;
  const src = rowSource(tr, c, p.sessions);
  const done = c.status !== 'open';
  const il = p.undo ? null : issueRow(c);
  const cls = ['card', p.focused && 'focus', p.isNew && 'new', rowTone(c), done && 'done', p.undo && 'un', il?.k === 'two' && 'two'].filter(Boolean).join(' ');
  const t = rowText(tr, c);
  const line = p.undo ? <>{tr('inbox.chosen')} “{p.undo.label}” {tr('inbox.sendIn', { s: p.undo.left })}</> : <><Rich text={t.text} />{t.code ? <> <code>{t.code}</code></> : null}</>;
  return (
    <article className={cls} data-id={c.id} onClick={p.onOpen}>
      <span className="ki"><Icon n={done ? 'check' : KIND_ICON[c.kind]} s={14} /></span>
      {src ? <span className={`src${c.kind === 'issues_new' ? ' am' : ''}`}>{src}</span> : null}
      <span className={`tt${t.am ? ' am' : ''}`} title={c.kind === 'issues_new' || il?.k === 'two' ? t.text : undefined}>{line}</span>
      {p.undo ? (
        <button type="button" className="und" onClick={e => { e.stopPropagation(); p.onUndo(); }}>
          <i className="ring" style={{ '--p': p.undo.left * 20 } as CSSProperties} />{tr('inbox.undo', { s: p.undo.left })}
        </button>
      ) : <>
        {done ? <span className="an">{resolvedLabel(tr, c)}</span> : null}
        <span className="tm">{fmtHm(c.createdAt)}</span>
        {done ? null : il ? issueButtons(il, c, p) : <span className="ra">{rowActions(c, p.channel).map((a, i) => rowButton(a, c, p, i))}</span>}
      </>}
    </article>
  );
}
