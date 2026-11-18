import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { insertLane, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { IssueEvents, type EventTimers } from '../../src/issues/events.ts';
import { addDep, createIssue, finishIssue, getIssue, insertSpec, moveSpec, takeIssue, updateSpec, type NewIssue } from '../../src/issues/store.ts';

let db: Db;
let sent: { sid: string; text: string }[];
let live: Set<string>;
let room: boolean;
let pending: { fn: () => void; ms: number }[];
let ev: IssueEvents;
let laneId: number;

const timers: EventTimers = { set: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clear: () => {} };
const orch = (id: string, kind: 'design' | 'build' | 'general', createdAt = 1) => {
  insertSession(db, { id, projectId: 'p1', kind: 'orchestrator', account: null });
  db.query('UPDATE session SET orch_kind = ?, created_at = ? WHERE id = ?').run(kind, createdAt, id);
};
const issue = (o: Partial<NewIssue> = {}) => createIssue(db, { projectId: 'p1', kind: 'task', specId: null, source: 'spec', title: 'x', ...o });
const activeSpec = (build: string | null = 'build1', path = 'docs/specs/v25.md') => {
  const s = insertSpec(db, { projectId: 'p1', path, title: 'v2.5', origin: 'app' });
  moveSpec(db, s.id, 'approved');
  moveSpec(db, s.id, 'active');
  return updateSpec(db, s.id, { buildSession: build });
};
const texts = (sid: string) => sent.filter((s) => s.sid === sid).map((s) => s.text);

beforeEach(() => {
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'one', path: '/r/one' });
  sent = []; live = new Set(); room = true; pending = [];
  orch('design1', 'design');
  orch('build1', 'build');
  orch('gen1', 'general', 5);
  laneId = insertLane(db, { projectId: 'p1', name: 'D2', cwd: '/w/d2', ownerSession: 'build1' }).id;
  ev = new IssueEvents({
    db, send: (sid, text) => sent.push({ sid, text }), running: (sid) => live.has(sid), hasRoom: () => room, timers,
  });
});
afterEach(() => db.close());

describe('§5.3 routing (never a design session)', () => {
  test('§5.3 a spec issue → spec.build_session', () => {
    const s = activeSpec();
    const t = issue({ specId: s.id });
    const b = issue({ specId: s.id, blockedBy: [t.id] });
    takeIssue(db, t.id, laneId, null);
    ev.issueDone(finishIssue(db, t.id, []));
    expect(texts('build1')).toContain(`[cc-slaves] ${b.key} hết bị chặn`);
  });

  test('§5.3 a spec whose build_session is a design session → nothing sent', () => {
    const s = activeSpec('design1');
    const t = issue({ specId: s.id });
    issue({ specId: s.id, blockedBy: [t.id] });
    takeIssue(db, t.id, laneId, null);
    ev.issueDone(finishIssue(db, t.id, []));
    expect(sent).toEqual([]);
  });

  test('§5.3 outside spec → the running general session; none running → created_by_session (not design) → newest general', () => {
    live.add('gen1');
    const a = issue({ source: 'lane', createdBySession: 'build1' });
    ev.issueCreated(a);
    expect(texts('gen1')).toEqual([`[cc-slaves] ${a.key} (ngoài spec) mới — mở lane riêng: x`]);
    live.clear(); sent = [];
    const b = issue({ source: 'orchestrator', createdBySession: 'build1', title: 'y' });
    ev.poOk(b);
    expect(sent.map((s) => s.sid)).toEqual(['build1']);
    sent = [];
    const c = issue({ source: 'orchestrator', createdBySession: 'design1', title: 'z' });
    ev.poOk(c);
    expect(sent.map((s) => s.sid)).toEqual(['gen1']);
  });

  test('§5.3 the creator itself is the receiver → no echo of its own issue', () => {
    live.add('gen1');
    ev.issueCreated(issue({ source: 'po', createdBySession: 'gen1' }));
    expect(sent).toEqual([]);
  });
});

describe('§5.3 lane holds the issue until it ends (A2, A9, R15)', () => {
  const lane = { projectId: 'p1', laneId: 0, name: 'D2' };
  test('§5.3 lane ended with the issue not done → back to todo + "trả về hàng" to the build session', () => {
    const s = activeSpec();
    const t = issue({ specId: s.id });
    takeIssue(db, t.id, laneId, 'abc');
    ev.laneEnded({ ...lane, laneId }, 'kết thúc');
    expect(getIssue(db, t.id)).toMatchObject({ state: 'todo', laneId: null, baseSha: null });
    expect(texts('build1')).toEqual([`[cc-slaves] ${t.key} trả về hàng (lane D2 kết thúc)`]);
  });

  test('§5.3 lane ended after issue_done → nothing released, nothing sent', () => {
    const s = activeSpec();
    const t = issue({ specId: s.id });
    issue({ specId: s.id, title: 'still open' });
    takeIssue(db, t.id, laneId, null);
    finishIssue(db, t.id, []);
    ev.laneEnded({ ...lane, laneId }, 'kết thúc');
    expect(getIssue(db, t.id)!.state).toBe('done');
    expect(sent).toEqual([]);
  });

  test('§5.3 lane broken keeps the issue + "kẹt ở lane hỏng"', () => {
    const t = issue();
    live.add('gen1');
    takeIssue(db, t.id, laneId, null);
    ev.laneBroken({ ...lane, laneId });
    expect(getIssue(db, t.id)).toMatchObject({ state: 'doing', laneId });
    expect(texts('gen1')).toEqual([`[cc-slaves] ${t.key} kẹt ở lane hỏng D2: resume hoặc finish`]);
  });

  test('§5.3 lane idle → "<spec> còn sẵn sàng: B-12↑, T-50" to the build session, priority first', () => {
    const s = activeSpec();
    const held = issue({ specId: s.id, title: 'held' });
    const t = issue({ specId: s.id, title: 'plain' });
    const b = issue({ specId: s.id, kind: 'bug', source: 'lane', title: 'bug' });
    takeIssue(db, held.id, laneId, null);
    ev.laneIdle({ ...lane, laneId });
    expect(texts('build1')).toEqual([`[cc-slaves] ${s.path} còn sẵn sàng: ${b.key}↑, ${t.key}`]);
  });

  test('§5.3 lane idle with nothing ready → no follow-up', () => {
    const s = activeSpec();
    const held = issue({ specId: s.id });
    takeIssue(db, held.id, laneId, null);
    ev.laneIdle({ ...lane, laneId });
    expect(sent).toEqual([]);
  });
});

describe('§5.4 outside-spec reminder (R10)', () => {
  test('§5.4 still todo after 10 min with room → reminded once; taken or no room → not', () => {
    live.add('gen1');
    const a = issue({ source: 'lane', title: 'a' });
    ev.issueCreated(a);
    expect(pending.map((p) => p.ms)).toEqual([600_000]);
    sent = [];
    pending[0]!.fn();
    expect(texts('gen1')).toEqual([`[cc-slaves] ${a.key} (ngoài spec) vẫn chưa giao sau 10 phút — mở lane riêng: lane_start {issue: "${a.key}"}`]);
    expect(pending).toHaveLength(1);
    sent = [];
    const b = issue({ source: 'lane', title: 'b' });
    ev.issueCreated(b);
    takeIssue(db, b.id, laneId, null);
    pending[1]!.fn();
    const c = issue({ source: 'lane', title: 'c' });
    ev.issueCreated(c);
    room = false;
    sent = [];
    pending[2]!.fn();
    expect(sent).toEqual([]);
  });

  test('§5.4 a spec issue sets no reminder', () => {
    const s = activeSpec();
    ev.issueCreated(issue({ specId: s.id, source: 'lane' }));
    expect(pending).toEqual([]);
  });
});

describe('§5.2-5 / §5.2-9 / §5.6 spec and PO events', () => {
  test('§5.2-5 the last open issue of the spec done → "xong hết mục" once', () => {
    const s = activeSpec();
    const a = issue({ specId: s.id });
    const b = issue({ specId: s.id, title: 'b' });
    takeIssue(db, a.id, laneId, null);
    ev.issueDone(finishIssue(db, a.id, []));
    expect(texts('build1').filter((t) => t.includes('xong hết mục'))).toEqual([]);
    takeIssue(db, b.id, laneId, null);
    ev.issueDone(finishIssue(db, b.id, []));
    expect(texts('build1').filter((t) => t.includes('xong hết mục'))).toEqual([
      `[cc-slaves] spec ${s.path} xong hết mục. Ghi bảng mục cuối vào spec §"Nhóm việc", chuyển file sang docs/specs/done/, merge, rồi spec_close {path: "${s.path}"}.`,
    ]);
  });

  test('ruling 22:36 a spec pinned to a rev the engine does not hold: the last issue done skips "xong hết mục", never throws', () => {
    const s = activeSpec();
    db.query('UPDATE spec SET workflow_rev = ? WHERE id = ?').run('a'.repeat(64), s.id);
    const a = issue({ specId: s.id });
    takeIssue(db, a.id, laneId, null);
    expect(() => ev.issueDone(finishIssue(db, a.id, []))).not.toThrow();
    expect(texts('build1').filter((t) => t.includes('xong hết mục'))).toEqual([]);
  });

  test('§5.2-9 spec amended → the verbatim message to the build session', () => {
    const s = activeSpec();
    ev.amended(s, 2, 'thêm nút xuất CSV', '0123456789abcdef');
    expect(texts('build1')).toEqual([
      `[cc-slaves] Spec ${s.path} được bổ sung (lần 2): thêm nút xuất CSV · commit 0123456. Đọc diff, tạo mục mới (source amend), huỷ mục todo không còn cần, dừng / giao lại lane nếu việc đang làm bị đổi.`,
    ]);
  });

  test('§5.6 PO ok → a note for the orchestrator (ghi nhận)', () => {
    live.add('gen1');
    const a = issue({ source: 'lane', title: 'sửa log' });
    ev.poOk(a);
    expect(texts('gen1')).toEqual([`[cc-slaves] PO cho làm ${a.key}: sửa log (ghi nhận)`]);
  });

  test('§5.3 an unlinked issue whose blockers are now all done → "hết bị chặn"', () => {
    live.add('gen1');
    const a = issue();
    const b = issue({ title: 'b', blockedBy: [a.id] });
    addDep(db, b.id, a.id);
    db.query('DELETE FROM issue_dep').run();
    ev.unblocked(getIssue(db, b.id)!);
    expect(texts('gen1')).toEqual([`[cc-slaves] ${b.key} hết bị chặn`]);
  });
});
