// v2.7 issue MCP tools (spec §5.3–§5.7, §10.1): issue_create / get / list / link / assign / update / drop / done and the
// `lane_start {issue}` take. Every call: the caller from its token (lane row, or the orchestrator session's `orch_kind` +
// bound spec), §5.5-8 by session kind (`gateTool`, before any tool runs), then the tool's own rules.ts check. A refusal
// is the rule's Vietnamese text; nothing is written before every check passed.
import { copyFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import type { Db } from '../db.ts';
import { DIR_MODE, paths } from '../paths.ts';
import { normTitle, type IssueKind, type IssueRow, type IssueSource } from '../../../shared/issues.ts';
import { checkIssueCommits, headSha } from '../issues/commits.ts';
import type { IssueEvents } from '../issues/events.ts';
import {
  checkAssignable, checkDupTitle, checkIssueCreate, checkIssueDone, checkIssueDrop, checkLaneCreate, checkLaneTakes, checkLink, checkLinkScope,
  checkPriorityFirst, checkRevertConflict, checkSessionTool, type Caller, type ToolTarget, type Verdict,
} from '../issues/rules.ts';
import {
  addDep, addFile, cancelIssue, createIssue, finishIssue, getIssue, getIssueByKey, getSpec, getSpecByPath, issueViews, laneIssues, listEvents, listFiles,
  listIssues, projectDeps, readyIssues, removeDep, revertConflict, specOfSession, takeIssue, titleIndex, updateIssue,
} from '../issues/store.ts';
import { eventData } from '../issues/views.ts';
import type { LaneView } from '../lane/manager.ts';
import type { Exec } from '../setup/setup.ts';
import { sessionStep, wfText } from '../workflow/runtime.ts';
import { BOTH, fixed, mustOwn, O, obj, opt, str, ToolError, type Args, type Identity, type McpLanes, type Schema, type ToolDef, type ToolDeps } from './tool-kit.ts';

export interface IssuePorts {
  db: Db;
  /** The git runner of `base_sha` / the §5.5-6 trailer check (engine `gitExec`). */
  exec: Exec;
  events: IssueEvents;
  /** G2a: the session is named after the spec title (`spec_draft`). */
  rename: (sessionId: string, title: string) => void;
  /** G2a: the Build session ends once its handoff turn is over (`spec_close`). */
  closeWhenIdle: (sessionId: string) => void;
  /** v2.9 §5.8 the first of `plugins` not in effect for this project's lanes (null = all are). */
  missingPlugin: (projectId: string, plugins: readonly string[]) => string | null;
  /** v2.9 §5.3 `start: auto`: open the step after an approved spec's (as the PO's Bắt đầu does, account auto). */
  startNext: (projectId: string, path: string) => Promise<unknown>;
  /** G3a the project's specs / issues may have changed: the engine pushes `issue_changed` / `spec_changed` (coalesced). */
  changed: (projectId: string) => void;
  /** G3b §5.7-5 a revert hit a conflict: the revert_conflict card + the orchestrator note (engine IssuesArea). */
  conflict: (orig: IssueRow, revert: IssueRow, detail: string) => void;
}

export type Orch = Extract<Caller, { role: 'orchestrator' }>;
type LaneRow = { id: number; name: string; cwd: string; state: string };
const SHA = /^[0-9a-f]{7,40}$/;
const RECENT_EVENTS = 5;
const pluginOff = (plugin: string) => `Từ chối lane_start: ${plugin} chưa có hiệu lực cho lane của project này (plugin tắt trong ~/.claude/settings.json `
  + 'hoặc trong danh sách tắt cho lane). Báo PO (notify) bật lại ở Skills & MCP, rồi gọi lại lane_start.';

export const refuse = (v: Verdict): void => { if (!v.ok) throw new ToolError(v.msg); };

export function projectRoot(db: Db, projectId: string): string {
  const r = db.query<{ path: string }, [string]>('SELECT path FROM project WHERE id = ?').get(projectId);
  if (!r) throw new ToolError(`project ${projectId} không còn`);
  return r.path;
}

/** The caller as rules.ts sees it: a lane with the issue it holds, or an orchestrator session with its step type + spec; both
 *  with the words + rules of the workflow rev they are pinned to (v2.9 §6.1). */
export function callerOf(db: Db, who: Identity): Caller {
  if (who.role === 'lane') {
    const l = db.query<{ id: number; name: string }, [string]>('SELECT id, name FROM lane WHERE session_id = ?').get(who.sessionId);
    if (!l) throw new ToolError('Không tìm thấy lane của session này');
    const held = laneIssues(db, l.id).find((i) => i.state === 'doing') ?? null;
    return { role: 'lane', projectId: who.projectId, laneId: l.id, laneName: l.name, held, wf: wfText(sessionStep(db, who.sessionId).workflow) };
  }
  const { workflow, step } = sessionStep(db, who.sessionId);
  const stepType = step.type === 'lane' ? 'general' : step.type;
  return { role: 'orchestrator', projectId: who.projectId, sessionId: who.sessionId, stepType, spec: specOfSession(db, who.sessionId, stepType), wf: wfText(workflow) };
}

const orchOf = (db: Db, who: Identity): Orch => callerOf(db, who) as Orch;

function mustIssue(db: Db, projectId: string, key: string): IssueRow {
  const i = getIssueByKey(db, projectId, key);
  if (!i) throw new ToolError(`Không có mục ${key} trong project này — xem issues_list`);
  return i;
}

const laneByName = (db: Db, projectId: string, name: string): LaneRow | null =>
  db.query<LaneRow, [string, string]>('SELECT id, name, cwd, state FROM lane WHERE project_id = ? AND name = ?').get(projectId, name);

/** A spec path argument → the project-relative form the rows keep (`docs/specs/x.md`). */
export function specRel(root: string, raw: string): string {
  const t = raw.trim().replace(/^\.\//, '');
  return t.startsWith(`${root}/`) ? t.slice(root.length + 1) : t;
}

function mustSpecId(db: Db, c: Caller, raw: string): number {
  const s = getSpecByPath(db, c.projectId, specRel(projectRoot(db, c.projectId), raw));
  if (!s) throw new ToolError(`Không có spec ${raw} trong project này — spec mới đi qua phiên ${c.wf.names.design} (spec_draft)`);
  return s.id;
}

/** `issue_create` target spec: given path, `null` = outside any spec, left out = the Build session's own spec (others: outside). */
function createSpecOf(db: Db, c: Orch, raw: unknown): number | null {
  if (raw === undefined) return c.stepType === 'build' ? c.spec?.id ?? null : null;
  return raw === null ? null : mustSpecId(db, c, raw as string);
}

function targetOf(db: Db, c: Orch, tool: string, a: Args): ToolTarget {
  const t: ToolTarget = {};
  const key = typeof a.key === 'string' ? a.key : typeof a.issue === 'string' ? a.issue : null;
  if (key !== null) t.issue = mustIssue(db, c.projectId, key);
  else if (tool.startsWith('lane_') && typeof a.name === 'string') {
    const l = laneByName(db, c.projectId, a.name);
    t.issue = l ? laneIssues(db, l.id).find((i) => i.state === 'doing') ?? null : null;
  }
  if (tool.startsWith('spec_') && typeof a.path === 'string') t.spec = getSpecByPath(db, c.projectId, specRel(projectRoot(db, c.projectId), a.path));
  if (tool === 'issue_create') t.createSpecId = createSpecOf(db, c, a.spec);
  return t;
}

/** §5.5-8 by the orchestrator session's kind, before any tool runs (lane tools on a held issue included). */
export function gateTool(p: IssuePorts, who: Identity, tool: string, a: Args): void {
  if (who.role !== 'orchestrator') return;
  const c = orchOf(p.db, who);
  refuse(checkSessionTool(c, tool, targetOf(p.db, c, tool, a)));
}

/** §5.5-1 / -2 / -3 / -4 before a lane takes `issue`, by the rules of the giving session's workflow (v2.9 §5.7). */
function checkGive(db: Db, c: Caller, issue: IssueRow, via: 'lane_start' | 'issue_assign', lane: { name: string; issues: IssueRow[] } | null): void {
  const spec = issue.specId === null ? null : getSpec(db, issue.specId);
  const blockers = projectDeps(db, issue.projectId).filter((d) => d.issueId === issue.id).map((d) => getIssue(db, d.blockedById)!);
  refuse(checkAssignable(c.wf, issue, spec, blockers));
  const view = issueViews(db, issue.projectId).find((v) => v.issue.id === issue.id)!;
  const readyPriority = issue.specId === null ? [] : readyIssues(db, issue.projectId, issue.specId).filter((v) => v.priority).map((v) => v.issue.key);
  refuse(checkPriorityFirst(c.wf, issue, view.priority, readyPriority));
  refuse(checkLaneTakes(c.wf, issue, via, lane));
}

/** R-B13 (c) issues being handed to a lane right now (between the §5.5 checks and the take), per state.db: a second
 * `lane_start {issue}` / `issue_assign` of the same issue is refused instead of opening a lane with nothing to hold. */
const giving = new WeakMap<Db, Set<number>>();
function reserve(db: Db, issue: IssueRow): () => void {
  let s = giving.get(db);
  if (!s) giving.set(db, (s = new Set()));
  if (s.has(issue.id)) throw new ToolError(`${issue.key} đang được giao cho một lane khác — đợi vài giây rồi xem issue_get ${issue.key}`);
  const held = s.add(issue.id);
  return () => { held.delete(issue.id); };
}

const assignText = (i: IssueRow) => `Nhận ${i.key}: ${i.title}. Đọc: issue_get ${i.key}`;

/**
 * `lane_start` (§7.3 + §5.3): refused while a plugin the session's workflow requires is off for lanes (v2.9 §5.8); with
 * `issue` the §5.5 checks run and `base_sha` is read before the lane exists; the returned step takes the issue for the
 * started lane and tells it.
 */
export async function prepareLaneStart(p: IssuePorts, who: Identity, key: string | undefined, cwd: string): Promise<LaneTake | null> {
  const missing = p.missingPlugin(who.projectId, sessionStep(p.db, who.sessionId).workflow.requirePlugins);
  if (missing !== null) throw new ToolError(pluginOff(missing));
  if (key === undefined) return null;
  const issue = mustIssue(p.db, who.projectId, key);
  checkGive(p.db, callerOf(p.db, who), issue, 'lane_start', null);
  const release = reserve(p.db, issue); // R-B13 (c) held until the lane took it, or its spawn failed
  const base = await headSha({ cwd, exec: p.exec }).catch((e: unknown) => { release(); throw e; });
  return {
    release,
    take: async (lanes, v) => {
      let taken: IssueRow;
      try { taken = takeIssue(p.db, issue.id, v.laneId, base); } catch (e) {
        // review-B MINOR-1 the PO cancelled it while the lane spawned: the lane exists, say so and how to end it
        if (getIssue(p.db, issue.id)?.state !== 'cancelled') throw e;
        return { issue: null, text: `lane ${v.name} đã mở nhưng ${issue.key} vừa bị PO huỷ — lane_finish ${v.name}` };
      } finally { release(); }
      await lanes.message(who.projectId, v.name, assignText(taken), 'orchestrator');
      return { issue: taken.key };
    },
  };
}

/** `lane_start {issue}` after the checks: `take` once the lane exists, `release` when its spawn failed. */
export interface LaneTake { take: (lanes: McpLanes, v: LaneView) => Promise<{ issue: string } | { issue: null; text: string }>; release: () => void }

const arr = (description?: string): Schema => ({ type: 'array', items: str(), ...(description ? { description } : {}) });
const keyOnly = fixed(obj({ key: str('mã mục, vd T-47') }, ['key']));
const laneNames = (db: Db, projectId: string) =>
  new Map(db.query<{ id: number; name: string }, [string]>('SELECT id, name FROM lane WHERE project_id = ?').all(projectId).map((l) => [l.id, l.name]));

function createIssueTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db, events } = d.issues;
  const c = callerOf(db, who);
  if (c.role === 'lane') refuse(checkLaneCreate(c, who.projectId));
  const specId = c.role === 'lane' ? c.held?.specId ?? null : createSpecOf(db, c, a.spec);
  const source: IssueSource = c.role === 'lane' ? 'lane' : opt<IssueSource>(a, 'source') ?? 'orchestrator';
  const state = opt<'todo' | 'done'>(a, 'state') ?? 'todo';
  const spec = specId === null ? null : getSpec(db, specId);
  refuse(checkIssueCreate(c, spec, state, source));
  const title = (a.title as string).trim();
  if (!title) throw new ToolError('issue_create cần title');
  const idx = titleIndex(db, who.projectId);
  const dup = checkDupTitle(c.wf, normTitle(title), idx.cancelledByPo, idx.open);
  refuse(dup);
  if (dup.ok && dup.existing) return { key: dup.existing, existing: true, text: `Trùng mục đang mở ${dup.existing}: dùng mục đó, không tạo mới` };
  const files = attachSources(c.role === 'orchestrator' ? opt<string[]>(a, 'files') ?? [] : []);
  const shas = opt<string[]>(a, 'commits') ?? [];
  const bad = shas.find((s) => !SHA.test(s));
  if (bad !== undefined) throw new ToolError(`commits: "${bad}" không phải mã commit (7–40 ký tự hex)`);
  const row = createIssue(db, {
    projectId: who.projectId, kind: opt<IssueKind>(a, 'kind') ?? 'task', specId, source, title, body: opt<string>(a, 'body') ?? '',
    doneWhen: opt<string[]>(a, 'done_when') ?? [], blockedBy: (opt<string[]>(a, 'blocked_by') ?? []).map((k) => mustIssue(db, who.projectId, k).id),
    createdBySession: who.sessionId, sourceLane: c.role === 'lane' ? c.laneId : null, sourceIssue: c.role === 'lane' ? c.held?.id ?? null : null,
    state, commits: shas.map((sha) => ({ sha, branch: spec?.branch ?? null })),
  });
  keepFiles(db, row, files);
  events.issueCreated(row);
  return { key: row.key, state: row.state, spec: spec?.path ?? null, ...(files.length ? { files: files.length } : {}) };
}

/** §5.1 `issue_file`: only the PO's v2.4 attachment copies (`attachRoot`, deleted after delivery) are taken; anything else is
 * refused before the issue exists, so a session cannot copy arbitrary files into the engine home. */
function attachSources(raw: readonly string[]): string[] {
  if (raw.length === 0) return [];
  const root = realpathSync(paths().attachRoot);
  return raw.map((f) => {
    let real: string | null = null;
    try { real = realpathSync(f); } catch { /* missing → refused below */ }
    if (real === null || !real.startsWith(root + sep) || !statSync(real).isFile()) {
      throw new ToolError(`files: "${f}" không phải ảnh / file PO đính kèm trong tin nhắn (thư mục đính kèm của cc-slaves)`);
    }
    return real;
  });
}

/** Copies into `<home>/issues/<project>/<key>/` (the v2.4 copy is deleted after delivery) + one `issue_file` row each. */
function keepFiles(db: Db, issue: IssueRow, srcs: readonly string[]): void {
  if (srcs.length === 0) return;
  const dir = join(paths().home, 'issues', issue.projectId, issue.key);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  srcs.forEach((src, n) => {
    const name = basename(src);
    const dest = join(dir, `${n + 1}-${name}`);
    copyFileSync(src, dest);
    addFile(db, issue.id, { name, path: dest, size: statSync(dest).size });
  });
}

/** `issues_list` scope: given spec / outside (`null`), else what the caller works on; `cancelled` reads the whole project. */
function listScope(db: Db, who: Identity, a: Args): number | null | undefined {
  if (a.spec !== undefined) return a.spec === null ? null : mustSpecId(db, callerOf(db, who), a.spec as string);
  if (a.state === 'cancelled') return undefined;
  const c = callerOf(db, who);
  if (c.role === 'lane') return c.held ? c.held.specId : undefined;
  if (c.stepType === 'general') return null;
  return c.spec?.id ?? undefined;
}

function listTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db } = d.issues;
  const scope = listScope(db, who, a);
  const state = opt<string>(a, 'state');
  const names = laneNames(db, who.projectId);
  const rows = issueViews(db, who.projectId)
    .filter((v) => scope === undefined || v.issue.specId === scope)
    .filter((v) => (state ? v.issue.state === state : v.issue.state !== 'cancelled'))
    .map(({ issue: i, blockedBy, priority, ready }) => ({
      key: i.key, title: i.title, state: i.state,
      ...(blockedBy.length ? { blocked_by: blockedBy } : {}), ...(priority && i.state === 'todo' ? { priority: true } : {}),
      ...(ready ? { ready: true } : {}), ...(i.laneId !== null ? { lane: names.get(i.laneId) ?? null } : {}),
      ...(i.state === 'cancelled' ? { cancel_reason: i.cancelReason } : {}),
    }));
  const spec = scope === undefined ? 'all' : scope === null ? null : getSpec(db, scope)?.path ?? null;
  return { spec, issues: rows };
}

function getTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db } = d.issues;
  const i = mustIssue(db, who.projectId, a.key as string);
  const blockers = projectDeps(db, i.projectId).filter((x) => x.issueId === i.id).map((x) => getIssue(db, x.blockedById)!);
  const names = laneNames(db, i.projectId);
  const nameOf = (id: number) => names.get(id) ?? null;
  const files = listFiles(db, i.id).map((f) => ({ name: f.name, path: f.path }));
  return {
    key: i.key, kind: i.kind, title: i.title, state: i.state, spec: i.specId === null ? null : getSpec(db, i.specId)?.path ?? null,
    lane: i.laneId === null ? null : nameOf(i.laneId),
    blocked_by: blockers.map((b) => ({ key: b.key, state: b.state })), done_when: i.doneWhen, body: i.body,
    ...(files.length ? { files } : {}),
    events: listEvents(db, i.id).slice(-RECENT_EVENTS).map((e) => ({ type: e.type, ...eventData(e.data, nameOf) })),
  };
}

function linkTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db, events } = d.issues;
  const i = mustIssue(db, who.projectId, a.key as string);
  const b = mustIssue(db, who.projectId, a.blocked_by as string);
  refuse(checkLinkScope(callerOf(db, who), i, b));
  if (a.remove === true) {
    removeDep(db, i.id, b.id);
    events.unblocked(getIssue(db, i.id)!);
    return { ok: true, key: i.key, removed: b.key };
  }
  refuse(checkLink(i, b, projectDeps(db, who.projectId), new Map(listIssues(db, who.projectId).map((x) => [x.id, x.key]))));
  addDep(db, i.id, b.id);
  return { ok: true, key: i.key, blocked_by: b.key };
}

async function assignTool(d: ToolDeps, who: Identity, a: Args): Promise<unknown> {
  const { db, exec } = d.issues;
  const name = a.lane as string;
  mustOwn(d, who, name);
  const i = mustIssue(db, who.projectId, a.key as string);
  const l = laneByName(db, who.projectId, name);
  if (!l) throw new ToolError(`Không có lane ${name} — xem lanes_list`);
  if (l.state === 'done') throw new ToolError(`lane ${name} đã kết thúc: mở lane mới bằng lane_start {issue: "${i.key}"}`);
  checkGive(db, callerOf(db, who), i, 'issue_assign', { name, issues: laneIssues(db, l.id) });
  const release = reserve(db, i);
  let taken: IssueRow;
  try { taken = takeIssue(db, i.id, l.id, await headSha({ cwd: l.cwd, exec })); } finally { release(); }
  await d.lanes.message(who.projectId, name, assignText(taken), 'orchestrator');
  return { ok: true, key: taken.key, lane: name };
}

function updateTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db } = d.issues;
  const i = mustIssue(db, who.projectId, a.key as string);
  if (i.state === 'done' || i.state === 'cancelled') throw new ToolError(`${i.key} đã ${i.state === 'done' ? 'xong' : 'huỷ'}: không sửa được — tạo mục mới nếu còn việc`);
  const patch: { title?: string; body?: string; doneWhen?: string[] } = {};
  const title = opt<string>(a, 'title');
  if (title !== undefined) { if (!title.trim()) throw new ToolError('title không được rỗng'); patch.title = title; }
  const body = opt<string>(a, 'body');
  if (body !== undefined) patch.body = body;
  const doneWhen = opt<string[]>(a, 'done_when');
  if (doneWhen !== undefined) patch.doneWhen = doneWhen;
  return { ok: true, key: updateIssue(db, i.id, patch).key };
}

function dropTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db, events } = d.issues;
  const i = mustIssue(db, who.projectId, a.key as string);
  refuse(checkIssueDrop(callerOf(db, who), i, a.reason as string));
  cancelIssue(db, i.id, { reason: (a.reason as string).trim(), by: 'orchestrator' });
  if (i.specId !== null) events.specSettled(i.specId);
  return { ok: true, key: i.key, state: 'cancelled' };
}

async function doneTool(d: ToolDeps, who: Identity, a: Args): Promise<unknown> {
  const { db, exec, events } = d.issues;
  const c = callerOf(db, who);
  const i = mustIssue(db, who.projectId, a.key as string);
  refuse(checkIssueDone(c, i, null));
  const cwd = c.role === 'lane' ? db.query<{ cwd: string }, [number]>('SELECT cwd FROM lane WHERE id = ?').get(c.laneId)!.cwd : '';
  const r = await checkIssueCommits({ cwd, baseSha: i.baseSha, key: i.key, exec });
  if (r.kind === 'refused') throw new ToolError(r.message);
  if (r.kind === 'unknown' || r.kind === 'forbidden') throw new ToolError(`Không kiểm được commit của ${i.key}: ${r.reason} — sửa git trong worktree lane rồi gọi lại issue_done`);
  const commits = r.kind === 'ok' ? r.commits : [];
  const done = finishIssue(db, i.id, commits, Date.now(), (a.summary as string).trim());
  events.issueDone(done);
  return { ok: true, key: done.key, commits: commits.length };
}

/** §5.7-5 the lane holding a revert issue aborted its `git revert`: the revert issue is cancelled, the original stays done. */
function revertConflictTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db } = d.issues;
  const i = mustIssue(db, who.projectId, a.key as string);
  refuse(checkRevertConflict(callerOf(db, who), i));
  const detail = (a.detail as string).trim();
  if (!detail) throw new ToolError('issue_revert_conflict cần detail: xung đột ở đâu, vướng mục nào');
  const orig = revertConflict(db, i.id, detail);
  d.issues.conflict(orig, getIssue(db, i.id)!, detail);
  return { ok: true, key: i.key, state: 'cancelled', original: orig.key, revert: orig.revert, text: `Đã báo PO. Dừng ở đây: không thử revert lại.` };
}

const KINDS = { type: 'string', enum: ['task', 'bug'] } as const satisfies Schema;
const createSchema = (role: 'orchestrator' | 'lane'): Schema => {
  const base: Record<string, Schema> = {
    title: str(), kind: { ...KINDS, enum: [...KINDS.enum] }, body: str('markdown'), done_when: arr('điều kiện xong'), blocked_by: arr('mã mục phải xong trước'),
  };
  if (role === 'lane') return obj(base, ['title']);
  return obj({
    ...base, spec: { type: 'string', nullable: true, description: 'đường dẫn {doc}; null = ngoài {doc}' },
    source: { type: 'string', enum: ['spec', 'amend', 'po', 'orchestrator', 'prior'] }, state: { type: 'string', enum: ['todo', 'done'] },
    commits: arr('mã commit (chỉ source prior)'), files: arr('ảnh / file PO đính kèm: đường dẫn bản sao trong dòng "File PO đính kèm" của tin nhắn'),
  }, ['title']);
};

export const ISSUE_TOOLS: readonly ToolDef[] = [
  {
    name: 'issue_create', roles: BOTH, schema: createSchema,
    description: 'Tạo mục (T task / B bug). Lane: mục phát sinh, tự vào {doc} của mục đang giữ. Đọc issues_list {state: "cancelled"} trước: trùng mục PO đã huỷ bị từ chối.',
    run: createIssueTool,
  },
  { name: 'issue_get', roles: BOTH, schema: keyOnly, description: 'Đọc một mục: tiêu đề, nội dung, done_when, phụ thuộc, sự kiện gần nhất.', run: getTool },
  {
    name: 'issues_list', roles: BOTH, description: 'Danh sách mục (mặc định: {doc} của phiên / lane; state cancelled = cả project, kèm lý do huỷ).',
    schema: fixed(obj({ spec: { type: 'string', nullable: true, description: 'đường dẫn {doc}; null = ngoài {doc}' }, state: { type: 'string', enum: ['todo', 'doing', 'done', 'cancelled'] } })),
    run: listTool,
  },
  {
    name: 'issue_link', roles: BOTH, description: 'key chờ blocked_by xong trước; remove: true gỡ liên kết. Vòng / khác project bị từ chối.',
    schema: fixed(obj({ key: str(), blocked_by: str(), remove: { type: 'boolean' } }, ['key', 'blocked_by'])), run: linkTool,
  },
  {
    name: 'issue_assign', roles: O, description: 'Giao mục cho lane đang rảnh của {doc} (mục ngoài {doc}: lane_start {issue}).',
    schema: fixed(obj({ key: str(), lane: str('tên lane') }, ['key', 'lane'])), run: assignTool,
  },
  {
    name: 'issue_update', roles: O, description: 'Sửa tiêu đề / nội dung / done_when của mục chưa xong.',
    schema: fixed(obj({ key: str(), title: str(), body: str(), done_when: arr() }, ['key'])), run: updateTool,
  },
  {
    name: 'issue_drop', roles: O, description: 'Phiên {build} bỏ mục todo không còn cần của {doc}, kèm lý do.',
    schema: fixed(obj({ key: str(), reason: str() }, ['key', 'reason'])), run: dropTool,
  },
  {
    name: 'issue_done', roles: ['lane'], description: 'Báo xong mục lane đang giữ. Mọi commit từ lúc nhận phải có trailer "Issue: <mã>".',
    schema: fixed(obj({ key: str(), summary: str('một dòng tóm tắt') }, ['key', 'summary'])), run: doneTool,
  },
  {
    name: 'issue_revert_conflict', roles: ['lane'], description: 'Lane giữ mục hoàn tác: git revert vướng xung đột → git revert --abort trước, rồi gọi công cụ này (engine hỏi PO).',
    schema: fixed(obj({ key: str('mã mục hoàn tác'), detail: str('xung đột ở đâu, vướng mục nào') }, ['key', 'detail'])), run: revertConflictTool,
  },
];
