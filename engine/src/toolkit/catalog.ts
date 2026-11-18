// v2.5 §5.1 the Bộ công cụ catalog: pure data, one element per item (a new item = a new element). The "what it adds"
// line and the size hint are catalog text (`toolkit.item.<key>.*`), never computed at run time.
import type { ToolkitKey } from '../../../shared/toolkit.ts';

export interface PluginItem {
  key: Exclude<ToolkitKey, 'graph'>;
  kind: 'plugin';
  /** Always `<name>@<marketplace>` (research §1.1 bare-name trap). */
  id: string;
  marketplace: { name: string; repo: string };
  /** The plugin's MCP servers that need a login after install (their MCP id: `plugin:<id>:<server>`). */
  mcpLogin: readonly string[];
}

/** §5.3 the graph tool (latest GitHub release of `DeusData/codebase-memory-mcp`); installed by the `graph_install` flow. */
interface GraphItem { key: 'graph'; kind: 'graph' }

export type ToolkitItem = PluginItem | GraphItem;

const OFFICIAL = { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official' } as const;

export const TOOLKIT: readonly ToolkitItem[] = [
  { key: 'superpowers', kind: 'plugin', id: 'superpowers@claude-plugins-official', marketplace: OFFICIAL, mcpLogin: [] },
  { key: 'ui-ux-pro-max', kind: 'plugin', id: 'ui-ux-pro-max@ui-ux-pro-max-skill', marketplace: { name: 'ui-ux-pro-max-skill', repo: 'nextlevelbuilder/ui-ux-pro-max-skill' }, mcpLogin: [] },
  { key: 'context7', kind: 'plugin', id: 'context7@claude-plugins-official', marketplace: OFFICIAL, mcpLogin: ['context7'] },
  { key: 'vercel', kind: 'plugin', id: 'vercel@claude-plugins-official', marketplace: OFFICIAL, mcpLogin: ['vercel'] },
  { key: 'graph', kind: 'graph' },
];

export const PLUGIN_ITEMS: readonly PluginItem[] = TOOLKIT.filter((i): i is PluginItem => i.kind === 'plugin');
