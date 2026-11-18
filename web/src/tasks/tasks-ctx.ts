// v2.7 §4.3 what every region component of the Tasks tab reads (rail, list, detail, spec card, overview, Tài liệu, Huỷ):
// built once per render by TasksRoot. A type-only module so the regions never import the root (no cycle).
import type { ProjectIssues } from '../../../shared/issues.ts';
import type { AccountView, CardView, Command, LaneView, OrchestratorView } from '../../../shared/protocol.ts';
import type { WorkflowRow } from '../../../shared/workflows.ts';
import type { IssueCmds, TasksUi } from '../lib/issues.ts';
import type { RailSlots, WfDoc } from '../lib/wf-tasks.ts';
import type { StartReq } from '../lib/start.ts';

/** What a Tasks button names of its start (the root adds the project, `direct` and the hop to Deck). */
export type TaskStart = Pick<StartReq, 'kind' | 'path' | 'spec' | 'resume'>;

/** The snapshot parts the regions read beyond issues: the project's lanes (account, quota), accounts, open cards and the
 *  IS16 import notice (`tasksLive`). */
export interface TasksLiveIn {
  lanes: readonly LaneView[]; accounts: readonly AccountView[]; cards: readonly CardView[]; importNotice: number | null;
  /** v2.9 §4.1 the project's workflow id (null = an engine without the library) and the library rows (Mac snapshot);
   *  hf-sp `fallback` = the plugin that gave it Giao thẳng at add, while that plugin is still not installed. */
  wf: { id: string | null; rows: readonly WorkflowRow[]; fallback: string | null };
}
export interface TasksLive extends TasksLiveIn {
  /** the time the lane's account frees room (chờ quota · 15:00); null = unknown */
  quotaAt: (lane: string) => number | null;
}

export interface TasksCtx {
  /** `path` = the project root (absolute): `open_doc` paths and "thư mục gốc" in IS17 */
  project: { id: string; name: string; path: string };
  pi: ProjectIssues;
  ui: TasksUi; setUi: (patch: Partial<TasksUi>) => void;
  cmds: IssueCmds;
  /** IS8c: every button that needs the engine is disabled (Huỷ, Cho làm, + Spec mới, Bắt đầu build) */
  locked: boolean;
  /** R34 (IS13b) the project already runs 3 Thiết kế / Build sessions: + Spec mới / Bắt đầu build / Sửa spec / Bổ sung / Mở phiên locked */
  capFull: boolean;
  /** the project's running orchestrator sessions (Tới phiên vs Mở phiên, session titles) */
  sessions: readonly OrchestratorView[];
  /** §6 IS10 window < 1100 px: no rail, the detail / overview is a 360 overlay, the overview does not show by itself */
  narrow: boolean;
  /** §4.1 to Deck, Đang xem on that orchestrator session when given (+ Spec mới, Bắt đầu build, Sửa spec, Tới phiên) */
  toDeck: (sessionId?: string) => void;
  /** §4.10 to the Code tab (a `.md` / image of Tài liệu, after `requestCodeOpen`) */
  toCode: () => void;
  /** v2.7.1 §4.1 every Tasks control that opens a session (+ Spec mới, Bắt đầu build, Sửa spec, Mở phiên, Bổ sung yêu cầu,
   *  IS17): `direct` = the split button's main part (the step list at once, the defaults), else its ▾ (the start dialog);
   *  either way the web goes to Deck on the new session */
  start: (r: TaskStart, direct: boolean) => void;
  /** IS5b "Huỷ cả hai…": the keys whose IS4 opens at once (the last one is the open issue), bumped per ask */
  ask: { keys: string[]; n: number } | null;
  /** an open popover registers its close: Esc closes it before anything else in the tab */
  setPop: (close: (() => void) | null) => void;
  live: TasksLive;
  /** v2.9 §4.7 the project's workflow: its id, the library, its rev's steps (`cur`), the revs read so far, the rail's
   *  groups / labels (`slots`); `openWorkflows` = the Quy trình screen on that id (null = the library). */
  wf: {
    id: string | null; rows: readonly WorkflowRow[]; cur: WfDoc | null; docs: ReadonlyMap<string, WfDoc>; slots: RailSlots;
    openWorkflows: (id: string | null) => void;
    /** hf-sp the plugin whose absence gave the project Giao thẳng when it was added (one line why), null = no line */
    fallback: string | null;
  };
  /** the toasting `send` (card actions) */
  send: (c: Command) => Promise<unknown>;
  now: number;
}
