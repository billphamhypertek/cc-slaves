// UI ↔ engine WebSocket contract (spec §7.9). One JSON object per WS message.
// engine → UI: `snapshot` once on connect, then `event` diffs; UI → engine: `command` (id) → `ack` | `error`.
// Shared by engine/ (server) and web/ (client). Change it only additively; bump PROTOCOL_VERSION on a breaking change.
// Time unit (§5.3): every timestamp here (`*At`, `at`, `ts`, `deadline`) is epoch MILLISECONDS; the engine converts its seconds at the view edge.
import type { IssueCommand, IssueEngineEvent, OrchKind, ProjectIssues } from './issues.ts';
import type { DraftView, WfRef, WorkflowCommand, WorkflowEngineEvent, WorkflowRow } from './workflows.ts';
import type { GraphCommand, GraphEngineEvent, GraphView } from './graph.ts'; import type { ToolkitCommand, ToolkitEngineEvent, ToolkitView } from './toolkit.ts';
import type { AccountLoginView, AccountQuotaFields, QuotaState } from './accounts.ts'; import type { UpdateCommand, UpdateEngineEvent, UpdateInfo } from './update.ts';
export type { AccountLoginView, QuotaState } from './accounts.ts';

/** 2 = v2 accounts; 3 = v2 G5 i18n (§6A keys); 4 = v2 D18/D24 dropped the per-project mode, the app key and the signed-bypass
 *  commands; 5 = v2.2 §14.4 `partial.text` → `delta` / `full` + `key`; 6 = v2.7 issues / specs (`shared/issues.ts`);
 *  7 = v2.7.1 §7.2 `quota_refresh` ack = `QuotaRefreshAck` (`shared/accounts.ts`). */
export const PROTOCOL_VERSION = 7;

export type Channel = 'mac' | 'remote';

/** §6A an engine-composed text as a catalog key (additive, protocol 4): `inner` fills the outer `{detail}`. Claude's own
 *  text never gets one. The web renders it in `ui.lang` when every key is known, else the stored vi text. */
/** §6A the card `source` of the orchestrator (ask / permission); rows before G5-fix stored the vi word "Điều phối". */
export const ORCH_SOURCE = 'orchestrator';
export const isOrchSource = (s: string | null | undefined): boolean => s === ORCH_SOURCE || s === 'Điều phối';

export interface KeyedReason { key: string; params?: Record<string, string | number>; inner?: KeyedReason }

/** v2.1 §5.3 token counts (Claude `usage`: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens). */
export interface TokenCounts { input: number; output: number; cacheWrite: number; cacheRead: number }
export const ZERO_TOKENS: Readonly<TokenCounts> = Object.freeze({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
export const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts =>
  ({ input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead });
/** v2.1 §5.3 / W4 the one "tok" number shown = input + output + cacheWrite (cacheRead dwarfs it; the tooltip shows all four). */
export const displayTokens = (t: TokenCounts): number => t.input + t.output + t.cacheWrite;

// ---------- state (what the UI renders) ----------
export type LaneState =
  | 'starting' | 'running' | 'idle' | 'waiting_po' | 'switching' | 'waiting_quota'
  | 'draining' | 'stopped' | 'broken' | 'done'
  /** hotfix 2026-11-16: held after an app restart (project not resumed yet); no process, no token spent. In memory only:
   *  state.db keeps the lane's real state, which comes back on "Tiếp tục". */
  | 'paused';
/** v2.9 §5.5 a lane phase: one of the `phases` of the lane step of its workflow rev (Quy trình PO: queue … done). */
export type Phase = string;
export type Role = 'primary' | 'backup' | 'orchestrator';

export interface ProjectView {
  id: string; name: string; path: string; orchestratorAccount: string | null;
  gchatWebhookSet: boolean; gchatSendCommandText: boolean;
  /** v2.1 §4.15 / §4.8 "n chưa merge": lanes in done whose branch measured `unmerged` (reported-done lanes never count). */
  unmerged?: number;
  /** hotfix 2026-11-16: the project is held (nothing of it runs) until `project_resume` or a PO message. `start` = never
   *  ran (just added), `resume` = held after an app restart; `sessions` / `lanes` = how many wait. null = not held. */
  held?: { kind: 'start' | 'resume'; sessions: number; lanes: number } | null;
  /** v2.7 §4.9 IS16 "Đã nhập n spec có sẵn từ docs/specs · Ẩn" (first import only); null / absent = hidden or never. */
  specsImported?: number | null;
  workflow?: string; workflowFallback?: string | null; // v2.9 §4.1 the Tasks chip · hf-sp the plugin whose absence gave Giao thẳng at add
}

/** v2.1 §4.15 N6-e ack of `done_lanes_list`: one page, newest first; counts cover every done lane of the project. */
export interface DoneLanesPage {
  lanes: LaneView[]; total: number; unmerged: number; unknown: number;
  /** Pass as `before` for the next (older) page; null = last page. */
  next: string | null;
}

/** v2.1 §4.15 Engine: a lane's own branch vs the project base (`origin/HEAD`, else `main`), measured in the project repo.
 *  `none` = no own branch (never counted); `unknown` = git failed / timed out (`reason`, never counted). Additive. */
type BranchState = 'unmerged' | 'merged' | 'gone' | 'none' | 'unknown';
export interface LaneBranch {
  name: string | null; base: string | null; state: BranchState;
  /** commits on the branch not on base · files / added / deleted lines of `git diff --shortstat <base>...<branch>` (0 unless unmerged). */
  ahead: number; files: number; add: number; del: number;
  /** PR of the branch when `gh` is available; a merged PR counts as merged (known squash limit). */
  pr?: { number: number; state: 'open' | 'merged' | 'closed' };
  /** epoch ms of the measurement these numbers come from. */
  measuredAt: number;
  /** `unknown` only: why ("timeout", git's stderr line…). */
  reason?: string | null;
  /** §4.15 Trạng thái "đang đo…": a new measurement runs; the numbers above are the old ones. */
  measuring?: boolean;
  /** v2.3 §10.2 (V15) unmerged only: commits on base not on the branch. Additive. */
  behind?: number;
  /** v2.3 §10.2 unmerged only: files a merge into base would conflict on ([] = clean). Absent = not measured; `unknown` never has it. */
  conflicts?: string[];
  /** v2.3 §10.2 `git_branches` only: uncommitted entries of the lane worktree (`status --porcelain`); absent = cannot tell. */
  dirty?: number;
}

export interface LaneView {
  projectId: string; name: string; state: LaneState; phase: Phase | null; task: string | null; note: string | null;
  account: string | null; cwd: string; worktreeExists: boolean; agent: string | null; model: string | null;
  effort: string | null; failCount: number; lastError: string | null; lastErrorKeyed?: KeyedReason | null; costUsd: number; openCards: number[];
  turnStartedAt: number | null; contextPct: number | null; switches: number; updatedAt: number;
  /** v2.1 §5.3 W10 cumulative since the lane was created (every session and account switch, like `costUsd`); moves within a turn.
   *  Optional only so pre-v2.1 fixtures still type-check; the engine always sends it. */
  tokens?: TokenCounts;
  /** v2.1 §4.15 last branch measurement (null = never measured). Optional only so pre-v2.1 fixtures type-check. */
  branch?: LaneBranch | null;
  /** v2.1 §4.14 the running orchestrator session that owns the lane, and its #n (null = none). Additive. */
  ownerSession?: string | null;
  ownerSeq?: number | null;
  wf?: WfRef; // v2.9 §4.7 the lane's effective config (Inspector head)
  /** v2.4 §5.6 D55 (`model` / `effort` above = tier 1, null = "Theo mặc định"): what the lane's process runs (read from
   *  Claude Code; absent until known), a change waiting for the turn (§5.3), MD9 (tier 1, 2 or 3 not applied). Additive. */
  run?: { model: string; modelName?: string; effort: string | null };
  pending?: ModelPending; modelMismatch?: boolean;
}

/** v2.4 §5.5 / §5.6 a model / effort change waiting for the turn to end (orchestrator and lane). */
export interface ModelPending { model?: string | null; modelName?: string; effort?: string }

/** `paused` (hotfix 2026-11-16): held — restored after an app restart, or a project just added — until the PO presses
 *  "Tiếp tục" / "Bắt đầu" or sends a message; no process, no token spent. */
export type OrchestratorState = 'starting' | 'running' | 'idle' | 'switching' | 'waiting_quota' | 'stopped' | 'paused';
export interface OrchestratorView {
  projectId: string; state: OrchestratorState; account: string | null; homeAccount: string | null;
  lastError: string | null; lastErrorKeyed?: KeyedReason | null; costUsd: number; contextPct: number | null;
  /** v1.1 §5.2: lane `name` of the orchestrator's latest cc-slaves MCP call that carries one; null after its turn's
   *  `result`, when its session exits, and after an engine restart. Additive (no PROTOCOL_VERSION bump). */
  talkingTo: string | null;
  /** v2.1 §5.3 W10 cumulative over the current session (same scope as `costUsd`); moves within a turn.
   *  Optional only so pre-v2.1 fixtures still type-check; the engine always sends it. */
  tokens?: TokenCounts;
  /** v2.1 §4.14 the session this view is (one per running session), its #n and optional short name. Additive. */
  sessionId?: string; seq?: number | null; title?: string | null;
  /** v2.1 §4.4 N1-i the session's model (from its `init`); absent until known. Additive. */
  model?: string;
  /** v2.4 §5.5 display name of the running model, its effort, the PO's picks (null = "Theo mặc định"), a change waiting
   *  for the turn to end (§5.3) and "model khác lựa chọn" (§5.2, MD9). Additive. */
  modelName?: string; effort?: string | null; modelPick?: string | null; effortPick?: string | null;
  pending?: ModelPending; modelMismatch?: boolean;
  /** v2.7 §5.0 the session's kind (R-B13 e: the web applies `capReached` from `shared/issues.ts` to these). */
  orchKind?: OrchKind;
  wf?: WfRef; // v2.9 §4.7 the session's effective config (step name on the Deck, "Quy trình PO · Build · bản a1b2c3")
}

/** v2.4 §5.5 one `list_models` row (NC §8-1); `effortLevels` = `supportedEffortLevels` (empty: no effort). */
export interface ModelInfo { value: string; resolvedModel: string; displayName: string; effortLevels: string[] }
/** v2.4 §5.4 / §5.5 `session_models` ack: the account's models and the (account, project) default; `unavailable` = no list. */
export interface SessionModels {
  models: ModelInfo[]; defaultModel: string | null; defaultModelName: string | null; unavailable?: boolean;
  /** v2.4 §5.6 where the default **model** comes from (tier 2 agent · 3 Settings · 4 settings.json / plan), the agent's
   *  name, and the default effort (tiers 2–3; null = Claude Code decides). Additive. */
  defaultSource?: 'agent' | 'settings' | 'claude' | 'plan'; defaultAgent?: string; defaultEffort?: string | null;
  /** v2.4 §5.6 tier 4 alone, what Claude Code would use (Cài đặt › Model "Theo Claude Code"): settings.json's model, else
   *  the plan's; its `effortLevel` (null = not set); where the model comes from. Additive. */
  claudeModel?: string | null; claudeEffort?: string | null; claudeSource?: 'claude' | 'plan';
}
/** v2.4 §5.3 / §5.5 `session_set_model` ack. */
export interface SetModelResult { applied: 'now' | 'pending' | 'saved' | 'unsupported' }

/** v2.4 §5.5 the last model / effort a session ran with and the PO's picks (`SessionRowView`, `ResumePreview`). Additive. */
interface ModelFields { model?: string; modelName?: string; effort?: string | null; modelPick?: string | null; effortPick?: string | null }

/** v2.1 §4.14 one row of `sessions_list` ("Lịch sử phiên"): running first (open order), then ended (newest first). */
export interface SessionRowView extends ModelFields {
  sessionId: string; projectId: string; seq: number | null; title: string | null;
  /** live state for a running session; 'ended' once it is over. */
  state: OrchestratorState | 'ended';
  startedAt: number; endedAt: number | null;
  /** account it started on → account it is (or was last) on. */
  accountFirst: string | null; accountLast: string | null;
  /** lanes it owns now (running) / owned when it ended (ended: lanes it handed over). */
  lanes: number;
  /** that orchestrator's own turns only (lanes not added). */
  tokens: TokenCounts; costUsd: number;
  endReason: 'handoff' | 'ended_by_po' | 'replaced' | null; handoffPath: string | null;
  /** context tokens of its last assistant message. */
  ctxLast: number | null;
  /** v2.1 §4.14 ended rows: can it be resumed ("chạy tiếp được" / "chỉ xem · hết hạn"); null for running rows. */
  resumable: boolean | null;
  /** v2.1 §4.14 why not (catalog key), e.g. `errors.noTranscript`; null when resumable. Additive. */
  reason?: KeyedReason | null;
  /** v2.1 §4.14 "hết hạn sau n ngày": days left before Claude Code deletes the transcript, only when ≤ 5. Additive. */
  expiresInDays?: number | null;
  wf?: WfRef; // v2.9 §4.7 effective config
}
export interface SessionsList {
  running: SessionRowView[]; ended: SessionRowView[]; max: number;
  /** v2.1 §4.14 `cleanupPeriodDays` of the shared ~/.claude/settings.json (default 30; Settings › Engine). Additive. */
  cleanupPeriodDays?: number;
}

/** v2.1 §4.14 "Từ lúc dừng": a lane the session handed over, now done or with another owner. */
export interface SinceStopLane { name: string; kind: 'done' | 'moved'; seq: number | null; at: number | null }
/** v2.1 §4.14 `session_resume_preview` (N5-f/g/h): the impact before resuming. */
export interface ResumePreview extends ModelFields {
  sessionId: string; projectId: string; seq: number | null; title: string | null;
  resumable: boolean; reason: KeyedReason | null;
  ctxLast: number | null; ctxWindow: number; ctxPct: number | null;
  /** ≥ 80 %: "sẽ tự nén ngay sau lượt đầu"; the main button becomes "Phiên mới từ handoff #n". */
  ctxHigh: boolean;
  /** first turn re-reads ctxLast tokens; `pct` null = fewer than 5 usable turns ("chưa đủ số liệu"). */
  estimate: { tokens: number; pct: number | null; samples: number } | null;
  /** account it would run on; its last account; why not the last one (`console.resumeLastLow`). */
  account: string | null; accountLast: string | null; accountReason: KeyedReason | null;
  sinceStop: SinceStopLane[];
  /** false at 3 running sessions → only "Thay phiên". */
  parallelAllowed: boolean; running: number; max: number;
  handoffPath: string | null; expiresInDays: number | null; cleanupPeriodDays: number;
}
/** v2.1 §4.14 / §4.15 `lane_continue_preview` (N5-o). */
export interface LaneContinuePreview {
  projectId: string; name: string; resumable: boolean; reason: KeyedReason | null;
  ctxLast: number | null; estimate: { tokens: number; pct: number | null; samples: number } | null;
  account: string | null; accountLast: string | null;
  /** worktree still there, or rebuilt from the lane branch before the first message. */
  worktreeExists: boolean; branch: string | null; ahead: number;
}

/** v2.1 §5.3 token stats (§4.7 "5 giờ N tok", §4.8 "hôm nay N tok · ≈ $N"): `snapshot.stats` + `stats` event. Additive. */
export interface TokenStats {
  /** Epoch ms the numbers were computed (today = local midnight of this instant). */
  at: number;
  /** Every lane + orchestrator of every project, last 5 hours. */
  tokens5h: TokenCounts;
  /** Per project id, since local midnight. A project with no turn today is present with zeros. */
  projects: Record<string, { tokensToday: TokenCounts; costTodayUsd: number }>;
}

/** v2 §6 A2 login chip: ✓ ok · ⚠ expiring · ✗ out (signed out here, auth error, or no Keychain item — F16) · ? unknown. */
type AccountLogin = 'ok' | 'expiring' | 'out' | 'unknown';

/** v2.7.1 §7.3 + `AccountQuotaFields` (refresh, nextCheckAt, quotaError, fullWhy, admitBlock, pastReset, fiveWindow). */
export interface AccountView extends AccountQuotaFields {
  /** v2 §5.1 12-hex account id (null only for a row written before ids existed). */
  id: string | null; login: AccountLogin;
  email: string; plan: string | null; role: Role; week: number; five: number | null; hard: boolean;
  /** hf1116: the terminal's own login (`~/.claude`, shared with the terminal / VS Code); cc-slaves never signs it out. */
  terminal: boolean; loggedOut: boolean; lanes: number;
  weekPct: number | null; fivePct: number | null; weekResetsAt: number | null; fiveResetsAt: number | null;
  fetchedAt: number | null; fresh: boolean; status: 'ok' | 'allowed_warning' | 'rejected' | 'needs_probe' | 'unknown';
  /** U4: D21 "còn N %" — null when unknown */
  headroomPct: number | null; full: boolean;
  /** v2 §5.5 / A9 last shared-config check: ok=false → "cấu hình chung lỗi", the account gets no new lane. */
  sharedCfg: { ok: boolean; issues: SharedCfgIssue[] };
}

/** v2 §5.5 one problem left after self-heal (`real-entry` = Claude Code made a real dir where the link belongs). */
interface SharedCfgIssue {
  kind: 'missing-target' | 'target-not-dir' | 'missing-link' | 'wrong-target' | 'real-entry';
  name: string; path: string;
}

/**
 * `shared_cfg` = v2 A9 (key `<email>/<name>`), `shared_cfg_new` = §5.2 new unknown entry in ~/.claude (key = name),
 * `account_orphan` = §6 boot: a logged-in account dir with no row (key = the dir; "Thêm lại" / "Xoá").
 */
type CardKind = 'ask' | 'permission' | 'broken' | 'orchestrator_down' | 'logged_out' | 'cc_updated' | 'shared_cfg' | 'shared_cfg_new' | 'account_orphan' | 'cutover' | 'mcp_login' | 'issues_new' | 'superpowers_off' | 'revert_conflict';
type CardStatus = 'open' | 'answered' | 'cancelled' | 'expired';
export interface CardView {
  id: number; kind: CardKind; projectId: string | null; source: string | null; // lane name | 'orchestrator' | null
  status: CardStatus; createdAt: number; resolvedAt: number | null;
  title: string;            // e.g. "D2 xin chạy: Bash `rm -rf build/`" — §6A Vietnamese fallback (old `card_v2` rows)
  /** §6A catalog key of the title (+ its `{params}`); the UI renders it in `ui.lang` when present, else `title`. */
  titleKey?: string; params?: Record<string, string | number>;
  question?: string; options?: { label: string; description?: string }[]; recommended?: string | null;
  context?: string | null;  // "Xem thêm"
  canAllowAlways?: boolean; // permission: Claude Code sent permission_suggestions
  /** §6A (T9c) catalog key of the system-card body (`context`); absent = engine / Claude text, shown as sent. */
  bodyKey?: string; bodyParams?: Record<string, string | number>; bodyInner?: KeyedReason;
  /** system cards: lane_resume, account_relogin, restart_orchestrator, … — `labelKey` (§6A T9c) renders in `ui.lang`, `label` = vi fallback */
  actions?: { id: string; label: string; labelKey?: string; labelParams?: Record<string, string | number> }[];
  answer?: unknown;
  /** v2 system cards: the card key (A9 `<email>/<name>`, orphan dir, new entry name). Additive. */
  key?: string | null;
  /** v2.1 §4.14 source session (lane or orchestrator) and the #n of its orchestrator session (the lane's owner for a
   *  lane source); the web shows "#n" from this, never infers it. Additive. */
  sessionId?: string | null; seq?: number | null;
  /** v2.2 C26 K13 (`projectId` null): the projects with a lane missing the server; a tab's badge counts the card only
   *  there (absent = every tab, the other system cards). Additive. */
  projectIds?: string[];
}

/** v2 §5.2 one `~/.claude` entry as Account › "Cấu hình chung" lists it (`shared` = linked into every account). */
interface SharedEntryView { name: string; cls: 'shared' | 'never' | 'private' | 'unknown'; shared: boolean }
/** Ack of `accounts_info`: the Account tab's engine-side facts. */
export interface AccountsInfo {
  entries: SharedEntryView[];
  /** §3.2 SA6: the default browser can open a private window (A4 primary button). */
  privateWindow: boolean;
}

/** One line of a session's chat/console stream (U3). Tool blocks fold to one line in the UI. */
export interface StreamLine {
  seq: number; ts: number; kind: 'po' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'engine' | 'subagent';
  text: string; tool?: string; parentToolUseId?: string | null; inTurn?: boolean; // "đã gửi vào lượt đang chạy"
  /** v2.2 §14.4 `<api_message_id>:<index>` of the block this line came from (= its `partial` key); none when unknown. */
  key?: string;
  /** v2.2 §14.4 tool_use / tool_result: the tool call id. */
  toolUseId?: string;
  /** v2.2 §14.4 tool_use: the input, string values cut, JSON ≤ 2 KB. */
  input?: string;
  /** v2.2 §14.4 Edit / Write / MultiEdit: lines added / removed, from the input. */
  diff?: { add: number; del: number };
  /** v2.2 §14.4 tool_result: the result text with its newlines, ≤ 8 KB (`text` stays the one-line summary). */
  result?: string;
  isError?: boolean;
  /** v2.2 §14.4 `result` was cut at 8 KB; `totalLines` = the line count of the whole result. */
  truncated?: true; totalLines?: number;
  /** v2.2 §14.5 S5 tool_result: the exit code of a failed Bash call (Claude Code's "Exit code k" first line, cut from `result`). Additive. */
  exitCode?: number;
  /** v2.1 §4.14 a session boundary line (kind 'engine'; `text` = vi fallback, catalog `console.boundary*`). Additive. */
  boundary?: { type: 'start' | 'end' | 'resume'; seq: number | null; at: number; account?: string | null; handoff?: string | null; endReason?: string;
    /** v2.1 §4.14 resume line: "song song" or "thay #m". Additive. */
    mode?: 'parallel' | 'replace'; replaced?: number | null };
  /** v2.4 §5.3 a PO message sent while a model change waits: it reaches Claude Code after the change. Additive. */
  afterModelChange?: true;
  /** v2.4 §10.2 the message's attachments as labels (never bytes); `copy` = the engine sent a copy. Additive. */
  att?: { kind: 'image' | 'file'; name: string; copy?: boolean }[];
  held?: true; // v2.6 §4.8 / §10.3 a PO message received during the update hold, not written yet; `po_written` clears it
}
/** v2.1 §4.14 an orchestrator target may name its session; none = the project's first running session. */
export type Target = { kind: 'orchestrator'; projectId: string; sessionId?: string } | { kind: 'lane'; projectId: string; name: string };

export interface SubagentView {
  taskId: string; toolUseId: string; description: string; subagentType: string; background: boolean;
  status: 'running' | 'completed' | 'failed'; totalTokens: number | null; toolUses: number | null; lastTool: string | null;
  /** v2.1 §4.11b epoch ms the engine saw it start (Inspector duration). Additive. */
  startedAt?: number;
  /** v2.1 §5.3 / §4.5 epoch ms the subagent left `running` (the web's 60 s rule); null while running. */
  endedAt?: number | null;
}

export interface EngineInfo {
  version: string; protocol: number; claudePath: string | null; claudeVersion: string | null;
  shellEnvOk: boolean; startedAt: number; costTodayUsd: number; remote: { enabled: boolean; hostname: string | null };
  setupNeeded: boolean; // F1
  ccUpdated: string | null; // F17 pending check
  update?: UpdateInfo; // v2.6 §5.4-4 the update hold, every channel (§8 UP9); additive, the engine always sends it
}

export interface SetupStatus { // F1
  claude: { found: boolean; path: string | null; version: string | null; ok: boolean };
  accounts: { email: string; loggedIn: boolean }[]; // v2 §7: no ccSwitch / inCcSwitch
  poEmail: string | null; done: boolean;
  /** hotfix 2026-11-16 (b) Git in onboarding: every item optional, never part of `done`. */
  git: GitSetup;
}

/** hotfix 2026-11-16 (b): `git --version` in the login env (`missing` = no developer tools, `license` = Xcode's license not
 *  accepted), the global commit identity, and the gh user from the offline `gh config get -h github.com user` (`missing` = no
 *  `gh` on the login PATH). */
export interface GitSetup {
  state: 'ok' | 'missing' | 'license' | 'error';
  version: string | null;
  /** `error`: git's last output line. */
  detail: string | null;
  identity: { name: string | null; email: string | null };
  gh: 'missing' | 'logged_out' | 'ok';
  ghUser: string | null;
  /** The running `gh auth login --web` (null = none): the one-time code + the device page, or why it failed. */
  ghLogin: GhLoginView | null;
}
export interface GhLoginView { state: 'starting' | 'waiting' | 'failed'; code: string | null; url: string | null; detail: string | null }

// ---------- v2.2 Skills & MCP (§5.4, §5.5, §6; Mac channel only: entries can hold secrets, D32 remote = view-less) ----------
/** §6 K1 row state: the latest of the last lane `system/init` and the last §5.4b check; the proxy's needs-login mark. */
export type McpStatus = 'connected' | 'needs_login' | 'needs_relogin' | 'error' | 'unchecked';

export interface McpRowView {
  /** §5.1 scoped id (`user:<n>`, `local:<p>:<n>`, `project:<p>:<n>`, `plugin:<key>:<s>`); K1-local rows: `local:~<path>:<n>`. */
  id: string;
  /** The name in Claude Code (`plugin_<p>_<s>` for plugins, §3-3). */
  name: string;
  source: 'user' | 'local' | 'project' | 'plugin';
  kind: 'stdio' | 'http' | 'sse' | 'ws';
  projectId: string | null;
  plugin: string | null;
  /** The source entry as read (env / header values included: the web masks them, K2). */
  config: Record<string, unknown>;
  forLanes: boolean;
  /** K7 a `.mcp.json` entry neither enabled nor left off yet. */
  pending: boolean;
  /** K1-local: a local entry of a path that is no added project root (`path` = that path); never in a lane. */
  unused: { path: string } | null;
  /** Only user entries are written by the app (§5.4); the rest: "Mở file nguồn". */
  editable: boolean;
  status: McpStatus;
  tools: number | null;
  /** C20 `${CLAUDE_PLUGIN_*}` the catalog cannot expand; §5.3 `bad_name` an id with CR / LF / NUL (`name` = the entry name, escaped). */
  error: { code: 'plugin_var' | 'bad_name'; name: string } | null;
  /** K2 "D2 lúc 13:05: đã kết nối, 18 công cụ": the latest `system/init` record of this server; `toolNames` (no
   *  `mcp__<server>__` prefix) feed the K2 tool list when there is no check (§5.4b). */
  lastInit: { projectId: string; lane: string; state: string; tools: number; toolNames: string[]; at: number } | null;
  /** §5.4b C22 "Kiểm tra" shown (false: K7 unapproved, K1-local stdio, ws / headersHelper, C20 error). */
  canCheck: boolean;
  /** §5.4b a check of this server is running or queued. */
  checking: boolean;
  /** §5.4b the last check (K2 tool names). */
  probe: McpProbeView | null;
  /** §5.2 K2 "Xem log": the proxy's last lines of this server, oldest first (≤ 50; never a body or auth header). */
  log: McpLogLineView[];
  /** §5.3 the engine's OAuth state of a remote server (absent: stdio / ws, never proxied, or `noLogin`). */
  oauth?: McpOAuthView;
  /** K1-src / K3e plugin rows: the file declaring the server (`.mcp.json` / `plugin.json`), for "Mở file nguồn". */
  sourceFile?: string;
  /** §6 C25 the `cc_slaves` row (id `cc_slaves`): cc-slaves' own server, always on for lanes, no switch / menu / config. */
  builtin?: true;
  /** §6 K4 "Đăng nhập: Không" (config `mcp.noLogin`): cc-slaves never logs in; a 401 is an error. */
  noLogin?: true;
}

/** §5.3 / K3e named login errors. */
export type McpLoginError = 'no_metadata' | 'no_s256' | 'client_registration' | 'denied' | 'issuer_mismatch' | 'timeout' | 'network';
/** K3e detail lines (never a token / secret / URL query): the issuers compared, or where the network failed and how. */
export type McpLoginDetail = { kind: 'issuer'; expected: string; received: string | null } | { kind: 'network'; host: string; text: string };
/** §5.3 / K3 / K13 login state of one server (epoch ms). Never a token. */
export interface McpOAuthView {
  loggedIn: boolean;
  expiresAt: number | null;
  /** Last successful refresh. */
  refreshedAt: number | null;
  /** K13: why a (new) login is needed; `scope` = the missing scope of a 403 insufficient_scope (step-up). */
  needsLogin: { reason: 'no_token' | 'invalid_grant' | 'insufficient_scope'; scope: string | null } | null;
  /** §5.3 yellow "Không lưu được đăng nhập vào Keychain — mất khi engine khởi động lại" + "Thử lưu lại". */
  keychainFailed: boolean;
  /** K3 a login in progress: finding the AS, then waiting for the browser until `until` (`url` = "Sao chép link"). */
  login: { phase: 'discovering' | 'waiting'; url: string | null; until: number | null } | null;
  /** K3e the last login's error (cleared by the next login). */
  error: McpLoginError | null;
  /** K3e-iss / K3e-net the detail of `error` when the engine has one. */
  errorDetail?: McpLoginDetail;
}

/** §5.4b / §5.2 why a check or a proxied request failed: `code` + its catalog key (`skillsMcp.mcpErr.*`, `{detail}`). */
/** `key` = the cause line, `fix` = what to do about it (K2-err), both in the lazy `skillsMcp` namespace. */
export interface McpErrorView { code: string; key: string; fix: string; detail: string | null }
export interface McpProbeView { state: 'connected' | 'needs_login' | 'error'; tools: string[]; error: McpErrorView | null; at: number }
export interface McpLogLineView { at: number; method: string; path: string; status: number; ms: number; error: McpErrorView | null }

export interface SkillRowView {
  /** `user:<name>` / `project:<projectId>:<name>` (the `skills.offForLanes` id) / `plugin:<key>:<name>`. */
  id: string;
  scope: 'user' | 'project' | 'plugin';
  owner: string | null; dir: string; path: string; name: string; description: string;
  /** A project skill hidden by the user skill of the same name. */
  shadowed: boolean;
  /** "link → ~/.agents/skills/…"; null = a real folder. */
  link: string | null;
  forLanes: boolean;
}
/** §5.5 / K11 one issue (C23 `acked` = "Đã biết", by fingerprint). */
export interface SkillIssueView {
  id: string;
  code: 'brokenLink' | 'appLink' | 'missingSkillMd' | 'nameMismatch' | 'badChars' | 'duplicate' | 'nestedSkillsDir';
  level: 'error' | 'warn' | 'info';
  ackable: boolean; acked: boolean;
  path: string; dir: string | null; project: string | null; app?: string;
}
export interface PluginRowView { key: string; skills: number; servers: number; forLanes: boolean }
export interface IssueCount { red: number; yellow: number }
/** §6 C25 the one issue table: K0 = total, tab badges = mcp / skills / shared; v2.5 §5.3 `graph` (module in `error`). */
export interface SkillsMcpCounts { mcp: IssueCount; skills: IssueCount; shared: IssueCount; graph?: IssueCount; total: IssueCount }
export interface SkillsMcpView {
  mcp: { rows: McpRowView[]; servers: number; forLanes: number; tools: number };
  skills: { rows: SkillRowView[]; issues: SkillIssueView[]; plugins: PluginRowView[]; descTokens: number };
  counts: SkillsMcpCounts;
  /** K14: `ok` false → the band with `line`; `rev` changes on every source change (K4 / K5 "vừa đổi" band); `path` = the
   *  file the engine reads (K14 / K2 "Mở file"). */
  claudeJson: { ok: boolean; line: number | null; rev: string; path: string };
  /** §5.4b `claude` missing → add / edit / remove locked, reason + `install`. */
  claude: { found: boolean; install: string };
  /** §5.4 restores that failed: band "Server `<name>` đang không có…" + "Chép JSON cũ" (`command`, `json`). */
  lost: { name: string; json: string; command: string }[];
}

/** §5.5 K9 the checks of one skill folder before it is added as `~/.claude/skills/<dir>` (nothing written). */
export interface SkillDirCheck {
  /** The entry it would get in `~/.claude/skills` (a picked folder: its skill name; a git candidate: its folder). */
  dir: string;
  /** Frontmatter `name` (the folder name when missing). */
  name: string;
  description: string;
  skillMd: boolean;
  /** `name` has a char outside `[a-z0-9-_]`. */
  badChars: boolean;
  /** `~/.claude/skills/<dir>` already exists: its link target (null: a real folder); `same` = it is this very folder. */
  exists: { link: string | null; same: boolean } | null;
}

/** K9 "Git": the clone the engine keeps until `skill_git_add` / `skill_git_cancel` / the next fetch. */
export interface SkillGitFetch { cloneId: string; candidates: { name: string; check: SkillDirCheck }[] }

export interface Snapshot {
  engine: EngineInfo; channel: Channel; projects: ProjectView[]; orchestrators: OrchestratorView[]; lanes: LaneView[];
  accounts: AccountView[]; cards: CardView[]; config: Record<string, unknown>; setup: SetupStatus | null;
  /** v2: the login in progress (or the last one, until the next starts); null = none since the engine started. */
  login: AccountLoginView | null;
  stats?: TokenStats; // v2.1 §5.3 token stats; absent from engines before v2.1
  skillsMcp?: SkillsMcpView; // v2.2 §6 Skills & MCP; Mac channel only. Additive.
  workflows?: WorkflowRow[]; // v2.9 §10.1 the library rows (Mac only; `workflows_changed` replaces them)
  drafts?: DraftView[]; // v2.9 §4.10 the open author drafts (Mac only; `workflow_draft` / `workflow_draft_gone` update them)
  /** v2.7 specs + issues per open project; Mac channel only (§8). */
  issues?: ProjectIssues[];
  /** v2.7.1 §7.3 the 429 cooldown and the manual refresh queue. */
  quota: QuotaState;
  toolkit?: ToolkitView; graph?: GraphView; // v2.5 §5.8 Bộ công cụ and Graph code; Mac channel only (N7)
}

// ---------- engine → UI ----------
export type EngineEvent =
  | IssueEngineEvent
  | WorkflowEngineEvent | ToolkitEngineEvent | GraphEngineEvent | UpdateEngineEvent // v2.9 §10.1, v2.5 §5.8 (Mac only, N6 / N7), v2.6 shared/update.ts
  | { type: 'lane'; lane: LaneView }
  | { type: 'lane_removed'; projectId: string; name: string }
  | { type: 'orchestrator'; orchestrator: OrchestratorView }
  /** v2.1 §4.14 a session ended for good (end / replace): drop its root. Additive. */
  | { type: 'session_ended'; projectId: string; sessionId: string }
  | { type: 'account'; account: AccountView }
  /** v2 §6 A8: the account was deleted (row gone). */
  | { type: 'account_removed'; email: string }
  /** v2.7.1 §7.3 `Snapshot.quota` changed. */
  | { type: 'quota'; quota: QuotaState }
  /** v2 §6 A3–A7 login state (url / clock / error). */
  | { type: 'account_login'; login: AccountLoginView }
  | { type: 'card'; card: CardView }
  | { type: 'project'; project: ProjectView }
  | { type: 'project_removed'; id: string }
  | { type: 'engine'; engine: EngineInfo }
  | { type: 'setup'; setup: SetupStatus }
  | { type: 'stream'; target: Target; lines: StreamLine[] }         // only for watched targets (M16)
  /** v2.2 §14.4 a text block streaming, watched only: `delta` appends; `full` (a mid-stream `watch`) replaces the text so far.
   *  `key` = `<api_message_id>:<index>`, the same as the full line's `StreamLine.key`; `parent` = parent_tool_use_id. */
  | ({ type: 'partial'; target: Target; key: string; parent: string | null } & ({ delta: string; full?: never } | { full: string; delta?: never }))
  /** v2.2 §14.4 the text block `key` stopped (content_block_stop). */
  | { type: 'partial_end'; target: Target; key: string }
  /** v2.2 §14.4 a thinking block started (`on`) / stopped; never its content. */
  | { type: 'thinking'; target: Target; parent: string | null; on: boolean }
  /** v2.1 W9: local (mac) connections get every lane of the project they watch; remote ones only the watched target. */
  | { type: 'subagents'; target: Target; subagents: SubagentView[] }
  /** v2.1 §5.3 after each turn result, within a turn (throttled) and every minute (midnight / 5 h roll). */
  | { type: 'stats'; stats: TokenStats }
  /** v2.2 §6 the whole Skills & MCP view after any change; Mac channel only. Additive. */
  | { type: 'skills_mcp'; view: SkillsMcpView }
  /** v2.3 §10.2 a source changed on disk / in git: `paths` (root-relative) = only these files; absent = any file. Mac channel only. */
  | { type: 'code_changed'; projectId: string; src: Src; paths?: string[] }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'install_log'; job: string; line: string; lineKey?: string; done?: boolean; ok?: boolean } // F1b; job = setup_install.what
  /** After `config_update` / `caps_update`: the same object as `Snapshot.config` (additive, g3). */
  | { type: 'config'; config: Record<string, unknown> }
  /** §8.3: sound in-app; `mac` = the app shows a macOS notification (false when the PO is viewing that target, R10). */
  | { type: 'notify'; kind: NotifyKind; title: string; body: string; sound: boolean; mac: boolean; cardId?: number;
    /** v2.1 §4.15 §4 where a click leads (notify.rs remembers it); `title` already carries "#n" when > 1 running session. Additive. */
    projectId?: string; lane?: string };

export type NotifyKind = 'ask' | 'permission' | 'broken' | 'orchestrator_down' | 'logged_out' | 'cc_updated' | 'shared_cfg' | 'shared_cfg_new' | 'account_orphan' | 'cutover' | 'mcp_login' | 'issues_new' | 'superpowers_off' | 'revert_conflict' | 'all_full' | 'lane_done' | 'account_switch' | 'orchestrator_note';

/** `GET /healthz` body (menu bar N8 polls it without a WebSocket). */
export interface Health {
  version: string; startedAt: number; lanes: { name: string; state: LaneState; phase: Phase | null }[]; openCards: number;
  remote: { enabled: boolean; hostname: string | null };
}

export type ServerMsg =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'event'; event: EngineEvent }
  | { type: 'ack'; id: string; result?: unknown }
  /** `message` = Vietnamese fallback; §6A `key` (+ `params`) = catalog key the UI renders in its language when present. */
  | { type: 'error'; id: string; code: string; message: string; key?: string; params?: Record<string, string | number> };

// ---------- UI → engine ----------
export type Command =
  // chat / lanes (remote-allowed: see REMOTE_ALLOWED)
  /** v2.4 §10.2 `attachments` (Mac only: `up` = an uploaded copy id, `path` = an absolute file path); `raw` (§6.6) = a `/`
   *  command sent without the `[PO]` prefix. Errors `bad_input` (with the bad index), `forbidden_remote`. */
  | { cmd: 'send'; target: Target; text: string; attachments?: ({ up: string } | { path: string })[]; raw?: true }
  | { cmd: 'interrupt'; target: Target }
  | { cmd: 'lane_stop'; projectId: string; name: string; mode: 'drain' | 'now' }
  | { cmd: 'lane_resume'; projectId: string; name: string }
  | { cmd: 'lane_finish'; projectId: string; name: string; force?: boolean }
  | { cmd: 'lane_switch_account'; projectId: string; name: string; account: string | null } // null = auto
  | { cmd: 'card_answer'; id: number; answer: { option?: string; other?: string; note?: string } | { behavior: 'allow' | 'allow_always' | 'deny'; reason?: string } }
  | { cmd: 'card_action'; id: number; action: string }
  | { cmd: 'watch'; target: Target | null }                 // M16 partials + stream for this target only
  | { cmd: 'presence'; visible: boolean }                  // R10/§8.1 (I5): app window shown / hidden
  | { cmd: 'history'; target: Target; beforeSeq?: number; limit?: number } // ack.result = StreamLine[] (scroll-up paging)
  | { cmd: 'subagent_history'; target: Target; taskId: string; beforeSeq?: number } // F25
  /** v2.1 §4.15 N6-e done list (read-only, remote-allowed); ack = DoneLanesPage. `unmerged` = "Chưa merge" chip
   *  (unmerged + unknown rows); `before` = the previous page's `next`; `limit` ≤ 200 (default 50). */
  | { cmd: 'done_lanes_list'; projectId: string; query?: string; unmerged?: boolean; session?: string; before?: string; limit?: number }
  | { cmd: 'stop_all'; projectId?: string; sessionId?: string } // §8.2; v2.1 §4.14 `sessionId` = "lane của #n"
  | { cmd: 'orchestrator_restart'; projectId: string; sessionId?: string }
  | { cmd: 'orchestrator_new'; projectId: string; sessionId?: string } // F21 (v2.1: replaces that session)
  /** v2.1 §4.14 ack = SessionsList (read-only, remote-allowed). */
  | { cmd: 'sessions_list'; projectId: string }
  /** v2.1 §4.14 "Mở phiên song song" (Mac only); ack = OrchestratorView. `from` = "Phiên mới từ handoff #n" / "từ 50 dòng
   *  cuối" (new #n, counts to the cap); `replaceId` = "Thay phiên" (that session writes its handoff, ends, its lanes move). */
  | { cmd: 'session_open'; projectId: string; title?: string; first?: string; account?: string;
    from?: { sessionId: string; kind: 'handoff' | 'tail' }; replaceId?: string;
    /** v2.4 §5.5 the picks for the new session (null / absent = "Theo mặc định"). Additive. */
    model?: string | null; effort?: string | null }
  /** v2.1 §4.14 "Chạy tiếp…" (Mac only): `claude --resume <same id>`; ack = OrchestratorView. */
  | { cmd: 'session_resume'; sessionId: string; mode: 'parallel' | 'replace'; replaceId?: string; account?: string;
    /** v2.4 §5.5 Additive. */
    model?: string | null; effort?: string | null }
  /** v2.1 §4.14 the resume dialog (Mac only); ack = ResumePreview. */
  | { cmd: 'session_resume_preview'; sessionId: string }
  /** v2.1 §4.12 "Đổi tên…" (Mac only): title ≤ 24, empty = none. */
  | { cmd: 'session_rename'; sessionId: string; title: string }
  /** v2.1 §4.14 "Chạy tiếp lane…" (Mac only): a done lane runs again under `toSession`; ack = LaneView. */
  | { cmd: 'lane_continue'; projectId: string; name: string; toSession: string; account?: string }
  /** v2.1 §4.14 N5-o (Mac only); ack = LaneContinuePreview. */
  | { cmd: 'lane_continue_preview'; projectId: string; name: string }
  /** v2.1 §4.14 "Kết thúc phiên" (Mac only); `lanesTo` default = the earliest other running session. */
  | { cmd: 'session_end'; sessionId: string; lanesTo?: string }
  /** v2.1 §4.14 "Chuyển sang phiên" (Mac only). */
  | { cmd: 'lane_reassign'; projectId: string; name: string; toSession: string;
    /** v2.1 §4.14 "Hoàn tác" within 5 s: still-unsent notes of the move are dropped instead of a second pair. Additive. */
    undo?: boolean }
  | { cmd: 'remote_off' }
  | { cmd: 'device_revoke_self' }
  // Mac only
  | { cmd: 'project_add'; name: string; path: string; orchestratorAccount?: string }
  | { cmd: 'project_update'; id: string; patch: Partial<Omit<ProjectView, 'id'>> & { gchatWebhook?: string | null } }
  | { cmd: 'project_remove'; id: string }
  /** hotfix 2026-11-16 "Đóng project": refused (`project_busy`) while a lane or an orchestrator of it runs; the row stays
   *  (closed), its sessions are kept; `project_add` of the same path reopens it held. Ack: { id }. */
  | { cmd: 'project_close'; id: string }
  /** hotfix 2026-11-16 "Tiếp tục" / "Bắt đầu" of a held project: its sessions and lanes run again. Ack: ProjectView. */
  | { cmd: 'project_resume'; id: string }
  | { cmd: 'caps_update'; caps: Record<string, { role?: Role; week: number; five?: number; hard?: boolean }>; poEmail?: string }
  | { cmd: 'config_update'; patch: Record<string, unknown> }
  | { cmd: 'quota_refresh'; account?: string }
  | { cmd: 'setup_check' }
  | { cmd: 'setup_install'; what: 'claude' | 'claude_update' }
  // hotfix 2026-11-16 (b) Git setup (Mac only, never in REMOTE_ALLOWED). git_install ack { opened } (Apple's dialog; false =
  // the tools are already there); git_identity_set ack SetupStatus; gh_login ack GhLoginView.
  | { cmd: 'git_install' }
  | { cmd: 'git_identity_set'; name: string; email: string }
  | { cmd: 'gh_login' }
  | { cmd: 'gh_login_cancel' }
  // v2 accounts (Mac only, N7): ack of add / login = AccountLoginView
  | { cmd: 'account_add'; email?: string; sso?: boolean }
  | { cmd: 'account_login'; email: string }                 // A6 re-login into the account's own dir
  | { cmd: 'account_login_cancel' }
  | { cmd: 'account_paste_code'; code: string }            // A4 "Dán mã": code#state
  | { cmd: 'account_login_resolve'; choice: 'keep' | 'drop' } // A7f "Giữ x@" / "Bỏ x@"
  | { cmd: 'account_logout'; email: string }               // A8L
  | { cmd: 'account_delete'; email: string }               // A8
  /** §5.5 "Gộp vào ~/.claude"; `dryRun` → ack = the plan (files, clashes) and nothing moves. */
  | { cmd: 'shared_cfg_merge'; email: string; name: string; dryRun?: boolean }
  /** §6 A9C "Mở Finder" on the account copy of a clash (Mac only; the engine builds the path from its own merge plan). */
  | { cmd: 'shared_cfg_reveal'; email: string; name: string; file: string }
  /** §5.2 "Dùng chung" switch of an unknown ~/.claude entry, for every account (stored in config.json `sharedExtra`). */
  | { cmd: 'shared_cfg_toggle'; name: string; shared: boolean }
  /** A4 §3.2 SA6 "Mở cửa sổ riêng tư": ack `{ok}`; false → the UI falls back to "Sao chép link". */
  | { cmd: 'account_open_private'; url: string }
  /** PO 2026-11-15: "Thêm project" browse in a plain browser (Tauri has its own picker). Mac only. → { path | null } */
  | { cmd: 'folder_pick' }
  /** v2 §6 A2 ack = AccountsInfo. */
  | { cmd: 'accounts_info' }
  /** v2 §6 A2 ⋯ "Mở Terminal" / §5.4: Terminal at the account dir (the dir comes from the registry). */
  | { cmd: 'account_open_terminal'; email: string }
  | { cmd: 'open_in_vscode'; path: string }
  /** v2.3 §10.2 the Code form: `path` relative to the source root (same checks as `fs_read`); the file must exist. */
  | { cmd: 'open_in_vscode'; projectId: string; src: Src; path: string }
  // v2.4 §5.5 model / effort (Mac only, never in REMOTE_ALLOWED, §8). `accountId`: the open dialog; `sessionId`: the menu
  // (that session's account). ack = SessionModels.
  | { cmd: 'session_models'; projectId: string; accountId?: string; sessionId?: string; lane?: string }
  /** `model: null` = "Theo mặc định"; `effort` is never null. ack = { applied }; errors `model_not_found`, `timeout`. */
  | { cmd: 'session_set_model'; sessionId: string; model?: string | null; effort?: string }
  | { cmd: 'session_model_cancel'; sessionId: string }
  /** v2.4 §5.6 a lane's chip: same rules as `session_set_model`; ack = SetModelResult; errors + `bad_state` (lane Xong). */
  | { cmd: 'lane_set_model'; projectId: string; name: string; model?: string | null; effort?: string }
  | { cmd: 'lane_model_cancel'; projectId: string; name: string }
  // v2.3 §10.2 Code + Git (Mac only, never in REMOTE_ALLOWED, §8)
  | FsListReq | FsFindReq | FsReadReq | FsWriteReq
  | GitBranchesReq | GitChangesReq | GitDiffReq | GitLogReq | GitWatchReq
  | IssueCommand // v2.7 §10.1 (Mac only, §8)
  | WorkflowCommand | ToolkitCommand | GraphCommand | UpdateCommand // v2.9 §10.1, v2.5 §5.8 (Mac only, N6 / N7), v2.6 §10.2 (Mac only)
  // v2.2 Skills & MCP (§5.4, §5.5; Mac only, D32 / C24). `rev` = SkillsMcpView.claudeJson.rev the dialog opened with
  // (changed since → error `source_changed`, K14).
  /** K4 "Đăng nhập": `noLogin` = "Không" (config `mcp.noLogin`); "Client ID" = `config.oauth.clientId` + optional
   *  `clientSecret` (→ `add-json --client-secret`, env `MCP_CLIENT_SECRET`; never stored by cc-slaves). */
  | { cmd: 'mcp_add'; name: string; config: Record<string, unknown>; rev?: string; noLogin?: boolean; clientSecret?: string }
  /** K5: `to` = the new name (default `name`). */
  | { cmd: 'mcp_edit'; name: string; to?: string; config: Record<string, unknown>; rev?: string; noLogin?: boolean; clientSecret?: string }
  /** K4 check "npx có trên PATH (…)": the command looked up on the login PATH → { path | null }. */
  | { cmd: 'mcp_which'; command: string }
  | { cmd: 'mcp_remove'; name: string; rev?: string }
  /** K1 "Lane" switch (`mcp.offForLanes`); K7 "Để tắt" = `on: false` on a pending project entry. */
  | { cmd: 'mcp_toggle'; id: string; on: boolean }
  /** K7 "Bật cho lane" (`mcp.projectOn`). */
  | { cmd: 'mcp_project_enable'; id: string; on: boolean }
  /** §5.4b "Kiểm tra" (C22: `not_checkable` for K7 / K1-local stdio / ws / headersHelper). */
  | { cmd: 'mcp_check'; id: string }
  /** K3 "Đăng nhập" (the engine opens the browser); K3e-client: the PO's Client ID / secret (Keychain only, C18). */
  | { cmd: 'mcp_login'; id: string; clientId?: string; clientSecret?: string }
  /** K3 "Huỷ". */
  | { cmd: 'mcp_login_cancel'; id: string }
  /** §5.3 ⋯ "Đăng xuất": revoke, then delete the Keychain item. */
  | { cmd: 'mcp_logout'; id: string }
  /** §5.3 yellow row "Thử lưu lại": write the in-memory login to the Keychain again. */
  | { cmd: 'mcp_keychain_retry'; id: string }
  /** K13 "Để sau": hide the card 4 h (or until another lane misses the server). */
  | { cmd: 'mcp_snooze'; id: string }
  /** §5.5 K9 "Thư mục": "Liên kết" (default) / "Chép". */
  | { cmd: 'skill_add_folder'; path: string; mode: 'link' | 'copy' }
  /** K9 "Thư mục": the §5.5 checks of a picked folder before "Liên kết" / "Chép" (ack SkillDirCheck, nothing written). */
  | { cmd: 'skill_check_folder'; path: string }
  /** K9 "Git": clone + list (ack SkillGitFetch), then add the picked names (or cancel). */
  | { cmd: 'skill_git_fetch'; url: string }
  | { cmd: 'skill_git_add'; cloneId: string; names: string[] }
  | { cmd: 'skill_git_cancel'; cloneId: string }
  /** K10: link → unlink, folder → Trash (user skills only). */
  | { cmd: 'skill_remove'; id: string }
  /** K11 fixes: appLink → `copy`; brokenLink → `unlink` / `relink` (+ `target`); missingSkillMd → `trash`. */
  | { cmd: 'skill_fix'; issueId: string; fix: 'copy' | 'unlink' | 'relink' | 'trash'; target?: string }
  /** C23 "Đã biết" / "Bỏ đã biết". */
  | { cmd: 'skill_ack'; issueId: string; on: boolean }
  /** `skills.offForLanes` (user / project skill id). */
  | { cmd: 'skill_toggle'; id: string; on: boolean }
  /** `plugins.offForLanes` (`<plugin>@<marketplace>`). */
  | { cmd: 'plugin_toggle'; key: string; on: boolean }
  | { cmd: 'engine_shutdown' };

export type ClientMsg = { type: 'command'; id: string; command: Command };

// ---------- v2.3 §10.2 Code fs (Mac only) ----------
/** A Code source: the project dir, or a lane's worktree (valid only when listed by `git worktree list`); `laneId` = lane name as in `Target`. */
export type Src = { kind: 'base' } | { kind: 'lane'; laneId: string };
/** `ignored` = `.gitignore` flag for "Hiện file bị bỏ qua" (V21); `size` in bytes (lstat). */
export interface FsEntry { name: string; type: 'file' | 'dir' | 'symlink'; size: number; ignored: boolean }
export interface FsListReq { cmd: 'fs_list'; projectId: string; src: Src; dir: string; showIgnored: boolean }
/** §5.1: first 2 000 entries, dirs first; `more` = how many were cut. */
export interface FsListResult { entries: FsEntry[]; more: number }
export interface FsFindReq { cmd: 'fs_find'; projectId: string; src: Src; query: string; showIgnored: boolean }
/** ≤ 50 relative paths, best match first. */
export interface FsFindResult { paths: string[] }
export interface FsReadReq { cmd: 'fs_read'; projectId: string; src: Src; path: string }
export type Eol = 'lf' | 'crlf';
/** `hash` = sha1 of the file bytes; `text` has LF line ends (the web rejoins nothing, `fs_write` sends `eol` / `bom` back). */
export interface FsReadResult {
  kind: 'text' | 'image' | 'binary' | 'large'; text?: string; dataUrl?: string; size: number; hash: string;
  eol?: Eol; bom?: boolean; readOnly?: 'not_utf8' | 'mixed_eol';
}
export interface FsWriteReq {
  cmd: 'fs_write'; projectId: string; src: Src; path: string; text: string; eol: Eol; bom: boolean; baseHash: string; recreate?: boolean;
}
/** `lane_running` / `forbidden` are error frames; `conflict` carries the disk file, `gone` = the file is no longer there. */
export type FsWriteResult =
  | { ok: true; hash: string }
  | { ok: false; code: 'conflict'; disk: FsReadResult }
  | { ok: false; code: 'gone' };

// ---------- v2.3 §10.2 Git (Mac only); branch names come from `git_branches`, commits are hex ----------
export type GitOf = { branch: string } | { commit: string } | { dirty: Src };
interface GitBranchesReq { cmd: 'git_branches'; projectId: string }
/** `unpushed` null = no `origin/<name>` ref (never fetched); `dirty` = uncommitted entries of the project dir. */
interface GitBase { name: string; unpushed: number | null; dirty?: number }
export interface GitBranchesResult {
  base: GitBase | null;
  /** base null: `none` = detached / no branch (§6.1 "Không xác định được nhánh gốc"); `unknown` = git failed (`program` = the key run). */
  baseError?: { kind: 'none' } | { kind: 'unknown'; reason: string; program?: string };
  /** Lanes of the project in their own worktree; `branch` = the last §4.15 measurement + `dirty` (null = never measured). */
  lanes: { lane: string; name: string; branch: LaneBranch | null }[];
  /** §7 G7 (R17) the project dir is not a git repo: `base` null, `lanes` [] (other git commands fail with `git_not_repo`). */
  notRepo?: true;
}
/** `?` = untracked, `U` = unmerged; +/− only between two commits (absent for `{ dirty }` and binary files). */
export interface GitFileChange { path: string; status: 'A' | 'M' | 'D' | 'T' | 'U' | '?'; add?: number; del?: number; conflict?: boolean }
interface GitChangesReq { cmd: 'git_changes'; projectId: string; of: GitOf }
export interface GitChangesResult { files: GitFileChange[] }
/** One side of a diff: text (LF line ends, ≤ 2 MB like `fs_read`) or why there is none. */
export type GitBlob = { kind: 'text'; text: string } | { kind: 'binary' | 'large' | 'absent' };
interface GitDiffReq { cmd: 'git_diff'; projectId: string; path: string; of: GitOf }
export interface GitDiffResult {
  old: GitBlob; new: GitBlob;
  /** `{ branch }` whose merge into base conflicts on `path`: marker ranges (1-based lines of `merged`), the last base commit on it, the trial merge. */
  conflict?: { hunks: { start: number; end: number }[]; lastBaseCommit: string | null; merged: GitBlob };
}
/** `refs` [] = base + every lane branch; `limit` ≤ 200; `before` = the last hash of the previous page. */
interface GitLogReq { cmd: 'git_log'; projectId: string; refs: string[]; limit: number; before?: string }
/** `at` epoch ms; `refs` = local branch labels on the commit. */
export interface GitCommit { hash: string; parents: string[]; subject: string; author: string; at: number; refs: string[] }
/** `restart` = the tips moved since `before` was read: this page starts from the top again. */
export interface GitLogResult { commits: GitCommit[]; more: boolean; restart?: boolean }
/** §10.2 "không gọi git khi tab Git đang ẩn": the connection shows (on) / hides the Git tab of the project. */
interface GitWatchReq { cmd: 'git_watch'; projectId: string; on: boolean }

/**
 * System-card action id → the command it runs (I4): the engine gates `card_action` on the remote channel with it and
 * the UI hides what would be refused. Unlisted ids (dismiss…) only resolve the card.
 */
export const CARD_ACTION_CMD: Readonly<Record<string, Command['cmd']>> = {
  account_relogin: 'account_login', restart_orchestrator: 'orchestrator_restart', orchestrator_restart: 'orchestrator_restart',
  new_orchestrator: 'orchestrator_new', new_orchestrator_session: 'orchestrator_new', orchestrator_new: 'orchestrator_new',
  lane_resume: 'lane_resume', setup_check: 'setup_check', hand_to_orchestrator: 'send', view_log: 'history',
  shared_cfg_merge: 'shared_cfg_merge', shared_cfg_toggle: 'shared_cfg_toggle',
  account_orphan_adopt: 'account_add', account_orphan_delete: 'account_delete', account_add: 'account_add', // §7.1-3 cutover → A3 (Mac only, N7)
  mcp_login: 'mcp_login', mcp_snooze: 'mcp_snooze', // v2.2 K13 (C24): Mac only → forbidden_remote on the remote channel
};

/** §6B / §7.2 N2: the only commands accepted on the remote channel. Everything else → error `forbidden_remote`. */
export const REMOTE_ALLOWED: ReadonlySet<Command['cmd']> = new Set<Command['cmd']>([
  'send', 'interrupt', 'lane_stop', 'lane_resume', 'lane_finish', 'lane_switch_account', 'card_answer', 'card_action',
  'watch', 'presence', 'history', 'subagent_history', 'remote_off', 'device_revoke_self', 'done_lanes_list',
  'sessions_list', // v2.1 §4.14 read-only; open / end / reassign spawn or change command rights → Mac only
  'project_resume', // hotfix 2026-11-16 "Tiếp tục" steers like a send; `project_close` is Mac only
]);
