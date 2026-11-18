// LaneManager deps, views, events, errors and lane-state sets (split from lane/manager.ts).
import type { Key, Params } from '../../../../shared/i18n/index.ts';
import type { KeyedReason, ModelPending, TokenCounts } from '../../../../shared/protocol.ts';
import { KeyedError, type Msg } from '../../errors.ts';
import type { Account } from '../../accounts/registry.ts';
import type { PickReason, PickResult } from '../../accounts/picker.ts';
import type { Caps, Config, ModelDefaults } from '../../config.ts';
import type { Db, LaneState, QuotaRow } from '../../db.ts';
import type { Outbox } from '../../outbox.ts';
import type { Caffeinate } from '../../session/caffeinate.ts';
import type { ModelCache } from '../../models.ts';
import type { ModelControl, ModelNow } from '../../session/model-control.ts';
import type { Env } from '../../session/env.ts';
import type { SessionSetup, SessionSpawn } from '../../session/files.ts';
import type { ExitInfo, SessionOptions, SessionProcess } from '../../session/process.ts';
import type { UpdateGate } from '../../update/commit.ts';
import type {
  CanUseToolEvent, ControlCancelEvent, RateLimitEvent, ResultEvent, StreamEvent, TaskEvent,
} from '../../stream/parser.ts';
import type { TokenMeter } from '../../stream/tokens.ts';
import type { LaneCtx } from '../reducer.ts';
import type { TurnFive } from '../../orchestrator/resume.ts';

/**
 * §7.4 / §12 lane resume message (reference/cc-lanes.mjs RESUME_PROMPT; the outbox adds `[cc-slaves]`). A killed git
 * command can leave a stale `.git/index.lock`; the lane clears it itself.
 */
export const LANE_RESUME_TEXT = 'You were interrupted (account switch or plan limit). Check `git status`, remove a stale ' +
  '.git/index.lock if no git process is running, then continue the task exactly from where you stopped.';

export interface Timers { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
export const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** The slice of QuotaTracker the manager uses (tests may pass a fake). */
export interface QuotaView {
  get(email: string): QuotaRow | null;
  applyRateLimitEvent(email: string, ev: RateLimitEvent): void;
  /** A limit `result`: hold the account as rejected so waiting lanes don't re-pick it (QuotaTracker.markLimited). */
  markLimited?(email: string): void;
}

export interface LaneRef { projectId: string; laneId: number; name: string }
/** v2.7 §5.3: a lane keeps its issue through stopped / broken / waiting_quota / paused; only its end returns it. */
export interface LaneIssueHook {
  /** Called right after the "lane rảnh" notice went out. */
  laneIdle(l: LaneRef): void;
  /** The lane became `done`; `reason` ends the sentence "lane D2 <reason>". */
  laneEnded(l: LaneRef, reason: string): void;
  laneBroken(l: LaneRef): void;
}

export interface LaneManagerDeps {
  db: Db;
  outbox: Outbox;
  accounts: () => Account[];
  /** §6.16 accounts that cannot be used (no Claude login in the Keychain / an auth error not yet cleared). */
  loggedOut?: () => ReadonlySet<string>;
  /** Wire QuotaTracker `onAccountChanged` → `manager.accountChanged` (§3.4 I3). */
  quota: QuotaView;
  caps: () => Caps;
  config: () => Pick<Config, 'maxLanes' | 'maxLanesPerAccount'> & Partial<Pick<Config, 'laneCaps' | 'noNewLanes'>>;
  /** Absolute `claude` (tests: `['bun', fake-claude]`). */
  command: string[];
  /** Child env for a session on `account` (env.ts childEnv over the login env). */
  env: (account: Account) => Env;
  /** Port of the engine's MCP endpoint (files.ts writeSessionFiles). */
  mcpPort: number;
  /** The per-session MCP bearer token + the remote MCP ids its file holds (v2.2 §5.1), so the MCP server / proxy can authenticate it. */
  onMcpToken?: (sessionId: string, spawn: SessionSpawn) => void;
  /** v2.2 §5.1 / §5.5 the project's MCP catalog + lane switches for the session files (engine: catalog + config). */
  sessionSetup?: (projectId: string) => Pick<SessionSetup, 'catalog' | 'off' | 'graph'>;
  /** A lane session ended for good (lane done): revoke its MCP token (MINOR-3; its config file is deleted here). */
  onSessionEnded?: (sessionId: string) => void;
  /** Lane → orchestrator notice; `lane` routes it to the lane's owner session (v2.1 §4.14). */
  notify?: (projectId: string, text: string, lane?: string) => void;
  /** v2.7 §5.3 / R15 the issue a lane holds: follow-up after "rảnh", return on end, "kẹt" when broken (issues/events.ts). */
  issues?: LaneIssueHook;
  appendSystemPrompt?: (lane: { projectId: string; name: string }) => string;
  firstMessage?: (lane: { name: string; briefPath: string | null }) => string;
  newSessionId?: () => string;
  timers?: Timers | undefined;
  /** Epoch seconds. */
  now?: () => number;
  /** Wait this long for a session to exit after stdin is closed, then SIGTERM. */
  closeGraceMs?: number;
  caffeinate?: Caffeinate;
  /** v2.4 §5.4 the engine's one model cache (tests: a private one). */
  modelCache?: ModelCache;
  /** v2.4 §5.6 tier 3 "Cài đặt › Lane" (config.json `modelDefaults`), read at each spawn. */
  modelDefaults?: () => ModelDefaults;
  /** Engine log (an agent definition not found, §5.6). */
  log?: (line: string) => void;
  /** v2.6 §5.4 the update gate: spawns wait behind it, its processes write through it. */
  gate?: UpdateGate;
  session?: Partial<Pick<SessionOptions, 'initTimeoutMs' | 'interruptTimeoutMs' | 'handshakeTimeoutMs' | 'minVersion' | 'authEmail' | 'sleep' | 'ps' | 'kill' | 'beforeSpawn' | 'mcpInit'>>;
}

export type LaneErrorCode =
  | 'no_lane' | 'name_taken' | 'cwd_in_use' | 'bad_account' | 'machine_full' | 'no_account' | 'not_running'
  | 'not_halted' | 'lane_running' | 'lane_waiting_po' | 'incompatible' | 'bad_state';

/** §6A reducer `error` effects the PO sees through a command → catalog key (the text stays the vi fallback). */
export const REDUCER_ERR_KEY: Partial<Record<string, Key>> = { lane_running: 'errors.lane_running', lane_waiting_po: 'errors.lane_waiting_po' };

export class LaneError extends KeyedError {
  declare readonly code: LaneErrorCode;
  constructor(code: LaneErrorCode, m: Msg) { super(code, m); this.name = 'LaneError'; }
}

export interface StartInput {
  projectId: string; name: string; cwd: string; briefPath: string;
  agent?: string; model?: string; effort?: string; account?: string;
  /** v2.1 §4.14 the orchestrator session that opened it (owner). */
  ownerSession?: string;
}

export interface LaneView {
  projectId: string; name: string; laneId: number; sessionId: string; cwd: string; state: LaneState;
  account: string | null; phase: string | null; failCount: number; lastError: string | null; lastErrorKeyed?: KeyedReason | null; openCards: number[];
  switchPending: boolean; sawAssistant: boolean; costUsd: number | null; alive: boolean;
  /** v2.1 §5.3 W10 cumulative tokens since the lane was created, incl. the running turn's provisional part. */
  tokens: TokenCounts;
  /** Epoch seconds the running turn started; null between turns. */
  turnStartedAt: number | null;
  /** Context fill of the last assistant message (whole %), kept across process restarts until the next one reports. */
  contextPct: number | null;
  /** waiting_quota only: why the last pick found no account (§7.1-3 `no_account` = no usable account at all); else null. */
  /** §7.1-3: `no_account` = the registry has no usable account (cutover); the rest are the picker's reasons. */
  waitReason: 'no_account' | Exclude<PickReason, 'no_accounts'> | null;
  /** v2.4 §5.6 the real model / effort (null until read), a change waiting for the turn, MD9. */
  run?: { model: string; modelName?: string; effort: string | null } | null;
  pending?: ModelPending;
  modelMismatch?: boolean;
}

export const waitReasonOf = (r: PickResult): LaneView['waitReason'] => ('account' in r ? null : r.reason === 'no_accounts' ? 'no_account' : r.reason);

export type LaneUiEvent =
  | { type: 'lane'; lane: LaneView }
  | { type: 'notify'; projectId: string; text: string }
  | { type: 'remind'; projectId: string; name: string; text: string; key?: Key; params?: Params; action: { label: string; event: 'lane_resume' } }
  | { type: 'account_logged_out'; projectId: string; name: string; account: string }
  | { type: 'park_unit'; projectId: string; name: string; zone: 'merge' }
  | { type: 'card'; projectId: string; name: string; cardId: number; open: boolean }
  | { type: 'stream'; projectId: string; name: string; event: StreamEvent }
  /** v2.1 W9 subagent source: `system/task_*` and the turn's `result` of the lane's processes. */
  | { type: 'task'; projectId: string; name: string; event: TaskEvent | ResultEvent }
  /** §3.3-13/14 permission request / cancel from the lane's current process (CardStore makes the F15 card). */
  | { type: 'control'; projectId: string; name: string; sessionId: string; event: CanUseToolEvent | ControlCancelEvent }
  /** A session process of this lane exited (its pending permission requests are dead). */
  | { type: 'session_exit'; projectId: string; name: string; sessionId: string }
  /** §6.17 F17 input: the claude version seen at a start (ok = the start passed the self-check; false = too old). */
  | { type: 'claude_version'; version: string; ok: boolean; message?: string; reason?: KeyedReason }
  /** v2.4 §4.3 / §5.6 a lane's model / effort change went through (from → to), or a waiting one failed (`error`). */
  | { type: 'model_change'; projectId: string; name: string; sessionId: string; from: ModelNow; to: ModelNow; error?: { code: string; message: string } };

/** States in which a lane holds a slot (machine max and per-account count, §3.4 / §7.4). */
export const OCCUPY: readonly LaneState[] = ['starting', 'running', 'idle', 'waiting_po', 'switching', 'draining'];
/** States with a session on its account that I3 must re-check. */
export const ON_ACCOUNT: readonly LaneState[] = ['running', 'idle', 'waiting_po', 'draining'];
export const QUIET: readonly LaneState[] = ['idle', 'waiting_po'];

export interface Rt {
  projectId: string;
  laneId: number;
  cwd: string;
  briefPath: string;
  agent?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  ctx: LaneCtx;
  proc: SessionProcess | null;
  procExit: WeakMap<SessionProcess, Promise<ExitInfo>>;
  lastProc: SessionProcess | null;
  runN: number;
  chain: Promise<unknown>;
  retry: unknown;
  cost: number | null;
  /** v2.1 §5.3 W10 */
  tokens: TokenMeter;
  lastResult: string | null;
  userInterrupt: boolean;
  firstText: string;
  /** The last pick's "no account" reason, shown while waiting_quota. */
  waitReason: LaneView['waitReason'];
  /** v2.1 §4.14 five_pct before / after each turn (quota estimate samples). */
  five?: TurnFive;
  /** v2.1 §4.14 "Chạy tiếp lane": the next resume's first line instead of LANE_RESUME_TEXT, once. */
  resumeNote?: string;
  /** hotfix 2026-11-16 a held lane (`paused`): the stored state it goes back to on "Tiếp tục" (the row keeps it). */
  heldFrom?: LaneState;
  /** v2.4 §5.6 model / effort: picks (`model` / `effort` above), last real values, the change waiting for the turn. */
  mc: ModelControl;
  /** v2.4 §5.6 the current process passed its handshake (a change made before is applied inside it). */
  shaken: boolean;
}

export const today = () => new Date().toISOString().slice(0, 10);

export const key = (projectId: string, name: string) => `${projectId}\u0000${name}`;
