// stream-json reader for `claude -p --output-format stream-json` (spec §3.3, §8.4, §12).
// Tolerant by design: never throws, unknown shapes become `unknown` events with the raw object kept.
import type { TokenCounts } from '../../../shared/protocol.ts';
import { usageOf } from './tokens.ts';
import { isObj } from '../../../shared/json.ts';

// ---------- line splitter ----------

/** A line that exceeded the cap; its content was dropped (only the length is kept). */
export class TooLong {
  constructor(readonly length: number) {}
}

export interface SplitterOptions {
  /** Max characters in one line before it is dropped as TooLong. Default 64 Mi chars. */
  maxLineChars?: number;
}

const DEFAULT_MAX_LINE = 64 * 1024 * 1024;

/** Splits a byte/text stream into lines: partial lines across chunks, CRLF, blank lines, split UTF-8. */
export class LineSplitter {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly max: number;
  private parts: string[] = [];
  private len = 0;
  private dropped = 0; // > 0 while discarding an over-long line

  constructor(opts: SplitterOptions = {}) {
    this.max = opts.maxLineChars ?? DEFAULT_MAX_LINE;
  }

  push(chunk: Uint8Array | string): (string | TooLong)[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: (string | TooLong)[] = [];
    let start = 0;
    for (let nl = text.indexOf('\n', start); nl !== -1; nl = text.indexOf('\n', start)) {
      this.append(text.slice(start, nl));
      this.flushLine(out);
      start = nl + 1;
    }
    this.append(text.slice(start));
    return out;
  }

  end(): (string | TooLong)[] {
    const out: (string | TooLong)[] = [];
    this.append(this.decoder.decode());
    this.flushLine(out);
    return out;
  }

  private append(s: string): void {
    if (s.length === 0) return;
    if (this.dropped > 0) { this.dropped += s.length; return; }
    if (this.len + s.length > this.max) {
      this.dropped = this.len + s.length;
      this.parts = [];
      this.len = 0;
      return;
    }
    this.parts.push(s);
    this.len += s.length;
  }

  private flushLine(out: (string | TooLong)[]): void {
    if (this.dropped > 0) {
      out.push(new TooLong(this.dropped));
      this.dropped = 0;
      return;
    }
    let line = this.parts.length === 1 ? this.parts[0]! : this.parts.join('');
    this.parts = [];
    this.len = 0;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim().length > 0) out.push(line);
  }
}

// ---------- typed events ----------

type Obj = Record<string, unknown>;

interface McpServer { name: string; status: string; source: string | null }

/** v2.2 §5.1 the last `system/init` report of one MCP server (entry name) in one project — not per account; `toolNames`
 *  without the `mcp__<server>__` prefix (§5.4b K2 tool list when there is no check). */
export interface McpInitState { projectId: string; name: string; state: string; tools: number; toolNames: string[]; lane: string; at: number }

/**
 * v2.2 §5.1 in-memory map (project, server entry name) → its last init state, tool count, lane and time (epoch ms),
 * fed from every `system/init` of every session. An init that omits a server keeps its record. Not persisted: every
 * spawn re-reports. The engine's own `cc_slaves` is the §7.3 self-check, not recorded.
 */
export class McpInitStore {
  private readonly map = new Map<string, McpInitState>();
  record(projectId: string, lane: string, init: Pick<InitEvent, 'mcpServers' | 'tools'>, at = Date.now()): void {
    for (const s of init.mcpServers) {
      if (!s.name || s.name === 'cc_slaves') continue;
      // Claude Code's tool name: `mcp__<server, non [A-Za-z0-9_-] → _>__<tool>`.
      const prefix = `mcp__${s.name.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
      const toolNames = init.tools.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
      this.map.set(`${projectId}\0${s.name}`, { projectId, name: s.name, state: s.status, tools: toolNames.length, toolNames, lane, at });
    }
  }
  list(): McpInitState[] {
    return [...this.map.values()].sort((a, b) => a.projectId.localeCompare(b.projectId) || a.name.localeCompare(b.name));
  }
}

export interface InitEvent {
  kind: 'init'; sessionId: string | null; model: string | null; claudeCodeVersion: string | null;
  mcpServers: McpServer[]; permissionMode: string | null; tools: string[]; raw: Obj;
}
export interface MessageEvent {
  kind: 'assistant' | 'user'; uuid: string | null; sessionId: string | null; parentToolUseId: string | null;
  isReplay: boolean; message: unknown; raw: Obj;
  /** v2.4 §10.2 set by SessionProcess on a replay before it is emitted: the uuid was one of ours (outbox or transient). */
  ours?: boolean;
}
/** v2.2 §3-15 `apiMessageId` = the API message the block belongs to (stream key, §14.4). */
export interface PartialEvent { kind: 'stream_event'; apiMessageId: string | null; parentToolUseId: string | null; event: unknown; raw: Obj }
export interface ResultEvent {
  kind: 'result'; subtype: string | null; isError: boolean; result: string; sessionId: string | null;
  totalCostUsd: number | null;
  /** Σ model_usage_since_last_result[*].costUSD — this turn's cost (§3.3-19); null when the field is absent. */
  sinceLastCostUsd: number | null;
  resultIndex: number | null; numTurns: number | null; permissionDenials: unknown[]; subagentStats: unknown;
  /** v2.1 §5.3 `result.usage` = the turn's exact token counts; null when absent. */
  usage: TokenCounts | null; raw: Obj;
}
export interface RateWindow { utilization: number; resetsAt: number | null }
export interface RateLimitEvent {
  kind: 'rate_limit_event'; status: string | null; resetsAt: number | null;
  /** utilization 0–1 (§3.3-9) */
  fiveHour: RateWindow | null; sevenDay: RateWindow | null; raw: Obj;
}
export interface CanUseToolEvent {
  kind: 'can_use_tool'; requestId: string; toolName: string; input: Obj; permissionSuggestions: unknown[];
  toolUseId: string | null; description: string | null; raw: Obj;
}
export interface ControlCancelEvent { kind: 'control_cancel_request'; requestId: string; raw: Obj }
interface ControlResponseEvent {
  kind: 'control_response'; requestId: string | null; subtype: string | null;
  /** interrupt's still_queued as uuids; null when the response carries none */
  stillQueued: string[] | null; behavior: string | null; error: string | null; raw: Obj;
}
interface StatusEvent { kind: 'status'; permissionMode: string | null; status: string | null; raw: Obj }
export interface TaskEvent {
  kind: 'task_started' | 'task_progress' | 'task_updated' | 'task_notification';
  taskId: string | null; toolUseId: string | null;
  /** true iff the task carries `subagent_type`; background Bash tasks do not (§3.3-20) */
  isSubagent: boolean; subagentType: string | null; description: string | null; isBackgrounded: boolean;
  ownedBySubagent: string | null; status: string | null; outputFile: string | null; summary: string | null;
  totalTokens: number | null; toolUses: number | null; lastToolName: string | null; raw: Obj;
}
interface UnknownEvent {
  kind: 'unknown'; reason: 'invalid_json' | 'not_object' | 'unrecognized' | 'line_too_long';
  line: string | null; raw: Obj | null;
}

export type StreamEvent =
  | InitEvent | MessageEvent | PartialEvent | ResultEvent | RateLimitEvent | CanUseToolEvent | ControlCancelEvent
  | ControlResponseEvent | StatusEvent | TaskEvent | UnknownEvent;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function rateWindow(v: unknown): RateWindow | null {
  if (!isObj(v)) return null;
  const u = num(v.utilization);
  return u === null ? null : { utilization: u, resetsAt: num(v.resetsAt) };
}

function sumCost(usage: unknown): number | null {
  if (!isObj(usage)) return null;
  let total = 0;
  for (const m of Object.values(usage)) total += num(obj(m).costUSD) ?? 0;
  return total;
}

const unknownOf = (raw: Obj): UnknownEvent => ({ kind: 'unknown', reason: 'unrecognized', line: null, raw });

const TASK_KINDS = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification']);

function classifySystem(o: Obj): StreamEvent {
  const sub = str(o.subtype);
  if (sub === 'init') {
    return {
      kind: 'init', sessionId: str(o.session_id), model: str(o.model), claudeCodeVersion: str(o.claude_code_version),
      permissionMode: str(o.permissionMode),
      tools: arr(o.tools).filter((t): t is string => typeof t === 'string'),
      mcpServers: arr(o.mcp_servers).filter(isObj).map((s) => ({
        name: str(s.name) ?? '', status: str(s.status) ?? 'unknown', source: str(s.source),
      })),
      raw: o,
    };
  }
  if (sub === 'status') return { kind: 'status', permissionMode: str(o.permissionMode), status: str(o.status), raw: o };
  if (sub !== null && TASK_KINDS.has(sub)) {
    const subagentType = str(o.subagent_type);
    return {
      kind: sub as TaskEvent['kind'], taskId: str(o.task_id), toolUseId: str(o.tool_use_id),
      isSubagent: subagentType !== null, subagentType, description: str(o.description),
      isBackgrounded: o.is_backgrounded === true, ownedBySubagent: str(o.owned_by_subagent), status: str(o.status),
      outputFile: str(o.output_file), summary: str(o.summary), totalTokens: num(obj(o.usage).total_tokens),
      toolUses: num(o.tool_uses), lastToolName: str(o.last_tool_name), raw: o,
    };
  }
  return unknownOf(o);
}

/** Classifies one decoded JSON value. Never throws. */
export function classify(o: unknown): StreamEvent {
  if (!isObj(o)) return { kind: 'unknown', reason: 'not_object', line: null, raw: null };
  switch (o.type) {
    case 'system': return classifySystem(o);
    case 'assistant':
    case 'user':
      return {
        kind: o.type, uuid: str(o.uuid), sessionId: str(o.session_id), parentToolUseId: str(o.parent_tool_use_id),
        isReplay: o.isReplay === true, message: o.message, raw: o,
      };
    case 'stream_event':
      return { kind: 'stream_event', apiMessageId: str(o.api_message_id), parentToolUseId: str(o.parent_tool_use_id), event: o.event, raw: o };
    case 'result': {
      const r = o.result;
      return {
        kind: 'result', subtype: str(o.subtype), isError: o.is_error === true,
        result: typeof r === 'string' ? r : r === undefined || r === null ? '' : JSON.stringify(r),
        sessionId: str(o.session_id), totalCostUsd: num(o.total_cost_usd),
        sinceLastCostUsd: sumCost(o.model_usage_since_last_result), resultIndex: num(o.result_index),
        numTurns: num(o.num_turns), permissionDenials: arr(o.permission_denials), subagentStats: o.subagent_stats ?? null,
        usage: usageOf(o.usage), raw: o,
      };
    }
    case 'rate_limit_event': {
      const info = obj(o.rate_limit_info);
      const windows = obj(info.unifiedWindows);
      let fiveHour = rateWindow(windows.five_hour);
      let sevenDay = rateWindow(windows.seven_day);
      // Flat shape: one window named by rateLimitType.
      const flat = rateWindow({ utilization: info.utilization, resetsAt: info.resetsAt });
      if (flat && info.rateLimitType === 'five_hour' && !fiveHour) fiveHour = flat;
      if (flat && typeof info.rateLimitType === 'string' && info.rateLimitType.startsWith('seven_day') && !sevenDay) sevenDay = flat;
      return { kind: 'rate_limit_event', status: str(info.status), resetsAt: num(info.resetsAt), fiveHour, sevenDay, raw: o };
    }
    case 'control_request': {
      const req = obj(o.request);
      const requestId = str(o.request_id);
      if (req.subtype !== 'can_use_tool' || requestId === null) return unknownOf(o);
      return {
        kind: 'can_use_tool', requestId, toolName: str(req.tool_name) ?? '', input: obj(req.input),
        permissionSuggestions: arr(req.permission_suggestions), toolUseId: str(req.tool_use_id),
        description: str(req.description), raw: o,
      };
    }
    case 'control_cancel_request': {
      const requestId = str(o.request_id);
      return requestId === null ? unknownOf(o) : { kind: 'control_cancel_request', requestId, raw: o };
    }
    case 'control_response': {
      const res = obj(o.response);
      const inner = obj(res.response);
      const sq = inner.still_queued;
      return {
        kind: 'control_response', requestId: str(res.request_id), subtype: str(res.subtype),
        stillQueued: Array.isArray(sq)
          ? sq.map((q) => (typeof q === 'string' ? q : str(obj(q).uuid))).filter((q): q is string => q !== null)
          : null,
        behavior: str(inner.behavior), error: str(res.error), raw: o,
      };
    }
    default: return unknownOf(o);
  }
}

/** Parses one stdout line. Never throws. */
export function parseLine(line: string): StreamEvent {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return { kind: 'unknown', reason: 'invalid_json', line, raw: null }; }
  const e = classify(v);
  return e.kind === 'unknown' && e.reason === 'not_object' ? { ...e, line } : e;
}


// ---------- result classification (§3.4, §7.4) — the only match table ----------

const ERROR_PATTERNS = {
  auth: [
    /please run \/login/i, /invalid api key/i, /oauth token (has )?expired/i, /authentication[_ ]error/i,
    /\b401\b/, /not logged in/i, /token (has been )?revoked/i,
  ],
  limit: [
    /usage limit/i, /hit your limit/i, /limit reached/i, /rate[_ ]limit/i, /\b429\b/,
  ],
} as const;

const matches = (r: ResultEvent, pats: readonly RegExp[]) => {
  const text = `${r.subtype ?? ''} ${r.result}`;
  return pats.some((p) => p.test(text));
};

/** Auth wins over limit when both match: a login problem is never fixed by waiting. */
export function isAuthError(r: ResultEvent): boolean {
  return r.isError && matches(r, ERROR_PATTERNS.auth);
}

export function isLimitError(r: ResultEvent): boolean {
  return r.isError && !isAuthError(r) && matches(r, ERROR_PATTERNS.limit);
}

// ---------- cost (§8.6) ----------

/** One turn's cost = Σ model_usage_since_last_result[*].costUSD; null if absent. */
export function turnCost(r: ResultEvent): number | null {
  return r.sinceLastCostUsd;
}

/** Lane cost = largest total_cost_usd seen (it is cumulative per session, across resume). */
export function laneCost(prev: number | null, r: ResultEvent): number | null {
  if (r.totalCostUsd === null) return prev;
  return prev === null ? r.totalCostUsd : Math.max(prev, r.totalCostUsd);
}

// ---------- context fill (UnitPanel / Console "ctx %") ----------

export const CONTEXT_WINDOW = 200_000;
const CONTEXT_WINDOW_1M = 1_000_000;

/** Tokens the model read for a top-level assistant message (input + cache creation + cache read); null when unknown. */
export function contextTokens(e: StreamEvent): number | null {
  if (e.kind !== 'assistant' || e.parentToolUseId !== null) return null; // a sub-agent has its own context
  if (obj(e.message).model === '<synthetic>') return null; // §6.6 a built-in's answer (/context): usage all 0, not a reading
  const u = obj(obj(e.message).usage);
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(num);
  if (parts.every((p) => p === null)) return null;
  return parts.reduce<number>((t, p) => t + (p ?? 0), 0);
}

/** 1M when the model id ends in `[1m]` (claude's long-context alias), else 200k. */
export function contextWindow(model: string | null | undefined): number {
  return model?.endsWith('[1m]') ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW;
}

/** Whole percent of the context window, capped at 100. */
export function contextPct(tokens: number, model: string | null | undefined): number {
  return Math.min(100, Math.round((tokens * 100) / contextWindow(model)));
}
