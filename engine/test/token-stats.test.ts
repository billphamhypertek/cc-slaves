import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZERO_TOKENS, type TokenCounts } from '../../shared/protocol.ts';
import { insertEvent, insertLane, insertProject, insertRun, insertSession, laneTokens, openDb, sessionTokens, tokensSince, costSince, type Db } from '../src/db.ts';
import { localMidnight, tokenStats } from '../src/stats.ts';

let tmp: string;
let db: Db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-tok-'));
  db = openDb(join(tmp, 'state.db'));
  insertProject(db, { id: 'p1', name: 'one', path: '/r/one' });
  insertProject(db, { id: 'p2', name: 'two', path: '/r/two' });
  insertSession(db, { id: 's1', projectId: 'p1', kind: 'lane', account: 'a@x' });
  insertSession(db, { id: 's2', projectId: 'p2', kind: 'orchestrator', account: 'a@x' });
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const T = (input: number, output = 0, cacheWrite = 0, cacheRead = 0): TokenCounts => ({ input, output, cacheWrite, cacheRead });
const res = (sessionId: string, ts: number, usage: TokenCounts | null, turnCost = 0) =>
  insertEvent(db, { sessionId, type: 'result', ts, json: { turnCost, totalCostUsd: null, ...(usage ? { usage } : {}) } });

// 2026-03-10 local time; midnight = 00:00 local that day
const DAY = new Date(2026, 2, 10, 0, 0, 0, 0).getTime();
const H = 3_600_000;

describe('§5.3 token persistence in the stored result event', () => {
  test('§5.3 tokensSince sums the four counts of results at/after the cut, per project when asked', () => {
    res('s1', DAY - 1, T(1000, 1000, 1000, 1000)); // yesterday 23:59:59.999
    res('s1', DAY, T(1, 2, 3, 4));
    res('s2', DAY + H, T(10, 20, 30, 40));
    res('s1', DAY + 2 * H, null); // a pre-v2.1 row has no usage
    expect(tokensSince(db, DAY)).toEqual(T(11, 22, 33, 44));
    expect(tokensSince(db, DAY, 'p1')).toEqual(T(1, 2, 3, 4));
    expect(tokensSince(db, DAY, 'nope')).toEqual(ZERO_TOKENS);
  });

  test('§5.3 costSince filters by project like tokensSince', () => {
    res('s1', DAY, null, 0.25);
    res('s2', DAY, null, 0.5);
    expect(costSince(db, DAY)).toBeCloseTo(0.75);
    expect(costSince(db, DAY, 'p2')).toBeCloseTo(0.5);
  });

  test('§5.3 W10 laneTokens = every session of the lane (lane row + its runs), sessionTokens = the given ones', () => {
    insertSession(db, { id: 's1b', projectId: 'p1', kind: 'lane', account: 'b@x' });
    const id = insertLane(db, { projectId: 'p1', name: 'D1', cwd: '/w/d1', sessionId: 's1' }).id;
    insertRun(db, { sessionId: 's1', laneId: id, n: 1, account: 'a@x' });
    insertRun(db, { sessionId: 's1', laneId: id, n: 2, account: 'b@x' }); // account switch, same session
    insertRun(db, { sessionId: 's1b', laneId: id, n: 3, account: 'b@x' });
    res('s1', DAY, T(1, 1, 1, 1));
    res('s1b', DAY, T(2, 2, 2, 2));
    res('s2', DAY, T(100));
    expect(laneTokens(db, id)).toEqual(T(3, 3, 3, 3));
    expect(sessionTokens(db, ['s2'])).toEqual(T(100));
    expect(sessionTokens(db, [])).toEqual(ZERO_TOKENS);
  });

  test('§5.3 v14 the today / 5 h sums search event(type, ts) instead of scanning the table', () => {
    const plan = db.query<{ detail: string }, []>(
      "EXPLAIN QUERY PLAN SELECT 1 FROM event e JOIN session s ON s.id = e.session_id WHERE e.type IN ('result', 'usage') AND e.ts >= 0 AND s.project_id = 'p1'").all();
    expect(plan.map((r) => r.detail).join(' | ')).toContain('USING INDEX event_type_ts');
  });

  test('§5.3 a turn cut short (stored `usage` event) counts in today / 5 h and in the session / lane totals; cost does not', () => {
    const id = insertLane(db, { projectId: 'p1', name: 'D1', cwd: '/w/d1', sessionId: 's1' }).id;
    res('s1', DAY, T(1, 1, 1, 1), 0.25);
    insertEvent(db, { sessionId: 's1', type: 'usage', ts: DAY + H, json: { run: 1, usage: T(1000, 500) } });
    insertEvent(db, { sessionId: 's1', type: 'line', ts: DAY + H, json: { usage: T(7) } }); // other event types never count
    expect(tokensSince(db, DAY)).toEqual(T(1001, 501, 1, 1));
    expect(tokensSince(db, DAY, 'p1')).toEqual(T(1001, 501, 1, 1));
    expect(sessionTokens(db, ['s1'])).toEqual(T(1001, 501, 1, 1));
    expect(laneTokens(db, id)).toEqual(T(1001, 501, 1, 1));
    expect(costSince(db, DAY)).toBeCloseTo(0.25);
  });
});

describe('§5.3 tokenStats (today / 5 h)', () => {
  test('§5.3 "today" = local midnight', () => {
    expect(localMidnight(DAY + 23 * H)).toBe(DAY);
    expect(localMidnight(DAY)).toBe(DAY);
    expect(localMidnight(DAY - 1)).toBe(new Date(2026, 2, 9).getTime());
  });

  test('§5.3 today rolls to 0 over midnight (injected clock)', () => {
    res('s1', DAY + 23 * H, T(5, 5, 5, 5), 0.1);
    const before = tokenStats(db, DAY + 23.5 * H, ['p1', 'p2']);
    expect(before.projects.p1).toEqual({ tokensToday: T(5, 5, 5, 5), costTodayUsd: 0.1 });
    expect(before.projects.p2).toEqual({ tokensToday: ZERO_TOKENS, costTodayUsd: 0 });
    const after = tokenStats(db, DAY + 24 * H + 1, ['p1', 'p2']);
    expect(after.projects.p1).toEqual({ tokensToday: ZERO_TOKENS, costTodayUsd: 0 });
    expect(after.tokens5h).toEqual(T(5, 5, 5, 5)); // 5 h window does not care about midnight
  });

  test('§5.3 5 h window edge: a result exactly 5 h old counts, 1 ms older does not', () => {
    const now = DAY + 10 * H;
    res('s1', now - 5 * H, T(1));
    res('s2', now - 5 * H - 1, T(1000));
    res('s2', now, T(0, 2));
    expect(tokenStats(db, now, ['p1', 'p2']).tokens5h).toEqual(T(1, 2));
  });

  test('§5.3 W10 live provisional turn counts toward today and 5 h of its project', () => {
    const s = tokenStats(db, DAY + H, ['p1', 'p2'], [{ projectId: 'p2', tokens: T(7, 0, 1, 9) }]);
    expect(s.projects.p2!.tokensToday).toEqual(T(7, 0, 1, 9));
    expect(s.projects.p1!.tokensToday).toEqual(ZERO_TOKENS);
    expect(s.tokens5h).toEqual(T(7, 0, 1, 9));
    expect(s.at).toBe(DAY + H);
  });
});

describe('§5.3 "today" follows the machine clock, not UTC', () => {
  test('§5.3 local midnight in a +07 zone (bun test runs in UTC, so the zone is pinned here)', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    try {
      const local = new Date(2026, 2, 10, 0, 0, 0, 0).getTime(); // 2026-03-09T17:00Z
      expect(local).toBe(Date.UTC(2026, 2, 9, 17));
      expect(localMidnight(local + 3 * H)).toBe(local); // 03:00 local = 20:00Z the day before
      res('s1', local - 1, T(9)); // 23:59:59 local yesterday (but the same UTC day)
      res('s1', local + H, T(1));
      expect(tokenStats(db, local + 2 * H, ['p1']).projects.p1!.tokensToday).toEqual(T(1));
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });
});
