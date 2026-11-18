// v2.1 §4.15 §4 / §7.1 a lane restored at engine boot whose first event is "done" still notifies "lane xong" (T12b-4):
// the engine's previous-lane map is seeded from state.db at boot. Real Engine + fake-claude, temp homes, no network.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { insertLane, insertProject, insertSession, openDb, updateLaneState } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
const osa: string[] = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-recnotify-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  const repo = join(tmp, 'shop');
  mkdirSync(join(repo, '.git'), { recursive: true });
  // the state an earlier engine left behind: lane L1 idle in its own session (no process alive any more)
  const db = openDb(paths().stateDb);
  insertProject(db, { id: 'p', name: 'Shop', path: repo });
  insertSession(db, { id: 's-l1', projectId: 'p', kind: 'lane', account: null });
  db.query("UPDATE session SET state = 'idle' WHERE id = 's-l1'").run();
  const l = insertLane(db, { projectId: 'p', name: 'L1', cwd: repo, sessionId: 's-l1' });
  updateLaneState(db, l.id, 'idle');
  // lane L2 reported done (phase done, not finished) and never measured before the restart (g5-fix-engine ③ `seeded`)
  mkdirSync(join(tmp, 'l2'), { recursive: true });
  insertSession(db, { id: 's-l2', projectId: 'p', kind: 'lane', account: null });
  db.query("UPDATE session SET state = 'idle' WHERE id = 's-l2'").run();
  const l2 = insertLane(db, { projectId: 'p', name: 'L2', cwd: join(tmp, 'l2'), sessionId: 's-l2' });
  updateLaneState(db, l2.id, 'idle');
  db.query("UPDATE lane SET phase = 'done' WHERE id = ?").run(l2.id);
  db.close();
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 'tok', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: (t, b) => osa.push(`${t}|${b}`), postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => false,
  });
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§4.15 §4 restored lane → done as its first event', () => {
  test('§4.15 §4 a lane restored at boot and finished before any other event still notifies "lane xong"', async () => {
    expect(engine.lanes.get('p', 'L1')?.state).toBe('idle'); // restored, no lane event since boot
    await engine.lanes.finish('p', 'L1', true);
    expect(engine.lanes.get('p', 'L1')?.state).toBe('done');
    const end = Date.now() + 5000;
    while (!osa.some((x) => x.includes('L1')) && Date.now() < end) await Bun.sleep(15);
    expect(osa.filter((x) => x.startsWith('Shop · L1|'))).toHaveLength(1); // no app connected → osascript, title "project · lane"
  });
});

describe('§4.15 restored reported-done lane, never measured', () => {
  test('§4.15 the boot seed keeps the first-event rule: its first event after restart measures the branch', async () => {
    const measured: string[] = [], runs: Promise<unknown>[] = [];
    const b = engine.branches as unknown as { measure: (row: { name: string }) => Promise<unknown> };
    const orig = b.measure.bind(b);
    b.measure = (row) => { measured.push(row.name); const r = orig(row); runs.push(r); return r; };
    await engine.lanes.setPhase('p', 'L2', { phase: 'done', note: 'xong' }); // phase done → done: no transition
    const end = Date.now() + 3000;
    while (!measured.includes('L2') && Date.now() < end) await Bun.sleep(15);
    expect(measured).toContain('L2');
    await Promise.allSettled(runs); // no measurement may outlive the test's db
  });
});
