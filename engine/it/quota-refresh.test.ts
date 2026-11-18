// v2.7.1 §7.2–§7.3 IT: `quota_refresh` over WS against a real engine — ack at once (queued / skipped / cooldown), the
// `account` events of the asked row (refresh queued → fetching → idle, D103 `fiveWindow`), `Snapshot.quota` + the `quota`
// event, protocol 7. The usage API is a local fake HTTP server (keychainQuotaSource with a fake `security` + a fetch that
// routes there); temp home; never the real Keychain or Anthropic.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AccountView, type Command, type QuotaState, type ServerMsg, type Snapshot } from '../../shared/protocol.ts';
import type { QuotaRefreshAck } from '../../shared/accounts.ts';
import { keychainQuotaSource } from '../src/accounts/quota.ts';
import { openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const U = 'ultra@x.test'; // usage answers `five_hour: null` (weekly only)
const M = 'max@x.test';
const L = 'late@x.test';
const TOKEN = 'ws-token';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const week = { utilization: 40, resets_at: '2030-01-02T00:00:00Z' };

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let usage: ReturnType<typeof Bun.serve>;
const hits: string[] = [];
const svcEmail = new Map<string, string>();

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}

interface Client { msgs: ServerMsg[]; cmd(c: Command): Promise<ServerMsg>; close(): void; events<T>(type: string): T[] }
let n = 0;
async function connect(): Promise<Client> {
  const port = engine.port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${port}` } } as unknown as string[]);
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
    events: <T,>(type: string) => msgs.filter((m) => m.type === 'event' && m.event.type === type).map((m) => (m as unknown as { event: T }).event),
  };
}
const accountEvents = (c: Client, email: string) => c.events<{ account: AccountView }>('account').map((e) => e.account).filter((a) => a.email === email);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-quota-it-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  usage = Bun.serve({
    port: 0,
    fetch(req) {
      const email = (req.headers.get('authorization') ?? '').replace('Bearer tok-', '');
      hits.push(email);
      const body = email === U ? { five_hour: null, seven_day: week } : { five_hour: { utilization: 12, resets_at: '2030-01-01T05:00:00Z' }, seven_day: week };
      return Response.json(body);
    },
  });
  const db = openDb(paths().stateDb);
  const now = Math.floor(Date.now() / 1000);
  for (const a of seedAccounts([U, M, L], { db })) {
    svcEmail.set(a.keychainService, a.email);
    // asked 2 min ago: past the 60 s manual floor, before the 5-min schedule (no scheduled poll during the test)
    upsertQuota(db, { account: a.email, fivePct: 5, weekPct: 5, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now - 120, status: 'ok' });
  }
  db.close();
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: TOKEN, staticDir: null, command: ['false'],
    loginEnv: { env: { PATH: process.env.PATH ?? '' }, claudePath: null, shellFailed: false, reason: null },
    quotaSource: keychainQuotaSource({
      exec: (_cmd, args) => JSON.stringify({ claudeAiOauth: { accessToken: `tok-${svcEmail.get(args[2]!) ?? '?'}` } }),
      fetch: (_url, init) => fetch(`http://127.0.0.1:${usage.port}/api/oauth/usage`, init),
    }),
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    accountsEveryMs: 0, quotaEveryMs: 100, log: () => {},
    hasLogin: () => true,
  });
});

afterAll(async () => {
  await engine?.stop();
  void usage?.stop(true);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('v2.7.1 §7.2 quota_refresh over WS', () => {
  test('§7.2 protocol 7; snapshot carries quota + the new AccountView fields', async () => {
    const c = await connect();
    const s = (c.msgs[0] as { snapshot: Snapshot }).snapshot;
    expect(PROTOCOL_VERSION).toBe(7);
    expect(s.engine.protocol).toBe(7);
    expect(s.quota).toEqual({ cooldownUntil: null, queueEndsAt: null });
    expect(s.accounts.find((a) => a.email === M)).toMatchObject({ refresh: { state: 'idle', at: null }, quotaError: null, fullWhy: null, fiveWindow: true });
    c.close();
  });

  test('§7.2 ⟳ one row: ack at once, the row goes queued → fetching → idle; D103 Ultra shape → fiveWindow false', async () => {
    const c = await connect();
    const r = await c.cmd({ cmd: 'quota_refresh', account: U });
    expect(r.type).toBe('ack');
    expect((r as { result: QuotaRefreshAck }).result).toEqual({ queued: [U], skipped: [], cooldownUntil: null });
    await until(() => accountEvents(c, U).some((a) => a.refresh.state === 'idle' && a.weekPct === 40), 'U answered');
    const states = accountEvents(c, U).map((a) => a.refresh.state);
    expect(states.indexOf('queued')).toBeLessThan(states.indexOf('fetching'));
    expect(states.lastIndexOf('idle')).toBeGreaterThan(states.indexOf('fetching'));
    expect(accountEvents(c, U).at(-1)).toMatchObject({ fivePct: null, weekPct: 40, fiveWindow: false, quotaError: null });
    expect(hits).toEqual([U]);
    c.close();
  });

  test('§7.2 Làm mới all: the row asked < 60 s ago is skipped recent; the rest queued 20 s apart; quota event with queueEndsAt', async () => {
    const c = await connect();
    const r = await c.cmd({ cmd: 'quota_refresh' });
    const ack = (r as { result: QuotaRefreshAck }).result;
    expect([...ack.queued].sort()).toEqual([L, M].sort());
    expect(ack.skipped).toEqual([{ email: U, reason: 'recent', until: expect.any(Number) }]);
    expect(ack.skipped[0]!.until! - Date.now()).toBeLessThanOrEqual(60_000);
    await until(() => c.events<{ quota: QuotaState }>('quota').some((e) => e.quota.queueEndsAt !== null), 'quota event');
    const end = c.events<{ quota: QuotaState }>('quota').find((e) => e.quota.queueEndsAt !== null)!.quota.queueEndsAt!;
    expect(end % 60_000).toBe(0);
    await Bun.sleep(400); // the 20 s gap after U's ask: nothing else goes out yet
    expect(hits).toEqual([U]);
    const queued = engine.accountViews().filter((a) => a.refresh.state === 'queued');
    expect(queued.map((a) => a.email).sort()).toEqual([L, M].sort());
    // §4.4 ⟳ of the row queued last moves it to the front (no duplicate)
    const last = ack.queued.at(-1)!;
    const again = (await c.cmd({ cmd: 'quota_refresh', account: last }) as { result: QuotaRefreshAck }).result;
    expect(again.queued).toEqual([last]);
    const at = (e: string) => engine.accountViews().find((a) => a.email === e)!.refresh.at!;
    expect(at(last)).toBeLessThan(at(ack.queued[0]!));
    c.close();
  });

  test('§7.2 unknown account → no_account error', async () => {
    const c = await connect();
    const r = await c.cmd({ cmd: 'quota_refresh', account: 'nobody@x.test' });
    expect(r).toMatchObject({ type: 'error', code: 'no_account' });
    c.close();
  });
});
