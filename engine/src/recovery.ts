// Engine-start recovery (spec §7.1). Lanes are pipe children of the engine, so they died with it (EOF); this is an
// intended break, recovered as follows for every session not yet ended in state.db:
// 1. pid still alive AND its command line contains that session id → kill it (a pipe cannot be re-attached);
// 2. resume: lanes rebuilt in LaneManager from their `lane` row (standard resume message), orchestrators with the
//    §7.5 text; undelivered outbox messages go out after the resume message (§7.6);
// 3. open permission requests are marked cancelled (their control_request died with the process).
// hotfix 2026-11-16: nothing is resumed here any more — what would run waits `paused` (its project is held) until
// `project_resume` or a PO message; closed projects are not restored at all.
import { getLane, type Db } from './db.ts';
import type { LaneManager } from './lane/manager.ts';
import type { Orchestrators } from './orchestrator/session.ts';
import type { ProcInfo } from './session/process.ts';

export interface RecoveryDeps {
  db: Db;
  lanes: Pick<LaneManager, 'restore' | 'list'>;
  orchestrators: Pick<Orchestrators, 'restore' | 'list'>;
  /** Process list (default `ps -axo pid=,command=`). */
  ps?: () => Promise<ProcInfo[]>;
  kill?: (pid: number) => void;
}

export interface RecoverySummary {
  killed: { sessionId: string; pid: number }[];
  lanes: { projectId: string; name: string; state: string }[];
  orchestrators: { projectId: string; state: string }[];
  cancelledCards: number[];
  /** hotfix 2026-11-16 projects with a paused session or lane (held). */
  held: string[];
}

interface Row { id: string; project_id: string; kind: 'orchestrator' | 'lane'; account: string | null; state: string; pid: number | null }

export async function defaultPs(): Promise<ProcInfo[]> {
  const p = Bun.spawn(['ps', '-axo', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(p.stdout).text();
  return out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), command: m[2]! }));
}
const defaultKill = (pid: number) => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } };

export async function recover(d: RecoveryDeps): Promise<RecoverySummary> {
  const { db } = d;
  const out: RecoverySummary = { killed: [], lanes: [], orchestrators: [], cancelledCards: [], held: [] };
  const rows = unfinished(db);

  const procs = await (d.ps ?? defaultPs)();
  const kill = d.kill ?? defaultKill;
  for (const s of rows) {
    if (s.pid === null || s.pid === process.pid) continue;
    const p = procs.find((x) => x.pid === s.pid);
    // pid reuse: only a process whose command line names this session is ours.
    if (p && p.command.includes(s.id)) { kill(p.pid); out.killed.push({ sessionId: s.id, pid: p.pid }); }
  }

  out.cancelledCards = db.query<{ id: number }, []>(
    "UPDATE card SET status = 'cancelled' WHERE kind = 'permission' AND status = 'open' RETURNING id",
  ).all().map((r) => r.id).sort((a, b) => a - b);

  await restoreHeld(d, rows, out);
  return out;
}

/** Unfinished sessions of open projects (of `projectId` only when given), in open order (a resumed root last). */
function unfinished(db: Db, projectId?: string): Row[] {
  return db.query<Row, [string | null]>(
    `SELECT s.* FROM session s JOIN project p ON p.id = s.project_id
     WHERE s.ended_at IS NULL AND s.state <> 'done' AND p.closed_at IS NULL AND (?1 IS NULL OR s.project_id = ?1)
     ORDER BY s.opened_at, s.rowid`,
  ).all(projectId ?? null);
}

/** Rebuild every row held (§7.1 step 2 without the spawn); `out.held` = the projects left with something paused. */
async function restoreHeld(d: Pick<RecoveryDeps, 'db' | 'lanes' | 'orchestrators'>, rows: Row[], out: Pick<RecoverySummary, 'lanes' | 'orchestrators' | 'held'>): Promise<void> {
  const { db } = d;
  for (const s of rows) {
    if (s.kind === 'lane') {
      const lane = db.query<{ project_id: string; name: string }, [string]>('SELECT project_id, name FROM lane WHERE session_id = ?').get(s.id);
      const l = lane ? getLane(db, lane.project_id, lane.name) : null;
      if (!l || l.state === 'done') continue;
      const v = d.lanes.restore(l, s.account, undefined, true);
      out.lanes.push({ projectId: v.projectId, name: v.name, state: l.state });
    } else {
      const o = await d.orchestrators.restore(s, true);
      out.orchestrators.push({ projectId: s.project_id, state: o.view().state });
    }
  }
  const ids = new Set(rows.map((r) => r.project_id));
  out.held = [...ids].filter((p) => d.orchestrators.list(p).some((o) => o.view().state === 'paused') || d.lanes.list(p).some((v) => v.state === 'paused'));
}

/** hotfix 2026-11-16 re-added closed project: its unfinished sessions come back held; true = something is paused. */
export async function restoreProject(d: Pick<RecoveryDeps, 'db' | 'lanes' | 'orchestrators'>, projectId: string): Promise<{ orchestrators: number; held: boolean }> {
  const out: Pick<RecoverySummary, 'lanes' | 'orchestrators' | 'held'> = { lanes: [], orchestrators: [], held: [] };
  await restoreHeld(d, unfinished(d.db, projectId), out);
  return { orchestrators: out.orchestrators.length, held: out.held.length > 0 };
}
