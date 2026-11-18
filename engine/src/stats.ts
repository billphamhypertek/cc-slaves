// v2.1 §5.3 token stats: per project "today" (local midnight → now) and engine-wide last 5 hours, rebuilt from the
// stored `result` events (so they survive a restart, like `costSince`) plus the provisional part of running turns.
import { addTokens, type TokenCounts, type TokenStats } from '../../shared/protocol.ts';
import { costSince, tokensSince, type Db } from './db.ts';

const FIVE_HOURS_MS = 5 * 3_600_000;

/** Local (machine clock) midnight of the day containing `nowMs`. */
export function localMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** `live` = provisional (not yet `result`ed) tokens of running turns, by project. */
export function tokenStats(db: Db, nowMs: number, projectIds: readonly string[], live: readonly { projectId: string; tokens: TokenCounts }[] = []): TokenStats {
  const midnight = localMidnight(nowMs);
  let tokens5h = tokensSince(db, nowMs - FIVE_HOURS_MS);
  for (const l of live) tokens5h = addTokens(tokens5h, l.tokens);
  const projects: TokenStats['projects'] = {};
  for (const id of projectIds) {
    let t = tokensSince(db, midnight, id);
    for (const l of live) if (l.projectId === id) t = addTokens(t, l.tokens);
    projects[id] = { tokensToday: t, costTodayUsd: Math.round(costSince(db, midnight, id) * 10_000) / 10_000 };
  }
  return { at: nowMs, tokens5h, projects };
}
