// Live smoke helpers (spec §10 "Smoke thật"): engine from source on a temp CC_SLAVES_HOME, real claude (haiku via
// CC_SLAVES_MODEL_OVERRIDE), injected WS token (CC_SLAVES_TOKEN_OVERRIDE, no Keychain write). Spends real quota —
// never run from automated tests. Layout under $SMOKE_DIR (default <tmp>/ccs-smoke):
//   home/ (CC_SLAVES_HOME)  attach/ (CC_SLAVES_ATTACH)  proj/ (temp git repo)  wt-<lane>/ (worktrees)  engine.log  token
import { Database } from 'bun:sqlite';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, EngineEvent, ServerMsg, Snapshot } from '../../shared/protocol.ts';

const ROOT = resolve(import.meta.dir, '../..');
export const DIR = process.env.SMOKE_DIR ?? join(realpathSync(tmpdir()), 'ccs-smoke');
export const HOME = join(DIR, 'home');
export const PROJ = join(DIR, 'proj');
const PORT = Number(process.env.SMOKE_PORT ?? 47870);
/** v2: the accounts live under ACCTS (CC_SLAVES_ACCOUNTS); engine-entry.ts seeds the one smoke account (TOKEN_EMAIL) there. */
const ACCTS = join(DIR, 'accounts');
/** Accounts come only from env (no default address): fail before anything spends quota. */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (smoke reads its accounts from env: SMOKE_ORCH, SMOKE_TOKEN_EMAIL, SMOKE_LANES)`);
  return v;
}
export const ORCH = need('SMOKE_ORCH');
/** The smoke account (engine-entry.ts): the terminal login identity whose token the smoke engine seeds. */
export const TOKEN_EMAIL = need('SMOKE_TOKEN_EMAIL');
/** CLAUDE_HOME of the smoke engine: a temp claude home whose only plugin is a copy of superpowers (v2.7 §7.3, G0-1). */
const CLAUDE_HOME = join(DIR, 'claude-home');
/** Two lane accounts, comma-separated. */
export const LANE_ACCOUNTS = need('SMOKE_LANES').split(',');

export const sh = (argv: string[], cwd = DIR): string => {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')} → ${r.exitCode}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

function token(): string {
  const f = join(DIR, 'token');
  if (!existsSync(f)) writeFileSync(f, crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 });
  return readFileSync(f, 'utf8');
}

/** Fresh layout: empty v2 registry (no caps.json: accounts + roles come from the wizard), git repo with one README. */
export function prepare(): void {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  mkdirSync(ACCTS, { recursive: true, mode: 0o700 });
  if (!existsSync(PROJ)) {
    mkdirSync(PROJ, { recursive: true });
    writeFileSync(join(PROJ, 'README.md'), '# smoke\n');
    sh(['git', 'init', '-q', '-b', 'main'], PROJ);
    sh(['git', 'add', '.'], PROJ);
    sh(['git', '-c', 'user.email=smoke@local', '-c', 'user.name=smoke', 'commit', '-qm', 'init'], PROJ);
  }
  if (!existsSync(CLAUDE_HOME)) superpowersCopy();
}

/** A temp claude home with superpowers enabled from a copy (the PO's plugin dir is only read). */
function superpowersCopy(): void {
  const KEY = 'superpowers@claude-plugins-official';
  const real = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')) as
    { plugins: Record<string, { installPath: string; version: string; gitCommitSha?: string }[]> };
  const src = real.plugins[KEY]?.[0];
  if (!src) throw new Error(`${KEY} is not installed in ~/.claude`);
  const plugins = join(CLAUDE_HOME, 'plugins');
  const installPath = join(plugins, 'cache', 'claude-plugins-official', 'superpowers', src.version);
  cpSync(src.installPath, installPath, { recursive: true });
  const mkt = join(plugins, 'marketplaces', 'claude-plugins-official');
  // the whole clone (~26 MB, .git too): v2.5 toolkit_check runs `marketplace update` and context7 installs from ./external_plugins
  cpSync(join(homedir(), '.claude', 'plugins', 'marketplaces', 'claude-plugins-official'), mkt, { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [KEY]: [{ scope: 'user', installPath, version: src.version, installedAt: at, lastUpdated: at, ...(src.gitCommitSha ? { gitCommitSha: src.gitCommitSha } : {}) }] } }));
  writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify({ 'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' }, installLocation: mkt, lastUpdated: at } }));
  writeFileSync(join(CLAUDE_HOME, 'settings.json'), JSON.stringify({ enabledPlugins: { [KEY]: true } }));
}

export function worktree(name: string): string {
  const wt = join(DIR, `wt-${name}`);
  if (!existsSync(wt)) sh(['git', 'worktree', 'add', '-q', wt, '-b', name], PROJ);
  writeFileSync(join(DIR, `brief-${name}.md`), '');
  return wt;
}

export function brief(name: string, text: string): string {
  const p = join(DIR, `brief-${name}.md`);
  writeFileSync(p, text);
  return p;
}

/**
 * hf1116 B-M2: `CLAUDE_JSON` points at a temp file (no identity), so the engine never lists the PO's terminal login as
 * an account by itself; only `terminal: true` (smoke item `term`) lets it read the real `~/.claude.json`.
 */
function engineEnv(o: { terminal?: boolean }): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CC_SLAVES_HOME: HOME, CC_SLAVES_ACCOUNTS: ACCTS, CC_SLAVES_ATTACH: join(DIR, 'attach'), CC_SLAVES_PORT: String(PORT), CC_SLAVES_TOKEN_OVERRIDE: token(), CC_SLAVES_MODEL_OVERRIDE: 'haiku',
    CC_SLAVES_LAUNCHD_LABEL: '', CLAUDE_JSON: join(DIR, 'claude.json'),
  };
  if (o.terminal) delete env.CLAUDE_JSON;
  else Object.assign(env, { CLAUDE_HOME, SMOKE_DIR: DIR, SMOKE_TOKEN_EMAIL: TOKEN_EMAIL });
  return env;
}

/** Starts the engine detached (`scripts/smoke/engine-entry.ts`; `term`: `engine/src/main.ts` on the real terminal login) (survives this script), waits for engine.json; returns its pid. */
export async function startEngine(o: { terminal?: boolean } = {}): Promise<number> {
  const log = join(DIR, 'engine.log');
  const p = Bun.spawn(['bash', '-c', `set -m; nohup bun ${join(ROOT, o.terminal ? 'engine/src/main.ts' : 'scripts/smoke/engine-entry.ts')} >>"${log}" 2>&1 & echo $!`], { env: engineEnv(o), stdout: 'pipe' });
  const pid = Number((await new Response(p.stdout).text()).trim());
  const ej = join(HOME, 'engine.json');
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (existsSync(ej) && (JSON.parse(readFileSync(ej, 'utf8')) as { pid?: number }).pid === pid) return pid;
    await Bun.sleep(200);
  }
  throw new Error(`engine did not boot; see ${log}`);
}

export const enginePid = (): number | null => {
  try { return (JSON.parse(readFileSync(join(HOME, 'engine.json'), 'utf8')) as { pid: number }).pid; } catch { return null; }
};

/** SIGTERM the running engine and wait for its engine.json to go; returns the pid it stopped (null = none ran). */
export async function stopEngine(): Promise<number | null> {
  const pid = enginePid();
  if (pid) { process.kill(pid, 'SIGTERM'); for (let i = 0; i < 100 && existsSync(join(HOME, 'engine.json')); i++) await Bun.sleep(100); }
  return pid;
}

const db = (): Database => new Database(join(HOME, 'state.db'), { readonly: true });
export function q<T>(sql: string, ...args: (string | number)[]): T[] {
  const d = db();
  try { return d.query(sql).all(...args) as T[]; } finally { d.close(); }
}

export class Client {
  snapshot!: Snapshot;
  readonly events: EngineEvent[] = [];
  private ws!: WebSocket;
  private n = 0;
  private readonly pending = new Map<string, { ok: (v: unknown) => void; err: (e: Error) => void }>();
  private waiters: { pred: (e: EngineEvent) => boolean; ok: (e: EngineEvent) => void }[] = [];

  static async connect(): Promise<Client> {
    const c = new Client();
    await new Promise<void>((ok, err) => {
      c.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { authorization: `Bearer ${token()}`, origin: `http://127.0.0.1:${PORT}` } } as unknown as string[]);
      c.ws.onerror = () => err(new Error('ws error'));
      c.ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as ServerMsg;
        if (msg.type === 'snapshot') { c.snapshot = msg.snapshot; ok(); return; }
        if (msg.type === 'event') {
          c.events.push(msg.event);
          c.waiters = c.waiters.filter((w) => (w.pred(msg.event) ? (w.ok(msg.event), false) : true));
          return;
        }
        const p = c.pending.get(msg.id);
        if (!p) return;
        c.pending.delete(msg.id);
        if (msg.type === 'ack') p.ok(msg.result); else p.err(new Error(`${msg.code}: ${msg.message}`));
      };
    });
    return c;
  }

  cmd<T = unknown>(command: Command): Promise<T> {
    const id = `s${++this.n}`;
    return new Promise<T>((ok, err) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, err });
      this.ws.send(JSON.stringify({ type: 'command', id, command }));
    });
  }

  /** Resolves on the first event (already seen since `from`, or future) matching pred. */
  wait<E extends EngineEvent = EngineEvent>(pred: (e: EngineEvent) => boolean, ms = 120_000, from = 0, what = 'event'): Promise<E> {
    const seen = this.events.slice(from).find(pred);
    if (seen) return Promise.resolve(seen as E);
    return new Promise<E>((ok, err) => {
      const t = setTimeout(() => err(new Error(`timeout waiting for ${what}`)), ms);
      this.waiters.push({ pred, ok: (e) => { clearTimeout(t); ok(e as E); } });
    });
  }

  mark(): number { return this.events.length; }
  close(): void { this.ws.close(); }
}

export const isLane = (name: string, f: (l: Extract<EngineEvent, { type: 'lane' }>['lane']) => boolean) =>
  (e: EngineEvent) => e.type === 'lane' && e.lane.name === name && f(e.lane);

/** Engine MCP call with a session's bearer token (read from its mcp/<sid>.json). */
export async function mcp(sessionId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const cfg = JSON.parse(readFileSync(join(HOME, 'mcp', `${sessionId}.json`), 'utf8')) as
    { mcpServers: { cc_slaves: { headers: { Authorization: string } } } };
  const auth = cfg.mcpServers.cc_slaves.headers.Authorization;
  const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST', headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const j = await r.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };
  if (j.error || j.result?.isError) throw new Error(`mcp ${tool}: ${JSON.stringify(j.error ?? j.result)}`);
  return JSON.parse(j.result!.content[0]!.text);
}

export const orchSession = (): string =>
  q<{ id: string }>("SELECT id FROM session WHERE kind = 'orchestrator' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1")[0]!.id;
export const laneSession = (name: string): string => q<{ session_id: string }>('SELECT session_id FROM lane WHERE name = ?', name)[0]!.session_id;

/** Live `claude` pids whose argv carries this session id. */
export function claudePids(sessionId: string): number[] {
  const r = Bun.spawnSync(['pgrep', '-f', sessionId], { stdout: 'pipe' });
  return r.stdout.toString().split('\n').filter(Boolean).map(Number);
}

/** Raw stream-json lines of a session's newest run log (logs/<project>/<lane>/run-N.jsonl). */
export function runLogs(projectId: string, lane: string): string[] {
  const dir = join(HOME, 'logs', projectId, lane);
  if (!existsSync(dir)) return [];
  return Array.from(new Bun.Glob('run-*.jsonl').scanSync(dir)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).map((f) => join(dir, f));
}

export const results: { item: string; cmd: string; measured: string; ok: boolean }[] = [];
export function record(item: string, cmd: string, measured: string, ok: boolean): void {
  results.push({ item, cmd, measured, ok });
  console.log(`${ok ? '✓' : '✗'} ${item} — ${measured}`);
  writeFileSync(join(DIR, `result-${item.split(' ')[0]}.json`), JSON.stringify({ item, cmd, measured, ok }, null, 2));
}

/** v2.4 §10.2 `POST /attach` as the web sends a pasted image (Bearer + app Origin); returns the copy id. */
export async function attachUpload(name: string, bytes: Uint8Array): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${PORT}/attach`, {
    method: 'POST', body: bytes,
    headers: { authorization: `Bearer ${token()}`, origin: `http://127.0.0.1:${PORT}`, 'x-attach-name': encodeURIComponent(name), 'content-length': String(bytes.length) },
  });
  if (!r.ok) throw new Error(`attach ${r.status}: ${await r.text()}`);
  return (await r.json() as { id: string }).id;
}

/** Raw stream-json lines of every orchestrator run log of one session (design / build / general share `_orchestrator`). */
export function sessionLines(projectId: string, sessionId: string): string[] {
  return runLogs(projectId, '_orchestrator').map((f) => readFileSync(f, 'utf8')).filter((t) => t.includes(`"session_id":"${sessionId}"`))
    .flatMap((t) => t.split('\n').filter(Boolean));
}
