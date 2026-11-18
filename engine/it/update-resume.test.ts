// v2.6 §5.5-4 (R22, R15) the restart after an update, real Engine + fake-claude, temp homes, no network, no real quota.
// Boot 1: p1, p2, p4 resumed, p3 left held. Update hold: a PO message to p2 is held, a lane start in p4 is deferred
// (`starting`, no spawn); `update_commit` ok writes update-resume.json = [p1, p2, p4]. Boot 2 (the "new" engine): p1's idle
// orchestrator with nothing unsent → `idle`, 0 spawns, the next message boots it; p2's orchestrator boots and gets the
// held message; p4's deferred lane spawns exactly once (E1b ⑥: no double spawn); p3 stays held; the file is gone.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { insertOutbox, insertProject, insertSession, markDelivered, openDb, upsertQuota, type Db } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { hashOf } from '../test/_fixtures/po-pack.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import type { CommandCtx } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(60_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test', A = 'a@x.test';
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const MAC: CommandCtx = { channel: 'mac' };
const RESULT = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } };
const LOOP = { steps: Array.from({ length: 10 }, () => [{ waitUser: true }, RESULT]).flat() };

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
const runs: { trace: string; stdin: string }[] = [];

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}
/** The session id of each claude spawn from run `from` on (`--resume <id>` / `--session-id <id>`). */
const spawned = (from = 0): string[] => runs.slice(from).filter((r) => existsSync(r.trace)).map((r) => {
  const argv = (JSON.parse(readFileSync(r.trace, 'utf8')) as { argv: string[] }).argv;
  const i = argv.findIndex((a) => a === '--resume' || a === '--session-id');
  return i >= 0 ? argv[i + 1]! : '?';
});
const stdinOf = (sid: string, from = 0): string => runs.slice(from).filter((r) => existsSync(r.trace) && readFileSync(r.trace, 'utf8').includes(sid))
  .map((r) => (existsSync(r.stdin) ? readFileSync(r.stdin, 'utf8') : '')).join('\n');
const repo = (p: string) => join(tmp, `repo-${p}`);
const resumeFile = () => join(paths().home, 'update-resume.json');

/** Project `p`: an orchestrator session so-p that talked once (idle, nothing unsent). */
function seed(db: Db, p: string): void {
  mkdirSync(join(repo(p), '.git'), { recursive: true });
  insertProject(db, { id: p, name: `Shop ${p}`, path: repo(p), orchestratorAccount: O });
  insertSession(db, { id: `so-${p}`, projectId: p, kind: 'orchestrator', account: O });
  db.query("UPDATE session SET state = 'idle', prompt_hash = ?, seq = 1, account_home = ? WHERE id = ?").run(hashOf('general'), O, `so-${p}`);
  markDelivered(db, insertOutbox(db, { sessionId: `so-${p}`, text: 'tin đầu', prefix: '[cc-slaves]' }).uuid);
}

const start = async () => {
  engine = await Engine.start({
    gh: null, version: '0.3.0', port: 0, token: 't', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => {
      const n = runs.length + 1;
      const f = join(tmp, `scn-${n}.json`);
      writeFileSync(f, JSON.stringify(LOOP));
      const r = { trace: join(tmp, `trace-${n}.json`), stdin: join(tmp, `stdin-${n}.log`) };
      runs.push(r);
      return { FAKE_CLAUDE_SCENARIO: f, FAKE_CLAUDE_TRACE: r.trace, FAKE_CLAUDE_STDIN_LOG: r.stdin };
    },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    updateTickMs: 0, log: () => {}, hasLogin: () => true,
  });
};

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-upd-resume-')));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-marketplace': true } }));
  const db = openDb(paths().stateDb);
  seedAccounts([O, A], { db });
  const now = Math.floor(Date.now() / 1000);
  for (const a of [O, A]) upsertQuota(db, { account: a, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  for (const p of ['p1', 'p2', 'p3', 'p4']) seed(db, p);
  db.close();
  await start();
});

afterAll(async () => {
  await engine?.stop();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

const held = (id: string) => engine.snapshot('mac').projects.find((p) => p.id === id)?.held ?? null;

test('§5.5-4 R22/R15 restart after update_commit: quiet orchestrator idle (0 spawn), held message delivered, deferred lane spawned once, held project stays held', async () => {
  // boot 1: everything held; the PO resumes p1 and p2
  for (const p of ['p1', 'p2', 'p4']) { expect(await engine.held.wake(p)).toBe(true); }
  await until(() => ['p1', 'p2', 'p4'].every((p) => engine.orchestrators.get(p)?.view().state === 'idle'), 'p1, p2, p4 idle');
  expect(held('p3')).not.toBeNull();

  const app = { send: () => {} } as unknown as Conn;
  const h = buildHandlers(engine, app);
  await h.update_hold({ cmd: 'update_hold', on: true }, MAC);
  const before = runs.length;
  await h.send({ cmd: 'send', target: { kind: 'orchestrator', projectId: 'p2' }, text: 'tin giữ lại' }, MAC);
  mkdirSync(join(tmp, 'wt-D1'), { recursive: true });
  const lane = await engine.lanes.start({ projectId: 'p4', name: 'D1', cwd: join(tmp, 'wt-D1'), briefPath: '/b/D1.md' });
  expect(lane.state).toBe('starting');
  await Bun.sleep(300);
  expect(runs.length).toBe(before); // deferred: no spawn
  expect(stdinOf('so-p2')).not.toContain('tin giữ lại');
  expect(existsSync(resumeFile())).toBe(false);

  expect(await h.update_commit({ cmd: 'update_commit' }, MAC)).toEqual({ ok: true });
  const file = JSON.parse(readFileSync(resumeFile(), 'utf8')) as { from: string; at: number; projects: string[] };
  expect(file).toEqual({ from: '0.3.0', at: expect.any(Number) as number, projects: ['p1', 'p2', 'p4'] });

  // boot 2 — the new engine
  await engine.stop();
  const boot2 = runs.length;
  await start();
  expect(existsSync(resumeFile())).toBe(false);
  const laneSid = engine.lanes.list('p4').find((l) => l.name === 'D1')!.sessionId;
  await until(() => spawned(boot2).includes('so-p2') && spawned(boot2).includes(laneSid), 'p2 orchestrator + lane D1 spawned');
  await until(() => stdinOf('so-p2', boot2).includes('tin giữ lại'), 'held message delivered after the update');
  await until(() => stdinOf(laneSid, boot2).includes('/b/D1.md'), 'deferred lane got its brief');
  await until(() => engine.orchestrators.get('p2')!.view().state === 'idle', 'p2 idle again');
  await Bun.sleep(300);
  expect(spawned(boot2).filter((s) => s === laneSid)).toHaveLength(1); // E1b ⑥ no double spawn
  expect(spawned(boot2)).not.toContain('so-p1'); // R15 quiet orchestrator: no boot, no resume message
  expect(spawned(boot2)).not.toContain('so-p3');
  expect(engine.orchestrators.get('p1')!.view().state).toBe('idle');
  expect(held('p1')).toBeNull();
  expect(held('p2')).toBeNull();
  expect(held('p3')).toMatchObject({ kind: 'resume', sessions: 1 });

  // a message later boots p1's quiet orchestrator and is delivered
  await buildHandlers(engine, app).send({ cmd: 'send', target: { kind: 'orchestrator', projectId: 'p1' }, text: 'sau cập nhật' }, MAC);
  await until(() => stdinOf('so-p1', boot2).includes('sau cập nhật'), 'p1 boots on the next message');
  expect(spawned(boot2).filter((s) => s === 'so-p1')).toHaveLength(1);
});

test('§5.5-4 a restart with no resume file (crash, Thử lại) wakes nothing: every project with something unfinished is held', async () => {
  await engine.stop();
  const boot3 = runs.length;
  await start();
  await Bun.sleep(300);
  expect(spawned(boot3)).toEqual([]);
  for (const p of ['p1', 'p2', 'p3', 'p4']) expect(held(p)).not.toBeNull();
});

test('IMPORTANT-2 a sealed hold released with no update restart drops the resume file: a later crash restart wakes nothing', async () => {
  expect(await engine.held.wake('p1')).toBe(true);
  await until(() => engine.orchestrators.get('p1')?.view().state === 'idle', 'p1 idle');
  const app = { send: () => {} } as unknown as Conn;
  const h = buildHandlers(engine, app);
  await h.update_hold({ cmd: 'update_hold', on: true }, MAC);
  expect(await h.update_commit({ cmd: 'update_commit' }, MAC)).toEqual({ ok: true });
  expect(existsSync(resumeFile())).toBe(true);
  engine.update.closed(app); // the app crashed / the install failed after the commit: no restart came
  expect(existsSync(resumeFile())).toBe(false);
  await engine.stop();
  await start();
  await Bun.sleep(300);
  expect(held('p1')).not.toBeNull();
});
