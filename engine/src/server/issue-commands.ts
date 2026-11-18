// v2.7 §10.1 + R-B12 the Tasks tab's commands (+ review MINOR-2 `issue_file`, v2.7.1 §7.4 `session_pick` + spec_* picks). Mac only (§8): none is in REMOTE_ALLOWED, the router refuses them on the
// remote channel. Keys and paths are per project and always resolved through the DB rows (a spec path is never an fs
// path from the web); a resumed session's cwd must be the project root or one of its worktrees (R-B6).
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { IssueCommand, IssueFileData, IssueRow, SessionPick, SpecRow, StartPicks } from '../../../shared/issues.ts';
import { classify, readBytes } from '../code/read.ts';
import type { Engine } from '../engine.ts';
import { checkSpecBuild, checkSpecMark, type Verdict } from '../issues/rules.ts';
import { kickoffText } from '../workflow/compile.ts';
import { DEFAULT_WORKFLOW } from '../workflow/builtin/index.ts';
import { nextStep, projectWorkflow, readRev, stepOf, wfText, workflowOf, workflowRev } from '../workflow/runtime.ts';
import { getIssue, getIssueByKey, getSpec, getSpecByPath, listFiles, markOk, markSeen, moveSpec, updateSpec } from '../issues/store.ts';
import { paths } from '../paths.ts';
import { CancelRefused } from '../issues/cancel.ts';
import { CommandError, type Handlers } from './router.ts';
import { checkAccount, earliest, noAccount, startPicks } from './start-picks.ts';

type IssueCmd = IssueCommand['cmd'];

const bad = () => new CommandError('bad_input', { key: 'errors.badTarget' });
const str = (v: unknown): string => { if (typeof v !== 'string' || v === '') throw bad(); return v; };
const refuse = (v: Verdict): void => { if (!v.ok) throw new CommandError('refused', { key: 'errors.specRefused', params: { detail: v.msg } }); };

/** v2.9 §5.3 the step a spec is at (a row from before its step was known: the first doc step). */
const stepAt = (s: SpecRow) => { const w = workflowRev(s.workflowRev); return { w, at: s.step ?? stepOf(w, 'design')?.id ?? '' }; };

function project(e: Engine, v: unknown): { id: string; path: string; name: string } {
  const r = e.projectRow(str(v));
  if (!r) throw new CommandError('no_project', { key: 'errors.noProject' });
  return { id: r.id, path: r.path, name: r.name };
}
function mustSpec(e: Engine, projectId: string, path: unknown): SpecRow {
  const s = getSpecByPath(e.db, projectId, str(path));
  if (!s) throw new CommandError('not_found', { key: 'errors.noSpecPath', params: { path: String(path) } });
  return s;
}
function mustIssue(e: Engine, projectId: string, key: unknown): IssueRow {
  const i = getIssueByKey(e.db, projectId, str(key));
  if (!i) throw new CommandError('not_found', { key: 'errors.noIssueKey', params: { key: String(key) } });
  return i;
}

/** §5.7 a `CancelRefused` (R31, open revert, git unreadable, …) → `refused` with the Vietnamese reason. */
async function refused<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (err) {
    if (err instanceof CancelRefused) throw new CommandError('refused', { key: 'errors.cancelRefused', params: { detail: err.message } });
    throw err;
  }
}

/** review-B IMPORTANT-1 specs whose Build / Thiết kế session is being opened, per state.db (every connection shares it): a
 * second "Bắt đầu build" / "Sửa spec" during the boot is refused instead of opening an orphan session. */
const opening = new WeakMap<Engine['db'], Set<number>>();
async function onceFor<T>(e: Engine, s: SpecRow, f: () => Promise<T>): Promise<T> {
  let set = opening.get(e.db);
  if (!set) opening.set(e.db, (set = new Set()));
  if (set.has(s.id)) refuse({ ok: false, msg: `đang mở phiên cho spec ${s.path} — đợi vài giây, phiên đó hiện trên Deck` });
  set.add(s.id);
  try { return await f(); } finally { set.delete(s.id); }
}

const real = (p: string): string | null => { try { return realpathSync.native(p); } catch { return null; } };

/** §4.3 / §10.3 review MINOR-2 one kept attachment as a data URL: the row must belong to the issue and its real path must
 *  sit in `<home>/issues/<project>/<key>/` (a symlink out → forbidden); only an image ≤ 5 MB (the Code viewer's cap). */
function issueFile(e: Engine, projectId: string, i: IssueRow, id: unknown): IssueFileData {
  if (typeof id !== 'number') throw bad();
  const f = listFiles(e.db, i.id).find((x) => x.id === id);
  const at = f ? real(f.path) : null;
  if (!f || at === null) throw new CommandError('not_found', { key: 'errors.issueFileGone', params: { key: i.key } });
  const dir = real(join(paths().home, 'issues', projectId, i.key));
  if (dir === null || !at.startsWith(dir + sep)) throw new CommandError('forbidden', { key: 'errors.issueFileForbidden', params: { name: f.name } });
  const r = classify(at, readBytes(at));
  if (r.kind !== 'image' || r.dataUrl === undefined) throw new CommandError('refused', { key: 'errors.issueFileNotImage', params: { name: f.name } });
  return { name: f.name, size: r.size, dataUrl: r.dataUrl };
}

/** R-B6 the resumed session's cwd: the project root or inside one of its worktrees, else refused. */
async function resumeCwd(e: Engine, root: string, id: string, cwd: string | null): Promise<string> {
  const at = real(cwd ?? root);
  const roots = [root, ...await e.code.deps().worktreeRoots(root)].map(real).filter((r) => r !== null);
  if (at === null || !roots.some((r) => at === r || at.startsWith(r + sep))) {
    throw new CommandError('bad_input', { key: 'errors.priorCwd', params: { id, cwd: cwd ?? root } });
  }
  return at;
}

/** Open a session of `kind` with the ▾ picks (§7.4: a hand-picked account is checked now, else "Tự chọn" must find
 *  one), tell the views; ack = its id (the web selects it on the Deck). */
async function open(e: Engine, projectId: string, i: Parameters<Engine['orchestrators']['openKind']>[1], picks: StartPicks): Promise<string> {
  if (picks.account !== undefined) checkAccount(e.accountViews(), picks.account);
  else if (e.orchestrators.autoAccount(projectId) === null) throw noAccount(e.accountViews());
  await e.held.wake(projectId); // a PO action runs a session: a held project resumes first (hotfix 2026-11-16)
  const o = await e.orchestrators.openKind(projectId, { ...i, ...picks });
  e.issues.changed(projectId);
  return o.currentSessionId;
}
/** §5.2-3 / §5.2-10 v2.9 §5.3 "Bắt đầu" on an approved spec opens the step after its approved one (from its pinned rev): a
 *  doc step = a new session of it, the spec back to draft there; Build (fresh or resuming a prior one) = the spec active. */
async function build(e: Engine, p: { id: string; path: string; name: string }, s: SpecRow, resumeArg: unknown, picks: StartPicks): Promise<{ sessionId: string }> {
  const resumeId = resumeArg === undefined ? undefined : str(resumeArg);
  const { w, at } = stepAt(s);
  refuse(checkSpecBuild(wfText(w), s, s.afterId === null ? null : getSpec(e.db, s.afterId), resumeId !== undefined));
  const next = nextStep(w, at).step;
  if (next === null) throw bad();
  if (next.type === 'design') {
    if (resumeId !== undefined) throw bad();
    const sessionId = await open(e, p.id, { kind: 'design', specId: s.id, step: next.id, firstMessage: kickoffText(next, 'new', { project: p.name, path: s.path }) }, picks);
    moveSpec(e.db, s.id, 'draft');
    updateSpec(e.db, s.id, { step: next.id });
    e.issues.changed(p.id);
    return { sessionId };
  }
  let resume: { sessionId: string; cwd: string } | undefined;
  if (resumeId !== undefined) { // §5.2-10 one of IS17's candidates (owned ids are never listed), not running elsewhere
    const cand = (await e.issues.priorSessions(p.id, s.path)).find((x) => x.id === resumeId);
    if (!cand) throw new CommandError('not_found', { key: 'errors.priorGone', params: { id: resumeId } });
    if (cand.runningElsewhere) throw new CommandError('session_live', { key: 'errors.priorRunning', params: { id: resumeId } });
    resume = { sessionId: resumeId, cwd: await resumeCwd(e, p.path, resumeId, cand.cwd) };
  }
  const first = resume ? kickoffText(next, 'resume', { path: s.path }) : kickoffText(next, 'new', { path: s.path }, s.outsideBuild);
  const sessionId = await open(e, p.id, { kind: 'build', specId: s.id, firstMessage: first, ...(resume ? { resume } : {}) }, picks);
  moveSpec(e.db, s.id, 'active');
  updateSpec(e.db, s.id, { step: next.id });
  if (s.outsideBuild) updateSpec(e.db, s.id, { resumed: true }); // §5.2-10 Tiếp tục build (either way): prior issues allowed
  e.issues.changed(p.id);
  return { sessionId };
}

/** v2.9 §5.3 `start: auto` (spec_approve): open the step after the spec's approved one, as Bắt đầu does (account auto). */
export function startNextStep(e: Engine, projectId: string, path: string): Promise<{ sessionId: string }> {
  const p = project(e, projectId);
  const s = mustSpec(e, p.id, path);
  return onceFor(e, s, () => build(e, p, s, undefined, {}));
}

export function issueHandlers(e: Engine): Pick<Handlers, IssueCmd> {
  return {
    issue_cancel_preview: (c) => {
      const p = project(e, c.projectId);
      return refused(() => e.issues.cancelPreview(p.id, str(c.key)));
    },
    issue_cancel: (c) => {
      const p = project(e, c.projectId);
      if (c.reason !== undefined && typeof c.reason !== 'string') throw bad();
      return refused(() => e.issues.cancel(p.id, str(c.key), c.reason?.trim() || null));
    },
    issue_ok: (c) => {
      const p = project(e, c.projectId);
      const i = mustIssue(e, p.id, c.key);
      markOk(e.db, i.id);
      e.issueEvents.poOk(getIssue(e.db, i.id)!);
      e.issues.changed(p.id);
    },
    issue_file: (c) => {
      const p = project(e, c.projectId);
      return issueFile(e, p.id, mustIssue(e, p.id, c.key), c.id);
    },
    issue_seen: (c) => {
      const p = project(e, c.projectId);
      markSeen(e.db, mustIssue(e, p.id, c.key).id);
      e.issues.changed(p.id);
    },
    spec_new: async (c) => {
      const p = project(e, c.projectId);
      const picks = startPicks(c);
      // v2.9 §5.8 the first doc step of the project's workflow, once the plugins it requires are on (PO: brainstorming)
      const w = projectWorkflow(e.db, p.id);
      const first = stepOf(w, 'design');
      if (!first) refuse({ ok: false, msg: `quy trình ${w.name} không có bước tài liệu` });
      if (e.issues.missingPlugin(p.id, w.requirePlugins) !== null) throw new CommandError('superpowers_off', { key: 'errors.superpowersOff' });
      return { sessionId: await open(e, p.id, { kind: 'design', firstMessage: kickoffText(first!, 'new', { project: p.name }) }, picks) };
    },
    spec_build: async (c) => {
      const p = project(e, c.projectId);
      const s = mustSpec(e, p.id, c.path);
      const picks = startPicks(c);
      return onceFor(e, s, () => build(e, p, s, c.resume, picks));
    },
    spec_edit: async (c) => {
      const p = project(e, c.projectId);
      const s = mustSpec(e, p.id, c.path);
      const picks = startPicks(c);
      const { w, at } = stepAt(s);
      const { doc } = wfText(w);
      if (s.state === 'done') refuse({ ok: false, msg: `${doc} ${s.path} đã xong: yêu cầu mới = ${doc} mới hoặc bug ngoài ${doc}` });
      const bound = s.state === 'draft' ? s.designSession : s.editSession;
      if (bound !== null && e.orchestrators.bySession(bound)) return { sessionId: bound }; // "Tới phiên": already open
      // v2.9 §5.3 Sửa = a session of the spec's doc step; Bổ sung (built spec) = the first doc step
      const step = s.state === 'active' ? stepOf(w, 'design') : w.steps.find((x) => x.id === at);
      const first = kickoffText(step!, s.state === 'active' ? 'amend' : 'edit', { project: p.name, path: s.path });
      return onceFor(e, s, async () => ({ sessionId: await open(e, p.id, { kind: 'design', specId: s.id, firstMessage: first }, picks) }));
    },
    session_pick: (c): SessionPick => {
      const p = project(e, c.projectId);
      if (c.kind !== 'design' && c.kind !== 'build') throw bad();
      const views = e.accountViews();
      const account = e.orchestrators.autoAccount(p.id);
      return { account, headroomPct: views.find((v) => v.email === account)?.headroomPct ?? null, earliest: account === null ? earliest(views) : null };
    },
    spec_mark: (c) => {
      const p = project(e, c.projectId);
      const s = mustSpec(e, p.id, c.path);
      if (c.state !== 'draft' && c.state !== 'approved') throw bad();
      // ruling 22:36 not a spawn: a missing rev (logged once) marks with the default workflow's names, never workflow_missing
      refuse(checkSpecMark(wfText(readRev(s.workflowRev) ?? workflowOf(DEFAULT_WORKFLOW)), s, c.state));
      moveSpec(e.db, s.id, c.state);
      e.issues.changed(p.id);
      return e.issues.view(p.id)!.specs.find((x) => x.id === s.id)!;
    },
    spec_scan: (c) => e.issues.scan(project(e, c.projectId).id),
    spec_import_hide: (c) => { e.issues.hideImported(project(e, c.projectId).id); },
    spec_prior_sessions: (c) => {
      const p = project(e, c.projectId);
      return e.issues.priorSessions(p.id, mustSpec(e, p.id, c.path).path);
    },
    spec_outputs: (c) => {
      const p = project(e, c.projectId);
      const s = mustSpec(e, p.id, c.path);
      return e.issues.outputs(p.id, s);
    },
  };
}
