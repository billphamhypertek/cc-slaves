// v2.5 §5.4 graph fronts: thin `codebase-memory-mcp` stdio processes (one JSON-RPC message per line) of the per-user
// daemon. The control front (cwd = the engine data dir) lives while the module is managed and keeps the daemon warm
// (G0 §1); it restarts with a 1 → 2 → 4 … 30 s back-off. One session front per `claude` process that has the graph,
// in that session's cwd (so the tool's own watch refreshes that dir's index, §3-12): opened with the spawn, closed when
// the process exits or its token is replaced, respawned on the next call (the client's `initialize` replayed first).
// §5.5 the queue's port: tool calls on the control front, and each index job as a synchronous `index_repository` on its
// own index front (G0 §4: only that can be cancelled — `notifications/cancelled`, else SIGKILL of that front).
import type { Subprocess } from 'bun';
import type { Env } from '../session/env.ts';
import type { IndexArgs, IndexRun, QueuePort, RunEnd } from './queue.ts';
import type { GraphTool, ToolRead } from './tool.ts';

type RpcId = string | number;
export interface RpcRequest { jsonrpc: '2.0'; id: RpcId; method: string; params?: unknown }
export interface RpcNote { jsonrpc: '2.0'; method: string; params?: unknown }
export interface RpcReply { jsonrpc: '2.0'; id: RpcId | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

/** The front exited (or was closed) before it answered. */
export class FrontGone extends Error { override name = 'FrontGone'; }
/** No answer within the call's limit (the front is replaced). */
export class FrontTimeout extends Error { override name = 'FrontTimeout'; }

const INIT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
/** No index job outlives the queue's 30-min limit; this only bounds the request itself. */
const INDEX_REQUEST_MS = 31 * 60_000;
const KILL_AFTER_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;
/** §5.4 not up within 60 s → module `error` (the retries go on). */
const ERROR_AFTER_MS = 60_000;
const CLIENT_INFO = { name: 'cc-slaves', version: '1' };

class Front {
  readonly exited: Promise<void>;
  private readonly proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  private readonly pending = new Map<number, { id: RpcId; ok: (r: RpcReply) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private gone = false;
  byUs = false;
  /** The last stderr line (§5.3 the cause of `error`, e.g. a conflicting CBM process). */
  lastErr = '';

  constructor(path: string, cwd: string, env: Env) {
    this.proc = Bun.spawn([path], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    this.exited = Promise.all([this.readLoop(), this.readErr()]).then(() => {}).finally(() => this.end());
  }

  get alive(): boolean { return !this.gone; }

  /** One request on an internal id; the reply comes back with the caller's id. */
  request(m: RpcRequest, timeoutMs: number): Promise<RpcReply> { return this.send(m, timeoutMs).reply; }

  /** As request(), with the internal id (the `requestId` of `notifications/cancelled`). */
  send(m: RpcRequest, timeoutMs: number): { n: number; reply: Promise<RpcReply> } {
    if (this.gone) return { n: 0, reply: Promise.reject(new FrontGone()) };
    const n = ++this.seq;
    const reply = new Promise<RpcReply>((ok, fail) => {
      const timer = setTimeout(() => { this.pending.delete(n); fail(new FrontTimeout()); }, timeoutMs);
      this.pending.set(n, { id: m.id, ok, fail, timer });
      this.write({ ...m, id: n });
    });
    return { n, reply };
  }

  notify(m: RpcNote): void { if (!this.gone) this.write(m); }

  close(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.byUs = true;
    if (!this.gone) { this.proc.kill(signal); this.end(); }
  }

  private write(m: object): void {
    try { void this.proc.stdin.write(`${JSON.stringify(m)}\n`); void this.proc.stdin.flush(); } catch { this.end(); }
  }

  private async readLoop(): Promise<void> {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of this.proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('{')) this.onLine(line);
      }
    }
  }

  private async readErr(): Promise<void> {
    const text = await new Response(this.proc.stderr).text().catch(() => '');
    this.lastErr = text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  }

  private onLine(line: string): void {
    let m: RpcReply;
    try { m = JSON.parse(line) as RpcReply; } catch { return; }
    const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
    if (!p) return; // a server notification or a reply nobody waits for any more
    this.pending.delete(m.id as number);
    clearTimeout(p.timer);
    p.ok({ ...m, id: p.id });
  }

  private end(): void {
    if (this.gone) return;
    this.gone = true;
    try { void this.proc.stdin.end(); } catch { /* already closed */ }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.fail(new FrontGone()); }
    this.pending.clear();
  }
}

/** One session's front, as the `/mcp-graph` gate sees it (relay.ts `GraphPort`). */
class SessionFront {
  private front: Front | null = null;
  private starting: Promise<Front> | null = null;
  private init: RpcRequest | null = null;
  private closed = false;

  constructor(readonly sessionId: string, readonly cwd: string, private readonly spawn: (cwd: string) => Promise<Front>) {}

  async call(m: RpcRequest, timeoutMs: number): Promise<RpcReply> {
    if (m.method === 'initialize') this.init = m;
    const f = await this.ensure(m.method !== 'initialize');
    try {
      return await f.request(m, timeoutMs);
    } catch (e) {
      if (e instanceof FrontTimeout && this.front === f) { f.close(); this.front = null; } // replaced on the next call
      throw e;
    }
  }

  notify(m: RpcNote): void { void this.ensure(true).then((f) => f.notify(m), () => {}); }

  /** The front now (at the `claude` spawn: the daemon is already warm, G0 §1). */
  warm(): void { void this.ensure(false).catch(() => {}); }

  close(): void {
    this.closed = true;
    this.drop();
  }

  /** §5.6 the update closes the front; the session keeps its slot and respawns it on its next call. */
  drop(): void {
    this.front?.close();
    this.front = null;
    void this.starting?.then((f) => f.close(), () => {});
  }

  private ensure(replay: boolean): Promise<Front> {
    if (this.front?.alive) return Promise.resolve(this.front);
    this.starting ??= (async () => {
      const f = await this.spawn(this.cwd);
      if (this.closed) { f.close(); throw new FrontGone(); }
      if (replay && this.init) { // a respawned front never saw the client's handshake
        await f.request(this.init, INIT_TIMEOUT_MS);
        f.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      }
      this.front = f;
      return f;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
}

export interface GraphFrontsOptions {
  tool: GraphTool;
  /** The control front's cwd (the engine data dir). */
  dataDir: string;
  log: (line: string) => void;
  /** @internal test seam: the wait before restart attempt `n` (default 1 → 2 → 4 … 30 s). */
  backoffMs?: (n: number) => number;
  /** @internal test seam: §5.4 how long the control front may stay down before the module is `error` (default 60 s). */
  errorAfterMs?: number;
}

const textOf = (r: RpcReply): string => ((r.result as { content?: { text?: unknown }[] } | undefined)?.content?.[0]?.text as string | undefined) ?? '';
function parsed(r: RpcReply): Record<string, unknown> {
  if (r.error) throw new Error(r.error.message);
  const text = textOf(r);
  let v: unknown;
  try { v = JSON.parse(text); } catch { v = null; }
  const obj = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  if ((r.result as { isError?: unknown } | undefined)?.isError === true) throw new Error(typeof obj.error === 'string' ? obj.error : text);
  return obj;
}
const initMsg = (id: number): RpcRequest => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO } });
const toolCall = (name: string, args: Record<string, unknown>): RpcRequest => ({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name, arguments: args } });

export class GraphFronts implements QueuePort {
  private read: ToolRead = { state: 'missing' };
  private control: Front | null = null;
  private up = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** §5.6 an install / update runs: no front may spawn (rule 3 for every call). */
  private suspended = false;
  private downSince: number | null = null;
  private why = '';
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stateHooks: (() => void)[] = [];
  /** One front per live claude process, by session id (its token, cwd and graph live in TokenRegistry). */
  private readonly bySession = new Map<string, SessionFront>();
  private readonly upHooks: (() => void)[] = [];
  private readonly indexing = new Set<Front>();

  constructor(private readonly o: GraphFrontsOptions) {}

  /** Reads the tool (before any session spawns: the session MCP set depends on it) and starts the control front. */
  async start(): Promise<void> {
    this.read = await this.o.tool.read();
    if (this.managed() && !this.control && !this.timer) void this.startControl();
    else this.notifyState();
  }

  /** §5.7 the module manages the graph (tool ≥ MIN_GRAPH_VERSION, or an install / update running — §5.6 "Cập nhật từ bản
   *  old": every spawn from step (1) on has the entry): sessions get the cc-slaves entry. */
  managed(): boolean { return this.read.state === 'ready' || this.suspended; }

  /** §5.4 rule 3: calls are served only while the control front is up. */
  ready(): boolean { return this.managed() && this.up; }

  /** §5.3 the last tool read (path, version, state). */
  toolRead(): ToolRead { return this.read; }

  /** §5.3 module `error`: the control front has been down ≥ 60 s → its cause (the front's last stderr line); else null. */
  failing(): string | null {
    if (!this.managed() || this.up || this.suspended || this.downSince === null) return null;
    return Date.now() - this.downSince >= (this.o.errorAfterMs ?? ERROR_AFTER_MS) ? this.why : null;
  }

  /** Runs when the module state may have changed (up, down, the 60 s mark). */
  onState(fn: () => void): void { this.stateHooks.push(fn); }

  /** GR-err "Thử lại": start the control front now (the back-off starts again from 1 s). */
  retry(): void {
    if (this.stopped || this.suspended || this.up || !this.managed()) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.attempt = 0;
    void this.startControl();
  }

  /** §5.6 step (1)–(2) of an install / update: rule 3 from now, every front closed (index fronts killed: the queue
   *  re-queues their job), nothing spawns until resume(). Session fronts keep their slot. */
  suspend(): void {
    this.suspended = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const s of this.bySession.values()) s.drop();
    for (const f of this.indexing) f.close('SIGKILL');
    this.control?.close();
    this.control = null;
    this.setUp(false, '');
  }

  /** §5.6 step (5): read the tool again and open the control front (session fronts reopen on their next call). */
  async resume(): Promise<void> {
    this.suspended = false;
    this.attempt = 0;
    await this.start();
  }

  /** A `claude` process of `sessionId` is spawned (with a new token) in `cwd`: its front opens now (a previous one is replaced). */
  openSession(sessionId: string, cwd: string): void {
    this.closeSession(sessionId);
    if (!this.managed() || this.stopped) return; // §5.6 during an update every spawn has the entry
    const s = new SessionFront(sessionId, cwd, (dir) => this.spawn(dir));
    this.bySession.set(sessionId, s);
    s.warm();
  }

  /** That process exited (or the session ended): its front closes. */
  closeSession(sessionId: string): void {
    this.bySession.get(sessionId)?.close();
    this.bySession.delete(sessionId);
  }

  session(sessionId: string): SessionFront | null { return this.bySession.get(sessionId) ?? null; }

  /** Runs each time the control front comes up (the module becomes `ready`). */
  onUp(fn: () => void): void { this.upHooks.push(fn); }

  /** A tool call on the control front (`format:"json"`): the parsed JSON of its text; a tool error throws its line. */
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const f = this.control;
    if (!f || !this.up) throw new FrontGone();
    return parsed(await f.request(toolCall(name, { ...args, format: 'json' }), CALL_TIMEOUT_MS));
  }

  /** R4 the user's `auto_index` (`<tool> config get auto_index`); unreadable = false. */
  async autoIndex(): Promise<boolean> {
    if (this.read.state !== 'ready') return false;
    try {
      const p = Bun.spawn([this.read.path, 'config', 'get', 'auto_index'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: this.o.tool.env });
      const timer = setTimeout(() => p.kill('SIGKILL'), 10_000);
      const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      clearTimeout(timer);
      return /\btrue\b/.test(out);
    } catch { return false; }
  }

  async status(root: string): Promise<string> {
    const s = (await this.call('index_repository', { repo_path: root, status: true })).state;
    return typeof s === 'string' ? s : 'idle';
  }

  async remove(name: string): Promise<RunEnd> {
    try { await this.call('delete_project', { project: name }); return { ok: true }; } catch (e) { return { ok: false, line: e instanceof Error ? e.message : String(e) }; }
  }

  /** §5.5 one index job: a synchronous `index_repository` on its own front (cwd = data dir), closed when it ends. */
  run(root: string, args: IndexArgs): IndexRun {
    let front: Front | null = null;
    let req = 0;
    let cancelled = false;
    const kill = () => { front?.close('SIGKILL'); };
    const done = (async (): Promise<RunEnd> => {
      const f = front = await this.spawn(this.o.dataDir);
      this.indexing.add(f);
      try {
        const init = await f.request(initMsg(1), INIT_TIMEOUT_MS);
        if (init.error) throw new Error(init.error.message);
        f.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
        if (cancelled) return { ok: false, line: 'cancelled' };
        const sent = f.send(toolCall('index_repository', { ...args, repo_path: root, format: 'json' }), INDEX_REQUEST_MS);
        req = sent.n;
        const r = await sent.reply;
        try { parsed(r); return { ok: true }; } catch (e) { return { ok: false, line: e instanceof Error ? e.message : String(e) }; }
      } finally { this.indexing.delete(f); f.close(); }
    })();
    const cancel = () => {
      cancelled = true;
      if (!front || req === 0) return;
      front.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: req, reason: 'cc-slaves' } });
      setTimeout(kill, KILL_AFTER_MS); // the cancel did not take: the same result (G0 §4 C2)
    };
    return { done, cancel };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.errorTimer) clearTimeout(this.errorTimer);
    for (const sid of [...this.bySession.keys()]) this.closeSession(sid);
    for (const f of this.indexing) f.close('SIGKILL');
    this.control?.close();
    this.control = null;
    this.up = false;
  }

  /** §5.3 the version is re-read before every spawn (the file may have changed). */
  private async spawn(cwd: string): Promise<Front> {
    this.read = await this.o.tool.read();
    if (this.read.state !== 'ready' || this.stopped || this.suspended) throw new FrontGone();
    return new Front(this.read.path, cwd, this.o.tool.env);
  }

  private async startControl(): Promise<void> {
    this.timer = null;
    let f: Front | null = null;
    try {
      f = await this.spawn(this.o.dataDir);
      this.control = f;
      const init = await f.request(initMsg(1), INIT_TIMEOUT_MS);
      if (init.error) throw new Error(init.error.message);
      f.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const list = await f.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, INIT_TIMEOUT_MS);
      const tools = (list.result as { tools?: { name?: unknown }[] } | undefined)?.tools ?? [];
      if (!tools.some((t) => t.name === 'search_graph')) throw new Error('no search_graph tool');
      if (this.stopped || this.control !== f) return;
      this.attempt = 0;
      this.setUp(true, '');
      for (const fn of this.upHooks) fn();
      const live = f;
      void live.exited.then(() => { if (!live.byUs && this.control === live) this.controlDown(live.lastErr || 'control front exited'); });
    } catch (e) {
      if (f) await Promise.race([f.exited, Bun.sleep(KILL_AFTER_MS)]); // its stderr says why it would not start
      f?.close();
      const line = e instanceof FrontGone ? f?.lastErr || 'control front exited' : e instanceof Error ? e.message : String(e);
      if (this.control === f || f === null) this.controlDown(line);
    }
  }

  private setUp(up: boolean, why: string): void {
    this.up = up;
    if (up) this.downSince = null;
    else if (this.downSince === null) this.downSince = Date.now();
    if (why) this.why = why;
    if (this.errorTimer) { clearTimeout(this.errorTimer); this.errorTimer = null; }
    if (!up && !this.suspended && !this.stopped) {
      const left = Math.max(0, this.downSince! + (this.o.errorAfterMs ?? ERROR_AFTER_MS) - Date.now());
      this.errorTimer = setTimeout(() => { this.errorTimer = null; this.notifyState(); }, left + 5);
    }
    this.notifyState();
  }

  private notifyState(): void { for (const fn of this.stateHooks) fn(); }

  private controlDown(why: string): void {
    this.control = null;
    this.setUp(false, why);
    if (this.stopped || this.suspended || !this.managed() || this.timer) return;
    const wait = (this.o.backoffMs ?? ((n) => Math.min(1000 * 2 ** n, BACKOFF_CAP_MS)))(this.attempt++);
    this.o.log(`graph: ${why} → thử lại sau ${Math.round(wait / 1000)} s`);
    this.timer = setTimeout(() => { void this.startControl(); }, wait);
  }
}
