// Engine sessions (spec v2.1 §4.14): session → target, history sessions, in-turn PO messages, "Chạy tiếp lane".
import type { LaneView, Target, SessionsList } from '../../../shared/protocol.ts';
import { listSessions, sessionTarget } from '../server/session-views.ts';
import { getLane } from '../db.ts';
import { PREFIX } from '../outbox.ts';
import { paths } from '../paths.ts';
import { cleanupPeriodDays } from '../orchestrator/resume.ts';
import { laneContinuedText, laneContinueText, prepareContinue, type ContinueDeps } from '../lane/continue.ts';
import { SessionError } from '../orchestrator/owners.ts';
import type { Engine } from '../engine.ts';

export function markInTurn(eng: Engine, sessionId: string, content: string): void {
  const list = eng.inTurnSent.get(sessionId) ?? [];
  list.push(content);
  eng.inTurnSent.set(sessionId, list.slice(-20));
}

export function targetOfSession(eng: Engine, sid: string | null): Target | null {
  return sessionTarget(sid, (x) => eng.lanes.bySession(x), (x) => eng.orchestrators.bySession(x));
}

/**
 * Session ids whose lines make up a target's history. v2.1 §4.14: an orchestrator target is one session only (its
 * `sessionId`, else the project's first running session, else its newest) — no more merging every session; each
 * session's history carries its own start / end boundary lines.
 */
export function sessionsOf(eng: Engine, t: Target): string[] {
  if (t.kind === 'lane') {
    const l = getLane(eng.db, t.projectId, t.name);
    return l?.sessionId ? [l.sessionId] : [];
  }
  if (t.sessionId !== undefined) {
    const ok = eng.db.query("SELECT 1 FROM session WHERE id = ? AND project_id = ? AND kind = 'orchestrator'").get(t.sessionId, t.projectId);
    return ok ? [t.sessionId] : [];
  }
  const live = eng.orchestrators.get(t.projectId);
  if (live) return [live.currentSessionId];
  const r = eng.db.query<{ id: string }, [string]>(
    "SELECT id FROM session WHERE project_id = ? AND kind = 'orchestrator' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(t.projectId);
  return r ? [r.id] : [];
}

/** v2.1 §4.14 / §4.15 what "Chạy tiếp lane" needs: git in the project repo, the shared transcript home. */
export function continueDeps(eng: Engine): ContinueDeps {
  return { db: eng.db, exec: eng.gitExec, claudeHome: paths().claudeHome, repoOf: (id) => eng.projectRow(id)?.path ?? null,
    busy: () => eng.orchestrators.busyAccounts() };
}

/**
 * §4.14 "Chạy tiếp lane": checks (branch not merged / gone, transcript there), rebuilds a removed worktree from the lane
 * branch, then the lane leaves Xong under `toSession` (`--resume` of its own session) and that session is told.
 */
export async function continueLane(eng: Engine, projectId: string, name: string, toSession: string, account?: string): Promise<LaneView> {
  const to = eng.orchestrators.route(toSession);
  if (!to || to.projectId !== projectId) throw new SessionError('no_session', { key: 'errors.noSession', params: { id: toSession } });
  const prep = await prepareContinue(eng.continueDeps(), projectId, name);
  eng.lanes.reopen(projectId, name, { ownerSession: to.currentSessionId, account: account ?? prep.account, text: laneContinueText(to.view().seq ?? null, prep.rebuilt) });
  await to.send(laneContinuedText(name), PREFIX.engine);
  const v = eng.laneView(projectId, name)!;
  eng.hub.broadcast({ type: 'lane', lane: v });
  return v;
}

/** v2.1 §4.14 `sessions_list`: running (open order, live state) then ended (newest first). */
export function sessionsList(eng: Engine, projectId: string): SessionsList {
  const live = new Map(eng.orchestrators.list(projectId).map((o) => [o.currentSessionId, o.view()] as const));
  return listSessions(eng.db, projectId, live, (id) => eng.orchestrators.resumability(id), cleanupPeriodDays(paths().claudeHome));
}
