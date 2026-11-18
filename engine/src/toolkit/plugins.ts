// v2.5 §5.2 the four toolkit plugins: row state (a pure read of the plugin files, never a `claude` call), the §3-5
// "có bản mới" compare after a catalog refresh, and install / update / check through `claude plugin … --json`, one at a
// time on the engine's own `claude plugin` queue. Every command runs in the login env without `CLAUDE_CONFIG_DIR`
// (the caller's `exec`, like `mcp/registry.ts`), always `<name>@<marketplace>`. git: `SetupStatus.git` (R3).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphToolView } from '../../../shared/graph.ts';
import type { GitSetup } from '../../../shared/protocol.ts';
import type { ToolkitErrorCode, ToolkitKey, ToolkitRow, ToolkitView } from '../../../shared/toolkit.ts';
import { isObj } from '../../../shared/json.ts';
import { below } from '../../../shared/graph.ts';
import type { Exec, ExecResult } from '../setup/setup.ts';
import { PLUGIN_ITEMS, type PluginItem } from './catalog.ts';

type Obj = Record<string, unknown>;
type RowError = NonNullable<ToolkitRow['error']>;

/** §5.2 a second check within 60 s reuses the result (unless "Kiểm tra"). */
const CHECK_REUSE_MS = 60_000;
/** research §1.1: vercel installs in ~9 s (156 MB); a marketplace clone ~6 s. */
const CLI_TIMEOUT_MS = 180_000;
/** Ruling 00:27 a row keeps the last 4 lines of its own output. */
const LOG_LINES = 4;
/** §5.2 "lỗi git mạng" in the CLI's message or stderr. */
const NETWORK = /could not resolve host|unable to access|failed to connect|connection (refused|timed out|reset)|operation timed out|could not read from remote|network is unreachable|proxy/i;
const GIT_CODE: Record<Exclude<GitSetup['state'], 'ok'>, ToolkitErrorCode> = { missing: 'git_missing', license: 'git_license', error: 'git_error' };

const readJson = (file: string): Obj => {
  try { const v: unknown = JSON.parse(readFileSync(file, 'utf8')); return isObj(v) ? v : {}; } catch { return {}; }
};
const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

/** The plugin files Claude Code writes (research §1.3). */
interface PluginFiles { installed: Obj; settings: Obj; known: Obj }
function readFiles(claudeHome: string): PluginFiles {
  const p = join(claudeHome, 'plugins');
  return { installed: readJson(join(p, 'installed_plugins.json')), settings: readJson(join(claudeHome, 'settings.json')), known: readJson(join(p, 'known_marketplaces.json')) };
}

/** The `scope:"user"` entry of `id` (a project-only entry is `missing` for the user scope). */
function userEntry(f: PluginFiles, id: string): Obj | null {
  const list = isObj(f.installed.plugins) ? f.installed.plugins[id] : undefined;
  return Array.isArray(list) ? ((list as unknown[]).find((x): x is Obj => isObj(x) && x.scope === 'user') ?? null) : null;
}

const marketDir = (f: PluginFiles, name: string): string | null => {
  const k = f.known[name];
  return isObj(k) && typeof k.installLocation === 'string' ? k.installLocation : null;
};

/** Every file under `dir` (relative path → bytes), `.in_use` left out (§3-5). */
function tree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let names: string[];
  try { names = readdirSync(dir, { recursive: true }) as string[]; } catch { return out; }
  for (const n of names.sort()) {
    if (n.split('/').pop() === '.in_use') continue;
    try { if (statSync(join(dir, n)).isFile()) out.set(n, readFileSync(join(dir, n))); } catch { /* vanished mid-read */ }
  }
  return out;
}
function sameTree(a: string, b: string): boolean {
  const x = tree(a);
  const y = tree(b);
  return x.size === y.size && [...x].every(([k, v]) => y.get(k)?.equals(v) === true);
}

/** §3-5 against the (refreshed) catalog: url source with `sha` → `sha ≠ gitCommitSha` (an entry without `gitCommitSha` is
 *  unknown, hf-fx: an update would never clear it); path source with `version` → the versions differ (`latest` = that
 *  version); path source without one → the directory content differs. null = unknown. */
function staleOf(f: PluginFiles, item: PluginItem): { latest?: string } | null {
  const entry = userEntry(f, item.id);
  const dir = marketDir(f, item.marketplace.name);
  if (!entry || !dir) return null;
  const cat = readJson(join(dir, '.claude-plugin', 'marketplace.json'));
  const name = item.id.split('@')[0];
  const p = Array.isArray(cat.plugins) ? (cat.plugins as unknown[]).find((x): x is Obj => isObj(x) && x.name === name) : undefined;
  if (!p) return null;
  const version = typeof p.version === 'string' ? p.version : undefined;
  if (isObj(p.source)) {
    const known = typeof p.source.sha === 'string' && typeof entry.gitCommitSha === 'string';
    return known && p.source.sha !== entry.gitCommitSha ? (version ? { latest: version } : {}) : null;
  }
  if (typeof p.source !== 'string') return null;
  if (version !== undefined) return version !== entry.version ? { latest: version } : null;
  return typeof entry.installPath === 'string' && !sameTree(join(dir, p.source), entry.installPath) ? {} : null;
}

/** Ruling 00:55 the commands `install()` runs for a missing row: the marketplace add while it is unknown, then the install. */
function installCommands(f: PluginFiles, item: PluginItem): string[] {
  const add = marketDir(f, item.marketplace.name) === null ? [`claude plugin marketplace add ${item.marketplace.repo}`] : [];
  return [...add, `claude plugin install ${item.id}`];
}

/** §5.2 one `claude plugin … --json` reply: the last stdout JSON line; a failure gets its cause code + first line. */
export function classify(r: ExecResult): { ok: true; json: Obj } | ({ ok: false } & RowError) {
  const last = r.stdout.trim().split('\n').at(-1) ?? '';
  let json: Obj | null = null;
  try { const v: unknown = JSON.parse(last); json = isObj(v) ? v : null; } catch { json = null; }
  if (r.code === 0 && json?.outcome === 'ok') return { ok: true, json };
  const message = typeof json?.message === 'string' ? json.message : '';
  const line = firstLine(message) || firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
  if (json?.failureCode === 'not_found') return { ok: false, code: 'not_found', line };
  if (r.code !== 0 && NETWORK.test(`${message}\n${r.stderr}`)) return { ok: false, code: 'offline', line };
  return { ok: false, code: 'unknown', line };
}

/** §5.2 the one queue of `claude plugin` work (install, update, check): strictly sequential, a failure never blocks. */
export class PluginQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
}

export interface ToolkitDeps {
  claudeHome: () => string;
  /** `claude` on the login PATH; null → `no_claude`. */
  claudePath: () => string | null;
  /** Login env, `CLAUDE_CONFIG_DIR` stripped. */
  exec: Exec;
  /** `SetupStatus.git` (R3); `fresh` = run `setup_check` first (toolkit_check). */
  git: (fresh: boolean) => Promise<Pick<GitSetup, 'state' | 'detail'>>;
  /** v2.2 §5.3 the OAuth "needs (re-)login" mark of an MCP id (`plugin:<id>:<server>`), `mcp.noLogin` excluded. */
  needsLogin: (mcpId: string) => boolean;
  /** config `plugins.offForLanes`. */
  offForLanes: () => readonly string[];
  /** §5.2 step (3): MCP + skill catalogs rescanned and `settings.json` mirrored to the accounts, before "done". */
  afterWrite: () => void;
  onChange: () => void;
  now?: () => number;
  /** §5.3 / §5.6 the graph module (absent = no module: no graph row); `install` = the GR-run of a missing tool. */
  graph?: { tool: () => GraphToolView; install: () => Promise<void> };
}

/** §5.3 the graph tool row of the list: its state, version, "Sẽ chạy" line and run log come from the module view. */
function graphRow(t: GraphToolView): ToolkitRow {
  const line = t.failed?.line ?? (t.state === 'error' ? t.error : undefined);
  const newer = t.latest !== undefined && t.version !== undefined && below(t.version, t.latest);
  const state = t.run ? 'running' : line !== undefined ? 'failed' : t.state === 'missing' ? 'missing'
    : t.state === 'old' || newer ? 'outdated' : 'installed';
  const log = t.run?.log ?? (line !== undefined ? t.log?.slice(-LOG_LINES) : undefined);
  return {
    key: 'graph', kind: 'graph', state, mcpLoginIds: [],
    ...(t.version ? { version: t.version } : {}),
    ...(newer ? { latest: t.latest } : {}),
    ...(line !== undefined ? { error: { code: 'unknown' as const, line } } : {}),
    ...(log ? { log: [...log] } : {}),
    ...(state === 'missing' && t.command ? { commands: [t.command] } : {}),
  };
}

export class Toolkit {
  private readonly queue = new PluginQueue();
  private readonly running = new Set<ToolkitKey>();
  private busy: ToolkitKey | null = null;
  private readonly failed = new Map<ToolkitKey, RowError & { op: 'install' | 'update' }>();
  private readonly updated = new Set<ToolkitKey>();
  /** Ruling 00:27 each row's output of its last install / update (the last LOG_LINES lines). */
  private readonly logs = new Map<ToolkitKey, string[]>();
  /** After a check: plugin id → stale info (absent = not outdated). */
  private stale = new Map<string, { latest?: string }>();
  private checkedAt: number | undefined;
  private checkStart = -Infinity;
  private checkError: ToolkitView['checkError'];
  private checking: Promise<ToolkitView> | null = null;

  constructor(private readonly d: ToolkitDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  view(): ToolkitView {
    const f = readFiles(this.d.claudeHome());
    const off = new Set(this.d.offForLanes());
    const rows = PLUGIN_ITEMS.map((item): ToolkitRow => {
      const entry = userEntry(f, item.id);
      const fail = this.failed.get(item.key);
      if (fail?.op === 'install' && entry) this.failed.delete(item.key); // installed meanwhile (terminal): the old cause is gone
      const err = this.failed.get(item.key);
      const mcpLoginIds = entry ? item.mcpLogin.map((s) => `plugin:${item.id}:${s}`).filter((id) => this.d.needsLogin(id)) : [];
      const stale = entry ? this.stale.get(item.id) : undefined;
      const state = this.running.has(item.key) ? 'running' : err ? 'failed' : !entry ? 'missing'
        : !isObj(f.settings.enabledPlugins) || f.settings.enabledPlugins[item.id] !== true ? 'disabled'
          : mcpLoginIds.length > 0 ? 'needs_login' : stale ? 'outdated' : 'installed';
      return {
        key: item.key, kind: 'plugin', id: item.id, state, mcpLoginIds,
        ...(entry && typeof entry.version === 'string' ? { version: entry.version } : {}),
        ...(stale?.latest ? { latest: stale.latest } : {}),
        ...(off.has(item.id) ? { offForLanes: true as const } : {}),
        ...(err ? { error: { code: err.code, line: err.line } } : {}),
        ...(this.updated.has(item.key) && !err ? { updated: true as const } : {}),
        ...(this.logs.has(item.key) ? { log: [...this.logs.get(item.key)!] } : {}),
        ...(state === 'missing' ? { commands: installCommands(f, item) } : {}),
      };
    });
    if (this.d.graph) rows.push(graphRow(this.d.graph.tool()));
    return {
      rows, ...(this.checkedAt !== undefined ? { checkedAt: this.checkedAt } : {}),
      ...(this.checkError ? { checkError: this.checkError } : {}), ...(this.busy ? { busy: this.busy } : {}),
    };
  }

  /** §5.2 toolkit_check: `marketplace update` of every known marketplace of the four, then the §3-5 compare. */
  check(force: boolean): Promise<ToolkitView> {
    if (this.checking) return this.checking;
    if (!force && this.now() - this.checkStart < CHECK_REUSE_MS) return Promise.resolve(this.view());
    this.checkStart = this.now();
    const run = async (): Promise<ToolkitView> => {
      const git = await this.d.git(true);
      const claude = this.d.claudePath();
      if (git.state !== 'ok' || claude === null) return this.view(); // the rows show the cause on install / update
      return this.queue.run(async () => {
        let error: ToolkitView['checkError'];
        const f = readFiles(this.d.claudeHome());
        const names = [...new Set(PLUGIN_ITEMS.map((i) => i.marketplace.name))].filter((n) => marketDir(f, n) !== null);
        const refreshed = new Set<string>();
        for (const name of names) {
          const r = classify(await this.cli(claude, ['marketplace', 'update', name, '--json']));
          if (r.ok) refreshed.add(name);
          else error ??= { code: r.code === 'offline' ? 'offline' : 'unknown', line: r.line };
        }
        const after = readFiles(this.d.claudeHome());
        for (const item of PLUGIN_ITEMS) {
          if (!refreshed.has(item.marketplace.name)) continue;
          const s = staleOf(after, item);
          if (s) this.stale.set(item.id, s); else this.stale.delete(item.id);
        }
        this.checkedAt = this.now();
        this.checkError = error;
        this.d.onChange();
        return this.view();
      });
    };
    this.checking = run().finally(() => { this.checking = null; });
    return this.checking;
  }

  /** §5.2 toolkit_install: catalog order, only rows not installed yet; a failed row never stops the next; the graph tool last. */
  async install(keys: readonly ToolkitKey[]): Promise<void> {
    const f = readFiles(this.d.claudeHome());
    const want = new Set(keys);
    const items = PLUGIN_ITEMS.filter((i) => want.has(i.key) && !this.running.has(i.key) && userEntry(f, i.id) === null);
    await this.start(items, 'install', async (claude, item) => {
      if (marketDir(readFiles(this.d.claudeHome()), item.marketplace.name) === null) {
        const add = classify(await this.cli(claude, ['marketplace', 'add', item.marketplace.repo, '--json'], item.key));
        if (!add.ok) return add;
      }
      return classify(await this.cli(claude, ['install', item.id, '--json'], item.key));
    });
    if (want.has('graph') && this.d.graph?.tool().state === 'missing') await this.d.graph.install();
  }

  /** §5.2 toolkit_update: `marketplace update` → `update <id> -s user`; `updated` → the row's "Đã cập nhật" line. */
  update(key: ToolkitKey): Promise<void> {
    const items = PLUGIN_ITEMS.filter((i) => i.key === key && !this.running.has(i.key));
    return this.start(items, 'update', async (claude, item) => {
      const mk = classify(await this.cli(claude, ['marketplace', 'update', item.marketplace.name, '--json'], item.key));
      if (!mk.ok) return mk;
      const r = classify(await this.cli(claude, ['update', item.id, '--json', '-s', 'user'], item.key));
      if (r.ok) {
        this.stale.delete(item.id);
        if (r.json.updateOutcome === 'updated') this.updated.add(item.key);
      }
      return r;
    });
  }

  private start(items: PluginItem[], op: 'install' | 'update', step: (claude: string, item: PluginItem) => Promise<ReturnType<typeof classify>>): Promise<void> {
    if (items.length === 0) return Promise.resolve();
    for (const i of items) { this.running.add(i.key); this.failed.delete(i.key); this.updated.delete(i.key); this.logs.delete(i.key); }
    this.d.onChange();
    return this.queue.run(async () => {
      const git = await this.d.git(false);
      const claude = this.d.claudePath();
      for (const item of items) {
        this.busy = item.key;
        this.d.onChange();
        const cause: RowError | null = git.state !== 'ok' ? { code: GIT_CODE[git.state], line: git.detail ?? '' }
          : claude === null ? { code: 'no_claude', line: '' } : null;
        const r = cause ? { ok: false as const, ...cause } : await step(claude!, item).catch((e: unknown): ReturnType<typeof classify> => ({ ok: false, code: 'unknown', line: firstLine(e instanceof Error ? e.message : String(e)) }));
        if (r.ok) this.d.afterWrite();
        else this.failed.set(item.key, { code: r.code, line: r.line, op });
        this.running.delete(item.key);
        this.busy = null;
        this.d.onChange();
      }
    });
  }

  /** One `claude plugin` command; with `key`, its output lines go to that row's log (streamed, else the reply's lines). */
  private async cli(claude: string, args: string[], key?: ToolkitKey): Promise<ExecResult> {
    if (!key) return this.d.exec([claude, 'plugin', ...args], { timeoutMs: CLI_TIMEOUT_MS });
    let streamed = 0;
    const add = (line: string) => {
      if (line.trim() === '') return;
      const log = this.logs.get(key) ?? [];
      log.push(line);
      this.logs.set(key, log.slice(-LOG_LINES));
    };
    const r = await this.d.exec([claude, 'plugin', ...args], { timeoutMs: CLI_TIMEOUT_MS, onLine: (l) => { streamed++; add(l); this.d.onChange(); } });
    if (streamed === 0) for (const l of `${r.stdout}\n${r.stderr}`.split('\n')) add(l);
    return r;
  }
}
