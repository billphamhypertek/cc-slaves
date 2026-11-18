// v2.5 §6 TK2 the Bộ công cụ list, pure logic (lazy chunk of the Skills & MCP sheet; the wizard step 3 reuses it, G4b):
// the state a row shows, the TK2 summary line, the status line and the row's one action. `needs_login` is derived from
// the `skills_mcp` view (orchestrator ruling 00:05): the toolkit view is pushed only on toolkit changes, so a login or
// logout of a plugin MCP shows here at once only through the MCP catalog.
import type { Key, Tr } from '../../../shared/i18n/core.ts';
import type { McpRowView } from '../../../shared/protocol.ts';
import { below, MIN_GRAPH_VERSION } from '../../../shared/graph.ts';
import type { ToolkitKey, ToolkitRow, ToolkitView } from '../../../shared/toolkit.ts';
import { fmtHm, statLine } from './format.ts';
import { chip, code } from './graph.ts';

/** What a row shows: the engine state, plus `waiting` (running, not the busy row) and `git` (a git cause, TK1-git). */
export type TkShown = 'missing' | 'installed' | 'outdated' | 'disabled' | 'needs_login' | 'running' | 'waiting' | 'failed' | 'git';
export interface TkRowShown { row: ToolkitRow; shown: TkShown; loginIds: string[] }
export type TkMcp = Pick<McpRowView, 'id' | 'oauth'>;
/** `graphUpdate`: the graph tool row's "Cập nhật…" opens GR-upd (§5.6; `toolkit_update` refuses the graph key). */
export type TkAction = 'install' | 'update' | 'graphUpdate' | 'login' | 'retryInstall' | 'retryUpdate';

const GIT_CODES: ReadonlySet<string> = new Set(['git_missing', 'git_license', 'git_error']);

/** The MCP ids of plugin `id` that wait for a login (same test as the engine: OAuth `needsLogin`, `noLogin` has no oauth). */
const loginIdsOf = (id: string, mcp: readonly TkMcp[]): string[] =>
  mcp.filter(m => m.id.startsWith(`plugin:${id}:`) && m.oauth?.needsLogin != null).map(m => m.id);

function shownOf(row: ToolkitRow, busy: ToolkitView['busy'], mcp: readonly TkMcp[] | null): TkRowShown {
  if (row.state === 'running') return { row, shown: row.key === busy ? 'running' : 'waiting', loginIds: [] };
  if (row.state === 'failed') return { row, shown: row.error && GIT_CODES.has(row.error.code) ? 'git' : 'failed', loginIds: [] };
  if (row.kind === 'plugin' && row.id && mcp && (row.state === 'installed' || row.state === 'needs_login')) {
    const ids = loginIdsOf(row.id, mcp);
    return { row, shown: ids.length ? 'needs_login' : 'installed', loginIds: ids };
  }
  return { row, shown: row.state, loginIds: row.state === 'needs_login' ? row.mcpLoginIds : [] };
}

/** Every row as shown; `mcp` = the `skills_mcp` rows (null until that view arrives → the engine's own mark). */
export const shownRows = (view: ToolkitView, mcp: readonly TkMcp[] | null): TkRowShown[] => view.rows.map(r => shownOf(r, view.busy, mcp));

const INSTALLED: ReadonlySet<TkShown> = new Set(['installed', 'outdated', 'disabled', 'needs_login']);
const isInstalled = (s: TkRowShown) => INSTALLED.has(s.shown) || s.row.version !== undefined;

/** TK2 "5 mục · 4 đã cài · 1 chưa cài · 1 có bản mới · 2 cần đăng nhập · kiểm tra lúc 14:02" (a zero part is dropped). */
export function summaryText(tr: Tr, rows: readonly TkRowShown[], checkedAt: number | undefined): string {
  const inst = rows.filter(isInstalled).length;
  const out = rows.filter(s => s.shown === 'outdated').length;
  const login = rows.filter(s => s.shown === 'needs_login').length;
  const n = (key: Key, v: number) => (v ? tr(key, { n: v }) : null);
  return statLine([tr('toolkit.sum.items', { n: rows.length }), n('toolkit.sum.installed', inst), n('toolkit.sum.missing', rows.length - inst),
    n('toolkit.sum.outdated', out), n('toolkit.sum.login', login), checkedAt !== undefined ? tr('toolkit.sum.checked', { t: fmtHm(checkedAt) }) : null]);
}

/** TK1-all: a plugin with no version number (context7) records a commit id → its first 7 characters in brackets. */
export const versionText = (v: string | undefined): string => (v === undefined ? '' : /^[0-9a-f]{12,40}$/.test(v) ? `(${v.slice(0, 7)})` : v);

/** The row's one button (§6 "Nút"): none for installed, disabled, running, waiting and the git causes (the band acts). */
export function rowAction(s: TkRowShown): TkAction | null {
  switch (s.shown) {
    case 'missing': return 'install';
    case 'outdated': return s.row.kind === 'graph' ? 'graphUpdate' : 'update';
    case 'needs_login': return 'login';
    case 'failed': return s.row.version === undefined ? 'retryInstall' : 'retryUpdate';
    default: return null;
  }
}

function errorText(tr: Tr, row: ToolkitRow): string {
  const e = row.error;
  if (!e) return '';
  if (e.code === 'offline') return tr('toolkit.err.offline');
  if (e.code === 'not_found') return tr('toolkit.err.notFound', { id: row.id ?? row.key });
  if (e.code === 'no_claude') return tr('toolkit.err.noClaude');
  return e.line;
}

/** The status cell (§6 TK1-mix / TK1-run / TK2-upd, §5.2 causes); never a bare "Lỗi". */
/** The graph tool below the version cc-slaves needs (TK1-mix "Bản 0.8.1 — cc-slaves cần 0.12.1"). */
const graphOld = (row: ToolkitRow): boolean => row.kind === 'graph' && !!row.version && below(row.version, MIN_GRAPH_VERSION);

/** The status icon + colour of a row: its shown state, except the graph below the min (alert, one line) and a row off for
 *  lanes (grey like a disabled one, no check) — §6.1 mockup TK1-mix. */
export const statusLook = (s: TkRowShown): TkShown | 'graphOld' | 'offLanes' =>
  s.shown === 'outdated' && graphOld(s.row) ? 'graphOld' : s.shown === 'installed' && s.row.offForLanes && !s.row.updated ? 'offLanes' : s.shown;

/** The status line; versions are \u0001-marked (`code`) so they show mono (§6.1 mockup). */
export function statusText(tr: Tr, s: TkRowShown): string {
  const { row } = s;
  const v = row.version === undefined ? '' : code(versionText(row.version));
  switch (s.shown) {
    case 'missing': return tr('toolkit.st.missing');
    case 'running': return tr(row.version === undefined ? 'toolkit.st.installing' : 'toolkit.st.updating');
    case 'waiting': return tr('toolkit.st.waiting');
    case 'git': return tr('toolkit.st.git');
    case 'failed': return errorText(tr, row);
    case 'disabled': return tr('toolkit.st.disabled', { cmd: chip('/plugin') });
    case 'needs_login': return tr('toolkit.st.needsLogin');
    case 'outdated': if (graphOld(row)) return tr('toolkit.st.graphOld', { v: code(row.version!), min: code(MIN_GRAPH_VERSION) });
      return row.latest && row.version ? tr('toolkit.st.outdatedTo', { from: code(row.version), to: code(row.latest) })
      : v ? tr('toolkit.st.outdatedUsing', { v }) : tr('toolkit.st.outdatedBare');
    case 'installed': return !v ? tr('toolkit.st.installedBare') : row.updated ? tr('toolkit.st.updated', { v })
      : row.offForLanes ? tr('toolkit.st.offLanes', { v }) : tr('toolkit.st.installed', { v });
  }
}

/** TK1 (D70): a row the wizard step may tick — only a missing one (a git cause waits for the band, TK1-git). */
export const pickable = (s: TkRowShown): boolean => s.shown === 'missing';

/** The keys "Cài n mục" installs: every pickable row, ticked by default, minus the ones the user unticked; row order. */
export const pickedKeys = (rows: readonly TkRowShown[], unticked: ReadonlySet<ToolkitKey>): ToolkitKey[] =>
  rows.filter(s => pickable(s) && !unticked.has(s.row.key)).map(s => s.row.key);

/** Ruling 00:55 TK1-cmd "Sẽ chạy": the engine's commands of each picked row (`ToolkitRow.commands`), in run order, each once. */
export const installCommands = (rows: readonly TkRowShown[], keys: readonly ToolkitKey[]): string[] =>
  [...new Set(rows.filter(s => keys.includes(s.row.key)).flatMap(s => s.row.commands ?? []))];

/** The wizard step's foot: `pick` (TK1: Quay lại · Để sau · Cài n mục), `run` (TK1-run: Quay lại off · Tiếp), `next` (Quay lại · Tiếp). */
export function stepFoot(rows: readonly TkRowShown[]): 'pick' | 'run' | 'next' {
  if (rows.some(s => s.shown === 'running' || s.shown === 'waiting')) return 'run';
  return rows.some(pickable) ? 'pick' : 'next';
}

/** The muted line of the step: TK1-run "Bấm Tiếp…", TK1-done "Đăng nhập sau…", TK1-all "Máy này đã có đủ n mục." (on top). */
export function stepNote(rows: readonly TkRowShown[]): { k: 'run' } | { k: 'login' } | { k: 'all'; n: number } | null {
  const foot = stepFoot(rows);
  if (foot === 'run') return { k: 'run' };
  if (foot === 'pick') return null;
  if (rows.some(s => s.shown === 'needs_login')) return { k: 'login' };
  return rows.length && rows.every(s => s.shown === 'installed') ? { k: 'all', n: rows.length } : null;
}

/** Ruling 00:27: the last 4 lines of a row's own log (TK1-run), none when the engine sent none. */
export const logTail = (row: ToolkitRow): string[] => (row.log ?? []).slice(-4);
