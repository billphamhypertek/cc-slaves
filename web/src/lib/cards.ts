// Chờ PO inbox logic — spec §6.0 U1/U2, §6.4 F4, §6.15 F15; v2.4 §6.7 D52 the compact rows (actions, tone, text, keys).
import type { Tr } from '../../../shared/i18n/core.ts';
import type { CardView, Channel, Command } from '../../../shared/protocol.ts';
import { fmtHm } from './format.ts';
import { cardBody, cardTitle } from './i18n.tsx';
import { actionAllowed } from './remote.ts';

export type CardAnswer = Extract<Command, { cmd: 'card_answer' }>['answer'];

/** waiting for the PO: open, and not the §5.2 new-entry question (it lives only in Cấu hình chung, never in Chờ PO), so the tab
 *  badge, the menu bar and Chờ PO count the same cards */
export const isPending = (c: CardView) => c.status === 'open' && c.kind !== 'shared_cfg_new';

/**
 * Cards of the current project plus global system cards (projectId null). G4 UX 5(b): the §5.2 new-entry question
 * (safe default "riêng", nothing waits) lives only in Settings › Account › Cấu hình chung and its ⚠ n count.
 */
export const visibleCards = (cards: CardView[], projectId: string | null) =>
  cards.filter(c => c.kind !== 'shared_cfg_new' && (c.projectId === null || c.projectId === projectId));

/** §6 K13 the why line under the title (time = when the card came). */
export function k13Why(tr: Tr, c: Pick<CardView, 'titleKey' | 'createdAt'>): string {
  const time = fmtHm(c.createdAt);
  return c.titleKey === 'cards.mcpLogin' ? tr('inbox.k13.noToken')
    : c.titleKey === 'cards.mcpReloginScope' ? tr('inbox.k13.scope', { time }) : tr('inbox.k13.invalidGrant', { time });
}

/** C26 a card counts on the tab of `projectId`: its own project's, or a system card (projectId null) — K13 only on the
 *  tabs of its `projectIds` (the projects with a lane missing the server). */
export const countsOn = (c: CardView, projectId: string) =>
  c.projectId === projectId || (c.projectId === null && (c.projectIds === undefined || c.projectIds.includes(projectId)));

/** §7.3 / §5.7-5 (R-B19) cards that hold work back ("lane mới phải chờ", a stuck revert): always on top of Chờ PO. */
const PINNED: ReadonlySet<CardView['kind']> = new Set(['superpowers_off', 'revert_conflict']);
const pinRank = (c: CardView) => (PINNED.has(c.kind) ? 0 : 1);
/** U1: pending oldest first (new ones append at the bottom), the R-B19 pinned kinds above the rest; resolved below, latest
 *  resolved first. */
export function orderCards(cards: CardView[]): { pending: CardView[]; resolved: CardView[] } {
  const pending = cards.filter(isPending).sort((a, b) => pinRank(a) - pinRank(b) || a.createdAt - b.createdAt || a.id - b.id);
  const resolved = cards.filter(c => !isPending(c)).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0) || b.id - a.id);
  return { pending, resolved };
}

// ---------------------------------------------------------------- v2.4 §6.7 D52 one row per card
/** A row button: a permission answer, a system action (🔒 = Mac-only on the remote channel) or "›" = open the box. */
export type RowAct = { t: 'answer'; b: 'allow' | 'deny' } | { t: 'act'; id: string; locked: boolean } | { t: 'open' };

/** §6.7 the primary, non-destructive action(s) each kind shows on its row; questions and two-way choices only "›". */
const ROW_IDS: Partial<Record<CardView['kind'], string[]>> = {
  broken: ['view_log', 'lane_resume'], orchestrator_down: ['restart_orchestrator'], logged_out: ['account_relogin'],
  cc_updated: ['setup_check', 'dismiss'], shared_cfg: ['shared_cfg_merge'], cutover: ['account_add'], mcp_login: ['mcp_login'],
};
export function rowActions(c: CardView, channel: Channel | null): RowAct[] {
  if (!isPending(c)) return [];
  if (c.kind === 'permission') return [{ t: 'answer', b: 'allow' }, { t: 'answer', b: 'deny' }];
  const ids = ROW_IDS[c.kind] ?? [], have = new Set((c.actions ?? []).map(a => a.id));
  const acts = ids.filter(id => have.has(id)).slice(0, 2).map((id): RowAct => ({ t: 'act', id, locked: !actionAllowed(id, channel) }));
  return acts.length ? acts : [{ t: 'open' }];
}

/** §6.7 glyph colour: amber = waits for an answer, red = `BAD_KINDS` + a failed Claude Code update, grey = the rest. */
const BAD_KINDS = new Set<CardView['kind']>(['broken', 'orchestrator_down', 'logged_out', 'cutover', 'mcp_login', 'superpowers_off', 'revert_conflict']);
export function rowTone(c: CardView): 'warn' | 'bad' | 'info' {
  if (c.kind === 'ask' || c.kind === 'permission') return 'warn';
  return BAD_KINDS.has(c.kind) || (c.kind === 'cc_updated' && (c.actions ?? []).some(a => a.id === 'setup_check')) ? 'bad' : 'info';
}

const lines = (s: string | null) => (s ?? '').split('\n').map(x => x.trim()).filter(Boolean);
/** §6.7 the one line of a row (`code` = the mono part); a card without the field it needs (old `card_v2`) → its title.
 *  v2.7 §4.2-4 `am`: "<n> việc phát sinh" is orange. */
export function rowText(tr: Tr, c: CardView): { text: string; code?: string; am?: boolean } {
  const title = cardTitle(tr, c);
  const p = c.params;
  if (c.kind === 'issues_new') return typeof p?.key === 'string' ? { text: title } : { text: title, am: true };
  if (c.kind === 'permission') return p?.tool !== undefined && p.main !== undefined ? { text: String(p.tool), code: String(p.main) } : { text: title };
  if (c.kind === 'ask') return { text: c.question ?? title };
  const body = lines(cardBody(tr, c));
  if (c.kind === 'broken' && body.length) return { text: tr('inbox.row.broken', { text: body.at(-1)! }) };
  if (c.kind === 'orchestrator_down' && body.length) return { text: tr('inbox.row.down', { reason: body.join(' ') }) };
  return { text: title };
}

// ---------------------------------------------------------------- v2.7 the issue cards' rows (§4.2-4, §7.3, §5.7-5, §8)
type SubAct = { id: string; tone: 'acc' | 'def' | 'red'; alt?: number };
/** `xem` = the issues_new text button "Xem"; `two` = the second line (its buttons, then the body / "trả lời trên Mac"); null =
 *  the §6.7 icon buttons. Remote cards carry no actions (§8): Xem and the two buttons hide, revert_conflict says why. */
export type IssueRowLayout = { k: 'xem' } | { k: 'two'; acts: SubAct[]; note: 'body' | 'macOnly' | null } | { k: 'none' } | null;
export function issueRow(c: CardView): IssueRowLayout {
  if (!isPending(c)) return null;
  const has = (id: string) => (c.actions ?? []).some(a => a.id === id);
  if (c.kind === 'issues_new') return has('issues_view') ? { k: 'xem' } : { k: 'none' };
  if (c.kind === 'superpowers_off') return { k: 'two', acts: has('open_skills') ? [{ id: 'open_skills', tone: 'acc' }] : [], note: 'body' };
  if (c.kind === 'revert_conflict') {
    const acts: SubAct[] = [];
    if (has('revert_keep')) acts.push({ id: 'revert_keep', tone: 'def', alt: 1 });
    if (has('revert_cancel_both')) acts.push({ id: 'revert_cancel_both', tone: 'red' });
    return { k: 'two', acts, note: acts.length ? null : 'macOnly' };
  }
  return null;
}

/** §5.7-5 ⌥1 = "Giữ T-46" of the revert_conflict card that is the selected row or the open box (its first, default button). */
export function keyAct(k: Pick<KeyPickCtx, 'pending' | 'focusId' | 'boxId' | 'otherModal' | 'offline'>, n: number): { id: number; action: string } | null {
  if (k.otherModal || k.offline) return null;
  const c = k.pending.find(x => x.id === (k.boxId ?? k.focusId));
  const l = c ? issueRow(c) : null;
  const a = l?.k === 'two' ? l.acts.find(x => x.alt === n) : undefined;
  return c && a ? { id: c.id, action: a.id } : null;
}

export interface KeyPickCtx { pending: CardView[]; focusId: number | null; boxId: number | null; otherModal: boolean; offline: boolean }
/** §6.7 I3 what ⌥n answers: the open box's card (even though the box is a modal; not under another dialog), else the selected
 *  row only when it is a permission, and then only ⌥1 / ⌥3 — the row shows ✓ / ✕, never "Cho phép luôn" (R42 I1). Offline
 *  the box is read-only and rows cannot be pressed → nothing (R42 m1). */
export function keyPick(tr: Tr, k: KeyPickCtx, n: number): { id: number; label: string; answer: CardAnswer } | null {
  if (k.otherModal || k.offline) return null;
  const c = k.boxId !== null ? k.pending.find(x => x.id === k.boxId)
    : n === 1 || n === 3 ? k.pending.find(x => x.id === k.focusId && x.kind === 'permission') : undefined;
  const a = c && keyAnswer(tr, c, n);
  return c && a ? { id: c.id, ...a } : null;
}

/** §6.7 the detail box shows its card while that card keeps the status it opened with and is not in its undo. */
export type CardBox = { id: number; status: CardView['status'] };
export function boxCardOf(cards: CardView[], box: CardBox | null, inUndo: Set<number>): CardView | null {
  if (!box || inUndo.has(box.id)) return null;
  return cards.find(c => c.id === box.id && c.status === box.status) ?? null;
}

const answerable = (c: CardView) => (c.kind === 'ask' && (c.options?.length ?? 0) > 0) || c.kind === 'permission';

/** U1: ⌥ keys act on the selected card; default = top answerable pending card not in its undo window. */
export function defaultFocus(pending: CardView[], inUndo: Set<number>): number | null {
  return pending.find(c => answerable(c) && !inUndo.has(c.id))?.id ?? null;
}

/** §6.4: the `recommended` option stands first. */
export function orderedOptions(c: CardView): { label: string; description?: string }[] {
  const opts = c.options ?? [];
  const rec = opts.find(o => o.label === c.recommended);
  return rec ? [rec, ...opts.filter(o => o !== rec)] : opts;
}

export type PermBehavior = 'allow' | 'allow_always' | 'deny';
/** F15 permission buttons in the UI language. */
export const permLabel = (tr: Tr, b: PermBehavior): string => tr(b === 'allow' ? 'labels.perm.allow' : b === 'allow_always' ? 'labels.perm.always' : 'labels.perm.deny');

/** ⌥n → answer. Permission: 1 allow · 2 allow always (only when offered) · 3 deny (U2: no recommendation). */
export function keyAnswer(tr: Tr, c: CardView, n: number): { label: string; answer: CardAnswer } | null {
  if (c.kind === 'permission') {
    if (n === 1) return { label: permLabel(tr, 'allow'), answer: { behavior: 'allow' } };
    if (n === 2 && c.canAllowAlways) return { label: permLabel(tr, 'allow_always'), answer: { behavior: 'allow_always' } };
    if (n === 3) return { label: permLabel(tr, 'deny'), answer: { behavior: 'deny' } };
    return null;
  }
  if (c.kind !== 'ask') return null;
  const o = orderedOptions(c)[n - 1];
  return o ? { label: o.label, answer: { option: o.label } } : null;
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}
const realTimers: Timers = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: id => clearTimeout(id as never) };

const UNDO_MS = 5000;
interface Pending { label: string; answer: CardAnswer; deadline: number; timer: unknown }

/** §6.4 / §6.15: "Đã chọn … · Hoàn tác (5)" — the answer leaves only after 5 s. */
export class UndoQueue {
  private items = new Map<number, Pending>();
  private listeners = new Set<() => void>();
  constructor(private send: (a: { id: number; answer: CardAnswer }) => void, private t: Timers = realTimers) {}

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const fn of this.listeners) fn(); }

  choose(id: number, label: string, answer: CardAnswer) {
    const old = this.items.get(id);
    if (old) this.t.clearTimeout(old.timer);
    const timer = this.t.setTimeout(() => {
      this.items.delete(id);
      this.send({ id, answer });
      this.emit();
    }, UNDO_MS);
    this.items.set(id, { label, answer, deadline: this.t.now() + UNDO_MS, timer });
    this.emit();
  }

  undo(id: number) {
    const p = this.items.get(id);
    if (!p) return;
    this.t.clearTimeout(p.timer);
    this.items.delete(id);
    this.emit();
  }

  get(id: number): { label: string } | undefined { return this.items.get(id); }
  ids(): Set<number> { return new Set(this.items.keys()); }
  /** whole seconds left, rounded up (5 … 1) */
  remaining(id: number): number {
    const p = this.items.get(id);
    return p ? Math.max(0, Math.ceil((p.deadline - this.t.now()) / 1000)) : 0;
  }
}

/** U1: ignore clicks on cards for 1 s after the card list moved. */
export class ClickGuard {
  private last = -Infinity;
  constructor(private now: () => number = Date.now, private ms = 1000) {}
  shifted() { this.last = this.now(); }
  allow() { return this.now() - this.last >= this.ms; }
  /** `fn` that does nothing while the guard holds. */
  wrap<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void { return (...a) => { if (this.allow()) fn(...a); }; }
}
