// v2.4 §5.4 the model list: `models[]` per account and `defaultModel` per (account, project), each remembered 60 s, read
// from a session's own process or from a short probe process (no user line → no turn, no quota, NC §8-11). The one home
// of the `list_models` / `get_settings` parsing (shapes: NC §8-1, §8-5, §8-13, §8-26).
import type { ModelInfo, SessionModels } from '../../shared/protocol.ts';

type Obj = Record<string, unknown>;
export type { ModelInfo };
export interface Applied { model: string | null; effort: string | null }
/** §5.1 / §5.6 tier 4: the model and effort settings.json (user · project · local) set; null = not set. */
export interface Configured { configured: string | null; configuredEffort: string | null }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseModels(r: Obj): ModelInfo[] {
  const rows = Array.isArray(r.models) ? (r.models as unknown[]) : [];
  return rows.flatMap((x) => {
    const o = (x ?? {}) as Obj;
    const value = str(o.value), resolvedModel = str(o.resolvedModel);
    if (value === null || resolvedModel === null) return [];
    const levels = Array.isArray(o.supportedEffortLevels) ? o.supportedEffortLevels.filter((l): l is string => typeof l === 'string') : [];
    return [{ value, resolvedModel, displayName: str(o.displayName) ?? value, effortLevels: levels }];
  });
}

/**
 * `get_settings` → `applied` and the configured default (§5.1: `model` of the `sources` layers minus `flagSettings`, the
 * later layer wins; §5.6 tier 4 effort: their `effortLevel` the same way). Layer shape `{source, settings}` measured on
 * Claude Code 2.1.325 (NC §8-26).
 */
export function parseSettings(r: Obj): { applied: Applied } & Configured {
  const a = (r.applied ?? {}) as Obj;
  let configured: string | null = null, configuredEffort: string | null = null;
  for (const l of Array.isArray(r.sources) ? (r.sources as unknown[]) : []) {
    const layer = (l ?? {}) as Obj;
    if (layer.source === 'flagSettings') continue;
    const set = (layer.settings ?? {}) as Obj;
    configured = str(set.model) ?? configured;
    configuredEffort = str(set.effortLevel) ?? configuredEffort;
  }
  return { applied: { model: str(a.model), effort: str(a.effort) }, configured, configuredEffort };
}

/** The row of an alias / value / resolved model (`[1m]` dropped). A resolved model names its alias row, not Claude Code's
 *  `default` row that comes first with the same `resolvedModel` (A3: that row is never shown, NC §8-1). */
export function findModel(models: readonly ModelInfo[], m: string | null): ModelInfo | null {
  if (m === null) return null;
  const bare = m.replace(/\[1m\]$/i, '');
  const hits = models.filter((x) => x.value === bare || x.resolvedModel === bare);
  return hits.find((x) => x.value === bare) ?? hits.find((x) => x.value !== 'default') ?? hits[0] ?? null;
}

/** §5.1 the default a session runs: the configured `model`, else the plan's (`default` row of list_models). */
export function defaultModelOf(models: readonly ModelInfo[], configured: string | null): string | null {
  return configured ?? models.find((x) => x.value === 'default')?.resolvedModel ?? null;
}

/** §5.6 tiers 2–4 of each field resolved at a spawn ("Theo mặc định"): `model` / `effort` null = tier 4 (Claude Code). */
export interface Defaults { model: string | null; effort: string | null; source: 'agent' | 'settings' | null; agent?: string }
export const CLAUDE_DEFAULTS: Defaults = Object.freeze({ model: null, effort: null, source: null });

/** §5.6 per field, first tier with a value: the agent's frontmatter (lanes), then the Settings row. */
export function tiered(settings: { model: string | null; effort: string | null }, agent?: { name: string; model: string | null; effort: string | null } | null): Defaults {
  const effort = agent?.effort ?? settings.effort;
  if (agent && agent.model !== null) return { model: agent.model, effort, source: 'agent', agent: agent.name };
  return { model: settings.model, effort, source: settings.model !== null ? 'settings' : null };
}

/** §5.5 / §5.6 the `session_models` ack: the list + the default of tiers 2–4 and where its model comes from, and tier 4
 *  alone (what Claude Code would use). */
export function sessionModels(models: ModelInfo[], configured: string | null, tier: Defaults = CLAUDE_DEFAULTS, configuredEffort: string | null = null): SessionModels {
  const claudeModel = defaultModelOf(models, configured), claudeSource = configured !== null ? 'claude' : 'plan';
  const defaultModel = tier.model ?? claudeModel;
  return {
    models, defaultModel, defaultModelName: findModel(models, defaultModel)?.displayName ?? null,
    defaultSource: tier.source ?? claudeSource, ...(tier.agent !== undefined ? { defaultAgent: tier.agent } : {}),
    defaultEffort: tier.effort, claudeModel, claudeEffort: configuredEffort, claudeSource,
  };
}

export const UNAVAILABLE: SessionModels = Object.freeze({ models: [], defaultModel: null, defaultModelName: null, unavailable: true });

const MODELS_TTL_MS = 60_000;
interface Entry<T> { at: number; v: T }

/** §5.4 the one cache: models per account, configured default per (account, project); 60 s each. */
export class ModelCache {
  private readonly lists = new Map<string, Entry<ModelInfo[]>>();
  private readonly defaults = new Map<string, Entry<Configured>>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = MODELS_TTL_MS) {}

  private fresh<T>(e: Entry<T> | undefined): e is Entry<T> { return e !== undefined && this.now() - e.at < this.ttlMs; }

  /** The account's list when read in the last 60 s, else null (read it again). */
  models(account: string): ModelInfo[] | null { const e = this.lists.get(account); return this.fresh(e) ? e.v : null; }
  /** The last list ever read for the account (display names only; never a reason to skip a read). */
  lastModels(account: string): ModelInfo[] { return this.lists.get(account)?.v ?? []; }
  putModels(account: string, list: ModelInfo[]): void { this.lists.set(account, { at: this.now(), v: list }); }

  /** settings.json's model / effort when read in the last 60 s, else null. */
  configured(account: string, projectDir: string): Configured | null {
    const e = this.defaults.get(`${account}\u0000${projectDir}`);
    return this.fresh(e) ? e.v : null;
  }
  putConfigured(account: string, projectDir: string, configured: string | null, configuredEffort: string | null = null): void {
    this.defaults.set(`${account}\u0000${projectDir}`, { at: this.now(), v: { configured, configuredEffort } });
  }
}

/** A Claude Code a probe talks to: `list_models` + `get_settings`, then stdin closes. */
export interface ProbeDeps {
  cache: ModelCache;
  /** The account's config dir; null = unknown account. */
  configDir(account: string): string | null;
  /** Hit its quota limit or logged out: `unavailable`, no spawn. */
  flagged(account: string): boolean;
  /** `engine/shared-cfg.ts` preSpawn (settings copy + check); false = flagged shared config → `unavailable`. */
  preSpawn(configDir: string): boolean;
  command: readonly string[];
  env(account: string): Record<string, string>;
  /** Cap of one probe, default 5 s (§5.4). */
  timeoutMs?: number;
}

const PROBE_MS = 5_000;
/** §5.4 the probe's argv: same setting sources as a session, nothing persisted, no MCP server at all. */
const PROBE_ARGS: readonly string[] = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'user,project,local',
  '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
];

/** §5.4 one short process: both answers, or null (error reply, exit, > cap → killed). */
async function probe(d: ProbeDeps, account: string, cwd: string): Promise<Read> {
  let proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>;
  try { // a missing project dir or binary throws ENOENT at the spawn (§5.4 error → unavailable)
    proc = Bun.spawn([...d.command, ...PROBE_ARGS], { cwd, env: d.env(account), stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  } catch { return null; }
  const replies = new Map<string, Obj | null>();
  const ids = { models: 'cc-slaves-models', settings: 'cc-slaves-settings' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let o: Obj;
        try { o = JSON.parse(line) as Obj; } catch { continue; }
        const r = (o.type === 'control_response' ? o.response ?? {} : {}) as Obj;
        if (typeof r.request_id !== 'string') continue;
        replies.set(r.request_id, r.subtype === 'success' ? ((r.response ?? {}) as Obj) : null);
        if (replies.size === 2) return true;
      }
    }
    return false;
  })().catch(() => false);
  const cap = new Promise<false>((res) => { timer = setTimeout(() => res(false), d.timeoutMs ?? PROBE_MS); });
  try {
    void proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: ids.models, request: { subtype: 'list_models' } })}\n`);
    void proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: ids.settings, request: { subtype: 'get_settings' } })}\n`);
    await proc.stdin.flush();
    const ok = await Promise.race([read, cap]);
    const m = replies.get(ids.models), s = replies.get(ids.settings);
    if (!ok || !m || !s) { proc.kill(); return null; }
    void proc.stdin.end(); // §5.4 both answers in: stdin closes, the process ends on its own (hooks: ~1 s, NC §8-26)
    setTimeout(() => proc.kill(), d.timeoutMs ?? PROBE_MS).unref();
    const { configured, configuredEffort } = parseSettings(s);
    return { list: parseModels(m), configured, configuredEffort };
  } catch {
    proc.kill();
    return null;
  } finally { clearTimeout(timer); }
}

/** What a running session can answer itself (§5.4 "có sessionId → hỏi chính tiến trình của phiên đó"). */
export type OwnProcess = () => Promise<{ list: ModelInfo[] } & Configured>;

type Read = ({ list: ModelInfo[] } & Configured) | null;

/** §5.4 `session_models`: from the cache, the session's own process, or one shared probe per (account, project);
 *  `tier` = the asker's tiers 2–4 resolved now (§5.6). */
export class ModelSource {
  private readonly inflight = new Map<string, Promise<Read>>();

  constructor(private readonly d: ProbeDeps) {}

  async list(account: string, projectDir: string, own?: OwnProcess, tier: Defaults = CLAUDE_DEFAULTS): Promise<SessionModels> {
    const r = await this.read(account, projectDir, own);
    return r ? sessionModels(r.list, r.configured, tier, r.configuredEffort) : UNAVAILABLE;
  }

  private async read(account: string, projectDir: string, own?: OwnProcess): Promise<Read> {
    const { cache } = this.d;
    const list = cache.models(account), conf = cache.configured(account, projectDir);
    if (list && conf) return { list, ...conf };
    if (own) {
      try {
        const r = await own();
        cache.putModels(account, r.list);
        cache.putConfigured(account, projectDir, r.configured, r.configuredEffort);
        return r;
      } catch { /* no process / no reply in time → probe */ }
    }
    const key = `${account}\u0000${projectDir}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.probe(account, projectDir).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async probe(account: string, projectDir: string): Promise<Read> {
    const dir = this.d.configDir(account);
    if (dir === null || this.d.flagged(account) || !this.d.preSpawn(dir)) return null;
    const r = await probe(this.d, account, projectDir);
    if (!r) return null;
    this.d.cache.putModels(account, r.list);
    this.d.cache.putConfigured(account, projectDir, r.configured, r.configuredEffort);
    return r;
  }
}
