// hf1117-perf a session acks before its claude boots (`starting` for seconds): engine stop in that window must leave no
// claude behind (the real app would otherwise orphan real `claude` processes). fake-claude boots slowly here
// (FAKE_CLAUDE_BOOT_MS), like a real one running the PO's SessionStart hooks. Real Engine, temp homes, no network.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { insertOutbox, insertProject, insertSession, markDelivered, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { hashOf } from '../test/_fixtures/po-pack.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const BOOT_MS = 1500;
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;

/** Live fake-claude processes of this test's temp home. */
const alive = (): number => Bun.spawnSync(['ps', '-axo', 'command=']).stdout.toString().split('\n')
  .filter((l) => l.includes('fake-claude') && l.includes(tmp)).length;

async function until(cond: () => boolean, what: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-startstop-')));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'repo', '.git'), { recursive: true });
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(db, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  insertProject(db, { id: 'p1', name: 'Shop', path: join(tmp, 'repo'), orchestratorAccount: O });
  insertSession(db, { id: 'so-p1', projectId: 'p1', kind: 'orchestrator', account: O });
  db.query("UPDATE session SET state = 'idle', prompt_hash = ?, seq = 1, account_home = ? WHERE id = 'so-p1'").run(hashOf('general'), O);
  markDelivered(db, insertOutbox(db, { sessionId: 'so-p1', text: 'tin đầu', prefix: '[cc-slaves]' }).uuid);
  db.close();
  const scn = join(tmp, 'scn.json');
  writeFileSync(scn, JSON.stringify({ steps: [{ waitUser: true }] }));
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => ({ FAKE_CLAUDE_SCENARIO: scn, FAKE_CLAUDE_BOOT_MS: String(BOOT_MS) }),
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
  });
});

afterAll(async () => {
  await engine?.stop();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('hf1117-perf engine stop while a session is starting', () => {
  test('project_resume → `starting` with its claude still booting; engine.stop() → no claude left within 2 s', async () => {
    await engine.held.wake('p1');
    const o = engine.orchestrators.list('p1')[0]!;
    await until(() => alive() === 1, 'the booting claude', 3000);
    expect(o.view().state).toBe('starting'); // still inside FAKE_CLAUDE_BOOT_MS: no init yet
    const t0 = Date.now();
    await engine.stop();
    await until(() => alive() === 0, 'no claude left', 2000);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
