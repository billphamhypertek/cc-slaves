import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { keyedText, makeT } from '../../shared/i18n/index.ts';
import { PICK_REASON_KEY } from '../src/accounts/picker.ts';
import { LANE_RESUME_TEXT } from '../src/lane/manager/types.ts';
import { t } from '../../shared/i18n/index.ts';
import { listEvents, listRuns } from './_db.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account } from '../src/accounts/registry.ts';
import { QuotaTracker } from '../src/accounts/quota.ts';
import type { Caps } from '../src/config.ts';
import { getLane, insertProject, listUndelivered, openDb, upsertQuota, type Db, type LaneState } from '../src/db.ts';
import { LaneError, LaneManager, type LaneManagerDeps, type LaneUiEvent, type LaneView, type Timers } from '../src/lane/manager.ts';
import { appendixOf, hashOf } from '../test/_fixtures/po-pack.ts';
import { Outbox } from '../src/outbox.ts';
import { UpdateGate } from '../src/update/commit.ts';
import { paths } from '../src/paths.ts';
import { rejects } from '../test/_fixtures/rejects.ts';

setDefaultTimeout(20_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const A = 'a@x.test';
const B = 'b@x.test';
const C = 'c@x.test';
const CAPS: Caps = { default: { week: 98, five: 95 } };
const SAVED = process.env.CC_SLAVES_HOME;
const FUTURE5 = 4102444800;
const FUTURE7 = 4103049600;

// ---------- scenario building blocks ----------
type Step = Record<string, unknown>;
const assistant = (text = 'Đang làm…'): Step => ({
  emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] } },
});
const result = (text = 'Xong.', cost = 0.01, total = cost): Step => ({
  emit: { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: total,
    permission_denials: [], model_usage_since_last_result: { 'claude-fake': { costUSD: cost } } },
});
const limitResult: Step = {
  emit: { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm", num_turns: 1, permission_denials: [] },
};
const rateLimit = (five: number, status = 'allowed_warning'): Step => ({
  emit: { type: 'rate_limit_event', rate_limit_info: { status, resetsAt: FUTURE5, unifiedWindows: {
    five_hour: { utilization: five, resetsAt: FUTURE5 }, seven_day: { utilization: 0.3, resetsAt: FUTURE7 } } } },
});
const wait: Step = { waitUser: true };
/** n turns: wait for a user line, answer, result. */
const turns = (n: number, cost = 0.01): Step[] =>
  Array.from({ length: n }, (_, i) => [wait, assistant(), result(`Xong lượt ${i + 1}.`, cost, cost * (i + 1))]).flat();
const LOOP = { steps: turns(6) };

let tmp: string;
let db: Db;
let mgr: LaneManager | null;
let spawns: { account: string; n: number; trace: string; stdin: string }[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-lm-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  db = openDb(join(tmp, 'state.db'));
  insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1') });
  spawns = [];
  mgr = null;
});
afterEach(async () => {
  await mgr?.shutdown();
  db.close();
  if (SAVED === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = SAVED;
  rmSync(tmp, { recursive: true, force: true });
});

const account = (email: string): Account => ({
  email, id: null, configDir: join(tmp, `cfg-${email}`), keychainService: `k-${email}`, planTier: 'max', terminal: false,
});

class ManualTimers implements Timers {
  pending: { fn: () => void; ms: number; done: boolean }[] = [];
  set(fn: () => void, ms: number) { const t = { fn, ms, done: false }; this.pending.push(t); return t; }
  clear(h: unknown) { (h as { done: boolean }).done = true; }
  fire() { const t = this.pending.find((p) => !p.done); if (!t) throw new Error('no timer'); t.done = true; t.fn(); return t.ms; }
}

interface Setup {
  scenario: (email: string, n: number) => object;
  accounts?: string[];
  timers?: Timers;
  config?: { maxLanes: number; maxLanesPerAccount: number; laneCaps?: Record<string, number> };
  initTimeoutMs?: number;
  closeGraceMs?: number;
  loggedOut?: Set<string>;
  caps?: Caps;
  beforeSpawn?: (configDir: string) => boolean | void;
  /** T3: what the registry returns now (default: every account). */
  accountsNow?: (all: Account[]) => Account[];
  /** T3: runs at each pick (the loggedOut read is the pick's last input). */
  onPick?: () => void;
  /** v2.6 §5.4 the update gate. */
  gate?: UpdateGate;
}
/** v2.7 §5.3 the issue hook calls the manager made, in order. */
let hookCalls: string[] = [];

function setup(o: Setup) {
  const accounts = (o.accounts ?? [A, B]).map(account);
  const notes: string[] = [];
  const ended: string[] = [];
  const counts = new Map<string, number>();
  const tracker: QuotaTracker = new QuotaTracker({
    db, source: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    onAccountChanged: (e) => m.accountChanged(e),
  });
  const deps: LaneManagerDeps = {
    db, outbox: new Outbox(db), accounts: () => (o.accountsNow ? o.accountsNow(accounts) : accounts), quota: tracker, caps: () => o.caps ?? CAPS,
    loggedOut: () => { o.onPick?.(); return o.loggedOut ?? new Set(); },
    config: () => o.config ?? { maxLanes: 8, maxLanesPerAccount: 3 },
    command: ['bun', FAKE], mcpPort: 1,
    env: (a) => {
      const n = (counts.get(a.email) ?? 0) + 1;
      counts.set(a.email, n);
      const file = join(tmp, `scn-${a.email}-${n}.json`);
      writeFileSync(file, JSON.stringify(o.scenario(a.email, n)));
      const trace = join(tmp, `trace-${a.email}-${n}.json`);
      const stdin = join(tmp, `stdin-${a.email}-${n}.jsonl`);
      spawns.push({ account: a.email, n, trace, stdin });
      return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_TRACE: trace, FAKE_CLAUDE_STDIN_LOG: stdin };
    },
    notify: (_p, t) => notes.push(t),
    onSessionEnded: (sid) => ended.push(sid),
    issues: {
      laneIdle: (l) => hookCalls.push(`idle ${l.name}`), laneBroken: (l) => hookCalls.push(`broken ${l.name}`),
      laneEnded: (l, why) => hookCalls.push(`ended ${l.name} ${why}`),
    },
    timers: o.timers,
    session: { initTimeoutMs: o.initTimeoutMs ?? 5000, interruptTimeoutMs: 300, sleep: async () => {}, ps: async () => [], ...(o.beforeSpawn ? { beforeSpawn: o.beforeSpawn } : {}) },
    closeGraceMs: o.closeGraceMs ?? 300,
    ...(o.gate ? { gate: o.gate } : {}),
  };
  const m = new LaneManager(deps);
  mgr = m;
  hookCalls = [];
  const events: LaneUiEvent[] = [];
  m.on((e) => events.push(e));
  return { m, notes, tracker, ended, events, accounts };
}

let laneNo = 0;
function startArgs(name: string, extra: Record<string, unknown> = {}) {
  const cwd = join(tmp, `wt-${name}-${++laneNo}`);
  mkdirSync(cwd, { recursive: true });
  return { projectId: 'p1', name, cwd, briefPath: `/briefs/${name}.md`, ...extra };
}

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}
const stateOf = (m: LaneManager, name: string) => m.get('p1', name)?.state;
const reach = (m: LaneManager, name: string, s: LaneState) => until(() => stateOf(m, name) === s, `${name} ${s} (now ${stateOf(m, name)})`);
const argvOf = (trace: string): string[] => (JSON.parse(readFileSync(trace, 'utf8')) as { argv: string[] }).argv;
const traceOf = (email: string, n: number) => spawns.find((s) => s.account === email && s.n === n)!.trace;
/** User message texts a fake process received, in order. */
const received = (email: string, n: number): string[] => {
  const f = spawns.find((s) => s.account === email && s.n === n)?.stdin;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: string } })
    .filter((l) => l.type === 'user').map((l) => l.message!.content);
};
const flagOf = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];
const BRIEF = '[Điều phối] Đọc brief /briefs/D1.md và làm theo.';
const inUse = { steps: [{ stderr: 'Error: Session ID ${session} is already in use.\n' }, { exit: 1 }] };
const noConversation = { steps: [{ stderr: 'No conversation found with session ID: ${session}\n' }, { exit: 1 }] };

describe('LaneManager (§7.4)', () => {
  test('§7.4 start → idle → message → idle, notify, cost = max total_cost_usd, turn cost on event rows (§8.6)', async () => {
    const { m, notes } = setup({ scenario: () => LOOP });
    const v = await m.start(startArgs('D1'));
    expect(v.account).toBe(A);
    await reach(m, 'D1', 'idle');
    expect(notes).toContain('[cc-slaves] lane D1 rảnh: Xong lượt 1.');
    await m.message('p1', 'D1', 'làm tiếp', 'orchestrator');
    await until(() => notes.includes('[cc-slaves] lane D1 rảnh: Xong lượt 2.'), 'second idle');
    expect(stateOf(m, 'D1')).toBe('idle');
    const lane = getLane(db, 'p1', 'D1')!;
    expect(lane.state).toBe('idle');
    expect(lane.costUsd).toBeCloseTo(0.02);
    expect(listEvents(db, lane.sessionId!, 'result').map((e) => (e as { turnCost: number }).turnCost)).toEqual([0.01, 0.01]);
    expect(listUndelivered(db, lane.sessionId!)).toEqual([]);
    expect(argvOf(traceOf(A, 1))).toContain('--session-id');
    expect(m.result('p1', 'D1')).toBe('Xong lượt 2.');
    expect(m.tail('p1', 'D1', 2).length).toBe(2);
  });

  test('IMPORTANT-4 §5.5 a flagged pre-spawn check aborts that spawn (claude never runs on it) and the lane re-picks another account', async () => {
    const checked: string[] = [];
    const { m } = setup({ scenario: () => LOOP, beforeSpawn: (d) => { checked.push(d); return !d.endsWith(`cfg-${A}`); } });
    await m.start(startArgs('D1', { account: A }));
    await until(() => m.get('p1', 'D1')?.account === B && stateOf(m, 'D1') === 'idle', 'idle on B');
    expect(spawns.map((s) => s.account)).toEqual([B]); // env() runs at Bun.spawn: A was never spawned
    expect(checked).toEqual([join(tmp, `cfg-${A}`), join(tmp, `cfg-${B}`)]);
    expect(listRuns(db, getLane(db, 'p1', 'D1')!.id).map((r) => [r.account, r.endReason ?? null])).toEqual([[A, 'selfcheck:shared_cfg'], [B, null]]);
  });

  test('§3.4 rate-limit over cap → switch to another account, resume with the replay of undelivered messages', async () => {
    const { m } = setup({
      scenario: (e) => e === A
        ? { replay: 'manual', steps: [wait, { flushReplay: true }, assistant(), wait, rateLimit(0.97), { sleep: 3000 }] }
        : LOOP,
    });
    await m.start(startArgs('D1', { account: A }));
    await until(() => (m.get('p1', 'D1')?.sawAssistant ?? false) && stateOf(m, 'D1') === 'running', 'assistant seen');
    await m.message('p1', 'D1', 'tin giữa lượt', 'po');
    await until(() => m.get('p1', 'D1')?.account === B && stateOf(m, 'D1') === 'idle', 'idle on B');
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(argvOf(traceOf(B, 1))).toEqual(expect.arrayContaining(['--resume', sid]));
    expect(listUndelivered(db, sid)).toEqual([]);
    expect(listRuns(db, getLane(db, 'p1', 'D1')!.id).map((r) => r.account)).toEqual([A, B]);
  });

  test('§7.4 IMPORTANT-1 limit error result after the brief was replayed → switch with --resume (conversation exists)', async () => {
    const { m } = setup({ scenario: (e) => (e === A ? { steps: [wait, limitResult] } : LOOP) });
    await m.start(startArgs('D1', { account: A }));
    await until(() => m.get('p1', 'D1')?.account === B && stateOf(m, 'D1') === 'idle', 'idle on B');
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(argvOf(traceOf(B, 1))).toEqual(expect.arrayContaining(['--resume', sid]));
    expect(received(B, 1)).toEqual([`[cc-slaves] ${LANE_RESUME_TEXT}`]);
    expect(m.get('p1', 'D1')!.failCount).toBe(0);
  });

  test('§7.4 IMPORTANT-1/3 brief written but never replayed, fresh start hits "already in use" → one --resume retry', async () => {
    const { m } = setup({ scenario: (e, n) => (e === A ? { replay: 'manual', steps: [wait, limitResult] } : n <= 3 ? inUse : LOOP) });
    await m.start(startArgs('D1', { account: A }));
    await until(() => m.get('p1', 'D1')?.account === B && stateOf(m, 'D1') === 'idle', `idle on B (now ${stateOf(m, 'D1')})`);
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(argvOf(traceOf(B, 1))).toEqual(expect.arrayContaining(['--session-id', sid]));
    expect(argvOf(traceOf(B, 4))).toEqual(expect.arrayContaining(['--resume', sid]));
    expect(received(B, 4)).toEqual([`[cc-slaves] ${LANE_RESUME_TEXT}`, BRIEF]); // the unreplayed brief still goes out
    expect(listUndelivered(db, sid)).toEqual([]);
  });

  test('§7.4 IMPORTANT-1/2 "No conversation found" on --resume → fresh, same id, brief first then the pending message', async () => {
    const { m } = setup({ scenario: (_e, n) => (n === 1 ? { steps: [wait, assistant(), result('xong 1'), { exit: 0 }] } : n === 2 ? noConversation : LOOP), accounts: [A] });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    await until(() => !m.alive('p1', 'D1'), 'self exit');
    await m.message('p1', 'D1', 'tin sau khi thoát', 'po');
    await until(() => m.result('p1', 'D1') === 'Xong lượt 2.' && stateOf(m, 'D1') === 'idle', `fresh run answered (now ${stateOf(m, 'D1')})`);
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(argvOf(traceOf(A, 2))).toEqual(expect.arrayContaining(['--resume', sid]));
    expect(argvOf(traceOf(A, 3))).toEqual(expect.arrayContaining(['--session-id', sid]));
    expect(received(A, 3)).toEqual([BRIEF, '[PO] tin sau khi thoát']);
    expect(listUndelivered(db, sid)).toEqual([]);
  });

  test('§5.3 W10 a turn cut short keeps its tokens: the next process\'s result adds on top (cumulative across processes)', async () => {
    const timers = new ManualTimers();
    const used = (id: string, input: number): Step => ({ emit: { type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input } } } });
    const exact: Step = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, permission_denials: [], usage: { input_tokens: 1 } } };
    const { m } = setup({ scenario: (_e, n) => (n === 1 ? { steps: [wait, used('a', 10), { sleep: 50 }, { die: {} }] } : { steps: [wait, used('b', 1), exact, ...turns(3)] }), accounts: [A], timers });
    await m.start(startArgs('D1'));
    await until(() => m.get('p1', 'D1')?.tokens.input === 10, 'provisional 10 from the first process');
    await until(() => timers.pending.some((t) => !t.done), 'retry scheduled');
    timers.fire();
    await reach(m, 'D1', 'idle');
    expect(m.get('p1', 'D1')!.tokens).toEqual({ input: 11, output: 0, cacheWrite: 0, cacheRead: 0 });
  });

  test('§7.4 IMPORTANT-3 brief written to a process that died before replaying it → the fresh retry sends it again', async () => {
    const timers = new ManualTimers();
    const { m } = setup({ scenario: (_e, n) => (n === 1 ? { replay: 'manual', steps: [wait, { sleep: 50 }, { die: {} }] } : LOOP), accounts: [A], timers });
    await m.start(startArgs('D1'));
    await until(() => timers.pending.some((t) => !t.done), 'retry scheduled');
    timers.fire();
    await reach(m, 'D1', 'idle');
    expect(spawns.length).toBe(2);
    expect(argvOf(traceOf(A, 2))).toContain('--session-id');
    expect(received(A, 2)).toEqual([BRIEF]);
  });

  test('§7.5 IMPORTANT-5 lane appendix + prompt hash (v2.9 §6.1); resume text has the git / index.lock step; a changed text sent once', async () => {
    const { m } = setup({ scenario: (_e, n) => (n === 1 ? { steps: [wait, assistant(), result('xong 1'), { exit: 0 }] } : LOOP), accounts: [A] });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(flagOf(argvOf(traceOf(A, 1)), '--append-system-prompt')).toBe(appendixOf('lane'));
    // v2 §8 SA2 / D18: lane argv skips permissions, keeps --add-dir <acct>/projects <acct>/plans and the stdio prompt tool
    const la = argvOf(traceOf(A, 1));
    expect(la).toContain('--dangerously-skip-permissions');
    expect(la).not.toContain('--permission-mode');
    expect(flagOf(la, '--permission-prompt-tool')).toBe('stdio');
    const ad = la.indexOf('--add-dir');
    expect(la.slice(ad + 1, ad + 3)).toEqual([join(tmp, `cfg-${A}`, 'projects'), join(tmp, `cfg-${A}`, 'plans')]);
    const pv = () => db.query<{ v: string | null }, [string]>('SELECT prompt_hash AS v FROM session WHERE id = ?').get(sid)!.v;
    expect(pv()).toBe(hashOf('lane'));
    expect(LANE_RESUME_TEXT).toContain('git status');
    expect(LANE_RESUME_TEXT).toContain('.git/index.lock');
    await until(() => !m.alive('p1', 'D1'), 'self exit');
    db.query("UPDATE session SET prompt_hash = 'old' WHERE id = ?").run(sid);
    await m.message('p1', 'D1', 'tiếp', 'po');
    await until(() => m.result('p1', 'D1') === 'Xong lượt 3.' && stateOf(m, 'D1') === 'idle', `resumed (now ${stateOf(m, 'D1')})`);
    expect(received(A, 2)).toEqual([
      `[cc-slaves] ${LANE_RESUME_TEXT}`,
      `[cc-slaves] Cập nhật quy tắc điều phối: ${appendixOf('lane')}`,
      '[PO] tiếp',
    ]);
    expect(pv()).toBe(hashOf('lane'));
  });

  test('§6.17 a good start reports the claude version (F17 input)', async () => {
    const { m, events } = setup({ scenario: () => LOOP });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    expect(events.find((e) => e.type === 'claude_version')).toMatchObject({ type: 'claude_version', ok: true, version: expect.any(String) });
  });

  test('MINOR-2 shutdown awaits a process detached by close_stdin (its run row is ended before shutdown resolves)', async () => {
    const { m } = setup({ scenario: () => ({ steps: [wait, assistant(), result('xong 1'), { sleep: 3000 }] }), accounts: [A], closeGraceMs: 5000 });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    const laneId = getLane(db, 'p1', 'D1')!.id;
    void m.finish('p1', 'D1').catch(() => {});
    await until(() => stateOf(m, 'D1') === 'done', 'done');
    await m.shutdown();
    expect(listRuns(db, laneId).every((r) => r.endedAt !== null)).toBe(true);
  });

  test('MINOR-3 a finished lane: MCP config file deleted and onSessionEnded fired (token revoked)', async () => {
    const { m, ended } = setup({ scenario: () => LOOP, accounts: [A] });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(existsSync(paths().mcpConfig(sid))).toBe(true);
    await m.finish('p1', 'D1');
    expect(existsSync(paths().mcpConfig(sid))).toBe(false);
    expect(ended).toEqual([sid]);
  });

  test('§7.4 all full → waiting_quota → quota_freed → resumes on the freed account', async () => {
    const { m } = setup({ scenario: (e) => (e === A ? { steps: [wait, limitResult] } : LOOP) });
    const now = Math.floor(Date.now() / 1000);
    upsertQuota(db, { account: B, fivePct: 10, weekPct: 99.5, fiveResetsAt: FUTURE5, weekResetsAt: FUTURE7, source: 'api', fetchedAt: now, status: 'ok' });
    await m.start(startArgs('D1', { account: A }));
    await reach(m, 'D1', 'waiting_quota');
    upsertQuota(db, { account: A, fivePct: 100, weekPct: 50, fiveResetsAt: FUTURE5, weekResetsAt: FUTURE7, source: 'api', fetchedAt: now, status: 'rejected' });
    upsertQuota(db, { account: B, fivePct: 10, weekPct: 20, fiveResetsAt: FUTURE5, weekResetsAt: FUTURE7, source: 'api', fetchedAt: now, status: 'ok' });
    m.accountChanged(B);
    await reach(m, 'D1', 'idle');
    expect(m.get('p1', 'D1')!.account).toBe(B);
  });

  test('§7.4 3 abnormal deaths → broken; retries wait 20 s then 60 s (fake timers)', async () => {
    const timers = new ManualTimers();
    const die = { steps: [wait, assistant(), { sleep: 30 }, { die: {} }] };
    const { m, notes } = setup({ scenario: () => die, timers });
    await m.start(startArgs('D1', { account: A }));
    await until(() => timers.pending.some((t) => !t.done), 'retry 1 scheduled');
    expect(m.get('p1', 'D1')!.failCount).toBe(1);
    expect(timers.fire()).toBe(20_000);
    await until(() => timers.pending.filter((t) => !t.done).length === 1 && m.get('p1', 'D1')!.failCount === 2, 'retry 2 scheduled');
    expect(timers.fire()).toBe(60_000);
    await reach(m, 'D1', 'broken');
    expect(m.get('p1', 'D1')!.failCount).toBe(3);
    expect(getLane(db, 'p1', 'D1')!.state).toBe('broken');
    expect(notes.some((t) => t.includes('hỏng sau 3 lỗi'))).toBe(true);
    expect(hookCalls).toEqual(['broken D1']); // v2.7 §5.3 the held issue's "kẹt ở lane hỏng", once, never a release
    await m.finish('p1', 'D1', true);
    expect(hookCalls).toEqual(['broken D1', 'ended D1 hỏng rồi kết thúc']);
    // §6A G5-fix the exit reason is keyed beside the vi text, in the view and in state.db (survives a restart)
    const lv = m.get('p1', 'D1')!;
    expect(lv.lastErrorKeyed?.key).toMatch(/^errors\.exit(Code|Signal)$/);
    expect(keyedText(makeT('vi'), lv.lastErrorKeyed)).toBe(lv.lastError);
    expect(getLane(db, 'p1', 'D1')!.lastErrorKeyed).toEqual(lv.lastErrorKeyed);
    expect(argvOf(traceOf(A, 2))).toContain('--resume');
  });

  test('§7.4 stop drain: drain message → result → stopped (stdin closed)', async () => {
    const { m } = setup({ scenario: () => LOOP });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    await m.stop('p1', 'D1', 'drain');
    expect(['draining', 'stopped']).toContain(stateOf(m, 'D1')!);
    await reach(m, 'D1', 'stopped');
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(listUndelivered(db, sid)).toEqual([]);
    expect(m.alive('p1', 'D1')).toBe(false);
  });

  test('§7.4 stop now while running → killed → stopped', async () => {
    const { m } = setup({ scenario: () => ({ steps: [wait, assistant(), { sleep: 10_000 }] }) });
    await m.start(startArgs('D1'));
    await until(() => m.get('p1', 'D1')?.sawAssistant === true, 'running');
    await m.stop('p1', 'D1', 'now');
    expect(stateOf(m, 'D1')).toBe('stopped');
    await until(() => !m.alive('p1', 'D1'), 'process gone');
  });

  test('§7.4 finish: running → error lane_running; idle → done, cwd freed', async () => {
    const { m } = setup({ scenario: () => ({ steps: [wait, assistant(), { sleep: 400 }, result(), wait] }) });
    const a = startArgs('D1');
    await m.start(a);
    await until(() => m.get('p1', 'D1')?.sawAssistant === true, 'running');
    await rejects(m.finish('p1', 'D1')).toMatchObject({ code: 'lane_running' });
    await reach(m, 'D1', 'idle');
    await m.finish('p1', 'D1');
    expect(stateOf(m, 'D1')).toBe('done');
    await until(() => !m.alive('p1', 'D1'), 'process gone');
    await m.start({ ...a, name: 'D2' }); // same cwd is free again
  });

  test('ruling: process exits by itself while idle → no error; next message respawns with --resume and is delivered', async () => {
    const { m } = setup({ scenario: (_e, n) => (n === 1 ? { steps: [wait, assistant(), result('xong 1'), { exit: 0 }] } : LOOP) });
    await m.start(startArgs('D1', { account: A }));
    await reach(m, 'D1', 'idle');
    await until(() => !m.alive('p1', 'D1'), 'self exit');
    await Bun.sleep(50);
    expect(stateOf(m, 'D1')).toBe('idle');
    expect(m.get('p1', 'D1')!.failCount).toBe(0);
    await m.message('p1', 'D1', 'tin sau khi thoát', 'po');
    await until(() => spawns.length === 2, 'respawn');
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(argvOf(traceOf(A, 2))).toEqual(expect.arrayContaining(['--resume', sid]));
    await until(() => m.result('p1', 'D1') === 'Xong lượt 2.' && stateOf(m, 'D1') === 'idle', 'resume line + message answered');
    expect(listUndelivered(db, sid)).toEqual([]);
  });

  test('ruling: self-check fails after init → stopped, not a run error; lane_resume uses --resume', async () => {
    const bad = { init: { mcp_servers: [{ name: 'cc_slaves', status: 'failed', source: 'dynamic' }] }, steps: [wait] };
    const { m } = setup({ scenario: (_e, n) => (n === 1 ? bad : LOOP), accounts: [A] });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'stopped');
    expect(m.get('p1', 'D1')!.failCount).toBe(0);
    expect(m.get('p1', 'D1')!.lastError).toContain('cc_slaves');
    await m.resume('p1', 'D1');
    await reach(m, 'D1', 'idle');
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(argvOf(traceOf(A, 2))).toEqual(expect.arrayContaining(['--resume', sid]));
  });

  test('ruling: self-check fails before init → lane_resume runs fresh with the same session id', async () => {
    // nothing replayed (no message of ours delivered) → no conversation → fresh
    const { m } = setup({ scenario: (_e, n) => (n === 1 ? { init: false, replay: 'manual', steps: [wait] } : LOOP), accounts: [A], initTimeoutMs: 300 });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'stopped');
    await m.resume('p1', 'D1');
    await reach(m, 'D1', 'idle');
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    expect(argvOf(traceOf(A, 2))).toEqual(expect.arrayContaining(['--session-id', sid]));
  });

  test('ruling §3.3-20: assistant while idle with nothing awaiting replay → running (self-started turn) → idle again', async () => {
    const { m, notes } = setup({ scenario: () => JSON.parse(readFileSync(resolve(import.meta.dir, '../../fake-claude/scenarios/self-started-turn.json'), 'utf8')) as object });
    const states: LaneState[] = [];
    const views: LaneView[] = [];
    m.on((e) => { if (e.type === 'lane') { states.push(e.lane.state); views.push(e.lane); } });
    await m.start(startArgs('D1'));
    await until(() => notes.includes('[cc-slaves] lane D1 rảnh: Việc nền đã xong.'), 'self-started turn result');
    const firstIdle = states.indexOf('idle');
    expect(states.slice(firstIdle)).toContain('running');
    expect(stateOf(m, 'D1')).toBe('idle');
    // the self-started turn has a start time while it runs (UnitPanel "lượt đang chạy")
    expect(views.slice(firstIdle).find((v) => v.state === 'running')?.turnStartedAt).toEqual(expect.any(Number));
    expect(m.get('p1', 'D1')!.turnStartedAt).toBeNull();
  });

  test('UnitPanel turnStartedAt set when a message is written, cleared on result; contextPct from the last assistant usage ([1m] → 1M window)', async () => {
    const usage = (tokens: number): Step => ({ emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake',
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] } } });
    const { m } = setup({ scenario: () => ({ init: { model: 'claude-fake[1m]' }, steps: [wait, usage(100_000), result(), wait, { sleep: 1100 }, usage(250_000), result()] }) });
    const views: LaneView[] = [];
    const atAssistant: (number | null)[] = [];
    m.on((e) => {
      if (e.type === 'lane') views.push(e.lane);
      if (e.type === 'stream' && e.event.kind === 'assistant') atAssistant.push(m.get('p1', 'D1')!.turnStartedAt);
    });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    expect(m.get('p1', 'D1')).toMatchObject({ turnStartedAt: null, contextPct: 10 });
    const before = Date.now();
    const firstTurnViews = views.length;
    await m.message('p1', 'D1', 'tiếp', 'orchestrator');
    const t = m.get('p1', 'D1')!.turnStartedAt;
    expect(t).toBeGreaterThanOrEqual(before); // §5.3 epoch ms (web: now − turnStartedAt)
    expect(t).toBeLessThanOrEqual(Date.now());
    await until(() => m.get('p1', 'D1')!.contextPct === 25, 'second turn usage');
    await reach(m, 'D1', 'idle');
    expect(m.get('p1', 'D1')!.turnStartedAt).toBeNull();
    expect(atAssistant.at(-1)).toBe(t); // an assistant message > 1 s later keeps the turn's start
    // the view the UnitPanel receives for the message-started turn carries its start (not only a later re-render)
    expect(views.slice(firstTurnViews).filter((v) => v.state === 'running').map((v) => v.turnStartedAt)).toContain(t);
  });

  test('ruling §3.3-20: assistant while a written message awaits replay is not a self-started turn', async () => {
    const { m } = setup({ scenario: () => ({ replay: 'manual', steps: [wait, { flushReplay: true }, assistant(), result('xong 1'), { sleep: 100 }, assistant('tự chạy?'), { sleep: 4000 }] }) });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    const sid = getLane(db, 'p1', 'D1')!.sessionId!;
    new Outbox(db).enqueue(sid, 'chờ phát lại', null); // undelivered message of ours
    await Bun.sleep(400);
    expect(stateOf(m, 'D1')).toBe('idle');
  });

  test('§7.7 lane_interrupt: the interrupted turn ends quiet, no error counted', async () => {
    const stopped: Step = { emit: { type: 'result', subtype: 'error_during_execution', is_error: true, result: '', num_turns: 1, permission_denials: [] } };
    const { m } = setup({ scenario: () => ({ steps: [wait, assistant(), { waitInterrupt: true }, stopped, wait] }) });
    await m.start(startArgs('D1'));
    await until(() => m.get('p1', 'D1')?.sawAssistant === true, 'running');
    await m.interrupt('p1', 'D1');
    await reach(m, 'D1', 'idle');
    expect(m.get('p1', 'D1')!.failCount).toBe(0);
    await rejects(m.interrupt('p1', 'D1')).toMatchObject({ code: 'not_running' });
  });

  test('§3.4 I3 one rate_limit_event on account X switches both lanes on X', async () => {
    const long = { sleep: 4000 };
    const { m } = setup({
      scenario: (e, n) => (e !== A ? LOOP : n === 1 ? { steps: [wait, assistant(), long] } : { steps: [wait, assistant(), rateLimit(0.97), long] }),
      accounts: [A, B],
    });
    await m.start(startArgs('D1', { account: A }));
    await until(() => m.get('p1', 'D1')?.sawAssistant === true, 'D1 running');
    await m.start(startArgs('D2', { account: A }));
    await until(() => m.get('p1', 'D1')?.account === B && m.get('p1', 'D2')?.account === B, 'both on B', 10_000);
    await reach(m, 'D1', 'idle');
    await reach(m, 'D2', 'idle');
  });

  test('§7.4 duplicate name / live cwd rejected; account validation gives a reason', async () => {
    const { m } = setup({ scenario: () => LOOP });
    const a = startArgs('D1');
    await m.start(a);
    mkdirSync(join(tmp, 'other'));
    await rejects(m.start({ ...a, cwd: join(tmp, 'other') })).toBeInstanceOf(LaneError);
    await rejects(m.start({ ...a, name: 'D9' })).toMatchObject({ code: 'cwd_in_use' });
    await rejects(m.start(startArgs('D3', { account: 'nobody@x.test' }))).toMatchObject({ code: 'bad_account' });
  });

  test('§7.7 §6.16 lane_start on an explicit logged-out account → bad_account with a Vietnamese reason; auto-pick skips it', async () => {
    const out = new Set([A]);
    const { m } = setup({ scenario: () => LOOP, loggedOut: out });
    await rejects(m.start(startArgs('D1', { account: A }))).toMatchObject({ code: 'bad_account', message: `${A} đã đăng xuất — Cài đặt › Account › Đăng nhập lại` });
    expect((await m.start(startArgs('D2'))).account).toBe(B);
    out.add(B);
    await rejects(m.start(startArgs('D3'))).toMatchObject({ code: 'no_account', message: t('vi', PICK_REASON_KEY.logged_out) });
    out.clear(); // login back → usable again
    expect((await m.start(startArgs('D4', { account: A }))).account).toBe(A);
    expect(spawns.map((s) => s.account)).toEqual([B, A]);
  });

  test('§6 rev 2.1 N4 pickForStart: the only usable account is the orchestrator → lanes run on it (pinned and auto); ≥ 2 usable → refused / skipped', async () => {
    const caps = { default: { week: 98, five: 95 }, [A]: { role: 'orchestrator', week: 99 } } as Caps;
    const one = setup({ scenario: () => LOOP, accounts: [A], caps });
    expect((await one.m.start(startArgs('D1', { account: A }))).account).toBe(A);
    expect((await one.m.start(startArgs('D2'))).account).toBe(A);
    await one.m.shutdown();
    const two = setup({ scenario: () => LOOP, accounts: [A, B], caps });
    await rejects(two.m.start(startArgs('D3', { account: A }))).toMatchObject({ code: 'bad_account', message: `${A} là account Điều phối, số lane tối đa 0 — không chạy lane` });
    expect((await two.m.start(startArgs('D4'))).account).toBe(B);
  });

  test('D26 pickForStart: the orchestrator account with max lanes > 0 runs a pinned lane; 0 → refused', async () => {
    const caps = { default: { week: 98, five: 95 }, [A]: { role: 'orchestrator', week: 99 } } as Caps;
    const on = setup({ scenario: () => LOOP, accounts: [A, B], caps, config: { maxLanes: 8, maxLanesPerAccount: 3, laneCaps: { [A]: 1 } } });
    expect((await on.m.start(startArgs('D1', { account: A }))).account).toBe(A);
    await on.m.shutdown();
    const off = setup({ scenario: () => LOOP, accounts: [A, B], caps, config: { maxLanes: 8, maxLanesPerAccount: 3, laneCaps: { [A]: 0 } } });
    await rejects(off.m.start(startArgs('D2', { account: A }))).toMatchObject({ code: 'bad_account' });
  });

  test('§7.1-3 cutover: no usable account → a lane that was running waits (waiting_quota, no_account), no error; the first account → resumes there with --resume', async () => {
    const first = setup({ scenario: () => LOOP, accounts: [A] });
    await first.m.start(startArgs('D1'));
    await reach(first.m, 'D1', 'idle');
    await first.m.shutdown();
    db.query("UPDATE lane SET state = 'running' WHERE name = 'D1'").run(); // the v1 engine died mid-turn
    const v2 = setup({ scenario: () => LOOP, accounts: [] }); // A has no `dir` in the registry: not usable
    v2.m.restore(getLane(db, 'p1', 'D1')!, A);
    await reach(v2.m, 'D1', 'waiting_quota');
    expect(v2.m.get('p1', 'D1')).toMatchObject({ waitReason: 'no_account', lastError: null, failCount: 0 });
    v2.accounts.push(account(B)); // a v2 account logged in (no email pin: any usable account)
    v2.m.accountChanged(B);
    await reach(v2.m, 'D1', 'idle');
    expect(v2.m.get('p1', 'D1')).toMatchObject({ account: B, waitReason: null, lastError: null });
    expect(argvOf(traceOf(B, 1))).toContain('--resume');
  });

  test('§7.1-3 cutover: a quiet lane whose account is not usable → the next message waits (no_account), no error', async () => {
    const first = setup({ scenario: () => LOOP, accounts: [A] });
    await first.m.start(startArgs('D1'));
    await reach(first.m, 'D1', 'idle');
    await first.m.shutdown();
    const v2 = setup({ scenario: () => LOOP, accounts: [] });
    v2.m.restore(getLane(db, 'p1', 'D1')!, A);
    await v2.m.message('p1', 'D1', 'tiếp đi', 'po');
    await reach(v2.m, 'D1', 'waiting_quota');
    expect(v2.m.get('p1', 'D1')).toMatchObject({ waitReason: 'no_account', lastError: null, failCount: 0 });
  });

  test('§7.1-3 T3 spawn !acct: the picked account leaves the registry before spawn → the lane waits (no_account), no lastError, no card', async () => {
    let gone = false;
    let armed = true;
    const { m, events } = setup({
      scenario: () => LOOP, accounts: [A],
      accountsNow: (all) => (gone ? [] : all),
      onPick: () => { if (armed) { armed = false; gone = true; } }, // the pick saw A; the registry loses it right after
    });
    expect((await m.start(startArgs('D1'))).account).toBe(A);
    await reach(m, 'D1', 'waiting_quota');
    expect(m.get('p1', 'D1')).toMatchObject({ waitReason: 'no_account', lastError: null, failCount: 0 });
    expect(spawns).toEqual([]); // never spawned on the vanished account
    expect(events.filter((e) => e.type === 'account_logged_out')).toEqual([]); // no "đã đăng xuất" card for it
    expect(events.some((e) => e.type === 'lane' && e.lane.state === 'broken')).toBe(false);
  });

  test('§7.4 machine max and per-account lane count enforced at start', async () => {
    const { m } = setup({ scenario: () => LOOP, accounts: [A, B, C], config: { maxLanes: 2, maxLanesPerAccount: 1 } });
    await m.start(startArgs('D1', { account: A }));
    await rejects(m.start(startArgs('D2', { account: A }))).toMatchObject({ code: 'bad_account' });
    expect((await m.start(startArgs('D2'))).account).not.toBe(A);
    await rejects(m.start(startArgs('D3'))).toMatchObject({ code: 'machine_full' });
    expect(existsSync(join(tmp, 'home'))).toBe(true);
  });

  test('§7.4 lane_set_phase done → park + notify text; process stays', async () => {
    const { m, notes } = setup({ scenario: () => LOOP });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    await m.setPhase('p1', 'D1', { phase: 'done', note: 'xong T3' });
    expect(notes).toContain('[cc-slaves] lane D1 xong: xong T3');
    expect(getLane(db, 'p1', 'D1')!.phase).toBe('done');
    expect(m.alive('p1', 'D1')).toBe(true);
  });
});

describe('LaneManager behind the v2.6 update gate (§5.4)', () => {
  test('§5.4-3 lane_start while held: state starting, no claude, not busy (R11); release → it spawns and runs the brief', async () => {
    const gate = new UpdateGate(() => mgr!.writesOpened());
    const { m } = setup({ scenario: () => LOOP, gate });
    gate.hold(true);
    await m.start(startArgs('D1'));
    await Bun.sleep(150);
    expect(stateOf(m, 'D1')).toBe('starting');
    expect(spawns).toEqual([]);
    expect(gate.spawning()).toEqual([]);
    gate.hold(false);
    await reach(m, 'D1', 'idle');
    expect(received(A, 1)).toEqual([BRIEF]);
  });

  test('§5.4-1 an idle lane while held: the message waits in the outbox; release → written, the turn runs', async () => {
    const gate = new UpdateGate(() => mgr!.writesOpened());
    const { m, notes } = setup({ scenario: () => LOOP, gate });
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    gate.hold(true);
    await m.message('p1', 'D1', 'làm tiếp', 'orchestrator');
    await Bun.sleep(200);
    expect(received(A, 1)).toEqual([BRIEF]);
    expect(listUndelivered(db, getLane(db, 'p1', 'D1')!.sessionId!).map((r) => r.text)).toEqual(['[Điều phối] làm tiếp']);
    gate.hold(false);
    await until(() => notes.includes('[cc-slaves] lane D1 rảnh: Xong lượt 2.'), 'second turn');
    expect(received(A, 1)).toEqual([BRIEF, '[Điều phối] làm tiếp']);
  });

  test('§5.4-3 a spawn deferred by the hold is dropped when the lane is stopped meanwhile', async () => {
    const gate = new UpdateGate(() => mgr!.writesOpened());
    const { m } = setup({ scenario: () => LOOP, gate });
    gate.hold(true);
    await m.start(startArgs('D1'));
    await m.stop('p1', 'D1', 'now');
    const after = stateOf(m, 'D1');
    gate.hold(false);
    await Bun.sleep(300);
    expect(spawns).toEqual([]);
    expect(stateOf(m, 'D1')).toBe(after);
  });
});
