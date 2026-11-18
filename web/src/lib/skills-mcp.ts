// v2.2 §6 K0 (first paint): the C25 numbers → tab and the hover line. The sheet's own logic (lazy chunk): skills-mcp-sheet.ts.
// Every number on screen comes from the view's `counts` (C25).
import type { Tr } from '../../../shared/i18n/core.ts';
import type { McpRowView, SkillsMcpCounts } from '../../../shared/protocol.ts';

export type SmTab = 'mcp' | 'skills' | 'toolkit' | 'graph' | 'shared';
/** The tabs with C25 numbers (v2.5 §7: the Bộ công cụ tab has none; Graph code: `counts.graph`, red only, §5.8). */
type IssueTab = Exclude<SmTab, 'toolkit'>;
export type IssueLevel = 'red' | 'yellow';
/** The open sheet: its tab, `add` = open K4 at once (⌘K "Thêm MCP…"), `login` = open K3 for that server id (K13, ⌘K). */
export interface SmOpen { tab: SmTab; add?: boolean; login?: string }
const TABS: readonly IssueTab[] = ['mcp', 'skills', 'graph', 'shared']; // the sheet's tab order

/** §6 C25 / K0: a red / yellow number opens the tab holding the first issue of that level (none → MCP, C17; v2.5 GR-k0 only
 *  the graph → Graph code). */
export const firstIssueTab = (c: SkillsMcpCounts, level: IssueLevel): IssueTab => TABS.find(t => (c[t]?.[level] ?? 0) > 0) ?? 'mcp';

/** §6 K0 hover: "Skills & MCP · 2 MCP cần đăng nhập / lỗi · 4 skill lỗi · …" (the C25 numbers, one part per tab / level). */
export function k0Title(tr: Tr, c: SkillsMcpCounts): string {
  const parts = [
    c.mcp.red ? tr('topbar.sm.mcpRed', { n: c.mcp.red }) : '', c.mcp.yellow ? tr('topbar.sm.mcpYellow', { n: c.mcp.yellow }) : '',
    c.skills.yellow + c.skills.red ? tr('topbar.sm.skills', { n: c.skills.yellow + c.skills.red }) : '',
    c.graph?.red ? tr('topbar.sm.graph') : '',
    c.shared.yellow + c.shared.red ? tr('topbar.sm.shared', { n: c.shared.yellow + c.shared.red }) : '',
  ].filter(Boolean);
  return [tr('topbar.sm.label'), ...parts].join(' · ');
}

/** §6 K0-c F-M1 a number's own hover: one line per tab with issues of that level, then the tab a click opens. */
export function k0LevelTitle(tr: Tr, c: SkillsMcpCounts, level: IssueLevel): string {
  const lines = [
    c.mcp[level] ? tr(level === 'red' ? 'topbar.sm.mcpRed' : 'topbar.sm.mcpYellow', { n: c.mcp[level] }) : '',
    c.skills[level] ? tr('topbar.sm.skills', { n: c.skills[level] }) : '',
    c.graph?.[level] ? tr('topbar.sm.graph') : '', // v2.5 GR-k0
    c.shared[level] ? tr('topbar.sm.shared', { n: c.shared[level] }) : '',
  ].filter(Boolean);
  return [...lines, tr('topbar.sm.open', { tab: tr(`topbar.sm.tab.${firstIssueTab(c, level)}`) })].join('\n');
}

/** §6 ⌘K "Đăng nhập MCP…": the first remote server that needs a (new) login. */
export const firstLoginId = (rows: readonly Pick<McpRowView, 'id' | 'status' | 'oauth'>[]): string | undefined =>
  rows.find(r => r.oauth !== undefined && (r.status === 'needs_login' || r.status === 'needs_relogin'))?.id;
