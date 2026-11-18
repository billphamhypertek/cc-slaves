// v2.7 §4.3 / §10.1 the wire views of a project's specs and issues (protocol 6, `shared/issues.ts`): what the Tasks tab
// lists and the detail shows — blocked-by / waiting-on / blocks, the lane with its live state, commits, history, progress.
// Reads the store; the engine area (`engine/issues.ts`) supplies the live lane state and the file checks.
import type { Db } from '../db.ts';
import { progressOf, type IssueInfo, type IssueRow, type ProjectIssues, type SpecInfo, type SpecOverview, type SpecRow } from '../../../shared/issues.ts';
import { issueViews, listCommits, listEvents, listFiles, listSpecs, projectDeps } from './store.ts';

export interface IssueViewPorts {
  /** The lane row `id` with its live state + phase (runtime first, else the row); null = no such lane. */
  lane: (laneId: number) => { name: string; state: string; phase: string | null } | null;
  /** §5.2-7 the spec file is still on disk. */
  exists: (path: string) => boolean;
  /** §4.8 the "7 nhóm · G0–G6" summary of a spec file (read only for draft / approved). */
  groups: (path: string) => string | null;
  /** R-B14 an orchestrator session's title + state now (`waiting_po` = an open PO card of it); null = no such row. */
  session: (sessionId: string) => { title: string | null; state: 'running' | 'waiting_po' | 'closed' } | null;
}

/** Review IMPORTANT-2 `taken` / `returned` store the lane row id: the history names that lane (null = its row is gone),
 *  mapped at read so the rows need no migration. */
export function eventData(data: Record<string, unknown>, nameOf: (laneId: number) => string | null): Record<string, unknown> {
  return typeof data.lane === 'number' ? { ...data, lane: nameOf(data.lane) } : data;
}

/** R-B14 (D99) the overview card data of an `active` / `done` spec (IS22 / IS22b). */
function overviewOf(db: Db, s: SpecRow, mine: readonly IssueRow[], p: IssueViewPorts): SpecOverview | null {
  if (s.state !== 'active' && s.state !== 'done') return null;
  const sess = s.buildSession === null ? null : p.session(s.buildSession);
  const amends = mine.filter((i) => i.source === 'amend' && i.state !== 'cancelled');
  const lanes = mine.filter((i) => i.state === 'doing' && i.laneId !== null).flatMap((i) => {
    const l = p.lane(i.laneId!);
    return l ? [{ name: l.name, key: i.key, state: l.state, phase: l.phase }] : [];
  });
  return {
    buildSession: s.buildSession === null ? null : { id: s.buildSession, title: sess?.title ?? null, state: sess?.state ?? 'closed' },
    lanes,
    lastAmend: s.amendRev > 0 ? { rev: s.amendRev, issueCount: amends.length, at: amends.length ? Math.max(...amends.map((i) => i.createdAt)) : null } : null,
    commits: db.query<{ n: number }, [number]>('SELECT COUNT(DISTINCT c.sha) AS n FROM issue_commit c JOIN issue i ON i.id = c.issue_id WHERE i.spec_id = ?').get(s.id)!.n,
    mergedInto: s.state === 'done' ? 'main' : null,
  };
}

function specInfo(db: Db, s: SpecRow, all: readonly SpecRow[], issues: readonly IssueRow[], p: IssueViewPorts): SpecInfo {
  const after = s.afterId === null ? null : all.find((x) => x.id === s.afterId) ?? null;
  const exists = p.exists(s.path);
  const mine = issues.filter((i) => i.specId === s.id);
  return {
    id: s.id, projectId: s.projectId, path: s.path, title: s.title, state: s.state,
    after: after ? { id: after.id, path: after.path, title: after.title, state: after.state } : null,
    branch: s.branch, sessions: { design: s.designSession, build: s.buildSession, edit: s.editSession },
    origin: s.origin, outsideBuild: s.outsideBuild, resumed: s.resumed, amendRev: s.amendRev, missing: !exists,
    groups: exists && (s.state === 'draft' || s.state === 'approved') ? p.groups(s.path) : null,
    editing: s.editSession !== null, progress: progressOf(mine),
    approvedAt: s.approvedAt, openedAt: s.openedAt, doneAt: s.doneAt, createdAt: s.createdAt, overview: overviewOf(db, s, mine, p),
    workflowRev: s.workflowRev, step: s.step,
  };
}

/** Every spec and issue of one project, as the snapshot carries them. */
export function projectIssues(db: Db, projectId: string, p: IssueViewPorts): ProjectIssues {
  const views = issueViews(db, projectId);
  const rows = views.map((v) => v.issue);
  const keyOf = new Map(rows.map((i) => [i.id, i.key]));
  const deps = projectDeps(db, projectId);
  const specs = listSpecs(db, projectId);
  const laneName = (id: number | null) => (id === null ? null : p.lane(id)?.name ?? null);
  const issues = views.map(({ issue: i, priority, blockedBy: waitingOn }): IssueInfo => ({
    id: i.id, projectId: i.projectId, key: i.key, kind: i.kind, specId: i.specId, title: i.title, body: i.body,
    doneWhen: i.doneWhen, state: i.state, revert: i.revert, priority, waitingOn,
    blockedBy: deps.filter((d) => d.issueId === i.id).map((d) => keyOf.get(d.blockedById)!).filter(Boolean),
    blocks: deps.filter((d) => d.blockedById === i.id).map((d) => keyOf.get(d.issueId)!).filter(Boolean),
    lane: i.laneId === null ? null : p.lane(i.laneId), commits: listCommits(db, i.id),
    source: i.source, sourceLane: laneName(i.sourceLane), sourceIssue: i.sourceIssue === null ? null : keyOf.get(i.sourceIssue) ?? null,
    reverts: i.reverts === null ? null : keyOf.get(i.reverts) ?? null,
    poSeen: i.poSeen, poOk: i.poOk, cancelReason: i.cancelReason,
    files: listFiles(db, i.id).map((f) => ({ id: f.id, name: f.name, size: f.size })),
    events: listEvents(db, i.id).map((e) => ({ ts: e.ts, type: e.type, data: eventData(e.data, laneName) })),
    createdAt: i.createdAt, doneAt: i.doneAt,
  }));
  return {
    projectId, specs: specs.map((s) => specInfo(db, s, specs, rows, p)), issues,
    outside: progressOf(rows.filter((i) => i.specId === null)),
  };
}
