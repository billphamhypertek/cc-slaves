#!/usr/bin/env bun
// E2E engine: the real boot path (engine/src/boot.ts: lock, engine.json, signals, web server) with every outside
// dependency faked from files in $E2E_DIR — never the real Keychain, login shell, `claude`, network or osascript.
//   token            ← written here (fake Keychain); the fixture reads it
//   scn/lane-<name>.json  scenario for that lane's spawns (worktree basename = lane name), else
//   scn/<email>.json  scenario for the next spawn on that account (else scn/default.json), read at spawn time
//   usage.json        {email: {fivePct, weekPct, fiveResetsAt?, weekResetsAt?}} — fake usage API (missing → error)
//   quota-seed.json   same shape, written into state.db before boot (fresh numbers without waiting for a tick)
//   accounts-seed.json {emails, tier} → usable v2 registry accounts under $CC_SLAVES_ACCOUNTS (engine/it/seed-accounts.ts)
//   auth.env          v2 §6: sourced by the fake `claude` before `auth …` / `mcp …` (FAKE_CLAUDE_AUTH, FAKE_CLAUDE_MCP_PLAN)
//   user/             v2.2: HOME of every `claude` the engine runs itself (`claude mcp` writes user/.claude.json = a
//                     link to $CLAUDE_JSON); never the real home, so the fake never touches the PO's ~/.claude.json
//   browser-private   flag file: the default browser supports a private window (A4 primary button)
//   logs: stdin-<email>.log, trace-<email>-<n>.json (argv of the n-th spawn), mcp.log, exec.log, osascript.log, browser.log, security.log
//   E2E_FAKE_AS=1     v2.2 §8 K3: a fake MCP server + OAuth AS (fake-mcp) on 127.0.0.1 in this process, its origin in
//                     fake-as.origin; fake-as.json {as?, mcp?} = knobs applied (then removed) on its next request; the MCP
//                     Keychain = the file-backed fake `security` (sec/); fetch reaches loopback only (never the network)
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, upsertQuota } from '../engine/src/db.ts';
import { runEngine } from '../engine/src/boot.ts';
import { ensureHome, paths } from '../engine/src/paths.ts';
import { seedAccounts } from '../engine/it/seed-accounts.ts';
import { securityCli } from '../engine/src/keychain.ts';
import { makeFakeSecurity } from '../engine/test/_fixtures/fake-security.ts';
import { fakeAuthServer, type FakeAs } from '../fake-mcp/src/oauth-as.ts';
import { startFakeMcp, type FakeMcp } from '../fake-mcp/src/server.ts';

const dir = process.env.E2E_DIR;
if (!dir) { console.error('E2E_DIR is not set'); process.exit(2); }
const FAKE = resolve(import.meta.dir, '../fake-claude/src/index.ts');
const f = (n: string) => join(dir, n);
const readJson = <T>(n: string): T | null => { try { return JSON.parse(readFileSync(f(n), 'utf8')) as T; } catch { return null; } };
type Usage = Record<string, { fivePct: number | null; weekPct: number | null; fiveResetsAt?: number | null; weekResetsAt?: number | null }>;
const now = () => Math.floor(Date.now() / 1000);

ensureHome();
const accts = readJson<{ emails: string[]; tier?: string }>('accounts-seed.json');
if (accts) seedAccounts(accts.emails, accts.tier ? { tier: accts.tier } : {});
const seed = readJson<Usage>('quota-seed.json');
if (seed) {
  const db = openDb(paths().stateDb);
  for (const [account, u] of Object.entries(seed)) {
    upsertQuota(db, {
      account, fivePct: u.fivePct, weekPct: u.weekPct, fiveResetsAt: u.fiveResetsAt ?? now() + 3 * 3600,
      weekResetsAt: u.weekResetsAt ?? now() + 3 * 86_400, source: 'api', fetchedAt: now(), status: 'ok',
    });
  }
  db.close();
}

// v2 §6 A3–A7: `claude auth login|status|logout` = fake-claude in this dir's env (never the real CLI / browser)
const claudePath = f('claude-bin'); // not f('claude'): that is CLAUDE_HOME
writeFileSync(claudePath, `#!/bin/sh\n[ -f ${JSON.stringify(f('auth.env'))} ] && . ${JSON.stringify(f('auth.env'))}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
chmodSync(claudePath, 0o755);
const userHome = f('user');
mkdirSync(userHome, { recursive: true });
try { symlinkSync(paths().claudeJson, join(userHome, '.claude.json')); } catch { /* engine restart (F10): the link is there */ }
let fakeAs: { mcp: FakeMcp; as: FakeAs } | null = null;
if (process.env.E2E_FAKE_AS) {
  let as: FakeAs | null = null;
  const mcp = startFakeMcp({
    routes: (req, url, body) => {
      const k = readJson<{ as?: Partial<FakeAs['knobs']>; mcp?: Partial<FakeMcp['knobs']> }>('fake-as.json');
      if (k) { rmSync(f('fake-as.json'), { force: true }); Object.assign(as!.knobs, k.as ?? {}); Object.assign(mcp.knobs, k.mcp ?? {}); }
      return as!.routes(req, url, body);
    },
  });
  as = fakeAuthServer(() => mcp);
  mcp.knobs.requireToken = 'none-issued-yet'; // no login yet → 401 + WWW-Authenticate
  fakeAs = { mcp, as };
  mkdirSync(f('sec'), { recursive: true });
  writeFileSync(f('fake-as.origin'), mcp.origin);
}
const spawns = new Map<string, number>();
const loopback = (u: string) => /^http:\/\/(127\.0\.0\.1|localhost):/.test(u);
const CHROME = '{ LSHandlers = ( { LSHandlerRoleAll = "com.google.chrome"; LSHandlerURLScheme = https; } ); }';
await runEngine({
  gh: null, // never the real gh (network; v2.1 §4.15 PR lookup)
  storeToken: async (t) => { writeFileSync(f('token'), t, { mode: 0o600 }); },
  command: ['bun', FAKE],
  loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: userHome, ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}) }, claudePath, shellFailed: false, reason: null },
  extraEnv: (a) => {
    const own = f(`scn/${a.email}.json`);
    const n = (spawns.get(a.email) ?? 0) + 1;
    spawns.set(a.email, n);
    return {
      FAKE_CLAUDE_TRACE: f(`trace-${a.email}-${n}.json`), // v2.4 §4.4 the argv of each spawn (`--model` / `--effort`)
      FAKE_CLAUDE_SCENARIO: existsSync(own) ? own : f('scn/default.json'), FAKE_CLAUDE_SCENARIO_DIR: f('scn'),
      FAKE_CLAUDE_STDIN_LOG: f(`stdin-${a.email}.log`), FAKE_CLAUDE_MCP_LOG: f('mcp.log'),
      // hf1117-perf a slow real boot (SessionStart hooks): a test writes `boot-ms`, read at each spawn
      ...(existsSync(f('boot-ms')) ? { FAKE_CLAUDE_BOOT_MS: readFileSync(f('boot-ms'), 'utf8').trim() } : {}),
    };
  },
  quotaSource: {
    fetchUsage: async (a) => {
      const u = readJson<Usage>('usage.json')?.[a.email];
      if (!u) throw new Error('e2e: no usage for this account');
      return { fivePct: u.fivePct, weekPct: u.weekPct, fiveResetsAt: u.fiveResetsAt ?? now() + 3 * 3600, weekResetsAt: u.weekResetsAt ?? now() + 3 * 86_400 };
    },
  },
  exec: async (argv) => {
    appendFileSync(f('exec.log'), `${JSON.stringify(argv)}\n`);
    if (argv[0] === claudePath && argv[1] === '--version') return { code: 0, stdout: '2.1.330 (Claude Code)\n', stderr: '' };
    if (argv[0] === 'open') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'e2e: exec disabled' };
  },
  hasLogin: () => true, // F16: never the real Keychain
  securityRun: (args) => { appendFileSync(f('security.log'), `${JSON.stringify(args)}\n`); return { code: 44, stderr: 'could not be found' }; },
  mcpKeychain: fakeAs ? securityCli(makeFakeSecurity(f('sec')).bin) // v2.2 §5.3: never the real Keychain
    : (args) => { appendFileSync(f('security.log'), `${JSON.stringify(args)}\n`); return { code: 44, stdout: '', stderr: 'could not be found' }; },
  browserExec: async (cmd, args) => {
    appendFileSync(f('browser.log'), `${JSON.stringify([cmd, ...args])}\n`);
    if (cmd === 'defaults') return { code: 0, stdout: existsSync(f('browser-private')) ? CHROME : '{ LSHandlers = ( ); }' };
    return { code: 0, stdout: '' };
  },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    if (fakeAs && loopback(input instanceof Request ? input.url : String(input))) return fetch(input, init);
    throw new Error('e2e: no network');
  }) as unknown as typeof fetch,
  notify: { osascript: (t, b) => { appendFileSync(f('osascript.log'), `${t}|${b}\n`); }, postGchat: async () => {} },
  caffeinateSpawner: () => ({ kill() {} }),
  // F7: E2E_LANE_TIME_SCALE scales lane timers (retry 20 s / 60 s → a fraction)
  ...(process.env.E2E_LANE_TIME_SCALE ? { laneTimers: { set: (fn: () => void, ms: number) => setTimeout(fn, ms * Number(process.env.E2E_LANE_TIME_SCALE)), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) } } : {}),
  // F15: E2E_PERMISSION_TTL_MS replaces the 30-minute permission expiry
  ...(process.env.E2E_PERMISSION_TTL_MS ? { cardTimers: { set: (fn: () => void) => setTimeout(fn, Number(process.env.E2E_PERMISSION_TTL_MS)), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) } } : {}),
  accountsEveryMs: 1000,
  quotaEveryMs: 0,
  log: (l) => appendFileSync(f('engine.log'), `${l}\n`),
});
