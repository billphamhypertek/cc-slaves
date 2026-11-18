// v2.2 §5.4b "Kiểm tra" (C12): a minimal MCP client — `initialize` + `tools/list`, 10 s for the whole check. Remote
// servers go through the proxy's in-process `forward` (same upstream token and refresh, no session token) or, when the
// entry carries its own Authorization header (C9), straight to the URL. Local servers are spawned from the entry as the
// session file has it (plugin variables already expanded by the catalog; `${VAR}` expanded here as Claude Code does),
// JSON-RPC over stdio, and the whole process group is killed afterwards. C22 decides what may run at all.
import { spawn } from 'node:child_process';
import { isObj } from '../../../shared/json.ts';

/** Why a check failed; the view maps each code to a `skillsMcp.mcpErr.*` key. */
export type ProbeErrorCode = 'timeout' | 'network' | 'needs_login' | 'insufficient_scope' | 'endpoint_foreign' | 'http' | 'rpc' | 'bad_response' | 'spawn' | 'exited';

export interface ProbeResult {
  state: 'connected' | 'needs_login' | 'error';
  /** Tool names (`tools/list`, every page). */
  tools: string[];
  error: { code: ProbeErrorCode; detail: string | null } | null;
  /** Epoch ms the check finished (compared with the lanes' `system/init`: the latest wins). */
  at: number;
}

const PROBE_TIMEOUT_MS = 10_000;
const AUTO_PARALLEL = 4;
const PROTOCOL_VERSION = '2025-11-25';
const CLIENT_INFO = { name: 'cc-slaves-probe', version: '1' };
const MAX_PAGES = 20;
const KILL_GRACE_MS = 1000;

// ---------- C22 scope (pure) ----------

export interface ProbeTarget {
  source: 'user' | 'local' | 'project' | 'plugin';
  kind: 'stdio' | 'http' | 'sse' | 'ws';
  /** In lanes: on for lanes and (for `project:`) approved. */
  forLanes: boolean;
  /** K1-local: a local entry of a path that is no added project root. */
  unused: boolean;
  /** C20: an unknown `${CLAUDE_PLUGIN_*}` variable (the entry cannot be expanded). */
  error: boolean;
  /** C9 `headersHelper`: auth comes from running another command — never run by a check. */
  selfAuthHelper: boolean;
}

/**
 * §5.4b C22: a check never runs a command a lane is not allowed to run. `auto` = boot / after save / edit / login;
 * `po` = the "Kiểm tra" button (false → hidden).
 */
export function probeScope(t: ProbeTarget): { auto: boolean; po: boolean } {
  const none = { auto: false, po: false };
  if (t.error || t.kind === 'ws' || t.selfAuthHelper) return none;
  if (t.source === 'project' && !t.forLanes) return none; // K7: unapproved / left off — never spawned, no button (F3)
  if (t.unused) return { auto: false, po: t.kind !== 'stdio' };
  return { auto: t.forLanes, po: true };
}

// ---------- `${VAR}` expansion ----------

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Deep-expands `${VAR}` / `${VAR:-default}` in every string from `env` (Claude Code's own expansion); unknown stays. */
export function expandVars<T>(v: T, env: Readonly<Record<string, string | undefined>>): T {
  if (typeof v === 'string') return v.replace(VAR, (m, name: string, dflt: string | undefined) => env[name] ?? dflt ?? m) as T;
  if (Array.isArray(v)) return (v as unknown[]).map((x) => expandVars(x, env)) as T;
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandVars(x, env)])) as T;
  return v;
}

// ---------- JSON-RPC helpers ----------

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; result?: unknown; error?: { message?: unknown } };

class ProbeError extends Error {
  constructor(readonly code: ProbeErrorCode, readonly detail: string | null = null) { super(code); }
}

const req = (id: number, method: string, params: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const note = (method: string): string => JSON.stringify({ jsonrpc: '2.0', method });
const initParams = { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO };

/** The `result` of a JSON-RPC answer; an error answer → `rpc`. */
function resultOf(m: Rpc): Record<string, unknown> {
  if (m.error !== undefined) throw new ProbeError('rpc', typeof m.error?.message === 'string' ? m.error.message : JSON.stringify(m.error));
  if (!isObj(m.result)) throw new ProbeError('bad_response');
  return m.result;
}

function toolNames(r: Record<string, unknown>): string[] {
  if (!Array.isArray(r.tools)) throw new ProbeError('bad_response');
  return r.tools.flatMap((x) => (isObj(x) && typeof x.name === 'string' ? [x.name] : []));
}

/** `initialize` → `notifications/initialized` → `tools/list` (every page) over one `call` / `notify` pair. */
async function handshake(call: (id: number, method: string, params: unknown) => Promise<Rpc>, notify: (method: string) => Promise<void>): Promise<string[]> {
  resultOf(await call(1, 'initialize', initParams));
  await notify('notifications/initialized');
  const tools: string[] = [];
  let cursor: unknown;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = resultOf(await call(2 + page, 'tools/list', cursor === undefined ? {} : { cursor }));
    tools.push(...toolNames(r));
    if (typeof r.nextCursor !== 'string' || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return tools;
}

// ---------- SSE reading ----------

interface SseEvent { event: string; data: string }

/** Events of a text/event-stream body, one at a time (`null` at the end). */
function sseReader(body: ReadableStream<Uint8Array>): { next: () => Promise<SseEvent | null>; cancel: () => void } {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const next = async (): Promise<SseEvent | null> => {
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      if (m) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const lines = block.split(/\r?\n/);
        const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (data) return { event, data };
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
    }
  };
  return { next, cancel: () => { void reader.cancel().catch(() => {}); } };
}

const parse = (s: string): Rpc => { try { const v: unknown = JSON.parse(s); return isObj(v) ? v : {}; } catch { throw new ProbeError('bad_response'); } };

// ---------- remote ----------

export interface RemoteProbe {
  /** One HTTP exchange of the check (`url` absolute: the base or the legacy endpoint resolved against it). */
  send: (url: string, init: RequestInit) => Promise<Response>;
  /** The URL the client talks to (the configured URL, or the proxy path for in-process forwards). */
  base: string;
  legacySse: boolean;
  /** Proxy mode: the proxy's last log line of this server (its status + error code: `endpoint_foreign`, `timeout`, …). */
  lastProxyLine?: () => { status: number; error?: string } | undefined;
}

const PROXY_CODES: ReadonlySet<string> = new Set(['timeout', 'network', 'needs_login', 'insufficient_scope', 'endpoint_foreign']);

function httpFail(res: Response, last: { status: number; error?: string } | undefined): ProbeError {
  if (last?.error !== undefined && last.status === res.status && PROXY_CODES.has(last.error)) return new ProbeError(last.error as ProbeErrorCode);
  if (res.status === 401) return new ProbeError('needs_login');
  if (res.status === 504) return new ProbeError('timeout');
  if (res.status === 502) return new ProbeError('network');
  return new ProbeError('http', String(res.status));
}

/** Streamable HTTP (2025-11-25 / 2026-07-28): POST each message, the answer as JSON or as an SSE stream. */
async function streamable(p: RemoteProbe, signal: AbortSignal): Promise<string[]> {
  let session: string | null = null;
  let version: string | null = null;
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}),
  });
  const post = async (body: string): Promise<Response> => {
    const res = await p.send(p.base, { method: 'POST', headers: headers(), body, signal });
    if (!res.ok) { void res.body?.cancel(); throw httpFail(res, p.lastProxyLine?.()); }
    return res;
  };
  const call = async (id: number, method: string, params: unknown): Promise<Rpc> => {
    const res = await post(req(id, method, params));
    session ??= res.headers.get('mcp-session-id');
    if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
      const m = parse(await res.text());
      if (method === 'initialize' && isObj(m.result) && typeof m.result.protocolVersion === 'string') version = m.result.protocolVersion;
      return m;
    }
    if (!res.body) throw new ProbeError('bad_response');
    const sse = sseReader(res.body);
    try {
      for (let e = await sse.next(); e; e = await sse.next()) {
        const m = parse(e.data);
        if (m.id === id) return m;
      }
      throw new ProbeError('bad_response');
    } finally { sse.cancel(); }
  };
  try {
    return await handshake(call, async (m) => { const res = await post(note(m)); void res.body?.cancel(); });
  } finally {
    if (session) void p.send(p.base, { method: 'DELETE', headers: headers() }).then((r) => r.body?.cancel(), () => {});
  }
}

/** Legacy HTTP+SSE (2024-11-05): GET opens the stream, `endpoint` names the POST URL, answers come on the stream. */
async function legacy(p: RemoteProbe, signal: AbortSignal): Promise<string[]> {
  const res = await p.send(p.base, { method: 'GET', headers: { accept: 'text/event-stream' }, signal });
  if (!res.ok || !res.body) { void res.body?.cancel(); throw httpFail(res, p.lastProxyLine?.()); }
  const sse = sseReader(res.body);
  try {
    let e = await sse.next();
    while (e && e.event !== 'endpoint') e = await sse.next();
    if (!e) throw new ProbeError(p.lastProxyLine?.()?.error === 'endpoint_foreign' ? 'endpoint_foreign' : 'bad_response');
    const base = new URL(p.base);
    const endpoint = new URL(e.data, base);
    if (endpoint.origin !== base.origin) throw new ProbeError('endpoint_foreign');
    const post = async (body: string): Promise<void> => {
      const r = await p.send(endpoint.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });
      void r.body?.cancel();
      if (!r.ok) throw httpFail(r, p.lastProxyLine?.());
    };
    const call = async (id: number, method: string, params: unknown): Promise<Rpc> => {
      await post(req(id, method, params));
      for (let m = await sse.next(); m; m = await sse.next()) {
        if (m.event !== 'message') continue;
        const rpc = parse(m.data);
        if (rpc.id === id) return rpc;
      }
      throw new ProbeError(p.lastProxyLine?.()?.error === 'endpoint_foreign' ? 'endpoint_foreign' : 'bad_response');
    };
    return await handshake(call, (m) => post(note(m)));
  } finally { sse.cancel(); }
}

/** §5.4b check of a remote server (≤ `timeoutMs` in all). */
export function probeRemote(p: RemoteProbe, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return withTimeout(timeoutMs, (signal) => (p.legacySse ? legacy(p, signal) : streamable(p, signal)));
}

// ---------- local (stdio) ----------

export interface StdioProbe {
  command: string;
  args: readonly string[];
  /** The full child env (the stripped login env + the entry's expanded `env`). */
  env: Record<string, string>;
  cwd: string;
  /** Test hook: the spawned leader pid. */
  onSpawn?: (pid: number) => void;
}

const groupAlive = (pid: number): boolean => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const killGroup = (pid: number, sig: NodeJS.Signals): void => { try { process.kill(-pid, sig); } catch { /* already gone */ } };

/** §5.4b check of a local server: own process group (detached), newline-delimited JSON-RPC, group killed after. */
export function probeStdio(s: StdioProbe, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return withTimeout(timeoutMs, async (signal) => {
    const child = spawn(s.command, [...s.args], { cwd: s.cwd, env: s.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString('utf8')).slice(-500); });
    const waiting = new Map<number, (m: Rpc) => void>();
    let failed: ProbeError | null = null;
    let fail: (e: ProbeError) => void = () => {};
    const dead = new Promise<never>((_, reject) => { fail = (e) => { failed ??= e; reject(failed); }; });
    dead.catch(() => {});
    child.on('error', (e) => fail(new ProbeError('spawn', e.message)));
    child.on('exit', (code, sig) => fail(new ProbeError('exited', stderr.trim() || `exit ${sig ?? code}`)));
    child.stdin.on('error', () => {});
    signal.addEventListener('abort', () => fail(new ProbeError('timeout')));
    let buf = '';
    child.stdout.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m: Rpc;
        try { m = parse(line); } catch { continue; } // servers may log on stdout; only JSON-RPC lines count
        if (typeof m.id === 'number') waiting.get(m.id)?.(m);
      }
    });
    const write = (line: string): void => { if (!failed) child.stdin.write(`${line}\n`); };
    const call = (id: number, method: string, params: unknown): Promise<Rpc> =>
      Promise.race([dead, new Promise<Rpc>((resolve) => { waiting.set(id, resolve); write(req(id, method, params)); })]);
    try {
      if (child.pid === undefined) await dead;
      s.onSpawn?.(child.pid!);
      return await handshake(call, (m) => { write(note(m)); return Promise.resolve(); });
    } finally {
      const pid = child.pid;
      if (pid !== undefined) {
        child.stdin.end();
        killGroup(pid, 'SIGTERM');
        setTimeout(() => { if (groupAlive(pid)) killGroup(pid, 'SIGKILL'); }, KILL_GRACE_MS).unref();
      }
    }
  });
}

// ---------- result ----------

async function withTimeout(ms: number, f: (signal: AbortSignal) => Promise<string[]>): Promise<ProbeResult> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new ProbeError('timeout')); }, ms); });
  try {
    const tools = await Promise.race([f(ctl.signal), timeout]);
    return { state: 'connected', tools, error: null, at: Date.now() };
  } catch (e) {
    const err = e instanceof ProbeError ? e : ctl.signal.aborted ? new ProbeError('timeout') : new ProbeError('network', e instanceof Error ? e.message : String(e));
    const login = err.code === 'needs_login' || err.code === 'insufficient_scope';
    return { state: login ? 'needs_login' : 'error', tools: [], error: { code: err.code, detail: err.detail }, at: Date.now() };
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

// ---------- queue ----------

export interface ProbeRunnerDeps {
  run: (id: string) => Promise<ProbeResult>;
  /** A check started or finished (the view's `checking` / `probe` changed). */
  onChange: () => void;
  limit?: number;
}

/** §5.4b the checks in flight: auto ones ≤ 4 at once, a PO check jumps the queue; one run per id at a time. */
export class ProbeRunner {
  private readonly results = new Map<string, ProbeResult>();
  private readonly active = new Set<string>();
  private readonly waiting: string[] = [];
  private readonly idlers: (() => void)[] = [];
  private readonly limit: number;

  constructor(private readonly d: ProbeRunnerDeps) { this.limit = d.limit ?? AUTO_PARALLEL; }

  /** Auto checks (boot, after save / edit / login): the caller already filtered by `probeScope().auto`. */
  schedule(ids: readonly string[]): void {
    for (const id of ids) if (!this.active.has(id) && !this.waiting.includes(id)) this.waiting.push(id);
    this.pump();
  }

  /** "Kiểm tra": first in line (the caller already checked `probeScope().po`). */
  check(id: string): void {
    if (this.active.has(id)) return;
    const at = this.waiting.indexOf(id);
    if (at >= 0) this.waiting.splice(at, 1);
    this.waiting.unshift(id);
    this.pump();
  }

  result(id: string): ProbeResult | undefined { return this.results.get(id); }
  running(id: string): boolean { return this.active.has(id); }
  queued(id: string): boolean { return this.waiting.includes(id); }
  /** Changes whenever a result lands (the view poll's signature). */
  get version(): number { return this.results.size === 0 ? 0 : Math.max(...[...this.results.values()].map((r) => r.at)); }

  /** Resolves when nothing is running or queued. */
  idle(): Promise<void> {
    if (this.active.size === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idlers.push(resolve));
  }

  private pump(): void {
    let started = false;
    while (this.active.size < this.limit && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      this.active.add(id);
      started = true;
      void this.d.run(id)
        .catch((e: unknown): ProbeResult => ({ state: 'error', tools: [], error: { code: 'exited', detail: e instanceof Error ? e.message : String(e) }, at: Date.now() }))
        .then((r) => {
          this.results.set(id, r);
          this.active.delete(id);
          this.d.onChange();
          this.pump();
          if (this.active.size === 0 && this.waiting.length === 0) for (const f of this.idlers.splice(0)) f();
        });
    }
    if (started) this.d.onChange();
  }
}
