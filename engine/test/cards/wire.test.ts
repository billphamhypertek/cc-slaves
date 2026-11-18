import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore, type SystemPayload } from '../../src/cards/store.ts';
import { attachSystemCards, CLAUDE_VERSION_KEY } from '../../src/cards/wire.ts';
import { getMeta, insertProject, openDb, setMeta, type Db } from '../../src/db.ts';
import type { LaneUiEvent, LaneView } from '../../src/lane/manager.ts';
import type { OrchestratorEvent, OrchestratorView } from '../../src/orchestrator/session.ts';

let tmp: string;
let db: Db;
let store: CardStore;
let laneL: ((e: LaneUiEvent) => void)[];
let orchL: ((e: OrchestratorEvent) => void)[];
const lanes = { on: (f: (e: LaneUiEvent) => void) => { laneL.push(f); } };
const orchs = { on: (f: (e: OrchestratorEvent) => void) => { orchL.push(f); } };
const laneEv = (e: LaneUiEvent) => { for (const f of laneL) f(e); };
const orchEv = (e: OrchestratorEvent) => { for (const f of orchL) f(e); };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-wire-'));
  db = openDb(join(tmp, 'state.db'));
  insertProject(db, { id: 'p1', name: 'hagenta', path: join(tmp, 'p1') });
  store = new CardStore({ db, sessions: { writeControl: () => false, askOpen: () => {}, askClose: () => {}, deliver: () => {} } });
  laneL = [];
  orchL = [];
  attachSystemCards(store, db, { lanes, orchestrators: orchs });
});
afterEach(() => {
  store.shutdown();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const lane = (state: LaneView['state'], lastError: string | null = null): LaneView => ({
  projectId: 'p1', name: 'D2', laneId: 1, sessionId: 's-d2', cwd: '/wt', state, account: 'a@x', phase: null, failCount: 3,
  lastError, openCards: [], switchPending: false, sawAssistant: true, costUsd: null, alive: false, turnStartedAt: null, contextPct: null, waitReason: null, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
});
const orch = (state: OrchestratorView['state']): OrchestratorView => ({
  projectId: 'p1', sessionId: 's-o', state, account: 'o@x', home: 'o@x', deaths: 2, lastError: null, alive: true, contextPct: null, talkingTo: null, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
});
const open = () => store.list({ status: 'open' });
const actions = (id: number) => (store.get(id)!.payload as SystemPayload).actions.map((a) => a.action);

describe('system cards (§6.11 F11, §6.16 F16, §6.17 F17, lane Hỏng) — g2-review IMPORTANT-6', () => {
  test('§6.11 F11 system_card orchestrator_down → red card with Khởi động lại / Phiên mới; running again → resolved', () => {
    orchEv({ type: 'system_card', kind: 'orchestrator_down', projectId: 'p1', sessionId: 's-o', reason: 'claude thoát (mã 1)' });
    orchEv({ type: 'system_card', kind: 'orchestrator_down', projectId: 'p1', sessionId: 's-o', reason: 'lần nữa' });
    const [c, ...rest] = open();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ kind: 'orchestrator_down', projectId: 'p1', sessionId: 's-o', payload: { title: 'Điều phối hagenta ngừng', body: 'claude thoát (mã 1)' } });
    expect(actions(c!.id)).toEqual(['restart_orchestrator', 'new_orchestrator']);
    orchEv({ type: 'orchestrator', orchestrator: orch('starting') });
    expect(store.get(c!.id)!.status).toBe('open');
    orchEv({ type: 'orchestrator', orchestrator: orch('running') });
    expect(store.get(c!.id)!.status).toBe('answered');
  });

  test('§6.7 F7 lane broken → card with Chạy lại (lane_resume), Xem log, Giao điều phối xử lý; leaving broken → resolved', () => {
    laneEv({ type: 'lane', lane: lane('running') });
    expect(open()).toEqual([]);
    laneEv({ type: 'lane', lane: lane('broken', 'claude thoát (mã 1) khi chưa xong lượt') });
    laneEv({ type: 'lane', lane: lane('broken', 'claude thoát (mã 1) khi chưa xong lượt') });
    const [c, ...rest] = open();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ kind: 'broken', projectId: 'p1', sessionId: 's-d2', payload: { title: 'Lane D2 hỏng', body: 'claude thoát (mã 1) khi chưa xong lượt' } });
    expect((store.get(c!.id)!.payload as SystemPayload).actions).toEqual([
      { label: 'Chạy lại', action: 'lane_resume', args: { projectId: 'p1', name: 'D2' }, labelKey: 'cardText.act.resume' },
      { label: 'Xem log', action: 'view_log', labelKey: 'cardText.act.viewLog' },
      { label: 'Giao điều phối xử lý', action: 'hand_to_orchestrator', args: { projectId: 'p1', name: 'D2' }, labelKey: 'cardText.act.handToOrch' },
    ]);
    laneEv({ type: 'lane', lane: lane('starting') });
    expect(store.get(c!.id)!.status).toBe('answered');
  });

  test('v2 §6 F16 account_logged_out (lane or orchestrator) → one account card "ba@ đã đăng xuất" with Đăng nhập lại (account_relogin)', () => {
    laneEv({ type: 'account_logged_out', projectId: 'p1', name: 'D2', account: 'dev@x.test' });
    orchEv({ type: 'account_logged_out', projectId: 'p1', account: 'dev@x.test' });
    const [c, ...rest] = open();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ kind: 'logged_out', projectId: null, payload: { title: 'dev@ đã đăng xuất', key: 'dev@x.test' } });
    expect(actions(c!.id)).toEqual(['account_relogin']);
  });

  test('§6.17 F17 first version seen is the baseline (no card); a different version → cc_updated card + stored', () => {
    laneEv({ type: 'claude_version', version: '2.1.325', ok: true });
    expect(open()).toEqual([]);
    expect(getMeta(db, CLAUDE_VERSION_KEY)).toBe('2.1.325');
    laneEv({ type: 'claude_version', version: '2.1.325', ok: true });
    expect(open()).toEqual([]);
    orchEv({ type: 'claude_version', version: '2.1.330', ok: true });
    const [c, ...rest] = open();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ kind: 'cc_updated', payload: { title: 'Claude Code đã lên 2.1.330 — đã kiểm tra tương thích', key: '2.1.330' } });
    expect(getMeta(db, CLAUDE_VERSION_KEY)).toBe('2.1.330');
  });

  test('§6.17 F17 a version that fails the check → cc_updated card with the reason, not stored as checked', () => {
    setMeta(db, CLAUDE_VERSION_KEY, '2.1.325');
    laneEv({ type: 'claude_version', version: '2.1.300', ok: false, message: 'claude 2.1.300 cũ hơn 2.1.325' });
    const [c] = open();
    expect(c).toMatchObject({ kind: 'cc_updated', payload: { title: 'Claude Code 2.1.300 không qua kiểm tra tương thích', body: 'claude 2.1.300 cũ hơn 2.1.325' } });
    expect((c!.payload as SystemPayload).actions.map((a) => a.action)).toEqual(['setup_check', 'dismiss']);
    expect(getMeta(db, CLAUDE_VERSION_KEY)).toBe('2.1.325');
  });
});
