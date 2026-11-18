// Project add / close / resume (spec §6.2 F2; hotfix 2026-11-16 held projects + "Đóng project"). `project_add` and
// `project_close` are Mac only; `project_resume` is in REMOTE_ALLOWED (it only steers).
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { LaneState, ProjectView } from '../../../shared/protocol.ts';
import type { OrchestratorState } from '../orchestrator/session.ts';
import { lanesOff } from '../config.ts';
import { insertProject } from '../db.ts';
import type { Engine } from '../engine.ts';
import { restoreProject } from '../recovery.ts';
import { missingPluginKnown } from '../session/skills.ts';
import { DEFAULT_WORKFLOW, DIRECT_WORKFLOW } from '../workflow/builtin/index.ts';
import { workflowOf } from '../workflow/runtime.ts';
import { CommandError, type Handlers } from './router.ts';

const projectIdFor = (path: string): string => createHash('sha256').update(path).digest('hex').slice(0, 12);
const nowS = () => Math.floor(Date.now() / 1000);

/** H5 what refuses "Đóng project": a lane or a session doing work (paused / idle / stopped close fine). */
const LANE_BUSY: readonly LaneState[] = ['starting', 'running', 'switching', 'draining', 'waiting_quota'];
const ORCH_BUSY: readonly OrchestratorState[] = ['starting', 'running', 'switching', 'waiting_quota'];

export function projectHandlers(e: Engine): Pick<Handlers, 'project_add' | 'project_close' | 'project_resume'> {
  return {
    project_add: async (c) => {
      const path = typeof c.path === 'string' ? resolve(c.path) : '';
      const name = typeof c.name === 'string' ? c.name.trim() : '';
      if (!path || !isAbsolute(c.path)) throw new CommandError('bad_input', { key: 'errors.needAbsPath' });
      if (!name) throw new CommandError('bad_input', { key: 'errors.needName' });
      let dir = false;
      try { dir = statSync(path).isDirectory(); } catch { /* missing */ }
      if (!dir) throw new CommandError('not_found', { key: 'errors.dirNotFound', params: { path } });
      const rows = e.projectRows();
      if (rows.some((r) => r.path === path)) throw new CommandError('duplicate_path', { key: 'errors.duplicatePath' });
      if (rows.some((r) => r.name.toLocaleLowerCase('vi') === name.toLocaleLowerCase('vi'))) throw new CommandError('duplicate_name', { key: 'errors.duplicateName', params: { name } });
      const closed = e.db.query<{ id: string }, [string]>('SELECT id FROM project WHERE path = ? AND closed_at IS NOT NULL').get(path);
      if (closed) return reopen(e, closed.id, name);
      const id = projectIdFor(path);
      insertProject(e.db, { id, name, path, orchestratorAccount: c.orchestratorAccount ?? defaultOrchestrator(e), workflow: firstWorkflow(e, id) });
      void e.graphIndexes?.projectAdded(id, path); // v2.5 §5.5 a new project root is indexed when it has none
      await startHeld(e, id); // H2 nothing runs before "Bắt đầu" / a first message
      return shown(e, id);
    },
    project_close: async (c) => {
      const r = typeof c.id === 'string' ? e.projectRow(c.id) : null;
      if (!r) throw new CommandError('no_project', { key: 'errors.noProject' });
      const lanes = e.lanes.list(r.id).filter((v) => LANE_BUSY.includes(v.state)).length;
      const orch = e.orchestrators.list(r.id).filter((o) => ORCH_BUSY.includes(o.view().state)).length;
      if (lanes > 0 || orch > 0) {
        const key = orch === 0 ? 'errors.projectBusyLanes' : lanes === 0 ? 'errors.projectBusyOrch' : 'errors.projectBusy'; // A-M5 no "0 lane"
        throw new CommandError('project_busy', { key, params: { name: r.name, lanes, orch } });
      }
      await e.lanes.closeProject(r.id);
      await e.orchestrators.closeProject(r.id);
      e.held.drop(r.id);
      e.db.query('UPDATE project SET closed_at = ? WHERE id = ?').run(nowS(), r.id);
      e.broadcast({ type: 'project_removed', id: r.id });
      skillsLater(e); // its `.claude/skills` and MCP rows leave the watch / view
      return { id: r.id };
    },
    project_resume: async (c) => {
      if (typeof c.id !== 'string' || !e.projectRow(c.id)) throw new CommandError('no_project', { key: 'errors.noProject' });
      await e.held.wake(c.id);
      return e.projectView(c.id)!;
    },
  };
}

/** H2 a first orchestrator session, written with its first message and left `paused` (held `start`). */
async function startHeld(e: Engine, id: string): Promise<void> {
  const o = await e.orchestrators.start(id, undefined, true);
  e.held.mark(id, 'start');
  e.broadcast({ type: 'orchestrator', orchestrator: e.orchView(o.view()) });
}

/** H2 re-adding a closed project's folder: same id and history, its unfinished sessions back held. */
async function reopen(e: Engine, id: string, name: string): Promise<ProjectView> {
  e.db.query('UPDATE project SET closed_at = NULL, name = ? WHERE id = ?').run(name, id);
  const r = await restoreProject({ db: e.db, lanes: e.lanes, orchestrators: e.orchestrators }, id);
  if (r.orchestrators === 0) await startHeld(e, id);
  else {
    if (r.held) e.held.markRestored(id);
    for (const o of e.orchestrators.list(id)) e.broadcast({ type: 'orchestrator', orchestrator: e.orchView(o.view()) });
  }
  for (const v of e.snapshotLanes(id)) e.broadcast({ type: 'lane', lane: v });
  return shown(e, id);
}

/** The project view, broadcast; its root joins the skills / MCP watch (§5.5); v2.7 §5.2-7 its specs are scanned (project open). */
function shown(e: Engine, id: string): ProjectView {
  try { e.issues.scan(id); } catch { /* v2.7 §5.2-7 an unreadable docs/specs: nothing imported, the add still stands */ }
  e.issues.flush(); // hf1117-perf its specs land before the `project` event, which gives a project with none its empty entry
  const view = e.projectView(id)!;
  e.broadcast({ type: 'project', project: view });
  skillsLater(e);
  return view;
}

/**
 * The skills / MCP rescan after the reply (hot fix 2026-11-17): it re-reads the catalog and arms the new folder watchers
 * (hf1117-perf: only the new ones, `SkillsWatch.set`); Tasks no longer waits on it (the project's empty issues entry).
 */
function skillsLater(e: Engine): void {
  setTimeout(() => { if (!e.stopped) e.skillsMcp.projectsChanged(); }, 0);
}

/** hf-sp a new project runs the default pack, or Giao thẳng when the default needs a plugin known not to be on (`fallback` =
 *  that plugin, the Tasks hint); an unknown plugin state keeps the default (no guess). */
function firstWorkflow(e: Engine, id: string): { id: string; fallback: string | null } {
  const missing = missingPluginKnown(workflowOf(DEFAULT_WORKFLOW).requirePlugins, lanesOff(e.config, id));
  return missing ? { id: DIRECT_WORKFLOW, fallback: missing } : { id: DEFAULT_WORKFLOW, fallback: null };
}

/** F1d: the caps' orchestrator account if it is logged in, else the first account. */
function defaultOrchestrator(e: Engine): string | null {
  const byRole = e.accounts.find((a) => e.caps[a.email]?.role === 'orchestrator');
  return byRole?.email ?? e.accounts[0]?.email ?? null;
}
