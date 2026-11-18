// CardStore (spec §6.4 F4, §6.15 F15, §6.7/§6.11/§6.16/§6.17 system cards, §6.0 U1/U2, §3.3-13/14, §7.7 po_ask):
// every card in the "Chờ PO" box lives in the `card` table. Ids are global and increasing (`#12`), lists are oldest
// first. States: open → answered | cancelled | expired. An ask answer goes to the asking session as an outbox
// message; a permission answer is a `control_response` on that session's stdin — never an outbox message.
import type { Db } from '../db.ts';
import { KeyedError, type Msg } from '../errors.ts';
import { hasKey, keyedText, makeT, t, type Key, type Params } from '../../../shared/i18n/index.ts';
import { isOrchSource, ORCH_SOURCE, type KeyedReason } from '../../../shared/protocol.ts';
import type { Lang } from '../../../shared/i18n/index.ts';

export { ORCH_SOURCE };
/** §6A a card `source` as shown in `lang`: the orchestrator → its role name, a lane name as is. */
export const sourceText = (lang: Lang, s: string): string => (isOrchSource(s) ? t(lang, 'common.role.orchestrator') : s);
/** `params` with `{source}` shown in `lang` (titles rendered by the engine: vi title, notify, Google Chat). */
export const withSource = (lang: Lang, p: Params | undefined): Params | undefined =>
  (p && typeof p.source === 'string' ? { ...p, source: sourceText(lang, p.source) } : p);
import { cardAnswer, type Draft } from '../outbox.ts';
import type { CanUseToolEvent } from '../stream/parser.ts';
import { allowLine, denyLine } from '../stream/writer.ts';

export type CardKind = 'ask' | 'permission' | 'broken' | 'orchestrator_down' | 'logged_out' | 'cc_updated' | 'shared_cfg' | 'shared_cfg_new' | 'account_orphan' | 'cutover' | 'mcp_login' | 'issues_new' | 'superpowers_off' | 'revert_conflict';
export type SystemCardKind = Exclude<CardKind, 'ask' | 'permission'>;
export type CardStatus = 'open' | 'answered' | 'cancelled' | 'expired';
const SYSTEM_KINDS: readonly CardKind[] = ['broken', 'orchestrator_down', 'logged_out', 'cc_updated', 'shared_cfg', 'shared_cfg_new', 'account_orphan', 'cutover', 'mcp_login', 'issues_new', 'superpowers_off', 'revert_conflict'];

export interface AskOption { label: string; description?: string }
export interface AskPayload {
  source: string; question: string; options: AskOption[]; recommended: string | null; context: string | null;
}
export interface PermissionPayload {
  source: string; title: string; toolName: string; input: Record<string, unknown>; description: string | null;
  suggestions: unknown[]; allowAlways: boolean;
}
/** A button on a system card; `action` is data the UI sends back (e.g. `lane_resume`, `account_relogin`). */
export interface SystemAction { label: string; action: string; args?: Record<string, unknown>; labelKey?: Key; labelParams?: Params }
/**
 * §6A `title` / `body` / action `label` = the Vietnamese text (fallback for old rows / an older UI); the `*Key` + params
 * render in `ui.lang`. A body without `bodyKey` is engine / Claude text (an error, a reason) and is shown as sent.
 */
export interface SystemPayload {
  title: string; body: string | null; actions: SystemAction[]; key: string | null; titleKey?: Key; params?: Params;
  bodyKey?: Key; bodyParams?: Params; bodyInner?: KeyedReason;
}
/** §6A a system-card button: the vi `label` comes from the catalog, `labelKey` lets the UI render it in `ui.lang`. */
export const act = (labelKey: Key, action: string, args?: Record<string, unknown>): SystemAction =>
  ({ label: t('vi', labelKey), action, ...(args ? { args } : {}), labelKey });
/** §6A a catalog card body: the stored `body` is the vi text, `bodyKey` + `bodyParams` render in `ui.lang`. */
export interface KeyedBody { body: string; bodyKey: Key; bodyParams?: Params }
export const keyedBody = (bodyKey: Key, bodyParams?: Params): KeyedBody =>
  ({ body: t('vi', bodyKey, bodyParams), bodyKey, ...(bodyParams ? { bodyParams } : {}) });

export interface Card {
  id: number; kind: CardKind; projectId: string | null; sessionId: string | null; requestId: string | null;
  status: CardStatus; payload: AskPayload | PermissionPayload | SystemPayload; answer: unknown; createdAt: number;
  resolvedAt: number | null;
}

type AskAnswer = { option?: string; other?: string; note?: string };
type PermissionAnswer = { behavior: 'allow' | 'allow_always' | 'deny'; reason?: string };
export type CardAnswer = AskAnswer | PermissionAnswer;

export type CardEvent = { type: 'card_created'; card: Card } | { type: 'card_updated'; card: Card };

export type CardErrorCode = 'no_card' | 'answered' | 'cancelled' | 'expired' | 'bad_answer' | 'bad_input';
export class CardError extends KeyedError {
  declare readonly code: CardErrorCode;
  constructor(code: CardErrorCode, m: Msg) { super(code, m); this.name = 'CardError'; }
}

/** What the store needs from the session side (LaneManager for lanes, the orchestrator for its own session). */
export interface CardSessions {
  /** Raw control line to the session's live process; false when it has none (request is then dead). */
  writeControl(sessionId: string, line: string): boolean;
  /** `po_ask` opened / closed on this session (lane: reducer ask_open / ask_close → waiting_po). */
  askOpen(sessionId: string, cardId: number): void;
  askClose(sessionId: string, cardId: number): void;
  /** Deliver an engine message to the session through its outbox. */
  deliver(sessionId: string, draft: Draft): void | Promise<void>;
}

export interface Timers { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export const PERMISSION_TTL_S = 30 * 60;
export const EXPIRE_TEXT = 'PO chưa trả lời trong 30 phút';
const DENY_DEFAULT = 'PO từ chối';
const MAX_OPTIONS = 4;

export interface CardStoreDeps {
  db: Db;
  sessions: CardSessions;
  timers?: Timers;
  /** Epoch seconds. */
  now?: () => number;
}

interface Row {
  id: number; project_id: string | null; session_id: string | null; kind: CardKind; request_id: string | null;
  payload: string; status: CardStatus; answer: string | null; created_at: number; resolved_at: number | null;
}

/**
 * v2 §7: a v1 row (real DBs keep them) whose button opened CC Switch reads back as `account_relogin`; a v1 logged_out
 * card also gets the v2 title, so no text sends the PO to CC Switch. Read-time only: the row itself is not rewritten.
 */
function upgradeV1(kind: CardKind, payload: Card['payload']): Card['payload'] {
  const p = payload as Partial<SystemPayload>;
  if (!Array.isArray(p.actions) || !p.actions.some((a) => a.action === 'open_ccswitch')) return payload;
  const actions = p.actions.map((a) => (a.action === 'open_ccswitch' ? act('cardText.act.relogin', 'account_relogin') : a));
  if (kind === 'logged_out' && p.key) {
    const params = { who: `${p.key.split('@')[0]}@` };
    return { ...(p as SystemPayload), title: t('vi', 'cards.loggedOut', params), titleKey: 'cards.loggedOut', params, actions };
  }
  return { ...(p as SystemPayload), title: p.title ?? '', actions };
}

type BodyIn = { bodyKey?: Key; bodyParams?: Params; bodyInner?: KeyedReason };
const bodyKeyOf = (o: BodyIn) =>
  (o.bodyKey ? { bodyKey: o.bodyKey, ...(o.bodyParams ? { bodyParams: o.bodyParams } : {}), ...(o.bodyInner ? { bodyInner: o.bodyInner } : {}) } : {});
const viBody = (o: BodyIn & { body?: string | null }): string | null =>
  // unknown key → `t` (throws in tests, the key in prod), as before
  (o.bodyKey ? keyedText(makeT('vi'), { key: o.bodyKey, params: o.bodyParams, inner: o.bodyInner }) ?? t('vi', o.bodyKey, o.bodyParams) : o.body ?? null);

/** §6A a card body from an engine reason: keyed (vi body rebuilt from the catalog) when the key is known, else the text. */
export function reasonBody(text: string | null, keyed: KeyedReason | null | undefined): BodyIn & { body?: string | null } {
  if (!keyed || !hasKey('vi', keyed.key)) return { body: text };
  return { bodyKey: keyed.key as Key, ...(keyed.params ? { bodyParams: keyed.params } : {}), ...(keyed.inner ? { bodyInner: keyed.inner } : {}) };
}

const toCard = (r: Row): Card => ({
  id: r.id, kind: r.kind, projectId: r.project_id, sessionId: r.session_id, requestId: r.request_id, status: r.status,
  payload: upgradeV1(r.kind, JSON.parse(r.payload) as Card['payload']), answer: r.answer === null ? null : JSON.parse(r.answer) as unknown,
  createdAt: r.created_at, resolvedAt: r.resolved_at,
});

/** §6.4: the recommended option first with the "Đề xuất" flag (U2: permission / system cards have none). */
export function displayOptions(c: Card): (AskOption & { recommended: boolean })[] {
  if (c.kind !== 'ask') return [];
  const p = c.payload as AskPayload;
  const all = p.options.map((o) => ({ ...o, recommended: o.label === p.recommended }));
  return [...all.filter((o) => o.recommended), ...all.filter((o) => !o.recommended)];
}

const MAIN_INPUT_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'description'];

/** §6.15 "D2 xin chạy: Bash `rm -rf build/`": tool name + the main input (full input under "Xem thêm"). */
function permissionTitle(source: string, toolName: string, input: Record<string, unknown>, description: string | null): string {
  const k = permissionTitleKey(source, toolName, input, description);
  return t('vi', k.titleKey, withSource('vi', k.params));
}

/** §6A the permission title as a catalog key + params (the view renders it in `ui.lang`). */
export function permissionTitleKey(source: string, toolName: string, input: Record<string, unknown>, description: string | null): { titleKey: Key; params: Params } {
  const key = MAIN_INPUT_KEYS.find((k) => typeof input[k] === 'string' && (input[k]).trim() !== '');
  let main = key ? (input[key] as string) : (description ?? '');
  main = main.replace(/\s+/g, ' ').trim();
  if (main.length > 120) main = `${main.slice(0, 119)}…`;
  return main ? { titleKey: 'cards.permission', params: { source, tool: toolName, main } } : { titleKey: 'cards.permissionBare', params: { source, tool: toolName } };
}

export class CardStore {
  private readonly listeners: ((e: CardEvent) => void)[] = [];
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly expiry = new Map<number, unknown>();

  constructor(private readonly d: CardStoreDeps) {
    this.timers = d.timers ?? realTimers;
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  on(f: (e: CardEvent) => void): void { this.listeners.push(f); }

  get(id: number): Card | null {
    const r = this.d.db.query<Row, [number]>('SELECT * FROM card WHERE id = ?').get(id);
    return r ? toCard(r) : null;
  }

  /** §6.0 U1: oldest first. */
  list(f: { status?: CardStatus; projectId?: string; sessionId?: string } = {}): Card[] {
    const where: string[] = [];
    const args: string[] = [];
    if (f.status) { where.push('status = ?'); args.push(f.status); }
    if (f.projectId) { where.push('project_id = ?'); args.push(f.projectId); }
    if (f.sessionId) { where.push('session_id = ?'); args.push(f.sessionId); }
    const sql = `SELECT * FROM card${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
    return this.d.db.query<Row, string[]>(sql).all(...args).map(toCard);
  }

  // ---------- ask (po_ask) ----------

  ask(o: {
    projectId: string; sessionId: string; source: string; question: string; options: AskOption[];
    recommended?: string | undefined; context?: string | undefined;
  }): Card {
    const question = o.question.trim();
    if (!question) throw new CardError('bad_input', 'Câu hỏi trống');
    if (o.options.length > MAX_OPTIONS) throw new CardError('bad_input', `Tối đa ${MAX_OPTIONS} phương án`);
    const options = o.options.map((x) => {
      const label = x.label.trim();
      if (!label) throw new CardError('bad_input', 'Phương án không có nhãn');
      return x.description?.trim() ? { label, description: x.description.trim() } : { label };
    });
    if (new Set(options.map((x) => x.label)).size !== options.length) throw new CardError('bad_input', 'Nhãn phương án bị trùng');
    const rec = o.recommended?.trim() || null;
    if (rec !== null && !options.some((x) => x.label === rec)) {
      throw new CardError('bad_input', `Phương án Đề xuất "${rec}" không có trong danh sách`);
    }
    const payload: AskPayload = { source: o.source, question, options, recommended: rec, context: o.context?.trim() || null };
    const card = this.insert('ask', o.projectId, o.sessionId, null, payload);
    this.emit({ type: 'card_created', card });
    this.d.sessions.askOpen(o.sessionId, card.id);
    return card;
  }

  // ---------- permission (control_request can_use_tool) ----------

  permission(o: { projectId: string; sessionId: string; source: string; event: CanUseToolEvent }): Card {
    const e = o.event;
    const dup = this.d.db.query<Row, [string, string]>(
      "SELECT * FROM card WHERE session_id = ? AND request_id = ? AND kind = 'permission'").get(o.sessionId, e.requestId);
    if (dup) return toCard(dup);
    const payload: PermissionPayload = {
      source: o.source, title: permissionTitle(o.source, e.toolName, e.input, e.description), toolName: e.toolName,
      input: e.input, description: e.description, suggestions: e.permissionSuggestions,
      allowAlways: e.permissionSuggestions.length > 0,
    };
    const card = this.insert('permission', o.projectId, o.sessionId, e.requestId, payload);
    this.expiry.set(card.id, this.timers.set(() => this.expire(card.id), PERMISSION_TTL_S * 1000));
    this.emit({ type: 'card_created', card });
    return card;
  }

  /** §3.3-14 `control_cancel_request` for a pending permission. */
  cancelRequest(sessionId: string, requestId: string): void {
    const r = this.d.db.query<{ id: number }, [string, string]>(
      "SELECT id FROM card WHERE session_id = ? AND request_id = ? AND kind = 'permission' AND status = 'open'").get(sessionId, requestId);
    if (r) this.close(r.id, 'cancelled', null);
  }

  /** The session's process is gone: its pending permission requests can never be answered (§6.15 "đã huỷ"). */
  cancelSession(sessionId: string): void {
    for (const c of this.list({ status: 'open', sessionId })) if (c.kind === 'permission') this.close(c.id, 'cancelled', null);
  }

  /** v2.1 §4.14 a session ended for good: its pending PO asks expire (the answer has nowhere to go). Returns their ids. */
  expireAsks(sessionId: string): number[] {
    const ids: number[] = [];
    for (const c of this.list({ status: 'open', sessionId })) if (c.kind === 'ask') { this.close(c.id, 'expired', null); ids.push(c.id); }
    return ids;
  }

  /** Engine start: no process from before survives, so every open permission card is dead. */
  cancelOrphanPermissions(): void {
    for (const c of this.list({ status: 'open' })) if (c.kind === 'permission') this.close(c.id, 'cancelled', null);
  }

  // ---------- answer ----------

  async answer(id: number, a: CardAnswer): Promise<Card> {
    const c = this.get(id);
    if (!c) throw new CardError('no_card', { key: 'errors.noCard', params: { id } });
    if (c.kind === 'permission' && c.status === 'open' && this.now() >= c.createdAt + PERMISSION_TTL_S) this.expire(id);
    const cur = this.get(id)!;
    if (cur.status !== 'open') throw new CardError(cur.status, { key: `errors.card_${cur.status}`, params: { id } });
    if (cur.kind === 'ask') return this.answerAsk(cur, a);
    if (cur.kind === 'permission') return this.answerPermission(cur, a);
    throw new CardError('bad_answer', { key: 'errors.systemCardUseButtons', params: { id } });
  }

  private async answerAsk(c: Card, a: CardAnswer): Promise<Card> {
    if ('behavior' in a) throw new CardError('bad_answer', { key: 'errors.askNoBehavior' });
    const p = c.payload as AskPayload;
    const option = a.option?.trim() || undefined;
    const other = a.other?.trim() || undefined;
    if ((option === undefined) === (other === undefined)) throw new CardError('bad_answer', { key: 'errors.askPickOne' });
    if (option !== undefined && !p.options.some((x) => x.label === option)) {
      throw new CardError('bad_answer', { key: 'errors.noOption', params: { option: String(option) } });
    }
    const note = a.note?.trim() || undefined;
    const answer = { ...(option !== undefined ? { option } : { other }), ...(note ? { note } : {}) };
    const done = this.close(c.id, 'answered', answer);
    this.d.sessions.askClose(c.sessionId!, c.id);
    await this.d.sessions.deliver(c.sessionId!, cardAnswer(c.id, (option ?? other)!, note));
    return done;
  }

  private async answerPermission(c: Card, a: CardAnswer): Promise<Card> {
    if (!('behavior' in a)) throw new CardError('bad_answer', { key: 'errors.permNeedsBehavior' });
    const p = c.payload as PermissionPayload;
    let line: string;
    if (a.behavior === 'allow') line = allowLine(c.requestId!, p.input);
    else if (a.behavior === 'allow_always') {
      if (!p.allowAlways) throw new CardError('bad_answer', { key: 'errors.noAllowAlways' });
      line = allowLine(c.requestId!, p.input, p.suggestions);
    } else line = denyLine(c.requestId!, a.reason?.trim() || DENY_DEFAULT);
    if (!this.d.sessions.writeControl(c.sessionId!, line)) {
      this.close(c.id, 'cancelled', null);
      throw new CardError('cancelled', { key: 'errors.card_cancelled', params: { id: c.id } });
    }
    const answer = a.behavior === 'deny' ? { behavior: 'deny', reason: a.reason?.trim() || DENY_DEFAULT } : { behavior: a.behavior };
    return this.close(c.id, 'answered', answer);
  }

  private expire(id: number): void {
    const c = this.get(id);
    if (!c || c.status !== 'open') return;
    this.d.sessions.writeControl(c.sessionId!, denyLine(c.requestId!, EXPIRE_TEXT));
    this.close(id, 'expired', { behavior: 'deny', reason: EXPIRE_TEXT });
  }

  // ---------- system cards ----------

  /** One open card per (kind, key, project): a second create returns the open one. */
  createSystem(o: {
    kind: SystemCardKind; titleKey: Key; params?: Params; actions: SystemAction[]; projectId?: string | null; sessionId?: string | null;
    key?: string | null; body?: string | null; bodyKey?: Key; bodyParams?: Params; bodyInner?: KeyedReason;
  }): Card {
    if (!SYSTEM_KINDS.includes(o.kind)) throw new CardError('bad_input', `Loại thẻ hệ thống không hợp lệ: ${o.kind}`);
    const open = this.findOpenSystem(o.kind, o.key ?? null, o.projectId ?? null);
    if (open) return open;
    // §6A: the vi text is built from the catalog (throws in tests on an unknown key / missing param)
    const payload: SystemPayload = {
      title: t('vi', o.titleKey, o.params), body: viBody(o), actions: o.actions,
      key: o.key ?? null, titleKey: o.titleKey, ...(o.params ? { params: o.params } : {}), ...bodyKeyOf(o),
    };
    const card = this.insert(o.kind, o.projectId ?? null, o.sessionId ?? null, null, payload);
    this.emit({ type: 'card_created', card });
    return card;
  }

  /** G4 UX I3: refresh an open system card (A9 body after a dry run). Unchanged or closed → no write, no event. */
  updateSystem(id: number, o: { body: string | null; bodyKey?: Key; bodyParams?: Params; actions: SystemAction[]; params?: Params }): Card {
    const c = this.get(id);
    if (!c) throw new CardError('no_card', { key: 'errors.noCard', params: { id } });
    if (c.status !== 'open' || !SYSTEM_KINDS.includes(c.kind)) return c;
    const { bodyKey: _k, bodyParams: _p, bodyInner: _i, ...old } = c.payload as SystemPayload;
    const payload: SystemPayload = { ...old, body: o.bodyKey ? viBody(o) : o.body, actions: o.actions, ...bodyKeyOf(o) };
    if (o.params && old.titleKey) { payload.params = o.params; payload.title = t('vi', old.titleKey, o.params); } // §7.1-3 cutover n
    if (JSON.stringify(payload) === JSON.stringify(c.payload)) return c;
    const r = this.d.db.query<Row, [string, number]>("UPDATE card SET payload = ? WHERE id = ? AND status = 'open' RETURNING *").get(JSON.stringify(payload), id);
    if (!r) return this.get(id)!;
    const card = toCard(r);
    this.emit({ type: 'card_updated', card });
    return card;
  }

  findOpenSystem(kind: SystemCardKind, key: string | null, projectId: string | null = null): Card | null {
    return this.list({ status: 'open' }).find((c) => c.kind === kind && c.projectId === projectId &&
      (c.payload as SystemPayload).key === key) ?? null;
  }

  /** The PO pressed an action, or the condition cleared (`action` omitted). */
  resolveSystem(id: number, action?: string): Card {
    const c = this.get(id);
    if (!c) throw new CardError('no_card', { key: 'errors.noCard', params: { id } });
    if (!SYSTEM_KINDS.includes(c.kind)) throw new CardError('bad_input', { key: 'errors.notSystemCard', params: { id } });
    if (c.status !== 'open') return c;
    return this.close(id, 'answered', action === undefined ? null : { action });
  }

  /** Re-publish a card whose row was changed outside the store (LaneManager mark_cards_cancelled). */
  sync(id: number): void {
    const c = this.get(id);
    if (!c || c.status === 'open') return;
    if (this.published.get(id) === c.status) return;
    this.clearExpiry(id);
    this.emit({ type: 'card_updated', card: c });
  }

  shutdown(): void {
    for (const id of [...this.expiry.keys()]) this.clearExpiry(id);
  }

  // ---------- internals ----------

  private readonly published = new Map<number, CardStatus>();

  private insert(kind: CardKind, projectId: string | null, sessionId: string | null, requestId: string | null, payload: unknown): Card {
    const r = this.d.db.query<Row, [string | null, string | null, CardKind, string | null, string, number]>(
      'INSERT INTO card (project_id, session_id, kind, request_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
    ).get(projectId, sessionId, kind, requestId, JSON.stringify(payload), this.now())!;
    return toCard(r);
  }

  private close(id: number, status: Exclude<CardStatus, 'open'>, answer: unknown): Card {
    const r = this.d.db.query<Row, [string, string | null, number, number]>(
      "UPDATE card SET status = ?, answer = ?, resolved_at = ? WHERE id = ? AND status = 'open' RETURNING *",
    ).get(status, answer === null ? null : JSON.stringify(answer), this.now(), id);
    this.clearExpiry(id);
    if (!r) return this.get(id)!;
    const card = toCard(r);
    this.emit({ type: 'card_updated', card });
    return card;
  }

  private clearExpiry(id: number): void {
    const h = this.expiry.get(id);
    if (h !== undefined) { this.timers.clear(h); this.expiry.delete(id); }
  }

  private emit(e: CardEvent): void {
    if (e.type === 'card_updated') this.published.set(e.card.id, e.card.status);
    for (const f of this.listeners) f(e);
  }
}
