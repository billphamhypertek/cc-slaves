// G1 review IMPORTANT-1 (v2 §7.1-2): while the caps.json import has not run (a broken caps.json at the first v2 boot),
// config.json stays the source of laneCaps / noNewLanes — the runtime keeps them, a config save keeps them in the file,
// and the next boot with a fixed caps.json imports them into the account table.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPS_IMPORTED_KEY, getAccount } from '../src/accounts/registry.ts';
import { getMeta } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import type { Conn } from '../src/server/ws.ts';

setDefaultTimeout(30_000);
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const ORCH = 'bo@example.org';
const PAUSED = 'd@x.test';
const NEW = 'n@x.test';
let tmp: string;
let saved: Record<string, string | undefined>;

const start = () => Engine.start({
  gh: null, // never the real gh (network)
  version: 'test', port: 0, token: 'tok', staticDir: join(tmp, 'web'), command: ['false'],
  loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
  quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
  caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
  exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
  fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
  notify: { osascript: () => {}, postGchat: async () => {} },
  closeGraceMs: 100, accountsEveryMs: 0, quotaEveryMs: 0, log: () => {}, hasLogin: () => true,
});

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-regboot-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'web'), { recursive: true });
  writeFileSync(join(tmp, 'web', 'index.html'), '<!doctype html>');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
});

afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

test('IMPORTANT-1 §7.1-2 broken caps.json: laneCaps / noNewLanes survive a config save and are imported on the next boot', async () => {
  writeFileSync(paths().caps, JSON.stringify({ default: { week: 98 }, 'x@y.z': { week: 0 } })); // fails validation
  writeFileSync(paths().config, JSON.stringify({ laneCaps: { [ORCH]: 0 }, noNewLanes: { [PAUSED]: true }, volume: 20 }));

  let e = await start();
  try {
    expect(getMeta(e.db, CAPS_IMPORTED_KEY)).toBeNull();
    expect(e.config.laneCaps).toEqual({ [ORCH]: 0 }); // the orchestrator's 0 is honoured, not overlaid by an empty table
    expect(e.config.noNewLanes).toEqual({ [PAUSED]: true });
    const h = buildHandlers(e, { channel: 'mac', watch: null, present: false, send() {} } as unknown as Conn);
    h.config_update({ cmd: 'config_update', patch: { volume: 50 } }, {} as never);
    const file = JSON.parse(readFileSync(paths().config, 'utf8'));
    expect(file).toMatchObject({ volume: 50, laneCaps: { [ORCH]: 0 }, noNewLanes: { [PAUSED]: true } });
    expect(getAccount(e.db, ORCH)).toBeNull(); // nothing written to the table before the import
    expect(e.config.laneCaps).toEqual({ [ORCH]: 0 });
    // a lane-cap edit before the import goes to config.json (kept for the import), not to the table
    h.config_update({ cmd: 'config_update', patch: { laneCaps: { [ORCH]: 0, [NEW]: 2 } } }, {} as never);
    expect(getAccount(e.db, NEW)).toBeNull();
    expect(JSON.parse(readFileSync(paths().config, 'utf8')).laneCaps).toEqual({ [ORCH]: 0, [NEW]: 2 });
    expect(e.config.laneCaps).toEqual({ [ORCH]: 0, [NEW]: 2 });
  } finally {
    await e.stop();
  }

  writeFileSync(paths().caps, JSON.stringify({ default: { week: 98 } })); // PO fixes caps.json
  e = await start();
  try {
    expect(getMeta(e.db, CAPS_IMPORTED_KEY)).not.toBeNull();
    expect(getAccount(e.db, ORCH)?.lanesMax).toBe(0);
    expect(getAccount(e.db, PAUSED)?.paused).toBe(true);
    expect(getAccount(e.db, NEW)?.lanesMax).toBe(2);
    expect(e.config.laneCaps).toEqual({ [ORCH]: 0, [NEW]: 2 });
    expect(e.config.noNewLanes).toEqual({ [PAUSED]: true });
    const after = JSON.parse(readFileSync(paths().config, 'utf8'));
    expect(after.volume).toBe(50);
    expect(Object.keys(after).filter((k) => k === 'laneCaps' || k === 'noNewLanes')).toEqual([]); // stripped after the import
  } finally {
    await e.stop();
  }
});

test('IMPORTANT-4 §7.1-2 caps_update before the import is refused, so the next boot still imports role + lane cap', async () => {
  rmSync(join(tmp, 'home'), { recursive: true, force: true });
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  writeFileSync(paths().caps, JSON.stringify({ default: { week: 98 }, 'x@y.z': { week: 0 } })); // fails validation
  writeFileSync(paths().config, JSON.stringify({ laneCaps: { [ORCH]: 0 } }));

  let e = await start();
  try {
    expect(getMeta(e.db, CAPS_IMPORTED_KEY)).toBeNull();
    const h = buildHandlers(e, { channel: 'mac', watch: null, present: false, send() {} } as unknown as Conn);
    expect(() => h.caps_update({ cmd: 'caps_update', caps: { [ORCH]: { week: 90 } } }, {} as never)).toThrow(/caps\.json/);
    expect(getAccount(e.db, ORCH)).toBeNull(); // nothing written to the table
  } finally {
    await e.stop();
  }

  writeFileSync(paths().caps, JSON.stringify({ default: { week: 98 }, [ORCH]: { role: 'orchestrator', week: 95, hard: true } }));
  e = await start();
  try {
    const row = getAccount(e.db, ORCH);
    expect(row?.role).toBe('orchestrator');
    expect(row?.week).toBe(95);
    expect(row?.lanesMax).toBe(0);
  } finally {
    await e.stop();
  }
});
