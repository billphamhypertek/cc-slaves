// v2 §7.1-3 / §8 IT "Cutover" (I3c): the first v2 boot has no usable account → v1 lanes wait (`no_account`), Chờ PO
// gets one "Chưa có account v2 · {n} lane đang chờ" card that tracks n, and it resolves itself once an account is usable.
// The engine never reads ~/.cc-switch (T12). Temp homes, fake-claude, no Keychain, no network.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SystemPayload } from '../src/cards/store.ts';
import { insertLane, insertProject, insertSession, openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const V1 = 'v1@x.test'; // a v1 email with no v2 `dir`
const NEW = 'n@x.test';
const ENV_KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const LOOP = { steps: Array.from({ length: 4 }, (_, i) => [{ waitUser: true }, { emit: { type: 'result', subtype: 'success', is_error: false, result: `ok ${i}`, num_turns: 1, total_cost_usd: 0, permission_denials: [] } }]).flat() };
let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await Bun.sleep(20);
  }
}
const cutoverCards = (status?: 'open') => engine.cards.list(status ? { status } : {}).filter((c) => c.kind === 'cutover');

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-cutover-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'web'), { recursive: true });
  writeFileSync(join(tmp, 'web', 'index.html'), '<!doctype html>');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  // a v1 state.db: one project, two lanes on a v1 email (one died mid-turn, one quiet)
  const db = openDb(paths().stateDb);
  insertProject(db, { id: 'p1', name: 'shop', path: join(tmp, 'shop') });
  for (const [name, state] of [['D1', 'running'], ['D2', 'running'], ['D3', 'idle']] as const) {
    const cwd = join(tmp, `wt-${name}`);
    mkdirSync(cwd, { recursive: true });
    insertSession(db, { id: `s-${name}`, projectId: 'p1', kind: 'lane', account: V1 });
    insertLane(db, { projectId: 'p1', name, cwd, sessionId: `s-${name}`, briefPath: `/b/${name}.md`, state });
  }
  // a v1 F16 card: its only button (`open_ccswitch` → relogin) can never work on an email with no v2 `dir`
  db.query(`INSERT INTO card (project_id, session_id, kind, payload, status, created_at) VALUES (NULL, NULL, 'logged_out', ?, 'open', 1)`)
    .run(JSON.stringify({ key: V1, title: 'v1@ đã đăng xuất', actions: [{ label: 'Mở CC Switch', action: 'open_ccswitch' }] }));
  db.close();
  engine = await Engine.start({
    gh: null, // never the real gh (network)
    version: 'test', port: 0, token: 'tok', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => { const f = join(tmp, `scn-${Math.random()}.json`); writeFileSync(f, JSON.stringify(LOOP)); return { FAKE_CLAUDE_SCENARIO: f }; },
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
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

test('§7.1-3 I3c boot with no v2 account: v1 lanes wait (no_account, no error) and one cutover card counts them', async () => {
  // hf1116 H1: the two that died mid-turn are held until "Tiếp tục"
  expect(['D1', 'D2'].map((n) => engine.lanes.get('p1', n)?.state)).toEqual(['paused', 'paused']);
  await engine.held.wake('p1');
  // MINOR-1: the idle v1 lane D3 waits too (counted in n), not only the two that died mid-turn
  await until(() => engine.lanes.listAll().filter((v) => v.state === 'waiting_quota').length === 3, 'all three lanes waiting');
  for (const v of engine.lanes.listAll()) expect(v).toMatchObject({ waitReason: 'no_account', lastError: null, failCount: 0 });
  const open = cutoverCards('open');
  expect(open).toHaveLength(1);
  const p = open[0]!.payload as SystemPayload;
  expect(p).toMatchObject({ titleKey: 'cards.cutover', params: { n: 3 }, title: 'Chưa có account v2 · 3 lane đang chờ', key: 'cutover' });
  expect(p.actions).toEqual([{ label: 'Thêm account', action: 'account_add', labelKey: 'cardText.act.addAccount' }]);
  expect(open[0]!.projectId).toBeNull(); // global: Chờ PO of every project
  expect(engine.cards.list({ status: 'open' }).filter((c) => c.kind === 'logged_out' || c.kind === 'broken')).toEqual([]);
});

test('§7.1-3 IMPORTANT-2 a v1 logged_out card (no v2 `dir` for its email) is resolved at boot', () => {
  const v1 = engine.cards.list({}).filter((c) => c.kind === 'logged_out' && (c.payload as SystemPayload).key === V1);
  expect(v1.map((c) => c.status)).toEqual(['answered']);
});

test('§7.1-3 the card follows n: a lane stopped → n = 2 on the same card', async () => {
  const id = cutoverCards('open')[0]!.id;
  await engine.lanes.stop('p1', 'D2', 'now');
  await until(() => (cutoverCards('open')[0]?.payload as SystemPayload | undefined)?.params?.n === 2, 'n = 2');
  expect(cutoverCards('open').map((c) => c.id)).toEqual([id]);
  expect((cutoverCards('open')[0]!.payload as SystemPayload).title).toBe('Chưa có account v2 · 2 lane đang chờ');
});

test('§7.1-3 the first usable v2 account → the card resolves itself and the waiting lane resumes there', async () => {
  seedAccounts([NEW], { db: engine.db });
  engine.refreshAccounts();
  await until(() => cutoverCards('open').length === 0, 'card resolved');
  expect(cutoverCards()).toHaveLength(1); // resolved, not re-created
  await until(() => engine.lanes.get('p1', 'D1')?.account === NEW && engine.lanes.get('p1', 'D1')?.state !== 'waiting_quota', 'D1 resumed on NEW');
});

test('§7.1-3 IMPORTANT-2 a v2 account\'s logged_out card (its row has `dir`) stays open through the cutover sync', () => {
  const c = engine.cards.createSystem({ kind: 'logged_out', key: NEW, titleKey: 'cards.loggedOut', params: { who: 'n@' }, actions: [] });
  engine.refreshAccounts();
  expect(engine.cards.get(c.id)!.status).toBe('open');
});
