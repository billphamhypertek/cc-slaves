import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { keyedText, makeT } from '../../shared/i18n/index.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Account } from '../src/accounts/registry.ts';
import { QuotaTracker } from '../src/accounts/quota.ts';
import type { Caps } from '../src/config.ts';
import { getLane, getQuota, insertLane, insertOutbox, insertProject, insertSession, listUndelivered, markDelivered, openDb, sessionCost, upsertQuota, type Db } from '../src/db.ts';
import { LaneManager, type LaneManagerDeps } from '../src/lane/manager.ts';
import { LANE_RESUME_TEXT } from '../src/lane/manager/types.ts';
import { listEvents } from './_db.ts';
import { drainText } from '../src/lane/reducer.ts';
import { stopAll } from '../src/lane/stop-all.ts';
import { appendixOf, hashOf } from '../test/_fixtures/po-pack.ts';
import { Orchestrators, type OrchestratorDeps, type OrchestratorEvent, type OrchestratorState } from '../src/orchestrator/session.ts';
import { Outbox } from '../src/outbox.ts';
import { UpdateGate } from '../src/update/commit.ts';
import { recover } from '../src/recovery.ts';
import { CardStore, type SystemPayload } from '../src/cards/store.ts';
import { attachLaneCards, attachOrchestratorCards, attachSystemCards, laneCardSessions, orchestratorCardSessions } from '../src/cards/wire.ts';
import { buildCatalog, type SessionGraph } from '../src/mcp/catalog.ts';
import type { SessionSpawn } from '../src/session/files.ts';
import { paths } from '../src/paths.ts';
import { ModelCache } from '../src/models.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test'; // the project's orchestrator account
const A = 'a@x.test'; // primary soft
const H = 'h@x.test'; // primary hard
const K = 'k@x.test'; // backup
const CAPS: Caps = {
  default: { week: 98, five: 95 },
  [O]: { role: 'orchestrator', week: 99, five: 97 },
  [A]: { role: 'primary', week: 99 },
  [H]: { role: 'primary', week: 60, hard: true },
  [K]: { role: 'backup', week: 70, five: 95 },
};
const SAVED = process.env.CC_SLAVES_HOME;
const FUTURE5 = 4102444800;
const FUTURE7 = 4103049600;
const TODAY = new Date().toISOString().slice(0, 10);
const RESUME = (acct: string) => `[cc-slaves] Phiên được nối lại trên ${acct} sau khi bị ngắt. Gọi lanes_list để cập nhật rồi tiếp tục.`;

type Step = Record<string, unknown>;
const assistant = (text = 'Đang làm…'): Step => ({
  emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] } },
});
const result = (text = 'Xong.'): Step => ({
  emit: { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.01, permission_denials: [] },
});
const limitResult: Step = {
  emit: { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm", num_turns: 1, permission_denials: [] },
};
const stoppedResult: Step = { emit: { type: 'result', subtype: 'error_during_execution', is_error: true, result: '', num_turns: 1, permission_denials: [] } };
const rateLimit = (five: number, status = 'allowed_warning', type?: string): Step => ({
  emit: { type: 'rate_limit_event', rate_limit_info: { status, resetsAt: FUTURE5, ...(type ? { rateLimitType: type } : {}), unifiedWindows: {
    five_hour: { utilization: five, resetsAt: FUTURE5 }, seven_day: { utilization: 0.3, resetsAt: FUTURE7 } } } },
});
const wait: Step = { waitUser: true };
const sleep = (ms: number): Step => ({ sleep: ms });
const die: Step = { die: {} };
const turns = (n: number): Step[] => Array.from({ length: n }, (_, i) => [wait, assistant(), result(`Xong lượt ${i + 1}.`)]).flat();
const LOOP = { steps: turns(8) };

let tmp: string;
let db: Db;
let spawns: { account: string; n: number; trace: string; stdin: string }[];
let closers: (() => Promise<void>)[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-orch-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  db = openDb(join(tmp, 'state.db'));
  mkdirSync(join(tmp, 'p1'), { recursive: true });
  insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1'), orchestratorAccount: O });
  spawns = [];
  closers = [];
});
afterEach(async () => {
  for (const c of closers) await c();
  db.close();
  if (SAVED === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = SAVED;
  rmSync(tmp, { recursive: true, force: true });
});

const account = (email: string): Account => ({
  email, id: null, configDir: join(tmp, `cfg-${email}`), keychainService: `k-${email}`, planTier: 'max', terminal: false,
});

interface Setup { scenario: (email: string, n: number) => object; accounts?: string[]; handoffTimeoutMs?: number; loggedOut?: Set<string>; graph?: SessionGraph; gate?: UpdateGate }
type Spawned = { sid: string } & SessionSpawn;

function setup(o: Setup) {
  const accounts = (o.accounts ?? [O, A]).map(account);
  const counts = new Map<string, number>();
  const events: OrchestratorEvent[] = [];
  const outbox = new Outbox(db);
   
  let m: LaneManager;
   
  let orchs: Orchestrators;
  const tracker = new QuotaTracker({
    db, source: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    onAccountChanged: (e) => { m.accountChanged(e); orchs.accountChanged(e); },
  });
  const env = (a: Account) => {
    const n = (counts.get(a.email) ?? 0) + 1;
    counts.set(a.email, n);
    const file = join(tmp, `scn-${a.email}-${n}.json`);
    writeFileSync(file, JSON.stringify(o.scenario(a.email, n)));
    const trace = join(tmp, `trace-${a.email}-${n}.json`);
    const stdin = join(tmp, `stdin-${a.email}-${n}.jsonl`);
    spawns.push({ account: a.email, n, trace, stdin });
    return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_TRACE: trace, FAKE_CLAUDE_STDIN_LOG: stdin };
  };
  const ended: string[] = [];
  const spawned: Spawned[] = [];
  const onMcpToken = (sid: string, sp: SessionSpawn) => { spawned.push({ sid, ...sp }); };
  const od: OrchestratorDeps = {
    onSessionEnded: (sid) => ended.push(sid), onMcpToken,
    db, outbox, accounts: () => accounts, quota: tracker, caps: () => CAPS, command: ['bun', FAKE], mcpPort: 1, env,
    loggedOut: () => o.loggedOut ?? new Set(),
    sessionSetup: (pid) => ({
      catalog: buildCatalog({ claudeJson: { mcpServers: { user_srv: { command: `u-${pid}` }, cc_slaves: { type: 'http', url: 'evil' } } }, projectMcp: {}, plugins: [] }, [], { offForLanes: [], projectOn: [], pluginsOff: [] }),
      off: { skills: ['h-ops'], plugins: [] }, graph: o.graph ?? null,
    }),
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 500 }, closeGraceMs: 300, handoffTimeoutMs: o.handoffTimeoutMs ?? 5000, modelCache: new ModelCache(),
    ...(o.gate ? { gate: o.gate } : {}),
  };
  orchs = new Orchestrators(od);
  orchs.on((e) => events.push(e));
  const ld: LaneManagerDeps = {
    db, outbox, accounts: () => accounts, quota: tracker, caps: () => CAPS, config: () => ({ maxLanes: 8, maxLanesPerAccount: 3 }),
    command: ['bun', FAKE], mcpPort: 1, env, notify: (p, t) => orchs.notify(p, t), onMcpToken,
    ...(o.graph !== undefined ? { sessionSetup: () => ({ graph: o.graph }) } : {}),
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 300 }, closeGraceMs: 300,
  };
  m = new LaneManager(ld);
  const cards = new CardStore({ db, sessions: laneCardSessions(m, outbox, orchestratorCardSessions(orchs, outbox)) });
  attachLaneCards(cards, m);
  attachOrchestratorCards(cards, orchs);
  attachSystemCards(cards, db, { lanes: m, orchestrators: orchs });
  closers.push(async () => cards.shutdown(), () => orchs.shutdown(), () => m.shutdown());
  return { m, orchs, events, tracker, outbox, cards, ended, accounts, spawned };
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}
const spawn = (email: string, n: number) => spawns.find((s) => s.account === email && s.n === n);
const argvOf = (email: string, n: number): string[] => (JSON.parse(readFileSync(spawn(email, n)!.trace, 'utf8')) as { argv: string[] }).argv;
/** User message texts a fake process received, in order. */
const received = (email: string, n: number): string[] => {
  const f = spawn(email, n)?.stdin;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: string } })
    .filter((l) => l.type === 'user').map((l) => l.message!.content);
};
const orchState = (orchs: Orchestrators) => orchs.get('p1')?.view().state;
const reachO = (orchs: Orchestrators, s: OrchestratorState) => until(() => orchState(orchs) === s, `orchestrator ${s} (now ${orchState(orchs)})`);
const fresh = (account: string, five: number, o: Record<string, unknown> = {}) => upsertQuota(db, {
  account, fivePct: five, weekPct: 10, fiveResetsAt: FUTURE5, weekResetsAt: FUTURE7, source: 'api', fetchedAt: Math.floor(Date.now() / 1000), status: 'ok', ...o,
});
const sessionRow = (id: string) => db.query<{ kind: string; account: string; state: string; prompt_hash: string | null; ended_at: number | null }, [string]>(
  'SELECT kind, account, state, prompt_hash, ended_at FROM session WHERE id = ?').get(id)!;

describe('orchestrator session (§7.5)', () => {
  test('§7.5 start on the project orchestrator account: kind orchestrator, prompt hash, appendix via --append-system-prompt', async () => {
    const { orchs } = setup({ scenario: () => LOOP });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    const v = o.view();
    expect(v.account).toBe(O);
    expect(sessionRow(v.sessionId)).toMatchObject({ kind: 'orchestrator', account: O, state: 'idle', prompt_hash: hashOf('general') });
    const argv = argvOf(O, 1);
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(v.sessionId);
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(appendixOf('general'));
    // v2 §8 SA2 / D18: the orchestrator also skips permissions, with --add-dir and the stdio prompt tool kept
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--permission-mode');
    expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    expect(argv.slice(argv.indexOf('--add-dir') + 1, argv.indexOf('--add-dir') + 3)).toEqual([join(tmp, `cfg-${O}`, 'projects'), join(tmp, `cfg-${O}`, 'plans')]);
    expect(received(O, 1)).toEqual(['[cc-slaves] Bắt đầu điều phối. Gọi lanes_list rồi chờ tin PO.']);
    // v2.2 §5.1: the orchestrator's MCP file = its project's catalog set, strict; cc_slaves of the engine wins
    expect(argv.filter((x) => x === '--mcp-config')).toHaveLength(1);
    expect(argv.filter((x) => x === '--strict-mcp-config')).toHaveLength(1);
    const mcp = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1]!, 'utf8')).mcpServers;
    expect(mcp.user_srv.command).toBe('u-p1');
    expect(mcp.cc_slaves.url).toBe('http://127.0.0.1:1/mcp');
    // v2.2 §5.5: the orchestrator gets its own --settings file with the lane switches
    const settings = argv[argv.indexOf('--settings') + 1]!;
    expect(settings).toBe(paths().sessionSettings(v.sessionId));
    expect(JSON.parse(readFileSync(settings, 'utf8')).skillOverrides).toEqual({ 'h-ops': 'off' });
  });

  test('§8.4 run-N continues from the max on disk across boots (smoke g6: every boot appended into run-1.jsonl); ctx % from usage', async () => {
    const dir = dirname(paths().runLog('p1', '_orchestrator', 1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run-1.jsonl'), 'old\n');
    writeFileSync(join(dir, 'run-2.jsonl'), 'old\n');
    const usage: Step = { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake',
      usage: { input_tokens: 5, cache_creation_input_tokens: 15, cache_read_input_tokens: 59_980 }, content: [{ type: 'text', text: 'ok' }] } } };
    const { orchs } = setup({ scenario: () => ({ steps: [wait, usage, result('Xong.'), ...turns(2)] }) });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    expect(readFileSync(join(dir, 'run-1.jsonl'), 'utf8')).toBe('old\n');
    expect(readFileSync(join(dir, 'run-3.jsonl'), 'utf8')).toContain('"system"');
    expect(o.view().contextPct).toBe(30);
  });

  test('§4.4 N1-i the session\'s model (from its init) is on the view (Điều phối tooltip)', async () => {
    const { orchs } = setup({ scenario: () => ({ init: { model: 'claude-opus-5-5' }, steps: [wait, result('Xong.'), ...turns(2)] }) });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    expect(o.view().model).toBe('claude-opus-5-5');
  });

  test('§8.6 orchestrator results are recorded as result events → session cost (smoke g6: view showed $0)', async () => {
    const priced = (total: number, turn: number): Step => ({
      emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: total, permission_denials: [],
        model_usage_since_last_result: { 'claude-haiku': { costUSD: turn } } },
    });
    const { orchs } = setup({ scenario: () => ({ steps: [wait, assistant(), priced(0.0089, 0.0089), wait, assistant(), priced(0.0095, 0.0006), wait] }) });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    await o.send('[PO] lượt 2');
    await until(() => listEvents(db, o.view().sessionId, 'result').length === 2, 'two result events');
    expect(listEvents(db, o.view().sessionId, 'result')).toEqual([
      { run: 1, turnCost: 0.0089, totalCostUsd: 0.0089, isError: false, subtype: 'success', usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, account: 'o@x.test', fiveBefore: null, fiveAtBefore: null, fiveAfter: null, fiveAtAfter: null }, // §5.3 no usage in the fixture → 0s
      { run: 1, turnCost: 0.0006, totalCostUsd: 0.0095, isError: false, subtype: 'success', usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, account: 'o@x.test', fiveBefore: null, fiveAtBefore: null, fiveAfter: null, fiveAtAfter: null },
    ]);
    expect(sessionCost(db, o.view().sessionId)).toBeCloseTo(0.0095);
  });

  test('§7.5 over cap mid-turn → finishes the turn, then switches to a primary soft account with the §7.5 resume message', async () => {
    const { orchs } = setup({
      scenario: (e, n) => (e === O && n === 1 ? { steps: [wait, assistant(), rateLimit(0.99), sleep(400), assistant('vẫn chạy'), result(), wait] } : LOOP),
      accounts: [O, A, H, K],
    });
    fresh(H, 1);
    fresh(K, 1);
    await orchs.start('p1');
    await until(() => getQuota(db, O)?.fivePct === 99, 'rate limit applied');
    await Bun.sleep(150);
    expect(spawns.length).toBe(1); // mid-turn: no switch
    expect(orchState(orchs)).toBe('running');
    await until(() => spawn(A, 1) !== undefined && received(A, 1).length > 0, 'switch to A');
    expect(argvOf(A, 1)).toContain('--resume');
    expect(received(A, 1)[0]).toBe(RESUME(A));
    expect(spawns.map((s) => s.account)).toEqual([O, A]); // never the hard primary or the backup
    // the turn was allowed to finish: no interrupt was ever written to the session on O.
    expect(readFileSync(spawn(O, 1)!.stdin, 'utf8')).not.toContain('"subtype":"interrupt"');
    await reachO(orchs, 'idle');
  });

  test('§7.5 only a primary soft account: hard primary / backup only → waiting_quota', async () => {
    const { orchs } = setup({ scenario: () => LOOP, accounts: [O, H, K] });
    fresh(O, 99);
    fresh(H, 1);
    fresh(K, 1);
    await orchs.start('p1');
    await reachO(orchs, 'waiting_quota');
    expect(spawns.length).toBe(0);
  });

  test('§7.5 §6.16 home logged out → starts directly on the primary soft fallback (no auth-error spawn on home first)', async () => {
    const { orchs } = setup({ scenario: () => LOOP, loggedOut: new Set([O]) });
    fresh(O, 1);
    fresh(A, 1);
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    expect(o.view().account).toBe(A);
    expect(spawns.map((s) => s.account)).toEqual([A]);
  });

  test('§6.16 every usable account logged out → waiting_quota, nothing spawned', async () => {
    const { orchs } = setup({ scenario: () => LOOP, loggedOut: new Set([O, A]) });
    fresh(O, 1);
    fresh(A, 1);
    await orchs.start('p1');
    await reachO(orchs, 'waiting_quota');
    expect(spawns.length).toBe(0);
  });

  test('§7.5 plan blocks outright (rejected) mid-turn → interrupt and switch now', async () => {
    const { orchs } = setup({
      scenario: (e, n) => (e === O && n === 1
        ? { steps: [wait, assistant(), result(), wait, assistant(), rateLimit(1, 'rejected', 'five_hour'), { waitInterrupt: true }, stoppedResult, wait, assistant(), result('không được tới đây')] }
        : LOOP),
    });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    await o.send('[PO] làm tiếp');
    await until(() => received(A, 1).length > 0, 'switched to A mid-turn');
    expect(received(A, 1)[0]).toBe(RESUME(A));
    expect(o.view().account).toBe(A);
  });

  test('§7.1-3 T3 orchestrator !acct: the target account is removed while switching → waiting_quota, no account_logged_out, no wedge', async () => {
    const { orchs, events, accounts } = setup({
      scenario: (e, n) => (e === O && n === 1
        ? { steps: [wait, assistant(), result(), wait, assistant(), rateLimit(1, 'rejected', 'five_hour'), { waitInterrupt: true }, stoppedResult, wait] }
        : LOOP),
    });
    orchs.on((e) => {
      if (e.type === 'orchestrator' && e.orchestrator.state === 'switching') {
        const i = accounts.findIndex((a) => a.email === A);
        if (i >= 0) accounts.splice(i, 1);
      }
    });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    await o.send('[PO] làm tiếp');
    await reachO(orchs, 'waiting_quota');
    expect(spawns.map((s) => s.account)).toEqual([O]);
    expect(events.filter((e) => e.type === 'account_logged_out')).toEqual([]);
  });

  test('§7.5 returns home at the first turn boundary after home has room, never mid-turn', async () => {
    const { orchs } = setup({
      scenario: (e, n) => (e === A && n === 1 ? { steps: [wait, assistant(), result(), wait, assistant(), sleep(500), result('lượt 2'), wait] } : LOOP),
    });
    fresh(O, 99); // home over its 5h cap → start on the fallback
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    expect(o.view().account).toBe(A);
    await o.send('[PO] lượt 2');
    await until(() => orchState(orchs) === 'running', 'turn 2');
    fresh(O, 5);
    orchs.accountChanged(O);
    await Bun.sleep(200);
    expect(spawn(O, 1)).toBeUndefined(); // mid-turn: stays on A
    await until(() => received(O, 1).length > 0, 'back home');
    expect(argvOf(O, 1)).toContain('--resume');
    expect(received(O, 1)[0]).toBe(RESUME(O));
    expect(o.view().account).toBe(O);
  });

  test('§7.5 F11 abnormal death → one restart (resume); second → stopped + system_card; messages stay queued; restart() resumes', async () => {
    const { orchs, events } = setup({
      scenario: (_e, n) => (n === 1 ? { steps: [wait, assistant(), result(), wait, assistant(), die] }
        : n === 2 ? { steps: [wait, assistant(), die] } : LOOP),
    });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    await o.send('[PO] chạy đi');
    await reachO(orchs, 'stopped');
    expect(spawns.length).toBe(2);
    expect(argvOf(O, 2)).toContain('--resume');
    expect(received(O, 2)[0]).toBe(RESUME(O));
    const cards = events.filter((e) => e.type === 'system_card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: 'system_card', kind: 'orchestrator_down', projectId: 'p1', sessionId: o.view().sessionId });
    // §6A G5-fix the exit reason is keyed: card event + view carry it, vi catalog = the stored text
    const c0 = cards[0] as Extract<typeof cards[0], { type: 'system_card' }>;
    expect(c0.reasonKeyed?.key).toMatch(/^errors\.exit(Code|Signal)$/);
    expect(keyedText(makeT('vi'), c0.reasonKeyed)).toBe(c0.reason);
    expect(o.view().lastErrorKeyed).toEqual(c0.reasonKeyed ?? null);
    orchs.notify('p1', '[cc-slaves] lane D1 rảnh: xong');
    await Bun.sleep(100);
    expect(spawns.length).toBe(2);
    expect(listUndelivered(db, o.view().sessionId).map((m) => m.text)).toContain('[cc-slaves] lane D1 rảnh: xong');
    await o.restart();
    await reachO(orchs, 'idle');
    expect(received(O, 3)).toEqual([RESUME(O), '[cc-slaves] lane D1 rảnh: xong']);
  });

  test('§6.21 F21 newSession on a live session: handoff request, old closed, fresh session with the F21 first message', async () => {
    const { orchs } = setup({ scenario: () => LOOP });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    const old = o.view().sessionId;
    const r = await o.newSession();
    const path = `.local-check/handoff-${TODAY}/orchestrator.md`;
    expect(r.handoffPath).toBe(path);
    expect(received(O, 1)[1]).toStartWith(`[cc-slaves] Viết handoff vào ${path}`);
    expect(sessionRow(old)).toMatchObject({ state: 'done' });
    expect(sessionRow(old).ended_at).not.toBeNull();
    expect(r.sessionId).not.toBe(old);
    await reachO(orchs, 'idle');
    const argv = argvOf(O, 2);
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(r.sessionId);
    expect(argv).not.toContain('--resume');
    expect(received(O, 2)).toEqual([`[cc-slaves] Phiên điều phối mới. Đọc ${path} rồi \`lanes_list\` và tiếp tục.`]);
  });

  test('§6.21 F21 newSession(handoff) on a stopped session: no request, queued messages follow the F21 message', async () => {
    const { orchs } = setup({ scenario: (_e, n) => (n <= 2 ? { steps: [wait, assistant(), die] } : LOOP) });
    const o = await orchs.start('p1');
    await reachO(orchs, 'stopped');
    orchs.notify('p1', '[cc-slaves] lane D2 chờ PO #12');
    const r = await o.newSession('/h/x.md');
    await reachO(orchs, 'idle');
    expect(received(O, 3)).toEqual(['[cc-slaves] Phiên điều phối mới. Đọc /h/x.md rồi `lanes_list` và tiếp tục.', '[cc-slaves] lane D2 chờ PO #12']);
    expect(listUndelivered(db, r.sessionId)).toHaveLength(0);
  });

  test('§7.4 lane notices reach the orchestrator outbox: idle, phase done', async () => {
    const { orchs, m } = setup({ scenario: () => LOOP });
    await orchs.start('p1');
    await reachO(orchs, 'idle');
    const cwd = join(tmp, 'wt-D1');
    mkdirSync(cwd);
    await m.start({ projectId: 'p1', name: 'D1', cwd, briefPath: '/b/D1.md', account: A });
    await until(() => received(O, 1).includes('[cc-slaves] lane D1 rảnh: Xong lượt 1.'), 'idle notice');
    await m.setPhase('p1', 'D1', { phase: 'done', note: 'xong T3' });
    await until(() => received(O, 1).includes('[cc-slaves] lane D1 xong: xong T3'), 'done notice');
  });
});

describe('v2.5 §5.4 / §5.7 cwd + graph beside the token, at both spawn sites', () => {
  const graphIn = (sid: string) => JSON.parse(readFileSync(paths().mcpConfig(sid), 'utf8')).mcpServers['codebase-memory-mcp'] as { headers: { Authorization: string } } | undefined;
  test('graph on: the orchestrator spawn hands its cwd (project path) + graph, the lane spawn its worktree; the file has the entry for that token', async () => {
    const { orchs, m, spawned } = setup({ scenario: () => LOOP, graph: { on: true } });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    const cwd = join(tmp, 'wt-D1');
    mkdirSync(cwd);
    await m.start({ projectId: 'p1', name: 'D1', cwd, briefPath: '/b/D1.md', account: A });
    const lane = m.get('p1', 'D1')!.sessionId;
    await until(() => spawned.some((x) => x.sid === lane), 'lane spawn');
    const os = spawned.find((x) => x.sid === o.view().sessionId)!, ls = spawned.find((x) => x.sid === lane)!;
    expect([os.cwd, os.graph, ls.cwd, ls.graph]).toEqual([join(tmp, 'p1'), true, cwd, true]);
    for (const x of [os, ls]) expect(graphIn(x.sid)!.headers.Authorization).toBe(`Bearer ${x.token}`);
  });
  test('graph off (project switch): graph false beside the token, no entry in the file', async () => {
    const { orchs, spawned } = setup({ scenario: () => LOOP, graph: { on: false } });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    const sp = spawned.find((x) => x.sid === o.view().sessionId)!;
    expect([sp.cwd, sp.graph, graphIn(sp.sid)]).toEqual([join(tmp, 'p1'), false, undefined]);
  });
});

describe('appendix by prompt hash (§7.5, v2.9 §6.1)', () => {
  test('§7.5 resuming a session whose stored hash differs sends the update once and stores the new hash', async () => {
    const { orchs } = setup({ scenario: () => LOOP });
    insertSession(db, { id: 'so-old', projectId: 'p1', kind: 'orchestrator', account: O });
    db.query("UPDATE session SET prompt_hash = 'old', state = 'idle' WHERE id = 'so-old'").run();
    markDelivered(db, insertOutbox(db, { sessionId: 'so-old', text: 'tin đầu', prefix: '[cc-slaves]' }).uuid);
    const o = await orchs.restore({ id: 'so-old', project_id: 'p1', account: O, state: 'idle' });
    await reachO(orchs, 'idle');
    expect(received(O, 1)).toEqual([RESUME(O), `[cc-slaves] Cập nhật quy tắc điều phối: ${appendixOf('general')}`]);
    expect(sessionRow('so-old').prompt_hash).toBe(hashOf('general'));
    await o.restart();
    await reachO(orchs, 'idle');
    expect(received(O, 2)).toEqual([RESUME(O)]);
  });
});

describe('recover() at engine start (§7.1)', () => {
  test('§7.1 + hf1116 H1/H3 kills only an orphan with the session id, cancels permission cards, holds everything (0 spawns); unpause resumes and resends undelivered in order', async () => {
    const { m, orchs } = setup({ scenario: () => LOOP });
    // lane L1 was running on A when the engine died; two messages never got replayed.
    insertSession(db, { id: 'sl-1', projectId: 'p1', kind: 'lane', account: A });
    db.query("UPDATE session SET pid = 4242, state = 'running' WHERE id = 'sl-1'").run();
    mkdirSync(join(tmp, 'wt-L1'));
    insertLane(db, { projectId: 'p1', name: 'L1', cwd: join(tmp, 'wt-L1'), sessionId: 'sl-1', briefPath: '/b/L1.md', state: 'running' });
    markDelivered(db, insertOutbox(db, { sessionId: 'sl-1', text: 'brief', prefix: null }).uuid);
    insertOutbox(db, { sessionId: 'sl-1', text: 'm1', prefix: '[PO → L1]' });
    insertOutbox(db, { sessionId: 'sl-1', text: 'm2', prefix: '[Điều phối]' });
    // lane L2 idle with nothing pending → rebuilt, not respawned.
    insertSession(db, { id: 'sl-2', projectId: 'p1', kind: 'lane', account: A });
    db.query("UPDATE session SET pid = 4343, state = 'idle' WHERE id = 'sl-2'").run();
    mkdirSync(join(tmp, 'wt-L2'));
    insertLane(db, { projectId: 'p1', name: 'L2', cwd: join(tmp, 'wt-L2'), sessionId: 'sl-2', briefPath: '/b/L2.md', state: 'idle' });
    // orchestrator idle on O with one lane notice queued.
    insertSession(db, { id: 'so-1', projectId: 'p1', kind: 'orchestrator', account: O });
    db.query("UPDATE session SET pid = 4444, state = 'idle', prompt_hash = ? WHERE id = 'so-1'").run(hashOf('general'));
    markDelivered(db, insertOutbox(db, { sessionId: 'so-1', text: 'tin đầu', prefix: '[cc-slaves]' }).uuid);
    insertOutbox(db, { sessionId: 'so-1', text: '[cc-slaves] lane L1 rảnh: x', prefix: null });
    const card = (sid: string, kind: string) => db.query<{ id: number }, [string, string]>(
      "INSERT INTO card (session_id, kind, payload, created_at) VALUES (?, ?, '{}', 0) RETURNING id").get(sid, kind)!.id;
    const perm = card('sl-1', 'permission');
    const ask = card('sl-1', 'ask');

    const killed: number[] = [];
    const ps = async () => [
      { pid: 4242, command: `/usr/local/bin/claude -p --resume sl-1 --output-format stream-json` },
      { pid: 4343, command: '/Applications/Other.app/Contents/MacOS/Other' }, // pid reused by something else
      { pid: 9999, command: 'claude --resume so-1' }, // right id, wrong pid
    ];
    const s = await recover({ db, lanes: m, orchestrators: orchs, ps, kill: (p) => killed.push(p) });
    expect(killed).toEqual([4242]);
    expect(s.cancelledCards).toEqual([perm]);
    const status = (id: number) => db.query<{ status: string }, [number]>('SELECT status FROM card WHERE id = ?').get(id)!.status;
    expect(status(perm)).toBe('cancelled');
    expect(status(ask)).toBe('open');
    // hf1116 H1: nothing spawned, the busy lane and the orchestrator wait paused, the quiet lane stays idle; rows untouched
    await Bun.sleep(50);
    expect(spawns).toHaveLength(0);
    expect(s.held).toEqual(['p1']);
    expect(m.get('p1', 'L1')?.state).toBe('paused');
    expect(m.get('p1', 'L2')?.state).toBe('idle');
    expect(orchs.list('p1').map((o) => o.view().state)).toEqual(['paused']);
    expect(getLane(db, 'p1', 'L1')?.state).toBe('running');
    expect(db.query<{ state: string }, []>("SELECT state FROM session WHERE id = 'so-1'").get()!.state).toBe('idle');
    // hf1116 H3 resume = what recovery used to run
    m.unpause('p1');
    await orchs.unpause('p1');

    // the open ask card survives the restart → after its resumed turn the lane waits for the PO.
    await until(() => m.get('p1', 'L1')?.state === 'waiting_po', `L1 resumed: ${m.get('p1', 'L1')?.state}`);
    expect(m.get('p1', 'L1')?.openCards).toEqual([ask]);
    const l1 = spawns.find((x) => x.account === A)!;
    expect(argvOf(A, l1.n)).toContain('--resume');
    expect(received(A, l1.n)).toEqual([`[cc-slaves] ${LANE_RESUME_TEXT}`, '[PO → L1] m1', '[Điều phối] m2']);
    expect(m.get('p1', 'L2')?.state).toBe('idle');
    expect(spawns.filter((x) => x.account === A)).toHaveLength(1);

    await reachO(orchs, 'idle');
    // resume message first, then the queued notice; later lines are live notices from L1's resumed turns.
    expect(received(O, 1).slice(0, 2)).toEqual([RESUME(O), '[cc-slaves] lane L1 rảnh: x']);
    expect(s.lanes.map((l) => l.name).sort()).toEqual(['L1', 'L2']);
  });
});

describe('stopAll (§8.2)', () => {
  test('§8.2 every live lane gets the drain message with its handoff path and ends stopped after its turn', async () => {
    const { m } = setup({ scenario: () => LOOP, accounts: [A] });
    for (const n of ['D1', 'D2']) {
      const cwd = join(tmp, `wt-${n}`);
      mkdirSync(cwd);
      await m.start({ projectId: 'p1', name: n, cwd, briefPath: `/b/${n}.md` });
    }
    await until(() => m.list('p1').every((v) => v.state === 'idle'), 'both idle');
    const s = await stopAll(m, { projectId: 'p1' });
    expect(s.draining).toEqual(['p1/D1', 'p1/D2']);
    await until(() => m.list('p1').every((v) => v.state === 'stopped'), 'both stopped');
    // stopped is set before close_stdin finishes: wait for both processes to exit (their run rows end).
    await until(() => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM run WHERE ended_at IS NULL').get()!.n === 0, 'runs ended');
    for (const [i, n] of ['D1', 'D2'].entries()) {
      expect(received(A, i + 1)).toContain(drainText(n, TODAY));
    }
    expect(drainText('D1', TODAY)).toBe(`[cc-slaves] Dừng an toàn: không nhận task mới, xong task đang chạy, commit, viết handoff \`.local-check/handoff-${TODAY}/D1.md\` rồi báo xong (\`lane_set_phase\` với note 'đã dừng an toàn').`);
  });
});

describe('limit result marking (g2-t3 concern 2)', () => {
  test('a limit `result` marks the account rejected → a waiting lane does not re-pick it', async () => {
    const { m } = setup({ scenario: () => ({ steps: [wait, limitResult, wait] }), accounts: [A] });
    const cwd = join(tmp, 'wt-D1');
    mkdirSync(cwd);
    await m.start({ projectId: 'p1', name: 'D1', cwd, briefPath: '/b/D1.md' });
    await until(() => m.get('p1', 'D1')?.state === 'waiting_quota', 'waiting_quota');
    expect(getQuota(db, A)?.status).toBe('rejected');
    m.accountChanged('someone@else');
    await Bun.sleep(300);
    expect(spawns).toHaveLength(1);
    expect(m.get('p1', 'D1')?.state).toBe('waiting_quota');
  });
});

describe('orchestrator ↔ cards (g2-review IMPORTANT-4/6, MINOR-3)', () => {
  const PERM = resolve(import.meta.dir, '../../fake-claude/scenarios/permission-request.json');

  test('§3.3-13 IMPORTANT-4 an orchestrator permission request → card → allow reaches its process → turn ends', async () => {
    const { orchs, cards } = setup({ scenario: () => JSON.parse(readFileSync(PERM, 'utf8')) as object });
    const o = await orchs.start('p1');
    await until(() => cards.list({ status: 'open' }).some((c) => c.kind === 'permission'), 'permission card');
    const c = cards.list({ status: 'open' }).find((x) => x.kind === 'permission')!;
    expect(c).toMatchObject({ sessionId: o.view().sessionId, projectId: 'p1' });
    expect((c.payload as { title: string }).title).toStartWith('Điều phối xin chạy:');
    await cards.answer(c.id, { behavior: 'allow' });
    await reachO(orchs, 'idle');
    expect(cards.get(c.id)!.status).toBe('answered');
  });

  test('§7.7 IMPORTANT-4 po_ask answer to an idle orchestrator is written at once (not left in the outbox)', async () => {
    const { orchs, cards } = setup({ scenario: () => LOOP });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    const sid = o.view().sessionId;
    const ask = cards.ask({ projectId: 'p1', sessionId: sid, source: 'Điều phối', question: 'Gộp?', options: [{ label: 'Có' }, { label: 'Không' }] });
    await cards.answer(ask.id, { option: 'Có' });
    await until(() => received(O, 1).includes(`[cc-slaves] PO trả lời #${ask.id}: Có`), 'answer written');
    await reachO(orchs, 'idle');
    expect(listUndelivered(db, sid)).toEqual([]);
  });

  test('§6.11 F11 IMPORTANT-6 two deaths → open "Điều phối P1 ngừng" card; restart → idle → card resolved', async () => {
    const { orchs, cards } = setup({ scenario: (_e, n) => (n <= 2 ? { steps: [wait, assistant(), die] } : LOOP) });
    const o = await orchs.start('p1');
    await reachO(orchs, 'stopped');
    const c = cards.list({ status: 'open' }).find((x) => x.kind === 'orchestrator_down')!;
    expect(c).toMatchObject({ projectId: 'p1', payload: { title: 'Điều phối P1 ngừng' } });
    expect((c.payload as SystemPayload).actions.map((a) => a.action)).toEqual(['restart_orchestrator', 'new_orchestrator']);
    await o.restart();
    await reachO(orchs, 'idle');
    expect(cards.get(c.id)!.status).toBe('answered');
  });

  test('MINOR-3 F21 newSession ends the old session: its MCP config + v2.2 §5.5 settings file are deleted and onSessionEnded fires', async () => {
    const { orchs, ended } = setup({ scenario: () => LOOP });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    const old = o.view().sessionId;
    expect([existsSync(paths().mcpConfig(old)), existsSync(paths().sessionSettings(old))]).toEqual([true, true]);
    await o.newSession();
    expect([existsSync(paths().mcpConfig(old)), existsSync(paths().sessionSettings(old))]).toEqual([false, false]);
    expect(ended).toEqual([old]);
  });
});

describe('talkingTo (v1.1 §5.2)', () => {
  const toolUse = (tool: string, input: Record<string, unknown>): Step => ({
    emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake',
      content: [{ type: 'tool_use', id: `tu-${tool}`, name: `mcp__cc_slaves__${tool}`, input }] } },
  });
  const talk = (events: OrchestratorEvent[]) =>
    events.flatMap((e) => (e.type === 'orchestrator' ? [e.orchestrator.talkingTo] : []));

  test('v1.1 §5.2 set on a tool call with `name`; same name / tool without `name` → no new event; `result` → null', async () => {
    const steps = [wait, assistant(), result(), wait,
      toolUse('lane_message', { name: 'D2', text: 'hi' }), sleep(50),
      toolUse('lane_tail', { name: 'D2', n: 5 }), sleep(50),
      toolUse('lanes_list', {}), sleep(150), result('Xong lượt 2.'), ...turns(2)];
    const { orchs, events } = setup({ scenario: () => ({ steps }) });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    expect(o.view().talkingTo).toBeNull();
    const from = events.length;
    await o.send('[PO] nhắn D2');
    await until(() => o.view().talkingTo === 'D2', 'talkingTo D2');
    await Bun.sleep(150); // lane_tail (same name) + lanes_list (no name) arrive while still D2
    expect(o.view().talkingTo).toBe('D2');
    await reachO(orchs, 'idle');
    expect(o.view().talkingTo).toBeNull();
    const seq = talk(events.slice(from));
    expect(seq.filter((t) => t === 'D2')).toHaveLength(1);
    expect(seq.at(-1)).toBeNull();
  });

  test('v1.1 §5.2 the session exits mid-turn → null (no later `result` clears it: the restart dies too → stopped)', async () => {
    const { orchs, events } = setup({
      scenario: (_e, n) => (n === 1 ? { steps: [wait, assistant(), result(), wait, toolUse('lane_start', { name: 'B1', cwd: '/w' }), sleep(150), die] }
        : { steps: [wait, die] }),
    });
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    await o.send('[PO] mở B1');
    await until(() => o.view().talkingTo === 'B1', 'talkingTo B1');
    await reachO(orchs, 'stopped');
    expect(spawns.length).toBe(2);
    expect(o.view().talkingTo).toBeNull();
    const seq = talk(events);
    expect(seq.filter((t) => t === 'B1')).toHaveLength(1);
    expect(seq.at(-1)).toBeNull();
  });

});

describe('orchestrator behind the v2.6 update gate (§5.4)', () => {
  let opened: () => void = () => {};
  const held = () => new UpdateGate(() => opened());

  test('§5.4-3 a boot while held: starting, no claude; release → it spawns, gets its first message, idles', async () => {
    const gate = held();
    const { orchs } = setup({ scenario: () => LOOP, gate });
    opened = () => { for (const o of orchs.all()) o.writesOpened(); };
    gate.hold(true);
    await orchs.start('p1');
    await Bun.sleep(150);
    expect(orchState(orchs)).toBe('starting');
    expect(spawns).toEqual([]);
    gate.hold(false);
    await reachO(orchs, 'idle');
    expect(received(O, 1).length).toBe(1);
  });

  test('§5.4-1 an idle orchestrator while held: a PO message waits (state idle); release → written, the turn runs', async () => {
    const gate = held();
    const { orchs } = setup({ scenario: () => LOOP, gate });
    opened = () => { for (const o of orchs.all()) o.writesOpened(); };
    await orchs.start('p1');
    await reachO(orchs, 'idle');
    gate.hold(true);
    await orchs.get('p1')!.send('việc mới', '[PO]');
    await Bun.sleep(200);
    expect(orchState(orchs)).toBe('idle');
    expect(received(O, 1).length).toBe(1);
    gate.hold(false);
    await until(() => received(O, 1).length === 2, 'PO message written');
    expect(received(O, 1)[1]).toBe('[PO] việc mới');
    await reachO(orchs, 'idle');
  });

  test('§5.4-3 a quiet session that quit, messaged while held: starting, no claude; release → one resume gets both messages', async () => {
    const gate = held();
    const { orchs } = setup({ scenario: (_e, n) => (n === 1 ? { steps: [wait, assistant(), result(), { exit: 0 }] } : LOOP), gate });
    opened = () => { for (const o of orchs.all()) o.writesOpened(); };
    await orchs.start('p1');
    await until(() => orchs.get('p1')!.view().state === 'idle' && orchs.get('p1')!.turnStartedAt === null && spawns.length === 1, 'first turn');
    await Bun.sleep(200); // the quiet exit
    gate.hold(true);
    await orchs.get('p1')!.send('một', '[PO]');
    expect(orchState(orchs)).toBe('starting');
    await orchs.get('p1')!.send('hai', '[PO]');
    await Bun.sleep(150);
    expect(spawns.length).toBe(1);
    gate.hold(false);
    await until(() => received(O, 2).includes('[PO] hai'), 'resumed with both');
    expect(spawns.length).toBe(2);
  });

  test('v26-rv IMPORTANT-1 "Phiên mới" while held: release writes the handoff request at once (not behind the close job)', async () => {
    const gate = held();
    const { orchs } = setup({ scenario: () => LOOP, gate, handoffTimeoutMs: 4000 });
    opened = () => { for (const o of orchs.all()) o.writesOpened(); };
    const o = await orchs.start('p1');
    await reachO(orchs, 'idle');
    gate.hold(true);
    const t0 = Date.now();
    const done = o.newSession();
    await Bun.sleep(300);
    expect(received(O, 1).length).toBe(1);
    gate.hold(false);
    const r = await done;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(received(O, 1)[1]).toStartWith(`[cc-slaves] Viết handoff vào ${r.handoffPath}`);
  });
});
