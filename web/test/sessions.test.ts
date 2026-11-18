// v2.1 T10 §4.14 parallel orchestrator sessions as pure logic (lib/sessions.ts): roots, names, chips, dialog defaults,
// the resume choice, the reassign undo and the history rows.
import { describe, expect, test } from 'bun:test';
import type { OrchestratorView, ResumePreview, SessionRowView, SessionsList } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
import {
  cardChip, defaultReceiver, endAsks, estimateText, everMulti, laneSessionLine, nextSeq, openCmd, orchName, parallelFirst,
  reassignBack, resumeDefaults, rowMeta, rowStatus, sessionsOf, viewedSession,
} from '../src/lib/sessions.ts';
import { card, lane, snapshot } from './fixtures.ts';

const VI = makeT('vi');
const orch = (over: Partial<OrchestratorView> = {}): OrchestratorView => ({ projectId: 'p1', state: 'running', account: 'a@x', homeAccount: 'a@x', lastError: null,
  costUsd: 0, contextPct: 41, talkingTo: null, sessionId: 's3', seq: 3, ...over });
const S3 = orch(), S4 = orch({ sessionId: 's4', seq: 4, title: 'hotfix', account: 'c@x' });
const row = (over: Partial<SessionRowView> = {}): SessionRowView => ({ sessionId: 's2', projectId: 'p1', seq: 2, title: 'lot-2', state: 'ended',
  startedAt: 1, endedAt: 2, accountFirst: 'pm@x', accountLast: 'acc07@x', lanes: 2, tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
  costUsd: 19.8, endReason: 'replaced', handoffPath: '/h.md', ctxLast: 142_000, resumable: true, ...over });
const preview = (over: Partial<ResumePreview> = {}): ResumePreview => ({ sessionId: 's2', projectId: 'p1', seq: 2, title: 'lot-2', resumable: true, reason: null,
  ctxLast: 142_000, ctxWindow: 200_000, ctxPct: 71, ctxHigh: false, estimate: { tokens: 142_000, pct: 9, samples: 12 }, account: 'acc33@x', accountLast: 'acc07@x',
  accountReason: null, sinceStop: [], parallelAllowed: true, running: 2, max: 3, handoffPath: '/h.md', expiresInDays: null, cleanupPeriodDays: 30, ...over });

describe('§4.14 Sơ đồ: one root per running session, viewed session, names', () => {
  test('§4.14 sessions of a project in open / resume order (snapshot order); other projects left out', () => {
    const snap = snapshot({ orchestrators: [S3, orch({ projectId: 'p2', sessionId: 'x' }), S4] });
    expect(sessionsOf(snap, 'p1').map(o => o.sessionId)).toEqual(['s3', 's4']);
  });
  test('§4.14 the viewed session: the asked one while it runs, else the first running one', () => {
    expect(viewedSession([S3, S4], 's4')).toBe(S4);
    expect(viewedSession([S3, S4], 'gone')).toBe(S3);
    expect(viewedSession([S3, S4], null)).toBe(S3);
    expect(viewedSession([], 's4')).toBeNull();
  });
  test('§4.14 "Điều phối #n" once the project ever had > 1 session; the first session alone stays "Điều phối"', () => {
    expect(everMulti([orch({ seq: 1 })])).toBe(false);
    expect(everMulti([orch({ seq: 2 })])).toBe(true); // #1 ended: #2 alone still says its number
    expect(everMulti([orch({ seq: 1 }), orch({ seq: 2, sessionId: 's2' })])).toBe(true);
    expect(orchName(VI, orch({ seq: 1 }), false)).toBe('Điều phối');
    expect(orchName(VI, S4, true)).toBe('Điều phối #4');
  });
  test('§4.14 Inspector lane line "Phiên #3 · <tên>" only when > 1 session runs', () => {
    expect(laneSessionLine(VI, lane('D2', { ownerSession: 's4', ownerSeq: 4 }), [S3, S4])).toBe('Phiên #4 · hotfix');
    expect(laneSessionLine(VI, lane('D2', { ownerSession: 's3', ownerSeq: 3 }), [S3, S4])).toBe('Phiên #3');
    expect(laneSessionLine(VI, lane('D2', { ownerSession: 's3', ownerSeq: 3 }), [S3])).toBeNull();
  });
  test('§4.14 Chờ PO chip "#4 · Lane H2" only when > 1 session runs; the engine-sent seq, never inferred', () => {
    expect(cardChip(VI, card(1, { seq: 4 }), 'Lane H2', 2)).toBe('#4 · Lane H2');
    expect(cardChip(VI, card(1, { seq: 4 }), 'Lane H2', 1)).toBe('Lane H2');
    expect(cardChip(VI, card(1, { seq: null }), 'Lane H2', 2)).toBe('Lane H2');
  });
});

describe('§4.14 dialogs: defaults', () => {
  test('§4.14 N5-b next #n = highest seq ever (running + ended) + 1, never reused', () => {
    const list: SessionsList = { running: [row({ sessionId: 's3', seq: 3, state: 'running' })], ended: [row({ seq: 7 })], max: 3 };
    expect(nextSeq(list, [S3])).toBe(8);
    expect(nextSeq(null, [S3, S4])).toBe(5);
  });
  test('§4.14 N5-b default first message text names the new #n and the project', () => {
    expect(parallelFirst(VI, 4, 'hagenta')).toBe('[cc-slaves] Phiên song song #4 của hagenta. Gọi `lanes_list`; chỉ ra lệnh lane của mình.');
  });
  test('§4.14 N5-b the command: blank title / first / auto account are left to the engine', () => {
    expect(openCmd('p1', { title: '  ', first: '', account: null, model: null, effort: null })).toEqual({ cmd: 'session_open', projectId: 'p1' });
    expect(openCmd('p1', { title: ' hotfix ', first: 'Sửa SSO', account: 'c@x', model: null, effort: null })).toEqual({ cmd: 'session_open', projectId: 'p1', title: 'hotfix', first: 'Sửa SSO', account: 'c@x' });
  });
  test('§4.14 N5-k end dialog: default receiver = the earliest running session other than the ending one', () => {
    expect(defaultReceiver([S3, S4], 's4')).toBe('s3');
    expect(defaultReceiver([S3, S4], 's3')).toBe('s4');
    expect(defaultReceiver([S3], 's3')).toBeNull();
  });
  test('§4.14 N5-k the asks that expire: open cards whose source session is the ending one', () => {
    const cards = [card(1, { sessionId: 's4', source: 'H2' }), card(2, { sessionId: 's3' }), card(3, { sessionId: 's4', status: 'answered' })];
    expect(endAsks(cards, 's4').map(c => c.id)).toEqual([1]);
  });
});

describe('§4.14 Chạy tiếp: choice, cap, ≥ 80 %', () => {
  test('§4.14 N5-f default parallel; Thay defaults to the session viewed before history', () => {
    expect(resumeDefaults(preview(), 's4', [S3, S4])).toEqual({ mode: 'parallel', replaceId: 's4', parallelBlocked: false, main: 'resume' });
  });
  test('§4.14 N5-r at the cap: parallel dimmed, replace preselected', () => {
    expect(resumeDefaults(preview({ parallelAllowed: false, running: 3 }), 'gone', [S3, S4])).toEqual({ mode: 'replace', replaceId: 's3', parallelBlocked: true, main: 'resume' });
  });
  test('§4.14 N5-g context ≥ 80 % with a handoff: main button = "Phiên mới từ handoff #n" (resume kept as the second)', () => {
    expect(resumeDefaults(preview({ ctxHigh: true }), 's3', [S3]).main).toBe('handoff');
    expect(resumeDefaults(preview({ ctxHigh: true, handoffPath: null }), 's3', [S3]).main).toBe('resume');
  });
  test('§4.14 first turn estimate: "≈ n % … (ước từ n lần đo)"; < 5 samples → no %', () => {
    expect(estimateText(VI, preview())).toBe('không còn cache: đọc lại 142k tok ≈ 9 % quota 5 giờ của acc33@ (ước từ 12 lần đo)');
    expect(estimateText(VI, preview({ estimate: { tokens: 142_000, pct: null, samples: 3 } }))).toBe('đọc lại 142k tok (chưa đủ số liệu để quy ra % quota)');
    expect(estimateText(VI, preview({ estimate: null }))).toBe('—');
  });
});

describe('§4.14 Đổi chủ lane: undo', () => {
  test('§4.14 "Hoàn tác" sends the reverse move back to the old owner, marked undo', () => {
    expect(reassignBack({ projectId: 'p1', name: 'D2', from: 's3' })).toEqual({ cmd: 'lane_reassign', projectId: 'p1', name: 'D2', toSession: 's3', undo: true });
    expect(reassignBack({ projectId: 'p1', name: 'D2', from: null })).toBeNull();
  });
});

describe('§4.14 Lịch sử phiên rows', () => {
  test('§4.14 "chạy tiếp được" / "chỉ xem · hết hạn" / "hết hạn sau n ngày" (≤ 5)', () => {
    expect(rowStatus(VI, row())).toEqual({ text: 'chạy tiếp được', ok: true });
    expect(rowStatus(VI, row({ expiresInDays: 4 }))).toEqual({ text: 'chạy tiếp được · hết hạn sau 4 ngày', ok: true });
    expect(rowStatus(VI, row({ resumable: false }))).toEqual({ text: 'chỉ xem · hết hạn', ok: false });
    expect(rowStatus(VI, row({ state: 'running', resumable: null }))).toBeNull();
  });
});

describe('§4.14 N5-d history row meta', () => {
  const t = new Date(2026, 10, 13, 8, 10).getTime(), e = new Date(2026, 10, 13, 14, 22).getTime();
  test('§4.14 ended row: giờ · account đầu → cuối · số lane · tok · $ · cách kết thúc', () => {
    const r = row({ startedAt: t, endedAt: e, tokens: { input: 2_000_000, output: 400_000, cacheWrite: 0, cacheRead: 9 } });
    expect(rowMeta(VI, r)).toBe('13-11 08:10 → 14:22 · pm@ → acc07@ · 2 lane · 2,4M tok · ≈ $19,80 · thay bằng phiên mới');
  });
  test('§4.14 running row: one account when first = last, no end reason', () => {
    const r = row({ state: 'running', startedAt: t, endedAt: null, accountFirst: 'a@x', accountLast: 'a@x', endReason: null, costUsd: 8.3,
      tokens: { input: 1_100_000, output: 0, cacheWrite: 0, cacheRead: 0 }, resumable: null });
    expect(rowMeta(VI, r)).toBe('từ 13-11 08:10 · a@ · 2 lane · 1,1M tok · ≈ $8,30');
  });
});
