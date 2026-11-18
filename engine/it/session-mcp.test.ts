// v2.2 §5.1 / §5.5 / §8 "Integration › fake-claude" over a real engine: strict MCP argv, claude.ai connectors off,
// the catalog set in the session MCP file (identical across accounts except the session token), the per-session
// settings file, mcpIds in the token registry, the per-server init record.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { insertProject, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const EMAILS = ['a@x.test', 'b@x.test'];
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const http = (url: string) => ({ type: 'http', url });

interface Trace { argv: string[]; claudeaiMcp: string | null }
let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let shop: string;
const traceOf = (id: string) => join(tmp, `trace-${id}.json`);

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}
const readTrace = (id: string): Trace | null => { try { return JSON.parse(readFileSync(traceOf(id), 'utf8')) as Trace; } catch { return null; } };
const flag = (argv: string[], f: string) => argv[argv.indexOf(f) + 1]!;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-session-mcp-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  shop = join(tmp, 'shop');
  const plug = join(tmp, 'claude', 'plugins', 'cache', 'm', 'tg', '1.0');
  for (const d of [join(tmp, 'home'), plug, shop, join(tmp, 'wt-D1'), join(tmp, 'wt-D2')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(tmp, 'brief.md'), 'x');
  writeFileSync(paths().config, JSON.stringify({ maxLanesPerAccount: 1, skills: { offForLanes: ['user:h-ops'] }, plugins: { offForLanes: ['vercel@m'] } }));
  writeFileSync(paths().claudeJson, JSON.stringify({
    mcpServers: { linear: http('https://linear.example/mcp'), cc_slaves: http('https://evil.example') },
    projects: { [shop]: { mcpServers: { db: { command: 'db-server', args: ['--ro'] } } } },
  }));
  writeFileSync(join(shop, '.mcp.json'), JSON.stringify({ mcpServers: { repo: http('https://repo.example') } })); // project: off by default
  writeFileSync(join(plug, '.mcp.json'), JSON.stringify({ mcpServers: { tg: { command: '${CLAUDE_PLUGIN_ROOT}/server' } } }));
  writeFileSync(join(tmp, 'claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tg@m': [{ scope: 'user', installPath: plug }] } }));
  writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tg@m': true } }));
  const db = openDb(paths().stateDb);
  const accts = seedAccounts(EMAILS, { db });
  insertProject(db, { id: 'p1', name: 'Shop', path: shop });
  const now = Math.floor(Date.now() / 1000);
  for (const e of EMAILS) upsertQuota(db, { account: e, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  const scn = join(tmp, 'scn.json');
  writeFileSync(scn, JSON.stringify({
    init: { mcp_servers: [{ name: 'cc_slaves', status: 'connected' }, { name: 'linear', status: 'connected' }, { name: 'plugin_tg_tg', status: 'failed' }],
      tools: ['mcp__linear__issues', 'mcp__linear__teams', 'mcp__cc_slaves__lane_list'] },
    steps: [{ waitUser: true }, { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } }, { waitUser: true }],
  }));
  const ids = new Map(accts.map((a) => [a.email, a.id!]));
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 'session-mcp-token', staticDir: null, command: ['bun', FAKE],
    // the login shell said "true": the engine must still force "false" (claude.ai connectors differ per account)
    loginEnv: { env: { PATH: process.env.PATH ?? '', ENABLE_CLAUDEAI_MCP_SERVERS: 'true' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: (a) => ({ FAKE_CLAUDE_SCENARIO: scn, FAKE_CLAUDE_TRACE: traceOf(ids.get(a.email)!) }),
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
  });
  for (const n of ['D1', 'D2']) await engine.lanes.start({ projectId: 'p1', name: n, cwd: join(tmp, `wt-${n}`), briefPath: join(tmp, 'brief.md') });
  await until(() => accts.every((a) => readTrace(a.id!) !== null), 'both lanes spawned');
  await until(() => engine.lanes.listAll().filter((v) => v.state === 'idle' || v.state === 'running').length === 2, 'lanes up');
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

const traces = (): Trace[] => engine.accounts.map((a) => readTrace(a.id!)!);

describe('v2.2 §5.1 session MCP over fake-claude', () => {
  test('§8 two lanes on two accounts: each argv has --strict-mcp-config exactly once and one --mcp-config; env ENABLE_CLAUDEAI_MCP_SERVERS=false', () => {
    const accounts = new Set(engine.lanes.listAll().map((v) => v.account));
    expect(accounts.size).toBe(2);
    for (const t of traces()) {
      expect(t.argv.filter((a) => a === '--strict-mcp-config')).toHaveLength(1);
      expect(t.argv.filter((a) => a === '--mcp-config')).toHaveLength(1);
      expect(t.claudeaiMcp).toBe('false');
    }
  });

  test('§8 A1 the two MCP files are identical except the session token; catalog set: user remote proxied, local stdio, plugin expanded, project off', () => {
    const [a, b] = traces().map((t) => readFileSync(flag(t.argv, '--mcp-config'), 'utf8'));
    const tok = (s: string) => /Bearer (\S+?)"/.exec(s)![1]!;
    expect(tok(a!)).not.toBe(tok(b!));
    expect(a!.replaceAll(tok(a!), 'T')).toBe(b!.replaceAll(tok(b!), 'T'));
    const cfg = JSON.parse(a!) as { mcpServers: Record<string, { url?: string; command?: string }> };
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['cc_slaves', 'db', 'linear', 'plugin_tg_tg']);
    expect(cfg.mcpServers.linear!.url).toBe(`http://127.0.0.1:${engine.port}/mcp-proxy/user%3Alinear`);
    expect(cfg.mcpServers.cc_slaves!.url).toBe(`http://127.0.0.1:${engine.port}/mcp`);
    expect(cfg.mcpServers.plugin_tg_tg!.command).toBe(`${join(tmp, 'claude', 'plugins', 'cache', 'm', 'tg', '1.0')}/server`);
    expect(statSync(flag(traces()[0]!.argv, '--mcp-config')).mode & 0o777).toBe(0o600);
  });

  test('§5.1 the token registry holds each session token with its proxied mcpIds', () => {
    for (const t of traces()) {
      const tok = /Bearer (\S+?)"/.exec(readFileSync(flag(t.argv, '--mcp-config'), 'utf8'))![1]!;
      expect(engine.tokens.resolve(tok)?.projectId).toBe('p1');
      expect([...engine.tokens.mcpIds(tok)]).toEqual(['user:linear']);
    }
  });

  test('§5.5 per-session --settings file (0600): deny rules + skillOverrides + enabledPlugins from config; no shared engine-settings.json', () => {
    const files = traces().map((t) => flag(t.argv, '--settings'));
    expect(new Set(files).size).toBe(2);
    for (const f of files) {
      expect(f.startsWith(join(paths().home, 'settings'))).toBe(true);
      expect(statSync(f).mode & 0o777).toBe(0o600);
      const j = JSON.parse(readFileSync(f, 'utf8'));
      expect(j.skillOverrides).toEqual({ 'h-ops': 'off' });
      expect(j.enabledPlugins).toEqual({ 'vercel@m': false });
      expect(j.permissions.deny.length).toBeGreaterThan(10);
    }
  });

  test('§5.1 system/init recorded per server (state, tool count, lane), not per account; cc_slaves not recorded', async () => {
    await until(() => engine.mcpInit.list().length === 2, 'init recorded');
    const rows = engine.mcpInit.list().map(({ at: _at, lane, ...r }) => ({ ...r, laneOk: lane === 'D1' || lane === 'D2' }));
    expect(rows).toEqual([
      { projectId: 'p1', name: 'linear', state: 'connected', tools: 2, toolNames: ['issues', 'teams'], laneOk: true },
      { projectId: 'p1', name: 'plugin_tg_tg', state: 'failed', tools: 0, toolNames: [], laneOk: true },
    ]);
  });
});
