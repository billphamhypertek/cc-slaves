// v2.2 §6 Skills & MCP sheet logic (lazy chunk only): K1 groups, K2 masking, K4 paste / form parsing, the "Sẽ chạy:"
// previews (K4, K5) and K6 "lanes in use".
import { isGraphEntry, type GraphToolState } from '../../../shared/graph.ts';
import type { LaneView, McpRowView, McpStatus, ProjectView } from '../../../shared/protocol.ts';

import type { Key, Params } from '../../../shared/i18n/core.ts';
import type { IssueLevel } from './skills-mcp.ts';
import { isObj, jsonErrorAt } from '../../../shared/json.ts';
const RED: ReadonlySet<McpStatus> = new Set(['needs_login', 'needs_relogin', 'error']);
/** §6 C25 one row's level (same rule as the engine's `countIssues`): only rows a lane uses (or a K7 entry) count. */
export function rowIssue(r: Pick<McpRowView, 'forLanes' | 'pending' | 'status' | 'tools'>): IssueLevel | null {
  if (r.pending) return 'yellow';
  if (!r.forLanes) return null;
  if (RED.has(r.status)) return 'red';
  return r.status === 'connected' && r.tools === 0 ? 'yellow' : null;
}

/** K1 / K2 the row's buttons: login / logout read `oauth` (§5.3), "Kiểm tra" reads `canCheck` (§5.4b C22). `inline` = the one
 *  button on the row, always a plain button (v2.5 Z20). */
export function rowActs(r: Pick<McpRowView, 'unused' | 'status' | 'canCheck' | 'oauth'>): { inline: 'login' | 'check' | null; check: boolean; login: boolean; logout: boolean } {
  const login = r.oauth !== undefined;
  const inline = r.unused ? null : login && (r.status === 'needs_login' || r.status === 'needs_relogin') ? 'login'
    : r.canCheck && (r.status === 'error' || r.status === 'unchecked') ? 'check' : null;
  return { inline, check: r.canCheck, login, logout: r.oauth?.loggedIn === true };
}

/** v2.5 §5.7 K1-graph: while the graph module is `ready` the user's own `codebase-memory-mcp` entry is cc-slaves' (locked, its
 *  switch lives in the Graph code tab); in any other state it is an ordinary user row (v2.2). */
export const graphLocked = (r: Pick<McpRowView, 'name' | 'config'>, graph: GraphToolState | undefined): boolean =>
  graph === 'ready' && isGraphEntry(r.name, r.config);

export interface McpGroups { review: McpRowView[]; used: McpRowView[]; off: McpRowView[]; unused: McpRowView[] }
/** §6 K1 Cần xem (K7 pending first) → Dùng cho lane → Tắt cho lane → Không dùng trong lane (K1-local). A K1-graph row is in
 *  Dùng cho lane (`mcp.offForLanes` is not read for it, §5.7), right after `cc_slaves`. */
export function mcpGroups(rows: readonly McpRowView[], graph?: GraphToolState): McpGroups {
  const g: McpGroups = { review: [], used: [], off: [], unused: [] };
  for (const r of rows) {
    if (graphLocked(r, graph)) g.used.push(r);
    else if (r.unused) g.unused.push(r);
    else if (rowIssue(r)) g.review.push(r);
    else (r.forLanes ? g.used : g.off).push(r);
  }
  g.review.sort((a, b) => Number(b.pending) - Number(a.pending));
  const rank = (r: McpRowView) => (r.builtin ? 0 : graphLocked(r, graph) ? 1 : 2); // cc-slaves' own rows first (K1-graph mockup)
  g.used.sort((a, b) => rank(a) - rank(b));
  return g;
}

const MASK = '••••';
const cred = (v: unknown) => (typeof v === 'string' ? v.replace(/(:\/\/[^/:@\s]+:)[^@/\s]+@/g, `$1${MASK}@`) : v);
/** §6 K2 / K4 / K7: env and header values are secrets → "••••"; so is a password inside a URL (args, url). */
export function maskConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg, ...(Array.isArray(cfg.args) ? { args: cfg.args.map(cred) } : {}), ...('url' in cfg ? { url: cred(cfg.url) } : {}) };
  for (const k of ['env', 'headers'] as const) {
    const v = cfg[k];
    if (isObj(v)) out[k] = Object.fromEntries(Object.keys(v).map(n => [n, MASK]));
  }
  return out;
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** §6 K4 "Sẽ chạy:" the `claude mcp add-json` line, secrets masked. */
export const addJsonCmd = (name: string, cfg: Record<string, unknown>): string => `claude mcp add-json -s user ${name} ${q(JSON.stringify(maskConfig(cfg)))}`;

export interface EditPlan { cmds: [string, string]; remote: boolean; urlChanged: boolean }
/** §6 K5: remove + add-json; a remote entry warns the terminal re-login; a changed URL warns the login is dropped. */
export function editPlan(name: string, to: string, before: Record<string, unknown>, after: Record<string, unknown>): EditPlan {
  const remote = typeof after.url === 'string';
  return { cmds: [`claude mcp remove -s user ${name}`, addJsonCmd(to, after)], remote, urlChanged: remote && after.url !== before.url };
}

type PasteErr = 'empty' | 'badJson' | 'needName' | 'badName' | 'nameTaken' | 'badEntry' | 'badUrl';
export type Paste = { ok: true; servers: { name: string; config: Record<string, unknown> }[] } | { ok: false; err: PasteErr; name?: string; line?: number; col?: number };
const NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const isEntry = (v: Record<string, unknown>) => typeof v.command === 'string' || typeof v.url === 'string';

/** §6 K4 / §4.4 the checks before anything is written: name, entry shape, http(s) URL, name not taken. */
export function checkServer(name: string, cfg: Record<string, unknown>, taken: readonly string[]): Paste {
  if (!name) return { ok: false, err: 'needName' };
  if (!NAME.test(name)) return { ok: false, err: 'badName', name };
  if (taken.includes(name)) return { ok: false, err: 'nameTaken', name };
  if (!isEntry(cfg)) return { ok: false, err: 'badEntry', name };
  if (typeof cfg.url === 'string' && !/^https?:\/\//.test(cfg.url)) return { ok: false, err: 'badUrl', name };
  return { ok: true, servers: [{ name, config: cfg }] };
}

/** §6 K4 Dán JSON: `{"mcpServers":{…}}`, `{"name":{…}}` or one entry (its name from the field). */
export function parsePaste(text: string, name: string, taken: readonly string[]): Paste {
  if (!text.trim()) return { ok: false, err: 'empty' };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, err: 'badJson', ...jsonErrorAt(text) }; }
  if (!isObj(v)) return { ok: false, err: 'badJson', line: 1, col: 1 };
  if (isEntry(v)) return checkServer(name.trim(), v, taken);
  const map = isObj(v.mcpServers) ? v.mcpServers : v;
  const servers: { name: string; config: Record<string, unknown> }[] = [];
  for (const [n, cfg] of Object.entries(map)) {
    const r = checkServer(n, isObj(cfg) ? cfg : {}, taken);
    if (!r.ok) return r;
    servers.push(...r.servers);
  }
  return servers.length ? { ok: true, servers } : { ok: false, err: 'empty' };
}

/** K4 "Đăng nhập": Tự động (DCR) / Không (config `mcp.noLogin`) / Client ID (entry `oauth.clientId` + optional secret). */
export type LoginMode = 'auto' | 'none' | 'client';
export interface FormDraft {
  kind: 'local' | 'remote'; command: string; args: string; env: string; url: string; headers: string;
  login: LoginMode; clientId: string; clientSecret: string;
  /** The entry's other `oauth` keys (e.g. `callbackPort`), written back as they were. */
  oauthKeep: Record<string, unknown>;
}
const pairs = (text: string, sep: string): Record<string, string> | null => {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : null;
};
/** §6 K4 Điền form → the entry: local = command + args (space separated) + `KEY=value` env; remote = http URL + `Name: value` headers. */
export function formConfig(f: FormDraft): Record<string, unknown> {
  if (f.kind === 'remote') {
    const headers = pairs(f.headers, ':');
    const clientId = f.login === 'client' ? f.clientId.trim() : '';
    const oauth = f.login === 'none' ? {} : { ...f.oauthKeep, ...(clientId ? { clientId } : {}) };
    return { type: 'http', url: f.url.trim(), ...(headers ? { headers } : {}), ...(Object.keys(oauth).length ? { oauth } : {}) };
  }
  const args = f.args.split(/\s+/).filter(Boolean), env = pairs(f.env, '=');
  return { command: f.command.trim(), ...(args.length ? { args } : {}), ...(env ? { env } : {}) };
}
/** §6 K5 the form filled from an entry (inverse of `formConfig`); `noLogin` = the row's "Đăng nhập: Không". */
export function draftOf(cfg: Record<string, unknown>, noLogin: boolean): FormDraft {
  const lines = (v: unknown, sep: string) => (isObj(v) ? Object.entries(v).map(([k, x]) => `${k}${sep}${String(x)}`).join('\n') : '');
  const { clientId, ...oauthKeep } = isObj(cfg.oauth) ? cfg.oauth : {};
  const cid = typeof clientId === 'string' ? clientId : '';
  return {
    kind: typeof cfg.url === 'string' ? 'remote' : 'local', command: typeof cfg.command === 'string' ? cfg.command : '',
    args: Array.isArray(cfg.args) ? cfg.args.join(' ') : '', env: lines(cfg.env, '='), url: typeof cfg.url === 'string' ? cfg.url : '',
    headers: lines(cfg.headers, ': '), login: noLogin ? 'none' : cid ? 'client' : 'auto', clientId: cid, clientSecret: '', oauthKeep,
  };
}

type Server = { name: string; config: Record<string, unknown> };
/** K4 the distinct commands of the local servers (looked up on PATH by the engine, `mcp_which`). */
export const localCommands = (servers: readonly Server[]): string[] =>
  [...new Set(servers.flatMap(s => (typeof s.config.command === 'string' && s.config.command ? [s.config.command] : [])))];

/** §6 K4 the green check line ("1 server: playwright · cục bộ · npx có trên PATH (…) · tên chưa có"; the form drops the
 *  server count and kind) + the commands not on PATH (their own warning). `paths`: command → found path, null = not found,
 *  absent = not looked up yet. `editName`: K5 the edited entry's name — kept unchanged → "giữ tên", never "tên chưa có" (R-M3). */
export function checkParts(servers: readonly Server[], form: boolean, paths: Readonly<Record<string, string | null>>, editName: string | null): { parts: { key: Key; params?: Params }[]; missing: string[] } {
  const parts: { key: Key; params?: Params }[] = [];
  const local = localCommands(servers);
  const schemes = [...new Set(servers.flatMap(s => (typeof s.config.url === 'string' ? [s.config.url.split(':')[0]!] : [])))];
  if (!form) {
    parts.push({ key: 'skillsMcp.k4.ok', params: { n: servers.length, names: servers.map(s => s.name).join(', ') } });
    if (local.length) parts.push({ key: 'skillsMcp.k4.ok.local' });
    if (schemes.length) parts.push({ key: 'skillsMcp.k4.ok.remote' });
  }
  for (const cmd of local) { const p = paths[cmd]; if (p) parts.push({ key: 'skillsMcp.k4.ok.onPath', params: { cmd, path: p } }); }
  if (form) for (const scheme of schemes) parts.push({ key: 'skillsMcp.k4.ok.url', params: { scheme } });
  parts.push({ key: servers.every(s => s.name === editName) ? 'skillsMcp.k4.ok.keep' : 'skillsMcp.k4.ok.free' });
  return { parts, missing: local.filter(c => paths[c] === null) };
}

/** §6 K6 "Lane D2, B3 đang dùng": live lanes that get this server (a project-bound one: only its project's lanes). */
export function lanesUsing(r: Pick<McpRowView, 'forLanes' | 'projectId'>, lanes: readonly LaneView[]): string[] {
  if (!r.forLanes) return [];
  return lanes.filter(l => l.state !== 'stopped' && l.state !== 'done' && (r.projectId === null || l.projectId === r.projectId)).map(l => l.name);
}

/** §6 K1 the row's display name (a plugin server without its `plugin_<p>_` prefix). */
export const mcpShort = (r: Pick<McpRowView, 'plugin' | 'name'>) => (r.plugin ? r.name.replace(/^plugin_[^_]+_/, '') : r.name);

/** The file a row comes from ("Mở file nguồn"): project → its `.mcp.json`, plugin → the file declaring it (K1-src), user / local → `~/.claude.json`; cc_slaves: none. */
export function rowSourcePath(r: Pick<McpRowView, 'source' | 'projectId' | 'sourceFile' | 'builtin'>, projects: readonly Pick<ProjectView, 'id' | 'path'>[], claudeJson: string): string | null {
  if (r.builtin) return null;
  if (r.source === 'project') { const p = projects.find(x => x.id === r.projectId); return p ? `${p.path}/.mcp.json` : null; }
  return r.source === 'plugin' ? r.sourceFile ?? null : claudeJson;
}

export type MenuItem = 'login' | 'check' | 'edit' | 'logout' | 'log' | 'open' | 'remove' | 'pluginNote';
/** §6 K1-menu / K1-src the "⋯" items in order: a needed login first; "Xem log" for every proxied (non-stdio) row a lane uses —
 *  the log is the proxy's (orchestrator ruling: stdio servers have none, so no empty "Xem log"); plugins end on the
 *  disabled "Sửa / xoá trong plugin" note (K3e: never "Sửa"). `login` = "Đăng nhập lại" once logged in. */
export function rowMenu(r: Pick<McpRowView, 'unused' | 'status' | 'canCheck' | 'oauth' | 'editable' | 'source' | 'builtin' | 'kind'>, path: string | null): MenuItem[] {
  if (r.builtin) return [];
  const a = rowActs(r);
  const first = a.login && !a.logout;
  const items: (MenuItem | false)[] = [
    first && 'login', a.check && 'check', r.editable && 'edit', a.login && !first && 'login', a.logout && 'logout',
    !r.unused && r.kind !== 'stdio' && 'log', path !== null && 'open', r.editable && 'remove', r.source === 'plugin' && 'pluginNote',
  ];
  return items.filter((x): x is MenuItem => x !== false);
}
