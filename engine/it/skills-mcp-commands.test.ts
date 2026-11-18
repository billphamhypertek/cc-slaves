// v2.2 §5.4 / §5.5 / §6 the Skills & MCP commands + pushed view against a real engine: fake-claude for sessions and
// `claude mcp`, temp HOME / CLAUDE_HOME / CLAUDE_JSON. Never the real ~/.claude, ~/.claude.json or any API.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, ServerMsg, SkillDirCheck, SkillGitFetch, SkillsMcpView } from '../../shared/protocol.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { TOOLS } from '../src/mcp/tools.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { route } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';
import { fakeAuthServer, type FakeAs } from '../../fake-mcp/src/oauth-as.ts';
import { startFakeMcp, type FakeMcp } from '../../fake-mcp/src/server.ts';
import { MCP_KEYCHAIN_SERVICE, securityCli } from '../src/keychain.ts';
import type { SystemPayload } from '../src/cards/store.ts';
import { makeFakeSecurity, type FakeSecurity } from '../test/_fixtures/fake-security.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
let tmp: string;
let home: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let plan: string;
let projectId: string;
let projectDir: string;
const pushed: SkillsMcpView[] = [];
let fmcp: FakeMcp;
let fas: FakeAs;
let sec: FakeSecurity;
const opened: string[] = [];

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(20); }
}
const conn = (channel: 'mac' | 'remote'): Conn => ({ channel, watch: null, present: true, send: () => {} });
async function cmd(command: Command, channel: 'mac' | 'remote' = 'mac'): Promise<ServerMsg> {
  return route(buildHandlers(engine, conn(channel)), { channel }, { type: 'command', id: 'x', command });
}
const ack = async (command: Command): Promise<SkillsMcpView> => {
  const r = await cmd(command);
  if (r.type !== 'ack') throw new Error(`${command.cmd}: ${JSON.stringify(r)}`);
  return r.result as SkillsMcpView;
};
const servers = () => (JSON.parse(readFileSync(paths().claudeJson, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers;
const cfgFile = () => JSON.parse(readFileSync(paths().config, 'utf8')) as { mcp?: { offForLanes: string[]; projectOn: string[]; noLogin: string[] }; skills?: { offForLanes: string[]; acked: Record<string, string> }; plugins?: { offForLanes: string[] } };
const mkSkill = (dir: string, name = dir.split('/').pop()!) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: does ${name}\n---\n`);
  return dir;
};

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-skills-mcp-')));
  home = join(tmp, 'user');
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(home, '.claude');
  process.env.CLAUDE_JSON = join(home, '.claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  writeFileSync(join(tmp, 'home', 'engine-settings.json'), '{}'); // §5.5 stale v2.1 file: deleted at boot
  writeFileSync(paths().claudeJson, JSON.stringify({ mcpServers: { a: { command: 'a-bin' }, b: { type: 'http', url: 'https://b.example/mcp' } } }));
  writeFileSync(paths().caps, JSON.stringify({ default: { week: 99 }, [O]: { role: 'orchestrator', week: 99 } }));
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  db.close();
  const claude = join(tmp, 'claude-bin');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(claude, 0o755);
  plan = join(tmp, 'plan.json');
  fmcp = startFakeMcp({ routes: (req, url, body) => fas.routes(req, url, body) });
  fas = fakeAuthServer(() => fmcp);
  sec = makeFakeSecurity(tmp);
  const scn = join(tmp, 'scn.json');
  writeFileSync(scn, JSON.stringify({ steps: [{ waitUser: true }] }));
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: null, command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: home, FAKE_CLAUDE_MCP_PLAN: plan }, claudePath: claude, shellFailed: false, reason: null },
    extraEnv: () => ({ FAKE_CLAUDE_SCENARIO: scn }),
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true, securityRun: () => ({ code: 0, stderr: '' }), authCheckTimeoutMs: 30_000,
    mcpKeychain: securityCli(sec.bin), openUrl: (u) => opened.push(u),
  });
  engine.hub.open({ channel: 'mac', watch: null, present: true, send: (m) => { if (m.type === 'event' && m.event.type === 'skills_mcp') pushed.push(m.event.view); } });
  projectDir = join(tmp, 'shop');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { pg: { command: 'pg' } } }));
  const r = await cmd({ cmd: 'project_add', name: 'Shop', path: projectDir, orchestratorAccount: O });
  projectId = ((r as { result: { id: string } }).result).id;
});

afterAll(async () => {
  await engine?.stop();
  fmcp?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§6 view + §2 D32 channel', () => {
  test('§5.5 the stale ~/.cc-slaves/engine-settings.json is deleted at boot', () => {
    expect(existsSync(join(tmp, 'home', 'engine-settings.json'))).toBe(false);
  });

  test('§6 the Mac snapshot carries the view (K7 pending yellow; §5.4b boot checks: `a-bin` missing, b unreachable → red); the remote one does not', async () => {
    await engine.skillsMcp.probes.idle();
    const v = engine.snapshot('mac').skillsMcp!;
    expect(v.mcp.rows.map((r) => r.id).sort()).toEqual(['cc_slaves', `project:${projectId}:pg`, 'user:a', 'user:b']);
    expect(v.mcp.rows[0]).toMatchObject({ id: 'cc_slaves', builtin: true, tools: TOOLS.filter((t) => t.roles.includes('lane')).length }); // §6 F-I1 its real lane tool count
    expect(v.mcp.rows.map((r) => [r.id, r.probe?.error?.code ?? null])).toEqual([['cc_slaves', null], ['user:a', 'spawn'], ['user:b', 'network'], [`project:${projectId}:pg`, null]]);
    expect(v.counts.mcp).toEqual({ red: 2, yellow: 1 });
    expect(v.claude.found).toBe(true);
    expect(engine.snapshot('remote').skillsMcp).toBeUndefined();
  });

  test('§2 N6 C24 card_action mcp_login / mcp_snooze on the remote channel → forbidden_remote; card stays open', async () => {
    const card = engine.cards.createSystem({ kind: 'mcp_login', key: 'user:b', projectId: null, titleKey: 'cards.mcpReloginIdle', params: { name: 'b' },
      actions: [{ action: 'mcp_login', label: 'Đăng nhập', args: { id: 'user:b' } }, { action: 'mcp_snooze', label: 'Để sau', args: { id: 'user:b' } }] });
    for (const action of ['mcp_login', 'mcp_snooze']) {
      expect(await cmd({ cmd: 'card_action', id: card.id, action }, 'remote')).toMatchObject({ type: 'error', code: 'forbidden_remote' });
    }
    expect(engine.cards.get(card.id)!.status).toBe('open');
    engine.cards.resolveSystem(card.id);
    expect(await cmd({ cmd: 'mcp_add', name: 'z', config: { command: 'z' } }, 'remote')).toMatchObject({ code: 'forbidden_remote' });
    expect(servers().z).toBeUndefined();
  });
});

describe('§5.4 MCP commands', () => {
  test('§5.4 mcp_add → entry in ~/.claude.json, view pushed + acked; stale rev → source_changed', async () => {
    const n = pushed.length;
    const v = await ack({ cmd: 'mcp_add', name: 'c', config: { command: 'c-bin' }, rev: engine.skillsMcp.rev() });
    expect(servers().c).toEqual({ command: 'c-bin' });
    expect(v.mcp.rows.some((r) => r.id === 'user:c' && r.editable)).toBe(true);
    await until(() => pushed.length > n, 'skills_mcp push');
    expect(await cmd({ cmd: 'mcp_remove', name: 'c', rev: 'old' })).toMatchObject({ type: 'error', code: 'source_changed', key: 'skillsMcp.err.sourceChanged' });
    expect(await cmd({ cmd: 'mcp_add', name: 'a', config: { command: 'x' } })).toMatchObject({ code: 'name_taken', key: 'skillsMcp.err.nameTaken', params: { name: 'a' } });
  });

  test('§8 K4e-restore over WS: second add-json exit 1 → restored, old entry back', async () => {
    writeFileSync(plan, JSON.stringify({ 'add-json': ['fail'] }));
    expect(await cmd({ cmd: 'mcp_edit', name: 'a', config: { command: 'new' } })).toMatchObject({ type: 'error', code: 'restored', key: 'skillsMcp.err.restored' });
    expect(servers().a).toEqual({ command: 'a-bin' });
  });

  test('§6 K14 a failed own write pushes the view with the post-write rev BEFORE the error reply (K5 adopts it, no "vừa đổi")', async () => {
    writeFileSync(plan, JSON.stringify({ 'add-json': ['fail'] }));
    const n = pushed.length;
    expect(await cmd({ cmd: 'mcp_edit', name: 'a', config: { command: 'new' }, rev: engine.skillsMcp.rev() })).toMatchObject({ code: 'restored' });
    expect(pushed.length).toBeGreaterThan(n);
    expect(pushed.at(-1)!.claudeJson.rev).toBe(engine.skillsMcp.rev());
  });

  test('§8 restore fails too → lost, the view carries "Chép JSON cũ"; gone once the entry is back', async () => {
    writeFileSync(plan, JSON.stringify({ 'add-json': ['fail', 'fail'] }));
    expect(await cmd({ cmd: 'mcp_edit', name: 'a', config: { command: 'new' } })).toMatchObject({ code: 'lost', params: { name: 'a' } });
    const lost = engine.skillsMcp.view().lost;
    expect(lost).toHaveLength(1);
    expect(lost[0]!.command).toContain(`claude mcp add-json -s user 'a'`);
    await ack({ cmd: 'mcp_add', name: 'a', config: { command: 'a-bin' } });
    expect(engine.skillsMcp.view().lost).toEqual([]);
  });

  test('§5.4 mcp_toggle → config.json mcp.offForLanes; the catalog (lane set) follows; unknown id refused', async () => {
    const v = await ack({ cmd: 'mcp_toggle', id: 'user:b', on: false });
    expect(cfgFile().mcp!.offForLanes).toEqual(['user:b']);
    expect(v.mcp.rows.find((r) => r.id === 'user:b')!.forLanes).toBe(false);
    expect(engine.catalog().find((e) => e.id === 'user:b')!.forLanes).toBe(false);
    await ack({ cmd: 'mcp_toggle', id: 'user:b', on: true });
    expect(cfgFile().mcp!.offForLanes).toEqual([]);
    expect(await cmd({ cmd: 'mcp_toggle', id: 'user:nope', on: false })).toMatchObject({ code: 'no_item' });
    expect(await cmd({ cmd: 'mcp_toggle', id: 'cc_slaves', on: false })).toMatchObject({ code: 'read_only' }); // §6 F-I1 own row: always on
  });

  test('§5.4 K7 mcp_project_enable → projectOn; "Để tắt" (off) → offForLanes, no longer pending', async () => {
    const id = `project:${projectId}:pg`;
    const on = await ack({ cmd: 'mcp_project_enable', id, on: true });
    expect(on.mcp.rows.find((r) => r.id === id)).toMatchObject({ forLanes: true, pending: false });
    const off = await ack({ cmd: 'mcp_project_enable', id, on: false });
    expect(off.mcp.rows.find((r) => r.id === id)).toMatchObject({ forLanes: false, pending: false });
    expect(cfgFile().mcp).toEqual({ offForLanes: [id], projectOn: [], noLogin: [] });
    expect(off.counts.mcp.yellow).toBe(0);
  });


  test('§6 K4 "Đăng nhập: Không" → config.json mcp.noLogin; no login on that row; edit keeps / clears it, rename moves it, remove drops it', async () => {
    writeFileSync(plan, '{}');
    const url = 'https://nl.example/mcp';
    const v = await ack({ cmd: 'mcp_add', name: 'nl', config: { type: 'http', url }, noLogin: true });
    expect(cfgFile().mcp!.noLogin).toEqual(['user:nl']);
    expect(v.mcp.rows.find((r) => r.id === 'user:nl')).toMatchObject({ noLogin: true });
    expect(v.mcp.rows.find((r) => r.id === 'user:nl')).not.toHaveProperty('oauth');
    expect(await cmd({ cmd: 'mcp_login', id: 'user:nl' })).toMatchObject({ code: 'not_remote' });
    await ack({ cmd: 'mcp_edit', name: 'nl', to: 'nl2', config: { type: 'http', url }, noLogin: true });
    expect(cfgFile().mcp!.noLogin).toEqual(['user:nl2']);
    const auto = await ack({ cmd: 'mcp_edit', name: 'nl2', config: { type: 'http', url } });
    expect(cfgFile().mcp!.noLogin).toEqual([]);
    expect(auto.mcp.rows.find((r) => r.id === 'user:nl2')!.oauth).toBeDefined();
    await ack({ cmd: 'mcp_edit', name: 'nl2', config: { type: 'http', url }, noLogin: true });
    await ack({ cmd: 'mcp_remove', name: 'nl2' });
    expect(cfgFile().mcp!.noLogin).toEqual([]);
  });

  test('§6 K4 "Client ID": oauth.clientId in the entry, the secret through add-json --client-secret (env), never in config files', async () => {
    writeFileSync(plan, '{}');
    await ack({ cmd: 'mcp_add', name: 'cid', config: { type: 'http', url: 'https://cid.example/mcp', oauth: { clientId: 'c-1' } }, clientSecret: 'shh' });
    expect(servers().cid).toEqual({ type: 'http', url: 'https://cid.example/mcp', oauth: { clientId: 'c-1' } });
    expect(readFileSync(paths().claudeJson, 'utf8')).not.toContain('shh');
    expect(readFileSync(paths().config, 'utf8')).not.toContain('shh');
    await ack({ cmd: 'mcp_remove', name: 'cid' });
  });

  test('§6 K4 check "npx có trên PATH (…)": mcp_which looks the command up on the login PATH', async () => {
    const sh = await cmd({ cmd: 'mcp_which', command: 'sh' });
    expect(sh).toMatchObject({ type: 'ack' });
    expect((sh as { result: { path: string | null } }).result.path).toMatch(/\/sh$/);
    expect(await cmd({ cmd: 'mcp_which', command: 'no-such-bin-ccs' })).toMatchObject({ type: 'ack', result: { path: null } });
  });
});

describe('§5.3 OAuth commands (engine + fake AS + fake security)', () => {
  const stored = (id: string) => sec.items()[`${MCP_KEYCHAIN_SERVICE}/${id}`];
  const row = (v: SkillsMcpView, id: string) => v.mcp.rows.find((r) => r.id === id);
  /** The "browser": the authorize redirect lands on the engine's own /oauth/mcp/callback. */
  const browse = async () => fetch((await fetch(opened.at(-1)!, { redirect: 'manual' })).headers.get('location')!);
  const login = async (id: string) => {
    const n = opened.length;
    await ack({ cmd: 'mcp_login', id });
    await until(() => opened.length > n, 'browser opened');
    expect(new URL(opened.at(-1)!).searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${engine.port}/oauth/mcp/callback`);
    const page = await browse();
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
  };

  test('§5.3 a stdio entry has no login → not_remote', async () => {
    writeFileSync(plan, '{}');
    for (const c of ['mcp_login', 'mcp_logout', 'mcp_login_cancel', 'mcp_keychain_retry'] as const) {
      expect(await cmd({ cmd: c, id: 'user:a' })).toMatchObject({ code: 'not_remote', key: 'skillsMcp.err.notRemote' });
    }
  });

  test('§5.3 login through the engine port → row logged in; rename moves the Keychain item; URL change revokes + drops it', async () => {
    await ack({ cmd: 'mcp_add', name: 'fm', config: { type: 'http', url: `${fmcp.origin}/v3/mcp` } });
    await login('user:fm');
    expect(row(engine.skillsMcp.view(), 'user:fm')!.oauth).toMatchObject({ loggedIn: true, needsLogin: null, login: null });
    expect(servers().fm).toEqual({ type: 'http', url: `${fmcp.origin}/v3/mcp` }); // C18: nothing written to ~/.claude.json
    const rec = stored('user:fm')!;
    await ack({ cmd: 'mcp_edit', name: 'fm', to: 'fm2', config: { type: 'http', url: `${fmcp.origin}/v3/mcp` } });
    expect(stored('user:fm')).toBeUndefined();
    expect(stored('user:fm2')).toBe(rec);
    expect(row(engine.skillsMcp.view(), 'user:fm2')!.oauth!.loggedIn).toBe(true);
    const rt = (JSON.parse(rec) as { refreshToken: string }).refreshToken;
    await ack({ cmd: 'mcp_edit', name: 'fm2', config: { type: 'http', url: `${fmcp.origin}/v2/mcp` } });
    expect(fas.revoked).toContain(rt);
    expect(stored('user:fm2')).toBeUndefined();
    expect(row(engine.skillsMcp.view(), 'user:fm2')!.oauth!.loggedIn).toBe(false);
  });

  test('§5.4b C22 a login (and a logout) re-checks that server: autoProbe([id])', async () => {
    await ack({ cmd: 'mcp_add', name: 'fp', config: { type: 'http', url: `${fmcp.origin}/v3/mcp` } });
    const asked: (readonly string[] | undefined)[] = [];
    const real = engine.skillsMcp.autoProbe.bind(engine.skillsMcp);
    engine.skillsMcp.autoProbe = (ids) => { asked.push(ids); real(ids); };
    try {
      await login('user:fp');
      expect(asked).toEqual([['user:fp']]);
      await ack({ cmd: 'mcp_logout', id: 'user:fp' });
      expect(asked).toEqual([['user:fp'], ['user:fp']]);
    } finally { engine.skillsMcp.autoProbe = real; }
    await ack({ cmd: 'mcp_remove', name: 'fp' });
  });

  test('§5.3 logout and remove → revoke, then the Keychain item is gone', async () => {
    await login('user:fm2');
    let rt = (JSON.parse(stored('user:fm2')!) as { refreshToken: string }).refreshToken;
    await ack({ cmd: 'mcp_logout', id: 'user:fm2' });
    expect(fas.revoked).toContain(rt);
    expect(stored('user:fm2')).toBeUndefined();
    await login('user:fm2');
    rt = (JSON.parse(stored('user:fm2')!) as { refreshToken: string }).refreshToken;
    await ack({ cmd: 'mcp_remove', name: 'fm2' });
    expect(fas.revoked).toContain(rt);
    expect(stored('user:fm2')).toBeUndefined();
  });

  test('§6 K13 invalid_grant → card (projectId null); card_action mcp_login starts K3 (card stays open), the login closes it; Để sau resolves', async () => {
    await ack({ cmd: 'mcp_add', name: 'fm3', config: { type: 'http', url: `${fmcp.origin}/v3/mcp` } });
    await login('user:fm3');
    fas.knobs.refreshFail = 'invalid_grant';
    expect(await engine.skillsMcp.oauth.refresh('user:fm3')).toBe('invalid_grant');
    const card = engine.cards.findOpenSystem('mcp_login', 'user:fm3', null)!;
    expect((card.payload as SystemPayload).title).toBe('MCP fm3 cần đăng nhập lại');
    expect(row(engine.skillsMcp.view(), 'user:fm3')!.status).toBe('needs_relogin');
    const n = opened.length;
    await cmd({ cmd: 'card_action', id: card.id, action: 'mcp_login' });
    await until(() => opened.length > n, 'K3 from the card');
    expect(engine.cards.get(card.id)!.status).toBe('open');
    expect((await browse()).status).toBe(200);
    expect(engine.cards.get(card.id)!.status).not.toBe('open');
    fas.knobs.refreshFail = 'invalid_grant';
    await engine.skillsMcp.oauth.refresh('user:fm3');
    const again = engine.cards.findOpenSystem('mcp_login', 'user:fm3', null)!;
    await cmd({ cmd: 'card_action', id: again.id, action: 'mcp_snooze' });
    expect(engine.cards.get(again.id)!.status).not.toBe('open');
    expect(engine.cards.findOpenSystem('mcp_login', 'user:fm3', null)).toBeNull();
  });
});

describe('§5.5 skills commands', () => {
  test('§5.5 the watcher is re-made on project_add: a new project skill shows up in a pushed view', async () => {
    mkSkill(join(projectDir, '.claude', 'skills', 'shop-deploy'));
    await until(() => pushed.at(-1)?.skills.rows.some((r) => r.id === `project:${projectId}:shop-deploy`) === true, 'project skill pushed');
  });

  test('§5.5 hot fix 2026-11-17 the rescan after the reply: project_close drops the project skill, the reopen brings it back', async () => {
    const row = () => pushed.at(-1)?.skills.rows.some((r) => r.id === `project:${projectId}:shop-deploy`) === true;
    await until(row, 'project skill pushed');
    await cmd({ cmd: 'project_close', id: projectId });
    await until(() => !row(), 'project skill gone after close');
    expect(((await cmd({ cmd: 'project_add', name: 'Shop', path: projectDir })) as { result: { id: string } }).result.id).toBe(projectId);
    await until(row, 'project skill back after the reopen');
  });

  test('§5.5 skill_add_folder (link) → row; skill_toggle → skills.offForLanes; skill_remove unlinks, target kept', async () => {
    const src = mkSkill(join(tmp, 'src', 'h-ops'));
    const v = await ack({ cmd: 'skill_add_folder', path: src, mode: 'link' });
    expect(v.skills.rows.find((r) => r.id === 'user:h-ops')).toMatchObject({ link: src, forLanes: true });
    await ack({ cmd: 'skill_toggle', id: 'user:h-ops', on: false });
    expect(cfgFile().skills!.offForLanes).toEqual(['user:h-ops']);
    expect(await cmd({ cmd: 'skill_add_folder', path: src, mode: 'link' })).toMatchObject({ code: 'exists', key: 'skillsMcp.err.skill.exists' });
    const after = await ack({ cmd: 'skill_remove', id: 'user:h-ops' });
    expect(after.skills.rows.some((r) => r.id === 'user:h-ops')).toBe(false);
    expect(existsSync(join(src, 'SKILL.md'))).toBe(true);
  });

  test('§5.5 K9-folder skill_check_folder: the dry-run checks of a picked folder, nothing written; a missing folder is refused', async () => {
    const src = mkSkill(join(tmp, 'src', 'h-ops-skill'), 'h-ops');
    symlinkSync(src, join(home, '.claude', 'skills', 'h-ops'));
    const r = await cmd({ cmd: 'skill_check_folder', path: src });
    expect((r as { result: SkillDirCheck }).result).toEqual({ dir: 'h-ops', name: 'h-ops', description: 'does h-ops', skillMd: true, badChars: false, exists: { link: src, same: true } });
    expect(readdirSync(join(home, '.claude', 'skills'))).toEqual(['h-ops']);
    expect(await cmd({ cmd: 'skill_check_folder', path: join(tmp, 'nope') })).toMatchObject({ code: 'noFolder', key: 'skillsMcp.err.skill.noFolder' });
  });

  test('§5.5 C23 skill_ack stores the fingerprint, K0 yellow drops; the target changes → the issue is back', async () => {
    const t1 = mkSkill(join(tmp, 'src', 'named'), 'other-name');
    symlinkSync(t1, join(home, '.claude', 'skills', 'named'));
    engine.skillsMcp.rescan();
    const before = engine.skillsMcp.view();
    const issue = before.skills.issues.find((i) => i.code === 'nameMismatch')!;
    const after = await ack({ cmd: 'skill_ack', issueId: issue.id, on: true });
    expect(Object.keys(cfgFile().skills!.acked)).toEqual([issue.id]);
    expect(after.counts.skills.yellow).toBe(before.counts.skills.yellow - 1);
    rmSync(join(home, '.claude', 'skills', 'named'));
    symlinkSync(mkSkill(join(tmp, 'src2', 'named'), 'other-name'), join(home, '.claude', 'skills', 'named'));
    engine.skillsMcp.rescan();
    expect(engine.skillsMcp.view().skills.issues.find((i) => i.id === issue.id)!.acked).toBe(false);
  });

  test('§5.5 C23 a lane-breaking issue (broken link) cannot be acked; skill_fix unlink removes it', async () => {
    symlinkSync(join(tmp, 'gone'), join(home, '.claude', 'skills', 'dead'));
    engine.skillsMcp.rescan();
    const issue = engine.skillsMcp.view().skills.issues.find((i) => i.code === 'brokenLink')!;
    expect(await cmd({ cmd: 'skill_ack', issueId: issue.id, on: true })).toMatchObject({ code: 'not_ackable' });
    const v = await ack({ cmd: 'skill_fix', issueId: issue.id, fix: 'unlink' });
    expect(v.skills.issues.some((i) => i.code === 'brokenLink')).toBe(false);
  });

  test('§5.5 skill_git_fetch / skill_git_add from a local repo (file://); unknown clone refused', async () => {
    const repo = join(tmp, 'repo');
    mkSkill(join(repo, 'skills', 'g1'));
    mkSkill(join(repo, 'skills', 'g2'));
    const git = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
    const r = await cmd({ cmd: 'skill_git_fetch', url: `file://${repo}` });
    const f = (r as { result: SkillGitFetch }).result;
    expect(f.candidates.map((c) => c.name)).toEqual(['g1', 'g2']);
    expect(f.candidates[0]!.check).toEqual({ dir: 'g1', name: 'g1', description: 'does g1', skillMd: true, badChars: false, exists: null }); // §6 K9-git description
    const v = await ack({ cmd: 'skill_git_add', cloneId: f.cloneId, names: ['g2'] });
    expect(v.skills.rows.some((x) => x.id === 'user:g2')).toBe(true);
    expect(await cmd({ cmd: 'skill_git_add', cloneId: f.cloneId, names: ['g1'] })).toMatchObject({ code: 'no_item' });
  });

  test('§5.5 plugin_toggle of an unknown plugin refused (no config write)', async () => {
    expect(await cmd({ cmd: 'plugin_toggle', key: 'nope@m', on: false })).toMatchObject({ code: 'no_item' });
    expect(cfgFile().plugins?.offForLanes ?? []).toEqual([]);
  });
});
