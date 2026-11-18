// v2.5 §5.3 / §5.5 / §5.6 the graph module over stub fronts / indexes / exec (no process, no network): module state, the
// latest-release check, install / update steps (A8 config only on a new install, update suspends first), impact counts
// (process tree split, file count for an old tool), the project rows of the view, the clean run. Temp dirs only.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/db.ts';
import { CheckError, type InstallerRun } from '../../src/graph/install.ts';
import { GraphModule, splitProcesses, type ModuleFronts, type ModuleIndexes } from '../../src/graph/module.ts';
import type { IndexRow } from '../../src/graph/orphans.ts';
import type { JobView, RunEnd } from '../../src/graph/queue.ts';
import type { ToolRead } from '../../src/graph/tool.ts';
import type { ExecResult } from '../../src/setup/setup.ts';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-gmod-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const P1 = join(tmp, 'p1'); const P2 = join(tmp, 'p2'); const GONE = join(tmp, 'gone');
mkdirSync(P1); mkdirSync(P2);
const P1GIT = join(P1, '.git'); mkdirSync(P1GIT); writeFileSync(join(P1GIT, 'HEAD'), 'ref: refs/heads/main\n');
/** v25-gate: the exact `indexed_at` a real 0.12.1 `index_status` returned (JSON form, live smoke 18/11) = epoch 1794971853000. */
const INDEXED = '2026-11-18T03:17:33Z';
const INDEXED_MS = 1_794_971_853_000;

let read: ToolRead; let up: boolean; let failing: string | null; let calls: string[]; let execs: string[][];
let list: IndexRow[]; let jobs: Map<string, JobView>; let nowRead: ToolRead; let latest: () => Promise<string>;
let installer: (o: InstallerRun) => Promise<RunEnd>; let installs: InstallerRun[]; let removed: string[]; let lanes: number;
let ps: string; let head: number; let off: string[]; let db: Db; let changes: number; let m: GraphModule;

const fronts = (): ModuleFronts => ({
  toolRead: () => read, ready: () => up, failing: () => failing, onState: () => {}, retry: () => { calls.push('retry'); },
  suspend: () => { calls.push('suspend'); up = false; }, resume: async () => { calls.push('resume'); read = nowRead; up = read.state === 'ready'; },
  call: async (name, args) => { calls.push(`${name} ${JSON.stringify(args)}`); return name === 'index_status' ? { project: args.project, status: 'ready', indexed_at: INDEXED } : {}; },
});
const indexes = (): ModuleIndexes => ({
  list: async () => list, keep: () => new Set([P1, P2]), indexNow: (id, root) => { calls.push(`indexNow ${id} ${root}`); },
  state: (root) => jobs.get(root) ?? null, stop: (root) => { calls.push(`stop ${root}`); return true; },
  remove: async (name) => { removed.push(name); return name === 'bad' ? { ok: false, line: 'locked' } : { ok: true }; },
});
const exec = async (argv: string[]): Promise<ExecResult> => {
  execs.push(argv);
  if (argv[0] === 'ps') return { code: 0, stdout: ps, stderr: '' };
  if (argv[0] === 'git' && argv[2] === P2) return { code: 128, stdout: '', stderr: 'not a git repository' };
  if (argv[0] === 'git' && argv[3] === 'rev-parse') return { code: 0, stdout: `true\n${P1GIT}\n`, stderr: '' };
  if (argv[0] === 'git' && argv[3] === 'log') return { code: 0, stdout: `${head}\n`, stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};
function make(): GraphModule {
  return new GraphModule({
    fronts: fronts(), indexes: indexes(), tool: { read: async () => nowRead, env: { PATH: '/bin' } }, db, home: tmp,
    projects: () => [{ id: 'a', name: 'p1', path: P1 }, { id: 'b', name: 'p2', path: P2 }], off: () => off, lanesRunning: () => lanes, exec,
    onChange: () => { changes++; }, log: () => {}, latest: () => latest(), installer: (o) => { installs.push(o); return installer(o); },
  });
}
const BIN = join(tmp, 'bin', 'codebase-memory-mcp');

beforeEach(() => {
  read = { state: 'ready', path: BIN, version: '0.12.1' }; up = true; failing = null; calls = []; execs = []; list = []; jobs = new Map();
  nowRead = { state: 'ready', path: BIN, version: '0.13.0' }; latest = async () => 'v0.13.0'; installer = async () => ({ ok: true }); installs = [];
  removed = []; lanes = 0; ps = ''; head = Date.parse(INDEXED) / 1000 - 60; off = []; db = openDb(':memory:'); changes = 0; m = make();
});

describe('§5.3 module state', () => {
  test('missing / old / ready from the tool read; ready + control down ≥ 60 s → error with its cause; a failed --version → error', () => {
    read = { state: 'missing' };
    expect(m.view().tool).toEqual({ state: 'missing' });
    read = { state: 'old', path: BIN, version: '0.8.1' };
    expect(m.view().tool).toMatchObject({ state: 'old', version: '0.8.1', path: BIN });
    read = { state: 'ready', path: BIN, version: '0.12.1' }; failing = 'conflicting CBM process is active';
    expect(m.view().tool).toMatchObject({ state: 'error', error: 'conflicting CBM process is active' });
    read = { state: 'error', path: BIN, line: 'Killed: 9' }; failing = null;
    expect(m.view().tool).toMatchObject({ state: 'error', error: 'Killed: 9' });
  });
  test('K0 red: only `error` with the graph on for ≥ 1 project', () => {
    expect(m.red()).toBe(false); // ready
    failing = 'conflicting CBM process is active';
    expect(m.red()).toBe(true);
    off = ['a'];
    expect(m.red()).toBe(true);
    off = ['a', 'b'];
    expect(m.red()).toBe(false);
  });
});

describe('§5.3 graph_check', () => {
  test('the latest tag → latest (no v) + checkedAt + the "Sẽ chạy" line of that tag; reused within 60 s; force runs again', async () => {
    let n = 0;
    latest = async () => { n++; return 'v0.13.0'; };
    const v = await m.check(false);
    expect(v.tool).toMatchObject({ latest: '0.13.0', version: '0.12.1' });
    expect(v.tool.checkedAt).toBeNumber();
    expect(v.tool.command).toContain(`/v0.13.0/install.sh`);
    expect(v.tool.command).toEndWith(`--dir "${join(tmp, 'bin')}"`); // the dir of the file in place
    await m.check(false);
    expect(n).toBe(1);
    await m.check(true);
    expect(n).toBe(2);
  });
  test('a failed check keeps the old latest + checkError (offline / unknown)', async () => {
    await m.check(true);
    latest = async () => { throw new CheckError('offline', 'Unable to connect'); };
    const v = await m.check(true);
    expect(v.tool).toMatchObject({ latest: '0.13.0', checkError: { code: 'offline', line: 'Unable to connect' } });
  });
});

describe('§5.6 install / update', () => {
  test('new install: tag → installer into ~/.local/bin → --version = tag → config set ui_enabled false (A8) → resume; never suspends', async () => {
    read = { state: 'missing' }; up = false;
    const seen: (number | undefined)[] = [];
    installer = async (o) => { o.onLine('Downloading…'); seen.push(m.view().tool.run?.step); return { ok: true }; };
    const p = m.install('install');
    expect(m.view().tool.state).toBe('installing');
    await p;
    expect(installs.map((o) => [o.tag, o.dir])).toEqual([['v0.13.0', join(tmp, '.local', 'bin')]]);
    expect(seen).toEqual([2]);
    expect(execs.filter((a) => a[1] === 'config')).toEqual([[BIN, 'config', 'set', 'ui_enabled', 'false']]);
    expect(calls).toEqual(['resume']);
    expect(m.view().tool).toMatchObject({ state: 'ready', version: '0.13.0', log: ['Downloading…'] });
    expect(m.view().tool.run).toBeUndefined();
    expect(changes).toBeGreaterThanOrEqual(4); // pushed at each step and each log line
  });
  test('update: suspend first (rule 3, fronts closed), the dir of the file in place, NO config set (A8), resume after; run shows from → to', async () => {
    let during: unknown;
    installer = async () => { during = m.view().tool; return { ok: true }; };
    await m.install('update');
    expect(during).toMatchObject({ state: 'updating', run: { kind: 'update', from: '0.12.1', to: '0.13.0', step: 2 } });
    expect(calls).toEqual(['suspend', 'resume']);
    expect(installs[0]!.dir).toBe(join(tmp, 'bin'));
    expect(execs.filter((a) => a[1] === 'config')).toEqual([]);
  });
  test('installer failure / a --version that is not the tag → failed {kind, line}, resumed on the file in place, no config set', async () => {
    installer = async () => ({ ok: false, line: 'checksum mismatch' });
    await m.install('update');
    expect(m.view().tool).toMatchObject({ state: 'ready', failed: { kind: 'update', line: 'checksum mismatch' } });
    expect(calls).toEqual(['suspend', 'resume']);
    read = { state: 'missing' }; nowRead = { state: 'ready', path: BIN, version: '0.12.9' }; installer = async () => ({ ok: true });
    await m.install('install');
    expect(m.view().tool.failed).toEqual({ kind: 'install', line: 'codebase-memory-mcp --version: 0.12.9 ≠ 0.13.0' });
    expect(execs.filter((a) => a[1] === 'config')).toEqual([]);
  });
  test('one run at a time: a second install while one runs does nothing', async () => {
    let release!: () => void;
    installer = () => new Promise((r) => { release = () => r({ ok: true }); });
    const p = m.install('update');
    await Bun.sleep(5);
    await m.install('update');
    release();
    await p;
    expect(installs).toHaveLength(1);
  });
  test('shutdown() (Engine.stop) aborts the running installer and waits for it; no resume of fronts that are about to close', async () => {
    installer = (o) => new Promise((r) => { o.signal!.addEventListener('abort', () => r({ ok: false, line: 'đã dừng' })); });
    const p = m.install('update');
    await Bun.sleep(5);
    expect(installs[0]!.signal!.aborted).toBe(false);
    await m.shutdown();
    expect(installs[0]!.signal!.aborted).toBe(true);
    await p;
    expect(calls).toEqual(['suspend']);
    expect(m.busy()).toBe(false);
  });
});

describe('§5.6 graph_impact', () => {
  test('process tree: under an engine lane claude → lanes; under another claude → sessions; launchd / an app → other; the engine fronts left out', () => {
    const E = 100;
    const procs = [
      { pid: 1, ppid: 0, comm: '/sbin/launchd' }, { pid: E, ppid: 1, comm: 'cc-slaves-engine' },
      { pid: 101, ppid: E, comm: '/bin/codebase-memory-mcp' }, // engine front
      { pid: 110, ppid: E, comm: 'claude' }, { pid: 111, ppid: 110, comm: '/Users/x/.local/bin/codebase-memory-mcp' }, // lane
      { pid: 200, ppid: 1, comm: '/Applications/iTerm.app/x' }, { pid: 201, ppid: 200, comm: '/bin/zsh' }, { pid: 202, ppid: 201, comm: '/Users/x/.local/bin/claude' },
      { pid: 203, ppid: 202, comm: 'codebase-memory-mcp' }, { pid: 204, ppid: 202, comm: 'codebase-memory-mcp' }, // other sessions
      { pid: 300, ppid: 1, comm: 'codebase-memory-mcp' }, { pid: 301, ppid: 200, comm: 'codebase-memory-mcp' }, // orphan, an app
    ];
    expect(splitProcesses(procs, E)).toEqual({ lanes: 1, sessions: 2, other: 2 });
  });
  test('ready → list_projects counts; old (no front) → *.db files bar _*.db and activity.db, bytes of the whole dir; lanes running', async () => {
    list = [{ name: 'a', root_path: P1, size_bytes: 100 }, { name: 'b', root_path: P2, size_bytes: 50 }];
    lanes = 3;
    ps = `  1     0 /sbin/launchd\n  9     1 codebase-memory-mcp\n`;
    expect(await m.impact()).toEqual({ indexes: { n: 2, bytes: 150 }, lanesRunning: 3, processes: { lanes: 0, sessions: 0, other: 1 } });
    const cache = join(tmp, '.cache', 'codebase-memory-mcp');
    mkdirSync(join(cache, 'logs'), { recursive: true });
    for (const [f, n] of [['a.db', 10], ['b.db', 20], ['_config.db', 5], ['activity.db', 7], ['logs/x.ndjson', 3]] as const) writeFileSync(join(cache, f), 'x'.repeat(n));
    read = { state: 'old', path: BIN, version: '0.8.1' }; up = false;
    expect((await m.impact()).indexes).toEqual({ n: 2, bytes: 45 });
  });
});

describe('§5.8 GraphView projects + clean', () => {
  test('rows: ready (nodes, bytes, indexedAt) · no git → never stale · queued (ahead) · running (startedAt, R4 byTool) · failed · none; git; lane dirs', async () => {
    const LANE = join(tmp, 'p1-wt');
    mkdirSync(LANE);
    db.query("INSERT INTO graph_index (root_path, project_id, origin) VALUES (?, 'a', 'lane')").run(LANE);
    list = [{ name: 'p1', root_path: P1, size_bytes: 100, nodes: 15 } as IndexRow, { name: 'p2', root_path: P2, size_bytes: 9 }, { name: 'w', root_path: LANE, size_bytes: 30 }];
    await m.refresh();
    const [a, b] = m.view().projects;
    expect(a).toEqual({ projectId: 'a', name: 'p1', on: true, git: true, state: 'ready', nodes: 15, bytes: 100, indexedAt: INDEXED_MS, lanes: { n: 1, bytes: 30 } });
    expect(b).toMatchObject({ state: 'ready', git: false });
    jobs.set(P1, { state: 'queued', by: 'engine', ahead: 1 });
    jobs.set(P2, { state: 'running', by: 'tool', startedAt: 5 });
    expect(m.view().projects.map((p) => [p.state, p.ahead, p.startedAt, p.byTool])).toEqual([['queued', 1, undefined, undefined], ['running', undefined, 5, true]]);
    jobs.set(P1, { state: 'failed', by: 'engine', error: 'index failed' });
    jobs.set(P2, { state: 'stopping', by: 'engine', startedAt: 5 });
    expect(m.view().projects.map((p) => [p.state, p.error, p.stopping])).toEqual([['failed', 'index failed', undefined], ['running', undefined, true]]);
    list = []; jobs.clear();
    await m.refresh();
    expect(m.view().projects.map((p) => p.state)).toEqual(['none', 'none']);
    off = ['b'];
    expect(m.view().projects.map((p) => p.on)).toEqual([true, false]); // GR1-offp: graph.offProjects
    read = { state: 'missing' };
    expect(m.view().projects).toEqual([]); // no project list without a module (GR0)
  });
  test('stale = the HEAD commit is newer than the index (ruling 07:05); older or equal → ready; the tool status is never read for it', async () => {
    list = [{ name: 'p1', root_path: P1, size_bytes: 1 }, { name: 'p2', root_path: P2, size_bytes: 1 }];
    await m.refresh();
    expect(m.view().projects.map((p) => p.state)).toEqual(['ready', 'ready']);
    head = Date.parse(INDEXED) / 1000 + 60; m = make();
    await m.refresh();
    expect(m.view().projects.map((p) => [p.state, p.git])).toEqual([['stale', true], ['ready', false]]);
    head = Date.parse(INDEXED) / 1000; m = make();
    await m.refresh();
    expect(m.view().projects[0]!.state).toBe('ready');
  });
  test('index / stop go to the project root (Index lại first in line); nothing while the module is down', () => {
    expect(m.index('a')).toBe(true);
    expect(m.stop('b')).toBe(true);
    expect(calls).toEqual([`indexNow a ${P1}`, `stop ${P2}`]);
    up = false;
    expect(m.index('a')).toBe(false);
  });
  test('orphans: gone dirs only (project roots kept), kept count; clean: progress, then done with freed bytes, failures + their roots', async () => {
    list = [{ name: 'p1', root_path: P1, size_bytes: 1 }, { name: 'g1', root_path: GONE, size_bytes: 70 }, { name: 'bad', root_path: `${GONE}2`, size_bytes: 5 }, { name: 'x' }];
    expect(await m.orphans()).toEqual({ rows: [{ root_path: GONE, bytes: 70 }, { root_path: `${GONE}2`, bytes: 5 }], bytes: 75, skipped: { n: 0 }, kept: 1 });
    m.clean([GONE, `${GONE}2`, P1]);
    expect(m.view().tool.clean).toMatchObject({ state: 'running', done: 0, total: 3 });
    await Bun.sleep(20);
    expect(removed).toEqual(['g1', 'bad']); // P1 is no orphan: never deleted
    expect(m.view().tool.clean).toEqual({ state: 'done', done: 2, total: 3, freedBytes: 70, failed: 1, failedRoots: [`${GONE}2`], error: 'locked' });
  });
});
