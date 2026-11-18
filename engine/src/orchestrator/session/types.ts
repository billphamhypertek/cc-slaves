// Orchestrator session types: view, events, deps, DB rows (split from orchestrator/session.ts).
import type { Account } from '../../accounts/registry.ts';
import type { Caps, ModelDefaults } from '../../config.ts';
import type { Db } from '../../db.ts';
import type { ModelCache } from '../../models.ts';
import type { ModelNow } from '../../session/model-control.ts';
import type { QuotaView } from '../../lane/manager.ts';
import type { EchoLine, Outbox } from '../../outbox.ts';
import type { Caffeinate } from '../../session/caffeinate.ts';
import type { Env } from '../../session/env.ts';
import type { SessionSetup, SessionSpawn } from '../../session/files.ts';
import type { SessionOptions } from '../../session/process.ts';
import type { UpdateGate } from '../../update/commit.ts';
import type { KeyedReason, ModelPending, TokenCounts } from '../../../../shared/protocol.ts';
import type { OrchKind } from '../../../../shared/issues.ts';
import type { CanUseToolEvent, ControlCancelEvent, StreamEvent } from '../../stream/parser.ts';

/** `paused` (hotfix 2026-11-16): held, no process, until the project resumes; in memory only (never written). */
export type OrchestratorState = 'starting' | 'running' | 'idle' | 'switching' | 'waiting_quota' | 'stopped' | 'done' | 'paused';

export interface OrchestratorView {
  projectId: string; sessionId: string; state: OrchestratorState; account: string | null; home: string | null;
  deaths: number; lastError: string | null; lastErrorKeyed?: KeyedReason | null; alive: boolean;
  /** Context fill of the session's last assistant message (whole %); null = none yet. */
  contextPct: number | null;
  /** v1.1 §5.2: lane the orchestrator last addressed in this turn (see `talkingToOf`); null between turns. */
  talkingTo: string | null;
  /** v2.1 §5.3 W10 tokens of the current session, incl. the running turn's provisional part. */
  tokens: TokenCounts;
  /** v2.1 §4.14 #n of the current session in its project; its optional short name. */
  seq?: number | null;
  title?: string | null;
  /** v2.1 §4.4 N1-i the model of the current session (its `init`); absent until known. */
  model?: string;
  /** v2.4 §5.5 display name of the model last read from Claude Code, its effort, the PO's picks, a change waiting for the turn. */
  modelName?: string;
  effort?: string | null;
  modelPick?: string | null;
  effortPick?: string | null;
  pending?: ModelPending;
  modelMismatch?: boolean;
}

/** v2.1 §4.14 how a session ended (session.end_reason). */
export type EndReason = 'handoff' | 'ended_by_po' | 'replaced';
/** v2.1 §4.14 boundary line written into a session's own history (start / end). */
export interface Boundary {
  type: 'start' | 'end' | 'resume'; seq: number | null; at: number; account?: string | null; handoff?: string | null; endReason?: EndReason; lanes?: string[];
  /** resume only: parallel, or replacing #replaced. */
  mode?: 'parallel' | 'replace'; replaced?: number | null;
}

export type OrchestratorEvent =
  | { type: 'orchestrator'; orchestrator: OrchestratorView }
  /** F11: g2-t4's CardStore turns this into the red "Điều phối <project> ngừng" card. */
  | { type: 'system_card'; kind: 'orchestrator_down'; projectId: string; sessionId: string; reason: string; reasonKeyed?: KeyedReason }
  /** §3.3-13/14 permission request / cancel from the current process (CardStore makes the F15 card, IMPORTANT-4). */
  | { type: 'control'; projectId: string; sessionId: string; event: CanUseToolEvent | ControlCancelEvent }
  /** A process of this session exited (its pending permission requests are dead). */
  | { type: 'session_exit'; projectId: string; sessionId: string }
  /** §6.16 F16: an auth error on the orchestrator's account. */
  | { type: 'account_logged_out'; projectId: string; account: string }
  /** §6.17 F17 input, as LaneUiEvent `claude_version`. */
  | { type: 'claude_version'; version: string; ok: boolean; message?: string; reason?: KeyedReason }
  /** Chat stream of the current process (assistant / user / partial), for the UI console (§6.3, M16). */
  | { type: 'stream'; projectId: string; sessionId: string; event: StreamEvent }
  /** v2.1 §4.14 a history boundary line for `sessionId` (session started / ended). */
  | { type: 'boundary'; projectId: string; sessionId: string; boundary: Boundary }
  /** v2.4 §10.2 an `echoed` row moved into `sessionId` (F21, "Kết thúc phiên", forwardTo): its `po` line, written there once. */
  | { type: 'po_line'; projectId: string; sessionId: string; line: EchoLine }
  /** v2.1 §4.14 a session ended for good (end / replace): its cards go (asks expire when `expireAsks`). */
  | { type: 'session_ended'; projectId: string; sessionId: string; reason: EndReason; expireAsks: boolean }
  /** v2.4 §4.3 / §5.3 a model / effort change went through (from → to), or a waiting one failed (`error`: toast + engine line). */
  | { type: 'model_change'; projectId: string; sessionId: string; from: ModelNow; to: ModelNow; error?: { code: string; message: string } };

export interface OrchestratorDeps {
  db: Db;
  outbox: Outbox;
  accounts: () => Account[];
  /** §6.16 accounts that cannot be used (no Claude login in the Keychain / an auth error not yet cleared). */
  loggedOut?: () => ReadonlySet<string>;
  quota: QuotaView;
  caps: () => Caps;
  command: string[];
  env: (account: Account) => Env;
  mcpPort: number;
  /** The per-session MCP bearer token + the remote MCP ids its file holds (v2.2 §5.1), so the MCP server / proxy can authenticate it. */
  onMcpToken?: (sessionId: string, spawn: SessionSpawn) => void;
  /** v2.2 §5.1 / §5.5 the project's MCP catalog + lane switches for the session files (engine: catalog + config). */
  sessionSetup?: (projectId: string) => Pick<SessionSetup, 'catalog' | 'off' | 'graph'>;
  /** An orchestrator session ended for good (F21 replaced it): revoke its MCP token (MINOR-3). */
  onSessionEnded?: (sessionId: string) => void;
  newSessionId?: () => string;
  /** Epoch seconds. */
  now?: () => number;
  today?: () => string;
  closeGraceMs?: number;
  /** F21: how long the live session gets to write its handoff. */
  handoffTimeoutMs?: number;
  caffeinate?: Caffeinate;
  /** v2.4 §5.4 the engine's one model cache. */
  modelCache: ModelCache;
  /** v2.4 §5.6 tier 3 "Cài đặt › Model" (config.json `modelDefaults`), read at each spawn. */
  modelDefaults?: () => ModelDefaults;
  /** v2.6 §5.4 the update gate: spawns wait behind it, its processes write through it. */
  gate?: UpdateGate;
  session?: Partial<Pick<SessionOptions, 'initTimeoutMs' | 'interruptTimeoutMs' | 'minVersion' | 'authEmail' | 'beforeSpawn' | 'mcpInit'>>;
}

export interface SessionRow {
  id: string; project_id: string; account: string | null; state: string; account_home?: string | null;
  /** v2.7 R25 (absent on rows read before v23 = general). */
  orch_kind?: OrchKind;
  /** v2.7 R-B13 (a) where it runs when not the project root (null / absent = the root). */
  cwd?: string | null;
}

/** v2.1 §4.14 `Orchestrators.open` input. */
export interface OpenInput { title?: string; first?: string; account?: string; replaceId?: string; model?: string | null; effort?: string | null }
/**
 * v2.7 §5.0 `Orchestrators.openKind` input: Thiết kế (new, or bound to a spec it edits), Build (its spec; fresh, or
 * `--resume` of a session made outside cc-slaves, spawned in that session's cwd — R-B6), Chung (= `open`).
 */
export interface KindInput {
  kind: OrchKind; specId?: number; firstMessage: string; resume?: { sessionId: string; cwd: string };
  /** v2.9 §5.3 a Thiết kế session of this doc step (the next one, opened by Bắt đầu); absent = the spec's step. */
  step?: string;
  /** v2.7.1 §7.4 the ▾ dialog's picks (checked by the caller): an account = the session's home (like `open`); absent = auto. */
  account?: string; model?: string | null; effort?: string | null;
}
/** v2.1 §4.14 `Orchestrators.resume` input. */
export interface ResumeInput { mode: 'parallel' | 'replace'; replaceId?: string; account?: string; model?: string | null; effort?: string | null }

export interface EndedRow { id: string; project_id: string; account: string | null; state: string; seq: number | null;
  title: string | null; ended_at: number | null; end_reason: string | null; handoff_path: string | null; ctx_last: number | null;
  opened_at: number | null; orch_kind: OrchKind; cwd: string | null }
