// v2.7.1 §7.4 / §11 over the real Engine with fake-claude (temp homes, no network, no real quota): spec_* with account +
// model + effort → the session runs on that account with --model / --effort on its argv; omitted → today's home account,
// no flags; a full account → account_unusable; no account left → no_account + earliest; session_pick = what openKind uses;
// hf1117 the ack still goes before a 3 s claude boot.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionPick } from '../../shared/issues.ts';
import { insertProject, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { insertSpec, moveSpec } from '../src/issues/store.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import type { CommandCtx } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(60_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test', A = 'a@x.test', B = 'b@x.test', F = 'f@x.test';
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const MAC: CommandCtx = { channel: 'mac' };
const RESULT = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } };
const LOOP = { steps: Array.from({ length: 6 }, () => [{ waitUser: true }, RESULT]).flat() };
const BOOT_MS = '3000';

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let h: ReturnType<typeof buildHandlers>;
const traces: string[] = [];
const now = () => Math.floor(Date.now() / 1000);

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(20);
  }
}
const argvOf = (sid: string): string[] => traces.filter((f) => existsSync(f))
  .map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { argv: string[] }).argv).find((a) => a.includes(sid))!;
const flag = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
const view = (sid: string) => engine.orchestrators.bySession(sid)?.view();
const quota = (account: string, o: { weekPct?: number; status?: string; weekResetsAt?: number } = {}) => upsertQuota(engine.db, {
  account, fivePct: 10, weekPct: o.weekPct ?? 10, fiveResetsAt: now() + 3600, weekResetsAt: o.weekResetsAt ?? now() + 86_400,
  source: 'api', fetchedAt: now(), status: o.status ?? 'ok',
});
async function err(f: () => unknown): Promise<{ code: string; key?: string; params?: Record<string, unknown> }> {
  try { await f(); } catch (x) { return x as { code: string }; }
  throw new Error('expected a refusal');
}
const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const r = await f(); return [r, performance.now() - t]; };

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-startpicks-')));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-marketplace': true } }));
  const db = openDb(paths().stateDb);
  seedAccounts([O, A, B, F], { db });
  for (const p of ['p1', 'p2', 'p3', 'p4']) {
    mkdirSync(join(tmp, p), { recursive: true });
    insertProject(db, { id: p, name: p.toUpperCase(), path: join(tmp, p), orchestratorAccount: O });
  }
  db.close();
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => {
      const n = traces.length + 1;
      const f = join(tmp, `scn-${n}.json`);
      writeFileSync(f, JSON.stringify(LOOP));
      const trace = join(tmp, `trace-${n}.json`);
      traces.push(trace);
      return { FAKE_CLAUDE_SCENARIO: f, FAKE_CLAUDE_TRACE: trace, FAKE_CLAUDE_BOOT_MS: BOOT_MS };
    },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 10_000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
  });
  h = buildHandlers(engine, {} as Conn);
  for (const a of [O, A, B]) quota(a);
  quota(F, { weekPct: 100, status: 'rejected' }); // Anthropic: limit reached
});

afterAll(async () => {
  await engine?.stop();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('v2.7.1 §7.4 start options (Engine + fake-claude)', () => {
  test('spec_new with account + model + effort: ack < 500 ms at a 3 s boot; runs on that account, --model / --effort on argv', async () => {
    const [ack, ms] = await timed(() => h.spec_new({ cmd: 'spec_new', projectId: 'p1', account: A, model: 'sonnet', effort: 'high' }, MAC) as Promise<{ sessionId: string }>);
    expect(ms).toBeLessThan(500); // hf1117 the session opens before claude boots
    expect(view(ack.sessionId)?.state).toBe('starting');
    await until(() => view(ack.sessionId)?.state === 'idle', 'picked session idle');
    expect(view(ack.sessionId)?.account).toBe(A);
    const a = argvOf(ack.sessionId);
    expect(flag(a, '--model')).toBe('sonnet');
    expect(flag(a, '--effort')).toBe('high');
  });

  test('spec_build with picks omitted → today exactly: the project home account, no --model / --effort; ack < 500 ms', async () => {
    const s = insertSpec(engine.db, { projectId: 'p2', path: 'docs/specs/b.md', title: 'B', origin: 'app' });
    moveSpec(engine.db, s.id, 'approved');
    const [ack, ms] = await timed(() => h.spec_build({ cmd: 'spec_build', projectId: 'p2', path: s.path }, MAC) as Promise<{ sessionId: string }>);
    expect(ms).toBeLessThan(500);
    await until(() => view(ack.sessionId)?.state === 'idle', 'default session idle');
    expect(view(ack.sessionId)?.account).toBe(O);
    const a = argvOf(ack.sessionId);
    expect(a).not.toContain('--model');
    expect(a).not.toContain('--effort');
  });

  test('a full account picked by hand → account_unusable with the reason; nothing opened', async () => {
    const before = engine.orchestrators.list('p3').length;
    expect(await err(() => h.spec_new({ cmd: 'spec_new', projectId: 'p3', account: F }, MAC)))
      .toMatchObject({ code: 'account_unusable', key: 'errors.startFullAnthropicWeek', params: { email: F } }); // week at 100 % → the week
    expect(engine.orchestrators.list('p3').length).toBe(before);
  });

  test('UX MINOR-6 the Deck "Mở phiên song song" (session_open) with a full account picked by hand → account_unusable; nothing opened', async () => {
    const before = engine.orchestrators.list('p3').length;
    expect(await err(() => h.session_open({ cmd: 'session_open', projectId: 'p3', account: F }, MAC)))
      .toMatchObject({ code: 'account_unusable', key: 'errors.startFullAnthropicWeek', params: { email: F } });
    expect(engine.orchestrators.list('p3').length).toBe(before);
  });

  test('session_pick = openKind\'s account; every account full → null + earliest, spec_new (no account) → no_account + earliest', async () => {
    const pick = await h.session_pick({ cmd: 'session_pick', projectId: 'p3', kind: 'design' }, MAC) as SessionPick;
    expect(pick).toMatchObject({ account: B, earliest: null }); // home O runs p2's session, A runs p1's: busy accounts rank after
    const opened = await h.spec_new({ cmd: 'spec_new', projectId: 'p3' }, MAC) as { sessionId: string };
    await until(() => view(opened.sessionId)?.state === 'idle', 'auto session idle');
    expect(view(opened.sessionId)?.account).toBe(pick.account); // the account the session really runs on
    const before = engine.orchestrators.list('p3').length;
    const soon = now() + 7200;
    quota(O, { weekPct: 100, status: 'rejected', weekResetsAt: now() + 86_400 });
    quota(A, { weekPct: 99.5, weekResetsAt: soon });
    quota(B, { weekPct: 99.5, weekResetsAt: soon + 60 });
    const none = await h.session_pick({ cmd: 'session_pick', projectId: 'p3', kind: 'build' }, MAC) as SessionPick;
    expect(none).toMatchObject({ account: null, headroomPct: null });
    expect(none.earliest).not.toBeNull();
    const refused = await err(() => h.spec_new({ cmd: 'spec_new', projectId: 'p3' }, MAC));
    expect(refused).toMatchObject({ code: 'no_account', key: 'errors.noAccountEarliest', params: { email: none.earliest!.email, atMs: none.earliest!.at } });
    expect(engine.orchestrators.list('p3').length).toBe(before);
  });

  test('§4.5 hard home in the admit band (cap 70, week 68 %): Tự chọn skips it and the session runs where session_pick said', async () => {
    engine.caps = { ...engine.caps, [O]: { ...engine.caps[O], week: 70, hard: true } };
    quota(O, { weekPct: 68 });
    quota(A);
    quota(B);
    const pick = await h.session_pick({ cmd: 'session_pick', projectId: 'p4', kind: 'design' }, MAC) as SessionPick;
    expect(pick.account).not.toBeNull();
    expect(pick.account).not.toBe(O);
    const ack = await h.spec_new({ cmd: 'spec_new', projectId: 'p4' }, MAC) as { sessionId: string };
    await until(() => view(ack.sessionId)?.state === 'idle', 'auto session idle');
    expect(view(ack.sessionId)?.account).toBe(pick.account);
    expect(await err(() => h.spec_new({ cmd: 'spec_new', projectId: 'p4', account: O }, MAC)))
      .toMatchObject({ code: 'account_unusable', key: 'errors.startAdmit' }); // hand pick and Tự chọn agree
  });
});
