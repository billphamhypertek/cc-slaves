// v2.7 issues / specs (spec §5.1): the wire types and the few rules engine and web must compute the same way. A leaf.

export type SpecState = 'draft' | 'approved' | 'active' | 'done';
export type SpecOrigin = 'app' | 'imported';
export type IssueKind = 'task' | 'bug';
/** §5.1: `amend` = from a "Bổ sung yêu cầu" round (§5.2-9); `prior` = done before the import (§5.2-10). */
export type IssueSource = 'spec' | 'amend' | 'po' | 'lane' | 'orchestrator' | 'prior';
export type IssueState = 'todo' | 'doing' | 'done' | 'cancelled';
/** §5.7 the revert of a cancelled `done` issue. */
export type RevertState = 'none' | 'pending' | 'running' | 'conflict' | 'done';
/** §5.0 the three orchestrator session kinds (`session.orch_kind`); sessions older than v2.7 are `general`. */
export type OrchKind = 'design' | 'build' | 'general';

/** §5.2-7 what an imported spec's status line decides once (scan) and the store writes (`NewSpec`). */
export interface SpecGuess { state: 'draft' | 'approved'; outsideBuild: boolean }

/** §5.5-6 one commit of an issue: `branch` = the lane branch it was made on (null = detached HEAD). */
export interface IssueCommit { sha: string; branch: string | null }

export interface SpecRow {
  id: number;
  projectId: string;
  /** Relative to the project root. */
  path: string;
  title: string;
  state: SpecState;
  /** The spec that must be `done` before this one may be built (§5.2-6). */
  afterId: number | null;
  /** Integration branch; null = straight on `main`. */
  branch: string | null;
  /** v2.9 §5.3 column `step_session`: the session of the spec's current doc step (wire `sessions.design`). */
  designSession: string | null;
  buildSession: string | null;
  editSession: string | null;
  origin: SpecOrigin;
  outsideBuild: boolean;
  resumed: boolean;
  amendRev: number;
  approvedAt: number | null;
  openedAt: number | null;
  doneAt: number | null;
  createdAt: number;
  /** v2.9 §6.1 the workflow rev the spec runs to its end. */
  workflowRev: string;
  /** v2.9 §5.3 the doc / build step it is at (`null` once done). */
  step: string | null;
}

export interface IssueRow {
  id: number;
  projectId: string;
  num: number;
  /** `T-47` / `B-50` (§5.1). */
  key: string;
  kind: IssueKind;
  specId: number | null;
  source: IssueSource;
  sourceLane: number | null;
  sourceIssue: number | null;
  /** The issue this one reverts (§5.7-4). */
  reverts: number | null;
  title: string;
  body: string;
  doneWhen: string[];
  state: IssueState;
  revert: RevertState;
  laneId: number | null;
  baseSha: string | null;
  poSeen: boolean;
  poOk: boolean;
  cancelReason: string | null;
  createdBySession: string | null;
  createdAt: number;
  doneAt: number | null;
}

const KEY_RE = /^([TB])-([1-9]\d{0,8})$/;

/** R-B4 the one home of the display key: `T-<num>` task, `B-<num>` bug (one shared counter per project). */
export function issueKey(kind: IssueKind, num: number): string {
  return `${kind === 'bug' ? 'B' : 'T'}-${num}`;
}

export function parseIssueKey(key: string): { kind: IssueKind; num: number } | null {
  const m = KEY_RE.exec(key.trim());
  return m ? { kind: m[1] === 'B' ? 'bug' : 'task', num: Number(m[2]) } : null;
}

export interface Progress {
  done: number;
  /** Every issue except `cancelled`. */
  total: number;
  /** Extra scope not yet done (`source ≠ spec`): the striped part of the bar. */
  scope: number;
  cancelled: number;
  /** Non-cancelled issues from a "Bổ sung yêu cầu" round ("· 3 bổ sung"). */
  amend: number;
}

/** §4.2-2 THE progress rule, shared by the Deck head strip and the Tasks tab. */
export function progressOf(issues: readonly { state: IssueState; source: IssueSource }[]): Progress {
  const p: Progress = { done: 0, total: 0, scope: 0, cancelled: 0, amend: 0 };
  for (const i of issues) {
    if (i.state === 'cancelled') { p.cancelled++; continue; }
    p.total++;
    if (i.state === 'done') p.done++;
    else if (i.source !== 'spec') p.scope++;
    if (i.source === 'amend') p.amend++;
  }
  return p;
}

/** §5.5-7 (A5) title compare: lower case, punctuation / symbols dropped, spaces collapsed; Vietnamese diacritics kept. */
export function normTitle(title: string): string {
  return title.normalize('NFC').toLocaleLowerCase('vi').replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** R34 (§5.0) at most 3 Thiết kế / Build sessions per project, plus the one Chung session. */
export const MAX_SESSIONS = 3;

/** R34 how many of a project's running sessions count: design + build, and a Chung beyond the first (pre-v2.7 parallel ones). */
export function countedSessions(kinds: readonly OrchKind[]): number {
  const general = kinds.filter((k) => k === 'general').length;
  return kinds.length - general + Math.max(0, general - 1);
}

/** R34 opening one more session of `kind` next to `kinds` would pass the cap (a first Chung never does). Engine and web
 *  (R-B13 e, from `OrchestratorView.orchKind`) use this one rule; v2.9 §5.7 `max` = the workflow's `max_doc_sessions`. */
export function capReached(kinds: readonly OrchKind[], kind: OrchKind, max = MAX_SESSIONS): boolean {
  const counts = kind !== 'general' || kinds.includes('general');
  return counts && countedSessions(kinds) >= max;
}

// ---------- protocol 6 wire (§10.1): snapshot `issues`, events, Mac-only commands ----------
export type SpecOutputKind = 'md' | 'image' | 'html' | 'link' | 'other';
/** §4.10 the row's slot in the fixed order; the web names it (Spec, Mockup, Ảnh mockup · n, …). */
export type SpecOutputRole = 'spec' | 'mockup' | 'images' | 'doc' | 'link';
/** `spec_outputs` ack row (§4.10 IS20). */
export interface SpecOutput {
  role: SpecOutputRole;
  kind: SpecOutputKind;
  /** root-relative path or the full URL (a token stays here, R33: state.db only; the web shows `display`). */
  ref: string;
  label: string | null;
  display: string;
  addedBy: 'auto' | 'session';
  /** `off` = a localhost link nothing listens on (300 ms probe): "đã tắt". */
  state: 'ok' | 'missing' | 'off';
  /** `images` only: how many images the row groups (`ref` = the first). */
  count?: number;
}

/** `spec_prior_sessions` ack row (§4.9 IS17, §5.2-10). */
export interface PriorSession {
  id: string;
  firstText: string;
  /** mtime of the transcript, epoch ms. */
  lastAt: number;
  /** user text messages (tool results, sidechains and meta lines are not turns). */
  turns: number;
  /** R-B6 the `cwd` of the first `type:user` line: resume spawns there. */
  cwd: string | null;
  runningElsewhere: boolean;
  long: boolean;
  /** v2.7.1 SA6b "Như phiên cũ (<giá trị>)": the last assistant line's model id / effort; null when the transcript has none. Additive. */
  model: string | null;
  effort: string | null;
}

export interface SpecInfo {
  id: number; projectId: string; path: string; title: string; state: SpecState;
  /** §5.2-6 the spec that must be `done` first. */
  after: { id: number; path: string; title: string; state: SpecState } | null;
  branch: string | null;
  sessions: { design: string | null; build: string | null; edit: string | null };
  origin: SpecOrigin; outsideBuild: boolean; resumed: boolean; amendRev: number;
  /** §5.2-7 the file is gone ("mất file"); the spec and its issues stay. */
  missing: boolean;
  /** §4.8 "7 nhóm · G0–G6" (draft / approved only); null = no §"Nhóm việc". */
  groups: string | null;
  /** §4.8 a Thiết kế session is editing / amending it ("đang sửa · Tới phiên"). */
  editing: boolean;
  progress: Progress;
  approvedAt: number | null; openedAt: number | null; doneAt: number | null; createdAt: number;
  /** R-B14 (D99, IS22 / IS22b) the overview card of an `active` / `done` spec; null for draft / approved. */
  overview: SpecOverview | null;
  /** v2.9 §6.1 / §5.3 the rev the spec runs to its end and the step it is at (null once done): the rail's groups. */
  workflowRev: string; step: string | null;
}

/** R-B14 the engine half of the spec overview card (§4.3 D99); times / labels are the web's. */
export interface SpecOverview {
  /** "Phiên Build": `waiting_po` = it has an open PO card; `closed` = ended or no live process. */
  buildSession: { id: string; title: string | null; state: 'running' | 'waiting_po' | 'closed' } | null;
  /** "Lane đang làm": the lanes holding a `doing` issue of the spec, with their live state + phase (§4.3 cluster). */
  lanes: { name: string; key: string; state: string; phase: string | null }[];
  /** "Bổ sung" (only after a round): rev, its `amend` issues, when the newest of them was created. */
  lastAmend: { rev: number; issueCount: number; at: number | null } | null;
  /** "Commit": distinct trailer commits recorded over the spec's issues (§5.5-6). */
  commits: number;
  /** "Nhánh (đã merge vào …)": `main` once the spec is done (§5.2-5 the Build session merges before spec_close); null while building. */
  mergedInto: string | null;
}

export interface IssueInfo {
  id: number; projectId: string; key: string; kind: IssueKind; specId: number | null; title: string; body: string;
  doneWhen: string[]; state: IssueState; revert: RevertState;
  /** §5.4 computed. */
  priority: boolean;
  /** Every blocker ("Bị chặn bởi"); `waitingOn` = those not `done` ("chờ T-47, T-48"); `blocks` = issues it blocks ("Đang chặn"). */
  blockedBy: string[]; waitingOn: string[]; blocks: string[];
  /** The lane holding / that held it, its state + phase now (LaneState / Phase strings). */
  lane: { name: string; state: string; phase: string | null } | null;
  commits: { sha: string; branch: string | null; at: number }[];
  source: IssueSource; sourceLane: string | null; sourceIssue: string | null;
  /** The issue this one reverts (§5.7-4). */
  reverts: string | null;
  poSeen: boolean; poOk: boolean; cancelReason: string | null;
  files: { id: number; name: string; size: number }[];
  /** History, structured (§5.1): the web builds the sentence. `taken` / `returned`: `data.lane` = that event's lane name
   *  (null = its row is gone), mapped by the engine at read (review IMPORTANT-2). */
  events: { ts: number; type: string; data: Record<string, unknown> }[];
  createdAt: number; doneAt: number | null;
}

/** `Snapshot.issues` (Mac only): one per open project. */
export interface ProjectIssues {
  projectId: string; specs: SpecInfo[]; issues: IssueInfo[];
  /** §4.2-2 progress of the issues outside any spec. */
  outside: Progress;
}

/** Mac-only events: one per spec / issue whose view changed, coalesced per tick. */
export type IssueEngineEvent = { type: 'issue_changed'; issue: IssueInfo } | { type: 'spec_changed'; spec: SpecInfo };

/** §10.1 + R-B12 Mac-only commands (never in REMOTE_ALLOWED, §8). Keys and paths are per project: every one names it.
 *  `spec_new` / `spec_build` / `spec_edit` ack `{ sessionId }` (the web selects that session); `spec_mark` ack SpecInfo;
 *  `spec_scan` ack `{ imported, moved }`; `spec_prior_sessions` ack PriorSession[]; `spec_outputs` ack SpecOutput[]. */
export type IssueCommand =
  | { cmd: 'issue_ok'; projectId: string; key: string }
  | { cmd: 'issue_seen'; projectId: string; key: string }
  | ({ cmd: 'spec_new'; projectId: string } & StartPicks)
  /** `resume` = the Claude session id picked in IS17 ("Nhận phiên cũ"). */
  | ({ cmd: 'spec_build'; projectId: string; path: string; resume?: string } & StartPicks)
  | ({ cmd: 'spec_edit'; projectId: string; path: string } & StartPicks)
  /** v2.7.1 §7.4 read only (ack SessionPick): the account "Tự chọn" would open a session of `kind` on right now. */
  | { cmd: 'session_pick'; projectId: string; kind: 'design' | 'build' }
  | { cmd: 'spec_mark'; projectId: string; path: string; state: 'draft' | 'approved' }
  | { cmd: 'spec_scan'; projectId: string }
  /** IS16 "Ẩn" of the "Đã nhập n spec có sẵn" line (`ProjectView.specsImported` → null). */
  | { cmd: 'spec_import_hide'; projectId: string }
  | { cmd: 'spec_prior_sessions'; projectId: string; path: string }
  | { cmd: 'spec_outputs'; projectId: string; path: string }
  /** R-B12 the IS4 numbers (ack IssueCancelPreview); a refused cancel (prior, open revert, …) → error `refused`. */
  | { cmd: 'issue_cancel_preview'; projectId: string; key: string }
  /** §5.7 the PO confirmed IS4 (ack IssueCancelResult); `reason` goes to the orchestrator and onto the issue (A5). */
  | { cmd: 'issue_cancel'; projectId: string; key: string; reason?: string }
  /** §4.3 an attachment of the issue (`IssueInfo.files[].id`) to view (ack IssueFileData): images ≤ 5 MB only. */
  | { cmd: 'issue_file'; projectId: string; key: string; id: number };

/** v2.7.1 §7.4 start options of `spec_new` / `spec_build` / `spec_edit` (the ▾ dialog); an absent field = today's default.
 *  `account` hand-picked → refused `account_unusable` (signed out, full, needs a test run, past the admit line — L13);
 *  none and "Tự chọn" finds no account → refused `no_account`. `model` / `effort` null = "Theo mặc định" (v2.4 §5.5). */
export interface StartPicks { account?: string; model?: string | null; effort?: string | null }

/** v2.7.1 §7.4 `session_pick` ack: "Tự chọn"'s account + its `headroomPct`; `earliest` (account null only) = the account
 *  that reopens first and when (epoch ms, SA9). */
export interface SessionPick { account: string | null; headroomPct: number | null; earliest: { email: string; at: number } | null }

/** `issue_file` ack: the kept copy as a data URL (the Code image viewer's form). */
export interface IssueFileData { name: string; size: number; dataUrl: string }

/** R-B12 / §4.4 what IS4 shows before the PO confirms. `mode`: `cancel` a `todo` · `stop` a `doing` whose commits are not on
 *  the target branch (stop the lane, drop its branch, no revert) · `revert` a `done` (or a `doing` already merged in part). */
export interface IssueCancelPreview {
  key: string;
  mode: 'cancel' | 'stop' | 'revert';
  /** `stop`: the lane to stop now, the branch it works on, its commits for the issue (none merged). */
  lane: { name: string; branch: string | null; commits: number } | null;
  /** `revert`: the target branch (null = no git), its trailer commits newest first, the key the revert issue gets. */
  revert: { branch: string | null; shas: string[]; key: string } | null;
  /** Issues blocked by it: open ones stay blocked until the orchestrator unlinks; done ones were built on it (UX r2 I6). */
  dependants: { open: string[]; done: string[] };
}

/** `issue_cancel` ack: what happened; `revertKey` = the new "Hoàn tác …" issue (mode `revert`). */
export interface IssueCancelResult { key: string; mode: IssueCancelPreview['mode']; revertKey: string | null }

/** §8 the v2.7 cards whose buttons act on the Mac only: the remote channel gets them with no buttons ("trả lời trên Mac"). */
export const MAC_ACTION_CARDS: ReadonlySet<string> = new Set(['issues_new', 'superpowers_off', 'revert_conflict']);

/** §8 a card as the remote channel sees it. */
export function remoteCard<T extends { kind: string; actions?: unknown[] }>(c: T): T {
  return MAC_ACTION_CARDS.has(c.kind) ? { ...c, actions: [] } : c;
}
