// v2.1 §4.14 pure session / ownership rules on an in-memory state.db: seq numbering, owner lookups, messages, migration.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MIGRATIONS, insertLane, insertProject, insertSession, migrate, openDb, type Db } from '../../src/db.ts';
import {
  adoptOrphans, designTitle, sinceStop, nameTakenText, nextSeq, notOwnerText, ownerOf, parallelFirstText, seqOf, sessionTitle,
} from '../../src/orchestrator/owners.ts';
import { capReached, countedSessions, MAX_SESSIONS } from '../../../shared/issues.ts';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'shop', path: '/r/shop' });
  insertProject(db, { id: 'p2', name: 'blog', path: '/r/blog' });
});
afterEach(() => db.close());

const orch = (id: string, projectId = 'p1', seq?: number) => {
  insertSession(db, { id, projectId, kind: 'orchestrator', account: 'o@x' });
  if (seq !== undefined) db.query('UPDATE session SET seq = ? WHERE id = ?').run(seq, id);
};

describe('§4.14 session numbering', () => {
  test('§4.14 seq starts at 1 per project and is never reused (an ended #2 still holds its number)', () => {
    expect(nextSeq(db, 'p1')).toBe(1);
    orch('s1', 'p1', 1);
    orch('s2', 'p1', 2);
    db.query("UPDATE session SET ended_at = 5, state = 'done' WHERE id = 's2'").run();
    expect(nextSeq(db, 'p1')).toBe(3);
    expect(nextSeq(db, 'p2')).toBe(1);
    expect(seqOf(db, 's2')).toBe(2);
    expect(seqOf(db, 'nope')).toBeNull();
  });

  test('§4.14 lane sessions do not take an orchestrator number', () => {
    orch('s1', 'p1', 1);
    insertSession(db, { id: 'l1', projectId: 'p1', kind: 'lane', account: 'a@x' });
    db.query("UPDATE session SET seq = 9 WHERE id = 'l1'").run();
    expect(nextSeq(db, 'p1')).toBe(2);
  });

  test('§5.0 R34 cap is 3 Thiết kế / Build sessions', () => { expect(MAX_SESSIONS).toBe(3); });
  test('§5.0 R34 only design + build count; the one Chung never does (a pre-v2.7 extra general does)', () => {
    expect(countedSessions(['general'])).toBe(0);
    expect(countedSessions(['general', 'build', 'build', 'design'])).toBe(3);
    expect(countedSessions(['general', 'general', 'general'])).toBe(2);
    expect(countedSessions([])).toBe(0);
  });
  test('§5.0 R34 2 build + 1 design + Chung open → a 4th design / build refused; a Chung next to none / to them is not', () => {
    const open = ['general', 'build', 'build', 'design'] as const;
    expect(capReached(open, 'design')).toBe(true);
    expect(capReached(open, 'build')).toBe(true);
    expect(capReached(['build', 'build', 'design'], 'general')).toBe(false); // the project's one Chung is never counted
    expect(capReached(['general', 'build', 'design'], 'design')).toBe(false);
    expect(capReached(['general', 'general', 'general', 'general'], 'general')).toBe(true); // pre-v2.7 parallel generals: 3 extra
  });
  test('§4.7 design session title "Thiết kế · HH:MM" in VN time (UTC+7)', () => {
    expect(designTitle(Date.UTC(2026, 10, 17, 2, 5))).toBe('Thiết kế · 09:05');
    expect(designTitle(Date.UTC(2026, 10, 17, 18, 30))).toBe('Thiết kế · 01:30');
  });

  test('§4.14 title: typed (trimmed) wins; empty → first 24 chars of the first message; neither → null', () => {
    expect(sessionTitle('  hotfix ', 'x')).toBe('hotfix');
    expect(sessionTitle('', 'Sửa lỗi thanh toán ở trang giỏ hàng hôm nay')).toBe('Sửa lỗi thanh toán ở tra');
    expect(sessionTitle(undefined, undefined)).toBeNull();
    expect(sessionTitle('  ', '  ')).toBeNull();
  });
});

describe('§4.14 lane ownership', () => {
  test('§5.3 sinceStop `at` crosses the protocol as epoch ms (done_at is stored in seconds)', () => {
    orch('s1', 'p1', 1);
    insertLane(db, { projectId: 'p1', name: 'D7', cwd: '/w/d7', ownerSession: 's1', state: 'done' });
    db.query("UPDATE lane SET done_at = 1763200000 WHERE name = 'D7'").run();
    db.query("INSERT INTO event (session_id, ts, type, json) VALUES ('s1', 1, 'handover', ?)").run(JSON.stringify({ lanes: ['D7'] }));
    expect(sinceStop(db, 's1')).toEqual([{ name: 'D7', kind: 'done', seq: 1, at: 1_763_200_000_000 }]);
  });

  test('§4.14 owner check message names the lane and its session', () => {
    expect(notOwnerText('D2', 3)).toBe('D2 thuộc #3; nhờ PO chuyển');
  });

  test('§4.14 duplicate lane name message names the owner; no owner → without it', () => {
    expect(nameTakenText('D7', 3)).toBe('Tên D7 đã có (thuộc #3)');
    expect(nameTakenText('D7', null)).toBe('Tên D7 đã có');
  });

  test('§4.14 default first message of a parallel session', () => {
    expect(parallelFirstText(2, 'shop')).toBe('Phiên song song #2 của shop. Gọi `lanes_list`; chỉ ra lệnh lane của mình.');
  });

  test('§4.14 ownerOf returns the owner session and its seq', () => {
    orch('s1', 'p1', 1);
    orch('s3', 'p1', 3);
    insertLane(db, { projectId: 'p1', name: 'D2', cwd: '/w/d2', ownerSession: 's3' });
    insertLane(db, { projectId: 'p1', name: 'D4', cwd: '/w/d4' });
    expect(ownerOf(db, 'p1', 'D2')).toEqual({ sessionId: 's3', seq: 3 });
    expect(ownerOf(db, 'p1', 'D4')).toBeNull();
    expect(ownerOf(db, 'p1', 'nope')).toBeNull();
  });

  test('§4.14 adoptOrphans: live lanes owned by an ended session (or nobody) move; done lanes and live owners stay', () => {
    orch('s1', 'p1', 1);
    orch('s2', 'p1', 2);
    orch('s3', 'p1', 3);
    db.query("UPDATE session SET ended_at = 5, state = 'done' WHERE id = 's1'").run();
    insertLane(db, { projectId: 'p1', name: 'A', cwd: '/w/a', ownerSession: 's1' });
    insertLane(db, { projectId: 'p1', name: 'B', cwd: '/w/b', ownerSession: 's2' });
    insertLane(db, { projectId: 'p1', name: 'C', cwd: '/w/c' });
    insertLane(db, { projectId: 'p1', name: 'Z', cwd: '/w/z', ownerSession: 's1', state: 'done' });
    expect(adoptOrphans(db, 'p1', 's3')).toEqual(['A', 'C']);
    expect(ownerOf(db, 'p1', 'A')?.sessionId).toBe('s3');
    expect(ownerOf(db, 'p1', 'B')?.sessionId).toBe('s2');
    expect(ownerOf(db, 'p1', 'Z')?.sessionId).toBe('s1');
  });
});

describe('§4.14 migration v12 → v13', () => {
  const v12 = () => {
    const old = new Database(':memory:', { strict: true });
    for (const m of MIGRATIONS.slice(0, 12)) old.exec(m);
    old.exec('PRAGMA user_version = 12');
    old.run("INSERT INTO project (id, name, path, created_at) VALUES ('p1','shop','/r/shop',1), ('p2','blog','/r/blog',1), ('p3','none','/r/none',1)");
    return old;
  };
  const sess = (old: Database, id: string, p: string, created: number, ended: number | null, kind = 'orchestrator') =>
    old.run('INSERT INTO session (id, project_id, kind, created_at, ended_at) VALUES (?, ?, ?, ?, ?)', [id, p, kind, created, ended]);
  const laneRow = (old: Database, p: string, name: string) =>
    old.run("INSERT INTO lane (project_id, name, cwd, state, created_at) VALUES (?, ?, ?, 'idle', 1)", [p, name, `/w/${p}/${name}`]);

  test('§4.14 v2 DB: seq by creation per project; lanes → newest unended orchestrator; none unended → newest', () => {
    const old = v12();
    sess(old, 'a1', 'p1', 10, 20);
    sess(old, 'a2', 'p1', 30, null);
    sess(old, 'a3', 'p1', 35, 36); // newer but ended: the unended a2 wins
    sess(old, 'l1', 'p1', 31, null, 'lane');
    sess(old, 'b1', 'p2', 10, 20);
    sess(old, 'b2', 'p2', 40, 50);
    laneRow(old, 'p1', 'D1');
    laneRow(old, 'p2', 'E1');
    laneRow(old, 'p3', 'F1');
    migrate(old);
    const seqs = old.query<{ id: string; seq: number | null }, []>('SELECT id, seq FROM session ORDER BY id').all();
    expect(seqs).toEqual([{ id: 'a1', seq: 1 }, { id: 'a2', seq: 2 }, { id: 'a3', seq: 3 }, { id: 'b1', seq: 1 }, { id: 'b2', seq: 2 }, { id: 'l1', seq: null }]);
    const owners = old.query<{ name: string; owner_session: string | null }, []>('SELECT name, owner_session FROM lane ORDER BY name').all();
    expect(owners).toEqual([{ name: 'D1', owner_session: 'a2' }, { name: 'E1', owner_session: 'b2' }, { name: 'F1', owner_session: null }]);
    const cols = old.query<{ name: string }, []>('PRAGMA table_info(session)').all().map((c) => c.name);
    for (const c of ['seq', 'title', 'end_reason', 'handoff_path', 'ctx_last']) expect(cols).toContain(c);
    old.close();
  });
});
