// v2.2 §5.4 / §5.5 / §6 the engine's Skills & MCP area: the `claude mcp` registry, the skills scan + watcher (re-made
// when the project list changes), the git clone K9 keeps open, the config.json switches, and the one view pushed to
// Mac connections after every change (catalog watch, skills watch, a 2 s source / init poll, every command); the MCP
// OAuth client (§5.3, the proxy's upstream auth) and its K13 cards.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillGitFetch, SkillsMcpView } from '../../../shared/protocol.ts';
import { saveConfig, validateConfig, type Config } from '../config.ts';
import type { Engine } from '../engine.ts';
import type { CatalogEntry } from '../mcp/catalog.ts';
import { probeScope, ProbeRunner, type ProbeResult } from '../mcp/probe.ts';
import { McpRegistry, readClaudeJson, type LostEntry } from '../mcp/registry.ts';
import { McpOAuth, oauthServerOf } from '../mcp/oauth.ts';
import { TOOLS } from '../mcp/tools.ts';
import { McpLoginCards } from './mcp-login.ts';
import { paths } from '../paths.ts';
import { stripEnv } from '../session/env.ts';
import { CLAUDE_INSTALL } from '../setup/setup.ts';
import { ackedOf, buildCatalog, type SkillCatalog, type SkillScan } from '../skills/catalog.ts';
import { checkSkillDir, cloneSkillRepo, disposeClone, installFromClone, type SkillClone } from '../skills/ops.ts';
import { scanSkills, userSkillsDir, type SkillRoots } from '../skills/scan.ts';
import { watchSkillDirs, type SkillsWatch } from '../skills/watch.ts';
import { skillsMcpView, unusedLocal } from '../server/skills-mcp-view.ts';
import { runProbe, targetOf, type ProbeEntry } from './mcp-probe.ts';

const POLL_MS = 2000;
const PUSH_DEBOUNCE_MS = 50;
/** §6 F-I1 the `cc_slaves` row's tool count: what a lane's session gets from it. */
const LANE_TOOLS = TOOLS.filter((t) => t.roles.includes('lane')).length;

/** mtime + size of `~/.claude.json` (K14 "vừa đổi": the dialog's `rev`). */
function revOf(file: string): string {
  try { const s = statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
}

/** No Keychain / browser given (tests, e2e without overrides): nothing is stored, nothing opens. */
const NO_KEYCHAIN = () => ({ code: 1, stdout: '', stderr: 'no keychain' });

export class SkillsMcp {
  readonly registry: McpRegistry;
  /** §5.3 the engine's OAuth client of remote MCP servers (the proxy's `UpstreamAuth`). */
  readonly oauth: McpOAuth;
  /** §6 K13 one "cần đăng nhập lại" card per server. */
  readonly loginCards: McpLoginCards;
  private lost: LostEntry[] = [];
  private scan: SkillScan | null = null;
  private clone: { id: string; clone: SkillClone } | null = null;
  private watch: SkillsWatch | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSig = '';
  /** §5.4b checks: results, in flight, the auto queue. */
  readonly probes = new ProbeRunner({ run: (id) => this.probeOne(id), onChange: () => this.changed() });
  /** §5.4b ids saved / edited (or logged in) whose catalog rebuild has not landed yet: auto-checked when it does. */
  private readonly probeAfterRebuild = new Set<string>();

  constructor(private readonly e: Engine) {
    this.registry = new McpRegistry({
      claudePath: () => e.login.claudePath, env: () => stripEnv(e.login.env), claudeJson: () => paths().claudeJson,
      onWritten: () => e.mcpCatalog.sourceChanged(),
    });
    this.oauth = new McpOAuth({
      keychain: e.o.mcpKeychain ?? NO_KEYCHAIN, server: (id) => oauthServerOf(e.catalog(), id, e.config.mcp.noLogin),
      redirectBase: () => `http://127.0.0.1:${e.port}`,
      open: (url) => (e.o.openUrl ? e.o.openUrl(url) : e.log(`mcp oauth: no browser to open ${new URL(url).origin}`)),
      onChange: (id) => { if (!e.stopped) { this.loginCards.sync(id); this.changed(); } },
      onLoggedIn: (id) => { if (!e.stopped) this.autoProbe([id]); }, // §5.4b C22 "sau … đăng nhập"
    });
    this.loginCards = new McpLoginCards({
      cards: e.cards, view: (id) => this.oauth.view(id), name: (id) => oauthServerOf(e.catalog(), id)?.name ?? id,
      missing: (id) => e.tokens.sessionsWith(id).flatMap((s) => { const l = e.lanes.bySession(s); return l ? [{ name: l.name, projectId: l.projectId }] : []; }),
    });
  }

  get roots(): SkillRoots { return { home: this.e.login.env.HOME || homedir(), claudeHome: paths().claudeHome }; }

  start(): void {
    this.projectsChanged();
    this.autoProbe(); // §5.4b C22 boot: every id going into lanes
    this.poll = setInterval(() => { if (!this.e.stopped && this.e.hub.macCount > 0 && this.signature() !== this.lastSig) this.changed(); }, POLL_MS);
  }

  stop(): void {
    this.oauth.stop();
    this.loginCards.stop();
    this.watch?.stop();
    this.watch = null;
    if (this.poll) clearInterval(this.poll);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.dropClone();
  }

  /** §5.5 the skills watcher covers the user folder, every project's `.claude/skills` and enabled plugins' `skills/`. */
  projectsChanged(): void {
    this.rescan();
    const dirs = [userSkillsDir(this.roots), ...this.e.projectRows().map((p) => join(p.path, '.claude', 'skills')), ...this.pluginDirs().map((p) => join(p.installPath, 'skills'))];
    if (this.watch) this.watch.set(dirs); // hf1117-perf folders still listed keep their watchers
    else this.watch = watchSkillDirs(dirs, () => { if (!this.e.stopped) { this.rescan(); this.changed(); } });
    this.changed();
  }

  /** Enabled user plugins + project-scoped plugins of an added root (the ones whose skills reach a lane). */
  private pluginDirs(): { id: string; installPath: string }[] {
    this.e.catalog();
    const roots = new Set(this.e.projectRows().map((p) => p.path));
    return this.e.mcpCatalog.plugins.filter((p) => (p.scope === 'user' ? p.enabled : roots.has(p.projectPath ?? '')))
      .map((p) => ({ id: p.key, installPath: p.installPath }));
  }

  /** v2.9 §5.4 the plugins a lane gets (enabled user + project-scoped of an added root), by name (`superpowers`). */
  installedPlugins(): string[] { return this.pluginDirs().map((p) => p.id.split('@')[0]!); }

  rescan(): void {
    const projects = this.e.projectRows().map((p) => ({ id: p.id, name: p.name, path: p.path }));
    this.scan = scanSkills(this.roots, { projects, plugins: this.pluginDirs() });
  }

  skillCatalog(): SkillCatalog | null {
    return this.scan ? buildCatalog(this.scan, ackedOf(this.e.config)) : null;
  }

  rev(): string { return revOf(paths().claudeJson); }

  private signature(): string {
    const logAt = this.probeEntries().reduce((n, x) => Math.max(n, this.e.mcpProxy?.log.lines(x.id).at(-1)?.at ?? 0), 0);
    return `${this.rev()}|${this.e.mcpInit.list().reduce((n, r) => Math.max(n, r.at), 0)}|${this.probes.version}|${logAt}`;
  }

  view(): SkillsMcpView {
    const read = readClaudeJson(paths().claudeJson);
    const catalog = this.e.catalog();
    if (read.ok) this.lost = this.lost.filter((l) => !(l.name in ((read.json.mcpServers ?? {}) as Record<string, unknown>)));
    const skills = this.skillCatalog();
    this.lastSig = this.signature();
    return skillsMcpView({
      catalog, roots: this.e.projectRows().map((r) => ({ id: r.id, path: r.path })), config: this.e.config, init: this.e.mcpInit.list(),
      claudeJson: read, claudeJsonPath: paths().claudeJson, rev: this.rev(), plugins: this.pluginDirs().map((p) => p.id),
      skills: skills && this.scan ? { catalog: skills, scan: this.scan } : null,
      sharedBad: this.e.accountViews().filter((a) => !a.sharedCfg.ok).length,
      ...(this.e.graphModule ? { graphRed: this.e.graphModule.red(), graphReady: this.e.graphModule.state() === 'ready' } : {}),
      claudeFound: this.e.login.claudePath !== null, install: CLAUDE_INSTALL, lost: this.lost, ccTools: LANE_TOOLS,
      probes: this.probes, oauth: (id) => this.oauth.view(id), log: (id) => this.e.mcpProxy?.log.lines(id) ?? [],
    });
  }

  // ---------- §5.4b checks ----------

  /** K1-local entries (a local entry of a path that is no added project root) as catalog-shaped entries. */
  unusedEntries(): CatalogEntry[] {
    const read = readClaudeJson(paths().claudeJson);
    if (!read.ok) return [];
    return unusedLocal(read.json, this.e.projectRows()).map((r) => ({ id: r.id, name: r.name, source: 'local', kind: r.kind, config: r.config, forLanes: false }));
  }

  private probeEntries(): ProbeEntry[] {
    const cat = this.e.catalog().map((x): ProbeEntry => ({
      id: x.id, source: x.source, kind: x.kind, config: x.config, forLanes: x.forLanes, unused: false, error: x.error !== undefined,
      ...(x.projectId !== undefined ? { projectId: x.projectId } : {}),
    }));
    return [...cat, ...this.unusedEntries().map((x): ProbeEntry => ({ id: x.id, source: 'local', kind: x.kind, config: x.config, forLanes: false, unused: true, error: false }))];
  }

  /** §5.4b C22 auto checks (boot, after save / edit / login): only ids going into lanes; `ids` narrows them. */
  autoProbe(ids?: readonly string[]): void {
    this.probes.schedule(this.probeEntries().filter((x) => (!ids || ids.includes(x.id)) && probeScope(targetOf(x)).auto).map((x) => x.id));
  }

  /** §5.4b after save / edit / login: auto-check `ids` once the catalog has re-read its sources. */
  probeSoon(ids: readonly string[]): void { for (const id of ids) this.probeAfterRebuild.add(id); }

  /** The catalog rebuilt from changed sources (fs watch or a write of ours). */
  catalogChanged(): void {
    const ids = [...this.probeAfterRebuild];
    this.probeAfterRebuild.clear();
    if (ids.length > 0 && !this.e.stopped) this.autoProbe(ids);
    this.changed();
  }

  /** "Kiểm tra" (C22: false = not allowed — no button for it; nothing runs). */
  check(id: string): boolean {
    const x = this.probeEntries().find((p) => p.id === id);
    if (!x || !probeScope(targetOf(x)).po) return false;
    this.probes.check(id);
    return true;
  }

  private probeOne(id: string): Promise<ProbeResult> {
    const x = this.probeEntries().find((p) => p.id === id);
    // Re-checked at run time: the entry may have changed (or lost its approval) while queued — never spawn then.
    if (!x || !probeScope(targetOf(x)).po || !this.e.mcpProxy) return Promise.reject(new Error(`not checkable: ${id}`));
    const env = stripEnv(this.e.login.env);
    const root = x.projectId !== undefined ? this.e.projectRows().find((p) => p.id === x.projectId)?.path : undefined;
    return runProbe(x, { proxy: this.e.mcpProxy, fetch: this.e.fetch, env, cwd: root ?? this.roots.home });
  }

  /** Coalesced push of the whole view to Mac connections. */
  changed(): void {
    if (this.e.stopped || this.pushTimer) return;
    this.pushTimer = setTimeout(() => this.flush(), PUSH_DEBOUNCE_MS);
  }

  /**
   * Push now (drops a pending coalesced push). §6 K14: a write command calls it before its reply, so the Mac sees the
   * post-write `rev` before the ack / error — a failed own write (K4e-restore) never reads as a foreign change.
   */
  flush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    if (!this.e.stopped && this.e.hub.macCount > 0) this.e.broadcast({ type: 'skills_mcp', view: this.view() });
  }

  addLost(l: LostEntry): void { this.lost = [...this.lost.filter((x) => x.name !== l.name), l]; }

  /** §5.4 the `config.json` switches (same write path as `config_update`). */
  setConfig(next: Config): void {
    const bad = validateConfig(next);
    if (bad) throw new Error(`config: ${bad.key}`);
    saveConfig(next, { keepRegistryKeys: !this.e.registryImported() });
    this.e.config = next;
    this.e.broadcast({ type: 'config', config: this.e.configView() });
    this.changed();
  }

  // ---------- K9 git ----------

  async gitFetch(url: string): Promise<SkillGitFetch> {
    this.dropClone();
    const clone = await cloneSkillRepo(url, this.e.gitExec);
    const id = randomBytes(6).toString('hex');
    this.clone = { id, clone };
    return { cloneId: id, candidates: clone.candidates.map((c) => ({ name: c.name, check: checkSkillDir(this.roots, c.path, c.name) })) }; // K9-git
  }

  gitAdd(cloneId: string, names: readonly string[]): string[] | null {
    if (this.clone?.id !== cloneId) return null;
    try { return installFromClone(this.roots, this.clone.clone, names); } finally { this.dropClone(); this.rescan(); this.changed(); }
  }

  dropClone(id?: string): void {
    if (!this.clone || (id !== undefined && this.clone.id !== id)) return;
    disposeClone(this.clone.clone);
    this.clone = null;
  }
}
