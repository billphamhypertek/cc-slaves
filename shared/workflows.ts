// spec v2.9 §10.1 the workflow library on the wire: rows, one pack's files, the commands (Mac only: none is in
// REMOTE_ALLOWED, §10.2 N6) and the `workflows_changed` event (Mac channel only).

/** §5.2 the four step types; the ids equal `session.orch_kind` + `lane`. */
export const STEP_TYPES = ['design', 'build', 'general', 'lane'] as const;
export type StepType = (typeof STEP_TYPES)[number];
/** §5.3 `next.start` of a doc → doc / doc → build edge. */
export const START_VALUES = ['button', 'auto'] as const;
export type StartMode = (typeof START_VALUES)[number];
/** §5.3 the end of the chain (`next.to: done` = Xong); no step may take this id. */
export const DONE_ID = 'done';
/** R9 / §7 "Trống" (only Chung + Lane, no instructions): a template to copy in "+ Quy trình mới"; no library row, never applied. */
export const BLANK_TEMPLATE = 'template:blank';
/** §5.7 the on / off rules and the one number (Quy trình PO defaults: all on, 3). */
export const BOOL_RULES = ['priority_first', 'one_item_per_lane', 'outside_item_new_lane', 'no_recreate_cancelled'] as const;
export type BoolRule = (typeof BOOL_RULES)[number];
export const MAX_DOC_SESSIONS = { min: 1, max: 6, def: 3 } as const;
/** §5.3 / §5.4 at most 4 doc steps, 8 lane phases ending in `done`; step ids and phases are short slugs. */
export const MAX_DOCS = 4;
export const MAX_PHASES = 8;
export const LAST_PHASE = 'done';
export const STEP_ID_RE = /^[a-z0-9-]{1,24}$/;
export const PHASE_RE = /^[a-z0-9-]{1,16}$/;
/** §5.6 a `{{slot}}` in a body. */
export const SLOT_RE = /\{\{([a-z_:]+)\}\}/g;

/** One §5.4 finding (`V1`–`V15` error or `W` warning), a Vietnamese sentence tied to a file / step / line. */
interface WorkflowIssue { code: string; msg: string; file?: string; step?: string; line?: number }

export interface WorkflowRow {
  /** `builtin:<slug>` or the library folder name. */
  id: string;
  builtin: boolean;
  name: string;
  description: string;
  /** The last valid rev: what a project applying it runs (WF5b: still this one while the files on disk are broken). */
  rev: string | null;
  /** The rev of the files on disk now, the `baseRev` of `workflow_save` (WF5c). */
  diskRev: string;
  /** Epoch ms the running rev was read ("bản hợp lệ lúc 14:02 17/11"). */
  validAt: number | null;
  /** Findings of the files on disk (errors = the row shows "lỗi"). */
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
  /** R13 `based_on` of a copy, and whether that built-in has a newer rev ("mẫu gốc có bản mới"). */
  basedOn: string | null;
  baseOutdated: boolean;
  /** Projects whose `project.workflow` is this id (WF10a "đang dùng ở …"). */
  usedBy: { id: string; name: string }[];
  /** The pack folder on this Mac (WF5b / ⋯ "Mở thư mục", WF10b); null = a built-in (embedded in the engine). */
  dir: string | null;
}

/** §4.7 the effective config of a session / lane ("Quy trình PO · Build · bản a1b2c3"); the hover lists the skills the
 *  step blocks and the §5.7 rules on (bool rule keys, plus `maxDoc` = max_doc_sessions). */
export interface WfRef { rev: string; name: string; step: string; stepName: string; deny: string[]; rules: string[]; maxDoc: number }

/** §5.3 / §5.5 what the Tasks tab reads of a rev (groups, buttons, labels, phases). */
interface WorkflowStepInfo {
  id: string; type: 'design' | 'build' | 'general' | 'lane'; name: string;
  labels: { group?: string; waiting?: string; start?: string };
  next: { to: string; start: 'button' | 'auto' | null } | null;
  phases: string[] | null;
}

/** `workflow_get`: the files (`path → text`) of a library pack on disk or of a pinned rev, their findings, and the steps
 *  of the rev when it is valid. */
export interface WorkflowDetail {
  rev: string;
  files: Record<string, string>;
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
  name: string;
  docLabel: string;
  steps: WorkflowStepInfo[] | null;
}

/** `workflow_save` ack: `saved` false = the files have errors (nothing written). A disk change since `baseRev` is the
 *  error frame `workflow_conflict` (WF5c). */
export interface WorkflowSaveResult { saved: boolean; row: WorkflowRow | null; errors: WorkflowIssue[]; warnings: WorkflowIssue[] }

/** §4.8 `workflow_import` ack: the preview (`name` after the "(2)" rename); `row` set once added (not on `preview`). */
export interface WorkflowImportResult {
  name: string; description: string; files: Record<string, string>; errors: WorkflowIssue[]; warnings: WorkflowIssue[];
  row: WorkflowRow | null;
}

/** §10.2 one canvas change: a frontmatter key of an md file (`value` absent / null = drop the key), its body, or a whole file
 *  (`.layout.json`, a new / removed step file; `text` null = remove). */
export type WorkflowEdit =
  | { path: string; key: string; value?: unknown }
  | { path: string; body: string }
  | { path: string; text: string | null };

/** An md file read back for the canvas: `fm` null = YAML that does not parse; `readOnly` = keys the canvas may not rewrite. */
export interface WorkflowDocView { fm: Record<string, unknown> | null; body: string; readOnly: string[] }

/** `workflow_edit` ack: the files after the edits (nothing written), each md file read back, the §5.4 findings, and the
 *  keys `patchFrontmatter` refused (their files unchanged). */
export interface WorkflowEditResult {
  files: Record<string, string>;
  docs: Record<string, WorkflowDocView>;
  errors: WorkflowIssue[]; warnings: WorkflowIssue[];
  failed: { path: string; key: string; reason: string }[];
}

export type WorkflowCommand =
  | { cmd: 'workflow_get'; id: string }
  | { cmd: 'workflow_get'; rev: string }
  | { cmd: 'workflow_save'; id: string; files: Record<string, string>; baseRev: string }
  /** §10.2 apply canvas edits to the files the page holds (no write). Ack WorkflowEditResult. */
  | { cmd: 'workflow_edit'; files: Record<string, string>; edits: WorkflowEdit[] }
  /** R9 "+ Quy trình mới" = copy `from` (a built-in or a library id) under `name`. Ack WorkflowRow. */
  | { cmd: 'workflow_create'; from: string; name: string }
  /** §4.8 a picked folder: `preview` checks only; without it the pack is copied into the library. */
  | { cmd: 'workflow_import'; dir: string; preview?: boolean }
  /** R12 the folder goes to the Trash; refused while a project uses it. Ack `{ trashed }`. */
  | { cmd: 'workflow_delete'; id: string }
  /** §4.6 Áp dụng: new docs and the Chung session follow it; pinned docs keep their rev (R6). */
  | { cmd: 'project_set_workflow'; projectId: string; id: string }
  /** §4.10 / §5.9 author by prompt: a draft of a library pack (`fromId`) or of a new pack (null) + the first message. Ack DraftView. */
  | { cmd: 'workflow_draft_start'; fromId: string | null; text: string }
  | { cmd: 'workflow_draft_say'; draftId: string; text: string }
  /** Dừng: interrupt the running turn. */
  | { cmd: 'workflow_draft_stop'; draftId: string }
  /** Bỏ nháp: stop the session, delete the draft folder. */
  | { cmd: 'workflow_draft_discard'; draftId: string }
  /** §4.10 a hand edit on the draft canvas (same edits as `workflow_edit`), written into `pack/`. Ack WorkflowEditResult. */
  | { cmd: 'workflow_draft_patch'; draftId: string; edits: WorkflowEdit[] }
  /** Lưu (the button; the session's `draft_save` does the same): `name` = the new pack's name edited in place. Ack WorkflowSaveResult. */
  | { cmd: 'workflow_draft_save'; draftId: string; name?: string }
  /** Hoàn tác within 30 s of a save: the previous files back (or the new pack to the Trash), the draft reopened. */
  | { cmd: 'workflow_draft_undo'; draftId: string }
  /** §5.9 the account hit its cap mid-turn: Tiếp tục (`go`, resume on `to`) or Để sau. */
  | { cmd: 'workflow_draft_quota'; draftId: string; go: boolean };

/** §4.10 one line of the author chat: the user, Claude's reply, the turn's activity ("đang viết steps/plan.md…", gone when the
 *  turn ends) or a system line (`key` of the `workflow.author.*` catalog + params). */
export interface DraftLine { kind: 'user' | 'claude' | 'activity' | 'system'; text: string; key?: string; params?: Record<string, string | number> }

/** §6.2 `running` = a turn is on (canvas read only); `idle` = waits for the user; `quota` = Tiếp tục / Để sau; `saved` = hidden 30 s for Hoàn tác. */
export type DraftState = 'running' | 'idle' | 'quota' | 'saved';

/** §4.10 / §5.9 one draft on the Mac (`workflow_draft` event, snapshot `drafts`). */
export interface DraftView {
  id: string;
  /** The library pack it edits; null = a new pack. */
  fromId: string | null;
  state: DraftState;
  account: string | null;
  model: string | null;
  /** `pack/` now (the §5.1 files only) and as the draft opened (`base`, empty for a new pack). */
  files: Record<string, string>;
  base: Record<string, string>;
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
  /** The §5.1 paths added / changed / removed against `base` ("3 thay đổi", the "mới" / "đổi" tags, struck removed nodes). */
  changed: { added: string[]; changed: string[]; removed: string[] };
  lines: DraftLine[];
  /** §5.9 the cap hit mid-turn: the account it left and the one Tiếp tục resumes on (null = none has room). */
  quota: { from: string; to: string | null } | null;
  /** Saved: the pack it became, Hoàn tác until (epoch ms), `applied` = a project took the new pack (Hoàn tác dimmed). */
  saved: { id: string; name: string; until: number; applied: string | null } | null;
  /** WF15c the old session could not resume after a restart (the next message opens a new one). */
  resumeFailed: boolean;
}

export type WorkflowEngineEvent =
  | { type: 'workflows_changed'; rows: WorkflowRow[] }
  | { type: 'workflow_draft'; draft: DraftView }
  | { type: 'workflow_draft_gone'; draftId: string };
