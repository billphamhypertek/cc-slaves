// v2.5 G5a e2e: a scripted Graph code engine on the page's socket. The e2e engine runs with the graph module off (Z5: no test
// runs the real codebase-memory-mcp), so every `graph_*` command is answered here and never reaches the engine; the
// snapshot gets this `graph` view and every change is pushed as the `graph` event, like the engine's Mac channel.
// G5b: `sm` edits every Skills & MCP view the engine sends (scripted MCP rows / C25 counts), `toolkit` answers `toolkit_*`.
// G6: `tk` pushes a scripted toolkit view, `holdCheck` keeps `toolkit_check` unanswered (TK1-chk) until `release`, `drop` loses
// the engine (refuses reconnects: TK2-lost).
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { GraphImpact, GraphOrphans, GraphProjectView, GraphView } from '../shared/graph.ts';
import type { ClientMsg, Command, McpRowView, ServerMsg, SkillsMcpView } from '../shared/protocol.ts';
import type { ToolkitView } from '../shared/toolkit.ts';

/** The K1-graph mockup's MCP rows (beside the engine's own cc_slaves): context7 + vercel need a login (ⓘ2), the user's
 *  codebase-memory-mcp (17 tools, its file in ~/.local/bin), onedevtool. */
export const mcpRow = (name: string, over: Partial<McpRowView> = {}): McpRowView => ({
  id: `user:${name}`, name, source: 'user', kind: 'stdio', projectId: null, plugin: null, config: { command: 'npx' }, forLanes: true, pending: false,
  unused: null, editable: true, status: 'connected', tools: 38, error: null, lastInit: null, canCheck: true, checking: false, probe: null, log: [], ...over,
});
export const needsLogin = (p: string): McpRowView => mcpRow(`plugin_${p}_${p}`, { id: `plugin:${p}@claude-plugins-official:${p}`, source: 'plugin', plugin: `${p}@claude-plugins-official`,
  kind: 'http', status: 'needs_login', tools: null, editable: false, config: { type: 'http', url: `https://mcp.${p}.test/mcp` },
  oauth: { loggedIn: false, expiresAt: null, refreshedAt: null, needsLogin: { reason: 'no_token', scope: null }, keychainFailed: false, login: null, error: null } });
/** G6 every v2.5 frame at 1440 × 900 and 1024 × 640 (`check` runs at each size); with `E2E_SHOTS=1` the shots go to
 *  .e2e-results/v25-g6/<frame>[-1024][-dark].png, never into docs/. Ends back at 1440 × 900. */
export async function v25Shot(page: Page, frame: string, theme: 'light' | 'dark', check?: (w: number) => Promise<void>): Promise<void> {
  await page.mouse.move(1, 1);
  for (const [w, h] of [[1440, 900], [1024, 640]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    await check?.(w);
    if (process.env.E2E_SHOTS === '1') await page.screenshot({ path: join('.e2e-results', 'v25-g6', `${frame}${w === 1024 ? '-1024' : ''}${theme === 'dark' ? '-dark' : ''}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const MB = 1024 ** 2, GB = 1024 ** 3;
const at = (h: number, m: number, d: number) => new Date(2026, 10, d, h, m).getTime();
const p = (name: string, nodes: number, mb: number, indexedAt: number, lanes: [number, number] = [0, 0]): GraphProjectView =>
  ({ projectId: `p-${name}`, name, on: true, git: true, state: 'ready', nodes, bytes: mb * MB, indexedAt, lanes: { n: lanes[0], bytes: lanes[1] * MB } });

/** §5.6 the pinned one-line install command of tag `v`. */
export const installCmd = (v: string): string =>
  `curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/v${v}/install.sh | CBM_DOWNLOAD_URL=https://github.com/DeusData/codebase-memory-mcp/releases/download/v${v} bash -s -- --skip-config --dir "$HOME/.local/bin"`;

/** The mockup's one data set (§6): 6 projects, 140 indexes · 10,0 GB, 92 orphans · 7,7 GB, 2 skipped, 46 kept. */
export function mockupView(): GraphView {
  return {
    tool: { state: 'ready', version: '0.12.1', latest: '0.12.1', checkedAt: at(14, 2, 18), path: '/Users/po/.local/bin/codebase-memory-mcp',
      indexes: { n: 140, bytes: 10 * GB }, orphans: { n: 92, bytes: 7.7 * GB, skipped: 2 },
      command: installCmd('0.12.1') },
    projects: [p('cc-slaves', 15_899, 101, at(14, 2, 16), [3, 310]), p('hagenta', 153_761, 820, at(13, 40, 16), [2, 410]), p('h-cowork', 48_212, 214, at(9, 15, 16)),
      p('hagent-os', 61_530, 168, at(21, 47, 15)), p('h-ops', 4_306, 25, at(18, 20, 14)),
      { projectId: 'p-aether', name: 'aether', on: true, git: true, state: 'none', lanes: { n: 0, bytes: 0 } }],
  };
}
const IMPACT: GraphImpact = { indexes: { n: 140, bytes: 10 * GB }, lanesRunning: 4, processes: { lanes: 4, sessions: 8, other: 3 } };
export const ORPHANS: GraphOrphans = {
  rows: Array.from({ length: 92 }, (_, i) => ({ root_path: `/Users/po/Works/Projects/hagenta-w${i + 1}`, bytes: Math.round((7.7 * GB) / 92) })),
  bytes: 7.7 * GB, skipped: { n: 2 }, kept: 46,
};

export interface GraphMock {
  view: GraphView;
  /** Every graph command the page sent, in order. */
  sent: Command[];
  /** Change the view and push it (the `graph` event). */
  set(f: (v: GraphView) => void): void;
  /** Change the scripted toolkit view and push it (the `toolkit` event). */
  tk(f: (v: ToolkitView) => void): void;
  /** Answer the held `toolkit_check` commands. */
  release(): void;
  /** Close the socket and refuse reconnects ("Mất kết nối engine"). */
  drop(): void;
}

/** Route the page's engine socket: graph commands answered by the script, the rest to the real engine. */
export async function mockGraph(page: Page, view: GraphView, o: { sm?: (v: SkillsMcpView) => void; toolkit?: ToolkitView; holdCheck?: boolean } = {}): Promise<GraphMock> {
  let live: { send(m: string): void; close(): Promise<void> } | null = null, down = false;
  const held: string[] = [];
  const send = (msg: ServerMsg) => live?.send(JSON.stringify(msg));
  const push = () => send({ type: 'event', event: { type: 'graph', view: m.view } });
  const m: GraphMock = { view, sent: [], set: (f) => { f(m.view); push(); },
    tk: (f) => { f(o.toolkit!); send({ type: 'event', event: { type: 'toolkit', view: o.toolkit! } }); },
    release: () => { for (const id of held.splice(0)) send({ type: 'ack', id, result: o.toolkit }); },
    drop: () => { down = true; void live?.close(); } };
  const later = (ms: number, f: (v: GraphView) => void) => setTimeout(() => m.set(f), ms);
  const proj = (id: string) => m.view.projects.find(x => x.projectId === id)!;
  const answer = (c: Command): unknown => {
    switch (c.cmd) {
      case 'graph_impact': return IMPACT;
      case 'graph_orphans': return ORPHANS;
      case 'graph_index': { const x = proj(c.projectId); Object.assign(x, { state: 'running', startedAt: Date.now() }); break; }
      case 'graph_index_stop': { const x = proj(c.projectId); Object.assign(x, { state: 'ready', startedAt: undefined }); break; }
      case 'graph_toggle': proj(c.projectId).on = c.on; break;
      case 'graph_retry': delete m.view.tool.error; m.view.tool.state = 'ready'; break;
      case 'graph_clean': {
        const total = c.roots.length;
        m.view.tool.clean = { state: 'running', done: 31, total, freedBytes: 0, failed: 0, failedRoots: [] };
        later(1500, v => { v.tool.clean = { state: 'done', done: total, total, freedBytes: 7.7 * GB, failed: 0, failedRoots: [] }; v.tool.indexes = { n: 48, bytes: 2.3 * GB }; v.tool.orphans = { n: 0, bytes: 0, skipped: 2 }; });
        break;
      }
      case 'graph_update': case 'graph_install': {
        const t = m.view.tool, to = t.latest ?? '0.12.1';
        t.state = c.cmd === 'graph_update' ? 'updating' : 'installing';
        t.run = { kind: c.cmd === 'graph_update' ? 'update' : 'install', ...(t.version ? { from: t.version } : {}), to, step: 1, log: [`$ ${t.command ?? ''}`] };
        later(600, v => { v.tool.run = { ...v.tool.run!, step: 2, log: [...v.tool.run!.log, `Downloading codebase-memory-mcp-darwin-arm64.tar.gz (v${to})`, 'Verifying SHA-256 against checksums.txt … ok', 'Installing to ~/.local/bin'] }; });
        later(1800, v => { delete v.tool.run; delete v.tool.failed; Object.assign(v.tool, { state: 'ready', version: to }); if (!v.projects.length) v.projects = mockupView().projects; });
        break;
      }
      default: break;
    }
    return m.view;
  };
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    if (down) { void ws.close(); return; }
    live = ws;
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as ClientMsg;
      if (o.toolkit && msg.type === 'command' && msg.command.cmd.startsWith('toolkit_')) {
        if (o.holdCheck && msg.command.cmd === 'toolkit_check') { held.push(msg.id); return; }
        ws.send(JSON.stringify({ type: 'ack', id: msg.id, result: o.toolkit } satisfies ServerMsg));
        return;
      }
      if (msg.type === 'command' && msg.command.cmd.startsWith('graph_')) {
        m.sent.push(msg.command);
        ws.send(JSON.stringify({ type: 'ack', id: msg.id, result: answer(msg.command) } satisfies ServerMsg));
        if (msg.command.cmd !== 'graph_impact' && msg.command.cmd !== 'graph_orphans') push();
        return;
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as ServerMsg;
      if (msg.type === 'event' && msg.event.type === 'skills_mcp' && o.sm) { o.sm(msg.event.view); ws.send(JSON.stringify(msg)); return; }
      if (msg.type === 'event' && msg.event.type === 'toolkit' && o.toolkit) return;
      if (msg.type !== 'snapshot') { ws.send(raw); return; }
      msg.snapshot.graph = m.view;
      if (o.sm && msg.snapshot.skillsMcp) o.sm(msg.snapshot.skillsMcp);
      if (o.toolkit) msg.snapshot.toolkit = o.toolkit;
      ws.send(JSON.stringify(msg));
    });
  });
  return m;
}
