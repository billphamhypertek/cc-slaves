// v2 §5.2 / §5.4 / §5.5 / §6 A9 IT: a real engine + fake-claude. An account whose `projects/` is a real dir is flagged
// and gets no new lane; "Gộp" over WS fixes it and the lane starts; the unknown-entry card + toggle; the remote channel
// refuses every new command. Temp dirs only (CLAUDE_HOME, accounts root); never the real home or browser.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CardView, Command, ServerMsg } from '../../shared/protocol.ts';
import { insertProject, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { LaneError } from '../src/lane/manager.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { route } from '../src/server/router.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const P = 'ba@x.test';
const TOKEN = 'shared-token';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const opened: string[][] = [];

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let dir: string;
let home: string;

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}
async function cmd(command: Command): Promise<ServerMsg> {
  const ws = new WebSocket(`ws://127.0.0.1:${engine.port}/ws`, { headers: { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${engine.port}` } } as unknown as string[]);
  const msgs: ServerMsg[] = [];
  ws.onmessage = (m) => msgs.push(JSON.parse(String(m.data)) as ServerMsg);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  ws.send(JSON.stringify({ type: 'command', id: 'c1', command }));
  const isReply = (m: ServerMsg) => (m.type === 'ack' || m.type === 'error') && m.id === 'c1';
  await until(() => msgs.some(isReply), `reply to ${command.cmd}`);
  ws.close();
  return msgs.find(isReply)!;
}
const cards = (kind: string): CardView[] => engine.snapshot('mac').cards.filter((c) => c.kind === kind && c.status === 'open');
const view = () => engine.accountViews().find((a) => a.email === P)!;
const startLane = (name: string) => engine.lanes.start({ projectId: 'p1', name, cwd: join(tmp, `wt-${name}`), briefPath: join(tmp, 'brief.md') });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-shared-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  home = join(tmp, 'claude');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'projects'), { recursive: true });
  writeFileSync(join(home, 'projects', 'canary.jsonl'), 'keep');
  writeFileSync(paths().caps, JSON.stringify({ default: { week: 99 }, [P]: { role: 'primary', week: 99 } }));
  writeFileSync(paths().claudeJson, JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://l' } } }));
  writeFileSync(join(tmp, 'brief.md'), 'x');
  for (const n of ['D1', 'D2', 'D3']) mkdirSync(join(tmp, `wt-${n}`));
  const db = openDb(paths().stateDb);
  dir = seedAccounts([P], { db })[0]!.configDir;
  insertProject(db, { id: 'p1', name: 'Shop', path: join(tmp, 'shop') });
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(db, { account: P, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  // Claude Code made a real `projects/` inside the account (the §5.5 A9 case)
  mkdirSync(join(dir, 'projects', '-r-shop'), { recursive: true });
  writeFileSync(join(dir, 'projects', '-r-shop', 's1.jsonl'), 'S1');
  const scn = join(tmp, 'scn.json');
  writeFileSync(scn, JSON.stringify({ steps: [{ waitUser: true }, { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } }, { waitUser: true }] }));
  engine = await Engine.start({
    gh: null, // never the real gh (network)
    version: 'test', port: 0, token: TOKEN, staticDir: null, command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => ({ FAKE_CLAUDE_SCENARIO: scn }),
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
    browserExec: async (c, args) => {
      opened.push([c, ...args]);
      return c === 'defaults'
        ? { code: 0, stdout: '{ LSHandlers = ( { LSHandlerURLScheme = https; LSHandlerRoleAll = "com.google.chrome"; } ); }' }
        : { code: 0, stdout: '' };
    },
  });
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('v2 §5.5 A9 shared config over a real engine', () => {
  test('§5.5 boot check: other links healed; real projects/ → sharedCfg.ok=false, A9 card with the file list, no new lane', async () => {
    expect(readlinkSync(join(dir, 'todos'))).toBe(join(home, 'todos'));
    expect(view().sharedCfg).toEqual({ ok: false, issues: [{ kind: 'real-entry', name: 'projects', path: join(dir, 'projects') }] });
    const [c] = cards('shared_cfg');
    expect(c?.title).toBe('ba@: `projects` chưa nối về `~/.claude`. Tạm ngừng nhận lane.');
    expect(c?.context).toContain('-r-shop/s1.jsonl');
    expect(c?.context).toContain('Không ghi đè.');
    expect(c?.actions?.map((a) => a.label)).toEqual(['Gộp', 'Để sau']);
    const err = await startLane('D1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaneError);
    expect(engine.lanes.get('p1', 'D1')).toBeNull();
  });

  test('§7 N7 remote channel refuses shared_cfg_merge / shared_cfg_toggle / account_open_private and the A9 card action; nothing moves', async () => {
    const h = buildHandlers(engine, { channel: 'remote', watch: null, present: false, send: () => {} });
    const id = cards('shared_cfg')[0]!.id;
    const cmds: Command[] = [
      { cmd: 'shared_cfg_merge', email: P, name: 'projects' }, { cmd: 'shared_cfg_toggle', name: 'hooks', shared: true },
      { cmd: 'account_open_private', url: 'https://claude.ai/x' }, { cmd: 'card_action', id, action: 'shared_cfg_merge' },
    ];
    for (const command of cmds) expect(await route(h, { channel: 'remote' }, { type: 'command', id: 'r', command })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
    expect(lstatSync(join(dir, 'projects')).isDirectory()).toBe(true);
    expect(opened).toEqual([]);
  });

  test('§5.5 dry run over WS returns the plan and moves nothing', async () => {
    const r = await cmd({ cmd: 'shared_cfg_merge', email: P, name: 'projects', dryRun: true });
    expect(r).toMatchObject({ type: 'ack', result: { ok: true, files: ['-r-shop/s1.jsonl'], clashes: [] } });
    expect(readFileSync(join(dir, 'projects', '-r-shop', 's1.jsonl'), 'utf8')).toBe('S1');
  });

  test('G4 UX I2 §6 A9C dry run lists both copies of a clash; clashPath only answers files of the plan', async () => {
    mkdirSync(join(home, 'projects', '-r-shop'), { recursive: true });
    writeFileSync(join(home, 'projects', '-r-shop', 's1.jsonl'), 'theirs');
    try {
      const r = await cmd({ cmd: 'shared_cfg_merge', email: P, name: 'projects', dryRun: true });
      expect(r).toMatchObject({ type: 'ack', result: { ok: false, reason: 'clash', clashes: ['-r-shop/s1.jsonl'], copies: [{
        file: '-r-shop/s1.jsonl', account: { dir: join(dir, 'projects'), path: join(dir, 'projects', '-r-shop', 's1.jsonl') }, shared: { dir: join(home, 'projects') },
      }] } });
      const c = (r as { result: { copies: { account: { mtime: number | null } }[] } }).result.copies[0]!;
      expect(typeof c.account.mtime).toBe('number');
      expect(engine.clashPath(P, 'projects', '-r-shop/s1.jsonl')).toBe(join(dir, 'projects', '-r-shop', 's1.jsonl'));
      expect(engine.clashPath(P, 'projects', '../../../etc/passwd')).toBeNull();
      expect(engine.clashPath(P, 'projects', 'canary.jsonl')).toBeNull(); // in ~/.claude, not a clash
      expect(engine.clashPath('nobody@x', 'projects', '-r-shop/s1.jsonl')).toBeNull();
      // I3: the dry run refreshed the open A9 card: clash body, primary "Xem trùng tên"
      const c9 = cards('shared_cfg')[0]!;
      expect(c9.context).toContain('Trùng tên, không gộp được:');
      expect(c9.actions?.map((x) => x.label)).toEqual(['Xem trùng tên', 'Để sau']);
    } finally { rmSync(join(home, 'projects', '-r-shop'), { recursive: true, force: true }); }
    await cmd({ cmd: 'shared_cfg_merge', email: P, name: 'projects', dryRun: true });
    expect(cards('shared_cfg')[0]!.actions?.map((x) => x.label)).toEqual(['Gộp', 'Để sau']); // clash gone → Gộp again
    expect(cards('shared_cfg')[0]!.context).toContain('-r-shop/s1.jsonl');
  });

  test('§5.5 A9 "Gộp" card action merges (bak kept, link made), the account is ok again and a lane starts on it', async () => {
    const id = cards('shared_cfg')[0]!.id;
    const r = await cmd({ cmd: 'card_action', id, action: 'shared_cfg_merge' });
    expect(r.type).toBe('ack');
    expect(readlinkSync(join(dir, 'projects'))).toBe(join(home, 'projects'));
    expect(readFileSync(join(home, 'projects', '-r-shop', 's1.jsonl'), 'utf8')).toBe('S1');
    expect(readFileSync(join(home, 'projects', 'canary.jsonl'), 'utf8')).toBe('keep');
    expect(readdirSync(dir).filter((n) => n.startsWith('projects.cc-slaves-bak-'))).toHaveLength(1);
    expect(view().sharedCfg).toEqual({ ok: true, issues: [] });
    expect(cards('shared_cfg')).toEqual([]);
    await startLane('D2');
    await until(() => ['running', 'idle'].includes(engine.lanes.get('p1', 'D2')?.state ?? ''), 'D2 up');
    expect(engine.lanes.get('p1', 'D2')?.account).toBe(P);
  });

  test('§5.2 a new unknown entry in ~/.claude → card; toggle on links it in every account, off unlinks only (target kept); config.json persists', async () => {
    mkdirSync(join(home, 'hooks'));
    writeFileSync(join(home, 'hooks', 'pre.sh'), 'echo');
    await until(() => cards('shared_cfg_new').length === 1, 'new-entry card');
    expect(cards('shared_cfg_new')[0]!.title).toBe('Claude Code vừa tạo `hooks/` — dùng chung cho mọi account?');
    expect(await cmd({ cmd: 'shared_cfg_toggle', name: 'hooks', shared: true })).toMatchObject({ type: 'ack', result: { sharedExtra: ['hooks'] } });
    expect(readlinkSync(join(dir, 'hooks'))).toBe(join(home, 'hooks'));
    expect(JSON.parse(readFileSync(paths().config, 'utf8')).sharedExtra).toEqual(['hooks']);
    expect(cards('shared_cfg_new')).toEqual([]);
    expect(await cmd({ cmd: 'shared_cfg_toggle', name: 'hooks', shared: false })).toMatchObject({ type: 'ack', result: { sharedExtra: [] } });
    expect(existsSync(join(dir, 'hooks'))).toBe(false);
    expect(readFileSync(join(home, 'hooks', 'pre.sh'), 'utf8')).toBe('echo');
    expect(JSON.parse(readFileSync(paths().config, 'utf8')).sharedExtra).toEqual([]);
    expect(await cmd({ cmd: 'shared_cfg_toggle', name: 'projects', shared: false })).toMatchObject({ type: 'error', code: 'bad_input' });
  });

  test('§5.5 check before spawn: a link removed inside the account is back before the next lane starts on it', async () => {
    rmSync(join(dir, 'plans')); // the link only; nothing else (watch / timer) looks inside account dirs
    expect(existsSync(join(dir, 'plans'))).toBe(false);
    await startLane('D3');
    await until(() => ['running', 'idle'].includes(engine.lanes.get('p1', 'D3')?.state ?? ''), 'D3 up');
    expect(readlinkSync(join(dir, 'plans'))).toBe(join(home, 'plans'));
  });

  test('IMPORTANT-4 §5.5 §5.2 the pick sees the pre-spawn check: a real projects/ made after boot → no lane on that account + A9 card', async () => {
    mkdirSync(join(tmp, 'wt-D4'));
    rmSync(join(dir, 'projects')); // the link; Claude Code made a real dir since the last check
    mkdirSync(join(dir, 'projects', '-r-new'), { recursive: true });
    writeFileSync(join(dir, 'projects', '-r-new', 's9.jsonl'), 'S9');
    const err = await startLane('D4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaneError);
    expect((err as LaneError).code).toBe('no_account');
    expect(engine.lanes.get('p1', 'D4')).toBeNull();
    expect(view().sharedCfg.ok).toBe(false);
    expect(cards('shared_cfg').map((c) => c.title)).toEqual(['ba@: `projects` chưa nối về `~/.claude`. Tạm ngừng nhận lane.']);
    expect(lstatSync(join(dir, 'projects')).isDirectory()).toBe(true); // nothing merged behind the PO's back
  });

  test('SA6 account_open_private: ack {ok}; a non-http url → {ok:false} and nothing opens', async () => {
    expect(await cmd({ cmd: 'account_open_private', url: 'https://claude.ai/oauth?x=1' })).toMatchObject({ type: 'ack', result: { ok: true } });
    expect(opened.at(-1)).toEqual(['open', '-na', 'Google Chrome', '--args', '--incognito', 'https://claude.ai/oauth?x=1']);
    const n = opened.length;
    expect(await cmd({ cmd: 'account_open_private', url: 'file:///etc/passwd' })).toMatchObject({ type: 'ack', result: { ok: false } });
    expect(opened.length).toBe(n);
  });
});
