// hotfix 2026-11-16 held projects + "Đóng project" (engine): an app restart holds every project that had something
// unfinished (0 claude spawns) until `project_resume` or a PO message; `project_close` refuses while work runs, hides the
// project and keeps it out of the next recovery; re-adding its folder reopens it held with its history.
// Real Engine + fake-claude, temp homes, no network, no real quota.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getLane, insertLane, insertOutbox, insertProject, insertSession, listUndelivered, markDelivered, openDb, upsertQuota, type Db } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { hashOf } from '../test/_fixtures/po-pack.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import type { CommandCtx } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(40_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test', A = 'a@x.test';
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const MAC: CommandCtx = { channel: 'mac' };
const RESULT = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } };
const LOOP = { steps: Array.from({ length: 10 }, () => [{ waitUser: true }, RESULT]).flat() };

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let h: ReturnType<typeof buildHandlers>;
const traces: string[] = [];
const repo = (p: string) => join(tmp, `repo-${p}`);

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}
async function err(p: unknown): Promise<{ code: string; key?: string; message?: string; params?: Record<string, unknown> }> {
  try { await p; } catch (e) { return e as { code: string; params?: Record<string, unknown> }; }
  throw new Error('expected a rejection');
}
/** The session id each claude spawn ran (`--resume <id>` / `--session-id <id>`), in spawn order. */
const spawned = (from = 0): string[] => traces.slice(from).filter((f) => existsSync(f)).map((f) => {
  const argv = (JSON.parse(readFileSync(f, 'utf8')) as { argv: string[] }).argv;
  const i = argv.findIndex((a) => a === '--resume' || a === '--session-id');
  return i >= 0 ? argv[i + 1]! : '?';
});

/** Project `p`: orchestrator session so-p (idle, talked to) and lane L-p running on A when the old engine died. */
function seed(db: Db, p: string): void {
  mkdirSync(join(repo(p), '.git'), { recursive: true });
  insertProject(db, { id: p, name: `Shop ${p}`, path: repo(p), orchestratorAccount: O });
  insertSession(db, { id: `so-${p}`, projectId: p, kind: 'orchestrator', account: O });
  db.query("UPDATE session SET state = 'idle', prompt_hash = ?, seq = 1, account_home = ? WHERE id = ?").run(hashOf('general'), O, `so-${p}`);
  markDelivered(db, insertOutbox(db, { sessionId: `so-${p}`, text: 'tin đầu', prefix: '[cc-slaves]' }).uuid);
  const cwd = join(tmp, `wt-${p}`);
  mkdirSync(cwd, { recursive: true });
  insertSession(db, { id: `sl-${p}`, projectId: p, kind: 'lane', account: A });
  db.query("UPDATE session SET state = 'running', prompt_hash = ? WHERE id = ?").run(hashOf('lane'), `sl-${p}`);
  insertLane(db, { projectId: p, name: `L-${p}`, cwd, sessionId: `sl-${p}`, briefPath: `/b/${p}.md`, state: 'running', ownerSession: `so-${p}` });
  markDelivered(db, insertOutbox(db, { sessionId: `sl-${p}`, text: 'brief', prefix: null }).uuid);
}

const start = async () => {
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => {
      const n = traces.length + 1;
      const f = join(tmp, `scn-${n}.json`);
      writeFileSync(f, JSON.stringify(LOOP));
      const trace = join(tmp, `trace-${n}.json`);
      traces.push(trace);
      return { FAKE_CLAUDE_SCENARIO: f, FAKE_CLAUDE_TRACE: trace };
    },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
  });
  h = buildHandlers(engine, {} as Conn);
};

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-held-')));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-marketplace': true } })); // the default pack
  const db = openDb(paths().stateDb);
  seedAccounts([O, A], { db });
  const now = Math.floor(Date.now() / 1000);
  for (const a of [O, A]) upsertQuota(db, { account: a, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  seed(db, 'p1');
  seed(db, 'p2');
  seed(db, 'p3');
  seed(db, 'p4');
  db.close();
  await start();
});

afterAll(async () => {
  await engine?.stop();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

/** Live fake-claude processes of this test's temp home (whose argv names `sid` when given). */
const alive = (sid?: string): number => Bun.spawnSync(['ps', '-axo', 'command=']).stdout.toString().split('\n')
  .filter((l) => l.includes('fake-claude') && l.includes(tmp) && (sid === undefined || l.includes(sid))).length;
const held = (id: string) => engine.snapshot('mac').projects.find((p) => p.id === id)?.held;

describe('hf1116 held projects', () => {
  test('hf1116 H1 restart with 2 projects (orchestrator + running lane each) → 0 spawns, both held, rows keep their state', async () => {
    await Bun.sleep(300);
    expect(spawned()).toEqual([]);
    for (const p of ['p1', 'p2']) {
      expect(held(p)).toEqual({ kind: 'resume', sessions: 1, lanes: 1 });
      expect(engine.lanes.get(p, `L-${p}`)?.state).toBe('paused');
      expect(engine.orchestrators.list(p).map((o) => o.view().state)).toEqual(['paused']);
      expect(getLane(engine.db, p, `L-${p}`)?.state).toBe('running'); // never persisted
    }
    expect(engine.snapshot('mac').lanes.find((l) => l.name === 'L-p1')?.state).toBe('paused');
  });

  test('hf1116 H4 a lane notice, account / quota changes do not boot a held project; the notice waits in the outbox', async () => {
    engine.orchestrators.notify('p2', '[cc-slaves] lane L-p2 rảnh', 'L-p2');
    engine.accountChanged(O);
    engine.accountChanged(A);
    await Bun.sleep(300);
    expect(spawned()).toEqual([]);
    expect(listUndelivered(engine.db, 'so-p2').map((m) => m.text)).toEqual(['[cc-slaves] lane L-p2 rảnh']);
    expect(held('p2')).toEqual({ kind: 'resume', sessions: 1, lanes: 1 });
  });

  test('hf1116 A-I1 send to a held project ‖ project_close → no claude of the closed project is left running', async () => {
    const r = await Promise.allSettled([
      h.send({ cmd: 'send', target: { kind: 'orchestrator', projectId: 'p3' }, text: 'chạy tiếp' }, MAC),
      h.project_close({ cmd: 'project_close', id: 'p3' }, MAC),
    ]);
    expect(r[1].status).toBe('fulfilled');
    await Bun.sleep(1500);
    expect(spawned().filter((s) => s.endsWith('-p3'))).toEqual([]);
    expect(alive('-p3')).toBe(0);
    expect(engine.lanes.list('p3')).toEqual([]);
    expect(engine.orchestrators.list('p3')).toEqual([]);
    // A-M2 the menu bar (healthz) counts open cards of open projects only, as the snapshot does
    const before = engine.health().openCards;
    engine.db.query("INSERT INTO card (project_id, session_id, kind, payload, created_at) VALUES ('p3', 'so-p3', 'ask', '{}', 0)").run();
    expect(engine.health().openCards).toBe(before);
  });

  test('hf1116 A-I1 project_resume ‖ project_close → no claude of the closed project is left running', async () => {
    const o = engine.orchestrators.list('p4')[0]!;
    const r = await Promise.allSettled([
      h.project_resume({ cmd: 'project_resume', id: 'p4' }, MAC),
      h.project_close({ cmd: 'project_close', id: 'p4' }, MAC),
    ]);
    expect(r[1].status).toBe('fulfilled');
    await Bun.sleep(1500);
    await o.boot(); // a straggler boot of the dropped session (a queued job) spawns nothing
    await Bun.sleep(300);
    expect(spawned().filter((s) => s.endsWith('-p4'))).toEqual([]);
    expect(alive('-p4')).toBe(0);
  });

  test('hf1116 H3 project_resume of p1 → only p1 sessions spawn (resume); p2 stays held; resume again is a no-op', async () => {
    const v = await h.project_resume({ cmd: 'project_resume', id: 'p1' }, MAC) as { held: unknown };
    expect(v.held).toBeNull();
    await until(() => spawned().length === 2, 'p1 orchestrator + lane spawned');
    expect(spawned().sort()).toEqual(['sl-p1', 'so-p1']);
    await until(() => engine.orchestrators.get('p1')?.view().state === 'idle', 'p1 orchestrator idle');
    await until(() => engine.lanes.get('p1', 'L-p1')?.state === 'idle', 'p1 lane idle');
    expect(held('p2')).toEqual({ kind: 'resume', sessions: 1, lanes: 1 });
    await h.project_resume({ cmd: 'project_resume', id: 'p1' }, { channel: 'remote' }); // REMOTE_ALLOWED, idempotent
    await Bun.sleep(200);
    expect(spawned()).toHaveLength(2);
  });

  test('hf1116 H3 a PO send to a held project resumes all of it first; the queued notice goes out', async () => {
    await h.send({ cmd: 'send', target: { kind: 'orchestrator', projectId: 'p2' }, text: 'chạy tiếp' }, MAC);
    await until(() => spawned().length === 4, 'p2 orchestrator + lane spawned');
    expect(spawned().slice(2).sort()).toEqual(['sl-p2', 'so-p2']);
    expect(held('p2')).toBeNull();
    await until(() => listUndelivered(engine.db, 'so-p2').length === 0, 'p2 outbox drained');
  });

  test('hf1116 H5 project_close refused while a lane runs (project_busy + counts), OK once stopped / idle; gone from the snapshot', async () => {
    await until(() => engine.lanes.get('p1', 'L-p1')?.state === 'idle', 'p1 lane idle');
    await h.send({ cmd: 'send', target: { kind: 'lane', projectId: 'p1', name: 'L-p1' }, text: 'làm tiếp' }, MAC);
    await until(() => engine.lanes.get('p1', 'L-p1')?.state === 'running', 'p1 lane running');
    const e = await err(h.project_close({ cmd: 'project_close', id: 'p1' }, MAC));
    expect(e.code).toBe('project_busy');
    expect(e.params).toMatchObject({ name: 'Shop p1', lanes: 1 });
    // A-M5 a 0 part never reads "0 phiên": lanes only → its own key
    expect(e.key).toBe('errors.projectBusyLanes');
    expect(e.message).toBe('Không đóng được Shop p1: còn 1 lane đang chạy. Dừng hoặc chờ chúng xong rồi đóng.');
    await engine.lanes.stop('p1', 'L-p1', 'now');
    await until(() => engine.orchestrators.get('p1')?.view().state === 'idle', 'p1 orchestrator idle');
    expect(await h.project_close({ cmd: 'project_close', id: 'p1' }, MAC)).toEqual({ id: 'p1' });
    const s = engine.snapshot('mac');
    expect(s.projects.map((p) => p.id)).toEqual(['p2']);
    expect(s.lanes.some((l) => l.projectId === 'p1')).toBe(false);
    expect(s.orchestrators.some((o) => o.projectId === 'p1')).toBe(false);
    expect(engine.orchestrators.list('p1')).toEqual([]);
    expect((await err(h.project_resume({ cmd: 'project_resume', id: 'p1' }, MAC))).code).toBe('no_project');
    // its orchestrator session stays unfinished (a reopen holds it)
    expect(engine.db.query<{ ended_at: number | null }, []>("SELECT ended_at FROM session WHERE id = 'so-p1'").get()!.ended_at).toBeNull();
  });

  test('hf1116 H5 a closed project is not restored on the next start; the open one is held again; a paused project closes', async () => {
    await engine.stop();
    await Bun.sleep(300);
    expect(alive()).toBe(0); // A-I1: engine.stop() leaves no claude behind (none escaped a close race)
    const before = traces.length;
    await start();
    await Bun.sleep(300);
    expect(traces.length).toBe(before);
    expect(engine.orchestrators.list('p1')).toEqual([]);
    expect(engine.lanes.list('p1')).toEqual([]);
    expect(held('p2')).toMatchObject({ kind: 'resume', sessions: 1 });
    expect(await h.project_close({ cmd: 'project_close', id: 'p2' }, MAC)).toEqual({ id: 'p2' });
    expect(engine.snapshot('mac').projects).toEqual([]);
  });

  test('hf1116 H2 re-adding a closed folder reopens the same project held, with its sessions and a new name; nothing spawns', async () => {
    const before = traces.length;
    const v = await h.project_add({ cmd: 'project_add', name: 'Shop mới', path: repo('p1') }, MAC) as { id: string; name: string; held: unknown };
    expect(v).toMatchObject({ id: 'p1', name: 'Shop mới', held: { kind: 'resume', sessions: 1, lanes: 0 } });
    expect(engine.orchestrators.list('p1').map((o) => [o.currentSessionId, o.view().state])).toEqual([['so-p1', 'paused']]);
    expect(engine.lanes.get('p1', 'L-p1')?.state).toBe('stopped');
    await Bun.sleep(200);
    expect(traces.length).toBe(before);
    await h.project_resume({ cmd: 'project_resume', id: 'p1' }, MAC);
    await until(() => spawned(before).includes('so-p1'), 'reopened orchestrator resumed');
  });

  test('hf1117-perf a folder with specs: its spec_changed events are sent before the `project` event (Tasks never paints it empty)', async () => {
    mkdirSync(join(repo('p6'), '.git'), { recursive: true });
    mkdirSync(join(repo('p6'), 'docs/specs'), { recursive: true });
    writeFileSync(join(repo('p6'), 'docs/specs/v1.md'), `# v1\n\n**Status:** approved\n\n${'mô tả '.repeat(60)}\n`);
    const sent: string[] = [];
    const broadcast = engine.broadcast.bind(engine);
    Object.defineProperty(engine.hub, 'macCount', { get: () => 1, configurable: true }); // a Mac client is on
    engine.broadcast = (ev) => { sent.push(ev.type); broadcast(ev); };
    try {
      await h.project_add({ cmd: 'project_add', name: 'Shop 6', path: repo('p6') }, MAC);
    } finally { engine.broadcast = broadcast; delete (engine.hub as { macCount?: number }).macCount; } // the class getter again
    expect(sent.indexOf('spec_changed')).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf('spec_changed')).toBeLessThan(sent.lastIndexOf('project'));
  });

  test('hf1116 A-M3 a project added but never answered is still "start" (not "resume") after a restart', async () => {
    mkdirSync(join(repo('p5'), '.git'), { recursive: true });
    const v = await h.project_add({ cmd: 'project_add', name: 'Shop 5', path: repo('p5') }, MAC) as { id: string; held: unknown };
    expect(v.held).toEqual({ kind: 'start', sessions: 1, lanes: 0 });
    await until(() => engine.orchestrators.get('p1')?.view().state === 'idle', 'p1 orchestrator idle');
    await engine.stop();
    await start();
    expect(held(v.id)).toEqual({ kind: 'start', sessions: 1, lanes: 0 });
    expect(held('p1')).toMatchObject({ kind: 'resume' });
  });
});

describe('hf-sp a new project without the default pack\'s plugin runs Giao thẳng', () => {
  const settings = (body: string | null) => {
    const f = join(tmp, 'claude', 'settings.json');
    if (body === null) rmSync(f, { force: true }); else writeFileSync(f, body);
  };
  const add = async (p: string, name: string) => {
    mkdirSync(join(repo(p), '.git'), { recursive: true });
    return await h.project_add({ cmd: 'project_add', name, path: repo(p) }, MAC) as { id: string; workflow?: string; workflowFallback?: string | null };
  };
  test('hf-sp superpowers not on (no settings file) → builtin:direct, the reason kept; Áp dụng another pack clears it', async () => {
    settings(null);
    const v = await add('sp1', 'Không SP');
    expect(v).toMatchObject({ workflow: 'builtin:direct', workflowFallback: 'superpowers' });
    expect(engine.projectView(v.id)).toMatchObject({ workflow: 'builtin:direct', workflowFallback: 'superpowers' });
    await h.project_set_workflow({ cmd: 'project_set_workflow', projectId: v.id, id: 'builtin:po' }, MAC);
    expect(engine.projectView(v.id)).toMatchObject({ workflow: 'builtin:po', workflowFallback: null });
  });
  test('hf-sp superpowers on → the default pack, no reason', async () => {
    settings(JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-marketplace': true } }));
    expect(await add('sp2', 'Có SP')).toMatchObject({ workflow: 'builtin:po', workflowFallback: null });
  });
  test('hf-sp plugin state unknown (settings not JSON) → the default pack, no guess', async () => {
    settings('{');
    expect(await add('sp3', 'Chưa rõ SP')).toMatchObject({ workflow: 'builtin:po', workflowFallback: null });
  });
});
