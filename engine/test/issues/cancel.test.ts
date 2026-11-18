// spec v2.7 §5.7 Huỷ / hoàn tác (D75) + R-B12 `issue_cancel_preview`: every branch of `cancelByPo` over a real state.db and a
// temp git repo (engine/test/git/_repo.ts, never this repo). The lane is a port: a fake whose "process" exits late proves A4.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import { insertLane, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { invalidateGitConfig } from '../../src/git/run.ts';
import { CancelRefused, cancelByPo, cancelPreview, REVERT_DONE_WHEN, type CancelPorts } from '../../src/issues/cancel.ts';
import { IssueEvents } from '../../src/issues/events.ts';
import { viewIssues } from '../../src/issues/rules.ts';
import {
  addDep, createIssue, finishIssue, getIssue, getIssueByKey, insertSpec, keepAfterConflict, listEvents, listIssues, moveSpec, projectDeps,
  revertConflict, takeIssue, updateSpec, type NewIssue,
} from '../../src/issues/store.ts';
import { execIn } from '../../src/setup/setup.ts';
import { rejects } from '../_fixtures/rejects.ts';
import { commit, fixture, git, type Fixture } from '../git/_repo.ts';

setDefaultTimeout(30_000);
let f: Fixture;
let db: Db;
let sent: string[];
let log: string[];
let exitDelay: number;
let p: CancelPorts;
let lane: { id: number; cwd: string };
let firstDoing: string | null = null;

const head = (cwd = f.repo) => git(cwd, 'rev-parse', 'HEAD');
const tagged = (cwd: string, file: string, key: string) => commit(cwd, file, `${file}\n`, `${file}\n\nIssue: ${key}`);
const issue = (o: Partial<NewIssue> = {}) => createIssue(db, { projectId: 'p1', kind: 'task', specId: null, source: 'spec', title: 'việc', ...o });
const state = (key: string) => getIssueByKey(db, 'p1', key)!;

beforeEach(() => {
  f = fixture();
  invalidateGitConfig();
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'Shop', path: f.repo });
  insertSession(db, { id: 'gen1', projectId: 'p1', kind: 'orchestrator', account: null });
  const wt = join(f.root, 'wt-f1');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'fix-b52', wt);
  lane = { id: insertLane(db, { projectId: 'p1', name: 'F1', cwd: wt, ownerSession: 'gen1' }).id, cwd: wt };
  sent = []; log = []; exitDelay = 0;
  const events = new IssueEvents({ db, send: (_sid, text) => sent.push(text), running: () => true, hasRoom: () => true, timers: { set: () => 0, clear: () => {} } });
  p = {
    db, exec: execIn(process.env), events, root: () => f.repo,
    stopLane: async (_pid, name) => {
      log.push(`stop ${name} (${state(firstDoing ?? 'T-1')?.state})`);
      await Bun.sleep(exitDelay); // the process exits late
      log.push(`exited ${name}`);
    },
    finishLane: async (_pid, name) => { log.push(`finish ${name} (${state(firstDoing ?? 'T-1')?.state})`); },
    reverting: (o) => { log.push(`reverting ${o.key}`); },
  };
});
afterEach(() => { db.close(); f.done(); });

/** A `doing` issue held by F1, with base_sha = the worktree's HEAD now. */
function doing(o: Partial<NewIssue> = {}) {
  const i = issue(o);
  firstDoing = i.key;
  return takeIssue(db, i.id, lane.id, head(lane.cwd));
}
/** A `done` issue whose one tagged commit is on main. */
function doneOnMain(o: Partial<NewIssue> = {}) {
  const i = doing(o);
  tagged(lane.cwd, `${i.key}.txt`, i.key);
  const sha = head(lane.cwd);
  git(f.repo, 'merge', '-q', '--no-ff', '-m', `merge ${i.key}`, 'fix-b52');
  return { issue: finishIssue(db, i.id, [{ sha, branch: 'fix-b52' }]), sha };
}

describe('§5.7-2 todo', () => {
  test('§5.7-2 todo → cancelled at once with the PO reason, event "PO huỷ", the issue it blocks named; no lane touched', async () => {
    const t = issue({ title: 'xuất PDF' });
    const w = issue({ title: 'in hoá đơn' });
    addDep(db, w.id, t.id);
    const r = await cancelByPo(p, 'p1', t.key, 'không cần nữa');
    expect(r).toEqual({ key: t.key, mode: 'cancel', revertKey: null });
    expect(state(t.key)).toMatchObject({ state: 'cancelled', cancelReason: 'không cần nữa' });
    expect(listEvents(db, t.id).at(-1)).toMatchObject({ type: 'cancelled', data: { by: 'po', reason: 'không cần nữa' } });
    expect(sent.at(-1)).toContain(`PO huỷ ${t.key}: xuất PDF — lý do: không cần nữa.`);
    expect(sent.at(-1)).toContain(`${w.key} bị chặn tới khi Điều phối gỡ`);
    expect(log).toEqual([]);
  });

  test('R-B12 §4.4 IS4a preview of a todo: mode cancel, the open issue waiting on it', async () => {
    const t = issue();
    const w = issue();
    addDep(db, w.id, t.id);
    expect(await cancelPreview(p, 'p1', t.key)).toEqual({ key: t.key, mode: 'cancel', lane: null, revert: null, dependants: { open: [w.key], done: [] } });
  });
});

describe('§5.7-3 doing', () => {
  test('§5.7-3 A4 doing, commits not merged → lane stopped and its late exit awaited BEFORE the issue changes, then cancelled + lane finish', async () => {
    const i = doing();
    tagged(lane.cwd, 'a', i.key);
    tagged(lane.cwd, 'b', i.key);
    exitDelay = 150;
    const r = await cancelByPo(p, 'p1', i.key, null);
    expect(r.mode).toBe('stop');
    expect(log).toEqual(['stop F1 (doing)', 'exited F1', 'finish F1 (cancelled)']);
    expect(state(i.key).state).toBe('cancelled');
    expect(state(i.key).revert).toBe('none');
    expect(listIssues(db, 'p1').filter((x) => x.reverts !== null)).toEqual([]); // no revert
    expect(sent.at(-1)).toContain('Xoá worktree + nhánh `fix-b52`');
    expect(sent.at(-1)).toContain('Engine đã dừng và kết thúc lane F1');
  });

  test('R-B12 §4.4 IS4b preview of a doing: the lane, its branch, 2 commits not merged', async () => {
    const i = doing();
    tagged(lane.cwd, 'a', i.key);
    tagged(lane.cwd, 'b', i.key);
    expect(await cancelPreview(p, 'p1', i.key)).toMatchObject({ mode: 'stop', lane: { name: 'F1', branch: 'fix-b52', commits: 2 }, revert: null });
    expect(log).toEqual([]); // a preview never stops anything
  });

  test('§5.7-3 doing already merged in part → like done: lane stopped first, then done + revert pending + the revert issue', async () => {
    const i = doing();
    tagged(lane.cwd, 'a', i.key);
    const merged = head(lane.cwd);
    git(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'fix-b52');
    tagged(lane.cwd, 'b', i.key);
    expect((await cancelPreview(p, 'p1', i.key)).revert).toMatchObject({ branch: 'main', shas: [merged] });
    const r = await cancelByPo(p, 'p1', i.key, 'sai hướng');
    expect(r.mode).toBe('revert');
    expect(log.slice(0, 2)).toEqual(['stop F1 (doing)', 'exited F1']);
    expect(state(i.key)).toMatchObject({ state: 'done', revert: 'pending', cancelReason: 'sai hướng' });
    expect(getIssueByKey(db, 'p1', r.revertKey!)!.reverts).toBe(i.id);
  });

  test('§5.7 a second confirm while the first is still stopping the lane → refused, the lane stopped once', async () => {
    const i = doing();
    exitDelay = 100;
    const first = cancelByPo(p, 'p1', i.key, null);
    await rejects(cancelByPo(p, 'p1', i.key, null)).toThrow('đang được huỷ');
    await first;
    expect(log.filter((x) => x.startsWith('stop'))).toHaveLength(1);
    expect(state(i.key).state).toBe('cancelled');
  });

  test('§5.7 A3 git unreadable → refused before the lane is stopped (nothing half-way)', async () => {
    const i = doing();
    db.query('UPDATE issue SET base_sha = ? WHERE id = ?').run('0000000000000000000000000000000000000000', i.id);
    await rejects(cancelByPo(p, 'p1', i.key, null)).toThrow(CancelRefused);
    expect(log).toEqual([]);
    expect(state(i.key).state).toBe('doing');
  });

  test('§5.7-3 the lane finished the issue while it was being stopped → reverted like a done one', async () => {
    const i = doing();
    tagged(lane.cwd, 'a', i.key);
    const sha = head(lane.cwd);
    p.stopLane = async () => {
      git(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'fix-b52');
      finishIssue(db, i.id, [{ sha, branch: 'fix-b52' }]);
    };
    expect((await cancelByPo(p, 'p1', i.key, null)).mode).toBe('revert');
    expect(state(i.key)).toMatchObject({ state: 'done', revert: 'pending' });
  });
});

describe('§5.7-4 done', () => {
  test('§5.7-4 done (spec active) → revert pending + "Hoàn tác T-…" in the same spec: source po, reverts, priority, done_when verbatim, body names its trailer', async () => {
    const s = insertSpec(db, { projectId: 'p1', path: 'docs/specs/v25.md', title: 'v2.5', origin: 'app' });
    moveSpec(db, s.id, 'approved');
    moveSpec(db, s.id, 'active');
    insertSession(db, { id: 'b1', projectId: 'p1', kind: 'orchestrator', account: null });
    db.query("UPDATE session SET orch_kind = 'build' WHERE id = 'b1'").run();
    updateSpec(db, s.id, { buildSession: 'b1' }); // §5.3 a spec issue's events go to its Build session
    const { issue: d, sha } = doneOnMain({ specId: s.id });
    const pre = await cancelPreview(p, 'p1', d.key);
    expect(pre).toMatchObject({ mode: 'revert', revert: { branch: 'main', shas: [sha], key: 'T-2' } });
    const r = await cancelByPo(p, 'p1', d.key, 'đổi ý');
    expect(r).toEqual({ key: d.key, mode: 'revert', revertKey: 'T-2' });
    expect(state(d.key)).toMatchObject({ state: 'done', revert: 'pending', cancelReason: 'đổi ý' });
    const rv = state('T-2');
    expect(rv).toMatchObject({ title: `Hoàn tác ${d.key}`, source: 'po', reverts: d.id, specId: s.id, state: 'todo', poSeen: true, doneWhen: REVERT_DONE_WHEN });
    expect(REVERT_DONE_WHEN).toEqual(['một commit Revert, test xanh, đã merge']);
    expect(rv.body).toContain('`Issue: T-2`');
    expect(rv.body).toContain(sha.slice(0, 7));
    expect(rv.body).toContain('issue_revert_conflict');
    expect(viewIssues(listIssues(db, 'p1'), projectDeps(db, 'p1')).find((v) => v.issue.key === 'T-2')!.priority).toBe(true);
    expect(log).toEqual([`reverting ${d.key}`]); // done: no lane stopped
    expect(sent.at(-1)).toContain(`PO huỷ ${d.key} (đã xong) — lý do: đổi ý.`);
    expect(sent.at(-1)).toContain('lane_start {issue: "T-2"}');
  });

  test('§5.7-4 spec done → the revert issue goes outside any spec; target main', async () => {
    const s = insertSpec(db, { projectId: 'p1', path: 'docs/specs/v24.md', title: 'v2.4', origin: 'app' });
    moveSpec(db, s.id, 'approved');
    moveSpec(db, s.id, 'active');
    updateSpec(db, s.id, { branch: 'v24' });
    const { issue: d } = doneOnMain({ specId: s.id });
    moveSpec(db, s.id, 'done');
    const r = await cancelByPo(p, 'p1', d.key, null);
    expect(state(r.revertKey!).specId).toBeNull();
  });

  test('§4.4 IS4c preview: the done dependants (built on it) and the open ones', async () => {
    const { issue: d } = doneOnMain();
    const open = issue();
    addDep(db, open.id, d.id);
    const built = issue();
    addDep(db, built.id, d.id);
    db.query("UPDATE issue SET state = 'done' WHERE id = ?").run(built.id);
    expect((await cancelPreview(p, 'p1', d.key)).dependants).toEqual({ open: [open.key], done: [built.key] });
  });

  test('§5.7-5 "Huỷ cả hai…": the revert of what was built on it runs first, whichever confirm came first', async () => {
    const { issue: a } = doneOnMain();
    const b = issue();
    addDep(db, b.id, a.id);
    db.query("UPDATE issue SET state = 'done' WHERE id = ?").run(b.id);
    const ra = (await cancelByPo(p, 'p1', a.key, null)).revertKey!; // base first
    const rb = (await cancelByPo(p, 'p1', b.key, null)).revertKey!;
    const deps = projectDeps(db, 'p1');
    expect(deps).toContainEqual({ issueId: state(ra).id, blockedById: state(rb).id });
  });

  test('§5.7-5 "Huỷ cả hai…" confirmed dependant first: the base revert still waits for it', async () => {
    const { issue: a } = doneOnMain();
    const b = issue();
    addDep(db, b.id, a.id);
    db.query("UPDATE issue SET state = 'done' WHERE id = ?").run(b.id);
    const rb = (await cancelByPo(p, 'p1', b.key, null)).revertKey!; // dependant first
    const ra = (await cancelByPo(p, 'p1', a.key, null)).revertKey!;
    expect(projectDeps(db, 'p1')).toContainEqual({ issueId: state(ra).id, blockedById: state(rb).id });
  });
});

describe('§5.7 refusals (R31, IS5)', () => {
  test('R31 a prior issue has no cancel / revert', async () => {
    const i = issue({ source: 'prior', state: 'done' });
    await rejects(cancelPreview(p, 'p1', i.key)).toThrow('phần làm trước khi nhập');
    await rejects(cancelByPo(p, 'p1', i.key, null)).toThrow(CancelRefused);
  });

  test('IS5 an issue with an open revert (pending / running) is refused; a revert issue itself too; cancelled too', async () => {
    const { issue: d } = doneOnMain();
    const { revertKey } = await cancelByPo(p, 'p1', d.key, null);
    await rejects(cancelByPo(p, 'p1', d.key, null)).toThrow('đang hoàn tác');
    await rejects(cancelPreview(p, 'p1', revertKey!)).toThrow('là mục hoàn tác');
    const t = issue();
    await cancelByPo(p, 'p1', t.key, null);
    await rejects(cancelByPo(p, 'p1', t.key, null)).toThrow('đã huỷ');
    await rejects(cancelByPo(p, 'p1', 'T-99', null)).toThrow('Không có mục T-99');
  });

  test('§5.7-5 after a conflict the original may be cancelled again (Huỷ cả hai), "Giữ" = revert none', async () => {
    const { issue: d } = doneOnMain();
    const { revertKey } = await cancelByPo(p, 'p1', d.key, null);
    const rv = state(revertKey!);
    takeIssue(db, rv.id, insertLane(db, { projectId: 'p1', name: 'R6', cwd: join(f.root, 'r6'), ownerSession: 'gen1' }).id, null);
    expect(revertConflict(db, rv.id, 'vướng T-53')).toMatchObject({ state: 'done', revert: 'conflict' });
    expect(state(revertKey!).state).toBe('cancelled');
    expect((await cancelPreview(p, 'p1', d.key)).mode).toBe('revert');
    expect(keepAfterConflict(db, d.id)).toMatchObject({ state: 'done', revert: 'none' });
    expect(getIssue(db, d.id)!.revert).toBe('none');
  });
});
