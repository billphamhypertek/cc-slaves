// v2.2 §6 the Skills & MCP view (pure): MCP catalog rows (+ last `system/init` per server, K1-local, K7 pending),
// skills + K11 issues + plugin rows, and the C25 issue-count table every number on screen reads (K0, tab badges, K1).
import type { Key } from '../../../shared/i18n/index.ts';
import type {
  IssueCount, McpErrorView, McpLogLineView, McpOAuthView, McpProbeView, McpRowView, McpStatus, PluginRowView, SkillIssueView, SkillRowView, SkillsMcpCounts, SkillsMcpView,
} from '../../../shared/protocol.ts';
import type { Config } from '../config.ts';
import type { CatalogEntry, ProjectRoot } from '../mcp/catalog.ts';
import { probeScope, type ProbeErrorCode, type ProbeResult } from '../mcp/probe.ts';
import type { ProxyError, ProxyLogLine } from '../mcp/proxy-log.ts';
import type { ClaudeJsonRead, LostEntry } from '../mcp/registry.ts';
import type { SkillCatalog, SkillScan } from '../skills/catalog.ts';
import type { McpInitState } from '../stream/parser.ts';
import { isGraphEntry } from '../../../shared/graph.ts';
import { isObj } from '../../../shared/json.ts';

const RED: ReadonlySet<McpStatus> = new Set(['needs_login', 'needs_relogin', 'error']);

/**
 * §6 C25: MCP red = on for lanes and needs login / re-login / error (lanes are missing tools); MCP yellow = on for lanes
 * and connected with 0 tools, or a K7 project entry waiting; skills yellow = every issue that is not info and not
 * "Đã biết"; shared yellow = accounts with a broken shared-config link. Off-for-lanes / unused rows never count.
 */
export function countIssues(i: {
  mcp: readonly Pick<McpRowView, 'name' | 'config' | 'forLanes' | 'pending' | 'status' | 'tools'>[];
  skills: readonly Pick<SkillIssueView, 'level' | 'acked'>[];
  sharedBad: number;
  /** v2.5 §5.3 the graph module is in `error` while the graph is on for ≥ 1 project; absent = no module (no graph line). */
  graphRed?: boolean;
  /** v2.5 §5.7 the graph module is `ready`: the user's `codebase-memory-mcp` row is cc-slaves' own (web K1-graph) and never counts. */
  graphReady?: boolean;
}): SkillsMcpCounts {
  const mcp: IssueCount = { red: 0, yellow: 0 };
  for (const r of i.mcp) {
    if (i.graphReady && isGraphEntry(r.name, r.config)) continue;
    if (r.pending) mcp.yellow++;
    else if (r.forLanes && RED.has(r.status)) mcp.red++;
    else if (r.forLanes && r.status === 'connected' && r.tools === 0) mcp.yellow++;
  }
  const skills: IssueCount = { red: 0, yellow: i.skills.filter((s) => s.level !== 'info' && !s.acked).length };
  const shared: IssueCount = { red: 0, yellow: i.sharedBad };
  const graph: IssueCount | undefined = i.graphRed === undefined ? undefined : { red: i.graphRed ? 1 : 0, yellow: 0 };
  const total = { red: mcp.red + skills.red + shared.red + (graph?.red ?? 0), yellow: mcp.yellow + skills.yellow + shared.yellow };
  return { mcp, skills, shared, ...(graph ? { graph } : {}), total };
}

const INIT_STATUS: Readonly<Record<string, McpStatus>> = { connected: 'connected', 'needs-auth': 'needs_login', failed: 'error' };
const LOG_IN_VIEW = 50;

/** §5.4b / §5.2 every check / proxy error code → its line in the lazy `skillsMcp` namespace. */
const ERR_KEY: Readonly<Record<ProbeErrorCode | ProxyError, Key>> = {
  timeout: 'skillsMcp.mcpErr.timeout', network: 'skillsMcp.mcpErr.network', needs_login: 'skillsMcp.mcpErr.needs_login',
  insufficient_scope: 'skillsMcp.mcpErr.insufficient_scope', endpoint_foreign: 'skillsMcp.mcpErr.endpoint_foreign',
  http: 'skillsMcp.mcpErr.http', rpc: 'skillsMcp.mcpErr.rpc', bad_response: 'skillsMcp.mcpErr.bad_response',
  spawn: 'skillsMcp.mcpErr.spawn', exited: 'skillsMcp.mcpErr.exited', not_allowed: 'skillsMcp.mcpErr.not_allowed',
  unknown_server: 'skillsMcp.mcpErr.unknown_server',
};

/** What the view reads of the §5.4b checks, the OAuth client and the proxy (engine: `ProbeRunner`, `McpOAuth`, `ProxyLog`). */
interface McpLive {
  probes: { result(id: string): ProbeResult | undefined; running(id: string): boolean; queued(id: string): boolean };
  /** §5.3 OAuth state of a remote entry (null: none) — the one source of "needs (re-)login" (K1 / K13 / C25). */
  oauth: (id: string) => McpOAuthView | null;
  log: (id: string) => readonly ProxyLogLine[];
}

/** §5.3 / K13 a login mark wins over init / check: no token → "Cần đăng nhập", a dead / short login → "… lại". */
const OAUTH_STATUS: Readonly<Record<NonNullable<McpOAuthView['needsLogin']>['reason'], McpStatus>> = {
  no_token: 'needs_login', invalid_grant: 'needs_relogin', insufficient_scope: 'needs_relogin',
};

/** §5.4b K1 / K2: state + tool count from the latest of the lane `system/init` and the check; then the OAuth mark. */
function liveState(base: McpStatus | null, init: McpInitState | null, probe: ProbeResult | undefined, oauth: McpOAuthView | null, noLogin: boolean): { status: McpStatus; tools: number | null } {
  let status: McpStatus = base ?? 'unchecked';
  let tools: number | null = null;
  if (base === null) {
    if (probe && (!init || probe.at >= init.at)) { status = probe.state; tools = probe.tools.length; } else if (init) { status = INIT_STATUS[init.state] ?? 'unchecked'; tools = init.tools; }
    if (oauth?.needsLogin) status = OAUTH_STATUS[oauth.needsLogin.reason];
    if (noLogin && (status === 'needs_login' || status === 'needs_relogin')) status = 'error';
  }
  return { status, tools: status === 'connected' ? tools : null };
}

/** §6 K4 "Đăng nhập: Không": a 401 / 403 of that server reads as its own error (wrong key / header), never a login. */
const LOGIN_CODES: ReadonlySet<string> = new Set(['needs_login', 'insufficient_scope']);
const errOf = (code: ProbeErrorCode | ProxyError, detail: string | null, noLogin: boolean): McpErrorView =>
  noLogin && LOGIN_CODES.has(code)
    ? { code, key: 'skillsMcp.mcpErr.unauthorized', fix: 'skillsMcp.mcpFix.unauthorized', detail }
    : { code, key: ERR_KEY[code], fix: `skillsMcp.mcpFix.${code}` satisfies Key, detail };
const probeView = (p: ProbeResult, noLogin: boolean): McpProbeView =>
  ({ state: p.state, tools: [...p.tools], error: p.error ? errOf(p.error.code, p.error.detail, noLogin) : null, at: p.at });

function liveFields(row: McpRowView, init: McpInitState | null, live: McpLive, noLogin: boolean): McpRowView {
  const probe = live.probes.result(row.id);
  const oauth = live.oauth(row.id);
  const st = liveState(row.error ? 'error' : null, init, probe, oauth, noLogin);
  const canCheck = probeScope({ source: row.source, kind: row.kind, forLanes: row.forLanes, unused: row.unused !== null, error: row.error !== null, selfAuthHelper: row.kind !== 'stdio' && row.config.headersHelper !== undefined }).po;
  const log: McpLogLineView[] = live.log(row.id).slice(-LOG_IN_VIEW).map((l) => ({ at: l.at, method: l.method, path: l.path, status: l.status, ms: l.ms, error: l.error ? errOf(l.error, null, noLogin) : null }));
  return {
    ...row, ...st, canCheck, checking: live.probes.running(row.id) || live.probes.queued(row.id), log,
    probe: probe ? probeView(probe, noLogin) : null, ...(oauth ? { oauth } : {}), ...(noLogin ? { noLogin: true as const } : {}),
  };
}

/** The latest init record of a catalog entry: same project for project-bound entries; for user / plugin ones, any
 *  project where no local / project entry of the same name shadows it (§5.1 rank). */
function lastInit(e: CatalogEntry, init: readonly McpInitState[], shadowed: ReadonlySet<string>): McpInitState | null {
  let best: McpInitState | null = null;
  for (const r of init) {
    if (r.name !== e.name) continue;
    if (e.projectId !== undefined ? r.projectId !== e.projectId : shadowed.has(`${r.projectId}\0${r.name}`)) continue;
    if (!best || r.at > best.at) best = r;
  }
  return best;
}

/** §6 C25 F-I1 cc-slaves' own server: always in every lane (never in the catalog), counted like any row shown. */
const ccSlavesRow = (tools: number): McpRowView => ({
  id: 'cc_slaves', name: 'cc_slaves', source: 'user', kind: 'http', projectId: null, plugin: null, config: {}, forLanes: true, pending: false,
  unused: null, editable: false, status: 'connected', tools, error: null, lastInit: null, ...NO_LIVE, builtin: true,
});

function mcpRow(e: CatalogEntry, prefs: Config['mcp'], init: McpInitState | null, live: McpLive): McpRowView {
  return liveFields({
    id: e.id, name: e.name, source: e.source, kind: e.kind, projectId: e.projectId ?? null, plugin: e.plugin ?? null, config: e.config,
    ...(e.sourceFile ? { sourceFile: e.sourceFile } : {}), forLanes: e.forLanes, pending: e.source === 'project' && !prefs.projectOn.includes(e.id) && !prefs.offForLanes.includes(e.id),
    unused: null, editable: e.source === 'user', status: 'unchecked', tools: null, error: e.error ?? null,
    lastInit: init ? { projectId: init.projectId, lane: init.lane, state: init.state, tools: init.tools, toolNames: init.toolNames, at: init.at } : null,
    ...NO_LIVE,
  }, init, live, prefs.noLogin.includes(e.id));
}

const NO_LIVE = { canCheck: false, checking: false, probe: null, log: [] } as const satisfies Partial<McpRowView>;

const kindOf = (c: Record<string, unknown>): McpRowView['kind'] =>
  c.type === 'http' || c.type === 'sse' || c.type === 'ws' ? c.type : typeof c.url === 'string' && c.command === undefined ? 'http' : 'stdio';

/** K1-local: `projects[<path>].mcpServers` of a path that is no added project root (never in a lane; live fields unset). */
export function unusedLocal(json: Record<string, unknown>, roots: readonly Pick<ProjectRoot, 'path'>[]): McpRowView[] {
  const byPath = isObj(json.projects) ? json.projects : {};
  const out: McpRowView[] = [];
  for (const [path, p] of Object.entries(byPath)) {
    if (roots.some((r) => r.path === path) || !isObj(p) || !isObj(p.mcpServers)) continue;
    for (const [name, cfg] of Object.entries(p.mcpServers)) {
      if (!isObj(cfg)) continue;
      out.push({
        id: `local:~${path}:${name}`, name, source: 'local', kind: kindOf(cfg), projectId: null, plugin: null, config: cfg,
        forLanes: false, pending: false, unused: { path }, editable: false, status: 'unchecked', tools: null, error: null, lastInit: null, ...NO_LIVE, log: [],
      });
    }
  }
  return out;
}

function mcpRows(i: ViewInput, json: Record<string, unknown> | null): McpRowView[] {
  const { catalog, config: cfg, init, roots } = i;
  const shadowed = new Set(catalog.filter((e) => e.projectId !== undefined && e.source !== 'plugin' && e.forLanes).map((e) => `${e.projectId}\0${e.name}`));
  return [ccSlavesRow(i.ccTools), ...catalog.map((e) => mcpRow(e, cfg.mcp, lastInit(e, init, shadowed), i)), ...(json ? unusedLocal(json, roots).map((r) => liveFields(r, null, i, false)) : [])];
}

function skillRows(cat: SkillCatalog, scan: SkillScan, cfg: Config): SkillRowView[] {
  const links = new Map(scan.entries.map((e) => [e.path, e.link?.target ?? null]));
  const off = new Set(cfg.skills.offForLanes);
  const pluginsOff = new Set(cfg.plugins.offForLanes);
  return cat.skills.map((s) => {
    const id = s.scope === 'user' ? `user:${s.name}` : `${s.scope}:${s.owner ?? ''}:${s.name}`;
    return {
      id, scope: s.scope, owner: s.owner, dir: s.dir, path: s.path, name: s.name, description: s.description, shadowed: s.shadowed,
      link: links.get(s.path) ?? null, forLanes: s.scope === 'plugin' ? !pluginsOff.has(s.owner ?? '') : !off.has(id),
    };
  });
}

export interface ViewInput extends McpLive {
  catalog: readonly CatalogEntry[];
  roots: readonly ProjectRoot[];
  config: Config;
  init: readonly McpInitState[];
  claudeJson: ClaudeJsonRead;
  claudeJsonPath: string;
  rev: string;
  /** Plugins whose skills / servers can reach a lane (enabled user plugins, project-scoped ones of an added root). */
  plugins: readonly string[];
  skills: { catalog: SkillCatalog; scan: SkillScan } | null;
  sharedBad: number;
  graphRed?: boolean;
  graphReady?: boolean;
  claudeFound: boolean;
  install: string;
  lost: readonly LostEntry[];
  /** Tools the `cc_slaves` server gives a lane (§6 F-I1 its row's tool count). */
  ccTools: number;
}

export function skillsMcpView(i: ViewInput): SkillsMcpView {
  const rows = mcpRows(i, i.claudeJson.ok ? i.claudeJson.json : null);
  const sRows = i.skills ? skillRows(i.skills.catalog, i.skills.scan, i.config) : [];
  const issues: SkillIssueView[] = (i.skills?.catalog.issues ?? []).map((x) => ({
    id: x.id, code: x.code, level: x.level, ackable: x.ackable, acked: x.acked, path: x.path, dir: x.dir, project: x.project, ...(x.app ? { app: x.app } : {}),
  }));
  const pluginsOff = new Set(i.config.plugins.offForLanes);
  const plugins: PluginRowView[] = i.plugins.map((key) => ({
    key, skills: sRows.filter((s) => s.scope === 'plugin' && s.owner === key).length,
    servers: i.catalog.filter((e) => e.plugin === key).length, forLanes: !pluginsOff.has(key),
  }));
  return {
    mcp: { rows, servers: rows.length, forLanes: rows.filter((r) => r.forLanes).length, tools: rows.reduce((n, r) => n + (r.forLanes ? r.tools ?? 0 : 0), 0) },
    skills: { rows: sRows, issues, plugins, descTokens: i.skills?.catalog.descTokens ?? 0 },
    counts: countIssues({
      mcp: rows, skills: issues, sharedBad: i.sharedBad, ...(i.graphRed === undefined ? {} : { graphRed: i.graphRed }), graphReady: i.graphReady === true,
    }),
    claudeJson: { ok: i.claudeJson.ok, line: i.claudeJson.ok ? null : i.claudeJson.line, rev: i.rev, path: i.claudeJsonPath },
    claude: { found: i.claudeFound, install: i.install },
    lost: [...i.lost],
  };
}
