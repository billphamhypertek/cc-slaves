// v2.5 §5.5 the index queue: one job at a time engine-wide, never two jobs for one directory (A2, G7). Every job runs as
// a synchronous `index_repository` on its own index front (G0 §4: an async job cannot be cancelled) — the port does that.
// Dừng / the 30-min limit = cancel that request; then the queue waits until the tool's `status:true` leaves running /
// cancelling before the next job (also when the cancel did not take: "Quá hạn — công cụ vẫn đang index"). R4: a dir the
// tool indexes by itself (`auto_index=true`) is adopted as a running job of the tool, with the same wait. The queue lives
// in memory only; at boot the engine rebuilds the missing jobs (indexes.ts).

export interface IndexArgs { mode?: unknown; persistence?: unknown }
export type RunEnd = { ok: true } | { ok: false; line: string };
/** One synchronous index request on its own front; `done` rejects when that front went away before it answered. */
export interface IndexRun { done: Promise<RunEnd>; cancel(): void }

export interface QueuePort {
  run(root: string, args: IndexArgs): IndexRun;
  /** The tool's own state of `root` (`index_repository {status:true}` on the control front): idle | queued | running | … */
  status(root: string): Promise<string>;
  /** `delete_project` on the control front. */
  remove(name: string): Promise<RunEnd>;
}

type JobState = 'queued' | 'running' | 'stopping' | 'done' | 'failed' | 'cancelled';
export interface JobView { state: JobState; by: 'engine' | 'tool'; ahead?: number; startedAt?: number; overdue?: boolean; error?: string }

interface Job {
  root: string; args: IndexArgs; first: boolean; by: 'engine' | 'tool';
  startedAt?: number; run?: IndexRun; stopping?: boolean; overdue?: boolean; retried?: boolean;
}
interface Removal { name: string; end: (r: RunEnd) => void }
type Item = Job | Removal;

const TIMEOUT_MS = 30 * 60_000;
const BUSY = new Set(['queued', 'running', 'cancelling']);
const OVERDUE = 'hết giờ';
const isJob = (i: Item): i is Job => 'root' in i;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface IndexQueueOptions {
  /** @internal test seam: the job limit (default 30 min, the wait for a turn not counted). */
  timeoutMs?: number;
  /** @internal test seam: the `status:true` poll (default 1 s). */
  pollMs?: number;
  /** @internal test seam: R4 how long an adopted dir may stay idle before the tool starts on it (default 10 s). */
  graceMs?: number;
  /** A job was queued, started, stopped or ended (`ended`: the index numbers changed). */
  onChange?: (ended: boolean) => void;
}

export class IndexQueue {
  private readonly waiting: Item[] = [];
  private current: Item | null = null;
  private readonly last = new Map<string, { state: 'done' | 'failed' | 'cancelled'; error?: string }>();
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly graceMs: number;
  private readonly changed: (ended: boolean) => void;

  constructor(private readonly port: QueuePort, o: IndexQueueOptions = {}) {
    this.changed = o.onChange ?? (() => {});
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
    this.pollMs = o.pollMs ?? 1000;
    this.graceMs = o.graceMs ?? 10_000;
  }

  /** Queue an index of `root` (merged into its job when it already has one); `first` = the user asked (before automatic jobs). */
  add(root: string, args: IndexArgs = {}, first = false): { ahead: number } {
    const job = this.job(root);
    if (job && job === this.current) return { ahead: 0 };
    if (job) {
      if (first && !job.first) { this.waiting.splice(this.waiting.indexOf(job), 1); job.first = true; this.insert(job); }
      return { ahead: this.ahead(job) };
    }
    const j: Job = { root, args, first, by: 'engine' };
    this.insert(j);
    this.pump();
    this.changed(false);
    return { ahead: this.ahead(j) };
  }

  /** R4 the tool runs `root` by itself: a running job of the tool from now (at the head when another job runs). */
  adopt(root: string): void {
    if (this.job(root)) return;
    const j: Job = { root, args: {}, first: true, by: 'tool', startedAt: Date.now() };
    this.waiting.unshift(j);
    this.pump();
    this.changed(false);
  }

  /** `delete_project` of an index, in line behind the jobs already queued. */
  remove(name: string): Promise<RunEnd> {
    return new Promise((end) => { this.waiting.push({ name, end }); this.pump(); });
  }

  /** Dừng (D70): a queued job is dropped; a running engine job is cancelled. False when there is nothing to stop (or R4). */
  stop(root: string): boolean {
    const job = this.job(root);
    if (!job || job.by === 'tool') return false;
    if (job !== this.current) this.waiting.splice(this.waiting.indexOf(job), 1);
    else if (!job.stopping) { job.stopping = true; job.run?.cancel(); }
    this.changed(false);
    return true;
  }

  state(root: string): JobView | null {
    const job = this.job(root);
    if (!job) { const l = this.last.get(root); return l ? { by: 'engine', ...l } : null; }
    if (job !== this.current && job.by === 'engine') return { state: 'queued', by: job.by, ahead: this.ahead(job) };
    return {
      state: job.stopping ? 'stopping' : 'running', by: job.by,
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}), ...(job.overdue ? { overdue: true } : {}),
    };
  }

  /** §5.4 rule 2 the gate's `status:true` answer, in the tool's words; null = the engine never saw this dir (forward). */
  reply(root: string): Record<string, unknown> | null {
    const v = this.state(root);
    if (!v) return null;
    const base = { repo_path: root };
    if (v.state === 'queued') return { state: 'queued', ...base, ahead: v.ahead };
    if (v.state === 'running' || v.state === 'stopping') {
      return { state: v.state === 'stopping' ? 'cancelling' : 'running', ...base, ...(v.startedAt ? { started_at: new Date(v.startedAt).toISOString() } : {}) };
    }
    return { state: v.state === 'done' ? 'succeeded' : v.state, ...base, ...(v.error ? { error: v.error } : {}) };
  }

  private job(root: string): Job | null {
    const all = this.current ? [this.current, ...this.waiting] : this.waiting;
    return (all.find((i) => isJob(i) && i.root === root) as Job | undefined) ?? null;
  }

  private ahead(j: Job): number { return this.waiting.indexOf(j) + (this.current ? 1 : 0); }

  private insert(j: Job): void {
    if (!j.first) { this.waiting.push(j); return; }
    const at = this.waiting.findIndex((i) => !isJob(i) || !i.first);
    this.waiting.splice(at < 0 ? this.waiting.length : at, 0, j);
  }

  private pump(): void {
    if (this.current) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.current = next;
    void (isJob(next) ? this.runJob(next) : this.runRemoval(next)).finally(() => { this.current = null; this.pump(); });
  }

  private async runRemoval(r: Removal): Promise<void> {
    try { r.end(await this.port.remove(r.name)); } catch (e) { r.end({ ok: false, line: msg(e) }); }
  }

  private async runJob(j: Job): Promise<void> {
    if (j.by === 'tool') { this.finish(j, await this.settle(j.root, Date.now() + this.graceMs)); return; }
    j.startedAt = Date.now();
    const run = j.run = this.port.run(j.root, j.args);
    this.changed(false);
    if (j.stopping) run.cancel();
    const timer = setTimeout(() => { j.overdue = true; run.cancel(); }, this.timeoutMs);
    let end: RunEnd | Error;
    try { end = await run.done; } catch (e) { end = e instanceof Error ? e : new Error(msg(e)); } finally { clearTimeout(timer); }
    if (end instanceof Error && !j.stopping && !j.overdue) { // the index front went away: what did the tool do?
      const now = await this.settle(j.root);
      if (now.state === 'done') { this.finish(j, now); return; }
      if (!j.retried) { this.waiting.unshift({ root: j.root, args: j.args, first: true, by: 'engine', retried: true }); return; }
      this.finish(j, { state: 'failed', error: end.message });
      return;
    }
    if (j.stopping || j.overdue) { // cancelled: wait until the tool really left the job (A2)
      const now = await this.settle(j.root);
      this.finish(j, j.overdue ? { state: 'failed', error: OVERDUE } : now.state === 'done' ? now : { state: 'cancelled' });
      return;
    }
    this.finish(j, end instanceof Error ? { state: 'failed', error: end.message } : end.ok ? { state: 'done' } : { state: 'failed', error: end.line });
  }

  /** Polls `status:true` until the tool no longer works on `root`; its final word. Before `idleUntil`, idle = not started yet. */
  private async settle(root: string, idleUntil = 0): Promise<{ state: 'done' | 'failed' | 'cancelled'; error?: string }> {
    for (;;) {
      let s: string;
      try { s = await this.port.status(root); } catch { s = 'running'; } // control front down: keep waiting
      if (BUSY.has(s)) idleUntil = 0;
      else if (!(s === 'idle' && Date.now() < idleUntil)) return s === 'succeeded' ? { state: 'done' } : s === 'failed' ? { state: 'failed', error: 'index thất bại' } : { state: 'cancelled' };
      await Bun.sleep(this.pollMs);
    }
  }

  private finish(j: Job, r: { state: 'done' | 'failed' | 'cancelled'; error?: string }): void {
    this.last.set(j.root, r);
    this.changed(true);
  }
}
