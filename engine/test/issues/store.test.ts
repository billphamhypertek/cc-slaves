import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { insertLane, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import {
  addDep, addFile, appendEvent, bumpAmend, cancelIssue, createIssue, finishIssue, getIssue, getIssueByKey, getSpec, getSpecByPath, insertSpec,
  issueViews, laneIssues, listCommits, listEvents, listFiles, listIssues, listSpecs, markOk, markSeen, moveSpec, readyIssues,
  releaseIssue, removeDep, requestRevert, revertConflict, takeIssue, titleIndex, unseenCount, updateSpec, type NewIssue,
} from '../../src/issues/store.ts';

let db: Db;
let lane1: number;
let lane2: number;
beforeEach(() => {
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'one', path: '/r/one' });
  insertProject(db, { id: 'p2', name: 'two', path: '/r/two' });
  insertSession(db, { id: 's1', projectId: 'p1', kind: 'orchestrator', account: null });
  lane1 = insertLane(db, { projectId: 'p1', name: 'D1', cwd: '/w/d1' }).id;
  lane2 = insertLane(db, { projectId: 'p1', name: 'D2', cwd: '/w/d2' }).id;
});
afterEach(() => db.close());

const issue = (o: Partial<NewIssue> = {}) =>
  createIssue(db, { projectId: 'p1', kind: 'task', specId: null, source: 'spec', title: 'x', ...o });
const spec = (path = 'docs/specs/a.md') => insertSpec(db, { projectId: 'p1', path, title: 'A', origin: 'app' });

describe('§5.1 / §5.2 spec rows', () => {
  test('§5.2 draft → approved → active → done stamps times; approved → draft re-draft; a skipped step throws', () => {
    const s = spec();
    expect(s.state).toBe('draft');
    expect(() => moveSpec(db, s.id, 'active')).toThrow(/not allowed/);
    expect(moveSpec(db, s.id, 'approved', 10).approvedAt).toBe(10);
    expect(moveSpec(db, s.id, 'draft').state).toBe('draft');
    moveSpec(db, s.id, 'approved', 11);
    expect(moveSpec(db, s.id, 'active', 12).openedAt).toBe(12);
    expect(() => moveSpec(db, s.id, 'draft')).toThrow(/not allowed/);
    const done = moveSpec(db, s.id, 'done', 13);
    expect([done.state, done.doneAt]).toEqual(['done', 13]);
  });

  test('§5.2-7 imported spec keeps its guessed state + outside_build; get by path; list per project', () => {
    insertSpec(db, { projectId: 'p1', path: 'docs/specs/b.md', title: 'B', origin: 'imported', state: 'approved', outsideBuild: true }, 5);
    spec();
    const b = getSpecByPath(db, 'p1', 'docs/specs/b.md')!;
    expect([b.origin, b.state, b.outsideBuild, b.approvedAt]).toEqual(['imported', 'approved', true, 5]);
    expect(listSpecs(db, 'p1').map((x) => x.path)).toEqual(['docs/specs/b.md', 'docs/specs/a.md']);
    expect(listSpecs(db, 'p2')).toEqual([]);
    expect(getSpecByPath(db, 'p2', 'docs/specs/b.md')).toBeNull();
    expect(getSpec(db, b.id)?.path).toBe('docs/specs/b.md');
    expect(getSpec(db, 999)).toBeNull();
  });

  test('§5.2-8 / -9 / -10 branch, sessions, edit_session, resumed, amend_rev', () => {
    const s = spec();
    const u = updateSpec(db, s.id, { branch: 'v25', buildSession: 's1', editSession: 's1', resumed: true });
    expect([u.branch, u.buildSession, u.editSession, u.resumed, u.outsideBuild]).toEqual(['v25', 's1', 's1', true, false]);
    expect(updateSpec(db, s.id, { editSession: null }).editSession).toBeNull();
    expect([bumpAmend(db, s.id), bumpAmend(db, s.id)]).toEqual([1, 2]);
  });
});

describe('§5.1 issue rows', () => {
  test('§5.1 num is one counter per project for tasks and bugs; keys T- / B-', () => {
    const a = issue();
    const b = issue({ kind: 'bug' });
    const c = createIssue(db, { projectId: 'p2', kind: 'bug', specId: null, source: 'po', title: 'y' });
    expect([a.key, b.key, c.key]).toEqual(['T-1', 'B-2', 'B-1']);
    expect(getIssueByKey(db, 'p1', 'B-2')?.id).toBe(b.id);
    expect(getIssueByKey(db, 'p1', 'T-2')).toBeNull();
    expect(getIssueByKey(db, 'p1', 'nonsense')).toBeNull();
    expect(getIssue(db, c.id)?.key).toBe('B-1');
    expect(getIssue(db, 999)).toBeNull();
  });

  test('§5.6 lane / orchestrator issues start unseen; po / spec seen; unseen count skips cancelled', () => {
    const l = issue({ source: 'lane', sourceLane: lane1 });
    issue({ source: 'orchestrator' });
    issue({ source: 'po' });
    expect([l.poSeen, unseenCount(db, 'p1')]).toEqual([false, 2]);
    markSeen(db, l.id);
    expect(unseenCount(db, 'p1')).toBe(1);
    const o = getIssueByKey(db, 'p1', 'T-2')!;
    cancelIssue(db, o.id, { reason: null, by: 'po' });
    expect(unseenCount(db, 'p1')).toBe(0);
    const n = issue({ source: 'lane' });
    markOk(db, n.id);
    const after = getIssueByKey(db, 'p1', n.key)!;
    expect([after.poOk, after.poSeen]).toEqual([true, true]);
  });

  test('§5.3 take → doing (lane + base_sha); a lane holds one doing issue; release → todo, lane cleared', () => {
    const a = issue();
    const b = issue();
    const t = takeIssue(db, a.id, lane1, 'abc');
    expect([t.state, t.laneId, t.baseSha]).toEqual(['doing', lane1, 'abc']);
    expect(() => takeIssue(db, a.id, lane2, null)).toThrow(/doing/);
    expect(() => takeIssue(db, b.id, lane1, null)).toThrow(/UNIQUE/);
    const r = releaseIssue(db, a.id, 'lane_finish');
    expect([r.state, r.laneId, r.baseSha]).toEqual(['todo', null, null]);
    expect(listEvents(db, a.id).map((e) => e.type)).toEqual(['created', 'taken', 'returned']);
    expect(listEvents(db, a.id)[2]!.data).toEqual({ lane: lane1, reason: 'lane_finish' });
  });

  test('§5.5-6 done saves commit rows; laneIssues keeps history of the lane', () => {
    const a = issue();
    takeIssue(db, a.id, lane1, 'abc');
    const d = finishIssue(db, a.id, [{ sha: 'c1', branch: 'v25' }, { sha: 'c2', branch: 'v25' }], 9);
    expect([d.state, d.doneAt]).toEqual(['done', 9]);
    expect(listCommits(db, a.id).map((c) => c.sha)).toEqual(['c1', 'c2']);
    expect(laneIssues(db, lane1).map((i) => i.key)).toEqual(['T-1']);
    expect(() => finishIssue(db, a.id, [])).toThrow(/done/);
  });

  test('§5.2-10 prior issue created done with its commits', () => {
    const s = spec();
    const p = issue({ specId: s.id, source: 'prior', state: 'done', commits: [{ sha: 'p1', branch: null }] });
    expect([p.state, p.doneAt !== null]).toEqual(['done', true]);
    expect(listCommits(db, p.id).map((c) => c.sha)).toEqual(['p1']);
  });

  test('§5.1 list per spec / outside spec / cancelled', () => {
    const s = spec();
    issue({ specId: s.id });
    const o = issue();
    issue({ specId: s.id });
    cancelIssue(db, o.id, { reason: 'không cần', by: 'po' });
    expect(listIssues(db, 'p1', { specId: s.id }).map((i) => i.key)).toEqual(['T-1', 'T-3']);
    expect(listIssues(db, 'p1', { specId: null }).map((i) => i.key)).toEqual(['T-2']);
    const c = listIssues(db, 'p1', { state: 'cancelled' });
    expect(c.map((i) => [i.key, i.cancelReason])).toEqual([['T-2', 'không cần']]);
  });

  test('§5.7 revert: none → pending → running (lane takes revert) → done cancels the original', () => {
    const a = issue();
    takeIssue(db, a.id, lane1, null);
    finishIssue(db, a.id, []);
    const r = issue({ source: 'po', reverts: a.id, title: 'Hoàn tác T-1' });
    expect(() => takeIssue(db, r.id, lane2, null)).toThrow(/revert none → running not allowed/);
    requestRevert(db, a.id, { reason: 'sai hướng' });
    takeIssue(db, r.id, lane2, null);
    expect(getIssueByKey(db, 'p1', 'T-1')!.revert).toBe('running');
    releaseIssue(db, r.id, 'lane_finish');
    expect(getIssueByKey(db, 'p1', 'T-1')!.revert).toBe('pending');
    takeIssue(db, r.id, lane2, null);
    finishIssue(db, r.id, [{ sha: 'rv', branch: 'main' }]);
    const orig = getIssueByKey(db, 'p1', 'T-1')!;
    expect([orig.state, orig.revert]).toEqual(['cancelled', 'done']);
  });

  test('§5.7-5 revert conflict: revert issue cancelled, original stays done with revert=conflict', () => {
    const a = issue();
    takeIssue(db, a.id, lane1, null);
    finishIssue(db, a.id, []);
    requestRevert(db, a.id, { reason: null });
    const r = issue({ source: 'po', reverts: a.id });
    takeIssue(db, r.id, lane2, null);
    const orig = revertConflict(db, r.id, 'vướng T-53');
    expect([orig.state, orig.revert]).toEqual(['done', 'conflict']);
    expect(getIssueByKey(db, 'p1', r.key)!.state).toBe('cancelled');
    expect(() => revertConflict(db, a.id, 'x')).toThrow(/not a revert/);
    expect(requestRevert(db, a.id, { reason: 'thử lại' }).revert).toBe('pending');
  });

  test('§5.7-4 / A5 PO cancels a done issue: reason + cancelled {by: po} stored at once; after the revert the dup check has it', () => {
    const a = issue({ title: 'Sửa nút' });
    takeIssue(db, a.id, lane1, null);
    finishIssue(db, a.id, []);
    const p = requestRevert(db, a.id, { reason: 'PO đổi ý' }, 5);
    expect([p.state, p.revert, p.cancelReason]).toEqual(['done', 'pending', 'PO đổi ý']);
    expect(listEvents(db, a.id).find((e) => e.type === 'cancelled')?.data).toEqual({ by: 'po', reason: 'PO đổi ý' });
    expect(() => requestRevert(db, a.id, { reason: 'x' })).toThrow(/revert pending → pending not allowed/);
    const r = issue({ source: 'po', reverts: a.id });
    takeIssue(db, r.id, lane2, null);
    finishIssue(db, r.id, []);
    expect(titleIndex(db, 'p1').cancelledByPo).toEqual([{ key: 'T-1', norm: 'sửa nút', cancelReason: 'PO đổi ý' }]);
    expect(() => requestRevert(db, a.id, { reason: 'x' })).toThrow(/T-1 is cancelled/);
    expect(() => requestRevert(db, r.id + 1, { reason: 'x' })).toThrow(/not found/);
    expect(() => requestRevert(db, issue().id, { reason: 'x' })).toThrow(/is todo/);
  });

  test('§5.7-3 PO cancels a doing issue already merged: done + commits + revert pending in one step; a later release refuses', () => {
    const a = issue();
    takeIssue(db, a.id, lane1, 'b0');
    const p = requestRevert(db, a.id, { reason: 'dừng', commits: [{ sha: 'c1', branch: 'v27' }] }, 9);
    expect([p.state, p.revert, p.doneAt, p.laneId]).toEqual(['done', 'pending', 9, lane1]);
    expect(listCommits(db, a.id).map((c) => c.sha)).toEqual(['c1']);
    expect(() => releaseIssue(db, a.id, 'lane_finish')).toThrow(/is done/);
    expect(laneIssues(db, lane1).filter((i) => i.state === 'doing')).toEqual([]);
  });

  test('§5.1 events are structured JSON; files rows', () => {
    const a = issue();
    appendEvent(db, a.id, 'note', { lane: 'D2', n: 3 });
    expect(listEvents(db, a.id).at(-1)?.data).toEqual({ lane: 'D2', n: 3 });
    addFile(db, a.id, { name: 'shot.png', path: '/h/issues/p1/T-1/shot.png', size: 12 }, 4);
    expect(listFiles(db, a.id)).toEqual([{ id: 1, name: 'shot.png', path: '/h/issues/p1/T-1/shot.png', size: 12, at: 4 }]);
  });
});

describe('§5.1 / §5.4 derived views', () => {
  test('§5.1 blocked = a blocker not done; a cancelled blocker still blocks; removing the dep unblocks', () => {
    const a = issue();
    const b = issue({ blockedBy: [a.id] });
    const view = () => issueViews(db, 'p1').find((v) => v.issue.id === b.id)!;
    expect([view().blockedBy, view().ready]).toEqual([['T-1'], false]);
    cancelIssue(db, a.id, { reason: null, by: 'po' });
    expect(view().blockedBy).toEqual(['T-1']);
    removeDep(db, b.id, a.id);
    expect([view().blockedBy, view().ready]).toEqual([[], true]);
    addDep(db, b.id, a.id);
    expect(view().ready).toBe(false);
  });

  test('§5.4 ready order: priority → more waiters → lower num; priority = po/lane/orchestrator or the last blocker', () => {
    const s = spec();
    const i = (o: Partial<NewIssue> = {}) => issue({ specId: s.id, ...o });
    const t1 = i();                                  // T-1 plain
    const t2 = i();                                  // T-2: sole blocker of T-4 → priority
    const t3 = i();                                  // T-3: blocks T-5 together with T-2 → waiters 1, no priority
    i({ blockedBy: [t2.id] });                       // T-4
    i({ blockedBy: [t3.id, t2.id] });                // T-5
    const t6 = i({ source: 'lane' });                // T-6 priority by source
    issue();                                         // T-7 outside spec: not in this spec's list
    const order = readyIssues(db, 'p1', s.id).map((v) => [v.issue.key, v.priority, v.waiters]);
    expect(order).toEqual([['T-2', true, 2], ['T-6', true, 0], ['T-3', false, 1], ['T-1', false, 0]]);
    takeIssue(db, t6.id, lane1, null);
    expect(readyIssues(db, 'p1', s.id).map((v) => v.issue.key)).toEqual(['T-2', 'T-3', 'T-1']);
    expect(readyIssues(db, 'p1', null).map((v) => v.issue.key)).toEqual(['T-7']);
    expect(t1.num).toBe(1);
  });

  test('§5.5-7 title index: PO-cancelled (and reverted) with reason; a drop by the orchestrator is not the PO', () => {
    const a = issue({ title: 'Sửa nút Huỷ!' });
    const b = issue({ title: 'Đổi màu' });
    issue({ title: 'Mở   tab Tasks' });
    cancelIssue(db, a.id, { reason: 'PO không cần', by: 'po' });
    cancelIssue(db, b.id, { reason: 'trùng', by: 'orchestrator' });
    const idx = titleIndex(db, 'p1');
    expect(idx.cancelledByPo).toEqual([{ key: 'T-1', norm: 'sửa nút huỷ', cancelReason: 'PO không cần' }]);
    expect(idx.open).toEqual([{ key: 'T-3', norm: 'mở tab tasks' }]);
  });
});
