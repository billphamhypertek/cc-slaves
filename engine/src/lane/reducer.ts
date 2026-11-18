// Lane state machine of spec §7.4 (I4, I5) as a pure reducer: reduce(ctx, event) → { ctx, effects }.
// No I/O, no clock: effects are data the lane driver executes in order. Every "—" cell of the table returns the
// same ctx object and no effects.
import { t, type Key, type Params } from '../../../shared/i18n/index.ts';
import type { KeyedReason } from '../../../shared/protocol.ts';
import type { LaneState } from '../db.ts';
import type { SendExtra } from '../outbox.ts';

/** v2.4 §10.2 what a lane message carries past its text: the row prefix ('' = a raw `/` command, §6.6; else null) and
 *  `send`'s uuid / attachments / echoed. */
interface LaneSend { prefix: string | null; extra: SendExtra }
/** One lane message on its way to the outbox. */
interface LaneMsg { text: string; send?: LaneSend }

/** §7.4: 1st and 2nd consecutive abnormal error wait this long, then resume; the 3rd marks the lane broken. */
export const RETRY_DELAYS_S = [20, 60] as const;
const MAX_FAILS = RETRY_DELAYS_S.length + 1;
/** §7.4 "Đang chuyển": after `interrupt`, wait for the turn's `result` this long before closing stdin / SIGTERM. */
const INTERRUPT_WAIT_S = 10;
/** §7.4: the idle notification carries this much of the last result. */
const SUMMARY_MAX = 300;

export interface LaneCtx {
  id: string;
  /** Short lane name shown to the PO and the orchestrator ("D2"). */
  name: string;
  sessionId: string;
  /** Account email the process runs (or will run) on; null = not chosen yet. */
  account: string | null;
  state: LaneState;
  /** Consecutive abnormal errors; 0 after every successful result. */
  failCount: number;
  lastError: string | null;
  /** §6A the catalog key of `lastError` when the engine composed it (exit / start failure); null for Claude's own text. */
  lastErrorKeyed?: KeyedReason | null;
  /** A first assistant message was seen → the session can be resumed; otherwise restart fresh with the same id. */
  sawAssistant: boolean;
  /** Open `po_ask` card ids. */
  openCards: number[];
  /** Limit hit while idle: switch before the next message is written. */
  switchPending: boolean;
  /** A `schedule_retry` is outstanding; `retry_timer` acts only then. */
  retryPending: boolean;
  /** Messages for an idle session waiting on `check_cap_before_write`. */
  pendingWrite: LaneMsg[];
  /** Accounts tried in the current switch (excluded from the next pick). */
  tried: string[];
  /** The drain message must be sent again once the session is back (switch / retry during a drain). */
  drainAfterResume: boolean;
  drainText: string | null;
  lastSummary: string;
  phase: string | null;
}

export type LaneEvent =
  | { type: 'init_ok' }
  | { type: 'result_ok'; summary?: string }
  | { type: 'limit_or_cap' }
  | { type: 'auth_error' }
  | { type: 'abnormal_error'; text?: string; reason?: KeyedReason }
  | { type: 'message'; text: string; from: 'po' | 'orchestrator'; send?: LaneSend }
  | { type: 'ask_open'; cardId: number }
  | { type: 'ask_close'; cardId: number }
  | { type: 'stop_drain'; date: string }
  | { type: 'stop_now' }
  | { type: 'lane_finish'; force?: boolean }
  | { type: 'lane_resume' }
  /** §3.3-20: first assistant/stream_event while idle / waiting_po with no message pending replay (driver decides). */
  | { type: 'self_started_turn' }
  /** Any assistant message: marks the session resumable. */
  | { type: 'assistant_seen' }
  | { type: 'quota_freed'; account: string }
  | { type: 'retry_timer' }
  /** Result of a `pick_account` effect (see switcher.ts `pickToEvent`); null = no account left. */
  | { type: 'pick_result'; to: string | null }
  /** Result of a `check_cap_before_write` effect. */
  | { type: 'cap_checked'; ok: boolean };

export type LaneEffect =
  | ({ type: 'write_stdin' } & LaneMsg)
  | ({ type: 'enqueue_outbox' } & LaneMsg)
  | { type: 'flush_outbox' }
  | { type: 'interrupt'; waitResultS: number }
  | { type: 'close_stdin' }
  | { type: 'kill' }
  | { type: 'pick_account'; exclude: string[] }
  | { type: 'spawn'; mode: 'resume' | 'fresh'; sessionId: string; account: string }
  | { type: 'schedule_retry'; seconds: number }
  | { type: 'notify_orchestrator'; text: string }
  /** §6A `text` = vi fallback; `key` + `params` render in `ui.lang` when the engine shows the toast. */
  | { type: 'remind_po'; text: string; key?: Key; params?: Params; action: { label: string; event: 'lane_resume' } }
  | { type: 'mark_card'; cardId: number; open: boolean }
  | { type: 'mark_cards_cancelled'; cardIds: number[] }
  | { type: 'account_logged_out'; account: string }
  | { type: 'check_cap_before_write'; account: string | null }
  | { type: 'park_unit'; zone: 'merge' }
  | { type: 'error'; code: 'lane_running' | 'lane_waiting_po' | 'lane_broken'; text: string };

export interface Step { ctx: LaneCtx; effects: LaneEffect[] }

export function newLaneCtx(o: { id: string; name: string; sessionId: string; account: string | null }): LaneCtx {
  return {
    ...o, state: 'starting', failCount: 0, lastError: null, lastErrorKeyed: null, sawAssistant: false, openCards: [], switchPending: false,
    retryPending: false, pendingWrite: [], tried: [], drainAfterResume: false, drainText: null, lastSummary: '',
    phase: null,
  };
}

/** §8.2 drain message. */
export function drainText(name: string, date: string): string {
  return `[cc-slaves] Dừng an toàn: không nhận task mới, xong task đang chạy, commit, viết handoff ` +
    `\`.local-check/handoff-${date}/${name}.md\` rồi báo xong (\`lane_set_phase\` với note 'đã dừng an toàn').`;
}

const idleText = (c: LaneCtx) => `[cc-slaves] lane ${c.name} rảnh: ${c.lastSummary.slice(0, SUMMARY_MAX)}`;
const waitingPoText = (c: LaneCtx) => `[cc-slaves] lane ${c.name} chờ PO ${c.openCards.map((id) => `#${id}`).join(', ')}`;

const step = (ctx: LaneCtx, effects: LaneEffect[] = []): Step => ({ ctx, effects });
const noop = (ctx: LaneCtx): Step => ({ ctx, effects: [] });

function spawnOn(c: LaneCtx, account: string): LaneEffect {
  return { type: 'spawn', mode: c.sawAssistant ? 'resume' : 'fresh', sessionId: c.sessionId, account };
}

/** Messages awaiting a cap check go to the outbox when the lane leaves idle/waiting_po another way. */
function spill(c: LaneCtx): [LaneCtx, LaneEffect[]] {
  if (c.pendingWrite.length === 0) return [c, []];
  return [{ ...c, pendingWrite: [] }, c.pendingWrite.map((m) => ({ type: 'enqueue_outbox', ...m }))];
}

function withTried(c: LaneCtx): string[] {
  return c.account === null || c.tried.includes(c.account) ? [...c.tried] : [...c.tried, c.account];
}

/** Leave the current account: interrupt a live turn, close the process, pick another account (§7.4 "Đang chuyển"). */
function leave(c: LaneCtx, o: { state: LaneState; liveTurn: boolean; auth: boolean }, pre: LaneEffect[] = []): Step {
  const tried = withTried(c);
  const effects: LaneEffect[] = [...pre];
  if (o.auth && c.account !== null) effects.push({ type: 'account_logged_out', account: c.account });
  if (o.liveTurn) effects.push({ type: 'interrupt', waitResultS: INTERRUPT_WAIT_S });
  effects.push({ type: 'close_stdin' }, { type: 'pick_account', exclude: tried });
  return step({ ...c, state: o.state, tried, switchPending: false }, effects);
}

function countError(c: LaneCtx, text: string | undefined, reason: KeyedReason | undefined): Step {
  const failCount = c.failCount + 1;
  const lastError = text ?? c.lastError;
  const lastErrorKeyed = text !== undefined ? reason ?? null : c.lastErrorKeyed ?? null;
  if (failCount >= MAX_FAILS) {
    const why = text ? `: ${text}` : '';
    return step({ ...c, state: 'broken', failCount, lastError, lastErrorKeyed, retryPending: false, drainAfterResume: false }, [
      { type: 'kill' },
      { type: 'error', code: 'lane_broken', text: `${c.name} hỏng sau ${failCount} lỗi liên tiếp${why}` },
    ]);
  }
  const drainAfterResume = c.drainAfterResume || c.state === 'draining';
  return step({ ...c, state: 'starting', failCount, lastError, lastErrorKeyed, retryPending: true, drainAfterResume }, [
    { type: 'kill' },
    { type: 'schedule_retry', seconds: RETRY_DELAYS_S[failCount - 1]! },
  ]);
}

const toStopped = (c: LaneCtx): LaneCtx => ({ ...c, state: 'stopped', retryPending: false, drainAfterResume: false, tried: [] });

const LIVE: readonly LaneState[] = ['starting', 'running', 'switching', 'draining'];
const QUIET: readonly LaneState[] = ['idle', 'waiting_po'];
const SPAWNING: readonly LaneState[] = ['starting', 'switching'];
const HALTED: readonly LaneState[] = ['stopped', 'broken'];

export function reduce(c: LaneCtx, e: LaneEvent): Step {
  const s = c.state;
  if (s === 'done') return noop(c);
  switch (e.type) {
    case 'init_ok': {
      if (!SPAWNING.includes(s)) return noop(c);
      const effects: LaneEffect[] = [{ type: 'flush_outbox' }];
      if (c.drainAfterResume && c.drainText !== null) {
        effects.push({ type: 'write_stdin', text: c.drainText });
        return step({ ...c, state: 'draining', tried: [], drainAfterResume: false }, effects);
      }
      return step({ ...c, state: 'running', tried: [] }, effects);
    }

    case 'result_ok': {
      if (s === 'draining') {
        return step({ ...toStopped(c), failCount: 0, sawAssistant: true }, [{ type: 'close_stdin' }]);
      }
      if (s !== 'running') return noop(c);
      const n: LaneCtx = { ...c, failCount: 0, sawAssistant: true, lastSummary: e.summary ?? '' };
      if (n.openCards.length > 0) {
        const w = { ...n, state: 'waiting_po' as const };
        return step(w, [{ type: 'notify_orchestrator', text: waitingPoText(w) }]);
      }
      const i = { ...n, state: 'idle' as const };
      return step(i, [{ type: 'notify_orchestrator', text: idleText(i) }]);
    }

    case 'limit_or_cap':
      if (s === 'running') return leave(c, { state: 'switching', liveTurn: true, auth: false });
      if (s === 'draining') return leave({ ...c, drainAfterResume: true }, { state: 'switching', liveTurn: true, auth: false });
      if (SPAWNING.includes(s)) return leave(c, { state: s, liveTurn: false, auth: false });
      if (QUIET.includes(s)) return c.switchPending ? noop(c) : step({ ...c, switchPending: true });
      return noop(c);

    case 'auth_error':
      // §6.16: switch without counting an error. While already switching: "—".
      if (s === 'starting') return leave(c, { state: 'starting', liveTurn: false, auth: true });
      if (s === 'running') return leave(c, { state: 'switching', liveTurn: true, auth: true });
      if (s === 'draining') return leave({ ...c, drainAfterResume: true }, { state: 'switching', liveTurn: true, auth: true });
      if (QUIET.includes(s)) {
        const [n, pre] = spill(c);
        return leave(n, { state: 'switching', liveTurn: false, auth: true }, pre);
      }
      return noop(c);

    case 'abnormal_error':
      return LIVE.includes(s) ? countError(c, e.text, e.reason) : noop(c);

    case 'message': {
      const m: LaneMsg = e.send ? { text: e.text, send: e.send } : { text: e.text };
      if (s === 'running') return step(c, [{ type: 'write_stdin', ...m }]);
      if (QUIET.includes(s)) {
        if (c.switchPending) {
          const [n, pre] = spill(c);
          return leave(n, { state: 'switching', liveTurn: false, auth: false }, [...pre, { type: 'enqueue_outbox', ...m }]);
        }
        // §3.4 I3: check the account's cap before writing into an idle session.
        if (c.pendingWrite.length > 0) return step({ ...c, pendingWrite: [...c.pendingWrite, m] });
        return step({ ...c, pendingWrite: [m] }, [{ type: 'check_cap_before_write', account: c.account }]);
      }
      if (HALTED.includes(s)) {
        return step(c, [
          { type: 'enqueue_outbox', ...m },
          { type: 'remind_po', text: t('vi', 'notify.laneStoppedQueued', { name: c.name }), key: 'notify.laneStoppedQueued', params: { name: c.name }, action: { label: 'Chạy lại', event: 'lane_resume' } },
        ]);
      }
      return step(c, [{ type: 'enqueue_outbox', ...m }]);
    }

    case 'cap_checked': {
      if (c.pendingWrite.length === 0) return noop(c);
      if (!e.ok) {
        const [n, pre] = spill(c);
        if (QUIET.includes(s)) return leave(n, { state: 'switching', liveTurn: false, auth: false }, pre);
        return step(n, pre);
      }
      const writes: LaneEffect[] = c.pendingWrite.map((m) => ({ type: 'write_stdin', ...m }));
      return step({ ...c, state: 'running', pendingWrite: [] }, writes);
    }

    case 'ask_open': {
      if (s !== 'running' && !QUIET.includes(s)) return noop(c);
      const openCards = c.openCards.includes(e.cardId) ? c.openCards : [...c.openCards, e.cardId];
      const mark: LaneEffect = { type: 'mark_card', cardId: e.cardId, open: true };
      if (s === 'idle') {
        const w: LaneCtx = { ...c, openCards, state: 'waiting_po' };
        return step(w, [mark, { type: 'notify_orchestrator', text: waitingPoText(w) }]);
      }
      return step({ ...c, openCards }, [mark]);
    }

    case 'ask_close': {
      if ((s !== 'running' && s !== 'waiting_po') || !c.openCards.includes(e.cardId)) return noop(c);
      const openCards = c.openCards.filter((id) => id !== e.cardId);
      const mark: LaneEffect = { type: 'mark_card', cardId: e.cardId, open: false };
      if (s === 'waiting_po' && openCards.length === 0) {
        const i: LaneCtx = { ...c, openCards, state: 'idle' };
        return step(i, [mark, { type: 'notify_orchestrator', text: idleText(i) }]);
      }
      return step({ ...c, openCards }, [mark]);
    }

    case 'stop_drain': {
      if (s === 'running' || QUIET.includes(s)) {
        const [n, pre] = spill(c);
        const text = drainText(c.name, e.date);
        return step({ ...n, state: 'draining', drainText: text }, [...pre, { type: 'write_stdin', text }]);
      }
      if (SPAWNING.includes(s)) return step(toStopped(c), [{ type: 'kill' }]);
      if (s === 'waiting_quota' || s === 'paused') return step(toStopped(c)); // hotfix 2026-11-16 held: no turn to drain
      return noop(c);
    }

    case 'stop_now': {
      if (LIVE.includes(s)) return step(toStopped(c), [{ type: 'kill' }]);
      if (QUIET.includes(s)) {
        const [n, pre] = spill(c);
        return step(toStopped(n), [...pre, { type: 'close_stdin' }]);
      }
      if (s === 'waiting_quota' || s === 'paused') return step(toStopped(c));
      return noop(c);
    }

    case 'lane_finish': {
      if (s === 'running') {
        return step(c, [{ type: 'error', code: 'lane_running', text: 'Lane đang chạy — chờ hết lượt hoặc dừng lane trước' }]);
      }
      if (s === 'idle') {
        const [n, pre] = spill(c);
        return step({ ...n, state: 'done' }, [...pre, { type: 'close_stdin' }]);
      }
      if (s === 'waiting_po') {
        if (!e.force) {
          return step(c, [{ type: 'error', code: 'lane_waiting_po', text: 'Lane đang chờ PO — dùng force để huỷ thẻ và kết thúc' }]);
        }
        const [n, pre] = spill(c);
        return step({ ...n, state: 'done', openCards: [] }, [
          ...pre, { type: 'mark_cards_cancelled', cardIds: [...c.openCards] }, { type: 'close_stdin' },
        ]);
      }
      if (HALTED.includes(s)) return step({ ...c, state: 'done' });
      if (s === 'paused') { // hotfix 2026-11-16 held: no process; an open ask still needs `force`, as on waiting_po
        if (c.openCards.length === 0) return step({ ...c, state: 'done' });
        if (!e.force) return step(c, [{ type: 'error', code: 'lane_waiting_po', text: 'Lane đang chờ PO — dùng force để huỷ thẻ và kết thúc' }]);
        return step({ ...c, state: 'done', openCards: [] }, [{ type: 'mark_cards_cancelled', cardIds: [...c.openCards] }]);
      }
      return noop(c);
    }

    case 'lane_resume':
      if (!HALTED.includes(s)) return noop(c);
      return step({ ...c, state: 'starting', failCount: 0, retryPending: false, tried: [] }, [{ type: 'pick_account', exclude: [] }]);

    case 'self_started_turn':
      return QUIET.includes(s) ? step({ ...c, state: 'running', sawAssistant: true }) : noop(c);

    case 'assistant_seen':
      return c.sawAssistant ? noop(c) : step({ ...c, sawAssistant: true });

    case 'quota_freed':
      if (s !== 'waiting_quota') return noop(c);
      return step({ ...c, state: 'starting', account: e.account, tried: [] }, [spawnOn(c, e.account)]);

    case 'retry_timer': {
      if (!c.retryPending || s !== 'starting') return noop(c);
      const n = { ...c, retryPending: false };
      if (c.account === null) return step(n, [{ type: 'pick_account', exclude: [] }]);
      return step(n, [spawnOn(c, c.account)]);
    }

    case 'pick_result':
      if (!SPAWNING.includes(s)) return noop(c);
      if (e.to === null) return step({ ...c, state: 'waiting_quota', tried: [] });
      return step({ ...c, account: e.to }, [spawnOn(c, e.to)]);
  }
}

/** §7.4 `lane_set_phase done`: phase = done, unit parks at Merge, orchestrator told. The process is NOT closed —
 *  the orchestrator calls `lane_finish`. */
export function setPhaseDone(c: LaneCtx, note?: string): Step {
  return step({ ...c, phase: 'done' }, [
    { type: 'park_unit', zone: 'merge' },
    { type: 'notify_orchestrator', text: `[cc-slaves] lane ${c.name} xong${note ? `: ${note}` : ''}` },
  ]);
}
