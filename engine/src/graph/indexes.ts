// v2.5 §5.5 the index lifecycle: when the engine indexes by itself, the index book (`graph_index`, R1) and the automatic
// clean-up. Events: module ready (also engine start) / project added → a project root with no index; a session spawn with
// cwd ≠ root → that cwd when it has none (R4: when the user's `auto_index` is on, the tool indexes it by itself — adopted as
// a running job, nothing queued); a spawn in a non-git project → its root again (the tool does not refresh non-git dirs,
// §3-12); a lane done / module ready → clean the `lane` rows that are orphans (orphans.ts), through the queue.
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db } from '../db.ts';
import { gone } from './gone.ts';
import { clean, type IndexRow } from './orphans.ts';
import type { IndexArgs, IndexQueue, QueuePort } from './queue.ts';

/** The control front as this file uses it (front.ts `GraphFronts`). */
export interface IndexPort extends QueuePort {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  autoIndex(): Promise<boolean>;
}

export interface GraphIndexesDeps {
  db: Db;
  port: IndexPort;
  queue: IndexQueue;
  home: string;
  /** Open projects that have the graph on. */
  projects: () => readonly { id: string; path: string }[];
  /** The root of every project row, graph on or off (D66: never an orphan, booked as `project`). */
  roots: () => readonly string[];
  /** cwds of lanes not done (never cleaned). */
  liveCwds: () => readonly string[];
  log?: (line: string) => void;
}

/** The engine's key of a directory: its real path when it exists. */
export const dirKey = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

export class GraphIndexes {
  private auto = false;
  private up = false;
  private readonly pending: { projectId: string; cwd: string }[] = [];

  constructor(private readonly d: GraphIndexesDeps) {}

  /** The module is ready (each time the control front comes up). */
  async ready(): Promise<void> {
    this.up = true;
    this.auto = await this.d.port.autoIndex();
    const have = await this.roots();
    for (const p of this.d.projects()) this.ensure(p.id, dirKey(p.path), have);
    for (const s of this.pending.splice(0)) await this.spawned(s.projectId, s.cwd, have);
    await this.cleanUp();
  }

  async projectAdded(id: string, path: string): Promise<void> {
    if (this.up) this.ensure(id, dirKey(path), await this.roots());
  }

  /** A `claude` process of a session with the graph was spawned in `cwd`. */
  async spawned(projectId: string, cwd: string, have?: Set<string>): Promise<void> {
    const p = this.d.projects().find((x) => x.id === projectId);
    if (!p) return;
    if (!this.up) { this.pending.push({ projectId, cwd }); return; }
    const root = dirKey(p.path); const dir = dirKey(cwd);
    if (!existsSync(join(root, '.git'))) { this.queue(projectId, root); return; }
    if (dir === root) return;
    if ((have ?? await this.roots()).has(dir)) return;
    if (this.auto) { this.book(dir, projectId); this.d.queue.adopt(dir); return; }
    this.queue(projectId, dir);
  }

  /** §5.4 rule 2 a lane asked to index `root` (inside its cwd). */
  laneIndex(projectId: string, root: string, args: IndexArgs): { ahead: number } {
    this.book(root, projectId);
    return this.d.queue.add(root, args);
  }

  status(root: string): Record<string, unknown> | null { return this.d.queue.reply(root); }

  laneDone(): Promise<void> { return this.up ? this.cleanUp() : Promise.resolve(); }

  /** "Index" / "Index lại" / "Thử lại" of a project root: before the automatic jobs. */
  indexNow(projectId: string, root: string): void {
    this.book(root, projectId);
    this.d.queue.add(root, {}, true);
  }

  private ensure(projectId: string, root: string, have: Set<string>): void {
    if (!have.has(root)) this.queue(projectId, root);
  }

  private queue(projectId: string, root: string): void {
    this.book(root, projectId);
    this.d.queue.add(root);
  }

  private book(root: string, projectId: string): void {
    const isRoot = this.d.roots().some((p) => dirKey(p) === root);
    this.d.db.query('INSERT OR IGNORE INTO graph_index (root_path, project_id, origin) VALUES (?, ?, ?)').run(root, projectId, isRoot ? 'project' : 'lane');
  }

  /** Every `list_projects` page (`detail:"stats"`). */
  async list(): Promise<IndexRow[]> {
    const out: IndexRow[] = [];
    for (let offset = 0; ;) {
      const r = await this.d.port.call('list_projects', { detail: 'stats', offset });
      const page = Array.isArray(r.projects) ? (r.projects as IndexRow[]) : [];
      out.push(...page);
      if (r.has_more !== true || page.length === 0) return out;
      offset += page.length;
    }
  }

  private async roots(): Promise<Set<string>> {
    try { return new Set((await this.list()).flatMap((r) => (r.root_path ? [r.root_path, dirKey(r.root_path)] : []))); } catch { return new Set(); }
  }

  /** Never an orphan: every project root (graph on or off) + cwds of lanes not done (literal and real paths). */
  keep(): Set<string> {
    const keep = new Set<string>();
    for (const p of [...this.d.roots(), ...this.d.liveCwds()]) { keep.add(resolve(p)); keep.add(dirKey(p)); }
    return keep;
  }

  /** Lane rows that are orphans now → `delete_project` through the queue; a lane row with no index and a gone dir → dropped. */
  private async cleanUp(): Promise<void> {
    const lanes = this.d.db.query<{ root_path: string }, []>("SELECT root_path FROM graph_index WHERE origin = 'lane'").all().map((r) => r.root_path);
    if (lanes.length === 0) return;
    try {
      const r = await clean(lanes, { home: this.d.home, keep: () => this.keep(), list: () => this.list(), queue: this.d.queue });
      if (r.failed > 0) this.d.log?.(`graph: dọn index — ${r.failed} hỏng: ${r.error ?? ''}`);
      const have = await this.roots();
      const keep = this.keep();
      for (const root of lanes) {
        if (!have.has(root) && !keep.has(root) && gone(root, { home: this.d.home }) === 'gone') this.d.db.query('DELETE FROM graph_index WHERE root_path = ?').run(root);
      }
    } catch (e) { this.d.log?.(`graph: dọn index — ${e instanceof Error ? e.message : String(e)}`); }
  }
}
