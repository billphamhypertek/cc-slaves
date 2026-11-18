// v2.5 §5.8 the Bộ công cụ (toolkit) view and commands. Mac channel only: no toolkit command is in REMOTE_ALLOWED and
// the `toolkit` event never reaches a remote connection. git comes from `SetupStatus.git` (R3), never repeated here.

export type ToolkitKey = 'superpowers' | 'ui-ux-pro-max' | 'context7' | 'vercel' | 'graph';

/** §5.2 one row's state (`needs_login`: one of its plugin MCP servers is `needs_login` / `needs_relogin`). */
type ToolkitState = 'missing' | 'installed' | 'outdated' | 'disabled' | 'needs_login' | 'running' | 'failed';

/** §5.2 "Nguyên nhân lỗi": the UI picks the text by `code`; `line` = the first line of the CLI's message (or git's). */
export type ToolkitErrorCode = 'git_missing' | 'git_license' | 'git_error' | 'offline' | 'not_found' | 'no_claude' | 'unknown';

export interface ToolkitRow {
  key: ToolkitKey;
  kind: 'plugin' | 'graph';
  /** Plugins: `<name>@<marketplace>`. */
  id?: string;
  state: ToolkitState;
  /** The installed version (`installed_plugins.json` user entry). */
  version?: string;
  /** `outdated` and the catalog names the new version (today: only ui-ux-pro-max). */
  latest?: string;
  /** `plugins.offForLanes` (tab Skills): still `installed`, the row adds "tắt cho lane". */
  offForLanes?: true;
  /** The MCP ids (`plugin:<id>:<server>`) that wait for a login. */
  mcpLoginIds: string[];
  error?: { code: ToolkitErrorCode; line: string };
  /** Ruling 00:27: the last 4 lines of this row's own install / update output (TK1-run, TK1-fail "Xem log"). */
  log?: string[];
  /** Ruling 00:55 TK1-cmd "Sẽ chạy": the commands an install of this row runs, in order (only while it is missing). */
  commands?: string[];
  /** The last `toolkit_update` of this row updated it: "Đã cập nhật <version> · áp dụng từ lần chạy sau của mỗi lane". */
  updated?: true;
}

export interface ToolkitView {
  rows: ToolkitRow[];
  /** epoch ms of the last finished `toolkit_check`. */
  checkedAt?: number;
  checkError?: { code: 'offline' | 'unknown'; line: string };
  /** The row whose `claude plugin` step is running. */
  busy?: ToolkitKey;
}

/** `toolkit_check` ack = ToolkitView; `force` = "Kiểm tra" (else a check < 60 s old is reused). `toolkit_install` /
 *  `toolkit_update` ack = ToolkitView with the rows `running`; progress and the result come as `toolkit` events. */
export type ToolkitCommand =
  | { cmd: 'toolkit_check'; force?: boolean }
  | { cmd: 'toolkit_install'; keys: ToolkitKey[] }
  | { cmd: 'toolkit_update'; key: ToolkitKey };

export type ToolkitEngineEvent = { type: 'toolkit'; view: ToolkitView };
