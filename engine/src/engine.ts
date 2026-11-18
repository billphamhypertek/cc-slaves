// Engine composition (spec §7.1, §7.9, §8.1, §8.3): config/caps, state.db, login env, accounts + QuotaTracker,
// LaneManager, Orchestrators, CardStore, MCP, notifications, WS hub and the Mac web server. `main.ts` adds the
// process-level parts (lock, Keychain, signals); tests build this directly with fakes (fake-claude, no keychain).
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import type { AccountLoginView, AccountView, Channel, EngineEvent, EngineInfo, GhLoginView, Health, LaneView, SetupStatus, AccountsInfo, ProjectView, Snapshot, Target, TokenStats, CardView, OrchestratorView, SessionsList } from '../../shared/protocol.ts';
import { notifySeq } from './server/session-views.ts';
import { keychainQuotaSource, QuotaTracker, rejectedHeld, type QuotaSource } from './accounts/quota.ts';
import { ModelCache, ModelSource } from './models.ts';
import { CardStore, type Card, type Timers as CardTimers } from './cards/store.ts';
import { attachLaneCards, attachOrchestratorCards, attachSystemCards, laneCardSessions, orchestratorCardSessions } from './cards/wire.ts';
import { activeLogin, readIdentity, type PtySpawn, type StartOptions } from './accounts/login.ts';
import type { SecurityRun } from './accounts/keychain.ts';
import type { SecurityCli } from './keychain.ts';
import type { DeleteOutcome, RemoveDeps } from './accounts/remove.ts';
import { CAPS_IMPORTED_KEY, importAtBoot, registryCaps, type Account } from './accounts/registry.ts';
import { writeSkillGate } from './session/skills.ts';
import { catalogPrefs, lanesOff, loadCaps, loadConfig, stripRegistryKeys, type Caps, type Config } from './config.ts';
import { getMeta, openDb, type Db, type LaneState } from './db.ts';
import { SubagentTracker } from './server/subagents.ts';
import { LaneError, LaneManager, type LaneManagerDeps, type StartInput } from './lane/manager.ts';
import { BranchTracker, ghLookup, type GhLookup } from './lane/branch.ts';
import { CodeArea } from './engine/code.ts';
import { IssuesArea } from './engine/issues.ts';
import { createMcpHandler, TokenRegistry } from './mcp/server.ts';
import { createMcpProxy, upstreamOf, type McpProxy } from './mcp/proxy.ts';
import { GraphFronts } from './graph/front.ts';
import { GraphIndexes } from './graph/indexes.ts';
import { latestTag, runInstaller, type GraphUrls } from './graph/install.ts';
import { GraphModule } from './graph/module.ts';
import { IndexQueue } from './graph/queue.ts';
import { createGraphGate } from './graph/relay.ts';
import { GraphTool } from './graph/tool.ts';
import type { McpLanes } from './mcp/tool-kit.ts';
import { IssueEvents } from './issues/events.ts';
import { Notifier, osascriptNotify, postGchat, type NotifierDeps } from './notify/notify.ts';
import { Orchestrators, type OrchestratorView as OrchestratorRtView } from './orchestrator/session.ts';
import { Outbox } from './outbox.ts';
import { ensureHome, paths } from './paths.ts';
import type { ContinueDeps } from './lane/continue.ts';
import { recover } from './recovery.ts';
import { Caffeinate, type CaffeinateSpawner } from './session/caffeinate.ts';
import { childEnv, findOnPath, loadLoginEnv, stripEnv, type Env, type LoginEnv } from './session/env.ts';
import type { SessionSpawn } from './session/files.ts';
import type { ProcInfo } from './session/process.ts';
import { buildHandlers } from './server/commands.ts';
import { startNextStep } from './server/issue-commands.ts';
import { startHttp } from './server/http.ts';
import { attachRoute } from './attach/routes.ts';
import { AttachStore } from './attach/store.ts';
import { LineStore, poWritten } from './server/lines.ts';
import type { AuthCheck, ProjectRow } from './server/views.ts';
import { WsHub, type Conn } from './server/ws.ts';
import { execIn, setupCheck, type Exec } from './setup/setup.ts';
import { cltFallback, gitCheck } from './setup/git-setup.ts';
import type { GhLoginHandle } from './setup/gh-login.ts';
import { McpInitStore } from './stream/parser.ts';
import { McpCatalog, type CatalogEntry } from './mcp/catalog.ts';
import { SkillsMcp } from './engine/skills-mcp.ts';
import { WorkflowLibrary } from './workflow/library.ts';
import { Toolkit } from './toolkit/plugins.ts';
import { mirrorSettings } from './accounts/mirror.ts';
import { AuthorSessions } from './workflow/author.ts';
import { createDraftMcpHandler } from './mcp/draft-server.ts';
import { logMissingRevs } from './workflow/runtime.ts';
import { openPrivate, type BrowserExec, type OpenResult } from './accounts/browser.ts';
import { SharedCfgState, watchClaudeRoot, type ClashCopy, type MergePlan, type MergeResult, type SharedCfgCheck } from './accounts/shared-cfg.ts';
import { adoptOrphan, authDeps, deleteOrphan, orphanAt, startAccountLogin, sweepLogins } from './engine/account-login.ts';
import { accountChanged, accountViews, broadcastAccount, deleteAccount, loggedOut, loginRenewed, readNoLogin, readRegistry, refreshAccounts, removeDeps, signOutAccount, syncCutover } from './engine/accounts.ts';
import { checkAuth, scheduleAuthCheck } from './engine/auth-check.ts';
import { scheduleStats, seedPrevLanes, sendHeld, versionSeen, wire } from './engine/events.ts';
import { BlockLedger } from './stream/blocks.ts';
import { HeldProjects } from './engine/held.ts';
import { continueDeps, continueLane, markInTurn, sessionsList, sessionsOf, targetOfSession } from './engine/sessions.ts';
import { accountsInfo, checkAllSharedCfg, checkSharedCfg, clashPath, laneConfig, logMirror, mergeSharedCfg, preSpawn, refreshA9, scanClaudeRoot, startSettingsMirror, syncSharedCards, toggleShared } from './engine/shared-cfg.ts';
import { backupState, UpdateGate } from './update/commit.ts';
import { heldSince, sessionsBusy, UpdateHold } from './update/hold.ts';
import { takeResume, writeResume } from './update/resume.ts';
import { branchOnWatch, buildLaneView, buildProjectView, buildTokenStats, cardViewOf, configView, engineInfo, health, orchView, pushSubagents, snapshot, snapshotLanes } from './engine/views.ts';


export interface EngineOptions {
  version: string;
  /** v2.1 §4.15 git runner of the branch measurement (default: real git; never `exec`, which tests fake). */
  gitExec?: Exec;
  /** v2.1 §4.15 PR lookup (default: `gh` on the login PATH, else none); null = never ask gh. */
  gh?: GhLookup | null;
  /** v2.1 §4.15 base-branch poll (default 5 min; 0 = off). */
  branchPollMs?: number;
  /** 47800 in production; 0 = any free port (tests). */
  port: number;
  hostname?: string;
  token: string;
  staticDir: string | null;
  /** Default: the login-shell `claude`. Tests: `['bun', fake-claude]`. */
  command?: string[];
  loginEnv?: LoginEnv;
  /** Extra child env per account (tests: FAKE_CLAUDE_SCENARIO). */
  extraEnv?: (a: Account) => Env;
  quotaSource?: QuotaSource;
  caffeinateSpawner?: CaffeinateSpawner;
  ps?: () => Promise<ProcInfo[]>;
  kill?: (pid: number) => void;
  exec?: Exec;
  fetch?: typeof fetch;
  notify?: Partial<Pick<NotifierDeps, 'osascript' | 'postGchat'>>;
  session?: LaneManagerDeps['session'];
  closeGraceMs?: number;
  /** Account re-read / quota tick period (ms); 0 disables (tests). */
  accountsEveryMs?: number;
  /** v2.9 §10.1 workflow library poll (ms, default 2 s); 0 disables. */
  workflowPollMs?: number;
  quotaEveryMs?: number;
  /** v2.4 §10.2 attachment sweep: at start (+ the 14-day rule) and then every N ms. 0 / unset = off (in-process tests;
   *  boot passes 1 h). */
  attachSweepMs?: number;
  /** v2.1 §5.3 token stats push period (midnight / 5 h roll); 0 disables. Default 60 s. */
  statsEveryMs?: number;
  /** v2.6 §5.4-4 how often a held engine re-reads `engine.update` (ms). Default 1 s. */
  updateTickMs?: number;
  /** v2.1 §5.3 throttle of the within-turn stats push (ms). Default 2 s. */
  statsThrottleMs?: number;
  /** Lane timers (§7.4 retry delays 20 s / 60 s; e2e scales them). */
  laneTimers?: CardTimers;
  /** Card expiry timers (§6.15 30 min; e2e shortens them). */
  cardTimers?: CardTimers;
  /** F16: does this account's Keychain item hold a Claude login (default: /usr/bin/security, yes/no only). */
  hasLogin?: (a: Account) => boolean;
  /** v2 §3.2 SA4 `/usr/bin/security` for the Keychain delete (tests: a fake; never the real Keychain). */
  securityRun?: SecurityRun;
  /** v2 §3.2 SA6 `defaults` / `open` runner for "Mở cửa sổ riêng tư" (tests: a fake; never a real browser). */
  browserExec?: BrowserExec;
  /** v2.2 §5.3 `security` for the MCP OAuth records (boot: /usr/bin/security; default none: nothing is stored). */
  mcpKeychain?: SecurityCli;
  /** v2.2 §5.3 opens an MCP login link in the default browser (boot: `open`; default none: logged only). */
  openUrl?: (url: string) => void;
  /** v2 §3.2 SA1 pty spawn for `claude auth …` (default: `script` in a pty). */
  authSpawn?: PtySpawn;
  /** v2 §6 A2 `claude auth status` per account: timeout (default 5 s → `?`), re-check period for a known result
   *  (default 5 min; 0 = boot and new accounts only), debounce of refreshAccounts triggers (default 1 s). */
  authCheckTimeoutMs?: number;
  authCheckEveryMs?: number;
  authCheckDebounceMs?: number;
  /** v2.5 §5.3 the graph module: find the tool on the login PATH (else ~/.local/bin) and run its fronts. Boot: true;
   *  unset = off, so no test ever runs the real codebase-memory-mcp (Z5; tests put `fake-cbm` on a temp PATH). */
  graphModule?: boolean;
  /** @internal test seam: v2.5 §5.6 loopback stand-ins for the GitHub release / script / download URLs. */
  graphUrls?: GraphUrls;
  /** `engine_shutdown` accepted (main.ts: launchctl bootout / exit). */
  onShutdownRequest?: () => void;
  log?: (line: string) => void;
}

const BUSY: readonly LaneState[] = ['starting', 'running', 'switching', 'draining'];
const PROJECT_COLS = 'id, name, path, orchestrator_account, gchat_webhook, gchat_send_command_text';

export class Engine {
  /** §5.3 epoch ms (EngineInfo / Health `startedAt`). */
  readonly startedAt = Date.now();
  config: Config;
  caps: Caps;
  accounts: Account[] = [];
  /** v2.2 §5.1 last `system/init` state per (project, MCP server), from every session (G4 exposes it). */
  readonly mcpInit = new McpInitStore();
  /** v2.2 §5.1 the MCP catalog (cached, rebuilt when a source file changes). */
  readonly mcpCatalog = new McpCatalog({ claudeJson: () => paths().claudeJson, claudeHome: () => paths().claudeHome, onChange: () => this.skillsMcp.catalogChanged() });
  /** v2.2 §5.4 / §5.5 / §6 Skills & MCP: `claude mcp` registry, skills scan + watch, the pushed view. */
  readonly skillsMcp: SkillsMcp;
  /** The K0 graph red + `ready` (§5.7 the locked row leaves the MCP count) last pushed with the skills_mcp view. */
  private graphCount = 'false|false';
  /** v2.9 §10.1 the workflow library + pinned revs. */
  readonly workflows: WorkflowLibrary;
  /** v2.5 §5.2 Bộ công cụ: plugin rows + install / update / check on the `claude plugin` queue. */
  readonly toolkit: Toolkit;
  /** v2.9 §5.9 the author sessions (drafts by prompt). */
  readonly authors: AuthorSessions;
  /** v2.3 §10.2 Code + Git commands, `code_changed`. */
  readonly code: CodeArea;
  /** v2.7 specs / issues: snapshot part, coalesced pushes, spec scan, prior sessions / outputs. */
  readonly issues: IssuesArea;
  /** v2.5 §5.4 the graph fronts behind `/mcp-graph` (null: module off). */
  readonly graph: GraphFronts | null;
  /** v2.5 §5.5 the index queue, the index book, automatic indexing and clean-up (null: module off). */
  readonly graphIndexes: GraphIndexes | null;
  /** v2.5 §5.3 / §5.6 / §5.8 module state, latest check, install / update, GraphView (null: module off). */
  readonly graphModule: GraphModule | null;
  /** v2.2 §5.2 the MCP proxy (§5.4b checks call its `forward`; its upstream tokens: `skillsMcp.oauth`). */
  mcpProxy: McpProxy | null = null;
  stopSettingsWatch: () => void = () => {};
  /** v2 §5.5 last shared-config check per account (flagged → no new lane). */
  readonly sharedCfg: SharedCfgState;
  /** A9 cards the PO put off ("Để sau"), by card key: not reopened until that issue clears. */
  readonly sharedDismissed = new Set<string>();
  private stopRootWatch: () => void = () => {};
  /** §6.16 accounts whose Keychain item holds no Claude login (re-read with the registry, every `accountsEveryMs`). */
  noLogin = new Set<string>();
  /** v2 §6 A2 / §3.1-4: last `claude auth status` per account (exit code only) and when it finished (ms). */
  readonly auth = new Map<string, { state: AuthCheck; at: number }>();
  authTimer: ReturnType<typeof setTimeout> | null = null;
  readonly authBusy = new Set<string>();
  /** §6.3 F3: PO message contents sent while the target was mid-turn, per session, until their replay echo. */
  readonly inTurnSent = new Map<string, string[]>();
  setup: SetupStatus | null = null;
  /** hotfix 2026-11-16 (b) `gh` on the login PATH (null: none, or tests passed `gh`), and the running `gh auth login`. */
  readonly ghPath: string | null;
  ghLogin: GhLoginHandle | null = null;
  /** v2 §6 A3–A7: the running (or last) login, as the UI renders it. */
  loginView: AccountLoginView | null = null;
  /** F17: a failed compatibility check → `lane_start` refuses (running lanes untouched). */
  compat: { version: string; message: string } | null = null;
  claudeVersion: string | null = null;
  readonly db: Db;
  readonly outbox: Outbox;
  readonly tokens: TokenRegistry;
  readonly tracker: QuotaTracker;
  readonly lanes: LaneManager;
  readonly orchestrators: Orchestrators;
  /** v2.7 §5.3 `[cc-slaves]` issue messages to the orchestrator sessions + the lane hold / return hook. */
  readonly issueEvents: IssueEvents;
  readonly cards: CardStore;
  readonly lines: LineStore;
  /** v2.2 §14.4 stream block ledger + held text, per session (stream/blocks.ts). */
  readonly blocks = new BlockLedger<Target>();
  /** hotfix 2026-11-16 projects held until "Tiếp tục" / a PO message (nothing of them runs). */
  readonly held = new HeldProjects(this);
  /** v2.6 §5.4 the app's update hold: lives as long as the WS that asked for it. */
  readonly update: UpdateHold<Conn>;
  readonly hub: WsHub;
  readonly notifier: Notifier;
  readonly exec: Exec;
  readonly fetch: typeof fetch;
  server!: Server<unknown>;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  /** v2.4 §6.5 attachment copies (`/attach*`, the `send` check, sweep); a copy an outbox row names is kept (§10.2). */
  readonly attach = new AttachStore({ referenced: () => this.outbox.referencedCopies() });
  /** v2.4 §5.4 models per account / default per (account, project), 60 s; the probe source of `session_models`. */
  readonly modelCache = new ModelCache();
  readonly models: ModelSource;
  /** Each lane's last emitted state; `seeded` = read from state.db at boot (no event since). */
  readonly prevLane = new Map<string, { state: LaneState; phase: string | null; account: string | null; seeded?: true }>();
  /** v2.1 §4.15 branch / merge measurement of reported-done and done lanes. */
  readonly branches: BranchTracker;
  /** git for branch measuring and the §4.14 "Chạy tiếp lane" worktree rebuild (tests inject one). */
  gitExec!: Exec;
  /** v2.1 W9 subagents of every lane (from their task_* events). */
  readonly subagents = new SubagentTracker();
  statsTimer: ReturnType<typeof setTimeout> | null = null;
  stopped = false;

  private constructor(readonly o: EngineOptions, readonly login: LoginEnv, port: number) {
    // eslint-disable-next-line no-console -- the default log sink is the sidecar's stderr (Tauri captures it)
    this.log = o.log ?? ((l) => console.error(l));
    // hotfix 2026-11-16: every engine-run tool (git, gh, setup) gets the login-shell env, as sessions do (DEVELOPER_DIR, PATH)
    const loginExec = execIn(stripEnv(login.env));
    this.exec = o.exec ?? loginExec;
    this.fetch = o.fetch ?? fetch;
    const cfg = loadConfig();
    if (cfg.error) this.log(cfg.error);
    this.db = openDb(paths().stateDb);
    // §7.1-2: caps.json + config laneCaps/noNewLanes are read once, into the account table; after that the table is the
    // only source (PO edits go there), so a caps.json changed later is never re-imported.
    if (getMeta(this.db, CAPS_IMPORTED_KEY) === null) {
      const caps = loadCaps();
      if (caps.error) this.log(caps.error);
      importAtBoot(this.db, caps, cfg);
    }
    if (getMeta(this.db, CAPS_IMPORTED_KEY) !== null && stripRegistryKeys()) this.log('config.json: laneCaps / noNewLanes đã chuyển vào bảng account');
    this.config = cfg.config;
    this.caps = registryCaps(this.db);
    this.readRegistry();
    this.outbox = new Outbox(this.db, this.attach);
    this.tokens = new TokenRegistry(this.db);
    this.lines = new LineStore(this.db);
    this.lines.unhold(); // v2.6 §5.4-8 no hold survives a restart: no "giữ lại" label either
    this.noLogin = this.readNoLogin();
    this.claudeVersion = null;

    this.sharedCfg = new SharedCfgState({ claudeHome: () => paths().claudeHome, extraShared: () => this.config.sharedExtra ?? [] });
    const caffeinate = new Caffeinate({ enabled: () => this.config.caffeinate, ...(o.caffeinateSpawner ? { spawner: o.caffeinateSpawner } : {}) });
    this.tracker = new QuotaTracker({
      db: this.db, source: o.quotaSource ?? keychainQuotaSource(),
      onAccountChanged: (email) => this.accountChanged(email),
      onRefreshState: (email) => { if (!this.stopped) this.broadcastAccount(email); }, // v2.7.1 §7.3 queued / fetching / idle
      onQueueState: (quota) => { if (!this.stopped) this.hub.broadcast({ type: 'quota', quota }); },
    });
    const command = o.command ?? [login.claudePath ?? 'claude'];
    const env = (a: Account) => ({ ...childEnv(login.env, a), ...(o.extraEnv?.(a) ?? {}) });
    // v2.6 §5.4 one gate in front of every write / spawn; its release writes what waited
    const gate = new UpdateGate(() => { this.lanes.writesOpened(); for (const orch of this.orchestrators.all()) orch.writesOpened(); this.authors.writesOpened(); });
    const common = {
      gate, db: this.db, outbox: this.outbox, accounts: () => this.accounts, loggedOut: () => this.loggedOut(), quota: this.tracker, caps: () => this.caps,
      command, env, mcpPort: port, caffeinate, modelCache: this.modelCache, modelDefaults: () => this.config.modelDefaults,
      // v2.5 §5.4 cwd + graph ride with the token; a process whose MCP file has the graph gets its front now (with the spawn)
      // §5.5 the same spawn may index its cwd (cwd ≠ root with no index, or a non-git project root)
      onMcpToken: (sid: string, sp: SessionSpawn) => {
        this.tokens.register(sid, sp.token, sp);
        if (!sp.graph) return;
        this.graph?.openSession(sid, sp.cwd);
        const who = this.tokens.resolve(sp.token);
        if (who) void this.graphIndexes?.spawned(who.projectId, sp.cwd);
      },
      onSessionEnded: (sid: string) => { this.tokens.revoke(sid); this.graph?.closeSession(sid); }, // M-3
      // v2.2 §5.1 / §5.5 the session MCP set + lane switches (v2.5 §5.7 + the graph); §5.3 pre-spawn settings copy; §5.1 init state per server
      sessionSetup: (projectId: string) => ({ catalog: this.catalog(), off: lanesOff(this.config, projectId), graph: this.graphSetup(projectId) }),
      session: {
        ...o.session, mcpInit: this.mcpInit,
        beforeSpawn: (dir: string) => { this.preSpawn(dir); },
      },
      ...(o.closeGraceMs !== undefined ? { closeGraceMs: o.closeGraceMs } : {}),
    };
    const account = (email: string) => this.accounts.find((a) => a.email === email) ?? null;
    this.models = new ModelSource({ // §5.4 the probe: preSpawn first, a flagged account never spawns
      cache: this.modelCache, command, env: (email) => env(account(email)!), configDir: (email) => account(email)?.configDir ?? null,
      flagged: (email) => { const q = this.tracker.get(email); return this.loggedOut().has(email) || (q !== null && rejectedHeld(q, Math.floor(Date.now() / 1000))); },
      preSpawn: (dir) => this.preSpawn(dir),
    });
    this.issueEvents = new IssueEvents({
      db: this.db, running: (sid) => this.orchestrators.bySession(sid) !== null, hasRoom: () => 'account' in this.lanes.pickFor(null, []),
      send: (sid, text) => { const to = this.orchestrators.bySession(sid); if (to) void to.send(text); else this.outbox.enqueue(sid, text, null); },
    });
    this.lanes = new LaneManager({
      ...common, ...(o.laneTimers ? { timers: o.laneTimers } : {}), issues: this.issueEvents,
      // IMPORTANT-4 §5.5: a lane spawn is refused on a flagged account (the session re-picks), and every pick runs the
      // check first, so it never chooses an account whose shared config broke since the last check (≤ 20 ms each).
      session: { ...common.session, beforeSpawn: (dir: string) => this.preSpawn(dir) },
      config: () => { this.checkAllSharedCfg(); return this.laneConfig(); }, notify: (p, t, lane) => this.orchestrators.notify(p, t, lane),
      log: this.log, // v2.4 §5.6 an agent definition not found
    });
    this.orchestrators = new Orchestrators(common);
    // v2.5 §5.4 a session front lives exactly as long as its claude process
    const tool = new GraphTool({ env: login.env });
    this.graph = o.graphModule ? new GraphFronts({ tool, dataDir: paths().home, log: this.log }) : null;
    // §5.5 a job queued / started / ended → the Mac view (after a job: its numbers are read again)
    const queue = this.graph ? new IndexQueue(this.graph, { onChange: (ended) => { if (ended) void this.graphModule?.refresh(); else this.graphModule?.changed(); } }) : null;
    this.graphIndexes = this.graph && queue ? new GraphIndexes({
      db: this.db, port: this.graph, queue, home: login.env.HOME || homedir(), log: this.log,
      projects: () => this.projectRows().filter((r) => !this.config.graph.offProjects.includes(r.id)).map((r) => ({ id: r.id, path: r.path })), // §5.7 graph on
      roots: () => this.projectRows().map((r) => r.path), // D66 every project root, graph off too
      liveCwds: () => this.db.query<{ cwd: string }, []>("SELECT cwd FROM lane WHERE state != 'done'").all().map((r) => r.cwd),
    }) : null;
    this.graph?.onUp(() => { void this.graphIndexes?.ready(); }); // module ready (also engine start)
    const gi = this.graphIndexes;
    this.graphModule = this.graph && gi && queue ? new GraphModule({
      fronts: this.graph, tool, db: this.db, home: login.env.HOME || homedir(), exec: loginExec, log: this.log,
      indexes: { list: () => gi.list(), keep: () => gi.keep(), indexNow: (id, root) => gi.indexNow(id, root), state: (r) => queue.state(r), stop: (r) => queue.stop(r), remove: (n) => queue.remove(n) },
      projects: () => this.projectRows().map((r) => ({ id: r.id, name: r.name, path: r.path })),
      off: () => this.config.graph.offProjects,
      lanesRunning: () => this.lanes.listAll().filter((v) => v.state === 'running').length,
      onChange: () => {
        if (this.stopped) return;
        this.hub.broadcast({ type: 'graph', view: this.graphModule!.view() });
        this.hub.broadcast({ type: 'toolkit', view: this.toolkit.view() }); // §5.3 its graph row
        const count = `${this.graphModule!.red()}|${this.graphModule!.state() === 'ready'}`; // §5.3 K0 count line, §5.7 K1-graph
        if (count !== this.graphCount) { this.graphCount = count; this.skillsMcp.changed(); }
      },
      ...(o.graphUrls ? { latest: () => latestTag(o.graphUrls), installer: (r) => runInstaller({ ...r, urls: o.graphUrls }) } : {}),
    }) : null;
    this.lanes.on((e) => {
      if (e.type === 'session_exit') this.graph?.closeSession(e.sessionId);
      if (e.type === 'lane' && e.lane.state === 'done') void this.graphIndexes?.laneDone(); // §5.5 clean-up when a lane is done
    });
    this.orchestrators.on((e) => { if (e.type === 'session_exit') this.graph?.closeSession(e.sessionId); });
    this.cards = new CardStore({ db: this.db, ...(o.cardTimers ? { timers: o.cardTimers } : {}), sessions: laneCardSessions(this.lanes, this.outbox, orchestratorCardSessions(this.orchestrators, this.outbox)) });
    attachLaneCards(this.cards, this.lanes);
    attachOrchestratorCards(this.cards, this.orchestrators);
    attachSystemCards(this.cards, this.db, { lanes: this.lanes, orchestrators: this.orchestrators });

    const gitExec = o.gitExec ?? loginExec;
    this.gitExec = gitExec;
    this.ghPath = o.gh === undefined ? findOnPath('gh', login.env.PATH) : null;
    const gh = o.gh ?? (this.ghPath ? ghLookup(loginExec, this.ghPath) : null);
    this.branches = new BranchTracker({
      db: this.db, exec: gitExec, ...(gh ? { gh } : {}),
      repoOf: (id) => this.projectRow(id)?.path ?? null,
      onChange: (projectId, name) => {
        if (this.stopped) return;
        const v = this.laneView(projectId, name);
        if (v) this.hub.broadcast({ type: 'lane', lane: v });
        const pv = this.projectView(projectId);
        if (pv) this.hub.broadcast({ type: 'project', project: pv });
      },
      onCommit: (projectId, name) => this.code.committed(projectId, name),
    });

    this.update = new UpdateHold<Conn>({
      gate, busy: () => sessionsBusy(this.lanes, this.orchestrators, [...this.authors.busy(), ...gate.spawning()]), held: (since) => heldSince(this.db, since, gate),
      ready: (c) => this.updateReady(c), failed: (err) => this.log(`update backup: ${err.message}`),
      committed: () => this.writeUpdateResume(), released: () => rmSync(join(paths().home, 'update-resume.json'), { force: true }),
      changed: () => { if (!this.stopped) this.hub.broadcast({ type: 'engine', engine: this.engineInfo() }); },
      ...(o.updateTickMs !== undefined ? { tickMs: o.updateTickMs } : {}),
    });
    this.hub = new WsHub({
      snapshot: (ch) => this.snapshot(ch),
      handlers: (c) => buildHandlers(this, c),
      onPresentMac: (n) => this.tracker.setUiOpen(n > 0),
      onClose: (c) => this.update.closed(c),
    });
    this.outbox.onPoWritten((t, seqs) => { if (!this.stopped) poWritten(this, t, seqs); }); // v2.6 §10.3 the label goes
    this.notifier = new Notifier({
      project: (id) => {
        const r = this.projectRow(id);
        return r ? { name: r.name, gchatWebhook: r.gchat_webhook, gchatSendCommandText: r.gchat_send_command_text === 1 } : null;
      },
      projectIds: () => this.projectRows().map((r) => r.id),
      targetOf: (c) => this.targetOfSession(c.sessionId),
      emit: (e) => this.hub.broadcast(e),
      appConnected: () => this.hub.macCount > 0,
      viewing: (t) => this.hub.viewing(t),
      seqOf: (t) => notifySeq(this.db, t, this.orchestrators.list(t.projectId).length),
      osascript: o.notify?.osascript ?? osascriptNotify,
      postGchat: o.notify?.postGchat ?? postGchat,
      remote: () => ({ enabled: false, hostname: null }), // group 5
      prefs: () => ({ notify: this.config.notify, sound: this.config.sound }), // Cài đặt › Thông báo, read at send time
      lang: () => this.config.ui?.lang ?? 'vi', // §6A read at send time: a switch applies to the next notification
      log: this.log,
    });
    this.skillsMcp = new SkillsMcp(this);
    this.workflows = new WorkflowLibrary({
      home: paths().home, trashHome: login.env.HOME || homedir(), db: this.db, log: this.log,
      env: () => ({ plugins: new Set(this.skillsMcp.installedPlugins()) }), // §5.4 the `require_plugins` warning
      onChange: () => { if (!this.stopped) this.hub.broadcast({ type: 'workflows_changed', rows: this.workflows.list() }); },
    });
    this.toolkit = new Toolkit({
      claudeHome: () => paths().claudeHome, claudePath: () => this.login.claudePath, exec: loginExec,
      git: async (fresh) => (fresh || !this.setup ? await this.runSetupCheck() : this.setup).git,
      needsLogin: (id) => this.skillsMcp.oauth.view(id)?.needsLogin != null && !this.config.mcp.noLogin.includes(id),
      offForLanes: () => this.config.plugins.offForLanes,
      afterWrite: () => { // §5.2 step (3): MCP + skill catalogs re-read (stat-checked sources), settings.json copied to the accounts
        this.skillsMcp.projectsChanged();
        this.logMirror(mirrorSettings(paths().claudeHome, this.accounts.filter((a) => !a.terminal).map((a) => a.configDir)));
      },
      onChange: () => { if (!this.stopped) this.hub.broadcast({ type: 'toolkit', view: this.toolkit.view() }); },
      ...(this.graphModule ? { graph: { tool: () => this.graphModule!.view().tool, install: () => this.graphModule!.install('install') } } : {}),
    });
    this.authors = new AuthorSessions({
      home: paths().home, db: this.db, outbox: this.outbox, library: this.workflows, pick: common, command, env, port, gate,
      session: common.session, model: () => this.config.modelDefaults?.orchestrator.model ?? null,
      installed: () => {
        const v = this.skillsMcp.view().skills;
        return { skills: v.rows.map((r) => (r.scope === 'plugin' ? `${r.id.split(':')[1]?.split('@')[0] ?? ''}:${r.name}` : r.name)).sort(), plugins: v.plugins.map((x) => x.key.split('@')[0]!).sort() };
      },
      emit: (e) => { if (!this.stopped) this.hub.broadcast(e); }, log: this.log,
    });
    this.code = new CodeArea(this);
    this.issues = new IssuesArea(this);
    this.wire();
  }

  readonly log: (line: string) => void;

  static async start(o: EngineOptions): Promise<Engine> {
    ensureHome();
    writeSkillGate(); // v2.7 §7.3 R-B9 the Skill hook every session's --settings points at (rewritten each boot)
    let login = o.loginEnv ?? await loadLoginEnv();
    // hotfix 2026-11-16 (b) G2: Xcode's license (or no tools) blocks git while the Command Line Tools git works → its
    // DEVELOPER_DIR for engine git and every session (never over one the login env has)
    const dev = await cltFallback({ exec: o.gitExec ?? execIn(stripEnv(login.env)), env: login.env });
    if (dev) login = { ...login, env: { ...login.env, DEVELOPER_DIR: dev } };
    // The MCP port must be known before sessions spawn: bind first, route through the engine once it exists.
    let engine: Engine | null = null;
    const hubProxy = {
      open: (c: Parameters<WsHub['open']>[0]) => engine!.hub.open(c),
      close: (c: Parameters<WsHub['close']>[0]) => engine?.hub.close(c),
      message: (c: Parameters<WsHub['message']>[0], raw: string) => engine!.hub.message(c, raw),
    } as unknown as WsHub;
    let mcp: ((r: Request) => Promise<Response>) | null = null;
    let mcpDraft: ((r: Request) => Promise<Response>) | null = null;
    let proxy: ReturnType<typeof createMcpProxy> | null = null;
    let graphGate: ((r: Request) => Promise<Response>) | null = null;
    let built: Engine | null = null;
    const server = startHttp({
      ...(o.hostname ? { hostname: o.hostname } : {}), port: o.port, token: () => o.token, staticDir: o.staticDir,
      mcp: async (r) => (mcp ? mcp(r) : new Response('engine đang khởi động', { status: 503 })), hub: hubProxy,
      mcpDraft: async (r) => (mcpDraft ? mcpDraft(r) : new Response('engine đang khởi động', { status: 503 })),
      mcpProxy: async (r) => (proxy ? proxy.handle(r) : new Response('engine đang khởi động', { status: 503 })),
      ...(o.graphModule ? { mcpGraph: async (r: Request) => (graphGate ? graphGate(r) : new Response('engine đang khởi động', { status: 503 })) } : {}),
      attach: async (r) => (engine ? attachRoute(r, engine.attach) : new Response('engine đang khởi động', { status: 503 })),
      oauthCallback: async (r) => (engine ? engine.skillsMcp.oauth.callback(r) : new Response('engine đang khởi động', { status: 503 })),
      ready: () => engine !== null, health: () => engine!.health(),
    });
    try {
      const e = built = new Engine(o, login, server.port ?? o.port);
      e.server = server;
      if (dev) e.log(`git: Xcode chặn git → dùng Command Line Tools (DEVELOPER_DIR=${dev})`);
      // v2.2 §5.2 / §5.3; K1-local rows resolve too (a §5.4b check only: no session's `mcpIds` ever holds their id).
      proxy = createMcpProxy({ tokens: e.tokens, upstream: (id) => upstreamOf(e.catalog(), id) ?? upstreamOf(e.skillsMcp.unusedEntries(), id), auth: e.skillsMcp.oauth, fetch: e.fetch });
      e.mcpProxy = proxy;
      const graph = e.graph;
      if (graph) {
        await graph.start(); // v2.5 §5.7 before any spawn: the session MCP set depends on the module state
        const idx = e.graphIndexes!;
        graphGate = createGraphGate({
          known: (t) => e.tokens.resolve(t) !== null, session: (t) => { const who = e.tokens.resolve(t); return who?.graph ? graph.session(who.sessionId) : null; },
          ready: () => graph.ready(), index: (t, root, args) => idx.laneIndex(e.tokens.resolve(t)!.projectId, root, args), indexed: (root) => idx.status(root),
        });
      }
      mcp = createMcpHandler({
        tokens: e.tokens,
        tools: {
          lanes: e.mcpLanes(), cards: e.cards, usage: () => e.accountViews(),
          notify: (p, level, text) => { void e.notifier.orchestratorNote(p, level, text); },
          worktreeExists: (cwd) => existsSync(cwd), owners: e.orchestrators.ownerPort(),
          issues: {
            db: e.db, exec: e.gitExec, events: e.issueEvents, rename: (sid, title) => { e.orchestrators.rename(sid, title); },
            closeWhenIdle: (sid) => { void e.orchestrators.closeWhenIdle(sid); },
            missingPlugin: (projectId, plugins) => e.issues.missingPlugin(projectId, plugins), changed: (p) => e.issues.changed(p),
            startNext: (projectId, path) => startNextStep(e, projectId, path),
            conflict: (orig, revert, detail) => { e.issues.revertConflicted(orig, revert, detail); },
          },
        },
      });
      // v2 §6 / §8: a login cut off by a restart (its processes, its dir with no row); at boot none of ours can run.
      await e.sweepLogins();
      // v2 §5.5 boot check of every account before anything spawns; then the ~/.claude root watch.
      e.checkAllSharedCfg();
      e.scanClaudeRoot();
      // §7.1 recovery: pending permission requests died with the old engine, then resume sessions.
      e.cards.cancelOrphanPermissions();
      logMissingRevs(e.log); // ruling 22:36 a missing pinned rev read off the spawn path
      try { e.workflows.boot(); } catch (err) { e.log(`workflows: ${err instanceof Error ? err.message : String(err)}`); } // v2.9 §6.1 before any spawn
      mcpDraft = createDraftMcpHandler({ draftOfToken: (t) => e.authors.draftOfToken(t), save: (id, name) => e.authors.callSave(id, name) });
      e.authors.boot(); // v2.9 §4.10 drafts live across restarts (idle; each resumes at its next message)
      seedPrevLanes(e); // before restore: a restored lane's first event compares against its stored state
      e.catalog(); // v2.2 §5.1 warm: the first read + fs.watch start costs ~0.9 s cold (measured), a spawn then ≤ 1 ms
      const rec = await recover({ db: e.db, lanes: e.lanes, orchestrators: e.orchestrators, ...(o.ps ? { ps: o.ps } : {}), ...(o.kill ? { kill: o.kill } : {}) });
      for (const id of rec.held) e.held.markRestored(id); // hotfix 2026-11-16: nothing resumes until the PO says so
      for (const id of takeResume(join(paths().home, 'update-resume.json'), Date.now())) await e.held.wakeAfterUpdate(id); // v2.6 §5.5-4 R22
      e.syncCutover(); // §7.1-3: a stale card from the last run is re-counted or resolved
      for (const r of e.projectRows()) { // v2.7 §5.2-7 project open = engine start (and project_add)
        try { e.issues.scan(r.id); } catch (err) { e.log(`spec scan ${r.id}: ${err instanceof Error ? err.message : String(err)}`); }
      }
      engine = e;
      e.startSettingsMirror();
      // hf1116 T1: a change there may be a terminal /login too → the registry re-read (it re-checks shared config)
      e.stopRootWatch = watchClaudeRoot(paths().claudeHome, () => { if (!e.stopped) { e.scanClaudeRoot(); e.refreshAccounts(); } });
      e.startTimers();
      e.skillsMcp.start();
      e.workflows.start(o.workflowPollMs ?? 2000);
      void e.runSetupCheck();
      void e.checkAuth(); // §6 A2: in the background — boot never waits for `claude auth status`
      return e;
    } catch (err) {
      void server.stop(true);
      built?.graph?.stop(); // a failed start leaves no front behind
      throw err;
    }
  }

  get port(): number { return this.server.port ?? this.o.port; }

  // ---------- views ----------

  /** v2.2 §5.1 the MCP catalog over every added project root, with the config switches applied. */
  catalog(): CatalogEntry[] {
    return this.mcpCatalog.get(this.projectRows().map((r) => ({ id: r.id, path: r.path })), catalogPrefs(this.config));
  }

  /** Open projects (hotfix 2026-11-16: a closed one is gone from the UI, catalog, notifications and commands). */
  projectRows(): ProjectRow[] {
    return this.db.query<ProjectRow, []>(`SELECT ${PROJECT_COLS} FROM project WHERE closed_at IS NULL ORDER BY created_at, id`).all();
  }
  projectRow(id: string): ProjectRow | null {
    return this.db.query<ProjectRow, [string]>(`SELECT ${PROJECT_COLS} FROM project WHERE id = ? AND closed_at IS NULL`).get(id) ?? null;
  }

  projectView(id: string): ProjectView | null { return buildProjectView(this, id); }
  branchOnWatch(projectId: string, name: string): void { branchOnWatch(this, projectId, name); }
  laneView(projectId: string, name: string): LaneView | null { return buildLaneView(this, projectId, name); }
  /** The lanes a snapshot shows for one project (hotfix 2026-11-16: a reopened project's lanes go out again). */
  snapshotLanes(projectId: string): LaneView[] { return snapshotLanes(this, projectId); }
  engineInfo(): EngineInfo { return engineInfo(this); }

  /** v2.6 §5.4-5 nothing mid-turn: back up `state.db`, then `update_ready` to the holding WS only. A failed backup throws (UpdateHold backs off). */
  private updateReady(c: Conn): void {
    const backup = backupState(this.db, { dir: join(paths().home, 'backups'), version: this.o.version });
    c.send({ type: 'event', event: { type: 'update_ready', backup } });
  }
  /** v2.6 §5.5-4 (R22) commit ok: the projects not held now wake at the next boot. A failed write only logs (all stay held). */
  private writeUpdateResume(): void {
    const projects = this.projectRows().map((r) => r.id).filter((id) => this.held.view(id) === null);
    try { writeResume(join(paths().home, 'update-resume.json'), { from: this.o.version, at: Date.now(), projects }); }
    catch (err) { this.log(`update resume: ${(err as Error).message}`); }
  }
  snapshot(channel: Channel): Snapshot { return snapshot(this, channel); }
  tokenStats(nowMs = Date.now()): TokenStats { return buildTokenStats(this, nowMs); }
  pushSubagents(c: Conn): void { pushSubagents(this, c); }
  configView(): Record<string, unknown> { return configView(this); }
  health(): Health { return health(this); }
  orchView(v: OrchestratorRtView): OrchestratorView { return orchView(this, v); }
  cardViewOf(c: Card): CardView { return cardViewOf(this, c); }

  // ---------- sessions and targets (engine/sessions.ts) ----------

  markInTurn(sessionId: string, content: string): void { markInTurn(this, sessionId, content); }
  targetOfSession(sid: string | null): Target | null { return targetOfSession(this, sid); }
  sessionsOf(t: Target): string[] { return sessionsOf(this, t); }
  continueDeps(): ContinueDeps { return continueDeps(this); }
  continueLane(projectId: string, name: string, toSession: string, account?: string): Promise<LaneView> { return continueLane(this, projectId, name, toSession, account); }
  sessionsList(projectId: string): SessionsList { return sessionsList(this, projectId); }

  // ---------- events (engine/events.ts) ----------

  scheduleStats(): void { scheduleStats(this); }
  private wire(): void { wire(this); }
  sendHeld(c: Conn): void { sendHeld(this, c); }
  versionSeen(e: { version: string; ok: boolean; message?: string }): void { versionSeen(this, e); }

  // ---------- accounts: registry, views, sign-out / delete, cutover (engine/accounts.ts) ----------

  loggedOut(): Set<string> { return loggedOut(this); }
  removeDeps(): RemoveDeps { return removeDeps(this); }
  logoutAccount(email: string): Promise<AccountView | null> { return signOutAccount(this, email); }
  deleteAccount(email: string): Promise<DeleteOutcome> { return deleteAccount(this, email); }
  readNoLogin(): Set<string> { return readNoLogin(this); }
  accountViews(): AccountView[] { return accountViews(this); }
  broadcastAccount(email: string): void { broadcastAccount(this, email); this.skillsMcp.changed(); } // C25 shared-config count
  accountChanged(email: string): void { accountChanged(this, email); }
  readRegistry(): string[] { return readRegistry(this); }
  refreshAccounts(): void { refreshAccounts(this); }
  syncCutover(): void { syncCutover(this); }
  loginRenewed(c: Card): boolean { return loginRenewed(this, c); }

  // ---------- `claude auth status` check (engine/auth-check.ts) ----------

  scheduleAuthCheck(): void { scheduleAuthCheck(this); }
  checkAuth(): Promise<void> { return checkAuth(this); }

  // ---------- account login and orphans (engine/account-login.ts) ----------

  authDeps(): RemoveDeps['auth'] { return authDeps(this); }
  startAccountLogin(opts: StartOptions): AccountLoginView { return startAccountLogin(this, opts); }
  private sweepLogins(): Promise<void> { return sweepLogins(this); }
  orphanAt(dir: string): { dir: string; email: string; who: NonNullable<ReturnType<typeof readIdentity>> } { return orphanAt(this, dir); }
  adoptOrphan(dir: string): void { adoptOrphan(this, dir); }
  deleteOrphan(dir: string): Promise<void> { return deleteOrphan(this, dir); }

  // ---------- shared config, settings mirror (engine/shared-cfg.ts) ----------

  preSpawn(dir: string): boolean { return preSpawn(this, dir); }
  laneConfig(): Config { return laneConfig(this); }
  checkSharedCfg(a: Account): SharedCfgCheck { return checkSharedCfg(this, a); }
  checkAllSharedCfg(): void { checkAllSharedCfg(this); }
  syncSharedCards(a: Account, r: SharedCfgCheck): void { syncSharedCards(this, a, r); }
  mergeSharedCfg(email: string, name: string, dryRun: boolean): (MergePlan & { copies?: ClashCopy[] }) | MergeResult { return mergeSharedCfg(this, email, name, dryRun); }
  toggleShared(name: string, shared: boolean): { sharedExtra: string[] } { return toggleShared(this, name, shared); }
  scanClaudeRoot(): void { scanClaudeRoot(this); }
  accountsInfo(): Promise<AccountsInfo> { return accountsInfo(this); }
  refreshA9(id: number, email: string, name: string, plan: MergePlan): void { refreshA9(this, id, email, name, plan); }
  clashPath(email: string, name: string, file: string): string | null { return clashPath(this, email, name, file); }
  logMirror(r: { errors: string[] }): void { logMirror(this, r); }
  private startSettingsMirror(): void { startSettingsMirror(this); }

  /** v2.5 §5.7 the session's graph entry: managed module → on unless `graph.offProjects` holds the project; else null (v2.2 catalog). */
  graphSetup(projectId: string): { on: boolean } | null {
    return this.graph?.managed() ? { on: !this.config.graph.offProjects.includes(projectId) } : null;
  }

  /** v2.5 §5.5 the graph was turned on for a project: its root is indexed when it has none. */
  graphProjectOn(projectId: string): void {
    const p = this.projectRows().find((r) => r.id === projectId);
    if (p) void this.graphIndexes?.projectAdded(p.id, p.path);
  }

  /** §7.1: the caps.json / config.json import has run, so the account table is the one source of lane limits. */
  registryImported(): boolean {
    return getMeta(this.db, CAPS_IMPORTED_KEY) !== null;
  }

  async runSetupCheck(): Promise<SetupStatus> {
    const s = await setupCheck({
      exec: this.exec, claudePath: () => this.login.claudePath,
      accounts: () => this.accounts, loggedOut: () => this.loggedOut(), poEmail: () => getMeta(this.db, 'po_email'),
      git: () => gitCheck({ exec: this.gitExec, env: this.login.env, ghPath: this.ghPath, ghLogin: this.ghLogin?.view() ?? null }),
    });
    if (this.stopped) return s;
    this.setup = s;
    this.hub.broadcast({ type: 'setup', setup: s });
    this.hub.broadcast({ type: 'engine', engine: this.engineInfo() });
    return s;
  }

  /** hotfix 2026-11-16 (b) the gh login row changed: the last setup status with it, no re-check. */
  patchGhLogin(v: GhLoginView | null): void {
    if (!this.setup || this.stopped) return;
    this.setup = { ...this.setup, git: { ...this.setup.git, ghLogin: v } };
    this.hub.broadcast({ type: 'setup', setup: this.setup });
  }

  /** The registry dir of an account (never a client-supplied path). */
  accountDir(email: string): string | null {
    return this.accounts.find((a) => a.email === email.trim().toLowerCase())?.configDir ?? null;
  }

  /** A4 §3.2 SA6 "Mở cửa sổ riêng tư" (best effort; `ok:false` → the UI shows "Sao chép link"). */
  openPrivate(url: string): Promise<OpenResult> {
    return openPrivate(url, this.o.browserExec);
  }

  private startTimers(): void {
    const acc = this.o.accountsEveryMs ?? 30_000;
    const q = this.o.quotaEveryMs ?? 30_000;
    if (acc > 0) this.timers.push(setInterval(() => this.refreshAccounts(), acc));
    const bp = this.o.branchPollMs ?? 5 * 60_000; // §4.15 base moved → re-measure; only while a client is connected
    if (bp > 0) this.timers.push(setInterval(() => { if (!this.stopped && this.hub.size > 0) void this.branches.pollBases(); }, bp));
    const sw = this.o.attachSweepMs ?? 0;
    if (sw > 0) {
      this.attach.sweep({ startup: true }); // throws without CC_SLAVES_ATTACH when CC_SLAVES_HOME is overridden (A11)
      this.timers.push(setInterval(() => { try { this.attach.sweep(); } catch (e) { this.log(`attach sweep: ${(e as Error).message}`); } }, sw));
    }
    const st = this.o.statsEveryMs ?? 60_000;
    if (st > 0) this.timers.push(setInterval(() => { if (!this.stopped && this.hub.size > 0) this.hub.broadcast({ type: 'stats', stats: this.tokenStats() }); }, st));
    if (q > 0) {
      this.timers.push(setInterval(() => { if (this.config.quotaReading) this.quotaTick(false); }, q));
      // v2.7.1 §7.1-3: the manual queue is asked every 5 s so the 20 s gap does not stretch to the 30 s tick
      this.timers.push(setInterval(() => this.quotaTick(true), Math.min(q, 5_000)));
    }
  }

  /** One quota tick (§7.1); `manualOnly` = only the `quota_refresh` queue (it runs whatever `quotaReading` says). */
  quotaTick(manualOnly: boolean): void {
    if (this.stopped) return;
    void this.tracker.tick(this.accounts, manualOnly).catch((e: Error) => this.log(`quota: ${e.message}`));
  }

  /** MCP lanes with the F17 guard on `lane_start`. */
  mcpLanes(): McpLanes {
    const m = this.lanes;
    return {
      list: (p) => m.list(p), message: (...a) => m.message(...a), interrupt: (...a) => m.interrupt(...a),
      stop: (...a) => m.stop(...a), resume: (...a) => m.resume(...a), finish: (...a) => m.finish(...a),
      result: (...a) => m.result(...a), tail: (...a) => m.tail(...a), setPhase: (...a) => m.setPhase(...a),
      bySession: (s) => m.bySession(s),
      start: async (i: StartInput) => {
        if (this.compat) {
          throw new LaneError('incompatible',
            { key: 'errors.incompatible', params: { version: this.compat.version, detail: this.compat.message } });
        }
        return m.start(i);
      },
    };
  }

  busyLanes(): string[] {
    return this.lanes.listAll().filter((v) => BUSY.includes(v.state)).map((v) => `${v.projectId}/${v.name}`);
  }

  broadcast(e: EngineEvent): void { this.hub.broadcast(e); }

  /** §7.1 graceful stop: no new connections or commands, sessions closed (state stays in state.db for recovery). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.statsTimer !== null) clearTimeout(this.statsTimer);
    if (this.authTimer !== null) clearTimeout(this.authTimer);
    this.stopSettingsWatch();
    this.stopRootWatch();
    this.update.stop();
    this.mcpCatalog.close();
    this.skillsMcp.stop();
    this.workflows.stop();
    await this.authors.stop();
    void this.server.stop(true);
    this.cards.shutdown();
    this.issueEvents.stop();
    await this.orchestrators.shutdown();
    await this.lanes.shutdown();
    // IMPORTANT-1 §3.2 SA1: a login left running would outlive the engine (detached groups) and could land a token with
    // no row; cancel kills both groups (and drops an add-mode dir) while the db is still open.
    await activeLogin()?.cancel();
    await this.ghLogin?.cancel();
    await this.graphModule?.shutdown(); // review-e IMPORTANT-1: a running installer's whole group, before its fronts close
    this.graph?.stop();
    this.db.close();
  }
}
