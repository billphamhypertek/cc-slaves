// v2.5 §5.8 the Graph code view (Mac channel only: no graph command is in REMOTE_ALLOWED and the `graph` event and the
// snapshot part never reach a remote connection, N7).

/** The tool's name: its file, its MCP entry, its tools `mcp__codebase-memory-mcp__*` (§5.7). */
export const GRAPH_NAME = 'codebase-memory-mcp';
/** §5.7 "the user's entry" (engine `sessionMcp`, web K1-graph): named `codebase-memory-mcp`, or its `command` is the tool's file
 *  (compared by file name). */
export function isGraphEntry(name: string, config: Readonly<Record<string, unknown>>): boolean {
  return name === GRAPH_NAME || (typeof config.command === 'string' && config.command.split('/').pop() === GRAPH_NAME);
}

/** The lowest version the `/mcp-graph` gate runs with (the one-daemon model of 0.12); GR0-old names it. */
export const MIN_GRAPH_VERSION = '0.12.1';
const parts = (v: string) => v.split('.').map(Number);
/** a < b (x.y.z): the tool state (§5.3), a newer release (§5.2, GR1-new). */
export function below(a: string, b: string): boolean {
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
}

/** §5.3 the tool / module state; `installing` / `updating` while a §5.6 run is on (rule 3 for every lane call). */
export type GraphToolState = 'missing' | 'old' | 'ready' | 'error' | 'installing' | 'updating';

/** §5.6 GR-run: 1 Đóng kết nối graph → 2 Tải và cài → 3 Kiểm phiên bản → 4 Mở lại. */
export interface GraphRunView {
  kind: 'install' | 'update';
  /** The version before (update). */
  from?: string;
  /** The tag being installed (known after step 1). */
  to?: string;
  step: 1 | 2 | 3 | 4;
  /** The last 4 lines of the installer (GR-run). */
  log: string[];
}

export interface GraphToolView {
  state: GraphToolState;
  /** The one file every spawn uses (A1). */
  path?: string;
  version?: string;
  /** §5.3 the latest release (`graph_check`), without the `v`. */
  latest?: string;
  /** epoch ms of the last `graph_check` that answered. */
  checkedAt?: number;
  checkError?: { code: 'offline' | 'unknown'; line: string };
  /** §5.3 `error`: why the control front does not start (GR-err). */
  error?: string;
  /** §5.6 GR-err-upd: the last install / update failed (its last log line); the old file is still in place. */
  failed?: { kind: 'install' | 'update'; line: string };
  /** GR-err / GR-err-upd "Xem log": the last 200 lines (installer output, front restarts). */
  log?: string[];
  /** §5.6 "Sẽ chạy:" the one-line equivalent of the next install / update (known once the latest tag is). */
  command?: string;
  /** Every index on the machine (`list_projects`). */
  indexes?: { n: number; bytes: number };
  /** D66 indexes whose directory is gone; `skipped` = could not be checked. */
  orphans?: { n: number; bytes: number; skipped: number };
  /** GR-clean-run / -done / -fail. */
  clean?: { state: 'running' | 'done'; done: number; total: number; freedBytes: number; failed: number; failedRoots: string[]; error?: string };
  run?: GraphRunView;
}

type GraphIndexState = 'none' | 'queued' | 'running' | 'ready' | 'stale' | 'failed';

export interface GraphProjectView {
  projectId: string;
  name: string;
  /** `graph.offProjects` does not hold it (GR1-offp). */
  on: boolean;
  /** `git rev-parse` in the login env (GR1-nogit when false). */
  git: boolean;
  state: GraphIndexState;
  nodes?: number;
  bytes?: number;
  /** epoch ms of the last index (`index_status`). */
  indexedAt?: number;
  /** `running`: when the job started (the UI shows the time it has run, §3-11). */
  startedAt?: number;
  /** `queued`: jobs ahead of it. */
  ahead?: number;
  /** `running` a job the tool runs by itself (R4: no Dừng). */
  byTool?: true;
  /** `running` after a Dừng, until the tool leaves the job ("Đang dừng…"). */
  stopping?: true;
  /** `running` past the 30-min limit and the cancel did not take ("Quá hạn — công cụ vẫn đang index"). */
  overdue?: true;
  /** `failed`: the tool's error line. */
  error?: string;
  /** Indexes of lane dirs of this project (`graph_index` origin = lane). */
  lanes: { n: number; bytes: number };
}

export interface GraphView { tool: GraphToolView; projects: GraphProjectView[] }

/** `graph_impact` (GR-upd): the real counts behind each line of the impact box. */
export interface GraphImpact {
  indexes: { n: number; bytes: number };
  /** Lanes running a turn now. */
  lanesRunning: number;
  /** §5.6 graph tool processes by process tree: under a lane `claude` of the engine / under another `claude` / anything else. */
  processes: { lanes: number; sessions: number; other: number };
}

/** `graph_orphans` (GR-clean): the list the user confirms; `graph_clean {roots}` takes exactly those roots. */
export interface GraphOrphans { rows: { root_path: string; bytes: number }[]; bytes: number; skipped: { n: number }; kept: number }

/** graph_check (force = "Kiểm tra") / install / update / retry / index / index_stop / clean ack the GraphView (install,
 *  update and clean go on in the background; progress as `graph`); graph_impact ack GraphImpact (GR-upd); graph_orphans
 *  ack GraphOrphans (GR-clean: graph_clean takes exactly those roots). */
export type GraphCommand =
  | { cmd: 'graph_check'; force?: boolean } | { cmd: 'graph_install' } | { cmd: 'graph_update' } | { cmd: 'graph_retry' }
  | { cmd: 'graph_impact' } | { cmd: 'graph_index'; projectId: string } | { cmd: 'graph_index_stop'; projectId: string }
  | { cmd: 'graph_orphans' } | { cmd: 'graph_clean'; roots: string[] }
  /** §5.7 GR1-offp: config `graph.offProjects` (applies from each lane's next spawn); ack the GraphView. */
  | { cmd: 'graph_toggle'; projectId: string; on: boolean };

export type GraphEngineEvent = { type: 'graph'; view: GraphView };
