// v2.1 §4.2 line 2 of a lane node / §4.4 line 2 of the orchestrator node. Ports the v1.1 `laneCard` / `orchCard` rules
// (v1.1 M3): the newest open card wins, "+n" for the others; Hỏng / Chờ PO from the lane state when no card is open.
import type { Tr } from '../../../shared/i18n/core.ts';
import type { AccountView, CardView, LaneView, OrchestratorView } from '../../../shared/protocol.ts';
import { cardTitle, reasonText } from '../lib/i18n.tsx';
import { fmtResetTime, resetAt } from '../lib/format.ts';
import { accKind } from './accounts.ts';

/** §4.2 "cắt 28 ký tự". */
export const CARD_CHARS = 28;
const trunc = (s: string, n = CARD_CHARS) => { const c = [...s]; return c.length > n ? c.slice(0, n).join('') + '…' : s; };
const lastLine = (s: string | null) => (s ? s.trim().split('\n').filter(x => x.trim()).at(-1)?.trim() ?? null : null);
const newest = (cs: CardView[]) => [...cs].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0] ?? null;

export type CardKind = 'ask' | 'perm' | 'broken' | 'waiting';
/** `text` is already cut to 28 chars; `more` = other open cards of the same lane ("+n"); `cardId` null = select the lane only. */
export interface CardFace { kind: CardKind; tone: 'warn' | 'bad'; text: string; more: number; cardId: number | null }

/** §4.2 the label before the text ("Chờ PO:" / "Xin chạy:" / "Hỏng" / "Chờ PO") and the button ("Trả lời" / "Xem"). */
export const cardLabel = (tr: Tr, k: CardKind) => tr(k === 'ask' ? 'deck.node.ask' : k === 'perm' ? 'deck.node.perm' : k === 'broken' ? 'deck.node.broken' : 'deck.node.waiting');
export const cardButton = (tr: Tr, k: CardKind) => tr(k === 'ask' || k === 'perm' ? 'deck.node.answer' : 'deck.node.view');

/** "Bash `rm -rf build/`" from the permission card's params (never "Đề xuất", v1 U2); old rows → the title. */
function permText(c: CardView, tr: Tr): string {
  const p = c.params;
  if (p && typeof p.tool === 'string') return typeof p.main === 'string' && p.main ? `${p.tool} ${p.main}` : p.tool;
  return cardTitle(tr, c);
}

/** §4.2 line 2, card part: the lane's newest open card; else Hỏng / Chờ PO from the lane state; else null. */
export function laneCard(l: LaneView, cards: CardView[], tr: Tr): CardFace | null {
  const open = cards.filter(x => x.status === 'open' && x.source === l.name && x.projectId === l.projectId);
  const c = newest(open), more = Math.max(0, open.length - 1);
  const err = () => lastLine(reasonText(tr, l.lastError, l.lastErrorKeyed)) ?? '';
  if (c) {
    if (c.kind === 'permission') return { kind: 'perm', tone: 'warn', text: trunc(permText(c, tr)), more, cardId: c.id };
    if (c.kind === 'broken') return { kind: 'broken', tone: 'bad', text: trunc(err() || cardTitle(tr, c)), more, cardId: c.id };
    return { kind: 'ask', tone: 'warn', text: trunc(c.question ?? cardTitle(tr, c)), more, cardId: c.id };
  }
  if (l.state === 'broken') return { kind: 'broken', tone: 'bad', text: trunc(err()), more: 0, cardId: null };
  if (l.state === 'waiting_po') return { kind: 'waiting', tone: 'warn', text: '', more: 0, cardId: null };
  return null;
}

export type Line2 =
  | { kind: 'card'; face: CardFace }
  | { kind: 'quota'; at: string | null }
  | { kind: 'text'; text: string };

/** §4.2 earliest reset of a full account ("reset sớm nhất", v1 F6) and which account it is (N4-e); null when none is known. */
export function earliestReset(accs: AccountView[]): { at: number; email: string } | null {
  const r = accs.filter(a => accKind(a) === 'full').map(a => ({ at: resetAt(a), email: a.email }))
    .filter((x): x is { at: number; email: string } => x.at !== null).sort((a, b) => a.at - b.at);
  return r[0] ?? null;
}

/** §4.2 line 2 priority: card (beats quota, N4-e) → Chờ quota + reset → note → the title of the issue it holds (v2.7 §4.2-3)
 *  → task. */
export function laneLine2(l: LaneView, cards: CardView[], accs: AccountView[], tr: Tr, issueTitle: string | null = null): Line2 {
  const face = laneCard(l, cards, tr);
  if (face) return { kind: 'card', face };
  if (l.state === 'waiting_quota') { const r = earliestReset(accs); return { kind: 'quota', at: fmtResetTime(r?.at ?? null) }; }
  return { kind: 'text', text: l.note || issueTitle || l.task || '' };
}

/** §4.4 orchestrator card: `orchestrator_down` / stopped beats its own ask (po_ask). */
export function orchCard(o: OrchestratorView | null, cards: CardView[], projectId: string): { kind: 'down' | 'ask'; cardId: number | null } | null {
  // v2.1 §4.14 a session's own cards only (cards without a session id belong to any root, as before)
  const mine = (x: CardView) => x.status === 'open' && x.projectId === projectId && (!o?.sessionId || !x.sessionId || x.sessionId === o.sessionId);
  const c = newest(cards.filter(x => mine(x) && (x.kind === 'orchestrator_down' || x.source === 'orchestrator')));
  const down = cards.find(x => mine(x) && x.kind === 'orchestrator_down');
  if (down) return { kind: 'down', cardId: down.id };
  if (o?.state === 'stopped') return { kind: 'down', cardId: null };
  if (c) return { kind: 'ask', cardId: c.id };
  return null;
}
