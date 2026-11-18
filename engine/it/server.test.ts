// Engine + Mac web server end to end (spec §7.1, §7.2, §7.9, M16): temp homes, fake keychain/exec, fake-claude,
// random port. Never touches the real ~/.cc-slaves, the Keychain or any API.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, LaneView, ServerMsg, Snapshot, StreamLine } from '../../shared/protocol.ts';
import { getMeta, insertEvent, upsertQuota, openDb } from '../src/db.ts';
import { CAPS_IMPORTED_KEY, deleteAccount, upsertAccount } from '../src/accounts/registry.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';
import { rejects } from '../test/_fixtures/rejects.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const PERM = JSON.parse(readFileSync(resolve(import.meta.dir, '../../fake-claude/scenarios/permission-request.json'), 'utf8')) as { steps: object[] };
const O = 'o@x.test';
const logins = new Set<string>([O]);
const TOKEN = 'test-token-123';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;

type Step = Record<string, unknown>;
const assistant = (text: string): Step => ({ emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] } } });
/** v2.2 §3-15 a reply still streaming: real-shape stream_events of one open text block (fake-claude `stream`, open). */
const partial = (text: string): Step => ({ stream: { blocks: [{ text }], open: true } });
const result = (text: string): Step => ({ emit: { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } });
const turn = (i: number): Step[] => [{ waitUser: true }, partial(`đang gõ ${i}`), assistant(`Trả lời ${i}`), result(`Xong ${i}`)];

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let scenario: object = { steps: [] };
let stdinLog: string;
/** v2.4 §5.2 the orchestrator also writes control requests (handshake, re-read after a turn): the last user line's text. */
const lastUserLine = (): string => readFileSync(stdinLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: unknown } })
  .filter((l) => l.type === 'user').map((l) => (typeof l.message?.content === 'string' ? l.message.content : '')).at(-1) ?? '';
let osa: string[];
let projectDir: string;
let projectId: string;
let oDir: string;

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}

interface Client { msgs: ServerMsg[]; cmd(c: Command): Promise<ServerMsg>; close(): void; events(type: string): unknown[] }
let n = 0;
async function connect(o: { token?: string; origin?: string } = {}): Promise<Client> {
  const port = engine.port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { authorization: `Bearer ${o.token ?? TOKEN}`, origin: o.origin ?? `http://127.0.0.1:${port}` },
  } as unknown as string[]);
  const msgs: ServerMsg[] = [];
  ws.onmessage = (m) => msgs.push(JSON.parse(String(m.data)) as ServerMsg);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  await until(() => msgs.some((m) => m.type === 'snapshot'), 'snapshot');
  return {
    msgs,
    async cmd(command) {
      const id = `c${++n}`;
      ws.send(JSON.stringify({ type: 'command', id, command }));
      const isReply = (m: ServerMsg) => (m.type === 'ack' || m.type === 'error') && m.id === id;
      await until(() => msgs.some(isReply), `reply to ${command.cmd}`);
      return msgs.find(isReply)!;
    },
    close: () => ws.close(),
    events: (type) => msgs.filter((m) => m.type === 'event' && m.event.type === type).map((m) => (m as { event: unknown }).event),
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-server-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  projectDir = join(tmp, 'shop');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  mkdirSync(join(tmp, 'web', 'assets'), { recursive: true });
  writeFileSync(join(tmp, 'web', 'index.html'), '<!doctype html><title>cc-slaves</title>');
  writeFileSync(join(tmp, 'web', 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(tmp, 'secret.txt'), 'nope');
  stdinLog = join(tmp, 'stdin.log');
  // fresh quota so the orchestrator account is usable (no network in tests)
  // §7.1-2: a v1 config.json still holding laneCaps (same value as the default 3: no behaviour change for other tests)
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude'), { recursive: true }); // v2.7 §7.3 lane_start needs superpowers on for lanes
  writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-marketplace': true } }));
  writeFileSync(paths().config, JSON.stringify({ laneCaps: { [O]: 3 }, sound: true }));
  const db = openDb(paths().stateDb);
  oDir = seedAccounts([O], { db })[0]!.configDir; // v2 §7: the registry, not CC Switch
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(db, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  osa = [];
  let spawn = 0;
  engine = await Engine.start({
    gh: null, // never the real gh (network)
    version: 'test', port: 0, token: TOKEN, staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => {
      const f = join(tmp, `scn-${++spawn}.json`);
      writeFileSync(f, JSON.stringify(scenario));
      return { FAKE_CLAUDE_SCENARIO: f, FAKE_CLAUDE_STDIN_LOG: stdinLog };
    },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: (t, b) => osa.push(`${t}|${b}`), postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {},
    hasLogin: (a) => logins.has(a.email),
  });
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('§7.1 v2 account registry at boot', () => {
  test('§7.1 first boot runs the caps.json import once (marker set, no hard-coded emails imported)', () => {
    expect(getMeta(engine.db, CAPS_IMPORTED_KEY)).not.toBeNull();
    // only the account the test seeded (with `dir`); no hard-coded email came in with the import
    expect(engine.db.query('SELECT email FROM account').all()).toEqual([{ email: O }]);
  });
  test('§7.1-3 a row that gets `dir` becomes usable on the next registry read and wakes waiting lanes (accountChanged)', () => {
    const N = 'n@x.test';
    const calls: string[] = [];
    const orig = engine.lanes.accountChanged.bind(engine.lanes);
    engine.lanes.accountChanged = (e: string) => { calls.push(e); orig(e); };
    try {
      upsertAccount(engine.db, { email: N, role: 'backup' }); // v1-imported, no dir: not usable
      logins.add(N);
      engine.refreshAccounts();
      expect(engine.accounts.map((x) => x.email)).toEqual([O]);
      expect(calls).toEqual([]);
      upsertAccount(engine.db, { email: N, dir: join(tmp, 'accts', 'nnnnnnnnnnnn') });
      engine.refreshAccounts();
      expect(engine.accounts.map((x) => x.email)).toEqual([N, O]);
      expect(calls).toEqual([N]);
    } finally {
      engine.lanes.accountChanged = orig;
      deleteAccount(engine.db, N);
      logins.delete(N);
      engine.refreshAccounts();
    }
  });
  test('§7.1-2 after the import the boot drops laneCaps / noNewLanes from config.json; the value lives in the table', () => {
    expect(engine.db.query('SELECT lanes_max FROM account WHERE email = ?').get(O)).toEqual({ lanes_max: 3 });
    expect(JSON.parse(readFileSync(paths().config, 'utf8'))).toEqual({ sound: true });
    expect(engine.config.laneCaps).toEqual({ [O]: 3 });
  });
});

describe('§7.2 Mac port auth', () => {
  const up = (h: Record<string, string>) => fetch(`http://127.0.0.1:${engine.port}/ws`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...h } });
  test('§7.2 WS with a bad / missing token → 401', async () => {
    expect((await up({ authorization: 'Bearer wrong', origin: `http://127.0.0.1:${engine.port}` })).status).toBe(401);
    expect((await up({ origin: `http://127.0.0.1:${engine.port}` })).status).toBe(401);
  });
  test('§7.2 WS with a good token but a foreign / missing Origin → 403', async () => {
    expect((await up({ authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })).status).toBe(403);
    expect((await up({ authorization: `Bearer ${TOKEN}` })).status).toBe(403);
  });
  test('§7.2 token via ?token= and tauri://localhost origin are accepted', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${engine.port}/ws?token=${TOKEN}`, { headers: { origin: 'tauri://localhost' } } as unknown as string[]);
    await new Promise<void>((res, rej) => { ws.onmessage = () => res(); ws.onerror = () => rej(new Error('refused')); });
    ws.close();
  });
  test('/healthz, /mcp needs a session token, static SPA fallback, no path escape', async () => {
    const base = `http://127.0.0.1:${engine.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect(await (await fetch(`${base}/`)).text()).toContain('<title>cc-slaves');
    expect(await (await fetch(`${base}/c/12`)).text()).toContain('<title>cc-slaves');
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/secret.txt`)).status).toBe(404);
  });
});

describe('§7.9 snapshot, commands, M16 watch, history', () => {
  test('§7.9 snapshot shape on connect (channel mac, engine info, accounts)', async () => {
    const c = await connect();
    const s = (c.msgs[0] as { snapshot: Snapshot }).snapshot;
    expect(Object.keys(s).sort()).toEqual(['accounts', 'cards', 'channel', 'config', 'drafts', 'engine', 'issues', 'lanes', 'login', 'orchestrators', 'projects', 'quota', 'setup', 'skillsMcp', 'stats', 'toolkit', 'workflows']);
    expect(s.channel).toBe('mac');
    expect(s.engine).toMatchObject({ version: 'test', protocol: 7, shellEnvOk: true });
    // §5.3 epoch ms like every other `*At` (web `now - startedAt < 30_000`, menu bar `started_at_ms`)
    expect(Date.now() - s.engine.startedAt).toBeGreaterThanOrEqual(0);
    expect(Date.now() - s.engine.startedAt).toBeLessThan(600_000);
    expect(s.accounts.map((a) => a.email)).toEqual([O]);
    expect(s.accounts[0]).toMatchObject({ fresh: true, weekPct: 10, lanes: 0 });
    c.close();
  });

  test('§6.2 F2 + hf1116 H2/H3 project_add: added held (paused, no process) → project_resume starts it; duplicate name refused', async () => {
    const c = await connect();
    const plain = join(tmp, 'plain');
    scenario = { steps: [...turn(1), ...turn(2), { waitUser: true }, partial('đang gõ 3'), { sleep: 1500 }, assistant('Trả lời 3'), result('Xong 3'), ...turn(4)] };
    const r = await c.cmd({ cmd: 'project_add', name: 'Shop', path: projectDir });
    expect(r.type).toBe('ack');
    projectId = ((r as { result: { id: string } }).result).id;
    expect(await c.cmd({ cmd: 'project_add', name: 'shop', path: plain.replace('plain', 'shop2') })).toMatchObject({ type: 'error' });
    expect((r as { result: { held: unknown } }).result.held).toEqual({ kind: 'start', sessions: 1, lanes: 0 });
    expect(engine.orchestrators.get(projectId)?.view()).toMatchObject({ state: 'paused', alive: false });
    const resumed = await c.cmd({ cmd: 'project_resume', id: projectId });
    expect((resumed as { result: { held: unknown } }).result.held).toBeNull();
    await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'orchestrator idle');
    expect((c.events('project') as { project: { held?: unknown } }[]).map((e) => e.project.held ?? null)).toEqual([{ kind: 'start', sessions: 1, lanes: 0 }, null]);
    expect(c.events('orchestrator').length).toBeGreaterThan(0);
    c.close();
  });

  test('§7.9 send to the orchestrator reaches fake-claude; M16 stream/partial only to the watcher; history pages', async () => {
    const a = await connect();
    const b = await connect();
    const target = { kind: 'orchestrator' as const, projectId };
    expect(await a.cmd({ cmd: 'watch', target })).toMatchObject({ type: 'ack' });
    expect(await b.cmd({ cmd: 'send', target, text: 'xin chào' })).toMatchObject({ type: 'ack' });
    await until(() => existsSync(stdinLog) && readFileSync(stdinLog, 'utf8').includes('[PO] xin chào'), 'PO text in fake-claude stdin');
    await until(() => a.events('stream').some((e) => (e as { lines: StreamLine[] }).lines.some((l) => l.text === 'Trả lời 2')), 'stream to watcher');
    expect(a.events('partial').length).toBeGreaterThan(0);
    expect(a.events('partial').every((e) => /^msg_fake_[\w-]+:0$/.test((e as { key: string }).key) && typeof (e as { delta?: string }).delta === 'string')).toBe(true); // v2.2 §14.4
    expect(b.events('stream')).toEqual([]);
    expect(b.events('partial')).toEqual([]);
    expect(b.events('orchestrator').length).toBeGreaterThan(0); // non-gated events reach everyone

    const all = (await a.cmd({ cmd: 'history', target, limit: 500 })) as { result: StreamLine[] };
    const texts = all.result.map((l) => l.text);
    expect(texts).toContain('xin chào'); // R3 the conversation shows no "[PO] "
    expect(texts).toContain('Trả lời 2');
    const last = (await a.cmd({ cmd: 'history', target, limit: 1 })) as { result: StreamLine[] };
    expect(last.result.length).toBe(1);
    const prev = (await a.cmd({ cmd: 'history', target, limit: 1, beforeSeq: last.result[0]!.seq })) as { result: StreamLine[] };
    expect(prev.result[0]!.seq).toBeLessThan(last.result[0]!.seq);
    a.close();
    b.close();
  });

  test('v2.2 §14.4 a watch mid-stream gets the held text as `full`; the turn end sends partial_end', async () => {
    const a = await connect();
    const b = await connect();
    const target = { kind: 'orchestrator' as const, projectId };
    await a.cmd({ cmd: 'watch', target });
    const said = (c: typeof a, f: (e: { full?: string; delta?: string }) => boolean) => c.events('partial').some((e) => f(e as { full?: string }));
    expect(await a.cmd({ cmd: 'send', target, text: 'tiếp' })).toMatchObject({ type: 'ack' });
    await until(() => a.events('partial').map((e) => (e as { delta: string }).delta).join('') === 'đang gõ 3', 'deltas to the first watcher');
    expect(b.events('partial')).toEqual([]);
    expect(await b.cmd({ cmd: 'watch', target })).toMatchObject({ type: 'ack' });
    expect(said(b, (e) => e.full === 'đang gõ 3')).toBe(true);
    expect(said(b, (e) => e.delta !== undefined)).toBe(false);
    await until(() => b.events('partial_end').length > 0, 'partial_end at the turn end');
    a.close();
    b.close();
  });

  test('§6.15 card_answer on a permission card from the orchestrator → allow reaches fake-claude', async () => {
    const c = await connect();
    scenario = { steps: [...turn(1), ...PERM.steps] };
    expect(await c.cmd({ cmd: 'orchestrator_new', projectId })).toMatchObject({ type: 'ack' });
    await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'new session idle');
    expect(await c.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId }, text: 'ghi file' })).toMatchObject({ type: 'ack' });
    await until(() => c.events('card').some((e) => (e as { card: { kind: string } }).card.kind === 'permission'), 'permission card');
    const card = (c.events('card').find((e) => (e as { card: { kind: string } }).card.kind === 'permission') as { card: { id: number; title: string } }).card;
    expect(card.title).toContain('Write');
    expect(c.events('notify').some((e) => (e as { cardId?: number }).cardId === card.id)).toBe(true); // app connected → notify event, no osascript
    expect(osa).toEqual([]);
    const r = await c.cmd({ cmd: 'card_answer', id: card.id, answer: { behavior: 'allow' } });
    expect(r).toMatchObject({ type: 'ack', result: { status: 'answered' } });
    await until(() => readFileSync(stdinLog, 'utf8').includes('"behavior":"allow"'), 'allow control_response in stdin');
    expect(await c.cmd({ cmd: 'card_answer', id: card.id, answer: { behavior: 'allow' } })).toMatchObject({ type: 'error', code: 'answered' });
    c.close();
  });

  test('§7 D24 snapshot: protocol 6 (v2.7 §10.1), no appKey, projects carry no permissionMode', () => {
    const snap = engine.snapshot('mac');
    expect(snap.engine.protocol).toBe(7);
    expect('appKey' in snap.engine).toBe(false);
    expect(snap.projects.length).toBeGreaterThan(0);
    for (const p of snap.projects) expect('permissionMode' in p).toBe(false);
  });

  test('§6.17 F17 a failed compatibility check makes lane_start refuse (Vietnamese reason)', async () => {
    engine.compat = { version: '9.9.9', message: 'thiếu MCP cc_slaves' };
    await rejects(engine.mcpLanes().start({ projectId, name: 'D1', cwd: join(tmp, 'wt'), briefPath: '/b.md' })).toThrow(/Không mở lane mới/);
    expect(engine.snapshot('mac').engine.ccUpdated).toContain('9.9.9');
    engine.compat = null;
  });

  test('F16 logged_out card resolves only when the login file is rewritten AND the Keychain holds a login (smoke g6: claude rewrites .claude.json on every start)', async () => {
    logins.delete(O);
    const card = engine.cards.createSystem({ kind: 'logged_out', key: O, titleKey: 'cards.loggedOut', params: { who: 'o@' }, actions: [] });
    engine.refreshAccounts();
    expect(engine.cards.get(card.id)!.status).toBe('open');
    expect(engine.accountViews()[0]!.loggedOut).toBe(true);
    const f = join(oDir, '.claude.json');
    const later = new Date((card.createdAt + 5) * 1000);
    utimesSync(f, later, later);
    engine.refreshAccounts(); // a failed `claude` start touched .claude.json, still no credential
    expect(engine.cards.get(card.id)!.status).toBe('open');
    logins.add(O); // CC Switch re-login wrote the Keychain item
    engine.refreshAccounts();
    expect(engine.cards.get(card.id)!.status).toBe('answered');
    expect(engine.accountViews()[0]!.loggedOut).toBe(false);
  });

  test('§6.16 §7.7 no Claude login in the Keychain → account logged out without a card; lane_start on it refused; login back clears it', async () => {
    logins.delete(O);
    engine.refreshAccounts();
    expect(engine.accountViews()[0]!.loggedOut).toBe(true);
    expect(engine.cards.list({ status: 'open' }).some((c) => c.kind === 'logged_out')).toBe(false);
    await rejects(engine.mcpLanes().start({ projectId, name: 'DX', cwd: join(tmp, 'wt-x'), briefPath: '/b.md', account: O }))
      .toThrow(`${O} đã đăng xuất — Cài đặt › Account › Đăng nhập lại`);
    logins.add(O);
    engine.refreshAccounts();
    expect(engine.accountViews()[0]!.loggedOut).toBe(false);
  });

  test('§8.6 costTodayUsd counts only results since local midnight (event.ts is ms; smoke g6)', () => {
    const before = engine.snapshot('mac').engine.costTodayUsd;
    insertEvent(engine.db, { sessionId: 'old', type: 'result', json: { turnCost: 7 } });
    engine.db.query("UPDATE event SET ts = ? WHERE session_id = 'old'").run(Date.now() - 2 * 86_400_000);
    insertEvent(engine.db, { sessionId: 'new', type: 'result', json: { turnCost: 0.25 } });
    expect(engine.snapshot('mac').engine.costTodayUsd).toBeCloseTo(before + 0.25);
  });

  test('g3 /healthz body for the menu bar: version, startedAt, lanes, openCards, remote', async () => {
    const q = engine.cards.createSystem({ kind: 'shared_cfg_new', key: 'hz:new', titleKey: 'cards.loggedOut', params: { who: 'o@' }, actions: [] });
    const h = await (await fetch(`http://127.0.0.1:${engine.port}/healthz`)).json() as Record<string, unknown>;
    expect(Object.keys(h).sort()).toEqual(['lanes', 'openCards', 'remote', 'startedAt', 'version']);
    expect(h).toMatchObject({ version: 'test', startedAt: engine.startedAt, remote: { enabled: false, hostname: null } });
    // the new-entry question lives only in Cấu hình chung: the menu bar never counts it (same rule as Chờ PO and the tab badge)
    expect(h.openCards).toBe(engine.cards.list({ status: 'open' }).length - 1);
    expect(engine.cards.get(q.id)?.status).toBe('open');
    expect(Array.isArray(h.lanes)).toBe(true);
  });

  test('§7.1-2 caps_update writes the account table (caps.json is not read or written after the import); bad caps refused', async () => {
    const a = await connect();
    const before = existsSync(paths().caps) ? readFileSync(paths().caps, 'utf8') : null;
    expect(await a.cmd({ cmd: 'caps_update', caps: { [O]: { role: 'primary', week: 91, five: 80, hard: false } } as never })).toMatchObject({ type: 'ack' });
    expect(engine.db.query('SELECT role, week, five, hard FROM account WHERE email = ?').get(O)).toEqual({ role: 'primary', week: 91, five: 80, hard: 0 });
    expect(engine.caps[O]).toEqual({ role: 'primary', week: 91, five: 80, hard: false });
    expect(existsSync(paths().caps) ? readFileSync(paths().caps, 'utf8') : null).toBe(before);
    expect(await a.cmd({ cmd: 'caps_update', caps: { [O]: { week: 400 } } })).toMatchObject({ type: 'error', code: 'bad_input' });
    expect(await a.cmd({ cmd: 'caps_update', caps: {} })).toMatchObject({ type: 'ack' }); // back to the defaults
    expect(engine.caps[O]).toBeUndefined();
    a.close();
  });

  test('§6A MINOR-1 config_update ui.lang en → the next card notify is English (Engine → Notifier reads ui.lang at send time)', async () => {
    const c = await connect();
    expect(await c.cmd({ cmd: 'config_update', patch: { ui: { lang: 'en' } } })).toMatchObject({ type: 'ack' });
    const card = engine.cards.createSystem({ kind: 'broken', projectId, key: 'lane:Z9', titleKey: 'cards.laneBroken', params: { name: 'Z9' }, actions: [] });
    const mine = () => c.events('notify').find((e) => (e as { cardId?: number }).cardId === card.id) as { title: string; body: string } | undefined;
    await until(() => mine() !== undefined, 'notify event for the card');
    expect(mine()!.body).toBe('Lane Z9 broken');
    expect(mine()!.title).not.toMatch(/Điều phối|Lane Z9 hỏng/);
    expect(await c.cmd({ cmd: 'config_update', patch: { ui: { lang: 'vi' } } })).toMatchObject({ type: 'ack' });
    const vi = engine.cards.createSystem({ kind: 'broken', projectId, key: 'lane:Z8', titleKey: 'cards.laneBroken', params: { name: 'Z8' }, actions: [] });
    await until(() => c.events('notify').some((e) => (e as { cardId?: number; body: string }).cardId === vi.id && (e as { body: string }).body === 'Lane Z8 hỏng'), 'vi notify after switching back');
    c.close();
  });

  test('g3 config_update → every client gets a `config` event equal to Snapshot.config; bad value refused', async () => {
    const a = await connect();
    const b = await connect();
    const r = await a.cmd({ cmd: 'config_update', patch: { laneCaps: { [O]: 2 }, noNewLanes: { [O]: true }, sound: false } });
    expect(r.type).toBe('ack');
    await until(() => b.events('config').length === 1, 'config event on the other client');
    const ev = b.events('config')[0] as { config: Record<string, unknown> };
    expect(ev.config).toMatchObject({ laneCaps: { [O]: 2 }, noNewLanes: { [O]: true }, sound: false });
    expect(ev.config).toEqual(engine.snapshot('mac').config);
    // §7.1-2 one source: the two keys live in the account table, never in config.json
    expect(engine.db.query('SELECT lanes_max, paused FROM account WHERE email = ?').get(O)).toEqual({ lanes_max: 2, paused: 1 });
    const file = JSON.parse(readFileSync(paths().config, 'utf8')) as Record<string, unknown>;
    expect(file.sound).toBe(false);
    expect('laneCaps' in file || 'noNewLanes' in file).toBe(false);
    expect(await a.cmd({ cmd: 'config_update', patch: { volume: 400 } })).toMatchObject({ type: 'error', code: 'bad_input' });
    expect(await a.cmd({ cmd: 'config_update', patch: { noNewLanes: {}, sound: true } })).toMatchObject({ type: 'ack' });
    a.close(); b.close();
  });

  test('§6.3 F3 a PO message sent into a running turn is echoed as a `po` line with inTurn; a quiet send is not', async () => {
    const c = await connect();
    const target = { kind: 'orchestrator' as const, projectId };
    scenario = { steps: [...turn(8), { waitUser: true }, { sleep: 1200 }, assistant('xong lượt'), result('ok'), ...turn(9), ...turn(10)] };
    expect(await c.cmd({ cmd: 'orchestrator_restart', projectId })).toMatchObject({ type: 'ack' });
    await until(() => lastUserLine().endsWith('tiếp tục.') && engine.orchestrators.get(projectId)?.view().state === 'idle', 'restarted, resume turn done');
    expect(await c.cmd({ cmd: 'watch', target })).toMatchObject({ type: 'ack' });
    expect(await c.cmd({ cmd: 'send', target, text: 'việc một' })).toMatchObject({ type: 'ack' });
    await until(() => engine.orchestrators.get(projectId)?.view().state === 'running', 'running');
    expect(await c.cmd({ cmd: 'send', target, text: 'thêm việc hai' })).toMatchObject({ type: 'ack' });
    const po = () => c.events('stream').flatMap((e) => (e as { lines: StreamLine[] }).lines).filter((l) => l.kind === 'po');
    await until(() => po().some((l) => l.text === 'thêm việc hai'), 'second echo');
    expect(po().find((l) => l.text === 'việc một')?.inTurn).toBeUndefined();
    expect(po().find((l) => l.text === 'thêm việc hai')?.inTurn).toBe(true);
    c.close();
  });

  test('§6.7 F7 card actions: view_log leaves the card open; hand_to_orchestrator tells the orchestrator and resolves', async () => {
    const c = await connect();
    const mk = () => engine.cards.createSystem({
      kind: 'broken', projectId, key: `lane:D9-${Math.random()}`, titleKey: 'cards.laneBroken', params: { name: 'D9' }, body: 'exit 1 ba lần',
      actions: [{ label: 'Chạy lại', action: 'lane_resume', args: { projectId, name: 'D9' } }, { label: 'Xem log', action: 'view_log' },
        { label: 'Giao điều phối xử lý', action: 'hand_to_orchestrator', args: { projectId, name: 'D9' } }],
    });
    const card = mk();
    expect(await c.cmd({ cmd: 'card_action', id: card.id, action: 'view_log' })).toMatchObject({ type: 'ack', result: { status: 'open' } });
    expect(await c.cmd({ cmd: 'card_action', id: card.id, action: 'hand_to_orchestrator' })).toMatchObject({ type: 'ack', result: { status: 'answered' } });
    await until(() => readFileSync(stdinLog, 'utf8').includes('PO giao điều phối xử lý lane D9 hỏng: exit 1 ba lần'), 'orchestrator told');
    expect(await c.cmd({ cmd: 'card_action', id: mk().id, action: 'nope' })).toMatchObject({ type: 'error' });
    c.close();
  });

  test('g3 install_log.job = setup_install.what; subagent_history ack = StreamLine[] of that subagent', async () => {
    const c = await connect();
    expect(await c.cmd({ cmd: 'setup_install', what: 'claude_update' })).toMatchObject({ type: 'ack', result: { job: 'claude_update' } });
    await until(() => c.events('install_log').some((e) => (e as { done?: boolean }).done === true), 'install done');
    expect(new Set(c.events('install_log').map((e) => (e as { job: string }).job))).toEqual(new Set(['claude_update']));
    const sid = engine.sessionsOf({ kind: 'orchestrator', projectId }).at(-1)!;
    engine.lines.append(sid, [{ kind: 'subagent', text: 'con 1', parentToolUseId: 'toolu_sub' }, { kind: 'assistant', text: 'cha', parentToolUseId: null }, { kind: 'tool_use', text: 'Read: a', tool: 'Read', parentToolUseId: 'toolu_sub' }]);
    const r = (await c.cmd({ cmd: 'subagent_history', target: { kind: 'orchestrator', projectId }, taskId: 'toolu_sub' })) as { type: string; result: StreamLine[] };
    expect(r.type).toBe('ack');
    expect(r.result.map((l) => l.text)).toEqual(['con 1', 'Read: a']);
    expect(r.result.every((l) => typeof l.seq === 'number' && typeof l.ts === 'number')).toBe(true);
    c.close();
  });

  test('fake-claude `mcp` step: the orchestrator calls lane_start over the engine MCP endpoint → the lane runs', async () => {
    const c = await connect();
    const wt = join(tmp, 'wt-D7');
    mkdirSync(wt, { recursive: true });
    scenario = { steps: [...turn(12), { waitUser: true }, { mcp: { tool: 'lane_start', args: { name: 'D7', cwd: wt, brief_path: '/b/D7.md' } } }, result('đã mở D7'), ...turn(13)] };
    expect(await c.cmd({ cmd: 'orchestrator_restart', projectId })).toMatchObject({ type: 'ack' });
    await until(() => lastUserLine().endsWith('tiếp tục.') && engine.orchestrators.get(projectId)?.view().state === 'idle', 'restarted, resume turn done');
    scenario = { steps: [...turn(1), { waitUser: true }, { sleep: 1200 }, assistant('lane xong'), result('ok'), ...turn(2), ...turn(3)] }; // the lane's own process (turn 3 answers the stop_all drain)
    expect(await c.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId }, text: 'mở D7' })).toMatchObject({ type: 'ack' });
    await until(() => engine.lanes.get(projectId, 'D7')?.state === 'idle', 'D7 started and idle');
    expect(c.events('lane').some((e) => (e as { lane: { name: string } }).lane.name === 'D7')).toBe(true);
    const h = await (await fetch(`http://127.0.0.1:${engine.port}/healthz`)).json() as { lanes: { name: string; state: string; phase: string | null }[] };
    expect(h.lanes).toContainEqual({ name: 'D7', state: 'idle', phase: null });
    c.close();
  });

  test('§6.3 F3 a PO message sent into a running lane turn is echoed with inTurn (lane path)', async () => {
    const c = await connect();
    const target = { kind: 'lane' as const, projectId, name: 'D7' };
    expect(await c.cmd({ cmd: 'watch', target })).toMatchObject({ type: 'ack' });
    expect(await c.cmd({ cmd: 'send', target, text: 'lane việc một' })).toMatchObject({ type: 'ack' });
    await until(() => engine.lanes.get(projectId, 'D7')?.state === 'running', 'D7 running');
    expect(await c.cmd({ cmd: 'send', target, text: 'lane thêm việc' })).toMatchObject({ type: 'ack' });
    const po = () => c.events('stream').flatMap((e) => (e as { lines: StreamLine[] }).lines).filter((l) => l.kind === 'po');
    await until(() => po().some((l) => l.text === 'lane thêm việc'), 'lane second echo');
    expect(po().find((l) => l.text === 'lane việc một')?.inTurn).toBeUndefined();
    expect(po().find((l) => l.text === 'lane thêm việc')?.inTurn).toBe(true);
    await until(() => engine.lanes.get(projectId, 'D7')?.state === 'idle', 'D7 idle again');
    c.close();
  });

  test('v2.4 §5.6 config_update modelDefaults.lane → the lanes resolve it at the next spawn; lane_set_model on an idle lane → now + LaneView.run', async () => {
    const c = await connect();
    expect(await c.cmd({ cmd: 'config_update', patch: { modelDefaults: { lane: { model: 'sonnet' } } } })).toMatchObject({ type: 'ack' });
    expect(engine.config.modelDefaults).toEqual({ orchestrator: { model: null, effort: null }, lane: { model: 'sonnet', effort: null } });
    expect(engine.lanes.modelScope(projectId, 'D7').tier).toEqual({ model: 'sonnet', effort: null, source: 'settings' });
    expect(await c.cmd({ cmd: 'lane_set_model', projectId, name: 'D7', effort: 'high' })).toMatchObject({ type: 'ack', result: { applied: 'now' } });
    await until(() => c.events('lane').some((e) => (e as { lane: LaneView }).lane.name === 'D7' && (e as { lane: LaneView }).lane.run?.effort === 'high'), 'D7 view with run');
    expect(await c.cmd({ cmd: 'lane_set_model', projectId, name: 'nope', effort: 'high' })).toMatchObject({ type: 'error', code: 'no_lane' });
    expect(await c.cmd({ cmd: 'config_update', patch: { modelDefaults: { lane: { model: null } } } })).toMatchObject({ type: 'ack' });
    c.close();
  });

  test('§6.20 stop_all without projectId never drains the orchestrator', async () => {
    const c = await connect();
    const before = readFileSync(stdinLog, 'utf8').length;
    expect(await c.cmd({ cmd: 'stop_all' })).toMatchObject({ type: 'ack', result: { draining: [`${projectId}/D7`] } });
    await until(() => readFileSync(stdinLog, 'utf8').slice(before).includes('Dừng an toàn'), 'D7 drain');
    await Bun.sleep(200);
    const sent = readFileSync(stdinLog, 'utf8').slice(before);
    expect(sent.split('Dừng an toàn').length - 1).toBe(1); // only the lane; the orchestrator gets nothing
    expect(sent).toContain('D7.md');
    expect(['idle', 'running']).toContain(engine.orchestrators.get(projectId)!.view().state);
    c.close();
  });

  test('§7.1 NC4 engine_shutdown refused while a lane runs is covered by unit; here: accepted when none run', async () => {
    let asked = 0;
    (engine.o as { onShutdownRequest?: () => void }).onShutdownRequest = () => { asked++; };
    const c = await connect();
    expect(await c.cmd({ cmd: 'engine_shutdown' })).toMatchObject({ type: 'ack', result: { shuttingDown: true } });
    await until(() => asked === 1, 'shutdown requested');
    c.close();
  });

  test('PO 2026-11-15 project_add: a folder that is not a git repo is accepted (no .git); its orchestrator starts', async () => {
    const c = await connect();
    const plain = join(tmp, 'plain-nogit');
    mkdirSync(plain, { recursive: true });
    scenario = { steps: [...turn(1)] };
    const r = await c.cmd({ cmd: 'project_add', name: 'NoGit', path: plain });
    expect(r).toMatchObject({ type: 'ack' });
    const id = ((r as { result: { id: string } }).result).id;
    expect(engine.projectRows().some((p) => p.path === plain)).toBe(true);
    await c.cmd({ cmd: 'project_resume', id }); // hf1116 H2
    await until(() => engine.orchestrators.get(id)?.view().state === 'idle', 'no-git orchestrator idle');
    c.close();
  });
});

describe('v2.4 model commands (last: it restarts the orchestrator on its own scenario)', () => {
  test('v2.4 §4.3 / §5.5 session_models from the session\'s process; model then effort within 2 s → one engine line, no "Set model to" replay line', async () => {
    const c = await connect();
    const target = { kind: 'orchestrator' as const, projectId };
    scenario = { steps: [...turn(20), ...turn(21)] };
    expect(await c.cmd({ cmd: 'orchestrator_restart', projectId })).toMatchObject({ type: 'ack' });
    await until(() => lastUserLine().endsWith('tiếp tục.') && engine.orchestrators.get(projectId)?.view().state === 'idle', 'restarted, idle');
    const sessionId = engine.orchestrators.get(projectId)!.currentSessionId;
    const list = (await c.cmd({ cmd: 'session_models', projectId, sessionId })) as { result: { models: { value: string }[]; unavailable?: true } };
    expect(list.result.unavailable).toBeUndefined();
    expect(list.result.models.map((m) => m.value)).toContain('sonnet');
    expect(await c.cmd({ cmd: 'watch', target })).toMatchObject({ type: 'ack' });
    expect(await c.cmd({ cmd: 'session_set_model', sessionId, model: 'sonnet' })).toMatchObject({ type: 'ack', result: { applied: 'now' } });
    expect(await c.cmd({ cmd: 'session_set_model', sessionId, effort: 'high' })).toMatchObject({ type: 'ack', result: { applied: 'now' } });
    const engineLines = () => c.events('stream').flatMap((e) => (e as { lines: StreamLine[] }).lines).filter((l) => l.kind === 'engine' && l.text.startsWith('Đổi '));
    await until(() => engineLines().length > 0, 'model line', 5_000);
    await Bun.sleep(300);
    expect(engineLines().map((l) => l.text)).toEqual(['Đổi model: claude-fake → Sonnet 5.5 · effort: — → high']);
    const all = (await c.cmd({ cmd: 'history', target, limit: 500 })) as { result: StreamLine[] };
    expect(all.result.filter((l) => l.text.includes('Set model to'))).toEqual([]);
    expect(all.result.filter((l) => l.text.startsWith('Đổi model:'))).toHaveLength(1);
    c.close();
  });
});
