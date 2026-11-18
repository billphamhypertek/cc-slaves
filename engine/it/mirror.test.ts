// v2 §5.3 with fake-claude: the pre-spawn settings copy and the engine boot mirror + watch (the session MCP file:
// session-mcp.test.ts).
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QuotaTracker } from '../src/accounts/quota.ts';
import type { Account } from '../src/accounts/registry.ts';
import { insertProject, openDb, upsertQuota, type Db } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { LaneManager } from '../src/lane/manager.ts';
import { Outbox } from '../src/outbox.ts';
import { paths } from '../src/paths.ts';
import { ensureMirrored } from '../src/accounts/mirror.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(20_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const A = 'a@x.test';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-mirror-it-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'claude'), { recursive: true, mode: 0o700 });
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(20);
  }
}

describe('pre-spawn settings copy (v2 §5.3)', () => {
  let db: Db;
  let mgr: LaneManager | null = null;
  afterEach(async () => { await mgr?.shutdown(); mgr = null; db.close(); });

  test('§5.3 source edited before the spawn → copy updated before the process starts', async () => {
    db = openDb(join(tmp, 'state.db'));
    insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1') });
    const cwd = join(tmp, 'wt');
    mkdirSync(cwd, { recursive: true });
    const cfgDir = join(tmp, 'accts', 'aaaaaaaaaaaa');
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    // the PO edits ~/.claude/settings.json; no boot mirror ran → only the pre-spawn check can bring it over
    writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ model: 'opus', env: { CLAUDE_CONFIG_DIR: '/x', K: 'v' } }));
    const account: Account = { email: A, id: 'aaaaaaaaaaaa', configDir: cfgDir, keychainService: 'k', planTier: 'max', terminal: false };
    const now = Math.floor(Date.now() / 1000);
    upsertQuota(db, { account: A, fivePct: 1, weekPct: 1, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
    const scn = join(tmp, 'scn.json');
    writeFileSync(scn, JSON.stringify({
      steps: [{ waitUser: true }, { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } }, { waitUser: true }],
    }));
    let settingsAtSpawn: unknown = null;
    const tracker: QuotaTracker = new QuotaTracker({ db, source: { fetchUsage: () => Promise.reject(new Error('no network')) }, onAccountChanged: () => {} });
    mgr = new LaneManager({
      db, outbox: new Outbox(db), accounts: () => [account], quota: tracker, caps: () => ({ default: { week: 98, five: 95 } }),
      loggedOut: () => new Set(), config: () => ({ maxLanes: 8, maxLanesPerAccount: 3 }), command: ['bun', FAKE], mcpPort: 1,
      env: () => {
        // env() runs at Bun.spawn time, after beforeSpawn: what the process would see on disk
        settingsAtSpawn = JSON.parse(readFileSync(join(cfgDir, 'settings.json'), 'utf8'));
        return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_SCENARIO: scn };
      },
      session: { initTimeoutMs: 5000, interruptTimeoutMs: 300, sleep: async () => {}, ps: async () => [], beforeSpawn: (d) => { ensureMirrored(d); } },
      closeGraceMs: 300,
    });
    await mgr.start({ projectId: 'p1', name: 'D1', cwd, briefPath: '/briefs/D1.md' });
    await until(() => mgr!.listAll().some((v) => v.state === 'idle' || v.state === 'running'), 'lane up');
    expect(settingsAtSpawn).toEqual({ model: 'opus', env: { K: 'v' } });
  });
});

describe('engine boot mirror + watch (v2 §5.3)', () => {
  test('§5.3 boot copies settings into every account dir; a later source edit lands within the 1 s debounce', async () => {
    const db = openDb(paths().stateDb);
    const dir = seedAccounts([A], { db })[0]!.configDir;
    db.close();
    writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    const engine = await Engine.start({
      gh: null, // never the real gh (network)
      version: 'test', port: 0, token: 't'.repeat(43), staticDir: null, command: ['bun', FAKE],
      loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
      quotaSource: { fetchUsage: () => Promise.reject(new Error('no network')) },
      caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
      exec: async () => ({ code: 1, stdout: '', stderr: 'fake' }),
      fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
      notify: { osascript: () => {}, postGchat: async () => {} },
      accountsEveryMs: 0, quotaEveryMs: 0, log: () => {}, hasLogin: () => true,
    });
    try {
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ model: 'opus' });
      writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ model: 'sonnet' }));
      await until(() => readFileSync(join(dir, 'settings.json'), 'utf8').includes('sonnet'), 'watch mirror', 5000);
    } finally {
      await engine.stop();
    }
  });
});
