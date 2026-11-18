// v2.5 §5.4 fronts over `fake-cbm` (never the real tool, Z5): the control front (engine data dir, restart with back-off),
// session fronts (session cwd; replaced on a new token; respawned on the next call with the client's initialize replayed;
// replaced after a timeout), id remapping, every spawn with the A1 env.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GraphFronts, FrontTimeout, type RpcReply } from '../../src/graph/front.ts';
import { GraphTool } from '../../src/graph/tool.ts';

const FAKE = resolve(import.meta.dir, '../../../fake-cbm/src/index.ts');
let tmp: string;
let bin: string;
let logFile: string;
let failFile: string;
let data: string;
const opened: GraphFronts[] = [];

interface Ev { ev: string; pid: number; cwd: string; method?: string; name?: string; env?: Record<string, string | null> }
const events = (): Ev[] => { try { return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev); } catch { return []; } };
const starts = (cwd: string) => events().filter((e) => e.ev === 'start' && e.cwd === realpathSync(cwd));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-front-'));
  bin = join(tmp, 'bin'); data = join(tmp, 'data');
  for (const d of [bin, data, join(tmp, 'wt-a'), join(tmp, 'wt-b')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, 'codebase-memory-mcp'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bin, 'codebase-memory-mcp'), 0o755);
  logFile = join(tmp, 'cbm.log'); failFile = join(tmp, 'fail');
});
afterAll(() => { for (const f of opened) f.stop(); rmSync(tmp, { recursive: true, force: true }); });

function fronts(env: Record<string, string> = {}, o: { backoff?: number; errorAfterMs?: number } = {}): GraphFronts {
  const f = new GraphFronts({
    tool: new GraphTool({ env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, FAKE_CBM_LOG: logFile, FAKE_CBM_FAIL: failFile, CBM_CACHE_DIR: '/leak', CLAUDE_CONFIG_DIR: '/leak', ...env } }),
    dataDir: data, log: () => {}, backoffMs: () => o.backoff ?? 50, ...(o.errorAfterMs !== undefined ? { errorAfterMs: o.errorAfterMs } : {}),
  });
  opened.push(f);
  return f;
}
const rpc = (id: string | number, method: string, params?: unknown) => ({ jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) });

describe('§5.4 control front', () => {
  test('tool ready → one control front in the engine data dir, initialized; ready() once it answers', async () => {
    const f = fronts();
    await f.start();
    expect(f.managed()).toBe(true);
    await until(() => f.ready(), 'control up');
    const c = starts(data);
    expect(c.length).toBeGreaterThanOrEqual(1);
    expect(c.at(-1)!.env).toEqual({ CBM_CACHE_DIR: null, CLAUDE_CONFIG_DIR: null }); // A1
    expect(events().filter((e) => e.pid === c.at(-1)!.pid && e.ev === 'msg').map((e) => e.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    f.stop();
    await until(() => !alive(c.at(-1)!.pid), 'control closed on stop');
  });
  test('the control front dies (an external install drained it) → not ready, then respawned with back-off', async () => {
    const f = fronts();
    await f.start();
    await until(() => f.ready(), 'control up');
    const first = starts(data).at(-1)!.pid;
    process.kill(first, 'SIGKILL');
    await until(() => !f.ready(), 'down after the kill');
    await until(() => f.ready() && starts(data).at(-1)!.pid !== first, 'respawned');
    f.stop();
  });
  test('a control front that cannot start (conflict) keeps retrying; it comes up once the cause is gone', async () => {
    writeFileSync(failFile, '');
    const f = fronts();
    await f.start();
    await Bun.sleep(300);
    expect(f.ready()).toBe(false);
    expect(f.managed()).toBe(true);
    rmSync(failFile);
    await until(() => f.ready(), 'up after the conflict cleared');
    f.stop();
  });
  test('a build without search_graph never counts as up (risk §10: a newer protocol / tool names)', async () => {
    const f = fronts({ FAKE_CBM_TOOLS: 'list_projects,index_status' });
    await f.start();
    await Bun.sleep(400);
    expect(f.managed()).toBe(true);
    expect(f.ready()).toBe(false);
    f.stop();
  });
  test('missing / old tool → not managed, nothing spawned, a session is never opened', async () => {
    const before = events().length;
    const old = fronts({ FAKE_CBM_VERSION: '0.8.1' });
    await old.start();
    expect(old.managed()).toBe(false);
    old.openSession('s-old', join(tmp, 'wt-a'));
    expect(old.session('s-old')).toBeNull();
    const missing = new GraphFronts({ tool: new GraphTool({ env: { PATH: join(tmp, 'none'), HOME: join(tmp, 'none') } }), dataDir: data, log: () => {} });
    await missing.start();
    expect(missing.managed()).toBe(false);
    await Bun.sleep(100);
    expect(events().slice(before).filter((e) => e.ev === 'start')).toEqual([]);
  });
});

describe('§5.4 session fronts', () => {
  test('one front per session in its cwd, spawned when the session is opened; a new token replaces it; close ends it', async () => {
    const f = fronts();
    await f.start();
    f.openSession('s1', join(tmp, 'wt-a'));
    f.openSession('s2', join(tmp, 'wt-b'));
    await until(() => starts(join(tmp, 'wt-a')).length > 0 && starts(join(tmp, 'wt-b')).length > 0, 'both session fronts spawned before any call');
    const a = starts(join(tmp, 'wt-a')).at(-1)!.pid;
    const first = f.session('s1')!;
    expect(first.cwd).toBe(join(tmp, 'wt-a'));
    f.openSession('s1', join(tmp, 'wt-a')); // the next spawn of that session's claude (a new token)
    expect(f.session('s1')).not.toBeNull();
    expect(f.session('s1')).not.toBe(first);
    await until(() => !alive(a), 'old front closed');
    const b = starts(join(tmp, 'wt-b')).at(-1)!.pid;
    f.closeSession('s2');
    expect(f.session('s2')).toBeNull();
    await until(() => !alive(b), 'closed with its claude process');
    f.stop();
  });
  test('ids are remapped: two calls with the same client id each get their own reply, with the client id back', async () => {
    const f = fronts();
    await f.start();
    f.openSession('s3', join(tmp, 'wt-a'));
    const s = f.session('s3')!;
    const init = await s.call(rpc('same', 'initialize', { protocolVersion: '2025-11-25' }), 5000);
    expect((init.result as { instructions: string }).instructions).toStartWith('Graph first:');
    s.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const [x, y] = await Promise.all([
      s.call(rpc('same', 'tools/call', { name: 'search_graph', arguments: { q: 'x' } }), 5000),
      s.call(rpc('same', 'tools/call', { name: 'search_graph', arguments: { q: 'y' } }), 5000),
    ]);
    const args = (r: RpcReply) => (JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text) as { args: unknown; cwd: string });
    expect([x.id, y.id]).toEqual(['same', 'same']);
    expect([args(x).args, args(y).args]).toEqual([{ q: 'x' }, { q: 'y' }]);
    expect(args(x).cwd).toBe(realpathSync(join(tmp, 'wt-a')));
    f.stop();
  });
  test('a dead session front → pending call fails; the next call respawns it and replays the client initialize first', async () => {
    const f = fronts({ FAKE_CBM_SLOW: 'trace_path' });
    await f.start();
    f.openSession('s4', join(tmp, 'wt-b'));
    const s = f.session('s4')!;
    await s.call(rpc(1, 'initialize', { protocolVersion: '2025-11-25' }), 5000);
    s.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const pid = starts(join(tmp, 'wt-b')).at(-1)!.pid;
    const pending = s.call(rpc(2, 'tools/call', { name: 'trace_path', arguments: {} }), 5000);
    await Bun.sleep(100);
    process.kill(pid, 'SIGKILL');
    expect(await pending.then(() => 'ok', (e: Error) => e.name)).toBe('FrontGone');
    const r = await s.call(rpc(3, 'tools/call', { name: 'search_graph', arguments: {} }), 5000);
    expect(r.error).toBeUndefined(); // fake-cbm refuses tools/call before initialize: the replay happened
    const again = starts(join(tmp, 'wt-b')).at(-1)!.pid;
    expect(again).not.toBe(pid);
    expect(events().filter((e) => e.pid === again && e.ev === 'msg').map((e) => e.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    f.stop();
  });
  test('a call past its limit → FrontTimeout and that front is replaced (the next call runs on a new one)', async () => {
    const f = fronts({ FAKE_CBM_SLOW: 'trace_path' });
    await f.start();
    f.openSession('s5', join(tmp, 'wt-a'));
    const s = f.session('s5')!;
    await s.call(rpc(1, 'initialize', {}), 5000);
    const before = starts(join(tmp, 'wt-a')).at(-1)!.pid;
    const err = await s.call(rpc(2, 'tools/call', { name: 'trace_path', arguments: {} }), 150).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FrontTimeout);
    await until(() => !alive(before), 'timed-out front closed');
    await s.call(rpc(3, 'tools/call', { name: 'search_graph', arguments: {} }), 5000);
    expect(starts(join(tmp, 'wt-a')).at(-1)!.pid).not.toBe(before);
    f.stop();
  });
});

describe('§5.5 the queue port (G0 §4: a sync index on its own front; cancel = notifications/cancelled)', () => {
  const state = () => { const d = join(tmp, `state-${Math.random().toString(36).slice(2)}`); mkdirSync(d); return d; };
  const jobs = (d: string) => JSON.parse(readFileSync(join(d, 'jobs.json'), 'utf8')) as Record<string, string>;
  test('run(): a synchronous index_repository (no async) on a new front in the data dir, closed when it ends; status() / call() on the control front', async () => {
    const st = state();
    const f = fronts({ FAKE_CBM_STATE: st, FAKE_CBM_INDEX_MS: '50' });
    await f.start(); await until(() => f.ready(), 'control up');
    const control = starts(data).at(-1)!.pid;
    const run = f.run('/r/one', { mode: 'fast' });
    await until(() => events().some((e) => e.name === 'index_repository' && e.pid !== control && (e as { args?: { repo_path?: string } }).args?.repo_path === '/r/one'), 'index sent');
    const sent = events().filter((e) => e.name === 'index_repository' && e.pid !== control).at(-1)! as Ev & { args: Record<string, unknown> };
    expect(sent.args).toEqual({ mode: 'fast', repo_path: '/r/one', format: 'json' });
    expect(await f.status('/r/one')).toBe('running');
    expect(await run.done).toEqual({ ok: true });
    expect(await f.status('/r/one')).toBe('succeeded');
    await until(() => !alive(sent.pid), 'index front closed');
    const list = await f.call('list_projects', {});
    expect((list.projects as { root_path: string }[]).map((p) => p.root_path)).toEqual(['/r/one']);
    const name = (list.projects as { name: string }[])[0]!.name;
    expect(await f.remove(name)).toEqual({ ok: true });
    expect(await f.remove(name)).toMatchObject({ ok: false, line: expect.stringContaining('not found') });
    f.stop();
  });
  test('cancel(): notifications/cancelled for that request → the run ends at once, the tool says cancelled', async () => {
    const st = state();
    const f = fronts({ FAKE_CBM_STATE: st, FAKE_CBM_INDEX_MS: '60000' });
    await f.start(); await until(() => f.ready(), 'control up');
    const run = f.run('/r/two', {});
    await until(() => { try { return jobs(st)['/r/two'] === 'running'; } catch { return false; } }, 'running');
    const t0 = Date.now();
    run.cancel();
    expect(await run.done).toEqual({ ok: false, line: 'Request cancelled' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await f.status('/r/two')).toBe('cancelled');
    f.stop();
  });
  test('a tool error of the index → { ok:false, line }', async () => {
    const f = fronts({ FAKE_CBM_STATE: state(), FAKE_CBM_INDEX_FAIL: 'bad' });
    await f.start(); await until(() => f.ready(), 'control up');
    expect(await f.run('/r/bad', {}).done).toEqual({ ok: false, line: 'index failed: /r/bad' });
    f.stop();
  });
});

describe('§5.5 R4 / module ready', () => {
  test('autoIndex() reads `<tool> config get auto_index` (true / false); onUp() runs each time the control front comes up', async () => {
    const on = fronts({ FAKE_CBM_AUTO_INDEX: 'true' });
    let ups = 0;
    on.onUp(() => { ups++; });
    await on.start(); await until(() => on.ready(), 'control up');
    expect(ups).toBe(1);
    expect(await on.autoIndex()).toBe(true);
    expect(events().some((e) => e.ev === 'config' && JSON.stringify((e as { args?: unknown }).args) === '["get","auto_index"]')).toBe(true);
    process.kill(starts(data).at(-1)!.pid, 'SIGKILL');
    await until(() => ups === 2, 'up again after a restart');
    on.stop();
    const off = fronts();
    await off.start();
    expect(await off.autoIndex()).toBe(false);
    off.stop();
  });
});

describe('§5.3 / §5.4 module error, Thử lại, update pause (G3b)', () => {
  test('§5.4 a control front not up within the error limit → failing() = its cause (state pushed); up again → null', async () => {
    writeFileSync(failFile, '');
    const f = fronts({}, { errorAfterMs: 150 });
    let pushes = 0;
    f.onState(() => { pushes++; });
    await f.start();
    expect(f.failing()).toBeNull(); // not yet: the 60 s rule
    await until(() => f.failing() !== null, 'error after the limit');
    expect(f.failing()).toBe('fake-cbm: conflicting CBM process is active'); // the front's last stderr line
    expect(pushes).toBeGreaterThanOrEqual(1);
    rmSync(failFile);
    await until(() => f.ready(), 'back up by itself');
    expect(f.failing()).toBeNull();
    f.stop();
  });
  test('§5.4 GR-err "Thử lại": retry() starts the control front now, not after the back-off', async () => {
    writeFileSync(failFile, '');
    const f = fronts({}, { backoff: 60_000 });
    await f.start();
    await Bun.sleep(200);
    expect(f.ready()).toBe(false);
    rmSync(failFile);
    f.retry();
    await until(() => f.ready(), 'up at once', 3000);
    f.stop();
  });
  test('§5.6 suspend(): rule 3 (not ready), every front closed, no spawn; resume(): the tool is read again, control up, a session front respawns on its next call', async () => {
    const f = fronts();
    await f.start();
    await until(() => f.ready(), 'control up');
    f.openSession('s9', join(tmp, 'wt-a'));
    const s = f.session('s9')!;
    await s.call(rpc(1, 'initialize', { protocolVersion: '2025-11-25' }), 5000);
    const ctl = starts(data).at(-1)!.pid; const sess = starts(join(tmp, 'wt-a')).at(-1)!.pid;
    f.suspend();
    expect(f.ready()).toBe(false);
    await until(() => !alive(ctl) && !alive(sess), 'fronts closed');
    expect(await s.call(rpc(2, 'tools/call', { name: 'search_graph', arguments: {} }), 2000).then(() => 'ok', (e: Error) => e.name)).toBe('FrontGone');
    await Bun.sleep(200);
    expect(starts(data).at(-1)!.pid).toBe(ctl); // no respawn while suspended
    await f.resume();
    await until(() => f.ready(), 'control up again');
    expect(f.session('s9')).toBe(s); // the session keeps its front slot
    const r = await s.call(rpc(3, 'tools/call', { name: 'search_graph', arguments: {} }), 5000);
    expect(r.error).toBeUndefined(); // respawned with the client's initialize replayed
    expect(f.toolRead()).toMatchObject({ state: 'ready', version: '0.12.1' });
    f.stop();
  });
  test('§5.6 a session spawned during the update (also from an old tool) gets its slot (rule 3 while suspended)', async () => {
    const f = fronts({ FAKE_CBM_VERSION: '0.8.1' });
    await f.start();
    expect(f.managed()).toBe(false);
    f.suspend(); // graph_update from `old`: every new spawn already carries the cc-slaves entry (§5.6 step 1)
    expect(f.managed()).toBe(true); // review-e MINOR-2: so graphSetup writes the cc-slaves entry for that spawn
    expect(f.ready()).toBe(false);
    f.openSession('s10', join(tmp, 'wt-b'));
    const s = f.session('s10');
    expect(s).not.toBeNull();
    expect(await s!.call(rpc(1, 'initialize', { protocolVersion: '2025-11-25' }), 2000).then(() => 'ok', (e: Error) => e.name)).toBe('FrontGone');
    await f.resume(); // the update failed: still the old tool → not managed again
    expect(f.managed()).toBe(false);
    f.stop();
  });
});
