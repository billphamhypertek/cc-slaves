// v2.2 §5.4b / §8 "Kiểm tra": the minimal MCP client against `fake-mcp` through the proxy's in-process `forward`
// (three transports, needs-login, foreign endpoint, timeout), a stdio fixture server (pagination, `${VAR}`, exit,
// timeout + process-group kill), and C22 on a real engine: an unapproved `project:` command never runs (marker file).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeMcp, type FakeMcp } from '../../fake-mcp/src/server.ts';
import type { Command, ServerMsg, SkillsMcpView } from '../../shared/protocol.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { runProbe, type ProbeEntry } from '../src/engine/mcp-probe.ts';
import type { CatalogEntry } from '../src/mcp/catalog.ts';
import { probeRemote, probeStdio } from '../src/mcp/probe.ts';
import { createMcpProxy, upstreamOf, type McpProxy, type UpstreamAuth } from '../src/mcp/proxy.ts';
import { TokenRegistry } from '../src/mcp/server.ts';
import type { Db } from '../src/db.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { route } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FIXTURE = resolve(import.meta.dir, '../test/_fixtures/stdio-mcp.ts');
const FAKE_CLAUDE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const BUN = process.execPath;
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let fake: FakeMcp;
let catalog: CatalogEntry[];
let proxy: McpProxy;
/** No token unless `current`; refresh always fails ('error'); records the proxy's 401 / 403 marks (the OAuth client's seam). */
class MarkAuth implements UpstreamAuth {
  readonly marked = new Map<string, string | undefined>();
  /** A held token whose refresh fails at the AS (network / 5xx). */
  current: string | undefined;
  token(): string | undefined { return this.current; }
  refresh(): Promise<'error'> { return Promise.resolve('error'); }
  markNeedsLogin(id: string, scope?: string): void { this.marked.set(id, scope); }
}
let auth: MarkAuth;

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(20); }
}
const remote = (id: string, kind: 'http' | 'sse', path: string, extra: Record<string, unknown> = {}): ProbeEntry =>
  ({ id, source: 'user', kind, config: { type: kind, url: `${fake.origin}${path}`, ...extra }, forLanes: true, unused: false, error: false });
const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: tmp });
const deps = () => ({ proxy, fetch, env: env(), cwd: tmp });

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-probe-')));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'user', '.claude');
  process.env.CLAUDE_JSON = join(tmp, 'user', '.claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'user', '.claude', 'skills'), { recursive: true });
  fake = startFakeMcp();
  const ids = [['user:v3', '/v3/mcp', 'http'], ['user:v2', '/v2/mcp', 'http'], ['user:legacy', '/sse', 'sse']] as const;
  catalog = ids.map(([id, path, kind]) => ({ id, name: id.slice(5), source: 'user', kind, config: { type: kind, url: `${fake.origin}${path}` }, forLanes: true }));
  auth = new MarkAuth();
  proxy = createMcpProxy({ tokens: new TokenRegistry({} as Db), upstream: (id) => upstreamOf(catalog, id), auth });
});

afterAll(() => {
  fake.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§5.4b remote check through the proxy forward (in process, no session token)', () => {
  test('§5.4b initialize + tools/list over 2026-07-28, 2025-11-25 (session + DELETE) and legacy HTTP+SSE', async () => {
    for (const [id, path, kind] of [['user:v3', '/v3/mcp', 'http'], ['user:v2', '/v2/mcp', 'http'], ['user:legacy', '/sse', 'sse']] as const) {
      const r = await runProbe(remote(id, kind, path), deps());
      expect([id, r.state, r.tools, r.error]).toEqual([id, 'connected', ['tick'], null]);
    }
    await until(() => fake.seen.some((s) => s.method === 'DELETE' && s.path === '/v2/mcp'), 'v2 session DELETE');
    const v2 = fake.seen.filter((s) => s.path === '/v2/mcp' && s.method === 'POST');
    expect(v2.map((s) => (JSON.parse(s.body) as { method: string }).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(v2.at(-1)!.headers['mcp-session-id']).toBeTruthy();
    expect(proxy.log.lines('user:v3').map((l) => l.status)).toEqual([200, 202, 200]); // §5.2 the check is logged like a lane
  });

  test('§5.2 / §5.4b upstream 401 without a token → needs_login, marked on the UpstreamAuth seam', async () => {
    fake.knobs.requireToken = 'never-issued';
    try {
      const r = await runProbe(remote('user:v3', 'http', '/v3/mcp'), deps());
      expect(r).toMatchObject({ state: 'needs_login', tools: [], error: { code: 'needs_login' } });
      expect([...auth.marked]).toEqual([['user:v3', undefined]]);
    } finally { fake.knobs.requireToken = null; auth.marked.clear(); }
  });

  test('§5.3 / G2 a refresh that fails at the AS (not invalid_grant) → the check reads network (502), no login mark', async () => {
    fake.knobs.requireToken = 'never-issued';
    auth.current = 'stale';
    try {
      const r = await runProbe(remote('user:v3', 'http', '/v3/mcp'), deps());
      expect(r).toMatchObject({ state: 'error', tools: [], error: { code: 'network' } });
      expect(proxy.log.lines('user:v3').at(-1)).toMatchObject({ status: 502, error: 'network' });
      expect(auth.marked.size).toBe(0);
    } finally { fake.knobs.requireToken = null; auth.current = undefined; auth.marked.clear(); }
  });

  test('§5.2 legacy endpoint on another host → endpoint_foreign (the token never goes there)', async () => {
    fake.knobs.endpointOrigin = 'http://evil.test:1234';
    try {
      const r = await runProbe(remote('user:legacy', 'sse', '/sse'), deps());
      expect(r).toMatchObject({ state: 'error', error: { code: 'endpoint_foreign' } });
    } finally { fake.knobs.endpointOrigin = null; }
  });

  test('§5.4b a server slower than the check limit → timeout, on time', async () => {
    fake.knobs.headerDelayMs = 2000;
    try {
      const t0 = Date.now();
      const r = await probeRemote({ base: 'http://127.0.0.1/mcp-proxy/user%3Av3', legacySse: false, send: (u, i) => proxy.forward('user:v3', new Request(u, i), i.signal!) }, 300);
      expect(r).toMatchObject({ state: 'error', error: { code: 'timeout' } });
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally { fake.knobs.headerDelayMs = 0; }
  });

  test('§5.1 C9 an entry with its own Authorization header is checked straight, `${VAR}` expanded from the session env', async () => {
    fake.knobs.requireToken = 'tk-42';
    try {
      const e = remote('user:own', 'http', '/v3/mcp', { headers: { Authorization: 'Bearer ${OWN_TOKEN}' } });
      const r = await runProbe(e, { ...deps(), env: { ...env(), OWN_TOKEN: 'tk-42' } });
      expect(r).toMatchObject({ state: 'connected', tools: ['tick'] });
      expect(proxy.log.lines('user:own')).toEqual([]);
    } finally { fake.knobs.requireToken = null; }
  });

  test('§5.2 C9 a self-auth legacy server whose endpoint is on another host → endpoint_foreign; its header never goes there', async () => {
    fake.knobs.endpointOrigin = 'http://127.0.0.1:1';
    const sent: string[] = [];
    try {
      const e = remote('user:own-sse', 'sse', '/sse', { headers: { Authorization: 'Bearer own' } });
      const r = await runProbe(e, { ...deps(), fetch: ((u: string, i?: RequestInit) => { sent.push(u); return fetch(u, i); }) as typeof fetch });
      expect(r).toMatchObject({ state: 'error', error: { code: 'endpoint_foreign' } });
      expect(sent).toEqual([`${fake.origin}/sse`]);
    } finally { fake.knobs.endpointOrigin = null; }
  });
});

const stdio = (o: { env?: Record<string, string>; args?: string[]; command?: string } = {}): ProbeEntry =>
  ({ id: 'user:fx', source: 'user', kind: 'stdio', config: { command: o.command ?? BUN, args: o.args ?? [FIXTURE], env: o.env ?? {} }, forLanes: true, unused: false, error: false });

describe('§5.4b local check: spawn, JSON-RPC over stdio, process group killed', () => {
  test('§5.4b tools over every tools/list page; the entry env with ${VAR} reaches the child; the leader is gone after', async () => {
    const pidFile = join(tmp, 'fx-ok.pid');
    const r = await runProbe(stdio({ env: { TOOL_PREFIX: '${PFX}_', MARKER: pidFile } }), { ...deps(), env: { ...env(), PFX: 'x' } });
    expect(r).toMatchObject({ state: 'connected', tools: ['x_a', 'x_b'], error: null });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => !alive(pid), 'stdio leader killed', 3000);
  });

  test('§5.4b a server that never answers → timeout; the whole group (leader + grandchild) is killed, no orphan by pid', async () => {
    const lead = join(tmp, 'fx-hang.pid');
    const child = join(tmp, 'fx-hang-child.pid');
    const r = await probeStdio({ command: BUN, args: [FIXTURE], env: { ...env(), MCP_MODE: 'hang', MARKER: lead, CHILD_PID: child }, cwd: tmp }, 500);
    expect(r).toMatchObject({ state: 'error', error: { code: 'timeout' } });
    await until(() => existsSync(child), 'grandchild pid');
    const pids = [Number(readFileSync(lead, 'utf8')), Number(readFileSync(child, 'utf8'))];
    await until(() => pids.every((p) => !alive(p)), `group ${pids.join(',')} killed`, 3000);
  });

  test('§5.4b exit before answering → exited with the stderr tail; missing command → spawn; error answer → rpc', async () => {
    expect(await runProbe(stdio({ env: { MCP_MODE: 'exit' } }), deps())).toMatchObject({ state: 'error', error: { code: 'exited', detail: 'fixture: bad config' } });
    expect(await runProbe(stdio({ command: join(tmp, 'no-such-bin') }), deps())).toMatchObject({ state: 'error', error: { code: 'spawn' } });
    expect(await runProbe(stdio({ env: { MCP_MODE: 'rpc_error' } }), deps())).toMatchObject({ state: 'error', error: { code: 'rpc', detail: 'fixture refuses' } });
  });
});

describe('§5.4b C22 on a real engine', () => {
  const O = 'o@x.test';
  let engine: Engine;
  let projectId: string;
  const marker = (n: string) => join(tmp, `marker-${n}`);
  const server = (n: string) => ({ command: BUN, args: [FIXTURE], env: { MARKER: marker(n) } });
  const conn: Conn = { channel: 'mac', watch: null, present: true, send: () => {} };
  const cmd = (command: Command): Promise<ServerMsg> => route(buildHandlers(engine, conn), { channel: 'mac' }, { type: 'command', id: 'x', command });
  const row = (v: SkillsMcpView, id: string) => v.mcp.rows.find((r) => r.id === id)!;

  beforeAll(async () => {
    const shop = join(tmp, 'shop');
    mkdirSync(join(shop, '.git'), { recursive: true });
    writeFileSync(join(shop, '.mcp.json'), JSON.stringify({ mcpServers: { pg: server('project') } }));
    writeFileSync(paths().claudeJson, JSON.stringify({ mcpServers: { fx: server('user'), off: server('user-off') }, projects: { [join(tmp, 'elsewhere')]: { mcpServers: { hcm: server('k1local') } } } }));
    writeFileSync(paths().caps, JSON.stringify({ default: { week: 99 }, [O]: { role: 'orchestrator', week: 99 } }));
    writeFileSync(paths().config, JSON.stringify({ mcp: { offForLanes: ['user:off'], projectOn: [] } }));
    const db = openDb(paths().stateDb);
    seedAccounts([O], { db });
    db.close();
    const claude = join(tmp, 'claude-bin');
    writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(BUN)} ${JSON.stringify(FAKE_CLAUDE)} "$@"\n`);
    chmodSync(claude, 0o755);
    engine = await Engine.start({
      gh: null, version: 'test', port: 0, token: 't', staticDir: null, command: ['bun', FAKE_CLAUDE],
      loginEnv: { env: env(), claudePath: claude, shellFailed: false, reason: null },
      quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
      caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
      exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
      fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
      notify: { osascript: () => {}, postGchat: async () => {} },
      session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
      log: () => {}, hasLogin: () => true, securityRun: () => ({ code: 0, stderr: '' }), authCheckTimeoutMs: 30_000,
    });
    const r = await cmd({ cmd: 'project_add', name: 'Shop', path: shop, orchestratorAccount: O });
    projectId = (r as { result: { id: string } }).result.id;
    await engine.skillsMcp.probes.idle();
  });

  afterAll(async () => { await engine?.stop(); });

  test('§5.4b C22 boot: the user server going into lanes is checked; off-for-lanes, K1-local and K7 project are not', () => {
    expect(existsSync(marker('user'))).toBe(true);
    expect(row(engine.skillsMcp.view(), 'user:fx')).toMatchObject({ status: 'connected', tools: 2, canCheck: true, probe: { tools: ['a', 'b'] } });
    for (const n of ['user-off', 'k1local', 'project']) expect([n, existsSync(marker(n))]).toEqual([n, false]);
  });

  test('§5.4b C22 F3 an unapproved project: entry → no button, "Kiểm tra" refused, its command never runs', async () => {
    const id = `project:${projectId}:pg`;
    expect(row(engine.skillsMcp.view(), id)).toMatchObject({ pending: true, canCheck: false });
    expect(await cmd({ cmd: 'mcp_check', id })).toMatchObject({ type: 'error', code: 'not_checkable' });
    engine.skillsMcp.autoProbe([id]);
    engine.skillsMcp.probes.schedule([id]); // past the filter: the run-time re-check still refuses
    await engine.skillsMcp.probes.idle();
    expect(engine.skillsMcp.probes.result(id)?.state).toBe('error');
    await Bun.sleep(200);
    expect(existsSync(marker('project'))).toBe(false);
  });

  test('§5.4b C22 K1-local stdio: no button, refused; user off-for-lanes: the PO check runs it', async () => {
    const local = engine.skillsMcp.view().mcp.rows.find((r) => r.unused !== null)!;
    expect(local.canCheck).toBe(false);
    expect(await cmd({ cmd: 'mcp_check', id: local.id })).toMatchObject({ code: 'not_checkable' });
    const r = await cmd({ cmd: 'mcp_check', id: 'user:off' });
    expect(r.type).toBe('ack');
    expect(row((r as { result: SkillsMcpView }).result, 'user:off').checking).toBe(true);
    await engine.skillsMcp.probes.idle();
    expect(existsSync(marker('user-off'))).toBe(true);
    expect(existsSync(marker('k1local'))).toBe(false);
  });

  test('§5.4b C22 once the PO approves the project entry ("Bật cho lane"), "Kiểm tra" runs it', async () => {
    const id = `project:${projectId}:pg`;
    await cmd({ cmd: 'mcp_project_enable', id, on: true });
    expect(await cmd({ cmd: 'mcp_check', id })).toMatchObject({ type: 'ack' });
    await engine.skillsMcp.probes.idle();
    expect(existsSync(marker('project'))).toBe(true);
    expect(row(engine.skillsMcp.view(), id)).toMatchObject({ status: 'connected', canCheck: true });
  });
});
