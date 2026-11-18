// v2.2 §5.1 MCP catalog: every MCP server the PO configured for Claude Code (user / local / project / plugin), with a
// scoped id, and the per-session set a lane or orchestrator gets (`--strict-mcp-config`, one file). Sources are read
// from disk once and cached; a source-file change rebuilds them after a 1 s debounce (fs watch).
import { existsSync, readFileSync, realpathSync, statSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GRAPH_NAME, isGraphEntry } from '../../../shared/graph.ts';
import { isObj } from '../../../shared/json.ts';

type McpServers = Record<string, unknown>;
type McpSource = 'user' | 'local' | 'project' | 'plugin';
type McpKind = 'stdio' | 'http' | 'sse' | 'ws';

export interface CatalogEntry {
  /** §5.1 "Định danh": `user:<n>`, `local:<projectId>:<n>`, `project:<projectId>:<n>`, `plugin:<plugin>@<mkt>:<server>`. */
  id: string;
  /** The entry name in the session MCP file (Claude Code's own name, `plugin_<plugin>_<server>` for plugins, §3-3). */
  name: string;
  source: McpSource;
  kind: McpKind;
  /** The entry as written into a session file (plugin variables expanded). */
  config: Record<string, unknown>;
  /** Goes into the lanes it applies to (all projects, or `projectId` only). */
  forLanes: boolean;
  projectId?: string;
  /** `<plugin>@<marketplace>` for plugin entries. */
  plugin?: string;
  /**
   * C20: a `${CLAUDE_PLUGIN_*}` variable the catalog cannot expand → the server never enters a lane. §5.3 `bad_name`:
   * the id holds a CR / LF / NUL (`name` = the entry name, escaped) → never in a lane, never a login (Keychain line) target.
   */
  error?: { code: 'plugin_var' | 'bad_name'; name: string };
  /** Plugin entries: the file declaring the server (K1-src / K3e "Mở file nguồn"). */
  sourceFile?: string;
}

export interface ProjectRoot { id: string; path: string }

/** One installed plugin (`installed_plugins.json` entry) with the MCP servers its directory declares. */
export interface PluginSource {
  key: string;
  installPath: string;
  scope: 'user' | 'project';
  projectPath?: string;
  /** `enabledPlugins[key] === true` in `~/.claude/settings.json`. */
  enabled: boolean;
  servers: Record<string, unknown>;
  /** The file `servers` was read from (`.mcp.json`, `plugin.json` or the file it names); K1-src "Mở file nguồn". */
  file?: string;
}

export interface CatalogSources {
  /** Parsed `~/.claude.json` (anything; wrong shapes read as empty). */
  claudeJson: unknown;
  /** Parsed `<project root>/.mcp.json` by project id. */
  projectMcp: Record<string, unknown>;
  plugins: PluginSource[];
}

/** cc-slaves' own switches (`config.json`, §5.4): `mcp.offForLanes`, `mcp.projectOn`, `plugins.offForLanes`. */
export interface CatalogPrefs { offForLanes: readonly string[]; projectOn: readonly string[]; pluginsOff: readonly string[] }

export interface SessionMcp { servers: McpServers; mcpIds: ReadonlySet<string> }

/** v2.5 §5.7 the graph of one session: `on` = the project's Lane switch while the module manages the tool; null = not managed. */
export type SessionGraph = { on: boolean } | null;

const objAt = (v: unknown, k: string): Record<string, unknown> => (isObj(v) && isObj(v[k]) ? v[k] : {});

function kindOf(cfg: Record<string, unknown>): McpKind {
  const t = cfg.type;
  if (t === 'http' || t === 'sse' || t === 'ws') return t;
  if (t === undefined && typeof cfg.url === 'string' && cfg.command === undefined) return 'http';
  return 'stdio';
}

/** §5.3 ids from files cc-slaves does not own must never carry a `security -i` line break. */
const CONTROL = /[\r\n\0]/;

const PLUGIN_VAR = /\$\{(CLAUDE_PLUGIN_[A-Za-z0-9_]*)\}/g;

/** Deep-expands `${CLAUDE_PLUGIN_ROOT}` in every string; reports the first other `${CLAUDE_PLUGIN_*}` it meets. */
function expandPlugin(v: unknown, root: string, bad: { name?: string }): unknown {
  if (typeof v === 'string') {
    return v.replace(PLUGIN_VAR, (m, name: string) => {
      if (name === 'CLAUDE_PLUGIN_ROOT') return root;
      bad.name ??= name;
      return m;
    });
  }
  if (Array.isArray(v)) return v.map((x) => expandPlugin(x, root, bad));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandPlugin(x, root, bad)]));
  return v;
}

/** The pure catalog over already-read sources. Order: user, local, project, plugin (stable within each). */
export function buildCatalog(src: CatalogSources, projects: readonly ProjectRoot[], prefs: CatalogPrefs): CatalogEntry[] {
  const off = new Set(prefs.offForLanes);
  const on = new Set(prefs.projectOn);
  const pluginsOff = new Set(prefs.pluginsOff);
  const out: CatalogEntry[] = [];
  const add = (e: Omit<CatalogEntry, 'kind' | 'forLanes'>, defaultOn: boolean) => {
    if (CONTROL.test(e.id)) e = { ...e, error: { code: 'bad_name', name: JSON.stringify(e.name).slice(1, -1) } };
    out.push({ ...e, kind: kindOf(e.config), forLanes: !e.error && defaultOn && !off.has(e.id) });
  };
  for (const [name, cfg] of Object.entries(objAt(src.claudeJson, 'mcpServers'))) {
    if (isObj(cfg)) add({ id: `user:${name}`, name, source: 'user', config: cfg }, true);
  }
  const byPath = objAt(src.claudeJson, 'projects');
  for (const p of projects) {
    for (const [name, cfg] of Object.entries(objAt(byPath[p.path], 'mcpServers'))) {
      if (isObj(cfg)) add({ id: `local:${p.id}:${name}`, name, source: 'local', projectId: p.id, config: cfg }, true);
    }
  }
  for (const p of projects) {
    for (const [name, cfg] of Object.entries(objAt(src.projectMcp[p.id], 'mcpServers'))) {
      const id = `project:${p.id}:${name}`;
      if (isObj(cfg)) add({ id, name, source: 'project', projectId: p.id, config: cfg }, on.has(id));
    }
  }
  for (const pl of src.plugins) {
    const project = pl.scope === 'project' ? projects.find((p) => p.path === pl.projectPath) : undefined;
    if (pl.scope === 'user' ? !pl.enabled : !project) continue;
    const at = pl.key.lastIndexOf('@');
    const plugin = at > 0 ? pl.key.slice(0, at) : pl.key;
    for (const [server, raw] of Object.entries(pl.servers)) {
      if (!isObj(raw)) continue;
      const bad: { name?: string } = {};
      const config = expandPlugin(raw, pl.installPath, bad) as Record<string, unknown>;
      add({
        id: `plugin:${pl.key}:${server}`, name: `plugin_${plugin}_${server}`, source: 'plugin', plugin: pl.key, config,
        ...(project ? { projectId: project.id } : {}), ...(pl.file ? { sourceFile: pl.file } : {}), ...(bad.name ? { error: { code: 'plugin_var' as const, name: bad.name } } : {}),
      }, !pluginsOff.has(pl.key));
    }
  }
  return out;
}

/** C9: the server handles its own auth (Authorization header, headersHelper) or is a websocket → written as is. */
function passThrough(e: CatalogEntry): boolean {
  if (e.kind === 'stdio' || e.kind === 'ws') return true;
  if (e.config.headersHelper !== undefined) return true;
  return isObj(e.config.headers) && Object.keys(e.config.headers).some((k) => k.toLowerCase() === 'authorization');
}

/** Name-clash rank inside one session (§5.1: local > project > user > plugin). */
const RANK: Record<McpSource, number> = { local: 0, project: 1, user: 2, plugin: 3 };

/**
 * §5.1 the MCP file content of one session of `projectId`: every entry for lanes of that project, remote http / sse
 * behind the engine proxy (`/mcp-proxy/<id>`, the session token), the engine's `cc_slaves` over every name.
 * `mcpIds` = the proxied ids written (the proxy's allow-list for this session's token). v2.5 §5.7 `graph` managed → the user's
 * graph entries are dropped and `on` adds the engine's `/mcp-graph` entry under the tool's own name.
 */
export function sessionMcp(catalog: readonly CatalogEntry[], projectId: string, port: number, token: string, graph: SessionGraph = null): SessionMcp {
  const servers: McpServers = {};
  const rank = new Map<string, number>();
  const ids = new Map<string, string>();
  const auth = { Authorization: `Bearer ${token}` };
  for (const e of catalog) {
    if (graph && isGraphEntry(e.name, e.config)) continue; // §5.7 the module manages the graph: the user's own entries never go in
    if (!e.forLanes || (e.projectId !== undefined && e.projectId !== projectId)) continue;
    const r = RANK[e.source];
    if ((rank.get(e.name) ?? Infinity) <= r) continue;
    rank.set(e.name, r);
    if (passThrough(e)) {
      servers[e.name] = e.config;
      ids.delete(e.name);
    } else {
      servers[e.name] = { type: e.kind, url: `http://127.0.0.1:${port}/mcp-proxy/${encodeURIComponent(e.id)}`, headers: auth };
      ids.set(e.name, e.id);
    }
  }
  if (graph?.on) servers[GRAPH_NAME] = { type: 'http', url: `http://127.0.0.1:${port}/mcp-graph`, headers: auth };
  servers.cc_slaves = { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: auth };
  ids.delete('cc_slaves');
  return { servers, mcpIds: new Set(ids.values()) };
}

// ---------- sources on disk ----------

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** A plugin's MCP servers and their file: `<dir>/.mcp.json` (wrapped or flat), else `.claude-plugin/plugin.json` `mcpServers`. */
function pluginServers(dir: string): Pick<PluginSource, 'servers' | 'file'> {
  const mcpFile = join(dir, '.mcp.json');
  const mcp = readJson(mcpFile);
  if (isObj(mcp)) return { servers: isObj(mcp.mcpServers) ? mcp.mcpServers : mcp, file: mcpFile };
  const manifestFile = join(dir, '.claude-plugin', 'plugin.json');
  const manifest = readJson(manifestFile);
  if (!isObj(manifest)) return { servers: {} };
  if (isObj(manifest.mcpServers)) return { servers: manifest.mcpServers, file: manifestFile };
  if (typeof manifest.mcpServers === 'string') {
    const file = join(dir, manifest.mcpServers);
    const f = readJson(file);
    return isObj(f) ? { servers: isObj(f.mcpServers) ? f.mcpServers : f, file } : { servers: {} };
  }
  return { servers: {} };
}

export interface CatalogFiles { claudeJson: string; claudeHome: string }

const pluginFiles = (claudeHome: string) => ({
  installed: join(claudeHome, 'plugins', 'installed_plugins.json'), settings: join(claudeHome, 'settings.json'),
});

/** Reads every source file (§3-8: plugin dir = `installPath`, never a cache scan). Missing / broken → empty. */
export function readCatalogSources(f: CatalogFiles, projects: readonly ProjectRoot[]): CatalogSources {
  const pf = pluginFiles(f.claudeHome);
  const enabled = objAt(readJson(pf.settings), 'enabledPlugins');
  const plugins: PluginSource[] = [];
  for (const [key, installs] of Object.entries(objAt(readJson(pf.installed), 'plugins'))) {
    if (!Array.isArray(installs)) continue;
    for (const i of installs) {
      if (!isObj(i) || typeof i.installPath !== 'string' || (i.scope !== 'user' && i.scope !== 'project')) continue;
      plugins.push({
        key, installPath: i.installPath, scope: i.scope, enabled: enabled[key] === true, ...pluginServers(i.installPath),
        ...(typeof i.projectPath === 'string' ? { projectPath: i.projectPath } : {}),
      });
    }
  }
  const projectMcp: Record<string, unknown> = {};
  for (const p of projects) projectMcp[p.id] = readJson(join(p.path, '.mcp.json'));
  return { claudeJson: readJson(f.claudeJson), projectMcp, plugins };
}

const sourceFiles = (f: CatalogFiles, projects: readonly ProjectRoot[]): string[] => {
  const pf = pluginFiles(f.claudeHome);
  return [f.claudeJson, pf.installed, pf.settings, ...projects.map((p) => join(p.path, '.mcp.json'))];
};

/** mtime + size of every source file: Bun's fs.watch on macOS drops events (measured 4/6 runs silent), so `get()` checks. */
function statKey(files: readonly string[]): string {
  return files.map((f) => { try { const s = statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } }).join('|');
}

/** Watch one dir; `onEvent` gets the changed entry name (null = unknown). Injected so unit tests never start FSEvents. */
export type WatchDir = (dir: string, onEvent: (name: string | null) => void) => { close(): void };

/** macOS FSEvents reports nothing for a path through a symlink (`/var` → `/private/var`): watch the real dir. */
const watchDir: WatchDir = (dir, onEvent) => {
  const w = watch(realpathSync(dir), (_e, name) => onEvent(name === null ? null : String(name)));
  w.on('error', () => {});
  return w;
};

/**
 * The engine's cached catalog. Sources are re-read when a watched file changed (debounced, default 1 s), a source
 * file's mtime / size differs from the last read, or the project list changed; prefs are applied per call (pure, cheap).
 */
export class McpCatalog {
  private sources: CatalogSources | null = null;
  private sourcesKey = '';
  private cached: { key: string; entries: CatalogEntry[] } | null = null;
  private readonly watchers = new Map<string, { watcher: { close(): void }; names: Set<string> }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `onChange`: a watched source changed (after the debounce) — the Skills & MCP view re-pushes. */
  constructor(private readonly o: { claudeJson: () => string; claudeHome: () => string; debounceMs?: number; onChange?: () => void; watch?: WatchDir }) {}

  get(projects: readonly ProjectRoot[], prefs: CatalogPrefs): CatalogEntry[] {
    const files = { claudeJson: this.o.claudeJson(), claudeHome: this.o.claudeHome() };
    const list = sourceFiles(files, projects);
    const sKey = JSON.stringify([list, statKey(list)]);
    if (!this.sources || sKey !== this.sourcesKey) {
      const prev = this.sources?.claudeJson;
      this.sources = readCatalogSources(files, projects);
      // §6 K14: a `~/.claude.json` that does not parse → lanes keep the last good read
      if (this.sources.claudeJson === undefined && prev !== undefined && existsSync(files.claudeJson)) this.sources.claudeJson = prev;
      this.sourcesKey = sKey;
      this.cached = null;
      this.watchAll(list);
    }
    const key = JSON.stringify(prefs);
    if (this.cached?.key !== key) this.cached = { key, entries: buildCatalog(this.sources, projects, prefs) };
    return this.cached.entries;
  }

  /** Installed plugins of the last `get` (§5.5: the skills scan reads their `skills/`). */
  get plugins(): readonly PluginSource[] { return this.sources?.plugins ?? []; }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.watcher.close();
    this.watchers.clear();
  }

  /** Keeps a watcher per source dir alive across rebuilds (a fresh FSEvents stream misses edits for ~0.3 s). */
  private watchAll(files: readonly string[]): void {
    const want = new Map<string, Set<string>>();
    for (const file of files) {
      const names = want.get(dirname(file)) ?? new Set<string>();
      names.add(basename(file));
      want.set(dirname(file), names);
    }
    for (const [dir, w] of this.watchers) if (!want.has(dir)) { w.watcher.close(); this.watchers.delete(dir); }
    for (const [dir, names] of want) {
      const have = this.watchers.get(dir);
      if (have) { have.names = names; continue; }
      try {
        const entry = { names, watcher: (this.o.watch ?? watchDir)(dir, (name) => { if (name === null || entry.names.has(name)) this.sourceChanged(); }) };
        this.watchers.set(dir, entry);
      } catch { /* dir missing: nothing to watch until the project list / paths change */ }
    }
  }

  /** A source file changed (fs watch; G4 after its own `claude mcp` write): re-read after the debounce. */
  sourceChanged(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.sources = null; this.o.onChange?.(); }, this.o.debounceMs ?? 1000);
  }
}
