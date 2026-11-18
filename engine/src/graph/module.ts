// v2.5 §5.3 / §5.5 / §5.6 the graph module as the Mac sees it: the module state (tool read + the 60 s `error` rule + an
// install / update run), the latest-release check (60 s reuse, a failed check keeps the old answer), the §5.6 install /
// update flow, the GraphView (sync, from the last refresh: `list_projects` stats + `index_status` + git HEAD, refreshed when the tab
// opens and after each job — never on a timer), the GR-upd impact counts and the GR-clean orphan list / clean run.
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GRAPH_NAME, type GraphImpact, type GraphOrphans, type GraphProjectView, type GraphRunView, type GraphToolState, type GraphToolView, type GraphView } from '../../../shared/graph.ts';
import type { Db } from '../db.ts';
import type { Exec } from '../setup/setup.ts';
import type { Env } from '../session/env.ts';
import { GitHeads } from './head.ts';
import { dirKey } from './indexes.ts';
import { CheckError, installLine, latestTag, runInstaller, type InstallerRun } from './install.ts';
import { clean, orphans, type IndexRow } from './orphans.ts';
import type { JobView, RunEnd } from './queue.ts';
import type { ToolRead } from './tool.ts';

const CHECK_REUSE_MS = 60_000;
const LOG_KEEP = 200;
const RUN_LOG = 4;
/** §5.6 the tool's default index dir (counted by file for an `old` tool that has no front). */
const CACHE_DIR = join('.cache', 'codebase-memory-mcp');

/** The fronts as the module uses them (front.ts `GraphFronts`). */
export interface ModuleFronts {
  toolRead(): ToolRead;
  ready(): boolean;
  failing(): string | null;
  onState(fn: () => void): void;
  retry(): void;
  suspend(): void;
  resume(): Promise<void>;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
/** The index side (indexes.ts `GraphIndexes` + queue.ts `IndexQueue`). */
export interface ModuleIndexes {
  list(): Promise<IndexRow[]>;
  keep(): Set<string>;
  indexNow(projectId: string, root: string): void;
  state(root: string): JobView | null;
  stop(root: string): boolean;
  remove(name: string): Promise<RunEnd>;
}

export interface GraphModuleDeps {
  fronts: ModuleFronts;
  indexes: ModuleIndexes;
  /** The graph tool: a fresh read after the installer (§5.6 step 4) and its env (graphEnv). */
  tool: { read(): Promise<ToolRead>; env: Env };
  db: Db;
  home: string;
  projects: () => readonly { id: string; name: string; path: string }[];
  /** config `graph.offProjects`. */
  off: () => readonly string[];
  lanesRunning: () => number;
  /** Login-env exec: `git rev-parse` / `git log` (head.ts), `ps`, `<tool> config set`. */
  exec: Exec;
  onChange: () => void;
  log: (line: string) => void;
  /** @internal test seams (default: GitHub through install.ts). */
  latest?: () => Promise<string>;
  installer?: (o: InstallerRun) => Promise<RunEnd>;
}

interface Proc { pid: number; ppid: number; comm: string }
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const epoch = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? undefined : t;
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** §5.6 every `*.db` but `_*.db` and `activity.db` is one index; bytes = everything under the dir (as `du`). */
function countDir(dir: string): { n: number; bytes: number } {
  let names: string[];
  try { names = readdirSync(dir, { recursive: true }) as string[]; } catch { return { n: 0, bytes: 0 }; }
  let n = 0; let bytes = 0;
  for (const rel of names) {
    try { const s = statSync(join(dir, rel)); if (!s.isFile()) continue; bytes += s.size; } catch { continue; }
    const b = basename(rel);
    if (!rel.includes('/') && b.endsWith('.db') && !b.startsWith('_') && b !== 'activity.db') n++;
  }
  return { n, bytes };
}

/** §5.6 graph tool processes by process tree: the engine's own fronts are left out (they are drained and reopened). */
export function splitProcesses(procs: readonly Proc[], enginePid: number): GraphImpact['processes'] {
  const by = new Map(procs.map((p) => [p.pid, p]));
  const out = { lanes: 0, sessions: 0, other: 0 };
  for (const p of procs) {
    if (basename(p.comm) !== GRAPH_NAME) continue;
    if (p.ppid === enginePid) continue;
    let kind: 'lanes' | 'sessions' | 'other' = 'other';
    const seen = new Set<number>();
    for (let up = by.get(p.ppid); up && !seen.has(up.pid); up = by.get(up.ppid)) {
      seen.add(up.pid);
      if (up.pid === enginePid) { kind = 'lanes'; break; }
      if (basename(up.comm) === 'claude' && kind === 'other') kind = 'sessions';
    }
    out[kind]++;
  }
  return out;
}

export class GraphModule {
  private latest: string | undefined;
  private checkedAt: number | undefined;
  private checkError: GraphToolView['checkError'];
  private checkStart = -Infinity;
  private checking: Promise<void> | null = null;
  private run: GraphRunView | null = null;
  /** The running install / update (Engine.stop aborts its installer and waits for it). */
  private running: { abort: AbortController; done: Promise<void> } | null = null;
  private failed: GraphToolView['failed'];
  private readonly log: string[] = [];
  private list: IndexRow[] | null = null;
  private readonly status = new Map<string, { indexedAt?: number; stale: boolean }>();
  private readonly git = new Map<string, boolean>();
  private readonly heads: GitHeads;
  private cleanRun: GraphToolView['clean'];

  constructor(private readonly d: GraphModuleDeps) {
    this.heads = new GitHeads(d.exec);
    d.fronts.onState(() => d.onChange());
  }

  /** §5.3 the module state now. */
  state(): GraphToolState {
    if (this.run) return this.run.kind === 'install' ? 'installing' : 'updating';
    const r = this.d.fronts.toolRead();
    if (r.state === 'error') return 'error';
    return r.state === 'ready' && this.d.fronts.failing() !== null ? 'error' : r.state;
  }

  busy(): boolean { return this.run !== null; }

  /** §5.3 the K0 red: the module is in `error` while the graph is on for ≥ 1 project. */
  red(): boolean {
    const off = new Set(this.d.off());
    return this.state() === 'error' && this.d.projects().some((p) => !off.has(p.id));
  }

  /** Something the view shows changed (an index job queued / started): push it. */
  changed(): void { this.d.onChange(); }

  view(): GraphView {
    const r = this.d.fronts.toolRead();
    const state = this.state();
    const error = r.state === 'error' ? r.line : state === 'error' ? this.d.fronts.failing() ?? undefined : undefined;
    const list = this.list;
    const o = list ? orphans(list, { home: this.d.home, keep: this.d.indexes.keep() }) : null;
    const tool: GraphToolView = {
      state,
      ...(r.state !== 'missing' ? { path: r.path } : {}),
      ...(r.state === 'old' || r.state === 'ready' ? { version: r.version } : {}),
      ...(this.latest ? { latest: this.latest.slice(1), command: installLine(this.latest, r.state === 'missing' ? null : dirname(r.path)) } : {}),
      ...(this.checkedAt !== undefined ? { checkedAt: this.checkedAt } : {}),
      ...(this.checkError ? { checkError: this.checkError } : {}),
      ...(error ? { error } : {}),
      ...(this.failed ? { failed: this.failed } : {}),
      ...(this.log.length ? { log: [...this.log] } : {}),
      ...(list ? { indexes: { n: list.length, bytes: list.reduce((s, x) => s + (x.size_bytes ?? 0), 0) } } : {}),
      ...(o ? { orphans: { n: o.rows.length, bytes: o.bytes, skipped: o.skipped.n } } : {}),
      ...(this.cleanRun ? { clean: { ...this.cleanRun, failedRoots: [...this.cleanRun.failedRoots] } } : {}),
      ...(this.run ? { run: { ...this.run, log: [...this.run.log] } } : {}),
    };
    return { tool, projects: state === 'ready' || state === 'error' || state === 'updating' ? this.projectRows() : [] };
  }

  private projectRows(): GraphProjectView[] {
    const lanes = this.d.db.query<{ root_path: string; project_id: string }, []>("SELECT root_path, project_id FROM graph_index WHERE origin = 'lane'").all();
    const off = new Set(this.d.off());
    const byRoot = new Map((this.list ?? []).flatMap((x) => (x.root_path ? [[dirKey(x.root_path), x] as const] : [])));
    return this.d.projects().map((p): GraphProjectView => {
      const root = dirKey(p.path);
      const idx = byRoot.get(root);
      const job = this.d.indexes.state(root);
      const st = this.status.get(root);
      const laneRows = lanes.filter((l) => l.project_id === p.id).map((l) => byRoot.get(dirKey(l.root_path))).filter((x) => x !== undefined);
      const state = job?.state === 'queued' ? 'queued' : job && ['running', 'stopping'].includes(job.state) ? 'running'
        : job?.state === 'failed' ? 'failed' : idx ? (st?.stale ? 'stale' : 'ready') : 'none';
      const nodes = num((idx as { nodes?: unknown } | undefined)?.nodes);
      return {
        projectId: p.id, name: p.name, on: !off.has(p.id), git: this.git.get(root) ?? true, state,
        ...(nodes !== undefined ? { nodes } : {}), ...(idx?.size_bytes !== undefined ? { bytes: idx.size_bytes } : {}),
        ...(st?.indexedAt !== undefined ? { indexedAt: st.indexedAt } : {}),
        ...(state === 'running' && job?.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
        ...(state === 'queued' && job?.ahead !== undefined ? { ahead: job.ahead } : {}),
        ...(state === 'running' && job?.by === 'tool' ? { byTool: true as const } : {}),
        ...(job?.state === 'stopping' ? { stopping: true as const } : {}),
        ...(job?.overdue ? { overdue: true as const } : {}),
        ...(state === 'failed' && job?.error ? { error: job.error } : {}),
        lanes: { n: laneRows.length, bytes: laneRows.reduce((s, x) => s + (x.size_bytes ?? 0), 0) },
      };
    });
  }

  /** §5.3 graph_check (tab / wizard step / "Kiểm tra"): the latest tag (reused for 60 s unless forced) + the numbers. */
  async check(force: boolean): Promise<GraphView> {
    if (force || Date.now() - this.checkStart >= CHECK_REUSE_MS) {
      this.checkStart = Date.now();
      this.checking ??= (async () => {
        try {
          this.latest = await (this.d.latest ?? latestTag)();
          this.checkedAt = Date.now();
          this.checkError = undefined;
        } catch (e) { // keep the old answer + "không kiểm được"
          this.checkError = { code: e instanceof CheckError ? e.code : 'unknown', line: msg(e) };
        }
      })().finally(() => { this.checking = null; });
      await this.checking;
    }
    await this.refresh();
    return this.view();
  }

  /** §5.5 the numbers: every `list_projects` page + `index_status` (`indexed_at`) and the git HEAD of each project (only
   * while the module is up); stale = HEAD committed after the index (head.ts — the tool itself never says stale). */
  async refresh(): Promise<void> {
    if (!this.d.fronts.ready()) return;
    try {
      const list = await this.d.indexes.list();
      this.list = list;
      for (const p of this.d.projects()) {
        const root = dirKey(p.path);
        const head = await this.heads.read(root);
        this.git.set(root, head.git);
        const row = list.find((x) => x.root_path && dirKey(x.root_path) === root);
        if (!row) { this.status.delete(root); continue; }
        try {
          const s = await this.d.fronts.call('index_status', { project: row.name });
          const indexedAt = epoch(s.indexed_at);
          this.status.set(root, { indexedAt, stale: head.at !== undefined && indexedAt !== undefined && head.at > indexedAt });
        } catch { this.status.delete(root); }
      }
    } catch (e) { this.addLog(`graph: list_projects — ${msg(e)}`); }
    this.d.onChange();
  }

  /** GR-err "Thử lại". */
  retry(): void { this.d.fronts.retry(); }

  /** §5.6 graph_install (missing) / graph_update (old, ready, error): one run at a time; the run is the view's `run`. */
  async install(kind: 'install' | 'update'): Promise<void> {
    if (this.run) return;
    const abort = new AbortController();
    const done = this.runInstall(kind, abort.signal);
    this.running = { abort, done };
    await done;
    this.running = null;
  }

  /** Engine.stop: the running installer's process group is killed; its fronts are not resumed (they close next). */
  async shutdown(): Promise<void> {
    this.running?.abort.abort();
    await this.running?.done;
  }

  private async runInstall(kind: 'install' | 'update', signal: AbortSignal): Promise<void> {
    const before = this.d.fronts.toolRead();
    const from = before.state === 'old' || before.state === 'ready' ? before.version : undefined;
    this.run = { kind, ...(from ? { from } : {}), step: 1, log: [] };
    this.failed = undefined;
    this.d.onChange();
    let end: RunEnd;
    try { end = await this.steps(kind, before, signal); } catch (e) { end = { ok: false, line: msg(e) }; }
    if (!end.ok) this.failed = { kind, line: end.line };
    this.run = null;
    if (signal.aborted) return;
    await this.d.fronts.resume(); // §5.6 step (5) / a failure: the state is computed again from the file in place
    this.d.onChange();
  }

  private async steps(kind: 'install' | 'update', before: ToolRead, signal: AbortSignal): Promise<RunEnd> {
    const run = this.run!;
    const tag = await (this.d.latest ?? latestTag)();
    run.to = tag.slice(1);
    this.latest = tag;
    if (kind === 'update') this.d.fronts.suspend(); // (1) rule 3, the running index job stopped, every front closed
    run.step = 2;
    this.d.onChange();
    const dir = before.state === 'missing' ? join(this.d.home, '.local', 'bin') : dirname(before.path);
    const ran = await (this.d.installer ?? runInstaller)({ tag, dir, env: this.d.tool.env, signal, onLine: (l) => this.runLine(l) });
    if (!ran.ok) return ran;
    run.step = 3;
    this.d.onChange();
    const now = await this.d.tool.read();
    if (now.state !== 'ready' || now.version !== run.to) {
      return { ok: false, line: now.state === 'error' ? now.line : `${GRAPH_NAME} --version: ${'version' in now ? now.version : now.state} ≠ ${run.to}` };
    }
    if (kind === 'install') { // A8 / Z7 only for a copy cc-slaves installed: its own UI (port 9749) off
      const r = await this.d.exec([now.path, 'config', 'set', 'ui_enabled', 'false'], { env: this.d.tool.env, timeoutMs: 10_000 });
      if (r.code !== 0) this.addLog(`graph: config set ui_enabled false — exit ${r.code}`);
    }
    run.step = 4;
    this.d.onChange();
    return { ok: true };
  }

  private runLine(line: string): void {
    const run = this.run;
    if (run) { run.log.push(line); if (run.log.length > RUN_LOG) run.log.splice(0, run.log.length - RUN_LOG); }
    this.addLog(line);
    this.d.onChange();
  }

  private addLog(line: string): void {
    this.log.push(line);
    if (this.log.length > LOG_KEEP) this.log.splice(0, this.log.length - LOG_KEEP);
  }

  /** §5.6 graph_impact: the GR-upd counts. */
  async impact(): Promise<GraphImpact> {
    let indexes: GraphImpact['indexes'] | null = null;
    if (this.d.fronts.ready()) {
      try { const l = await this.d.indexes.list(); indexes = { n: l.length, bytes: l.reduce((s, x) => s + (x.size_bytes ?? 0), 0) }; } catch { indexes = null; }
    }
    indexes ??= countDir(join(this.d.home, CACHE_DIR));
    return { indexes, lanesRunning: this.d.lanesRunning(), processes: splitProcesses(await this.processes(), process.pid) };
  }

  private async processes(): Promise<Proc[]> {
    try {
      const r = await this.d.exec(['ps', '-axo', 'pid=,ppid=,comm='], { timeoutMs: 10_000 });
      return r.stdout.split('\n').flatMap((l) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(l);
        return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]!.trim() }] : [];
      });
    } catch { return []; }
  }

  /** graph_index (Index / Index lại / Thử lại): the project root, before automatic jobs. */
  index(projectId: string): boolean {
    const p = this.d.projects().find((x) => x.id === projectId);
    if (!p || !this.d.fronts.ready()) return false;
    this.d.indexes.indexNow(p.id, dirKey(p.path));
    this.d.onChange();
    return true;
  }

  /** graph_index_stop (Dừng, D70). */
  stop(projectId: string): boolean {
    const p = this.d.projects().find((x) => x.id === projectId);
    const ok = p ? this.d.indexes.stop(dirKey(p.path)) : false;
    this.d.onChange();
    return ok;
  }

  /** graph_orphans (GR-clean): computed again each time the box opens. */
  async orphans(): Promise<GraphOrphans> {
    const list = this.list = await this.d.indexes.list();
    const o = orphans(list, { home: this.d.home, keep: this.d.indexes.keep() });
    this.d.onChange();
    return { ...o, kept: list.filter((x) => x.root_path).length - o.rows.length - o.skipped.n };
  }

  /** graph_clean {roots}: only roots the user saw that are still orphans now, one by one in the index queue (orphans.ts). */
  clean(roots: readonly string[]): void {
    if (this.cleanRun?.state === 'running') return;
    const run = this.cleanRun = { state: 'running' as 'running' | 'done', done: 0, total: new Set(roots).size, freedBytes: 0, failed: 0, failedRoots: [] as string[] };
    this.d.onChange();
    const names = new Map<string, string>();
    void clean(roots, {
      home: this.d.home, keep: () => this.d.indexes.keep(),
      list: async () => { const l = await this.d.indexes.list(); for (const x of l) if (x.root_path) names.set(x.name, x.root_path); return l; },
      queue: { remove: async (name) => {
        const r = await this.d.indexes.remove(name);
        run.done++;
        if (!r.ok) run.failedRoots.push(names.get(name) ?? name);
        this.d.onChange();
        return r;
      } },
    }).then((r) => {
      Object.assign(run, { state: 'done', done: r.deleted + r.failed, freedBytes: r.bytes, failed: r.failed, ...(r.error ? { error: r.error } : {}) });
    }, (e: unknown) => {
      Object.assign(run, { state: 'done', error: msg(e) });
    }).finally(() => { void this.refresh(); });
  }
}
