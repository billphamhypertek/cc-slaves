// R-B14 (spec v2.7 rev 4, D99, §4.3 IS22 / IS22b) the spec overview fields of the wire view: one test per field.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { SpecOverview } from '../../../shared/issues.ts';
import { insertLane, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { bumpAmend, createIssue, finishIssue, insertSpec, moveSpec, releaseIssue, takeIssue, updateSpec, type NewIssue } from '../../src/issues/store.ts';
import { projectIssues, type IssueViewPorts } from '../../src/issues/views.ts';

let db: Db;
let specId: number;
let sessions: Record<string, ReturnType<IssueViewPorts['session']>>;
const ports: IssueViewPorts = {
  lane: (id) => db.query<{ name: string; state: string; phase: string | null }, [number]>('SELECT name, state, phase FROM lane WHERE id = ?').get(id),
  exists: () => true, groups: () => null, session: (sid) => sessions[sid] ?? null,
};
const issue = (o: Partial<NewIssue> = {}) => createIssue(db, { projectId: 'p1', kind: 'task', specId, source: 'spec', title: 'x', ...o });
const overview = (id = specId): SpecOverview | null => projectIssues(db, 'p1', ports).specs.find((s) => s.id === id)!.overview;

beforeEach(() => {
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'Shop', path: '/r' });
  sessions = {};
  const s = insertSpec(db, { projectId: 'p1', path: 'docs/specs/v25.md', title: 'v2.5', origin: 'app' });
  specId = s.id;
  moveSpec(db, s.id, 'approved');
  moveSpec(db, s.id, 'active');
});

describe('R-B14 spec overview (D99)', () => {
  test('v2.9 §4.7 a spec view carries its pinned rev and step (the Tasks rail groups by step)', () => {
    const v = projectIssues(db, 'p1', ports).specs.find((x) => x.id === specId)!;
    const row = db.query<{ r: string; s: string | null }, [number]>('SELECT workflow_rev AS r, step AS s FROM spec WHERE id = ?').get(specId)!;
    expect([v.workflowRev, v.step]).toEqual([row.r, row.s]);
    expect(v.workflowRev).toMatch(/^[0-9a-f]{64}$/);
  });
  test('R-B14 draft / approved specs have no overview; active and done do', () => {
    const d = insertSpec(db, { projectId: 'p1', path: 'docs/specs/v26.md', title: 'v2.6', origin: 'app' });
    expect(overview(d.id)).toBeNull();
    moveSpec(db, d.id, 'approved');
    expect(overview(d.id)).toBeNull();
    expect(overview()).not.toBeNull();
  });

  test('R-B14 build session: title + running / waiting_po / closed from the port; unbound → null; a vanished row → closed', () => {
    expect(overview()!.buildSession).toBeNull();
    insertSession(db, { id: 'b1', projectId: 'p1', kind: 'orchestrator', account: null });
    updateSpec(db, specId, { buildSession: 'b1' });
    sessions.b1 = { title: 'Build v2.5', state: 'waiting_po' };
    expect(overview()!.buildSession).toEqual({ id: 'b1', title: 'Build v2.5', state: 'waiting_po' });
    sessions.b1 = { title: 'Build v2.5', state: 'running' };
    expect(overview()!.buildSession!.state).toBe('running');
    delete sessions.b1;
    expect(overview()!.buildSession).toEqual({ id: 'b1', title: null, state: 'closed' });
  });

  test('R-B14 lanes: only lanes holding a doing issue of this spec, with their state + phase', () => {
    const l = insertLane(db, { projectId: 'p1', name: 'D2', cwd: '/w/d2' });
    db.query("UPDATE lane SET state = 'broken', phase = 'code' WHERE id = ?").run(l.id);
    const t = issue();
    issue(); // todo: no lane
    takeIssue(db, t.id, l.id, null);
    expect(overview()!.lanes).toEqual([{ name: 'D2', key: t.key, state: 'broken', phase: 'code' }]);
  });

  test('R-B14 commit count: distinct trailer commits over the spec\'s issues (other specs / outside not counted)', () => {
    const l = insertLane(db, { projectId: 'p1', name: 'D2', cwd: '/w/d2' });
    const a = issue();
    takeIssue(db, a.id, l.id, null);
    finishIssue(db, a.id, [{ sha: 'aaaaaaa1', branch: 'x' }, { sha: 'aaaaaaa2', branch: 'x' }]);
    const out = issue({ specId: null });
    const l2 = insertLane(db, { projectId: 'p1', name: 'D3', cwd: '/w/d3' });
    takeIssue(db, out.id, l2.id, null);
    finishIssue(db, out.id, [{ sha: 'bbbbbbb1', branch: 'y' }]);
    expect(overview()!.commits).toBe(2);
  });

  test('R-B14 last amend: null before any round; rev + its amend issues (not cancelled) + newest creation time', () => {
    expect(overview()!.lastAmend).toBeNull();
    bumpAmend(db, specId);
    bumpAmend(db, specId);
    createIssue(db, { projectId: 'p1', kind: 'task', specId, source: 'amend', title: 'a1' }, 1000);
    createIssue(db, { projectId: 'p1', kind: 'task', specId, source: 'amend', title: 'a2' }, 2000);
    const gone = createIssue(db, { projectId: 'p1', kind: 'task', specId, source: 'amend', title: 'a3' }, 3000);
    db.query("UPDATE issue SET state = 'cancelled' WHERE id = ?").run(gone.id);
    expect(overview()!.lastAmend).toEqual({ rev: 2, issueCount: 2, at: 2000 });
  });

  test('R-B14 mergedInto: null while building, main once the spec is done; approvedAt / openedAt / doneAt + after stay on the spec view', () => {
    expect(overview()!.mergedInto).toBeNull();
    moveSpec(db, specId, 'done');
    expect(overview()!.mergedInto).toBe('main');
    const s = projectIssues(db, 'p1', ports).specs.find((x) => x.id === specId)!;
    expect([s.approvedAt, s.openedAt, s.doneAt].every((x) => typeof x === 'number')).toBe(true);
    expect(s.after).toBeNull();
  });
});

describe('review IMPORTANT-2 history names the lane of each event', () => {
  const laneRow = (name: string) => {
    insertSession(db, { id: `s${name}`, projectId: 'p1', kind: 'lane', account: null });
    return insertLane(db, { projectId: 'p1', name, cwd: `/r/${name}`, sessionId: `s${name}`, ownerSession: null }).id;
  };

  test('§4.3 taken D2 → returned D2 → taken D5: each event carries its own lane name, not the current lane', () => {
    const d2 = laneRow('D2'), d5 = laneRow('D5');
    const i = issue();
    takeIssue(db, i.id, d2, null);
    releaseIssue(db, i.id, 'lane D2 kết thúc');
    takeIssue(db, i.id, d5, null);
    const ev = projectIssues(db, 'p1', ports).issues.find((x) => x.id === i.id)!.events;
    expect(ev.filter((e) => e.type !== 'created').map((e) => [e.type, e.data.lane])).toEqual([['taken', 'D2'], ['returned', 'D2'], ['taken', 'D5']]);
  });

  test('§4.3 an event whose lane row is gone shows no lane (null), never another lane', () => {
    const d2 = laneRow('D2');
    const i = issue();
    takeIssue(db, i.id, d2, null);
    db.query('UPDATE issue_event SET json = ? WHERE issue_id = ? AND type = ?').run(JSON.stringify({ lane: 999 }), i.id, 'taken');
    const ev = projectIssues(db, 'p1', ports).issues.find((x) => x.id === i.id)!.events;
    expect(ev.find((e) => e.type === 'taken')!.data.lane).toBeNull();
  });
});
