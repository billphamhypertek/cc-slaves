// Test-only state.db reads for integration tests (the engine itself never lists runs / events this way).
import type { Db } from '../src/db.ts';

export function listRuns(db: Db, laneId: number): { account: string | null; endedAt: number | null; endReason: string | null }[] {
  return db.query<{ account: string | null; ended_at: number | null; end_reason: string | null }, [number]>(
    'SELECT account, ended_at, end_reason FROM run WHERE lane_id = ? ORDER BY n',
  ).all(laneId).map((r) => ({ account: r.account, endedAt: r.ended_at, endReason: r.end_reason }));
}

export function listEvents(db: Db, sessionId: string, type: string): unknown[] {
  return db.query<{ json: string }, [string, string]>('SELECT json FROM event WHERE session_id = ? AND type = ? ORDER BY id')
    .all(sessionId, type).map((r) => JSON.parse(r.json) as unknown);
}
