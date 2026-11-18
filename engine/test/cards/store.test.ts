import { beforeEach, describe, expect, test } from 'bun:test';
import { CardError, CardStore, displayOptions, EXPIRE_TEXT, PERMISSION_TTL_S, type CardEvent, type CardSessions } from '../../src/cards/store.ts';
import { cancelCards, insertProject, openDb, type Db } from '../../src/db.ts';
import type { Draft } from '../../src/outbox.ts';
import type { CanUseToolEvent } from '../../src/stream/parser.ts';
import { rejects } from '../_fixtures/rejects.ts';

class FakeTimers {
  pending: { fn: () => void; ms: number; done: boolean }[] = [];
  set(fn: () => void, ms: number) { const t = { fn, ms, done: false }; this.pending.push(t); return t; }
  clear(h: unknown) { (h as { done: boolean }).done = true; }
  fireAll() { for (const t of this.pending) if (!t.done) { t.done = true; t.fn(); } }
}

class FakeSessions implements CardSessions {
  lines: { sid: string; line: unknown }[] = [];
  opened: [string, number][] = [];
  closed: [string, number][] = [];
  delivered: { sid: string; draft: Draft }[] = [];
  live = true;
  writeControl(sid: string, line: string) { if (!this.live) return false; this.lines.push({ sid, line: JSON.parse(line) }); return true; }
  askOpen(sid: string, id: number) { this.opened.push([sid, id]); }
  askClose(sid: string, id: number) { this.closed.push([sid, id]); }
  deliver(sid: string, draft: Draft) { this.delivered.push({ sid, draft }); }
}

let db: Db;
let s: FakeSessions;
let timers: FakeTimers;
let now: number;
let store: CardStore;
let events: CardEvent[];

beforeEach(() => {
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'P1', path: '/r/p1' });
  s = new FakeSessions();
  timers = new FakeTimers();
  now = 1000;
  store = new CardStore({ db, sessions: s, timers, now: () => now });
  events = [];
  store.on((e) => events.push(e));
});

const ask = (o: Partial<Parameters<CardStore['ask']>[0]> = {}) => store.ask({
  projectId: 'p1', sessionId: 's1', source: 'D2', question: 'Chọn DB?',
  options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'nặng hơn' }], recommended: 'Postgres', ...o,
});

const canUse = (o: Partial<CanUseToolEvent> = {}): CanUseToolEvent => ({
  kind: 'can_use_tool', requestId: 'req-1', toolName: 'Bash', input: { command: 'rm -rf build/' },
  permissionSuggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], toolUseId: 't1',
  description: null, raw: {}, ...o,
});
const perm = (o: Partial<CanUseToolEvent> = {}) =>
  store.permission({ projectId: 'p1', sessionId: 's1', source: 'D2', event: canUse(o) });

describe('CardStore ask (§6.4 F4, §7.7 po_ask)', () => {
  test('§7.7 po_ask creates an open card with a global increasing id and opens the ask on the session', () => {
    const a = ask();
    const b = ask({ sessionId: 's2' });
    expect(b.id).toBe(a.id + 1);
    expect(a.status).toBe('open');
    expect(a.kind).toBe('ask');
    expect(s.opened).toEqual([['s1', a.id], ['s2', b.id]]);
    expect(events.map((e) => e.type)).toEqual(['card_created', 'card_created']);
  });

  test('§6.4 recommended option is shown first with the "Đề xuất" flag; options keep their labels', () => {
    const c = ask();
    expect(displayOptions(c)).toEqual([
      { label: 'Postgres', description: 'nặng hơn', recommended: true },
      { label: 'SQLite', recommended: false },
    ]);
  });

  test('§7.7 po_ask input: >4 options, duplicate labels, unknown recommended are refused', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` }));
    expect(() => ask({ options: five, recommended: undefined })).toThrow(CardError);
    expect(() => ask({ options: [{ label: 'a' }, { label: 'a' }], recommended: undefined })).toThrow(/trùng/);
    expect(() => ask({ recommended: 'MySQL' })).toThrow(/Đề xuất/);
    expect(() => ask({ question: '  ' })).toThrow(CardError);
  });

  test('§6.4 answer with an option → outbox cardAnswer to the asking session, ask closed, state answered', async () => {
    const c = ask();
    const done = await store.answer(c.id, { option: 'SQLite', note: 'cho nhẹ' });
    expect(done.status).toBe('answered');
    expect(s.closed).toEqual([['s1', c.id]]);
    expect(s.delivered).toEqual([{ sid: 's1', draft: { prefix: '[cc-slaves]', text: `PO trả lời #${c.id}: SQLite — cho nhẹ` } }]);
    expect(events.at(-1)).toEqual({ type: 'card_updated', card: done });
  });

  test('§6.4 "Khác…" free text; a 0-option card takes only free text', async () => {
    const c = ask({ options: [], recommended: undefined });
    await rejects(store.answer(c.id, { option: 'x' })).toThrow(CardError);
    await store.answer(c.id, { other: 'tự làm' });
    expect(s.delivered[0]!.draft.text).toBe(`PO trả lời #${c.id}: tự làm`);
  });

  test('§6.4 answer must be exactly one of option / other, and a known option', async () => {
    const c = ask();
    await rejects(store.answer(c.id, {})).toMatchObject({ code: 'bad_answer' });
    await rejects(store.answer(c.id, { option: 'SQLite', other: 'y' })).toMatchObject({ code: 'bad_answer' });
    await rejects(store.answer(c.id, { option: 'MySQL' })).toMatchObject({ code: 'bad_answer' });
    await rejects(store.answer(c.id, { behavior: 'allow' })).toMatchObject({ code: 'bad_answer' });
    expect(store.get(c.id)!.status).toBe('open');
  });

  test('a second answer is refused (answered); unknown id → no_card', async () => {
    const c = ask();
    await store.answer(c.id, { option: 'SQLite' });
    await rejects(store.answer(c.id, { option: 'SQLite' })).toMatchObject({ code: 'answered' });
    await rejects(store.answer(9999, { option: 'SQLite' })).toMatchObject({ code: 'no_card' });
    expect(s.delivered.length).toBe(1);
  });

  test('§6.0 U1 open cards list oldest first across kinds', () => {
    const a = ask();
    now = 2000;
    const p = perm();
    const sys = store.createSystem({ kind: 'cc_updated', titleKey: 'cards.ccUpdatedOk', params: { version: '2.1.330' }, actions: [] });
    expect(store.list({ status: 'open' }).map((c) => c.id)).toEqual([a.id, p.id, sys.id]);
    expect(store.list({ status: 'open', projectId: 'p1' }).map((c) => c.id)).toEqual([a.id, p.id]);
  });

  test('cards cancelled by the lane (mark_cards_cancelled) are re-published on sync', () => {
    const c = ask();
    cancelCards(db, [c.id]);
    store.sync(c.id);
    expect(events.at(-1)).toMatchObject({ type: 'card_updated', card: { id: c.id, status: 'cancelled' } });
    store.sync(c.id);
    expect(events.filter((e) => e.type === 'card_updated').length).toBe(1);
  });
});

describe('CardStore permission (§6.15 F15, §3.3-13/14)', () => {
  test('§6.15 title "<lane> xin chạy: <tool> <main input>", full input kept, allow_always only with suggestions', () => {
    const c = perm();
    expect(c.kind).toBe('permission');
    expect(c.payload).toMatchObject({
      title: 'D2 xin chạy: Bash rm -rf build/', toolName: 'Bash', input: { command: 'rm -rf build/' }, allowAlways: true,
    });
    const w = perm({ requestId: 'req-2', toolName: 'Write', input: { file_path: 's1-c.txt', content: 'x' }, permissionSuggestions: [] });
    expect(w.payload).toMatchObject({ title: 'D2 xin chạy: Write s1-c.txt', allowAlways: false });
    expect(s.opened).toEqual([]); // permission never opens an ask on the lane
  });

  test('§6.0 U2 permission card has no recommended option', () => {
    expect(displayOptions(perm())).toEqual([]);
    expect('recommended' in (perm({ requestId: 'r9' }).payload as object)).toBe(false);
  });

  test('§3.3-13 allow → control_response allow with updatedInput, never an outbox message', async () => {
    const c = perm();
    const done = await store.answer(c.id, { behavior: 'allow' });
    expect(done.status).toBe('answered');
    expect(s.lines).toEqual([{ sid: 's1', line: { type: 'control_response', response: {
      subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { command: 'rm -rf build/' } } } } }]);
    expect(s.delivered).toEqual([]);
  });

  test('§3.3-13 allow_always → updatedPermissions = permission_suggestions; refused when there are none', async () => {
    const c = perm();
    await store.answer(c.id, { behavior: 'allow_always' });
    expect((s.lines[0]!.line as { response: { response: unknown } }).response.response).toEqual({
      behavior: 'allow', updatedInput: { command: 'rm -rf build/' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    const n = perm({ requestId: 'req-2', permissionSuggestions: [] });
    await rejects(store.answer(n.id, { behavior: 'allow_always' })).toMatchObject({ code: 'bad_answer' });
    expect(store.get(n.id)!.status).toBe('open');
  });

  test('§6.15 deny with an optional reason', async () => {
    const a = perm();
    await store.answer(a.id, { behavior: 'deny', reason: 'đừng xoá' });
    const b = perm({ requestId: 'req-2' });
    await store.answer(b.id, { behavior: 'deny' });
    expect(s.lines.map((l) => (l.line as { response: { response: unknown } }).response.response)).toEqual([
      { behavior: 'deny', message: 'đừng xoá' }, { behavior: 'deny', message: 'PO từ chối' },
    ]);
  });

  test('§3.3-14 control_cancel_request → cancelled; a later answer is refused and nothing is written', async () => {
    const c = perm();
    store.cancelRequest('s1', 'req-1');
    expect(store.get(c.id)!.status).toBe('cancelled');
    await rejects(store.answer(c.id, { behavior: 'allow' })).toMatchObject({ code: 'cancelled' });
    expect(s.lines).toEqual([]);
  });

  test('§6.15 session process gone → its open permission cards are cancelled (not its asks)', () => {
    const p = perm();
    const a = ask();
    store.cancelSession('s1');
    expect(store.get(p.id)!.status).toBe('cancelled');
    expect(store.get(a.id)!.status).toBe('open');
  });

  test('§6.15 answer when the process can no longer take it → cancelled, error cancelled', async () => {
    const c = perm();
    s.live = false;
    await rejects(store.answer(c.id, { behavior: 'allow' })).toMatchObject({ code: 'cancelled' });
    expect(store.get(c.id)!.status).toBe('cancelled');
  });

  test('§6.15 expiry 30 min → deny "PO chưa trả lời trong 30 phút", expired; late answer → error expired', async () => {
    const c = perm();
    expect(timers.pending[0]!.ms).toBe(PERMISSION_TTL_S * 1000);
    expect(PERMISSION_TTL_S).toBe(1800);
    timers.fireAll();
    expect(store.get(c.id)!.status).toBe('expired');
    expect((s.lines[0]!.line as { response: { response: unknown } }).response.response).toEqual({ behavior: 'deny', message: EXPIRE_TEXT });
    expect(EXPIRE_TEXT).toBe('PO chưa trả lời trong 30 phút');
    await rejects(store.answer(c.id, { behavior: 'allow' })).toMatchObject({ code: 'expired' });
    expect(s.lines.length).toBe(1);
  });

  test('§6.15 expiry also holds by the clock when the timer is late (Mac asleep)', async () => {
    const c = perm();
    now += PERMISSION_TTL_S;
    await rejects(store.answer(c.id, { behavior: 'allow' })).toMatchObject({ code: 'expired' });
    expect((s.lines[0]!.line as { response: { response: unknown } }).response.response).toEqual({ behavior: 'deny', message: EXPIRE_TEXT });
    timers.fireAll(); // the late timer does nothing more
    expect(s.lines.length).toBe(1);
  });

  test('an answered card clears its expiry timer; the same request id twice gives the same card', async () => {
    const c = perm();
    expect(perm().id).toBe(c.id);
    await store.answer(c.id, { behavior: 'allow' });
    expect(timers.pending.every((t) => t.done)).toBe(true);
  });

  test('cancelOrphanPermissions (engine restart): every open permission card is cancelled', () => {
    const c = perm();
    const fresh = new CardStore({ db, sessions: s, timers, now: () => now });
    fresh.cancelOrphanPermissions();
    expect(fresh.get(c.id)!.status).toBe('cancelled');
  });
});

describe('G4 UX I3 an open system card body / actions can be refreshed', () => {
  test('updateSystem rewrites body + actions of an open card and emits card_updated; a closed card is left alone', () => {
    const c = store.createSystem({ kind: 'shared_cfg', key: 'a@x/plans', titleKey: 'cards.sharedCfgNotLinked', params: { who: 'a@', name: 'plans' }, body: 'old', actions: [{ label: 'Gộp', action: 'shared_cfg_merge' }] });
    const seen: string[] = [];
    store.on((e) => seen.push(e.type));
    const u = store.updateSystem(c.id, { body: 'new', actions: [{ label: 'Xem trùng tên', action: 'shared_cfg_merge' }] });
    expect(u.payload).toMatchObject({ body: 'new', title: 'a@: `plans` chưa nối về `~/.claude`. Tạm ngừng nhận lane.', titleKey: 'cards.sharedCfgNotLinked', key: 'a@x/plans', actions: [{ label: 'Xem trùng tên' }] });
    expect(store.get(c.id)!.payload).toMatchObject({ body: 'new' });
    expect(seen).toEqual(['card_updated']);
    expect(store.updateSystem(c.id, { body: 'new', actions: [{ label: 'Xem trùng tên', action: 'shared_cfg_merge' }] }).id).toBe(c.id);
    expect(seen).toEqual(['card_updated']); // no change → no event
    store.resolveSystem(c.id);
    expect(store.updateSystem(c.id, { body: 'x', actions: [] }).payload).toMatchObject({ body: 'new' });
  });
});

describe('CardStore system cards (§6.7, §6.11, §6.16, §6.17)', () => {
  test('create with actions as data; one open card per kind + key; resolve → answered', () => {
    const b = store.createSystem({
      kind: 'broken', projectId: 'p1', sessionId: 's1', key: 'D2', titleKey: 'cards.laneBroken', params: { name: 'D2' },
      actions: [{ label: 'Chạy lại', action: 'lane_resume', args: { name: 'D2' } }, { label: 'Giao điều phối xử lý', action: 'hand_to_orchestrator' }],
    });
    expect(b.kind).toBe('broken');
    expect(b.payload).toMatchObject({ actions: [{ action: 'lane_resume', args: { name: 'D2' } }, { action: 'hand_to_orchestrator' }] });
    const again = store.createSystem({ kind: 'broken', projectId: 'p1', key: 'D2', titleKey: 'cards.laneBroken', params: { name: 'x' }, actions: [] });
    expect(again.id).toBe(b.id);
    const lo = store.createSystem({ kind: 'logged_out', key: 'dev@x', titleKey: 'cards.loggedOut', params: { who: 'dev@' },
      actions: [{ label: 'Đăng nhập lại', action: 'account_relogin' }] });
    expect(lo.projectId).toBeNull();
    const r = store.resolveSystem(b.id, 'lane_resume');
    expect(r.status).toBe('answered');
    expect(r.answer).toEqual({ action: 'lane_resume' });
    expect(store.findOpenSystem('broken', 'D2', 'p1')).toBeNull();
    expect(store.findOpenSystem('logged_out', 'dev@x')?.id).toBe(lo.id);
  });

  test('v2 §7 a stored v1 card with `open_ccswitch` reads back as `account_relogin` (old rows in real DBs)', () => {
    db.run(`INSERT INTO card (project_id, session_id, kind, request_id, payload, created_at) VALUES (NULL, NULL, 'logged_out', NULL, ?, 1)`,
      [JSON.stringify({ title: 'dev đã đăng xuất trong CC Switch — mở CC Switch để đăng nhập lại', body: null, key: 'dev@x',
        actions: [{ label: 'Mở CC Switch', action: 'open_ccswitch' }, { label: 'Đã xem', action: 'dismiss' }] })]);
    const c = store.findOpenSystem('logged_out', 'dev@x')!;
    expect(c.payload).toEqual({ title: 'dev@ đã đăng xuất', body: null, key: 'dev@x', titleKey: 'cards.loggedOut', params: { who: 'dev@' },
      actions: [{ label: 'Đăng nhập lại', action: 'account_relogin', labelKey: 'cardText.act.relogin' }, { label: 'Đã xem', action: 'dismiss' }] });
    expect(store.get(c.id)!.payload).toEqual(c.payload);
    expect(store.list({ status: 'open' }).find((x) => x.id === c.id)!.payload).toEqual(c.payload);
  });

  test('system card API refuses ask/permission kinds and resolving a non-system card', async () => {
    expect(() => store.createSystem({ kind: 'ask' as never, titleKey: 'cards.laneBroken', params: { name: 'x' }, actions: [] })).toThrow(CardError);
    const a = ask();
    expect(() => store.resolveSystem(a.id)).toThrow(CardError);
    const down = store.createSystem({ kind: 'orchestrator_down', projectId: 'p1', titleKey: 'cards.orchestratorDown', params: { project: 'P1' }, actions: [] });
    await rejects(store.answer(down.id, { option: 'x' })).toMatchObject({ code: 'bad_answer' });
  });
});
