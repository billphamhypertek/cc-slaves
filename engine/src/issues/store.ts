// v2.7 spec / issue store (spec §5.1–§5.7): CRUD over the v23 tables + the derived views (blocked, priority, ready order,
// unseen). It enforces invariants only (state machines, one counter per project); the §5.5 refusals live in rules.ts.
import type { Db } from '../db.ts';
import {
  issueKey, normTitle, parseIssueKey,
  type IssueCommit, type IssueKind, type IssueRow, type IssueSource, type IssueState, type OrchKind, type RevertState, type SpecGuess, type SpecOrigin, type SpecRow, type SpecState,
} from '../../../shared/issues.ts';
import { readyOrder, specMoveOk, viewIssues, type DepEdge, type IssueView } from './rules.ts';

type SqlVal = string | number | null;

// ---------- spec ----------
interface SpecDb {
  id: number; project_id: string; path: string; title: string; state: SpecState; after_id: number | null; branch: string | null;
  step_session: string | null; build_session: string | null; edit_session: string | null; origin: SpecOrigin;
  outside_build: number; resumed: number; amend_rev: number; approved_at: number | null; opened_at: number | null;
  done_at: number | null; created_at: number; workflow_rev: string; step: string | null;
}
const toSpec = (r: SpecDb): SpecRow => ({
  id: r.id, projectId: r.project_id, path: r.path, title: r.title, state: r.state, afterId: r.after_id, branch: r.branch,
  designSession: r.step_session, buildSession: r.build_session, editSession: r.edit_session, origin: r.origin,
  outsideBuild: r.outside_build === 1, resumed: r.resumed === 1, amendRev: r.amend_rev, approvedAt: r.approved_at,
  openedAt: r.opened_at, doneAt: r.done_at, createdAt: r.created_at, workflowRev: r.workflow_rev, step: r.step,
});

/** Imported specs guess their state once (§5.2-7, `SpecGuess`); app specs start `draft`. v2.9 §6.1 pinned to `workflowRev`
 * (left out: the DB default, the first `builtin:po` rev) at doc step `step` (§5.3). */
export interface NewSpec extends Partial<SpecGuess> {
  projectId: string; path: string; title: string; origin: SpecOrigin; designSession?: string | null; workflowRev?: string; step?: string | null;
}

export function insertSpec(db: Db, s: NewSpec, now = Date.now()): SpecRow {
  const state = s.state ?? 'draft';
  return toSpec(db.query<SpecDb, SqlVal[]>(
    `INSERT INTO spec (project_id, path, title, state, origin, outside_build, step_session, approved_at, created_at, step${s.workflowRev ? ', workflow_rev' : ''})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${s.workflowRev ? ', ?' : ''}) RETURNING *`,
  ).get(s.projectId, s.path, s.title, state, s.origin, s.outsideBuild ? 1 : 0, s.designSession ?? null,
    state === 'approved' ? now : null, now, s.step ?? null, ...(s.workflowRev ? [s.workflowRev] : []))!);
}

export function getSpec(db: Db, id: number): SpecRow | null {
  const r = db.query<SpecDb, [number]>('SELECT * FROM spec WHERE id = ?').get(id);
  return r ? toSpec(r) : null;
}

export function getSpecByPath(db: Db, projectId: string, path: string): SpecRow | null {
  const r = db.query<SpecDb, [string, string]>('SELECT * FROM spec WHERE project_id = ? AND path = ?').get(projectId, path);
  return r ? toSpec(r) : null;
}

export function listSpecs(db: Db, projectId: string): SpecRow[] {
  return db.query<SpecDb, [string]>('SELECT * FROM spec WHERE project_id = ? ORDER BY id').all(projectId).map(toSpec);
}

/** §5.2 state machine (rules.specMoveOk); stamps approved_at / opened_at / done_at (a `done` spec has no step, v2.9 §5.3).
 * Throws on a move the machine forbids. */
export function moveSpec(db: Db, id: number, to: SpecState, now = Date.now()): SpecRow {
  return db.transaction(() => {
    const cur = getSpec(db, id);
    if (!cur) throw new Error(`spec ${id} not found`);
    if (!specMoveOk(cur.state, to)) throw new Error(`spec ${cur.path}: ${cur.state} → ${to} not allowed`);
    const stamp = { draft: null, approved: 'approved_at', active: 'opened_at', done: 'done_at' }[to];
    db.query(`UPDATE spec SET state = ?${stamp ? `, ${stamp} = ?` : ''}${to === 'done' ? ', step = NULL' : ''} WHERE id = ?`).run(...(stamp ? [to, now, id] : [to, id]));
    return getSpec(db, id)!;
  })();
}

export interface SpecPatch {
  title?: string; path?: string; afterId?: number | null; branch?: string | null; designSession?: string | null;
  buildSession?: string | null; editSession?: string | null; outsideBuild?: boolean; resumed?: boolean; step?: string | null;
}
const SPEC_COLS: Record<keyof SpecPatch, string> = {
  title: 'title', path: 'path', afterId: 'after_id', branch: 'branch', designSession: 'step_session',
  buildSession: 'build_session', editSession: 'edit_session', outsideBuild: 'outside_build', resumed: 'resumed', step: 'step',
};

export function updateSpec(db: Db, id: number, patch: SpecPatch): SpecRow {
  const entries = (Object.keys(patch) as (keyof SpecPatch)[]).filter((k) => patch[k] !== undefined);
  if (entries.length) {
    const vals = entries.map((k) => { const v = patch[k]!; return typeof v === 'boolean' ? (v ? 1 : 0) : v; });
    db.query(`UPDATE spec SET ${entries.map((k) => `${SPEC_COLS[k]} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
  }
  const s = getSpec(db, id);
  if (!s) throw new Error(`spec ${id} not found`);
  return s;
}

/** §5.0 the spec an orchestrator session is bound to: Thiết kế writes / edits it, Build builds it, Chung has none. */
export function specOfSession(db: Db, sessionId: string, kind: OrchKind): SpecRow | null {
  if (kind === 'general') return null;
  const sql = kind === 'build' ? 'SELECT * FROM spec WHERE build_session = ?1 ORDER BY id DESC'
    : 'SELECT * FROM spec WHERE edit_session = ?1 OR step_session = ?1 ORDER BY (edit_session = ?1) DESC, id DESC';
  const r = db.query<SpecDb, [string]>(sql).get(sessionId);
  return r ? toSpec(r) : null;
}

/** R-B13 (b) F21 "Phiên mới" gives the session a new id: the spec bindings (design / build / edit) follow it. */
export function moveSpecBindings(db: Db, from: string, to: string): void {
  db.query(`UPDATE spec SET step_session = CASE step_session WHEN ?1 THEN ?2 ELSE step_session END,
    build_session = CASE build_session WHEN ?1 THEN ?2 ELSE build_session END, edit_session = CASE edit_session WHEN ?1 THEN ?2 ELSE edit_session END
    WHERE ?1 IN (step_session, build_session, edit_session)`).run(from, to);
}

/** §10.1 `spec_output_add`: one row per (spec, ref); adding the same ref again only relabels it. */
export function addSpecOutput(db: Db, specId: number, o: { kind: 'md' | 'image' | 'html' | 'link' | 'other'; ref: string; label: string | null }, now = Date.now()): void {
  db.query(`INSERT INTO spec_output (spec_id, kind, ref, label, added_by, at) VALUES (?, ?, ?, ?, 'session', ?)
    ON CONFLICT (spec_id, ref) DO UPDATE SET label = COALESCE(excluded.label, label)`).run(specId, o.kind, o.ref, o.label, now);
}

/** §5.2-9 one more "Bổ sung yêu cầu" round; returns the new number. */
export function bumpAmend(db: Db, id: number): number {
  return db.query<{ amend_rev: number }, [number]>('UPDATE spec SET amend_rev = amend_rev + 1 WHERE id = ? RETURNING amend_rev').get(id)!.amend_rev;
}

// ---------- issue ----------
interface IssueDb {
  id: number; project_id: string; num: number; kind: IssueKind; spec_id: number | null; source: IssueSource;
  source_lane: number | null; source_issue: number | null; reverts: number | null; title: string; body: string;
  done_when: string; state: IssueState; revert: RevertState; lane_id: number | null; base_sha: string | null;
  po_seen: number; po_ok: number; cancel_reason: string | null; created_by_session: string | null; created_at: number;
  done_at: number | null;
}
const toIssue = (r: IssueDb): IssueRow => ({
  id: r.id, projectId: r.project_id, num: r.num, key: issueKey(r.kind, r.num), kind: r.kind, specId: r.spec_id,
  source: r.source, sourceLane: r.source_lane, sourceIssue: r.source_issue, reverts: r.reverts, title: r.title, body: r.body,
  doneWhen: JSON.parse(r.done_when) as string[], state: r.state, revert: r.revert, laneId: r.lane_id, baseSha: r.base_sha,
  poSeen: r.po_seen === 1, poOk: r.po_ok === 1, cancelReason: r.cancel_reason, createdBySession: r.created_by_session,
  createdAt: r.created_at, doneAt: r.done_at,
});

export interface NewIssue {
  projectId: string; kind: IssueKind; specId: number | null; source: IssueSource; title: string; body?: string;
  doneWhen?: string[]; sourceLane?: number | null; sourceIssue?: number | null; reverts?: number | null;
  createdBySession?: string | null; blockedBy?: number[];
  /** `done` only for `source: prior` (§5.2-10; rules.checkIssueCreate). */
  state?: 'todo' | 'done'; commits?: IssueCommit[];
  /** The body, given the key the issue gets (a §5.7-4 revert issue names its own trailer). Wins over `body`. */
  bodyFor?: (key: string) => string;
}

/** §5.1 `num` is one counter per project for both kinds, allocated inside the insert's transaction. §5.6 lane /
 * orchestrator issues start unseen. */
export function createIssue(db: Db, n: NewIssue, now = Date.now()): IssueRow {
  return db.transaction(() => {
    const num = (db.query<{ m: number | null }, [string]>('SELECT MAX(num) AS m FROM issue WHERE project_id = ?').get(n.projectId)?.m ?? 0) + 1;
    const state = n.state ?? 'todo';
    const unseen = n.source === 'lane' || n.source === 'orchestrator';
    const row = db.query<IssueDb, SqlVal[]>(
      `INSERT INTO issue (project_id, num, kind, spec_id, source, source_lane, source_issue, reverts, title, body, done_when,
         state, po_seen, created_by_session, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(n.projectId, num, n.kind, n.specId, n.source, n.sourceLane ?? null, n.sourceIssue ?? null, n.reverts ?? null,
      n.title.trim(), n.bodyFor ? n.bodyFor(issueKey(n.kind, num)) : n.body ?? '', JSON.stringify(n.doneWhen ?? []), state, unseen ? 0 : 1, n.createdBySession ?? null, now,
      state === 'done' ? now : null)!;
    for (const b of n.blockedBy ?? []) addDep(db, row.id, b);
    for (const c of n.commits ?? []) insertCommit(db, row.id, c, now);
    appendEvent(db, row.id, 'created', { source: n.source, state }, now);
    return toIssue(row);
  })();
}

export function getIssue(db: Db, id: number): IssueRow | null {
  const r = db.query<IssueDb, [number]>('SELECT * FROM issue WHERE id = ?').get(id);
  return r ? toIssue(r) : null;
}

/** `T-47` / `B-50` in one project; a key whose letter does not match the row's kind is not that issue. */
export function getIssueByKey(db: Db, projectId: string, key: string): IssueRow | null {
  const k = parseIssueKey(key);
  if (!k) return null;
  const r = db.query<IssueDb, [string, number, string]>('SELECT * FROM issue WHERE project_id = ? AND num = ? AND kind = ?')
    .get(projectId, k.num, k.kind);
  return r ? toIssue(r) : null;
}

/** `specId`: a spec's issues, `null` = outside any spec, omitted = every issue. */
export function listIssues(db: Db, projectId: string, f: { specId?: number | null; state?: IssueState } = {}): IssueRow[] {
  const where = ['project_id = ?'];
  const args: SqlVal[] = [projectId];
  if (f.specId === null) where.push('spec_id IS NULL');
  else if (f.specId !== undefined) { where.push('spec_id = ?'); args.push(f.specId); }
  if (f.state) { where.push('state = ?'); args.push(f.state); }
  return db.query<IssueDb, SqlVal[]>(`SELECT * FROM issue WHERE ${where.join(' AND ')} ORDER BY num`).all(...args).map(toIssue);
}

/** Every issue a lane holds or held (§5.5-3 / -4 input). */
export function laneIssues(db: Db, laneId: number): IssueRow[] {
  return db.query<IssueDb, [number]>('SELECT * FROM issue WHERE lane_id = ? ORDER BY num').all(laneId).map(toIssue);
}

function setState(db: Db, id: number, from: readonly IssueState[], sql: string, args: SqlVal[]): IssueRow {
  const cur = getIssue(db, id);
  if (!cur) throw new Error(`issue ${id} not found`);
  if (!from.includes(cur.state)) throw new Error(`${cur.key} is ${cur.state}`);
  db.query(`UPDATE issue SET ${sql} WHERE id = ?`).run(...args, id);
  return getIssue(db, id)!;
}

/** §5.3 a lane takes a `todo` issue (R-B2 `base_sha` = HEAD of its cwd at that moment, null outside git). */
export function takeIssue(db: Db, id: number, laneId: number, baseSha: string | null, now = Date.now()): IssueRow {
  return db.transaction(() => {
    const i = setState(db, id, ['todo'], "state = 'doing', lane_id = ?, base_sha = ?", [laneId, baseSha]);
    if (i.reverts !== null) setRevert(db, i.reverts, 'running', now);
    appendEvent(db, id, 'taken', { lane: laneId }, now);
    return i;
  })();
}

/** §5.3 the lane ended without finishing: back to `todo`, lane cleared. */
export function releaseIssue(db: Db, id: number, reason: string, now = Date.now()): IssueRow {
  return db.transaction(() => {
    const before = getIssue(db, id);
    const i = setState(db, id, ['doing'], "state = 'todo', lane_id = NULL, base_sha = NULL", []);
    if (i.reverts !== null) setRevert(db, i.reverts, 'pending', now);
    appendEvent(db, id, 'returned', { lane: before?.laneId ?? null, reason }, now);
    return i;
  })();
}

function insertCommit(db: Db, id: number, c: IssueCommit, now: number): void {
  db.query('INSERT OR IGNORE INTO issue_commit (issue_id, sha, branch, at) VALUES (?, ?, ?, ?)').run(id, c.sha, c.branch, now);
}

/** §5.5-6 `issue_done`: commits saved, `done`. A revert issue finishing cancels its original (§5.7-6). */
export function finishIssue(db: Db, id: number, commits: readonly IssueCommit[], now = Date.now(), summary?: string): IssueRow {
  return db.transaction(() => {
    const i = setState(db, id, ['doing'], "state = 'done', done_at = ?", [now]);
    for (const c of commits) insertCommit(db, id, c, now);
    appendEvent(db, id, 'done', { commits: commits.map((c) => c.sha), ...(summary ? { summary } : {}) }, now);
    if (i.reverts !== null) setRevert(db, i.reverts, 'done', now);
    return i;
  })();
}

export function listCommits(db: Db, id: number): { sha: string; branch: string | null; at: number }[] {
  return db.query<{ sha: string; branch: string | null; at: number }, [number]>('SELECT sha, branch, at FROM issue_commit WHERE issue_id = ? ORDER BY at, sha').all(id);
}

/** `issue_update`: title / body / done_when of an open issue (the caller refuses closed ones). */
export function updateIssue(db: Db, id: number, patch: { title?: string; body?: string; doneWhen?: string[] }, now = Date.now()): IssueRow {
  return db.transaction(() => {
    const sets: string[] = [];
    const vals: SqlVal[] = [];
    if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title.trim()); }
    if (patch.body !== undefined) { sets.push('body = ?'); vals.push(patch.body); }
    if (patch.doneWhen !== undefined) { sets.push('done_when = ?'); vals.push(JSON.stringify(patch.doneWhen)); }
    if (sets.length) db.query(`UPDATE issue SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    appendEvent(db, id, 'updated', { fields: Object.keys(patch) }, now);
    const i = getIssue(db, id);
    if (!i) throw new Error(`issue ${id} not found`);
    return i;
  })();
}

/** §5.7-2 / -3 / §5.5-8 `issue_drop`: `todo` / `doing` → `cancelled`. `by` tells a PO cancel (A5 dup check) from a drop. */
export function cancelIssue(db: Db, id: number, f: { reason: string | null; by: 'po' | 'orchestrator' }, now = Date.now()): IssueRow {
  return db.transaction(() => {
    const i = setState(db, id, ['todo', 'doing'], "state = 'cancelled', cancel_reason = ?", [f.reason]);
    appendEvent(db, id, 'cancelled', { by: f.by, reason: f.reason }, now);
    return i;
  })();
}

const REVERT_MOVES: Record<RevertState, readonly RevertState[]> = {
  none: ['pending'], pending: ['running'], running: ['pending', 'conflict', 'done'], conflict: ['pending', 'none'], done: [],
};

/** §5.7 revert of a `done` issue: none | conflict → pending (`requestRevert`) → running (lane takes the revert issue) → done |
 * conflict. `done` also cancels the original (§5.7-6); `conflict` leaves it `done` (§5.7-5); conflict → none = "Giữ". */
function setRevert(db: Db, id: number, to: RevertState, now: number): IssueRow {
  const cur = getIssue(db, id);
  if (!cur) throw new Error(`issue ${id} not found`);
  if (!REVERT_MOVES[cur.revert].includes(to)) throw new Error(`${cur.key} revert ${cur.revert} → ${to} not allowed`);
  db.query(`UPDATE issue SET revert = ?${to === 'done' ? ", state = 'cancelled'" : ''} WHERE id = ?`).run(to, id);
  appendEvent(db, id, 'revert', { to }, now);
  return getIssue(db, id)!;
}

/**
 * §5.7-4 the PO confirmed IS4 on a `done` issue (or §5.7-3 a `doing` one already merged into the target — it becomes `done`
 * with `commits` first, lane kept as history): the PO's reason + `cancelled {by: po}` are stored now (§5.7-7, A5), `revert`
 * → pending. The caller then creates the revert issue.
 */
export function requestRevert(db: Db, id: number, f: { reason: string | null; commits?: readonly IssueCommit[] }, now = Date.now()): IssueRow {
  return db.transaction(() => {
    const cur = setState(db, id, ['done', 'doing'], 'cancel_reason = ?', [f.reason]);
    if (cur.state === 'doing') {
      db.query("UPDATE issue SET state = 'done', done_at = ? WHERE id = ?").run(now, id);
      for (const c of f.commits ?? []) insertCommit(db, id, c, now);
    }
    appendEvent(db, id, 'cancelled', { by: 'po', reason: f.reason }, now);
    return setRevert(db, id, 'pending', now);
  })();
}

/** §5.7-5 the revert lane hit a conflict: the revert issue is cancelled, the original stays `done` with `revert=conflict`. */
export function revertConflict(db: Db, revertIssueId: number, detail: string, now = Date.now()): IssueRow {
  return db.transaction(() => {
    const r = getIssue(db, revertIssueId);
    if (r?.reverts == null) throw new Error(`issue ${revertIssueId} is not a revert issue`);
    cancelIssue(db, r.id, { reason: detail, by: 'orchestrator' }, now);
    return setRevert(db, r.reverts, 'conflict', now);
  })();
}

/** §5.7-5 "Giữ T-46" on the revert_conflict card: the original stays `done`, nothing is reverted (`revert` → none). */
export function keepAfterConflict(db: Db, id: number, now = Date.now()): IssueRow {
  return db.transaction(() => setRevert(db, id, 'none', now))();
}

/** §5.7 the open (todo / doing) issue reverting `id`, if any. */
export function openRevertOf(db: Db, id: number): IssueRow | null {
  const r = db.query<IssueDb, [number]>("SELECT * FROM issue WHERE reverts = ? AND state IN ('todo', 'doing') ORDER BY id DESC").get(id);
  return r ? toIssue(r) : null;
}

/** §5.6 seen when the PO leaves the issue; "Cho làm" = ok + seen. */
export function markSeen(db: Db, id: number): void {
  db.query('UPDATE issue SET po_seen = 1 WHERE id = ?').run(id);
}

export function markOk(db: Db, id: number, now = Date.now()): void {
  db.transaction(() => {
    db.query('UPDATE issue SET po_ok = 1, po_seen = 1 WHERE id = ?').run(id);
    appendEvent(db, id, 'po_ok', {}, now);
  })();
}

/** §4.1 / §5.6 the orange dot + `issues_new` card count. */
export function unseenCount(db: Db, projectId: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE project_id = ? AND po_seen = 0 AND state <> 'cancelled'").get(projectId)!.n;
}

// ---------- deps ----------
export function addDep(db: Db, issueId: number, blockedById: number): void {
  db.query('INSERT OR IGNORE INTO issue_dep (issue_id, blocked_by_id) VALUES (?, ?)').run(issueId, blockedById);
}

export function removeDep(db: Db, issueId: number, blockedById: number): void {
  db.query('DELETE FROM issue_dep WHERE issue_id = ? AND blocked_by_id = ?').run(issueId, blockedById);
}

export function projectDeps(db: Db, projectId: string): DepEdge[] {
  return db.query<DepEdge, [string]>(
    `SELECT d.issue_id AS issueId, d.blocked_by_id AS blockedById FROM issue_dep d JOIN issue i ON i.id = d.issue_id
     WHERE i.project_id = ?`,
  ).all(projectId);
}

/** §5.1 / §5.4 derived, never stored: blocked, priority, waiters, ready — for every issue of the project. */
export function issueViews(db: Db, projectId: string): IssueView<IssueRow>[] {
  return viewIssues(listIssues(db, projectId), projectDeps(db, projectId));
}

/** §5.4 ready issues of a spec (or outside any spec: null) in ready order. */
export function readyIssues(db: Db, projectId: string, specId: number | null): IssueView<IssueRow>[] {
  return readyOrder(issueViews(db, projectId).filter((v) => v.issue.specId === specId));
}

/** §5.5-7 input: cancelled by the PO (a cancel or a finished revert, title normalised, with the reason) and open titles. */
export function titleIndex(db: Db, projectId: string): {
  cancelledByPo: { key: string; norm: string; cancelReason: string | null }[]; open: { key: string; norm: string }[];
} {
  const byPo = new Set(db.query<{ issue_id: number }, [string]>(
    `SELECT e.issue_id FROM issue_event e JOIN issue i ON i.id = e.issue_id
     WHERE i.project_id = ? AND e.type = 'cancelled' AND json_extract(e.json, '$.by') = 'po'`,
  ).all(projectId).map((r) => r.issue_id));
  const all = listIssues(db, projectId);
  return {
    cancelledByPo: all.filter((i) => i.state === 'cancelled' && byPo.has(i.id))
      .map((i) => ({ key: i.key, norm: normTitle(i.title), cancelReason: i.cancelReason })),
    open: all.filter((i) => i.state === 'todo' || i.state === 'doing').map((i) => ({ key: i.key, norm: normTitle(i.title) })),
  };
}

// ---------- events + files ----------
export interface IssueEvent { id: number; ts: number; type: string; data: Record<string, unknown> }

/** History rows are structured JSON; the web builds the sentence (§5.1). */
export function appendEvent(db: Db, issueId: number, type: string, data: Record<string, unknown>, now = Date.now()): void {
  db.query('INSERT INTO issue_event (issue_id, ts, type, json) VALUES (?, ?, ?, ?)').run(issueId, now, type, JSON.stringify(data));
}

export function listEvents(db: Db, issueId: number): IssueEvent[] {
  return db.query<{ id: number; ts: number; type: string; json: string }, [number]>('SELECT id, ts, type, json FROM issue_event WHERE issue_id = ? ORDER BY id')
    .all(issueId).map((r) => ({ id: r.id, ts: r.ts, type: r.type, data: JSON.parse(r.json) as Record<string, unknown> }));
}

export interface IssueFile { id: number; name: string; path: string; size: number; at: number }

export function addFile(db: Db, issueId: number, f: { name: string; path: string; size: number }, now = Date.now()): IssueFile {
  return db.query<IssueFile, SqlVal[]>('INSERT INTO issue_file (issue_id, name, path, size, at) VALUES (?, ?, ?, ?, ?) RETURNING id, name, path, size, at')
    .get(issueId, f.name, f.path, f.size, now)!;
}

export function listFiles(db: Db, issueId: number): IssueFile[] {
  return db.query<IssueFile, [number]>('SELECT id, name, path, size, at FROM issue_file WHERE issue_id = ? ORDER BY id').all(issueId);
}
