import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { keyedText, makeT } from '../../shared/i18n/index.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listUndelivered, openDb, type Db } from '../src/db.ts';
import { Outbox } from '../src/outbox.ts';
import { paths } from '../src/paths.ts';
import { accountAddDirs, buildArgs } from '../src/session/args.ts';
import { childEnv } from '../src/session/env.ts';
import { SessionProcess, type ExitInfo, type SessionOptions } from '../src/session/process.ts';
import type { StreamEvent } from '../src/stream/parser.ts';

const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const EMAIL = 'po@example.com';
const SAVED = { home: process.env.CC_SLAVES_HOME, cj: process.env.CLAUDE_JSON };

let tmp: string;
let db: Db;
let outbox: Outbox;
let live: SessionProcess[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-sess-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  writeFileSync(process.env.CLAUDE_JSON, JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }));
  db = openDb(join(tmp, 'state.db'));
  outbox = new Outbox(db);
});
afterEach(async () => {
  for (const s of live) await s.terminate(500);
  live = [];
  db.close();
  for (const [k, v] of [['CC_SLAVES_HOME', SAVED.home], ['CLAUDE_JSON', SAVED.cj]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const ARGS = { settingsPath: '/h/deny.json', mcpConfigPath: '/h/mcp.json', appendSystemPrompt: 'vai trò' };

function make(scenario: string | (() => string), over: Partial<SessionOptions> = {}) {
  const trace = join(tmp, 'trace.json');
  const sessionId = over.sessionId ?? 'sess-1';
  const s = new SessionProcess({
    sessionId, resume: false, projectId: 'p1', lane: 'D1', runN: 1, args: ARGS, cwd: tmp,
    account: { email: EMAIL, configDir: join(tmp, 'acct') }, outbox, command: ['bun', FAKE],
    env: () => ({
      ...childEnv({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ANTHROPIC_API_KEY: 'sk-x', CLAUDECODE: '1' }, { configDir: join(tmp, 'acct') }),
      FAKE_CLAUDE_SCENARIO: typeof scenario === 'string' ? scenario : scenario(), FAKE_CLAUDE_TRACE: trace,
    }),
    initTimeoutMs: 5000,
    ...over,
  });
  live.push(s);
  const events: StreamEvent[] = [];
  s.on('event', (e) => events.push(e));
  const exited = new Promise<ExitInfo>((r) => s.on('exit', r));
  async function until(pred: (e: StreamEvent) => boolean, ms = 5000): Promise<StreamEvent> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timeout; got ${events.map((e) => e.kind).join(',')}`);
      await Bun.sleep(20);
    }
  }
  return { s, events, until, exited, trace, sessionId };
}

const isResult = (e: StreamEvent) => e.kind === 'result';

describe('SessionProcess self-check (§7.3)', () => {
  test('§7.3 ok-turn: first message written at spawn, init passes, version reported, replay marks outbox delivered', async () => {
    const f = make('ok-turn');
    const m = outbox.enqueue('sess-1', 'làm D1', '[Điều phối]');
    const r = await f.s.start();
    expect(r).toMatchObject({ ok: true, version: '2.1.325-fake' });
    await f.until(isResult);
    expect(listUndelivered(db, 'sess-1')).toEqual([]);
    expect(f.events.some((e) => e.kind === 'user' && e.uuid === m.uuid && e.isReplay)).toBe(true);
    // §7.3 exact argv + env stripped
    const t = JSON.parse(readFileSync(f.trace, 'utf8'));
    expect(t.argv).toEqual(buildArgs({ ...ARGS, addDirs: accountAddDirs({ configDir: join(tmp, 'acct') }), sessionId: 'sess-1', resume: false }));
    expect(t.argv.slice(t.argv.indexOf('--add-dir'), t.argv.indexOf('--add-dir') + 3)).toEqual(['--add-dir', join(tmp, 'acct', 'projects'), join(tmp, 'acct', 'plans')]); // §8 SA2
    expect(t.envKeys).not.toContain('ANTHROPIC_API_KEY');
    expect(t.envKeys).not.toContain('CLAUDECODE');
    expect(t.envKeys).toContain('CLAUDE_CONFIG_DIR'); // v2 §5.4: always the account dir
    // v2.2 §14.4 stream gate: stream_events always reach the engine (it holds text + numbers blocks), watched or not
    expect(f.events.filter((e) => e.kind === 'stream_event').length).toBe(2);
    // §8.4 per-run raw log, 0600, partial lines included; RAM keeps ≤ 50 lines
    const log = paths().runLog('p1', 'D1', 1);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.some((l) => l.includes('"stream_event"'))).toBe(true);
    expect(f.s.recentLines.length).toBe(lines.length);
    f.s.closeStdin();
    expect(await f.exited).toMatchObject({ kind: 'requested', requested: 'close', code: 0, sawResult: true, midTurn: false });
    expect(f.s.logOpen).toBe(false);
  });

  test('§8.4 RAM keeps only the last 50 stdout lines; the run log keeps all', async () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.330',
      mcp_servers: [{ name: 'cc_slaves', status: 'connected' }] });
    const script = `for i in $(seq 1 80); do echo "{\\"type\\":\\"noise\\",\\"n\\":$i}"; done; echo '${init}'; cat >/dev/null`;
    const f = make('unused', { command: ['sh', '-c', script, 'sh'] });
    outbox.enqueue('sess-1', 'go', null);
    expect(await f.s.start()).toMatchObject({ ok: true, version: '2.1.330' });
    expect(f.s.recentLines.length).toBe(50);
    expect(f.s.recentLines.at(-1)).toBe(init);
    expect(readFileSync(paths().runLog('p1', 'D1', 1), 'utf8').trim().split('\n').length).toBe(81);
  });

  for (const [scenario, kind, version] of [
    ['no-mcp', 'mcp_missing', '2.1.325-fake'],
    ['mcp-failed', 'mcp_not_connected', '2.1.325-fake'],
    ['old-version', 'old_version', '2.1.324'],
  ] as const) {
    test(`§7.3 self-check ${scenario} → kill + typed failure ${kind}, not a lane run`, async () => {
      const f = make(scenario);
      outbox.enqueue('sess-1', 'go', null);
      const r = await f.s.start();
      expect(r).toMatchObject({ ok: false, failure: { kind, version, countsAsRun: false, reason: { key: `errors.start_${kind}` } } });
      const fl = (r as Extract<typeof r, { ok: false }>).failure;
      expect(keyedText(makeT('vi'), fl.reason)).toBe(fl.message); // §6A G5-fix: vi catalog = the stored message
      expect(await f.exited).toMatchObject({ kind: 'requested', requested: 'selfcheck' });
    });
  }

  test('§7.3 no system/init within the timeout → kill + init_timeout', async () => {
    const f = make('no-init', { initTimeoutMs: 400 });
    outbox.enqueue('sess-1', 'go', null);
    const t0 = Date.now();
    const r = await f.s.start();
    expect(r).toMatchObject({ ok: false, failure: { kind: 'init_timeout', countsAsRun: false, reason: { key: 'errors.start_init_timeout', params: { s: 0 } } } });
    const fl = (r as Extract<typeof r, { ok: false }>).failure;
    expect(keyedText(makeT('en'), fl.reason)).toBe('claude sent no system/init within 0 s');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await f.exited).toMatchObject({ requested: 'selfcheck' });
  });


  test('§7.3 nothing to send → no spawn (init only comes after the first user line)', async () => {
    const f = make('ok-turn');
    expect(await f.s.start()).toMatchObject({ ok: false, failure: { kind: 'no_message' } });
    expect(existsSync(f.trace)).toBe(false);
  });
});

describe('SessionProcess I/O (§3.3, §7.4, §7.6)', () => {
  test('§7.6 resume: resume message first, then undelivered, all marked delivered on replay', async () => {
    const a = outbox.enqueue('sess-1', 'tin cũ 1', '[PO → D1]');
    const b = outbox.enqueue('sess-1', 'tin cũ 2', null);
    const f = make('ok-turn', { resume: true, resumeText: 'tiếp tục D1' });
    expect(await f.s.start()).toMatchObject({ ok: true });
    await f.until(isResult);
    const replays = f.events.filter((e) => e.kind === 'user' && e.isReplay).map((e) => (e.kind === 'user' ? e.uuid : null));
    expect(replays.slice(1)).toEqual([a.uuid, b.uuid]);
    expect(JSON.parse(readFileSync(f.trace, 'utf8')).argv).toContain('--resume');
    expect(listUndelivered(db, 'sess-1')).toEqual([]);
  });

  test('§3.3-6 §7.6 interrupt: result ≤10 s, still_queued stays undelivered, session lives and takes it later', async () => {
    const f = make('interrupt');
    outbox.enqueue('sess-1', 'first', null);
    await f.s.start();
    await f.until((e) => e.kind === 'assistant');
    const mid = f.s.send('mid-turn', '[PO → D1]');
    await Bun.sleep(100);
    const r = await f.s.interrupt();
    expect(r).toMatchObject({ timedOut: false, result: { subtype: 'error_during_execution' } });
    expect(listUndelivered(db, 'sess-1').map((m) => m.uuid)).toEqual([mid.uuid]);
    f.s.flush(); // written again after still_queued
    await f.until((e) => e.kind === 'result' && e.subtype === 'success');
    expect(listUndelivered(db, 'sess-1')).toEqual([]);
    expect(f.s.alive).toBe(true);
  });

  test('§7.4 die-mid-turn: exit without result, not requested → died_mid_turn', async () => {
    const f = make('die-mid-turn');
    outbox.enqueue('sess-1', 'go', null);
    expect(await f.s.start()).toMatchObject({ ok: true });
    expect(await f.exited).toMatchObject({ kind: 'died_mid_turn', requested: null, sawResult: false, midTurn: true });
  });

  test('§3.3-10 terminate → SIGTERM, classified as requested', async () => {
    const f = make('interrupt');
    outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    await f.until((e) => e.kind === 'assistant');
    await f.s.terminate();
    expect(await f.exited).toMatchObject({ kind: 'requested', requested: 'terminate', signal: 'SIGTERM' });
  });

  test('§7.1 "already in use": kill the orphan with that session id, wait 5 s, retry', async () => {
    let scenario = 'in-use';
    const killed: number[] = [];
    const sleeps: number[] = [];
    const f = make(() => scenario, {
      ps: async () => [{ pid: 999_991, command: 'claude -p --session-id sess-1' }, { pid: 999_992, command: 'claude --session-id other' }],
      kill: (pid) => { killed.push(pid); scenario = 'ok-turn'; },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const exits: ExitInfo[] = [];
    f.s.on('exit', (e) => exits.push(e));
    outbox.enqueue('sess-1', 'go', null);
    expect(await f.s.start()).toMatchObject({ ok: true });
    expect(exits).toEqual([]); // the retried attempt is not a session exit
    expect(killed).toEqual([999_991]);
    expect(sleeps).toEqual([5000]);
    await f.until(isResult);
    expect(listUndelivered(db, 'sess-1')).toEqual([]);
  });

  test('§7.1 "already in use" every time → in_use failure after 3 tries, no tight loop', async () => {
    let spawns = 0;
    const sleeps: number[] = [];
    const f = make(() => { spawns++; return 'in-use'; }, { ps: async () => [], kill: () => {}, sleep: async (ms) => { sleeps.push(ms); } });
    outbox.enqueue('sess-1', 'go', null);
    expect(await f.s.start()).toMatchObject({ ok: false, failure: { kind: 'in_use', countsAsRun: false } });
    expect(spawns).toBe(3);
    expect(sleeps).toEqual([5000, 5000]);
  });
});
