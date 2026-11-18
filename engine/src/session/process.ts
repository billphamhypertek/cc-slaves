// One running `claude` session (spec §3.3, §7.3, §7.4, §7.6, §8.4): spawn, self-check, stdout pump, stdin via the outbox.
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Subprocess } from 'bun';
import type { KeyedReason } from '../../../shared/protocol.ts';
import { reason, type Params } from '../../../shared/i18n/index.ts';
import type { SendAttachment } from '../attach/store.ts';
import type { OutboxMsg } from '../db.ts';
import { WriteLog, type Outbox, type Outgoing } from '../outbox.ts';
import { ensureDir, FILE_MODE, paths } from '../paths.ts';
import { contextPct, contextTokens, LineSplitter, parseLine, TooLong, type InitEvent, type McpInitStore, type ResultEvent, type StreamEvent } from '../stream/parser.ts';
import { interruptLine } from '../stream/writer.ts';
import { accountAddDirs, buildArgs, type ArgsInput } from './args.ts';
import type { Caffeinate } from './caffeinate.ts';
import type { Env } from './env.ts';
import type { UpdateBusy } from '../../../shared/update.ts';
import type { UpdateGate } from '../update/commit.ts';

export const MIN_CLAUDE_VERSION = '2.1.325';
const INIT_TIMEOUT_MS = 60_000;
const INTERRUPT_TIMEOUT_MS = 10_000;
const IN_USE_WAIT_MS = 5_000;
const MAX_SPAWN_TRIES = 3;
const RECENT_LINES = 50;
/** v2.4 §5.2 the whole handshake chain is ≤ 5 s; past it the first batch goes out anyway. */
const HANDSHAKE_TIMEOUT_MS = 5_000;
const STDERR_TAIL = 4000;

export interface ProcInfo { pid: number; command: string }

export interface SessionOptions {
  sessionId: string;
  resume: boolean;
  /** Required when resume: the engine's resume message, sent before every undelivered message (§7.6). */
  resumeText?: string;
  projectId: string;
  lane: string;
  /** Run number for `logs/<project>/<lane>/run-<n>.jsonl`. */
  runN: number;
  /** The session argv (`buildArgs`), or v2.9 §5.9 the author session's own whitelist argv (`buildAuthorArgs`), taken whole. */
  args: Omit<ArgsInput, 'sessionId' | 'resume' | 'addDirs'> | { argv: readonly string[]; model?: string | null };
  cwd: string;
  /** v2 §5.4: CLAUDE_CONFIG_DIR + `--add-dir <dir>/projects <dir>/plans`; neither for the terminal account (hf1116 T2). */
  account: { email: string; configDir: string; terminal?: boolean };
  outbox: Outbox;
  /** Absolute `claude` (tests: `['bun', fake-claude]`). */
  command: string[];
  /** Child env, evaluated on every spawn attempt (env.ts childEnv). */
  env: () => Env;
  initTimeoutMs?: number;
  interruptTimeoutMs?: number;
  minVersion?: string;
  /** The MCP server the init line must show connected (v2.9 §5.9 the author session's is `cc_draft`). */
  mcpServer?: string;
  /** §3.4 optional check at init (`claude auth status --json`); null = unknown, not a failure. */
  authEmail?: () => Promise<string | null>;
  ps?: () => Promise<ProcInfo[]>;
  kill?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  caffeinate?: Caffeinate;
  /**
   * v2 §5.3 runs right before each spawn (engine: `ensureMirrored` + the §5.5 shared-config check). `false` = that
   * account's shared config is broken → nothing is spawned, `start()` fails `shared_cfg` (IMPORTANT-4).
   */
  beforeSpawn?: (configDir: string) => boolean | void;
  /** v2.2 §5.1 every `system/init` reports its MCP servers here, per (project, server) — not per account. */
  mcpInit?: McpInitStore;
  /**
   * v2.4 §5.2 runs on every spawn attempt between the spawn and the first batch (orchestrator only: the model / effort
   * handshake over `control()`). Its error, or running past `handshakeTimeoutMs`, never keeps the first batch back.
   */
  beforeFirstWrite?: (proc: SessionProcess) => Promise<void>;
  handshakeTimeoutMs?: number;
  /** v2.6 §5.4 the update gate this process writes through; `kind` names it in `busy` while its spawn runs. */
  update?: { gate: UpdateGate; kind: UpdateBusy['kind'] };
}

/** v2.4 §10.2 a control request to Claude Code (NC §8: list_models, get_settings, set_model, apply_flag_settings). */
type ControlRequest = { subtype: string } & Record<string, unknown>;
/** `errorCode` as Claude Code sends it (`not_found`, `unsupported_request`, NC §8-2 / §8-14). */
type ControlReply = { ok: true; response: Record<string, unknown> } | { ok: false; error: string; errorCode: string | null };

/** v2.4 §10.2 A5 every image block's `source.data` (also inside a `tool_result`) → `<lược n byte>`, before the line is
 * logged, kept or parsed: no image byte reaches the run log, `recentLines` (lane_tail), the event bus or state.db. */
export function stripImageData(line: string): string {
  if (!line.includes('"image"')) return line;
  let o: unknown;
  try { o = JSON.parse(line); } catch { return line; }
  let hit = false;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v !== 'object' || v === null) return;
    const r = v as Record<string, unknown>;
    const src = r.source as Record<string, unknown> | undefined;
    if (r.type === 'image' && typeof src?.data === 'string') {
      const d = src.data;
      src.data = `<lược ${Math.floor((d.length * 3) / 4) - (d.endsWith('==') ? 2 : d.endsWith('=') ? 1 : 0)} byte>`;
      hit = true;
    }
    for (const x of Object.values(r)) walk(x);
  };
  walk(o);
  return hit ? JSON.stringify(o) : line;
}

class SharedCfgBroken extends Error { constructor(readonly email: string) { super(email); } }

type FailureKind =
  | 'wrong_account' | 'no_message' | 'spawn_failed' | 'in_use' | 'exited_before_init' | 'init_timeout'
  | 'old_version' | 'mcp_missing' | 'mcp_not_connected' | 'shared_cfg';

/** Self-check failure (§7.3): the process is gone; it never counts as a lane run. */
/** `message` is the vi text of `reason` (`errors.start_<kind>`, §6A: the UI renders the reason in `ui.lang`). */
interface StartFailure { kind: FailureKind; message: string; reason: KeyedReason; version: string | null; stderr: string; countsAsRun: false }
export type StartResult = { ok: true; version: string | null; init: InitEvent } | { ok: false; failure: StartFailure };

export type Requested = 'close' | 'terminate' | 'selfcheck';
export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** A result line was seen in this process. */
  sawResult: boolean;
  /** A turn was in flight (user written or assistant seen after the last result). */
  midTurn: boolean;
  requested: Requested | null;
  /** requested → the engine asked; died_mid_turn → crash in a turn; exited_idle → quit by itself between turns. */
  kind: 'requested' | 'died_mid_turn' | 'exited_idle';
  lastResult: ResultEvent | null;
  stderr: string;
}

/** §6A "claude thoát (mã N / tín hiệu X) khi chưa xong lượt" as a keyed reason (+ its vi text). */
export const exitReason = (x: Pick<ExitInfo, 'code' | 'signal'>) =>
  (x.signal ? reason('errors.exitSignal', { signal: x.signal }) : reason('errors.exitCode', { code: x.code ?? 'null' }));

export interface SessionEventMap { event: StreamEvent; exit: ExitInfo }
type Listener<K extends keyof SessionEventMap> = (v: SessionEventMap[K]) => void;

export function versionAtLeast(v: string | null, min: string): boolean {
  const m = v ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  if (!m) return false;
  const a = m.slice(1, 4).map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > (b[i] ?? 0);
  return true;
}

async function defaultPs(): Promise<ProcInfo[]> {
  const p = Bun.spawn(['ps', '-axo', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(p.stdout).text();
  return out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), command: m[2]! }));
}

interface Attempt {
  proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  init: Promise<InitEvent | null>;
  done: Promise<void>;
}

export class SessionProcess {
  /** Last raw stdout lines (§8.4: nothing older is kept in RAM; the run log has everything). */
  readonly recentLines: string[] = [];

  private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null;
  private exitedFlag = true;
  private listeners: { [K in keyof SessionEventMap]: Listener<K>[] } = { event: [], exit: [] };
  private inTurn = false;
  private sawResult = false;
  private lastResult: ResultEvent | null = null;
  private requested: Requested | null = null;
  private stderr = '';
  private logFd: number | null = null;
  private resultWaiters: ((r: ResultEvent | null) => void)[] = [];
  private releaseCaffeinate: (() => void) | null = null;
  private exitPromise: Promise<void> = Promise.resolve();
  private initSeen = false;
  private turnStart: number | null = null;
  private ctxPct: number | null = null;
  private ctxTok: number | null = null;
  private model: string | null = null;
  private controls = new Map<string, { resolve: (r: ControlReply) => void; reject: (e: Error) => void }>();
  /** v2.4 §5.3 set by `hold()`; `starting` = between spawn and the first batch (§5.2). Either keeps `flush()` quiet. */
  private holding = false;
  private starting = false;
  /** v2.4 §6.6 rows this process wrote, until replayed (raw rows: until the result of their own turn). */
  private log = new WriteLog();
  /** v2.4 §6.4 rows with attachments render async; every later row waits behind them so stdin keeps the outbox order. */
  private chain: Promise<void> | null = null;

  constructor(private readonly o: SessionOptions) {}

  on<K extends keyof SessionEventMap>(k: K, f: Listener<K>): void { this.listeners[k].push(f); }
  private emit<K extends keyof SessionEventMap>(k: K, v: SessionEventMap[K]): void { for (const f of this.listeners[k]) f(v); }

  get alive(): boolean { return !this.exitedFlag; }
  /** Epoch ms the current turn started (a message written / a self-started turn); null between turns. */
  get turnStartedAt(): number | null { return this.alive ? this.turnStart : null; }
  /** Context fill of the last top-level assistant message, whole percent of the model's window; null = none yet. */
  get contextPct(): number | null { return this.ctxPct; }
  /** v2.1 §4.14 context tokens of the last top-level assistant message; null = none yet. */
  get contextTokens(): number | null { return this.ctxTok; }
  get pid(): number | null { return this.proc?.pid ?? null; }

  // ---------- start + self-check (§7.3) ----------

  /** v2.6 §5.4-4 from here to the end of the self-check this spawn is busy (lane by name, orchestrator by session id). */
  async start(): Promise<StartResult> {
    const u = this.o.update;
    u?.gate.spawnBegan(this, { projectId: this.o.projectId, kind: u.kind, name: u.kind === 'orchestrator' ? this.o.sessionId : this.o.lane, turnStartedAt: Date.now() });
    try { return await this.boot(); } finally { u?.gate.spawnEnded(this); }
  }

  private async boot(): Promise<StartResult> {
    const o = this.o;
    const fail = (kind: FailureKind, params?: Params, version: string | null = null): StartResult => {
      const { text, ...r } = reason(`errors.start_${kind}`, params);
      return { ok: false, failure: { kind, message: text, reason: r, version, stderr: this.stderr, countsAsRun: false } };
    };

    // A new process: rows written to an earlier one and never replayed go out again (resume does the same).
    if (!o.resume) o.outbox.resetWritten(o.sessionId);
    const first: Outgoing[] = o.resume
      ? o.outbox.undeliveredAfterResume(o.sessionId, o.resumeText ?? 'Tiếp tục công việc đang dở.')
      : o.outbox.nextToSend(o.sessionId);
    if (first.length === 0) return fail('no_message');
    const unsend = () => o.outbox.onStillQueued(first.map((m) => m.uuid));

    const sleep = o.sleep ?? Bun.sleep;
    for (let attempt = 1; ; attempt++) {
      let a: Attempt;
      try {
        a = this.spawnOnce(attempt);
      } catch (e) {
        unsend();
        if (e instanceof SharedCfgBroken) return fail('shared_cfg', { email: e.email });
        return fail('spawn_failed', { err: (e as Error).message });
      }
      await this.handshake();
      this.writeRows(first);
      this.turnBegins();
      this.starting = false;
      this.flush(); // anything sent while the hook ran goes after the first batch

      const timeoutMs = o.initTimeoutMs ?? INIT_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
      const init = await Promise.race([a.init, timedOut]);
      clearTimeout(timer);

      if (init === 'timeout') {
        unsend();
        await this.terminate(2000, 'selfcheck');
        return fail('init_timeout', { s: Math.round(timeoutMs / 1000) });
      }
      if (init === null) {
        // exited before init
        const inUse = /already in use/i.test(this.stderr);
        if (inUse && attempt < MAX_SPAWN_TRIES) {
          await this.killOrphans();
          await sleep(IN_USE_WAIT_MS);
          continue;
        }
        unsend();
        return inUse
          ? fail('in_use', { session: o.sessionId, n: MAX_SPAWN_TRIES })
          : fail('exited_before_init', { stderr: this.stderr.slice(-300) });
      }

      const version = init.claudeCodeVersion;
      const min = o.minVersion ?? MIN_CLAUDE_VERSION;
      let bad: StartResult | null = null;
      const mcp = init.mcpServers.find((s) => s.name === (o.mcpServer ?? 'cc_slaves'));
      if (!versionAtLeast(version, min)) bad = fail('old_version', { version: version ?? '?', min }, version);
      else if (!mcp) bad = fail('mcp_missing', undefined, version);
      else if (mcp.status !== 'connected') bad = fail('mcp_not_connected', { status: mcp.status }, version);
      else if (o.authEmail) {
        const e = await o.authEmail();
        if (e !== null && e !== o.account.email) bad = fail('wrong_account', { got: e, want: o.account.email }, version);
      }
      if (bad) {
        unsend();
        await this.terminate(2000, 'selfcheck');
        return bad;
      }
      return { ok: true, version, init };
    }
  }

  /** §5.2 runs the hook, bounded; its failure goes to the run log only (the session starts either way). */
  private async handshake(): Promise<void> {
    const hook = this.o.beforeFirstWrite;
    if (!hook) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((r) => { timer = setTimeout(r, this.o.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS); });
    try {
      await Promise.race([hook(this), cap]);
    } catch (e) {
      this.record(JSON.stringify({ cc_slaves: 'handshake_failed', error: (e as Error).message }));
    } finally { clearTimeout(timer); }
  }

  private async killOrphans(): Promise<void> {
    const id = this.o.sessionId;
    const list = await (this.o.ps ?? defaultPs)();
    const kill = this.o.kill ?? ((pid: number) => { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } });
    for (const p of list) if (p.command.includes(id) && p.pid !== process.pid && p.pid !== this.proc?.pid) kill(p.pid);
  }

  private spawnOnce(attempt: number): Attempt {
    const o = this.o;
    this.stderr = '';
    this.requested = null;
    this.sawResult = false;
    this.lastResult = null;
    this.inTurn = false;
    this.turnStart = null;
    this.initSeen = false;
    this.holding = false; // §10.2 a new process never starts held
    this.starting = true;
    this.log = new WriteLog();
    this.chain = null;
    if (o.beforeSpawn?.(o.account.configDir) === false) throw new SharedCfgBroken(o.account.email);
    const argv = [...o.command, ...('argv' in o.args ? o.args.argv : buildArgs({ ...o.args, addDirs: accountAddDirs(o.account), sessionId: o.sessionId, resume: o.resume }))];
    const proc = Bun.spawn(argv, { cwd: o.cwd, env: o.env(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    this.proc = proc;
    this.exitedFlag = false;
    if (this.logFd === null) {
      const log = paths().runLog(o.projectId, o.lane, o.runN);
      ensureDir(dirname(log));
      this.logFd = openSync(log, 'a', FILE_MODE);
    }
    this.releaseCaffeinate = o.caffeinate?.acquire() ?? null;

    let resolveInit: (e: InitEvent | null) => void = () => {};
    const init = new Promise<InitEvent | null>((r) => { resolveInit = r; });
    const errPump = (async () => {
      const dec = new TextDecoder();
      for await (const c of proc.stderr) this.stderr = (this.stderr + dec.decode(c, { stream: true })).slice(-STDERR_TAIL);
    })();
    const outPump = (async () => {
      const split = new LineSplitter();
      const handle = (l: string | TooLong) => {
        const raw = l instanceof TooLong ? JSON.stringify({ cc_slaves: 'line_too_long', length: l.length }) : stripImageData(l);
        this.record(raw);
        const e = l instanceof TooLong ? ({ kind: 'unknown', reason: 'line_too_long', line: null, raw: null } as const) : parseLine(raw);
        if (e.kind === 'init') { this.initSeen = true; resolveInit(e); }
        this.onEvent(e);
      };
      for await (const c of proc.stdout) for (const l of split.push(c)) handle(l);
      for (const l of split.end()) handle(l);
    })();
    const done = (async () => {
      await Promise.all([outPump, errPump, proc.exited]);
      this.exitedFlag = true;
      this.starting = false;
      resolveInit(null);
      for (const c of [...this.controls.values()]) c.reject(new Error('claude exited'));
      this.controls.clear();
      this.releaseCaffeinate?.();
      this.releaseCaffeinate = null;
      for (const w of this.resultWaiters.splice(0)) w(null);
      // An attempt that start() will retry is not a session exit (it never reached init).
      if (attempt < MAX_SPAWN_TRIES && !this.initSeen && /already in use/i.test(this.stderr)) return;
      if (this.logFd !== null) { closeSync(this.logFd); this.logFd = null; }
      const requested = this.requested;
      this.emit('exit', {
        code: proc.exitCode, signal: proc.signalCode == null ? null : String(proc.signalCode), sawResult: this.sawResult, midTurn: this.inTurn, requested,
        kind: requested ? 'requested' : this.inTurn ? 'died_mid_turn' : 'exited_idle', lastResult: this.lastResult,
        stderr: this.stderr,
      });
    })();
    this.exitPromise = done;
    return { proc, init, done };
  }

  private record(line: string): void {
    if (this.logFd !== null) { try { writeSync(this.logFd, `${line}\n`); } catch { /* disk full: keep running */ } }
    this.recentLines.push(line);
    if (this.recentLines.length > RECENT_LINES) this.recentLines.shift();
  }

  private turnBegins(): void {
    this.inTurn = true;
    this.turnStart ??= Date.now();
  }

  private onEvent(e: StreamEvent): void {
    switch (e.kind) {
      case 'init':
        this.model = e.model;
        this.o.mcpInit?.record(this.o.projectId, this.o.lane, e);
        break;
      case 'user':
        if (e.isReplay && e.uuid) {
          e.ours = this.o.outbox.onReplay(e.uuid);
          this.log.replayed(e.uuid);
        }
        break;
      case 'assistant': {
        this.turnBegins();
        const t = contextTokens(e);
        if (t !== null) { this.ctxTok = t; this.ctxPct = contextPct(t, this.model ?? this.o.args.model ?? undefined); }
        break;
      }
      case 'control_response': {
        if (e.stillQueued) { this.o.outbox.onStillQueued(e.stillQueued); this.log.unqueued(e.stillQueued); }
        const c = e.requestId === null ? undefined : this.controls.get(e.requestId);
        if (c) {
          this.controls.delete(e.requestId!);
          const res = e.raw.response as Record<string, unknown>;
          c.resolve(e.subtype === 'success'
            ? { ok: true, response: (res.response ?? {}) as Record<string, unknown> }
            : { ok: false, error: e.error ?? '', errorCode: typeof res.error_code === 'string' ? res.error_code : null });
        }
        break;
      }
      case 'result':
        this.inTurn = false;
        this.turnStart = null;
        this.sawResult = true;
        this.lastResult = e;
        for (const u of this.log.result()) this.o.outbox.onRawDone(u);
        for (const w of this.resultWaiters.splice(0)) w(e);
        break;
      // v2.2 §14.4 stream_event: always emitted (block ledger + held text); the engine gates the broadcast
    }
    this.emit('event', e);
  }

  // ---------- stdin ----------

  private write(line: string): boolean {
    if (!this.proc || this.exitedFlag) return false;
    try { void this.proc.stdin.write(line); void this.proc.stdin.flush(); return true; } catch { return false; }
  }

  /** Raw control line (permission answers etc., stream/writer.ts builders). */
  writeLine(line: string): boolean { return this.write(line); }

  /** §7.6 persist first, then write (if the process is up). */
  send(text: string, prefix: string | null, extra?: { uuid?: string; attachments?: readonly SendAttachment[]; echoed?: boolean }): OutboxMsg {
    const m = this.o.outbox.enqueue(this.o.sessionId, text, prefix, extra);
    this.flush();
    return m;
  }

  /** Writes every undelivered message not yet written to this process (e.g. after interrupt's still_queued). */
  flush(): number {
    if (!this.alive || this.holding || this.starting) return 0;
    const gate = this.o.update?.gate;
    if (gate && !gate.writes) { gate.refused(this.o.sessionId); return 0; } // v2.6 §5.4-1 on top of the v2.4 hold (R9)
    const out = this.o.outbox.nextToSend(this.o.sessionId);
    this.writeRows(out);
    if (out.length) this.turnBegins();
    return out.length;
  }

  /** In outbox order: a plain row goes at once unless a row with attachments is still being built before it (§6.4). */
  private writeRows(rows: readonly Outgoing[]): void {
    this.log.wrote(rows, this.inTurn);
    const proc = this.proc;
    for (const m of rows) {
      const line = m.line;
      if (typeof line === 'string' && !this.chain) { this.write(line); continue; }
      const p: Promise<void> = (this.chain ?? Promise.resolve()).then(async () => {
        const r = typeof line === 'string' ? { line, missing: [] } : await line;
        if (this.proc !== proc) return; // that process is gone; the row goes out again to the next one
        if (r.missing.length) this.record(JSON.stringify({ cc_slaves: 'attach_missing', uuid: m.uuid, names: r.missing }));
        this.write(r.line);
      });
      this.chain = p;
      void p.finally(() => { if (this.chain === p) this.chain = null; });
    }
  }

  /** v2.4 §5.3 keep every outbox row off stdin (a model change waits for the turn); `writeLine` still goes through. */
  hold(): void { this.holding = true; }
  /** v2.4 §5.3 end the hold and write what waited; returns how many rows went out. */
  release(): number { this.holding = false; return this.flush(); }
  get held(): boolean { return this.holding; }

  /**
   * v2.4 §10.2 one control request → its `control_response` (matched by request id). Rejects at once when the process
   * is gone or exits before the reply; a timeout is the caller's.
   */
  control(request: ControlRequest): Promise<ControlReply> {
    const id = randomUUID();
    return new Promise<ControlReply>((resolve, reject) => {
      if (!this.alive) return reject(new Error('claude exited'));
      if (this.o.update?.gate.controls === false) return reject(new Error('update_sealed')); // v2.6 §5.4-9
      this.controls.set(id, { resolve, reject });
      if (!this.write(`${JSON.stringify({ type: 'control_request', request_id: id, request })}\n`)) {
        this.controls.delete(id);
        reject(new Error('claude exited'));
      }
    });
  }

  /** §3.3-6 interrupt the turn, wait for its `result` ≤ 10 s. Idle session → nothing to interrupt. */
  async interrupt(): Promise<{ result: ResultEvent | null; timedOut: boolean }> {
    if (!this.alive || !this.inTurn || this.o.update?.gate.controls === false) return { result: null, timedOut: false }; // §5.4-9 sealed
    const got = new Promise<ResultEvent | null>((r) => this.resultWaiters.push(r));
    this.write(interruptLine(randomUUID()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), this.o.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS); });
    const r = await Promise.race([got, t]);
    clearTimeout(timer);
    return r === 'timeout' ? { result: null, timedOut: true } : { result: r, timedOut: false };
  }

  /** §3.3-7 close stdin: an idle session exits 0 without a result line. */
  closeStdin(): void {
    if (!this.proc || this.exitedFlag) return;
    this.requested ??= 'close';
    try { void this.proc.stdin.end(); } catch { /* already closed */ }
  }

  /** §3.3-10 SIGTERM (no orphans); SIGKILL after `graceMs`. Resolves when the process is gone. */
  async terminate(graceMs = 5000, why: Requested = 'terminate'): Promise<void> {
    if (!this.proc || this.exitedFlag) return this.exitPromise;
    this.requested = why;
    const proc = this.proc;
    proc.kill('SIGTERM');
    const timer = setTimeout(() => { if (!this.exitedFlag) proc.kill('SIGKILL'); }, graceMs);
    await this.exitPromise;
    clearTimeout(timer);
  }

  get logOpen(): boolean { return this.logFd !== null; }
}
