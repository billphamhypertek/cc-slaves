// Engine views (spec §4.14, §4.15, §5.3): project / lane / engine / snapshot / health views and the token stats.
import { existsSync } from 'node:fs';
import { isOrchSource, PROTOCOL_VERSION, type Channel, type EngineInfo, type Health, type LaneView, type ProjectView, type Snapshot, type TokenStats, type CardView, type OrchestratorView } from '../../../shared/protocol.ts';
import { remoteCard } from '../../../shared/issues.ts';
import { cardSeq } from '../server/session-views.ts';
import { seqOf } from '../orchestrator/owners.ts';
import type { Card } from '../cards/store.ts';
import { costSince, getLane, getMeta, getSessionModel, laneTokens, sessionCost, type Db } from '../db.ts';
import { tokenStats } from '../stats.ts';
import type { OrchestratorView as OrchestratorRtView } from '../orchestrator/session.ts';
import { cardView, laneView, orchestratorView, projectView } from '../server/views.ts';
import type { Conn } from '../server/ws.ts';
import type { Engine } from '../engine.ts';
import { laneWf, projectWorkflowFallback, projectWorkflowId, sessionWf } from '../workflow/runtime.ts';

const nowS = () => Math.floor(Date.now() / 1000);

/** §4.15 / §4.8 the project view with its "n chưa merge" count. */
export function buildProjectView(eng: Engine, id: string): ProjectView | null {
  const r = eng.projectRow(id);
  return r ? { ...projectView(r), unmerged: eng.branches.unmergedCount(id), held: eng.held.view(id), specsImported: eng.issues.importedNotice(id), workflow: projectWorkflowId(eng.db, id), workflowFallback: projectWorkflowFallback(eng.db, id) } : null;
}

/** §4.15 a done-lane view opened (watch): re-measure its branch when older than 60 s. */
export function branchOnWatch(eng: Engine, projectId: string, name: string): void {
  const l = getLane(eng.db, projectId, name);
  if (l && (l.state === 'done' || l.phase === 'done')) void eng.branches.measureIfStale(l);
}

/** §4.15 / §5.3 epoch ms: a done lane's done time (before v12: its creation), else its last event (else its creation). */
function laneUpdatedAt(eng: Engine, laneId: number): number {
  return eng.db.query<{ at: number }, [number]>(
    `SELECT CASE WHEN l.state = 'done' THEN COALESCE(l.done_at, l.created_at) * 1000
       ELSE COALESCE((SELECT MAX(ts) FROM event WHERE session_id = l.session_id), l.created_at * 1000) END AS at
     FROM lane l WHERE l.id = ?`,
  ).get(laneId)!.at;
}

/** v2.4 §5.6 the last model / effort read for a lane's session (a done lane shows it, Y33). */
function lastRun(db: Db, sessionId: string | null): LaneView['run'] | null {
  const m = sessionId ? getSessionModel(db, sessionId) : null;
  return m?.lastModel ? { model: m.lastModel, ...(m.lastModelName !== null ? { modelName: m.lastModelName } : {}), effort: m.lastEffort } : null;
}

export function buildLaneView(eng: Engine, projectId: string, name: string): LaneView | null {
  const l = getLane(eng.db, projectId, name);
  if (!l) return null;
  const runs = eng.db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM run WHERE lane_id = ?').get(l.id)!.n;
  const rt = eng.lanes.get(projectId, name);
  const v = laneView(l, rt, {
    worktreeExists: existsSync(l.cwd), switches: Math.max(0, runs - 1), updatedAt: laneUpdatedAt(eng, l.id),
    ...(rt ? {} : { tokens: laneTokens(eng.db, l.id), run: lastRun(eng.db, l.sessionId) }), // §5.3 / v2.4 §5.6 no runtime: stored values
    branch: eng.branches.info(l.id),
  });
  const owner = l.ownerSession ?? null; // §4.14 the owner session and its #n
  const wf = laneWf(eng.db, projectId, name);
  return { ...v, ownerSession: owner, ownerSeq: owner ? seqOf(eng.db, owner) : null, ...(wf ? { wf } : {}) };
}

export function engineInfo(eng: Engine): EngineInfo {
  const cost = costSince(eng.db, new Date(new Date().toDateString()).getTime()); // local midnight, epoch ms like event.ts
  return {
    version: eng.o.version, protocol: PROTOCOL_VERSION, claudePath: eng.login.claudePath,
    claudeVersion: eng.claudeVersion ?? eng.setup?.claude.version ?? null, shellEnvOk: !eng.login.shellFailed,
    startedAt: eng.startedAt, costTodayUsd: Math.round(cost * 10_000) / 10_000, remote: { enabled: false, hostname: null },
    setupNeeded: eng.setup !== null && !eng.setup.done,
    ccUpdated: eng.compat ? `${eng.compat.version}: ${eng.compat.message}` : null,
    update: eng.update.view(),
  };
}

/** §4.15 snapshot lanes: every live lane + the lanes done in the last 7 days (before v12: created), creation order. */
export function snapshotLaneKeys(db: Db, now: number): { project_id: string; name: string }[] {
  return db.query<{ project_id: string; name: string }, [number]>(
    `SELECT l.project_id, l.name FROM lane l JOIN project p ON p.id = l.project_id
     WHERE p.closed_at IS NULL AND (l.state <> 'done' OR COALESCE(l.done_at, l.created_at) > ?) ORDER BY l.id`,
  ).all(now - 7 * 86_400);
}

/** §4.15 the snapshot's lanes (of one project when given). */
export function snapshotLanes(eng: Engine, projectId?: string): LaneView[] {
  return snapshotLaneKeys(eng.db, nowS()).filter((r) => projectId === undefined || r.project_id === projectId)
    .map((r) => eng.laneView(r.project_id, r.name)).filter((v): v is LaneView => v !== null);
}

export function snapshot(eng: Engine, channel: Channel): Snapshot {
  const lanes = snapshotLanes(eng);
  const rows = eng.projectRows();
  const open = new Set(rows.map((p) => p.id)); // hotfix 2026-11-16 a closed project's cards stay out too
  const orchestrators = rows.flatMap((p) => eng.orchestrators.list(p.id)).map((o) => eng.orchView(o.view()));
  const cards = eng.cards.list().filter((c) => (c.projectId === null || open.has(c.projectId)) && (c.status === 'open' || (c.resolvedAt ?? 0) > nowS() - 3600)).map((c) => (channel === 'mac' ? eng.cardViewOf(c) : remoteCard(eng.cardViewOf(c)))); // v2.7 §8
  return {
    engine: eng.engineInfo(), channel, projects: rows.map((r) => buildProjectView(eng, r.id)!), orchestrators, lanes,
    accounts: eng.accountViews(), cards, config: eng.configView(), setup: eng.setup, login: eng.loginView,
    stats: eng.tokenStats(), quota: eng.tracker.state(),
    ...(channel === 'mac' ? { skillsMcp: eng.skillsMcp.view(), toolkit: eng.toolkit.view(), ...(eng.graphModule ? { graph: eng.graphModule.view() } : {}), workflows: eng.workflows.list(), drafts: eng.authors.list(), issues: rows.map((r) => eng.issues.view(r.id)).filter((v) => v !== null) } : {}),
  };
}

/** v2.1 §5.3 today (per project) / 5 h (engine) tokens: stored results + running turns' provisional part. */
export function buildTokenStats(eng: Engine, nowMs = Date.now()): TokenStats {
  const live = [...eng.lanes.provisionalTokens(), ...eng.orchestrators.provisionalTokens()];
  return tokenStats(eng.db, nowMs, eng.projectRows().map((p) => p.id), live);
}

/** v2.1 W9 `watch`: send the connection the current subagents it may get (local: every lane of the project). */
export function pushSubagents(eng: Engine, c: Conn): void {
  const w = c.watch;
  if (w === null) return;
  const lists = c.channel === 'mac' ? eng.subagents.forProject(w.projectId)
    : w.kind === 'lane' ? [{ target: w, subagents: eng.subagents.list(w) }] : [];
  for (const x of lists) c.send({ type: 'event', event: { type: 'subagents', target: x.target, subagents: x.subagents } });
}

/** `Snapshot.config` and the `config` event: config.json + caps + the PO email. */
export function configView(eng: Engine): Record<string, unknown> {
  return { ...eng.config, caps: eng.caps, poEmail: getMeta(eng.db, 'po_email') };
}

/** `GET /healthz` for the menu bar (N8): no WebSocket, no token — localhost only, no message text. */
export function health(eng: Engine): Health {
  const open = new Set(eng.projectRows().map((p) => p.id)); // A-M2 a closed project's cards are not counted
  return {
    version: eng.o.version, startedAt: eng.startedAt,
    lanes: eng.lanes.listAll().map((v) => ({ name: v.name, state: v.state, phase: v.phase ?? null })),
    openCards: eng.cards.list({ status: 'open' }).filter((c) => c.kind !== 'shared_cfg_new' && (c.projectId === null || open.has(c.projectId))).length, remote: { enabled: false, hostname: null },
  };
}

/** v2.1 §4.14 `OrchestratorView` + its session id, #n and title; tok · $ of that orchestrator only. */
export function orchView(eng: Engine, v: OrchestratorRtView): OrchestratorView {
  const m = { modelName: v.modelName, effort: v.effort, modelPick: v.modelPick, effortPick: v.effortPick, pending: v.pending, modelMismatch: v.modelMismatch };
  const model = Object.fromEntries(Object.entries(m).filter(([, x]) => x !== undefined)) as Partial<typeof m>; // §5.5 v2.4 fields
  const orchKind = eng.orchestrators.bySession(v.sessionId)?.kind; // R-B13 (e)
  const wf = sessionWf(eng.db, v.sessionId); // v2.9 §4.7
  return { ...orchestratorView(v, sessionCost(eng.db, v.sessionId)), sessionId: v.sessionId, seq: v.seq ?? null, title: v.title ?? null, ...model, ...(orchKind ? { orchKind } : {}), ...(wf ? { wf } : {}) };
}

/** v2.1 §4.14 `card.session_id` + the #n of its orchestrator session; a lane source → that lane's owner now (I9: the card
 *  may come from an older session of the lane). */
export function cardViewOf(eng: Engine, c: Card): CardView {
  const v = cardView(c);
  const lane = v.source && !isOrchSource(v.source) && c.projectId ? getLane(eng.db, c.projectId, v.source) : null;
  const seq = lane?.ownerSession ? seqOf(eng.db, lane.ownerSession) : c.sessionId ? cardSeq(eng.db, c.sessionId) : null;
  return { ...v, sessionId: c.sessionId, seq };
}
