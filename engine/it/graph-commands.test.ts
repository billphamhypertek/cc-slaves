// v2.5 §5.6 / §5.8 Integration: the graph commands over a real engine. The "GitHub" is a loopback server (the
// `releases/latest` redirect + a tag's install.sh that drops a `fake-cbm` wrapper of that version into `--dir`); the graph
// tool is `fake-cbm` with a shared temp state dir (never the real codebase-memory-mcp, Z5); temp HOME (its own
// `.local/bin`), temp cc-slaves homes. Fresh install (A8 config once) → index of the project root; update (rule 3 for a
// lane call mid-way, then served again; no config); a failed update keeps the version in place; impact; graph_clean only
// deletes roots that are confirmed and still orphans; every command refused on the remote channel (N7).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { GraphImpact, GraphOrphans, GraphView } from '../../shared/graph.ts';
import type { Command, ServerMsg } from '../../shared/protocol.ts';
import type { ToolkitView } from '../../shared/toolkit.ts';
import { insertProject, openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { ALL_COMMANDS, route } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(60_000);
const CBM = resolve(import.meta.dir, '../../fake-cbm/src/index.ts');
// git on this Mac exits 69 (Xcode license) with a bare env: the login env carries DEVELOPER_DIR (hf1116 G2)
const DEV = process.env.DEVELOPER_DIR ?? '/Library/Developer/CommandLineTools';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let server: ReturnType<typeof Bun.serve>;
let latest = 'v0.12.1';
/** tag → extra shell run before the wrapper is written (a slow or failing installer). */
const scriptExtra = new Map<string, string>();
let cbmLog: string;
let state: string;
let argsLog: string;
const pushed: GraphView[] = [];
const toolkitPushed: ToolkitView[] = [];
const remoteSeen: string[] = [];

interface Ev { ev: string; args?: unknown; name?: string }
const events = (): Ev[] => { try { return readFileSync(cbmLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev); } catch { return []; } };
const configSets = () => events().filter((e) => e.ev === 'config' && JSON.stringify(e.args) === JSON.stringify(['set', 'ui_enabled', 'false']));
const projects = (): { name: string; root_path: string; indexed_at?: string }[] => { try { return JSON.parse(readFileSync(join(state, 'projects.json'), 'utf8')) as { name: string; root_path: string; indexed_at?: string }[]; } catch { return []; } };
async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}: ${JSON.stringify(engine.graphModule?.view().tool)}`); await Bun.sleep(20); }
}
const conn = (channel: 'mac' | 'remote'): Conn => ({ channel, watch: null, present: true, send: () => {} });
const cmd = (command: Command, channel: 'mac' | 'remote' = 'mac'): Promise<ServerMsg> =>
  route(buildHandlers(engine, conn(channel)), { channel }, { type: 'command', id: 'x', command });
async function ack<T = GraphView>(command: Command): Promise<T> {
  const r = await cmd(command);
  if (r.type !== 'ack') throw new Error(`${command.cmd}: ${JSON.stringify(r)}`);
  return r.result as T;
}
const tool = () => engine.graphModule!.view().tool;
const shop = () => join(tmp, 'shop');
const localBin = () => join(tmp, '.local', 'bin');
const gateCall = async (token: string) => {
  const r = await fetch(`http://127.0.0.1:${engine.port}/mcp-graph`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search_graph', arguments: { query: 'x' } } }),
  });
  const j = await r.json() as { result?: { isError?: boolean; content: { text: string }[] } };
  return { status: r.status, isError: j.result?.isError === true, text: j.result?.content[0]?.text ?? '' };
};

/** The install.sh of `tag`: records its argv + CBM_DOWNLOAD_URL, then writes a fake-cbm wrapper of that version into --dir. */
const script = (tag: string) => `set -e
printf '%s|' "$@" >> "${argsLog}"; echo "url=$CBM_DOWNLOAD_URL" >> "${argsLog}"
echo "Downloading codebase-memory-mcp ${tag}…"
${scriptExtra.get(tag) ?? ''}
mkdir -p "$3"
printf '#!/bin/sh\\nFAKE_CBM_VERSION=${tag.slice(1)} exec "%s" "%s" "$@"\\n' "${process.execPath}" "${CBM}" > "$3/codebase-memory-mcp"
chmod 755 "$3/codebase-memory-mcp"
echo "Installed binary"
`;

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-graph-cmd-')));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  state = join(tmp, 'cbm-state');
  for (const d of [join(tmp, 'home'), join(tmp, 'claude'), join(shop(), '.git'), state]) mkdirSync(d, { recursive: true, mode: 0o700 });
  cbmLog = join(tmp, 'cbm.log');
  argsLog = join(tmp, 'install-args.log');
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: (r) => {
      const u = new URL(r.url);
      if (u.pathname === '/releases/latest') return new Response(null, { status: 302, headers: { location: `https://github.com/DeusData/codebase-memory-mcp/releases/tag/${latest}` } });
      const m = /^\/raw\/(v[\d.]+)\/install\.sh$/.exec(u.pathname);
      return m ? new Response(script(m[1]!)) : new Response('not found', { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const db = openDb(paths().stateDb);
  seedAccounts(['a@x.test'], { db });
  insertProject(db, { id: 'p1', name: 'Shop', path: shop() });
  db.close();
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 'graph-cmd-token', staticDir: null, command: ['true'], graphModule: true,
    graphUrls: { latest: `${base}/releases/latest`, raw: `${base}/raw`, download: `${base}/download` },
    // no tool on the PATH and none in ~/.local/bin yet: `missing`
    loginEnv: { env: { PATH: '/usr/bin:/bin', HOME: tmp, DEVELOPER_DIR: DEV, FAKE_CBM_LOG: cbmLog, FAKE_CBM_STATE: state, FAKE_CBM_INDEX_MS: '100' }, claudePath: null, shellFailed: false, reason: null },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
  });
  engine.hub.open({ channel: 'mac', watch: null, present: true, send: (m) => {
    if (m.type === 'event' && m.event.type === 'graph') pushed.push(m.event.view);
    if (m.type === 'event' && m.event.type === 'toolkit') toolkitPushed.push(m.event.view);
  } });
  engine.hub.open({ channel: 'remote', watch: null, present: true, send: (m) => { if (m.type === 'event') remoteSeen.push(m.event.type); } });
});

afterAll(async () => {
  await engine?.stop();
  void server?.stop(true);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§5.8 N7 channel', () => {
  test('every graph command on the remote channel → forbidden_remote; nothing installed, nothing run', async () => {
    const all = ALL_COMMANDS.filter((c) => c.startsWith('graph_'));
    expect(all).toHaveLength(10);
    for (const c of all) expect(await cmd({ cmd: c, projectId: 'p1', roots: [], on: false } as unknown as Command, 'remote')).toMatchObject({ type: 'error', code: 'forbidden_remote' });
    expect(existsSync(argsLog)).toBe(false);
  });
  test('the Mac snapshot carries the graph view; the remote one does not', () => {
    expect(engine.snapshot('mac').graph?.tool.state).toBe('missing');
    expect(engine.snapshot('remote').graph).toBeUndefined();
  });
});

describe('§5.6 install / update', () => {
  test('graph_check on a machine without the tool: missing, latest 0.12.1, the pinned one-line command for ~/.local/bin', async () => {
    const v = await ack({ cmd: 'graph_check', force: true });
    expect(v.tool).toMatchObject({ state: 'missing', latest: '0.12.1' });
    expect(v.tool.command).toStartWith('curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/v0.12.1/install.sh | CBM_DOWNLOAD_URL=https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.12.1 bash');
    expect(v.tool.command).toEndWith('--skip-config --dir "$HOME/.local/bin"');
    expect(v.projects).toEqual([]);
    expect(await cmd({ cmd: 'graph_update' })).toMatchObject({ type: 'error', code: 'bad_state' }); // nothing to update
    expect(engine.toolkit.view().rows.at(-1)).toMatchObject({ key: 'graph', kind: 'graph', state: 'missing', commands: [v.tool.command] }); // TK1-cmd
  });

  test('toolkit_install [graph] (§5.2 graph last): the tag script into ~/.local/bin → 0.12.1 ready, config set ui_enabled false once (A8), the project root indexed', async () => {
    await ack<ToolkitView>({ cmd: 'toolkit_install', keys: ['graph'] });
    await until(() => tool().state === 'installing', 'installing');
    expect(engine.toolkit.view().rows.at(-1)!.state).toBe('running');
    expect(await cmd({ cmd: 'graph_install' })).toMatchObject({ type: 'error', code: 'busy' }); // one run at a time
    expect(await cmd({ cmd: 'toolkit_install', keys: ['superpowers'] })).toMatchObject({ type: 'error', code: 'busy' }); // for the whole toolkit
    expect(await cmd({ cmd: 'toolkit_update', key: 'superpowers' })).toMatchObject({ type: 'error', code: 'busy' }); // an update too (review-e MINOR-1)
    await until(() => tool().state === 'ready', 'installed');
    expect(readFileSync(argsLog, 'utf8').trim().split('\n')).toEqual([`--skip-config|--dir|${localBin()}|url=${server.url.origin}/download/v0.12.1`]);
    expect(tool()).toMatchObject({ version: '0.12.1', path: join(localBin(), 'codebase-memory-mcp') });
    expect(tool().failed).toBeUndefined();
    expect(configSets()).toHaveLength(1);
    await until(() => projects().some((p) => p.root_path === shop()), 'project root indexed (§5.5 module ready)');
    // pushed to the Mac only: installing → each step → ready; after the job the row re-reads its numbers (nodes, bytes)
    expect(pushed.some((v) => v.tool.state === 'installing' && v.tool.run?.step === 2)).toBe(true);
    await until(() => pushed.at(-1)?.projects[0]?.state === 'ready', 'row ready after the job');
    expect(pushed.some((v) => v.projects[0]?.state === 'queued' || v.projects[0]?.state === 'running')).toBe(true);
    expect(pushed.at(-1)!.projects[0]).toMatchObject({ projectId: 'p1', name: 'Shop', on: true, git: false, nodes: 10, bytes: 1000 });
    expect(remoteSeen).not.toContain('graph');
    expect(await cmd({ cmd: 'graph_install' })).toMatchObject({ type: 'error', code: 'bad_state' });
    expect(engine.toolkit.view().rows.at(-1)).toMatchObject({ key: 'graph', state: 'installed', version: '0.12.1' });
    expect(toolkitPushed.some((v) => v.rows.at(-1)?.state === 'running' && (v.rows.at(-1)?.log?.length ?? 0) > 0)).toBe(true); // GR-run lines reach the row
  });

  test('graph_update to 0.13.0: a lane call mid-way gets rule 3 (a tool error, not HTTP), served again after; no config set (A8); same dir', async () => {
    engine.tokens.register('s-g', 'tok-g', { cwd: shop(), graph: true, mcpIds: new Set() }, { role: 'lane', projectId: 'p1' });
    engine.graph!.openSession('s-g', shop());
    expect(await gateCall('tok-g')).toMatchObject({ status: 200, isError: false });
    latest = 'v0.13.0';
    scriptExtra.set('v0.13.0', 'sleep 1');
    await ack({ cmd: 'graph_update' });
    await until(() => tool().run?.step === 2, 'installer running');
    expect(tool()).toMatchObject({ state: 'updating', run: { kind: 'update', from: '0.12.1', to: '0.13.0' } });
    const mid = await gateCall('tok-g');
    expect(mid).toMatchObject({ status: 200, isError: true });
    expect(mid.text).toContain('Graph đang cập nhật');
    await until(() => tool().state === 'ready' && tool().version === '0.13.0', 'updated');
    await until(() => engine.graph!.ready(), 'control front back');
    expect(await gateCall('tok-g')).toMatchObject({ status: 200, isError: false });
    expect(configSets()).toHaveLength(1);
    expect(readFileSync(argsLog, 'utf8').trim().split('\n').at(-1)).toBe(`--skip-config|--dir|${localBin()}|url=${server.url.origin}/download/v0.13.0`);
  });

  test('a failed update (installer exit ≠ 0) → failed with its last line; the version in place stays and is served', async () => {
    latest = 'v0.14.0';
    scriptExtra.set('v0.14.0', 'echo "checksum mismatch: codebase-memory-mcp-darwin-arm64.tar.gz" >&2; exit 2');
    await ack({ cmd: 'graph_update' });
    await until(() => tool().failed !== undefined, 'failed');
    expect(tool()).toMatchObject({ state: 'ready', version: '0.13.0', failed: { kind: 'update', line: 'checksum mismatch: codebase-memory-mcp-darwin-arm64.tar.gz' } });
    expect(tool().log).toEqual(expect.arrayContaining(['Downloading codebase-memory-mcp v0.14.0…']));
    await until(() => engine.graph!.ready(), 'control front back');
    expect(await gateCall('tok-g')).toMatchObject({ isError: false });
  });

  test('graph_retry acks the view; graph_impact counts the indexes and the lanes running', async () => {
    expect((await ack({ cmd: 'graph_retry' })).tool.state).toBe('ready');
    const i = await ack<GraphImpact>({ cmd: 'graph_impact' });
    expect(i.indexes.n).toBe(projects().length);
    expect(i.lanesRunning).toBe(0);
  });
});

describe('§5.5 graph_index / graph_clean', () => {
  test('graph_index → the root re-indexed (first in line); an unknown project → bad_input', async () => {
    const n = events().filter((e) => e.name === 'index_repository').length;
    await ack({ cmd: 'graph_index', projectId: 'p1' });
    await until(() => events().filter((e) => e.name === 'index_repository').length > n, 'index sent');
    expect(await cmd({ cmd: 'graph_index', projectId: 'nope' })).toMatchObject({ type: 'error', code: 'bad_input' });
  });

  test('graph_clean deletes only roots the user saw that are still orphans: one that came back, a live dir, an unlisted path stay', async () => {
    const g1 = join(tmp, 'gone-1'); const g2 = join(tmp, 'gone-2'); const live = join(tmp, 'live'); const other = join(tmp, 'gone-3');
    mkdirSync(live);
    const now = projects();
    writeFileSync(join(state, 'projects.json'), JSON.stringify([...now, ...[g1, g2, live, other].map((r, i) => ({ name: `x${i}`, root_path: r, nodes: 1, edges: 1, size_bytes: 100 * (i + 1) }))]));
    const o = await ack<GraphOrphans>({ cmd: 'graph_orphans' });
    expect(o.rows.map((r) => r.root_path).sort()).toEqual([g1, g2, other].sort());
    mkdirSync(g2); // reappeared between the list and the clean
    await ack({ cmd: 'graph_clean', roots: [g1, g2, live] }); // `other` was not in the confirmed list
    await until(() => tool().clean?.state === 'done', 'clean done');
    expect(projects().map((p) => p.root_path).sort()).toEqual([...now.map((p) => p.root_path), g2, live, other].sort());
    expect(tool().clean).toMatchObject({ state: 'done', freedBytes: 100, failed: 0, failedRoots: [] });
    expect(await cmd({ cmd: 'graph_clean', roots: 'x' as unknown as string[] })).toMatchObject({ type: 'error', code: 'bad_input' });
  });
});

describe('§5.7 graph_toggle (graph.offProjects)', () => {
  test('off → config graph.offProjects, the row says off, the next spawn of the project gets no graph; on → back, the root indexed when it has none', async () => {
    const v = await ack({ cmd: 'graph_toggle', projectId: 'p1', on: false });
    expect(engine.config.graph.offProjects).toEqual(['p1']);
    expect(v.projects.find((p) => p.projectId === 'p1')!.on).toBe(false);
    expect(engine.graphSetup('p1')).toEqual({ on: false });
    expect(engine.graphSetup('other')).toEqual({ on: true });
    writeFileSync(join(state, 'projects.json'), JSON.stringify(projects().filter((p) => p.root_path !== shop()))); // its index is gone meanwhile
    await ack({ cmd: 'graph_toggle', projectId: 'p1', on: true });
    expect(engine.config.graph.offProjects).toEqual([]);
    expect(engine.graphSetup('p1')).toEqual({ on: true });
    await until(() => projects().some((p) => p.root_path === shop()), 'root indexed again (§5.5 "bật graph cho project")');
    expect(await cmd({ cmd: 'graph_toggle', projectId: 'p1', on: 'yes' as unknown as boolean })).toMatchObject({ type: 'error', code: 'bad_input' });
  });
});

describe('§5.5 "Cần dựng lại" from git (ruling 07:05)', () => {
  test('the 0.12.1 index_status never says stale; a HEAD commit older than indexed_at → ready, newer → stale', async () => {
    await until(() => engine.graphModule!.view().projects[0]?.state === 'ready', 'row ready');
    const at = Date.parse(projects().find((p) => p.root_path === shop())!.indexed_at!);
    rmSync(join(shop(), '.git'), { recursive: true, force: true });
    const git = (args: string[], when: number) => {
      const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@x.test', '-c', 'commit.gpgsign=false', '-C', shop(), ...args], {
        env: { PATH: '/usr/bin:/bin', HOME: tmp, DEVELOPER_DIR: DEV, GIT_CONFIG_NOSYSTEM: '1', GIT_COMMITTER_DATE: `@${Math.floor(when / 1000)} +0000`, GIT_AUTHOR_DATE: `@${Math.floor(when / 1000)} +0000` },
      });
      expect(r.exitCode).toBe(0);
    };
    git(['init', '-q'], at); git(['commit', '-q', '--allow-empty', '-m', 'before'], at - 86_400_000);
    await engine.graphModule!.refresh();
    expect(engine.graphModule!.view().projects[0]).toMatchObject({ state: 'ready', git: true, indexedAt: at });
    git(['commit', '-q', '--allow-empty', '-m', 'after'], at + 60_000);
    await engine.graphModule!.refresh();
    expect(engine.graphModule!.view().projects[0]).toMatchObject({ state: 'stale', git: true, indexedAt: at });
  });
});

