// v2.5 §5.2 / §5.8 the Bộ công cụ commands against a real engine: fake-claude for `claude plugin` (marketplace add /
// update, install, update), temp HOME / CLAUDE_HOME / CLAUDE_JSON / accounts. Never the real ~/.claude or any network.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, ServerMsg } from '../../shared/protocol.ts';
import type { ToolkitView } from '../../shared/toolkit.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { route } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(60_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const SP = 'superpowers@claude-plugins-official';
const UX = 'ui-ux-pro-max@ui-ux-pro-max-skill';
const C7 = 'context7@claude-plugins-official';
const VC = 'vercel@claude-plugins-official';
let tmp: string;
let home: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let remote: string;
let plan: string;
let log: string;
const pushed: ToolkitView[] = [];
const remoteSeen: string[] = [];

const official = (spSha: string, c7Text: string) => ({
  name: 'claude-plugins-official', head: 'b5b01ac4f889aaaa',
  plugins: [
    { name: 'superpowers', sha: spSha, pluginVersion: spSha === 's1' ? '7.0.0' : '7.0.2', files: {} },
    { name: 'context7', files: { '.mcp.json': JSON.stringify({ context7: { type: 'http', url: 'https://mcp.context7.test/mcp' } }), 'README.md': c7Text } },
    { name: 'vercel', sha: 'v1', pluginVersion: '0.50.0' },
  ],
});
const writeRemote = (spSha: string, c7Text = 'c7', uxVersion = '2.15.0') => writeFileSync(remote, JSON.stringify({
  'anthropics/claude-plugins-official': official(spSha, c7Text),
  'nextlevelbuilder/ui-ux-pro-max-skill': { name: 'ui-ux-pro-max-skill', head: 'u1', plugins: [{ name: 'ui-ux-pro-max', version: uxVersion, files: { 'skills/ui-ux-pro-max/SKILL.md': '---\nname: ui-ux-pro-max\ndescription: design\n---\n' } }] },
}));
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(20); }
}
const conn = (channel: 'mac' | 'remote'): Conn => ({ channel, watch: null, present: true, send: () => {} });
async function cmd(command: Command, channel: 'mac' | 'remote' = 'mac'): Promise<ServerMsg> {
  return route(buildHandlers(engine, conn(channel)), { channel }, { type: 'command', id: 'x', command });
}
const ack = async (command: Command): Promise<ToolkitView> => {
  const r = await cmd(command);
  if (r.type !== 'ack') throw new Error(`${command.cmd}: ${JSON.stringify(r)}`);
  return r.result as ToolkitView;
};
const row = (key: string) => engine.toolkit.view().rows.find((r) => r.key === key)!;
const idle = () => until(() => engine.toolkit.view().rows.every((r) => r.state !== 'running'), 'toolkit idle');

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-toolkit-it-')));
  home = join(tmp, 'user');
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(home, '.claude');
  process.env.CLAUDE_JSON = join(home, '.claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  writeFileSync(paths().claudeJson, '{}');
  writeFileSync(paths().caps, JSON.stringify({ default: { week: 99 }, [O]: { role: 'orchestrator', week: 99 } }));
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  db.close();
  const claude = join(tmp, 'claude-bin');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(claude, 0o755);
  remote = join(tmp, 'remote.json');
  plan = join(tmp, 'plan.json');
  log = join(tmp, 'plugin.log');
  writeRemote('s1');
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: null, command: ['bun', FAKE],
    // CLAUDE_CONFIG_DIR in the login env: `claude plugin` must run without it (§5.2, research §1.3)
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: join(tmp, 'wrong'), FAKE_CLAUDE_PLUGIN_REMOTE: remote, FAKE_CLAUDE_PLUGIN_PLAN: plan, FAKE_CLAUDE_PLUGIN_LOG: log }, claudePath: claude, shellFailed: false, reason: null },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    // git --version for SetupStatus.git (R3): `ok` unless a test swaps it
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    gitExec: async (argv) => (argv[1] === '--version' || argv[1] === '-p' ? { code: 0, stdout: argv[1] === '-p' ? '/Library/Developer/CommandLineTools\n' : 'git version 2.50.1\n', stderr: '' } : { code: 1, stdout: '', stderr: 'x' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true, securityRun: () => ({ code: 0, stderr: '' }), authCheckTimeoutMs: 30_000,
  });
  engine.hub.open({ channel: 'mac', watch: null, present: true, send: (m) => { if (m.type === 'event' && m.event.type === 'toolkit') pushed.push(m.event.view); } });
  engine.hub.open({ channel: 'remote', watch: null, present: true, send: (m) => { if (m.type === 'event') remoteSeen.push(m.event.type); } });
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§5.8 view + channel', () => {
  test('§5.8 the Mac snapshot carries the toolkit view (four plugin rows missing); the remote one does not', () => {
    const v = engine.snapshot('mac').toolkit!;
    expect(v.rows.map((r) => [r.key, r.state])).toEqual([['superpowers', 'missing'], ['ui-ux-pro-max', 'missing'], ['context7', 'missing'], ['vercel', 'missing']]);
    expect(engine.snapshot('remote').toolkit).toBeUndefined();
  });

  test('§5.8 every toolkit command on the remote channel → forbidden_remote, nothing run', async () => {
    for (const c of [{ cmd: 'toolkit_check' }, { cmd: 'toolkit_install', keys: ['superpowers'] }, { cmd: 'toolkit_update', key: 'superpowers' }] as Command[]) {
      expect(await cmd(c, 'remote')).toMatchObject({ type: 'error', code: 'forbidden_remote' });
    }
    expect(calls()).toEqual([]);
  });

  test('§5.8 a key outside the catalog → bad_input; toolkit_update of the graph tool → bad_input (GR-upd, §5.6)', async () => {
    expect(await cmd({ cmd: 'toolkit_install', keys: ['nope' as never] })).toMatchObject({ type: 'error', code: 'bad_input', key: 'errors.toolkitKey' });
    expect(await cmd({ cmd: 'toolkit_install', keys: [] })).toMatchObject({ type: 'error', code: 'bad_input' });
    expect(await cmd({ cmd: 'toolkit_update', key: 'graph' })).toMatchObject({ type: 'error', code: 'bad_input' });
    expect(calls()).toEqual([]);
  });
});

describe('§5.2 install / check / update through `claude plugin`', () => {
  test('§5.2 install all: ack with rows running; marketplaces added once; installed + enabled; settings.json mirrored to the account; MCP + skills rescanned', async () => {
    const v = await ack({ cmd: 'toolkit_install', keys: ['superpowers', 'ui-ux-pro-max', 'context7', 'vercel', 'graph'] });
    expect(v.rows.every((r) => r.state === 'running')).toBe(true);
    await idle();
    expect(calls()).toEqual([
      'marketplace-add anthropics/claude-plugins-official cfg=unset', `install ${SP} cfg=unset`,
      'marketplace-add nextlevelbuilder/ui-ux-pro-max-skill cfg=unset', `install ${UX} cfg=unset`,
      `install ${C7} cfg=unset`, `install ${VC} cfg=unset`,
    ]);
    expect(engine.toolkit.view().rows.map((r) => [r.key, r.state, r.version])).toEqual([
      ['superpowers', 'installed', '7.0.0'], ['ui-ux-pro-max', 'installed', '2.15.0'], ['context7', 'installed', 'b5b01ac4f889'], ['vercel', 'installed', '0.50.0'],
    ]);
    expect(existsSync(join(tmp, 'wrong'))).toBe(false);
    const acct = engine.accounts.find((a) => a.email === O)!;
    const mirrored = JSON.parse(readFileSync(join(acct.configDir, 'settings.json'), 'utf8')) as { enabledPlugins: Record<string, boolean>; theme: string };
    expect(mirrored.enabledPlugins).toEqual({ [SP]: true, [UX]: true, [C7]: true, [VC]: true });
    expect(mirrored.theme).toBe('dark');
    expect(engine.catalog().some((e) => e.id === `plugin:${C7}:context7`)).toBe(true); // the plugin's MCP server reached the v2.2 catalog
    expect(engine.skillsMcp.skillCatalog()!.skills.some((k) => k.scope === 'plugin' && k.owner === UX && k.name === 'ui-ux-pro-max')).toBe(true); // its skill: rescanned, no watcher wait
    expect(pushed.some((p) => p.busy === 'context7')).toBe(true);
    expect(pushed.at(-1)!.rows.every((r) => r.state === 'installed')).toBe(true);
    expect(remoteSeen).not.toContain('toolkit');
  });

  test('§5.2 pressing again runs nothing (every row installed)', async () => {
    const n = calls().length;
    await ack({ cmd: 'toolkit_install', keys: ['superpowers', 'context7'] });
    await idle();
    expect(calls().length).toBe(n);
  });

  test('§3-5 a new release: toolkit_check refreshes both marketplaces → superpowers (sha), ui-ux-pro-max (version → latest), context7 (content) outdated; vercel not', async () => {
    writeRemote('s2', 'c7 v2', '2.16.0');
    const n = calls().length;
    const v = await ack({ cmd: 'toolkit_check', force: true });
    expect(calls().slice(n)).toEqual(['marketplace-update claude-plugins-official cfg=unset', 'marketplace-update ui-ux-pro-max-skill cfg=unset']);
    expect(v.rows.map((r) => [r.key, r.state, r.latest])).toEqual([
      ['superpowers', 'outdated', undefined], ['ui-ux-pro-max', 'outdated', '2.16.0'], ['context7', 'outdated', undefined], ['vercel', 'installed', undefined],
    ]);
    expect(typeof v.checkedAt).toBe('number');
    expect(engine.setup?.git.state).toBe('ok'); // the check ran setup_check too (R3)
    const m = calls().length;
    await ack({ cmd: 'toolkit_check' }); // < 60 s: reused
    expect(calls().length).toBe(m);
  });

  test('§5.2 toolkit_update superpowers → marketplace update → update -s user → updated with the new version; mirrored', async () => {
    const n = calls().length;
    await ack({ cmd: 'toolkit_update', key: 'superpowers' });
    await idle();
    expect(calls().slice(n)).toEqual(['marketplace-update claude-plugins-official cfg=unset', `update ${SP} cfg=unset`]);
    expect(row('superpowers')).toMatchObject({ state: 'installed', version: '7.0.2', updated: true });
    expect(row('ui-ux-pro-max').state).toBe('outdated');
  });

  test('§5.2 offline check → checkError offline, rows keep their state; a failed update → failed + cause', async () => {
    writeFileSync(plan, JSON.stringify({ 'marketplace-update': ['offline', 'offline'] }));
    const v = await ack({ cmd: 'toolkit_check', force: true });
    expect(v.checkError?.code).toBe('offline');
    expect(row('ui-ux-pro-max').state).toBe('outdated');
    writeFileSync(plan, JSON.stringify({ update: ['fail'] }));
    await ack({ cmd: 'toolkit_update', key: 'ui-ux-pro-max' });
    await idle();
    expect(row('ui-ux-pro-max')).toMatchObject({ state: 'failed', error: { code: 'unknown', line: 'boom' } });
  });

  test('§5.2 TK1-git: git blocked by the Xcode license → install fails with git_license, no `claude plugin` call', async () => {
    rmSync(join(home, '.claude', 'plugins', 'installed_plugins.json'));
    engine.setup = { ...engine.setup!, git: { ...engine.setup!.git, state: 'license' } };
    const n = calls().length;
    await ack({ cmd: 'toolkit_install', keys: ['vercel'] });
    await idle();
    expect(calls().length).toBe(n);
    expect(row('vercel')).toMatchObject({ state: 'failed', error: { code: 'git_license' } });
  });
});
