// v2.1 §4.11b left column as pure logic: what "Đang xem" shows (selection), Esc "lên một cấp", breadcrumb, the composer
// target, the Chờ PO one-line form (Q, "Đã xử lý n ▸") and the narrow-window drawer (§4.10). No React / DOM.
import type { CardView, LaneView, ProjectView, Snapshot, SubagentView, Target } from '../../../shared/protocol.ts';
import { isPending } from './cards.ts';
import { laneRunning } from './labels.ts';
import { shortEmail } from './format.ts';
import type { Tr } from './i18n.tsx';

/** What the Inspector shows. A new kind goes here, in `selUp`, `composerTarget`, `crumbs` and a body in `Inspector.tsx`. */
export type Selection =
  | { k: 'orch' }
  /** `subsFirst`: opened from a "+n" node — the Subagent section comes first (N2-l). */
  | { k: 'lane'; name: string; subsFirst?: boolean }
  | { k: 'sub'; lane: string; taskId: string }
  | { k: 'account'; email: string }
  /** v2.1 §4.14 an ended session, read-only (N5-e); the viewed running session is kept aside for Esc. */
  | { k: 'session'; sessionId: string }
  /** v2.1 §4.15 §3 "Điều phối #n › Xong · 41" (N6-e) and one done lane, read-only (N6-f). */
  | { k: 'doneList' } | { k: 'doneLane'; name: string };

export const ORCH: Selection = { k: 'orch' };

/** v2.2 UX F-I8 (S4 / S4-narrow): the lane facts (Worktree, Lỗi liên tiếp, Account, Hoạt động) fold to one summary line
 *  in the 424 px drawer or while the lane runs, so the stream keeps the room; folded ≠ removed (a click opens them). */
export const factsFolded = (narrow: boolean, state: LaneView['state']): boolean => narrow || laneRunning(state);

/** v2.4 R43 I3 a short left column (`#left` < 620 px = window − 44 − 28 − 2 × 12; or the 1024 drawer): the lane block keeps the
 *  conversation ≥ 160 px — one subagent row (failed, then running first) + "+n subagent"; `open` (that click) = the list. */
export const SHORT_Q = '(max-height: 715px)';
/** N2-l failed subs first, then running, then completed. */
export const subRank = (s: SubagentView) => (s.status === 'failed' ? 0 : s.status === 'running' ? 1 : 2);
export function shortSubs(subs: SubagentView[], short: boolean, open: boolean): { shown: SubagentView[]; more: number } {
  if (!short || open || subs.length < 2) return { shown: subs, more: 0 };
  return { shown: [...subs].sort((x, y) => subRank(x) - subRank(y)).slice(0, 1), more: subs.length - 1 };
}

/** §4.11 Esc "Đang xem lên một cấp": sub → lane → Điều phối; account → Điều phối; an ended session → the running session
 *  viewed before (§4.14); Điều phối = top (null). */
export function selUp(s: Selection): Selection | null {
  switch (s.k) {
    case 'sub': return { k: 'lane', name: s.lane };
    case 'doneLane': return { k: 'doneList' }; // §4.15 §3 Esc: done lane → list → Điều phối
    case 'lane': case 'account': case 'session': case 'doneList': return ORCH;
    case 'orch': return null;
  }
}

/** The lane a selection belongs to (lane or a sub of it), else null. */
export const selLane = (s: Selection): string | null => (s.k === 'lane' || s.k === 'doneLane' ? s.name : s.k === 'sub' ? s.lane : null);
/** §4.15 §3 a done lane opens its read-only block (Esc → the done list), any other lane the lane block. */
export const laneSel = (l: Pick<LaneView, 'name' | 'state'>): Selection => (l.state === 'done' ? { k: 'doneLane', name: l.name } : { k: 'lane', name: l.name });

/** §4.11b composer target: orchestrator / account → the viewed session (`sessionId`, always sent once known — §4.14
 *  MINOR-3); an ended session → that session (watch / history only, no composer); lane → lane; sub → its parent lane. */
export function composerTarget(s: Selection, projectId: string, sessionId: string | null): Target {
  const l = selLane(s);
  if (l) return { kind: 'lane', projectId, name: l };
  const sid = s.k === 'session' ? s.sessionId : sessionId;
  return sid ? { kind: 'orchestrator', projectId, sessionId: sid } : { kind: 'orchestrator', projectId };
}

/** v2.3 §4.3 the composer's one target, computed once (App → Inspector prop): a "Nhờ …" override wins; else Đang xem —
 *  a done lane / the done list (read only, §4.15 §3) and a lane that vanished talk to Điều phối. */
export function composerFor(s: Selection, projectId: string, sessionId: string | null, lanes: readonly Pick<LaneView, 'name'>[], override: Target | null): Target {
  if (override) return override;
  const l = selLane(s);
  const back = s.k === 'doneList' || s.k === 'doneLane' || (l !== null && !lanes.some(x => x.name === l));
  return composerTarget(back ? ORCH : s, projectId, sessionId);
}

/** v2.3 §4.3 `pick(sel)`: every PO choice of Đang xem sets it and drops the "Nhờ …" override. */
export interface SelState { sel: Selection; override: Target | null }
export const applyPick = (s: SelState, a: Selection | ((cur: Selection) => Selection)): SelState =>
  ({ sel: typeof a === 'function' ? a(s.sel) : a, override: null });

/** v2.3 §4.3 / V12 "Nhờ …" (Git asks, C8 "Nhắn D15…"): the composer aims at `who` (null = back to Đang xem's);
 *  Đang xem (`sel`) never moves. The same state back when nothing changes (no re-render). */
export const askFor = (s: SelState, who: Target | null): SelState => (s.override === who ? s : { sel: s.sel, override: who });

/** §4.11b breadcrumb: "Điều phối › D2 › tests", "Account › acc11@"; §4.14 the ended session's own crumb is drawn by its
 *  body ("Lịch sử phiên › #2 · tên"). `root` = the viewed session's name ("Điều phối #4"). */
export function crumbs(s: Selection, tr: Tr, subs: Record<string, SubagentView[] | undefined>, root = tr('common.role.orchestrator')): string[] {
  switch (s.k) {
    case 'orch': return [root];
    case 'lane': return [root, s.name];
    case 'sub': return [root, s.lane, subs[s.lane]?.find(x => x.taskId === s.taskId)?.subagentType ?? 'sub'];
    case 'account': return [tr('inspector.account'), shortEmail(s.email)];
    case 'session': return [tr('session.crumbHist')];
    case 'doneList': return [root, tr('done.crumb')];
    case 'doneLane': return [root, tr('done.crumb'), s.name];
  }
}

/** §4.15 §4 a notification click (S5: the app got focus): project, the node to select, its tree to open, the card to
 *  focus in Chờ PO, and whether the Xong shelf shows its merged rows ("lane xong" has no card). */
export interface FocusPlan { projectId: string | null; sel: Selection | null; cardId: number | null; expand: string | null; openDone: boolean }
export function focusPlan(t: { cardId: number | null; projectId: string | null; lane: string | null }, snap: Snapshot): FocusPlan {
  const c = t.cardId !== null ? snap.cards.find(x => x.id === t.cardId) ?? null : null;
  const projectId = t.projectId ?? c?.projectId ?? null;
  const l = t.lane && projectId ? snap.lanes.find(x => x.projectId === projectId && x.name === t.lane) : undefined;
  const sel = l ? laneSel(l) : c ? cardSel(c, snap.lanes.filter(x => x.projectId === projectId).map(x => x.name)) : projectId ? ORCH : null;
  return { projectId, sel, cardId: c?.id ?? null, expand: l && l.state !== 'done' ? l.ownerSession ?? null : null, openDone: l?.state === 'done' };
}

/** §4.11 a card clicked in Chờ PO also selects its lane / Điều phối; system cards (account, update…) leave Đang xem as is. */
export function cardSel(c: CardView, laneNames: readonly string[]): Selection | null {
  if (c.kind === 'orchestrator_down' || c.source === 'orchestrator') return ORCH;
  return c.source && laneNames.includes(c.source) ? { k: 'lane', name: c.source } : null;
}

// ---------------------------------------------------------------- Chờ PO (§4.11b)
export interface InboxFold { folded: boolean; resolvedOpen: boolean }
/** One line when nothing is pending (an answered card stays pending through its 5 s undo, so the block only folds after
 *  it is sent — N1-k), or when the PO folded it (Q / "˄"); full when cards wait, or "Đã xử lý n ▸" is open. */
export function inboxMode(s: InboxFold & { cards: CardView[] }): 'full' | 'line' {
  if (s.folded) return 'line';
  return s.cards.some(isPending) || (s.resolvedOpen && s.cards.length > 0) ? 'full' : 'line';
}
/** §4.11 Q: full → one line; one line → full (0 pending: opens the answered cards). */
export function inboxToggle(s: InboxFold, cards: CardView[]): InboxFold {
  if (inboxMode({ ...s, cards }) === 'full') return { folded: true, resolvedOpen: false };
  return { folded: false, resolvedOpen: !cards.some(isPending) };
}

// ---------------------------------------------------------------- narrow drawer (§4.10)
export type DrawerEvent = 'node' | 'card' | 'focus' | 'button' | 'esc';
/** §4.10: below 1280 px the column is one drawer, closed by default; a node click, a new card or ⌘L opens it, the
 *  "Chờ PO n" button toggles it, Esc closes it. Wide windows have no drawer. */
export function drawerNext(open: boolean, e: DrawerEvent, narrow: boolean): boolean {
  if (!narrow) return false;
  if (e === 'esc') return false;
  if (e === 'button') return !open;
  return true;
}

/** Hot fix 2026-11-16 a held project's band in the Điều phối box: why nothing runs, and its one button. */
export function heldBand(tr: Tr, held: NonNullable<ProjectView['held']>): { text: string; button: string } {
  return held.kind === 'resume'
    ? { text: tr('inspector.held.resume', { sessions: held.sessions, lanes: held.lanes }), button: tr('inspector.held.resumeBtn') }
    : { text: tr('inspector.held.start'), button: tr('inspector.held.startBtn') };
}
/** The composer's placeholder while the project is held (sending resumes it, engine side). */
export const heldPlaceholder = (tr: Tr, held: NonNullable<ProjectView['held']>): string =>
  tr(held.kind === 'resume' ? 'console.ph.heldResume' : 'console.ph.heldStart');
