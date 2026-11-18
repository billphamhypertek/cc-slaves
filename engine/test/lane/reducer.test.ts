import { describe, expect, test } from 'bun:test';
import type { LaneState } from '../../src/db.ts';
import {
  RETRY_DELAYS_S, drainText, newLaneCtx, reduce, setPhaseDone, type LaneCtx, type LaneEffect, type LaneEvent,
} from '../../src/lane/reducer.ts';

const PM = 'pm@example.net';
const B24 = 'bo24990@example.com';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

const base = (state: LaneState, o: Partial<LaneCtx> = {}): LaneCtx =>
  deepFreeze({
    ...newLaneCtx({ id: 'l1', name: 'D2', sessionId: 'sess-1', account: PM }),
    sawAssistant: true, state, openCards: state === 'waiting_po' ? [12] : [], ...o,
  });

const types = (e: LaneEffect[]) => e.map((x) => x.type);
const run = (ctx: LaneCtx, ...events: LaneEvent[]) => {
  let c = ctx;
  const all: LaneEffect[] = [];
  for (const ev of events) { const r = reduce(c, ev); c = deepFreeze(r.ctx); all.push(...r.effects); }
  return { ctx: c, effects: all };
};
const of = <T extends LaneEffect['type']>(e: LaneEffect[], t: T) => e.filter((x) => x.type === t) as Extract<LaneEffect, { type: T }>[];

/** §7.4 the ten lane states, in spec order; `satisfies` + the check below keep it aligned with db `LaneState`. */
const LANE_STATES = [
  'starting', 'running', 'idle', 'waiting_po', 'switching', 'waiting_quota', 'draining', 'stopped', 'broken', 'done', 'paused',
] as const satisfies readonly LaneState[];
const _all: Exclude<LaneState, (typeof LANE_STATES)[number]> extends never ? true : never = true;
void _all;

// ── One case per §7.4 table cell. `null` = "—" (no-op: same ctx object, no effects). ────────────────────────────
type Col =
  | 'init_ok' | 'result_ok' | 'limit_or_cap' | 'auth_error' | 'abnormal_error' | 'message' | 'ask_open' | 'ask_close'
  | 'stop_drain' | 'stop_now' | 'lane_finish' | 'lane_resume';
const EV: Record<Col, LaneEvent> = {
  init_ok: { type: 'init_ok' },
  result_ok: { type: 'result_ok', summary: 'xong task 3' },
  limit_or_cap: { type: 'limit_or_cap' },
  auth_error: { type: 'auth_error' },
  abnormal_error: { type: 'abnormal_error', text: 'boom' },
  message: { type: 'message', text: 'tiếp đi', from: 'po' },
  ask_open: { type: 'ask_open', cardId: 13 },
  ask_close: { type: 'ask_close', cardId: 12 },
  stop_drain: { type: 'stop_drain', date: '2026-11-14' },
  stop_now: { type: 'stop_now' },
  lane_finish: { type: 'lane_finish' },
  lane_resume: { type: 'lane_resume' },
};
type Cell = null | [LaneState, LaneEffect['type'][]] | [LaneState, LaneEffect['type'][], Partial<LaneCtx>];
const NOOP_ROW = (): Record<Col, Cell> => Object.fromEntries(Object.keys(EV).map((k) => [k, null])) as Record<Col, Cell>;

const TABLE: Record<LaneState, Record<Col, Cell>> = {
  starting: {
    ...NOOP_ROW(),
    init_ok: ['running', ['flush_outbox']],
    limit_or_cap: ['starting', ['close_stdin', 'pick_account']],
    auth_error: ['starting', ['account_logged_out', 'close_stdin', 'pick_account']],
    abnormal_error: ['starting', ['kill', 'schedule_retry']],
    message: ['starting', ['enqueue_outbox']],
    stop_drain: ['stopped', ['kill']],
    stop_now: ['stopped', ['kill']],
  },
  running: {
    ...NOOP_ROW(),
    result_ok: ['idle', ['notify_orchestrator']],
    limit_or_cap: ['switching', ['interrupt', 'close_stdin', 'pick_account']],
    auth_error: ['switching', ['account_logged_out', 'interrupt', 'close_stdin', 'pick_account']],
    abnormal_error: ['starting', ['kill', 'schedule_retry']],
    message: ['running', ['write_stdin']],
    ask_open: ['running', ['mark_card']],
    ask_close: ['running', ['mark_card'], { openCards: [12] }],
    stop_drain: ['draining', ['write_stdin']],
    stop_now: ['stopped', ['kill']],
    lane_finish: ['running', ['error']],
  },
  idle: {
    ...NOOP_ROW(),
    limit_or_cap: ['idle', []],
    auth_error: ['switching', ['account_logged_out', 'close_stdin', 'pick_account']],
    message: ['idle', ['check_cap_before_write']],
    ask_open: ['waiting_po', ['mark_card', 'notify_orchestrator']],
    stop_drain: ['draining', ['write_stdin']],
    stop_now: ['stopped', ['close_stdin']],
    lane_finish: ['done', ['close_stdin']],
  },
  waiting_po: {
    ...NOOP_ROW(),
    limit_or_cap: ['waiting_po', []],
    auth_error: ['switching', ['account_logged_out', 'close_stdin', 'pick_account']],
    message: ['waiting_po', ['check_cap_before_write']],
    ask_open: ['waiting_po', ['mark_card']],
    ask_close: ['idle', ['mark_card', 'notify_orchestrator']],
    stop_drain: ['draining', ['write_stdin']],
    stop_now: ['stopped', ['close_stdin']],
    lane_finish: ['waiting_po', ['error']],
  },
  switching: {
    ...NOOP_ROW(),
    init_ok: ['running', ['flush_outbox']],
    limit_or_cap: ['switching', ['close_stdin', 'pick_account']],
    abnormal_error: ['starting', ['kill', 'schedule_retry']],
    message: ['switching', ['enqueue_outbox']],
    stop_drain: ['stopped', ['kill']],
    stop_now: ['stopped', ['kill']],
  },
  waiting_quota: {
    ...NOOP_ROW(),
    message: ['waiting_quota', ['enqueue_outbox']],
    stop_drain: ['stopped', []],
    stop_now: ['stopped', []],
  },
  draining: {
    ...NOOP_ROW(),
    result_ok: ['stopped', ['close_stdin']],
    limit_or_cap: ['switching', ['interrupt', 'close_stdin', 'pick_account']],
    auth_error: ['switching', ['account_logged_out', 'interrupt', 'close_stdin', 'pick_account']],
    abnormal_error: ['starting', ['kill', 'schedule_retry']],
    message: ['draining', ['enqueue_outbox']],
    stop_now: ['stopped', ['kill']],
  },
  stopped: {
    ...NOOP_ROW(),
    message: ['stopped', ['enqueue_outbox', 'remind_po']],
    lane_finish: ['done', []],
    lane_resume: ['starting', ['pick_account']],
  },
  broken: {
    ...NOOP_ROW(),
    message: ['broken', ['enqueue_outbox', 'remind_po']],
    lane_finish: ['done', []],
    lane_resume: ['starting', ['pick_account']],
  },
  done: NOOP_ROW(),
  // hotfix 2026-11-16 H4 held: nothing runs; a message waits in the outbox; stop / finish need no process (H1)
  paused: {
    ...NOOP_ROW(),
    message: ['paused', ['enqueue_outbox']],
    stop_drain: ['stopped', []],
    stop_now: ['stopped', []],
    lane_finish: ['done', []],
  },
};

test('hf1116 H1 lane_finish on a paused lane with an open ask: refused without force, force cancels the card', () => {
  const ctx = base('paused', { openCards: [12] });
  expect(reduce(ctx, { type: 'lane_finish' }).effects.map((x) => x.type)).toEqual(['error']);
  const r = reduce(ctx, { type: 'lane_finish', force: true });
  expect(r.ctx.state).toBe('done');
  expect(r.effects).toEqual([{ type: 'mark_cards_cancelled', cardIds: [12] }]);
});

describe('§7.4 table — one case per cell', () => {
  for (const state of LANE_STATES) {
    for (const col of Object.keys(EV) as Col[]) {
      const cell = TABLE[state][col];
      const label = cell === null ? '— (no-op)' : `→ ${cell[0]} [${cell[1].join(', ')}]`;
      test(`§7.4 row ${state} × col ${col}: ${label}`, () => {
        const ctx = base(state, cell?.[2] ?? {});
        const r = reduce(ctx, EV[col]);
        if (cell === null) {
          expect(r.effects).toEqual([]);
          expect(r.ctx).toBe(ctx);
          return;
        }
        expect(r.ctx.state).toBe(cell[0]);
        expect(types(r.effects)).toEqual(cell[1]);
      });
    }
  }
});

describe('§7.4 error counter', () => {
  test('§7.4 1st, 2nd abnormal error → retry after 20 s, 60 s then resume; 3rd → broken', () => {
    expect(RETRY_DELAYS_S).toEqual([20, 60]);
    let r = run(base('running'), { type: 'abnormal_error' });
    expect(r.ctx.failCount).toBe(1);
    expect(of(r.effects, 'schedule_retry')).toEqual([{ type: 'schedule_retry', seconds: 20 }]);
    r = run(r.ctx, { type: 'retry_timer' });
    expect(r.effects).toEqual([{ type: 'spawn', mode: 'resume', sessionId: 'sess-1', account: PM }]);
    expect(r.ctx.state).toBe('starting');
    r = run(r.ctx, { type: 'init_ok' }, { type: 'abnormal_error' });
    expect(r.ctx.failCount).toBe(2);
    expect(of(r.effects, 'schedule_retry')).toEqual([{ type: 'schedule_retry', seconds: 60 }]);
    r = run(r.ctx, { type: 'retry_timer' }, { type: 'init_ok' }, { type: 'abnormal_error', text: 'boom' });
    expect(r.ctx.state).toBe('broken');
    expect(r.ctx.failCount).toBe(3);
    expect(of(r.effects, 'schedule_retry')).toEqual([]);
    expect(of(r.effects, 'error')[0]!.code).toBe('lane_broken');
    expect(r.ctx.lastError).toBe('boom');
  });

  test('§7.4 counter resets to 0 on each result ok', () => {
    let r = run(base('running'), { type: 'abnormal_error' }, { type: 'retry_timer' }, { type: 'init_ok' });
    r = run(r.ctx, { type: 'abnormal_error' }, { type: 'retry_timer' }, { type: 'init_ok' }, { type: 'result_ok' });
    expect(r.ctx.failCount).toBe(0);
    r = run(r.ctx, { type: 'message', text: 'x', from: 'po' }, { type: 'cap_checked', ok: true }, { type: 'abnormal_error' });
    expect(r.ctx.failCount).toBe(1);
    expect(r.ctx.state).toBe('starting');
  });

  test('§7.4/§6.16 auth error does not count — while running nor while switching', () => {
    let r = run(base('running', { failCount: 2 }), { type: 'auth_error' });
    expect(r.ctx.failCount).toBe(2);
    r = run(r.ctx, { type: 'auth_error' });
    expect(r.ctx.failCount).toBe(2);
    expect(r.ctx.state).toBe('switching');
  });

  test('§7.4 retry_timer without a pending retry is a no-op', () => {
    for (const s of LANE_STATES) {
      const ctx = base(s);
      const r = reduce(ctx, { type: 'retry_timer' });
      expect(r.ctx).toBe(ctx);
      expect(r.effects).toEqual([]);
    }
  });

  test('§7.4 stop during a retry wait cancels the retry', () => {
    const r = run(base('running'), { type: 'abnormal_error' }, { type: 'stop_now' }, { type: 'retry_timer' });
    expect(r.ctx.state).toBe('stopped');
    expect(of(r.effects, 'spawn')).toEqual([]);
  });
});

describe('§7.4 resume vs restart', () => {
  test('§7.4 resume only when a first assistant message was seen; else fresh with the same session id', () => {
    const fresh = run(base('starting', { sawAssistant: false }), { type: 'abnormal_error' }, { type: 'retry_timer' });
    expect(of(fresh.effects, 'spawn')).toEqual([{ type: 'spawn', mode: 'fresh', sessionId: 'sess-1', account: PM }]);
    const seen = run(base('starting', { sawAssistant: false }), { type: 'assistant_seen' }, { type: 'abnormal_error' },
      { type: 'retry_timer' });
    expect(of(seen.effects, 'spawn')[0]!.mode).toBe('resume');
  });

  test('§7.4 switch: pick_result spawns on the new account (resume/fresh by first assistant)', () => {
    const r = run(base('running'), { type: 'limit_or_cap' });
    expect(of(r.effects, 'interrupt')).toEqual([{ type: 'interrupt', waitResultS: 10 }]);
    expect(of(r.effects, 'pick_account')).toEqual([{ type: 'pick_account', exclude: [PM] }]);
    const s = run(r.ctx, { type: 'pick_result', to: B24 });
    expect(s.effects).toEqual([{ type: 'spawn', mode: 'resume', sessionId: 'sess-1', account: B24 }]);
    expect(s.ctx.account).toBe(B24);
    const f = run(base('starting', { sawAssistant: false }), { type: 'limit_or_cap' }, { type: 'pick_result', to: B24 });
    expect(of(f.effects, 'spawn')[0]).toEqual({ type: 'spawn', mode: 'fresh', sessionId: 'sess-1', account: B24 });
  });

  test('§7.4 switching: next limit excludes every account already tried; none left → waiting_quota', () => {
    let r = run(base('running'), { type: 'limit_or_cap' }, { type: 'pick_result', to: B24 }, { type: 'limit_or_cap' });
    expect(of(r.effects, 'pick_account').at(-1)).toEqual({ type: 'pick_account', exclude: [PM, B24] });
    r = run(r.ctx, { type: 'pick_result', to: null });
    expect(r.ctx.state).toBe('waiting_quota');
    r = run(r.ctx, { type: 'quota_freed', account: PM });
    expect(r.ctx.state).toBe('starting');
    expect(r.effects).toEqual([{ type: 'spawn', mode: 'resume', sessionId: 'sess-1', account: PM }]);
    r = run(r.ctx, { type: 'init_ok' });
    expect(r.ctx.tried).toEqual([]);
  });

  test('§7.4 quota_freed and pick_result outside their states are no-ops', () => {
    for (const s of LANE_STATES) {
      const ctx = base(s);
      if (s !== 'waiting_quota') expect(reduce(ctx, { type: 'quota_freed', account: B24 }).ctx).toBe(ctx);
      if (s !== 'starting' && s !== 'switching') expect(reduce(ctx, { type: 'pick_result', to: B24 }).ctx).toBe(ctx);
    }
  });

  test('§7.4 lane_resume from stopped/broken resets the counter and resumes the same session', () => {
    const r = run(base('broken', { failCount: 3 }), { type: 'lane_resume' }, { type: 'pick_result', to: PM });
    expect(r.ctx.failCount).toBe(0);
    expect(of(r.effects, 'spawn')[0]).toEqual({ type: 'spawn', mode: 'resume', sessionId: 'sess-1', account: PM });
  });
});

describe('§7.4 self-started turn (§3.3-20)', () => {
  test('§7.4 idle → running; its result (even empty) → idle as a result ok', () => {
    let r = run(base('idle', { sawAssistant: false }), { type: 'self_started_turn' });
    expect(r.ctx.state).toBe('running');
    expect(r.ctx.sawAssistant).toBe(true);
    r = run(r.ctx, { type: 'result_ok' });
    expect(r.ctx.state).toBe('idle');
    expect(of(r.effects, 'notify_orchestrator')).toEqual([{ type: 'notify_orchestrator', text: '[cc-slaves] lane D2 rảnh: ' }]);
  });

  test('§7.4 waiting_po → running; result → back to waiting_po while a card is open', () => {
    const r = run(base('waiting_po'), { type: 'self_started_turn' }, { type: 'result_ok' });
    expect(r.ctx.state).toBe('waiting_po');
    expect(of(r.effects, 'notify_orchestrator')[0]!.text).toBe('[cc-slaves] lane D2 chờ PO #12');
  });

  test('§7.4 self_started_turn is a no-op outside idle / waiting_po', () => {
    for (const s of LANE_STATES.filter((x) => x !== 'idle' && x !== 'waiting_po')) {
      const ctx = base(s);
      expect(reduce(ctx, { type: 'self_started_turn' }).ctx).toBe(ctx);
    }
  });
});

describe('§7.4 messages, notifications, cards', () => {
  test('§3.4 I3 message to idle: cap check before write → write_stdin → running', () => {
    let r = run(base('idle'), { type: 'message', text: 'a', from: 'po' });
    expect(r.effects).toEqual([{ type: 'check_cap_before_write', account: PM }]);
    r = run(r.ctx, { type: 'message', text: 'b', from: 'orchestrator' });
    expect(r.effects).toEqual([]);
    r = run(r.ctx, { type: 'cap_checked', ok: true });
    expect(r.ctx.state).toBe('running');
    expect(r.effects).toEqual([{ type: 'write_stdin', text: 'a' }, { type: 'write_stdin', text: 'b' }]);
    expect(r.ctx.pendingWrite).toEqual([]);
  });

  test('§10.2 a lane message carries `send` (prefix, uuid, attachments, echoed) through every path: running, cap check, halted, spill', () => {
    const send = { prefix: '', extra: { uuid: 'u-1', echoed: true } };
    const m = { type: 'message' as const, text: '/compact', from: 'po' as const, send };
    expect(run(base('running'), m).effects).toEqual([{ type: 'write_stdin', text: '/compact', send }]);
    const idle = run(base('idle'), m);
    expect(run(idle.ctx, { type: 'cap_checked', ok: true }).effects).toEqual([{ type: 'write_stdin', text: '/compact', send }]);
    expect(of(run(idle.ctx, { type: 'cap_checked', ok: false }).effects, 'enqueue_outbox')).toEqual([{ type: 'enqueue_outbox', text: '/compact', send }]);
    expect(of(run(base('stopped'), m).effects, 'enqueue_outbox')).toEqual([{ type: 'enqueue_outbox', text: '/compact', send }]);
    expect(of(run(base('starting'), m).effects, 'enqueue_outbox')).toEqual([{ type: 'enqueue_outbox', text: '/compact', send }]);
  });

  test('§3.4 I3 cap check fails → message queued, lane switches', () => {
    const r = run(base('idle'), { type: 'message', text: 'a', from: 'po' }, { type: 'cap_checked', ok: false });
    expect(r.ctx.state).toBe('switching');
    expect(types(r.effects)).toEqual(['check_cap_before_write', 'enqueue_outbox', 'close_stdin', 'pick_account']);
    expect(of(r.effects, 'enqueue_outbox')[0]!.text).toBe('a');
  });

  test('§7.4 idle × limit: switch before the next message', () => {
    const r = run(base('idle'), { type: 'limit_or_cap' }, { type: 'message', text: 'a', from: 'po' });
    expect(r.ctx.state).toBe('switching');
    expect(types(r.effects)).toEqual(['enqueue_outbox', 'close_stdin', 'pick_account']);
    expect(r.ctx.switchPending).toBe(false);
  });

  test('§7.4 stop while a cap check is in flight queues the message in the outbox', () => {
    const r = run(base('idle'), { type: 'message', text: 'a', from: 'po' }, { type: 'stop_now' }, { type: 'cap_checked', ok: true });
    expect(of(r.effects, 'enqueue_outbox')).toEqual([{ type: 'enqueue_outbox', text: 'a' }]);
    expect(of(r.effects, 'write_stdin')).toEqual([]);
  });

  test('§7.4 stopped/broken + message → queue + reminder with a "Chạy lại" action', () => {
    const r = run(base('stopped'), { type: 'message', text: 'a', from: 'po' });
    expect(r.effects).toEqual([
      { type: 'enqueue_outbox', text: 'a' },
      { type: 'remind_po', text: 'D2 đã dừng — tin sẽ gửi khi Chạy lại', key: 'notify.laneStoppedQueued', params: { name: 'D2' }, action: { label: 'Chạy lại', event: 'lane_resume' } },
    ]);
  });

  test('§7.4 idle notification carries a 300-char summary', () => {
    const long = 'x'.repeat(400);
    const r = run(base('running'), { type: 'result_ok', summary: long });
    expect(of(r.effects, 'notify_orchestrator')[0]!.text).toBe(`[cc-slaves] lane D2 rảnh: ${'x'.repeat(300)}`);
  });

  test('§7.4 running × result ok with an open card → waiting_po + "chờ PO #12"', () => {
    const r = run(base('running'), { type: 'ask_open', cardId: 12 }, { type: 'result_ok' });
    expect(r.ctx.state).toBe('waiting_po');
    expect(of(r.effects, 'mark_card')).toEqual([{ type: 'mark_card', cardId: 12, open: true }]);
    expect(of(r.effects, 'notify_orchestrator')).toEqual([{ type: 'notify_orchestrator', text: '[cc-slaves] lane D2 chờ PO #12' }]);
  });

  test('§7.4 waiting_po: closing one of two cards stays; closing all → idle', () => {
    let r = run(base('waiting_po'), { type: 'ask_open', cardId: 13 }, { type: 'ask_close', cardId: 12 });
    expect(r.ctx.state).toBe('waiting_po');
    r = run(r.ctx, { type: 'ask_close', cardId: 13 });
    expect(r.ctx.state).toBe('idle');
  });

  test('§7.4 waiting_po × lane_finish: error unless force; force → cards cancelled → done', () => {
    const e = run(base('waiting_po'), { type: 'lane_finish' });
    expect(of(e.effects, 'error')[0]!.code).toBe('lane_waiting_po');
    const r = run(base('waiting_po'), { type: 'lane_finish', force: true });
    expect(r.ctx.state).toBe('done');
    expect(r.effects).toEqual([{ type: 'mark_cards_cancelled', cardIds: [12] }, { type: 'close_stdin' }]);
  });

  test('§7.4 running × lane_finish → error "đang chạy"', () => {
    expect(of(reduce(base('running'), { type: 'lane_finish', force: true }).effects, 'error')[0]!.code).toBe('lane_running');
  });
});

describe('§8.2 drain', () => {
  test('§8.2 drain message names the handoff path and lane_set_phase note', () => {
    const r = run(base('running'), { type: 'stop_drain', date: '2026-11-14' });
    expect(r.effects).toEqual([{ type: 'write_stdin', text: drainText('D2', '2026-11-14') }]);
    expect(drainText('D2', '2026-11-14')).toContain('.local-check/handoff-2026-11-14/D2.md');
    expect(drainText('D2', '2026-11-14')).toContain("'đã dừng an toàn'");
  });

  test('§8.2 draining interrupted by a limit: after the switch, the drain message is sent again', () => {
    let r = run(base('running'), { type: 'stop_drain', date: '2026-11-14' }, { type: 'limit_or_cap' },
      { type: 'pick_result', to: B24 });
    r = run(r.ctx, { type: 'init_ok' });
    expect(r.ctx.state).toBe('draining');
    expect(r.effects).toEqual([{ type: 'flush_outbox' }, { type: 'write_stdin', text: drainText('D2', '2026-11-14') }]);
    r = run(r.ctx, { type: 'result_ok' });
    expect(r.ctx.state).toBe('stopped');
  });

  test('§8.2 draining interrupted by an abnormal error resumes and drains again', () => {
    const r = run(base('draining', { drainText: 'DRAIN' }), { type: 'abnormal_error' }, { type: 'retry_timer' }, { type: 'init_ok' });
    expect(r.ctx.state).toBe('draining');
    expect(of(r.effects, 'write_stdin')).toEqual([{ type: 'write_stdin', text: 'DRAIN' }]);
  });
});

describe('§7.4 lane_set_phase done', () => {
  test('§7.4 phase=done, unit parks at Merge, orchestrator told; process not closed', () => {
    const ctx = base('idle');
    const r = setPhaseDone(ctx, 'đã dừng an toàn');
    expect(r.ctx.phase).toBe('done');
    expect(r.ctx.state).toBe('idle');
    expect(r.effects).toEqual([
      { type: 'park_unit', zone: 'merge' },
      { type: 'notify_orchestrator', text: '[cc-slaves] lane D2 xong: đã dừng an toàn' },
    ]);
    expect(types(r.effects)).not.toContain('close_stdin');
  });

  test('§7.4 phase done without a note: "[cc-slaves] lane D2 xong"', () => {
    const r = setPhaseDone(base('idle'));
    expect(r.effects).toContainEqual({ type: 'notify_orchestrator', text: '[cc-slaves] lane D2 xong' });
  });

  test('§7.4 notify texts: idle carries ≤300 chars of the result, waiting_po lists the card', () => {
    const idle = reduce({ ...base('running') }, { type: 'result_ok', summary: 'x'.repeat(400) });
    expect(idle.effects).toEqual([{ type: 'notify_orchestrator', text: `[cc-slaves] lane D2 rảnh: ${'x'.repeat(300)}` }]);
    const wpo = reduce({ ...base('running'), openCards: [12] }, { type: 'result_ok', summary: 'ok' });
    expect(wpo.effects).toEqual([{ type: 'notify_orchestrator', text: '[cc-slaves] lane D2 chờ PO #12' }]);
  });
});

test('§7.4 reducer is pure: input ctx is never mutated (deep-frozen inputs throw on write)', () => {
  for (const s of LANE_STATES) for (const ev of Object.values(EV)) expect(() => reduce(base(s), ev)).not.toThrow();
});
