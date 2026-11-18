// v2.1 §4.14 part A with fake-claude: parallel orchestrator sessions (cap 3, stopped included), lane ownership + MCP owner
// checks, reassign, end a session (lanes kept, outbox moves, asks expire), per-session "Điều phối ngừng" card, stopAll by
// session, history of one session, migration ownership, remote gate. Temp homes; never real quota or the Keychain.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account } from '../src/accounts/registry.ts';
import { QuotaTracker } from '../src/accounts/quota.ts';
import type { Caps } from '../src/config.ts';
import { getLane, insertLane, insertProject, listUndelivered, openDb, sessionTokens, upsertQuota, type Db } from '../src/db.ts';
import { LaneManager, type LaneManagerDeps } from '../src/lane/manager.ts';
import { stopAll } from '../src/lane/stop-all.ts';
import { callTool, findTool } from '../src/mcp/tools.ts';
import type { ToolDeps } from '../src/mcp/tool-kit.ts';
import { Orchestrators, type OrchestratorDeps, type OrchestratorEvent } from '../src/orchestrator/session.ts';
import { ownerOf, seqOf } from '../src/orchestrator/owners.ts';
import { Outbox, PREFIX } from '../src/outbox.ts';
import { CardStore, type SystemPayload } from '../src/cards/store.ts';
import { attachLaneCards, attachOrchestratorCards, attachSystemCards, laneCardSessions, orchestratorCardSessions } from '../src/cards/wire.ts';
import { ALL_COMMANDS, route, type Handlers } from '../src/server/router.ts';
import { REMOTE_ALLOWED, type OrchestratorView, type SessionsList, type StreamLine } from '../../shared/protocol.ts';
import { act } from '../src/cards/store.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { delivers, type Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';
import { rejects } from '../test/_fixtures/rejects.ts';
import { ModelCache } from '../src/models.ts';
import { issuePorts } from '../test/_fixtures/issue-ports.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test'; // project orchestrator account
const A = 'a@x.test'; // primary soft
const B = 'b@x.test'; // primary soft
const CAPS: Caps = {
  default: { week: 98, five: 95 },
  [O]: { role: 'orchestrator', week: 99, five: 97 },
  [A]: { role: 'primary', week: 99 },
  [B]: { role: 'primary', week: 99 },
};
const SAVED = process.env.CC_SLAVES_HOME;
const FUTURE5 = 4102444800;
const FUTURE7 = 4103049600;
const TODAY = new Date().toISOString().slice(0, 10);

type Step = Record<string, unknown>;
const assistant = (text = 'Đang làm…'): Step => ({
  emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] } },
});
const result = (text = 'Xong.'): Step => ({
  emit: { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.01, permission_denials: [] },
});
const wait: Step = { waitUser: true };
const die: Step = { die: {} };
const turns = (n: number): Step[] => Array.from({ length: n }, (_, i) => [wait, assistant(), result(`Xong lượt ${i + 1}.`)]).flat();
const LOOP = { steps: turns(8) };
/** Every turn takes 300 ms: a `session_end` handoff stays open long enough for a second command to overlap it. */
const SLOW = { steps: Array.from({ length: 8 }, (_, i) => [wait, { sleep: 300 }, assistant(), result(`Xong lượt ${i + 1}.`)]).flat() };

let tmp: string;
let db: Db;
let spawns: { account: string; n: number; trace: string; stdin: string }[];
let closers: (() => Promise<void>)[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-sess-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  db = openDb(join(tmp, 'state.db'));
  mkdirSync(join(tmp, 'p1'), { recursive: true });
  insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1'), orchestratorAccount: O });
  spawns = [];
  closers = [];
  const now = Math.floor(Date.now() / 1000);
  for (const a of [O, A, B]) upsertQuota(db, { account: a, fivePct: 10, weekPct: 10, fiveResetsAt: FUTURE5, weekResetsAt: FUTURE7, source: 'api', fetchedAt: now, status: 'ok' });
});
afterEach(async () => {
  for (const c of closers) await c();
  db.close();
  if (SAVED === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = SAVED;
  rmSync(tmp, { recursive: true, force: true });
});

const account = (email: string): Account => ({ email, id: null, configDir: join(tmp, `cfg-${email}`), keychainService: `k-${email}`, planTier: 'max', terminal: false });

function setup(scenario: (email: string, n: number) => object = () => LOOP) {
  const accounts = [O, A, B].map(account);
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
    writeFileSync(file, JSON.stringify(scenario(a.email, n)));
    const trace = join(tmp, `trace-${a.email}-${n}.json`);
    const stdin = join(tmp, `stdin-${a.email}-${n}.jsonl`);
    spawns.push({ account: a.email, n, trace, stdin });
    return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_TRACE: trace, FAKE_CLAUDE_STDIN_LOG: stdin };
  };
  const ended: string[] = [];
  const od: OrchestratorDeps = {
    onSessionEnded: (sid) => ended.push(sid), db, outbox, accounts: () => accounts, quota: tracker, caps: () => CAPS,
    command: ['bun', FAKE], mcpPort: 1, env, session: { initTimeoutMs: 5000, interruptTimeoutMs: 500 }, closeGraceMs: 300, handoffTimeoutMs: 5000, modelCache: new ModelCache(),
  };
  orchs = new Orchestrators(od);
  orchs.on((e) => events.push(e));
  const ld: LaneManagerDeps = {
    db, outbox, accounts: () => accounts, quota: tracker, caps: () => CAPS, config: () => ({ maxLanes: 8, maxLanesPerAccount: 3 }),
    command: ['bun', FAKE], mcpPort: 1, env, notify: (p, t, lane) => orchs.notify(p, t, lane),
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 300 }, closeGraceMs: 300,
  };
  m = new LaneManager(ld);
  const cards = new CardStore({ db, sessions: laneCardSessions(m, outbox, orchestratorCardSessions(orchs, outbox)) });
  attachLaneCards(cards, m);
  attachOrchestratorCards(cards, orchs);
  attachSystemCards(cards, db, { lanes: m, orchestrators: orchs });
  closers.push(async () => cards.shutdown(), () => orchs.shutdown(), () => m.shutdown());
  const tools: ToolDeps = {
    lanes: m, cards, usage: () => [], notify: () => {}, worktreeExists: () => true, owners: orchs.ownerPort(), issues: issuePorts(db),
  };
  const call = (sessionId: string, tool: string, args: object) =>
    callTool(tools, { sessionId, role: 'orchestrator', projectId: 'p1', cwd: '/w', graph: false }, findTool(tool)!, args);
  return { m, orchs, events, outbox, cards, ended, call };
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}
const spawn = (email: string, n: number) => spawns.find((s) => s.account === email && s.n === n);
const received = (email: string, n: number): string[] => {
  const f = spawn(email, n)?.stdin;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: string } })
    .filter((l) => l.type === 'user').map((l) => l.message!.content);
};
const stateOf = (orchs: Orchestrators, sid: string) => orchs.bySession(sid)?.view().state;
const reach = (orchs: Orchestrators, sid: string, s: string) => until(() => stateOf(orchs, sid) === s, `${sid} ${s} (now ${stateOf(orchs, sid)})`);
const sessionRow = (id: string) => db.query<{ seq: number | null; title: string | null; state: string; ended_at: number | null; end_reason: string | null; handoff_path: string | null }, [string]>(
  'SELECT seq, title, state, ended_at, end_reason, handoff_path FROM session WHERE id = ?').get(id)!;
const laneRow = (name: string, owner: string) => insertLane(db, { projectId: 'p1', name, cwd: join(tmp, `wt-${name}`), ownerSession: owner, state: 'idle' });
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe('§4.14 parallel sessions', () => {
  test('§4.14 open #2 in parallel → two processes, #2 numbered 2, default first message, lands on another account', async () => {
    const { orchs } = setup();
    const o1 = await orchs.start('p1');
    const s1 = o1.currentSessionId;
    await reach(orchs, s1, 'idle');
    const o2 = await orchs.open('p1', {});
    const s2 = o2.currentSessionId;
    await reach(orchs, s2, 'idle');
    expect(orchs.list('p1').map((o) => o.currentSessionId)).toEqual([s1, s2]);
    expect(sessionRow(s1).seq).toBe(1);
    expect(sessionRow(s2).seq).toBe(2);
    expect(o2.view().account).not.toBe(O); // §4.14 an account orchestrating another session ranks after
    expect(received(o2.view().account!, 1)[0]).toBe('[cc-slaves] Phiên song song #2 của P1. Gọi `lanes_list`; chỉ ra lệnh lane của mình.');
    expect(spawns.filter((s) => s.account === O)).toHaveLength(1);
  });

  test('§4.14 title: typed wins; empty → first 24 chars of the first message, which is sent as is', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    const o2 = await orchs.open('p1', { title: 'hotfix' });
    const o3 = await orchs.open('p1', { first: 'Sửa lỗi thanh toán ở trang giỏ hàng' });
    expect(sessionRow(o2.currentSessionId).title).toBe('hotfix');
    expect(sessionRow(o3.currentSessionId).title).toBe('Sửa lỗi thanh toán ở tra');
    await reach(orchs, o3.currentSessionId, 'idle');
    const acct = o3.view().account!;
    const n = spawns.filter((s) => s.account === acct).length;
    expect(received(acct, n)[0]).toBe('[cc-slaves] Sửa lỗi thanh toán ở trang giỏ hàng');
  });

  test('§4.14 + v2.7 R34 the first Chung is not counted: 3 more parallel sessions, then refused with the cap text; nothing spawned', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    await orchs.open('p1', {});
    await orchs.open('p1', {});
    await orchs.open('p1', {});
    const before = spawns.length;
    await rejects(orchs.open('p1', {})).toThrow('Đã đủ 3 phiên Thiết kế / Build — đóng bớt một phiên');
    expect(spawns.length).toBe(before);
    expect(orchs.list('p1')).toHaveLength(4);
  });

  test('§4.14 F11 #2 dies → card orchestrator:<#2>; #1 idle does not close it; no auto-end; still counts toward 3', async () => {
    const { orchs, cards } = setup((email) => (email === A ? { steps: [wait, assistant(), die] } : LOOP));
    const o1 = await orchs.start('p1');
    const s1 = o1.currentSessionId;
    await reach(orchs, s1, 'idle');
    const o2 = await orchs.open('p1', { account: A });
    const s2 = o2.currentSessionId;
    await reach(orchs, s2, 'stopped');
    const down = () => cards.list({ status: 'open' }).filter((c) => c.kind === 'orchestrator_down');
    expect(down()).toHaveLength(1);
    const c = down()[0]!;
    expect((c.payload as SystemPayload).key).toBe(`orchestrator:${s2}`);
    expect(c.sessionId).toBe(s2);
    expect(c.payload).toMatchObject({ title: 'Điều phối #2 ngừng' });
    expect((c.payload as SystemPayload).actions.map((a) => [a.action, (a.args as { sessionId?: string } | undefined)?.sessionId]))
      .toEqual([['restart_orchestrator', s2], ['new_orchestrator', s2]]);
    await o1.send('[PO] chạy tiếp');
    await reach(orchs, s1, 'running');
    await reach(orchs, s1, 'idle');
    expect(cards.get(c.id)!.status).toBe('open');
    await Bun.sleep(300);
    expect(sessionRow(s2).ended_at).toBeNull();
    expect(stateOf(orchs, s2)).toBe('stopped');
    await orchs.open('p1', {});
    await orchs.open('p1', {}); // v2.7 R34 the first Chung is free: the stopped #2 + 2 more = 3 counted
    await rejects(orchs.open('p1', {})).toThrow('Đã đủ 3 phiên');
  });

  test('§4.14 restore keeps every unended session (keyed by session id, not project)', async () => {
    const first = setup();
    const o1 = await first.orchs.start('p1');
    const o2 = await first.orchs.open('p1', {});
    await reach(first.orchs, o2.currentSessionId, 'idle');
    await first.orchs.shutdown();
    const second = setup();
    const rows = db.query<{ id: string; project_id: string; account: string | null; state: string; prompt_hash: string | null }, []>(
      "SELECT id, project_id, account, state, prompt_hash FROM session WHERE kind = 'orchestrator' AND ended_at IS NULL ORDER BY created_at, rowid").all();
    for (const r of rows) await second.orchs.restore(r);
    expect(second.orchs.list('p1').map((o) => o.currentSessionId)).toEqual([o1.currentSessionId, o2.currentSessionId]);
  });
});

describe('§4.14 lane ownership (MCP)', () => {
  test('§4.14 lane_start by #2 → lane owned by #2; lanes_list shows every lane with its owner', async () => {
    const { orchs, call, m } = setup();
    const s1 = (await orchs.start('p1')).currentSessionId;
    const s2 = (await orchs.open('p1', {})).currentSessionId;
    m.restore(laneRow('D1', s1), null);
    const cwd = join(tmp, 'wt-D2');
    mkdirSync(cwd);
    const r = await call(s2, 'lane_start', { name: 'D2', cwd, brief_path: '/b/D2.md', account: B });
    expect(r.isError).toBeUndefined();
    expect(ownerOf(db, 'p1', 'D2')).toEqual({ sessionId: s2, seq: 2 });
    const list = JSON.parse(text(await call(s2, 'lanes_list', {}))) as { lanes: { name: string; owner: number | null; mine: boolean }[] };
    expect(list.lanes.map((l) => [l.name, l.owner, l.mine])).toEqual([['D1', 1, false], ['D2', 2, true]]);
  });

  test('§4.14 command tools on another session\'s lane → "D1 thuộc #1; nhờ PO chuyển"; read tools allowed', async () => {
    const { orchs, call, m } = setup();
    const s1 = (await orchs.start('p1')).currentSessionId;
    const s2 = (await orchs.open('p1', {})).currentSessionId;
    m.restore(laneRow('D1', s1), null);
    for (const [tool, args] of [
      ['lane_message', { name: 'D1', text: 'x' }], ['lane_interrupt', { name: 'D1' }], ['lane_stop', { name: 'D1', mode: 'drain' }],
      ['lane_resume', { name: 'D1' }], ['lane_finish', { name: 'D1' }], ['lane_set_phase', { name: 'D1', phase: 'code' }],
    ] as const) {
      const r = await call(s2, tool, args);
      expect([tool, r.isError, text(r)]).toEqual([tool, true, 'D1 thuộc #1; nhờ PO chuyển']);
    }
    expect((await call(s2, 'lane_tail', { name: 'D1' })).isError).toBeUndefined();
    expect(text(await call(s1, 'lane_message', { name: 'D1', text: 'x' }))).not.toContain('thuộc #');
  });

  test('§4.14 duplicate lane name across sessions → "Tên D1 đã có (thuộc #1)"', async () => {
    const { orchs, call, m } = setup();
    const s1 = (await orchs.start('p1')).currentSessionId;
    const s2 = (await orchs.open('p1', {})).currentSessionId;
    m.restore(laneRow('D1', s1), null);
    const r = await call(s2, 'lane_start', { name: 'D1', cwd: join(tmp, 'other'), brief_path: '/b.md' });
    expect([r.isError, text(r)]).toEqual([true, 'Tên D1 đã có (thuộc #1)']);
  });

  test('§4.14 lane events go to the owner session only', async () => {
    const { orchs, m, call } = setup();
    const o1 = await orchs.start('p1');
    const o2 = await orchs.open('p1', {});
    await reach(orchs, o1.currentSessionId, 'idle');
    await reach(orchs, o2.currentSessionId, 'idle');
    const cwd = join(tmp, 'wt-D3');
    mkdirSync(cwd);
    await call(o2.currentSessionId, 'lane_start', { name: 'D3', cwd, brief_path: '/b/D3.md', account: B });
    const a2 = o2.view().account!;
    await until(() => received(a2, 1).includes('[cc-slaves] lane D3 rảnh: Xong lượt 1.'), 'idle notice to #2');
    expect(received(O, 1).some((t) => t.includes('lane D3'))).toBe(false);
    expect(m.get('p1', 'D3')).not.toBeNull();
  });
});

describe('§4.14 reassign and end', () => {
  test('§4.14 lane_reassign: owner moves, one message to the old and one to the new owner, events follow the new owner', async () => {
    const { orchs, m, call } = setup();
    const o1 = await orchs.start('p1');
    const s1 = o1.currentSessionId;
    const o2 = await orchs.open('p1', {});
    const s2 = o2.currentSessionId;
    await reach(orchs, s1, 'idle');
    await reach(orchs, s2, 'idle');
    const cwd = join(tmp, 'wt-D4');
    mkdirSync(cwd);
    await call(s1, 'lane_start', { name: 'D4', cwd, brief_path: '/b/D4.md', account: B });
    await until(() => received(O, 1).includes('[cc-slaves] lane D4 rảnh: Xong lượt 1.'), 'idle notice to #1');
    const r = await orchs.reassign('p1', 'D4', s2);
    expect(r).toEqual({ name: 'D4', from: s1, to: s2 });
    expect(ownerOf(db, 'p1', 'D4')?.sessionId).toBe(s2);
    const a2 = o2.view().account!;
    await until(() => received(O, 1).some((t) => t.startsWith('[cc-slaves] PO chuyển lane D4 sang phiên #2')), 'old owner told');
    await until(() => received(a2, 1).some((t) => t.startsWith('[cc-slaves] PO chuyển lane D4 từ phiên #1')), 'new owner told');
    expect((await call(s1, 'lane_message', { name: 'D4', text: 'x' })).isError).toBe(true);
    await m.message('p1', 'D4', 'thêm việc', 'po');
    await until(() => received(a2, 1).includes('[cc-slaves] lane D4 rảnh: Xong lượt 2.'), 'event to new owner');
    expect(received(O, 1).includes('[cc-slaves] lane D4 rảnh: Xong lượt 2.')).toBe(false);
    await rejects(orchs.reassign('p1', 'D4', 'nope')).toThrow();
  });

  test('§4.14 end a stopped #2: no handoff, lanes not stopped, owner = receiver, unsent outbox moves, its asks expire', async () => {
    const { orchs, cards, ended, events } = setup((email) => (email === A ? { steps: [wait, assistant(), die] } : LOOP));
    const o1 = await orchs.start('p1');
    const s1 = o1.currentSessionId;
    await reach(orchs, s1, 'idle');
    const o2 = await orchs.open('p1', { account: A });
    const s2 = o2.currentSessionId;
    await reach(orchs, s2, 'stopped');
    laneRow('D5', s2);
    const ask = cards.ask({ projectId: 'p1', sessionId: s2, source: 'orchestrator', question: 'Merge?', options: [{ label: 'Có' }] });
    const ask1 = cards.ask({ projectId: 'p1', sessionId: s1, source: 'orchestrator', question: 'Khác?', options: [{ label: 'Có' }] });
    const down = cards.list({ status: 'open' }).find((c) => c.kind === 'orchestrator_down')!;
    orchs.notify('p1', '[cc-slaves] lane D5 rảnh: xong', 'D5');
    await Bun.sleep(50);
    expect(listUndelivered(db, s2).map((x) => x.text)).toContain('[cc-slaves] lane D5 rảnh: xong');
    const r = await orchs.end(s2);
    expect(r).toMatchObject({ sessionId: s2, to: s1, lanes: ['D5'], handoffPath: null });
    expect(getLane(db, 'p1', 'D5')!.state).toBe('idle');
    expect(ownerOf(db, 'p1', 'D5')?.sessionId).toBe(s1);
    expect(sessionRow(s2)).toMatchObject({ state: 'done', end_reason: 'ended_by_po', handoff_path: null });
    expect(sessionRow(s2).ended_at).not.toBeNull();
    expect(listUndelivered(db, s2)).toHaveLength(0);
    await until(() => received(O, 1).includes('[cc-slaves] lane D5 rảnh: xong'), 'moved message delivered to #1');
    expect(cards.get(ask.id)!.status).toBe('expired');
    expect(cards.get(ask1.id)!.status).toBe('open');
    expect(cards.get(down.id)!.status).not.toBe('open'); // its "Điều phối #2 ngừng" card goes with it
    expect(orchs.list('p1').map((o) => o.currentSessionId)).toEqual([s1]);
    expect(ended).toContain(s2);
    expect(events.some((e) => e.type === 'session_ended' && e.sessionId === s2)).toBe(true);
  });

  test('§4.14 end a live session: it writes .local-check/handoff-<date>/orchestrator-<n>.md first', async () => {
    const { orchs } = setup();
    const s1 = (await orchs.start('p1')).currentSessionId;
    const o2 = await orchs.open('p1', {});
    const s2 = o2.currentSessionId;
    await reach(orchs, s2, 'idle');
    const a2 = o2.view().account!;
    const r = await orchs.end(s2, s1);
    const path = `.local-check/handoff-${TODAY}/orchestrator-2.md`;
    expect(r.handoffPath).toBe(path);
    expect(received(a2, 1).some((t) => t.startsWith(`[cc-slaves] Viết handoff vào ${path}`))).toBe(true);
    expect(sessionRow(s2)).toMatchObject({ handoff_path: path, end_reason: 'ended_by_po' });
  });

  test('§4.14 end refused for the last running session and for a receiver that is not another running session', async () => {
    const { orchs } = setup();
    const s1 = (await orchs.start('p1')).currentSessionId;
    await rejects(orchs.end(s1)).toThrow('Chỉ còn 1 phiên đang chạy');
    const s2 = (await orchs.open('p1', {})).currentSessionId;
    await rejects(orchs.end(s2, s2)).toThrow();
    await rejects(orchs.end(s2, 'nope')).toThrow();
  });

  test('§4.14 a lane event that comes in during #2\'s end handoff reaches the receiver #1 (no orphan notice)', async () => {
    const { orchs } = setup((email) => (email === O ? LOOP : SLOW));
    const s1 = (await orchs.start('p1')).currentSessionId;
    await reach(orchs, s1, 'idle');
    const s2 = (await orchs.open('p1', {})).currentSessionId;
    await reach(orchs, s2, 'idle');
    laneRow('D1', s2);
    const ending = orchs.end(s2, s1);
    await Bun.sleep(5);
    orchs.notify('p1', 'EVENT-X lane D1 hỏng', 'D1'); // owner is still #2 during its handoff
    const rows = () => db.query<{ s: string }, []>("SELECT session_id AS s FROM outbox WHERE text LIKE '%EVENT-X%'").all().map((r) => r.s);
    await until(() => rows().length > 0, 'EVENT-X queued');
    expect(orchs.bySession(s2)).not.toBeNull(); // #2 is still writing its handoff…
    expect(rows()).toEqual([s1]); // …and the notice already went to its receiver, not behind #2's end
    await ending;
    await until(() => received(O, 1).some((t) => t.includes('EVENT-X')), '#1 gets EVENT-X');
    expect(rows()).toEqual([s1]);
  });

  test('§4.14 ending #1 and #2 at once: the second is refused while the first closes; a running session and live owners stay', async () => {
    const { orchs } = setup(() => SLOW);
    const s1 = (await orchs.start('p1')).currentSessionId;
    await reach(orchs, s1, 'idle');
    const s2 = (await orchs.open('p1', {})).currentSessionId;
    await reach(orchs, s2, 'idle');
    laneRow('D1', s1); laneRow('D2', s2);
    const r = await Promise.allSettled([orchs.end(s1), orchs.end(s2)]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(orchs.list('p1')).toHaveLength(1);
    for (const n of ['D1', 'D2']) expect(sessionRow(ownerOf(db, 'p1', n)!.sessionId).ended_at).toBeNull();
    await rejects(orchs.end(orchs.list('p1')[0]!.currentSessionId)).toThrow('Chỉ còn 1 phiên đang chạy');
  });

  test('§4.14 while #2 closes: ending it again is refused, a reassign to it and a late send land on the receiver #1', async () => {
    const { orchs } = setup((email) => (email === O ? LOOP : SLOW));
    const s1 = (await orchs.start('p1')).currentSessionId;
    await reach(orchs, s1, 'idle');
    const o2 = await orchs.open('p1', {});
    const s2 = o2.currentSessionId;
    await reach(orchs, s2, 'idle');
    laneRow('D3', s1);
    const ending = orchs.end(s2, s1);
    await Bun.sleep(5);
    await rejects(orchs.end(s2, s1)).toThrow('đang kết thúc');
    expect(orchs.route(s2)?.currentSessionId).toBe(s1);
    expect(orchs.get('p1')?.currentSessionId).toBe(s1);
    await rejects(orchs.reassign('p1', 'D3', s2)).toThrow('D3 đã thuộc #1'); // to #2 = to its receiver #1
    await ending;
    await o2.send('LATE-Y'); // a straggler on the ended session follows its lanes
    await until(() => received(O, 1).some((t) => t.includes('LATE-Y')), '#1 gets LATE-Y');
    expect(db.query("SELECT 1 FROM outbox WHERE session_id = ? AND delivered_at IS NULL").all(s2)).toHaveLength(0);
  });

  test('§4.14 F21 new session (replace #n) takes the replaced session\'s lanes and gets a new number', async () => {
    const { orchs } = setup();
    const o1 = await orchs.start('p1');
    const s1 = o1.currentSessionId;
    await reach(orchs, s1, 'idle');
    laneRow('D6', s1);
    const r = await o1.newSession();
    expect(ownerOf(db, 'p1', 'D6')?.sessionId).toBe(r.sessionId);
    expect(sessionRow(r.sessionId)).toMatchObject({ seq: 2, title: null });
    expect(sessionRow(s1)).toMatchObject({ end_reason: 'replaced' });
    expect(orchs.bySession(r.sessionId)).toBe(o1);
    expect(orchs.bySession(s1)).toBeNull();
  });

  test('§4.14 migration rule: the first session opened afterwards adopts lanes whose owner ended and is told so', async () => {
    db.query("INSERT INTO session (id, project_id, kind, account, created_at, ended_at, seq, state) VALUES ('old', 'p1', 'orchestrator', ?, 1, 2, 1, 'done')").run(O);
    laneRow('D8', 'old');
    const { orchs } = setup();
    const o = await orchs.start('p1');
    expect(ownerOf(db, 'p1', 'D8')?.sessionId).toBe(o.currentSessionId);
    expect(sessionRow(o.currentSessionId).seq).toBe(2);
    await reach(orchs, o.currentSessionId, 'idle');
    expect(received(O, 1)).toContain('[cc-slaves] Phiên này nhận lane D8 (của phiên đã kết thúc). Gọi `lanes_list` trước khi ra lệnh.');
  });
});

describe('§5.3 orchestrator turn cut short keeps its tokens', () => {
  const usageLine = { emit: { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_cut', role: 'assistant', model: 'claude-fake',
    content: [{ type: 'text', text: '…' }], usage: { input_tokens: 1000, output_tokens: 500 } } } };
  const cut = { input: 1000, output: 500, cacheWrite: 0, cacheRead: 0 };
  const stored = (sid: string) => db.query<{ j: string }, [string]>("SELECT json AS j FROM event WHERE session_id = ? AND type = 'usage'").all(sid)
    .map((r) => (JSON.parse(r.j) as { usage: unknown }).usage);

  test('§5.3 the process dies mid-turn → a `usage` event with what it reported; the session total keeps it', async () => {
    const { orchs } = setup((_e, n) => (n === 1 ? { steps: [wait, usageLine, { sleep: 100 }, die] } : LOOP));
    const o = await orchs.start('p1');
    await until(() => stored(o.currentSessionId).length > 0, 'usage event stored');
    expect(stored(o.currentSessionId)).toEqual([cut]);
    expect(sessionTokens(db, [o.currentSessionId])).toEqual(cut);
    expect(o.view().tokens).toEqual(cut);
  });

  test('§5.3 "Khởi động lại" (restart) mid-turn kills the process → the cut turn\'s tokens are stored once', async () => {
    const { orchs } = setup((_e, n) => (n === 1 ? { steps: [wait, usageLine, { sleep: 60_000 }] } : LOOP));
    const o = await orchs.start('p1');
    await until(() => o.view().tokens?.input === 1000, 'provisional tokens');
    await o.restart();
    expect(stored(o.currentSessionId)).toEqual([cut]);
    expect(o.view().tokens).toEqual(cut);
  });

  test('§5.3 engine shutdown mid-turn → the running turn\'s tokens are stored', async () => {
    const { orchs } = setup(() => ({ steps: [wait, usageLine, { sleep: 60_000 }] }));
    const o = await orchs.start('p1');
    await until(() => o.view().tokens?.input === 1000, 'provisional tokens');
    await orchs.shutdown();
    expect(stored(o.currentSessionId)).toEqual([cut]);
  });
});

describe('§4.14 stopAll(sessionId)', () => {
  test('§4.14 "Dừng an toàn lane của #n" stops only that session\'s lanes', async () => {
    const { orchs, m, call } = setup();
    const s1 = (await orchs.start('p1')).currentSessionId;
    const s2 = (await orchs.open('p1', {})).currentSessionId;
    for (const [name, sid] of [['E1', s1], ['E2', s2]] as const) {
      const cwd = join(tmp, `wt-${name}`);
      mkdirSync(cwd);
      await call(sid, 'lane_start', { name, cwd, brief_path: `/b/${name}.md`, account: B });
    }
    await until(() => m.get('p1', 'E1')?.state === 'idle' && m.get('p1', 'E2')?.state === 'idle', 'lanes idle');
    const r = await stopAll(m, { projectId: 'p1', sessionId: s2, ownerOf: (p, n) => ownerOf(db, p, n)?.sessionId ?? null });
    expect(r.draining).toEqual(['p1/E2']);
    expect(r.states['p1/E1']).toBeUndefined();
    await until(() => m.get('p1', 'E2')?.state === 'stopped', 'E2 stopped');
    expect(m.get('p1', 'E1')?.state).toBe('idle');
  });
});

describe('§4.14 seq helper and remote gate', () => {
  test('§4.14 seqOf for a lane-less session id is null', () => { expect(seqOf(db, 'x')).toBeNull(); });

  test('§4.14 remote channel refuses every new session command except sessions_list (history stays allowed)', async () => {
    const called: string[] = [];
    const h = Object.fromEntries(ALL_COMMANDS.map((c) => [c, () => { called.push(c); return null; }])) as unknown as Handlers;
    const refused = ['session_open', 'session_end', 'lane_reassign'] as const;
    for (const cmd of refused) {
      expect(REMOTE_ALLOWED.has(cmd)).toBe(false);
      expect(await route(h, { channel: 'remote' }, { type: 'command', id: 'r', command: { cmd } })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
    }
    for (const cmd of ['sessions_list', 'history'] as const) {
      expect(REMOTE_ALLOWED.has(cmd)).toBe(true);
      expect(await route(h, { channel: 'remote' }, { type: 'command', id: 'r', command: { cmd } })).toMatchObject({ type: 'ack' });
    }
    expect(called).toEqual(['sessions_list', 'history']);
  });
});

// ---------- Engine level: commands, history of one session, card views ----------
describe('§4.14 engine commands (fake-claude, temp homes)', () => {
  const ENV_KEYS = ['CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON', 'CC_SLAVES_ATTACH'] as const;
  let saved: Record<string, string | undefined>;
  let engine: Engine;
  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
    process.env.CLAUDE_HOME = join(tmp, 'claude');
    process.env.CLAUDE_JSON = join(tmp, 'claude.json');
    process.env.CC_SLAVES_ATTACH = join(tmp, 'attach');
    mkdirSync(join(tmp, 'shop', '.git'), { recursive: true });
    mkdirSync(join(tmp, 'web'), { recursive: true });
    writeFileSync(join(tmp, 'web', 'index.html'), '<!doctype html>');
    mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
    const edb = openDb(paths().stateDb);
    seedAccounts([O], { db: edb });
    const now = Math.floor(Date.now() / 1000);
    upsertQuota(edb, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
    edb.close();
    engine = await Engine.start({
      gh: null, // never the real gh (network)
      version: 'test', port: 0, token: 'tok', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
      loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
      extraEnv: () => {
        const f = join(tmp, `escn-${Math.random().toString(36).slice(2)}.json`);
        writeFileSync(f, JSON.stringify(LOOP));
        return { FAKE_CLAUDE_SCENARIO: f };
      },
      quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
      caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
      exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
      fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
      notify: { osascript: () => {}, postGchat: async () => {} },
      session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
      statsEveryMs: 0, statsThrottleMs: 50, log: () => {}, hasLogin: () => true,
    });
  });
  afterEach(async () => {
    await engine?.stop();
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  const mac: Conn = { channel: 'mac', watch: null, present: false, send: () => {} };
  const idle = (sid: string) => until(() => engine.orchestrators.bySession(sid)?.view().state === 'idle', `${sid} idle`);

  test('§4.14 a watch with no sessionId (v2-shaped client) is pinned to the current session: #2\'s live lines do not leak in', async () => {
    const conn: Conn = { channel: 'mac', watch: null, present: false, send: () => {} };
    const h = buildHandlers(engine, conn);
    const p = await h.project_add({ cmd: 'project_add', name: 'Shop', path: join(tmp, 'shop') }, { channel: 'mac' }) as { id: string };
    await h.project_resume({ cmd: 'project_resume', id: p.id }, { channel: 'mac' }); // hf1116 H2
    const s1 = engine.orchestrators.get(p.id)!.currentSessionId;
    await idle(s1);
    const s2 = (await h.session_open({ cmd: 'session_open', projectId: p.id }, { channel: 'mac' }) as { sessionId: string }).sessionId;
    await h.watch({ cmd: 'watch', target: { kind: 'orchestrator', projectId: p.id } }, { channel: 'mac' });
    expect(conn.watch).toEqual({ kind: 'orchestrator', projectId: p.id, sessionId: s1 }); // same session as its history
    expect(delivers(conn, 'stream', { kind: 'orchestrator', projectId: p.id, sessionId: s2 })).toBe(false);
    expect(delivers(conn, 'stream', { kind: 'orchestrator', projectId: p.id, sessionId: s1 })).toBe(true);
    await h.watch({ cmd: 'watch', target: { kind: 'orchestrator', projectId: p.id, sessionId: s2 } }, { channel: 'mac' });
    expect(conn.watch).toEqual({ kind: 'orchestrator', projectId: p.id, sessionId: s2 }); // explicit one kept
  });

  test('§4.14 session_open / sessions_list / history of one session with boundary lines / session_end', async () => {
    const h = buildHandlers(engine, mac);
    const p = await h.project_add({ cmd: 'project_add', name: 'Shop', path: join(tmp, 'shop') }, { channel: 'mac' }) as { id: string };
    await h.project_resume({ cmd: 'project_resume', id: p.id }, { channel: 'mac' }); // hf1116 H2
    const s1 = engine.orchestrators.get(p.id)!.currentSessionId;
    await idle(s1);
    const v2 = await h.session_open({ cmd: 'session_open', projectId: p.id, title: 'hotfix' }, { channel: 'mac' }) as OrchestratorView;
    expect(v2).toMatchObject({ seq: 2, title: 'hotfix', projectId: p.id });
    const s2 = v2.sessionId!;
    await idle(s2);
    expect(engine.snapshot('mac').orchestrators.map((o) => [o.sessionId, o.seq])).toEqual([[s1, 1], [s2, 2]]);
    const hist = (sid: string) => h.history({ cmd: 'history', target: { kind: 'orchestrator', projectId: p.id, sessionId: sid } }, { channel: 'mac' }) as StreamLine[];
    const h2 = hist(s2);
    expect(h2[0]).toMatchObject({ kind: 'engine', text: `Phiên #2 bắt đầu · ${O}`, boundary: { type: 'start', seq: 2, account: O } });
    expect(h2.some((l) => l.boundary?.seq === 1)).toBe(false);
    expect(hist(s1)[0]).toMatchObject({ boundary: { type: 'start', seq: 1 } });
    expect(hist(s1).some((l) => l.boundary?.seq === 2)).toBe(false);
    // no sessionId → the project's first running session only (no merging)
    expect((h.history({ cmd: 'history', target: { kind: 'orchestrator', projectId: p.id } }, { channel: 'mac' }) as StreamLine[]).map((l) => l.seq))
      .toEqual(hist(s1).map((l) => l.seq));
    let list = h.sessions_list({ cmd: 'sessions_list', projectId: p.id }, { channel: 'mac' }) as SessionsList;
    expect(list.max).toBe(3);
    expect(list.running.map((r) => [r.seq, r.title, r.state, r.accountFirst, r.endReason, r.resumable])).toEqual([
      [1, null, 'idle', O, null, null], [2, 'hotfix', 'idle', O, null, null]]);
    expect(list.running[1]!.costUsd).toBeGreaterThan(0); // that orchestrator's own turns
    expect(list.ended).toEqual([]);
    const r = await h.session_end({ cmd: 'session_end', sessionId: s2 }, { channel: 'mac' }) as { to: string };
    expect(r.to).toBe(s1);
    list = h.sessions_list({ cmd: 'sessions_list', projectId: p.id }, { channel: 'mac' }) as SessionsList;
    expect(list.running.map((x) => x.seq)).toEqual([1]);
    expect(list.ended.map((x) => [x.seq, x.state, x.endReason, x.handoffPath])).toEqual([[2, 'ended', 'ended_by_po', `.local-check/handoff-${TODAY}/orchestrator-2.md`]]);
    expect(hist(s2).at(-1)).toMatchObject({ text: 'Phiên #2 kết thúc · đã viết handoff', boundary: { type: 'end', seq: 2, endReason: 'ended_by_po' } });
    expect(engine.snapshot('mac').orchestrators.map((o) => o.sessionId)).toEqual([s1]);
  });

  test('§10.2 G3d an echoed row forwarded from an ended session → one `po` line (with att) in the receiver\'s history, none in the ended one', async () => {
    const h = buildHandlers(engine, mac);
    const p = await h.project_add({ cmd: 'project_add', name: 'Shop', path: join(tmp, 'shop') }, { channel: 'mac' }) as { id: string };
    await h.project_resume({ cmd: 'project_resume', id: p.id }, { channel: 'mac' }); // hf1116 H2
    const s1 = engine.orchestrators.get(p.id)!.currentSessionId;
    await idle(s1);
    const s2 = (await h.session_open({ cmd: 'session_open', projectId: p.id }, { channel: 'mac' }) as OrchestratorView).sessionId!;
    await idle(s2);
    const ended = engine.orchestrators.bySession(s2)!;
    await h.session_end({ cmd: 'session_end', sessionId: s2 }, { channel: 'mac' });
    const up = engine.attach.put('ghi.txt', new TextEncoder().encode('x'));
    const t = await engine.attach.take([{ up: up.id }]);
    if (!t.ok) throw new Error('take');
    await ended.send('xem file', PREFIX.po, { attachments: t.list, echoed: true }); // forwardTo → #1
    const row = () => engine.db.query<{ d: number | null; e: number }, [string]>(
      "SELECT delivered_at AS d, echoed AS e FROM outbox WHERE session_id = ? AND text = 'xem file'").get(s1);
    await until(() => row()?.d != null, 'forwarded row delivered (replayed) in #1');
    expect(row()!.e).toBe(1);
    const hist = (sid: string) => h.history({ cmd: 'history', target: { kind: 'orchestrator', projectId: p.id, sessionId: sid } }, { channel: 'mac' }) as StreamLine[];
    expect(hist(s1).filter((l) => l.kind === 'po' && l.text === 'xem file').map((l) => l.att)).toEqual([[{ kind: 'file', name: 'ghi.txt', copy: true }]]);
    expect(hist(s2).some((l) => l.text === 'xem file')).toBe(false);
  });

  test('§4.14 card view carries session_id + #n (lane source → its owner\'s #n); card buttons act on their own session', async () => {
    const h = buildHandlers(engine, mac);
    const p = await h.project_add({ cmd: 'project_add', name: 'Shop', path: join(tmp, 'shop') }, { channel: 'mac' }) as { id: string };
    await h.project_resume({ cmd: 'project_resume', id: p.id }, { channel: 'mac' }); // hf1116 H2
    const s1 = engine.orchestrators.get(p.id)!.currentSessionId;
    const v2 = await h.session_open({ cmd: 'session_open', projectId: p.id }, { channel: 'mac' }) as OrchestratorView;
    const s2 = v2.sessionId!;
    const ask = engine.cards.ask({ projectId: p.id, sessionId: s2, source: 'orchestrator', question: 'q?', options: [] });
    expect(engine.cardViewOf(ask)).toMatchObject({ sessionId: s2, seq: 2 });
    engine.db.query("INSERT INTO session (id, project_id, kind, created_at) VALUES ('ls', ?, 'lane', 1)").run(p.id);
    insertLane(engine.db, { projectId: p.id, name: 'L1', cwd: join(tmp, 'wt-L1'), sessionId: 'ls', ownerSession: s2, state: 'idle' });
    const laneAsk = engine.cards.ask({ projectId: p.id, sessionId: 'ls', source: 'L1', question: 'q?', options: [] });
    expect(engine.cardViewOf(laneAsk)).toMatchObject({ sessionId: 'ls', seq: 2 });
    expect(engine.laneView(p.id, 'L1')).toMatchObject({ ownerSession: s2, ownerSeq: 2 });
    const restarted: string[] = [];
    for (const sid of [s1, s2]) engine.orchestrators.bySession(sid)!.restart = async () => { restarted.push(sid); };
    const c = engine.cards.createSystem({
      kind: 'orchestrator_down', projectId: p.id, sessionId: s2, key: `orchestrator:${s2}`, titleKey: 'cards.orchestratorDownN', params: { n: 2 },
      actions: [act('cardText.act.restart', 'restart_orchestrator', { sessionId: s2 })],
    });
    await h.card_action({ cmd: 'card_action', id: c.id, action: 'restart_orchestrator' }, { channel: 'mac' });
    expect(restarted).toEqual([s2]);
    // the button's own `args.sessionId` decides, not the project's first session (a card with no session row)
    const c2 = engine.cards.createSystem({
      kind: 'orchestrator_down', projectId: p.id, key: `orchestrator:x-${s2}`, titleKey: 'cards.orchestratorDownN', params: { n: 2 },
      actions: [act('cardText.act.restart', 'restart_orchestrator', { sessionId: s2 })],
    });
    await h.card_action({ cmd: 'card_action', id: c2.id, action: 'restart_orchestrator' }, { channel: 'mac' });
    expect(restarted).toEqual([s2, s2]);
    restarted.length = 1;
    await rejects(Promise.resolve().then(() => h.orchestrator_restart({ cmd: 'orchestrator_restart', projectId: p.id, sessionId: 'nope' }, { channel: 'mac' })))
      .toThrow('Không có phiên nope');
    await h.orchestrator_restart({ cmd: 'orchestrator_restart', projectId: p.id, sessionId: s1 }, { channel: 'mac' });
    expect(restarted).toEqual([s2, s1]);
  });

  test('§4.14 stop_all with sessionId drains only that session\'s lanes (command path)', async () => {
    const h = buildHandlers(engine, mac);
    const p = await h.project_add({ cmd: 'project_add', name: 'Shop', path: join(tmp, 'shop') }, { channel: 'mac' }) as { id: string };
    await h.project_resume({ cmd: 'project_resume', id: p.id }, { channel: 'mac' }); // hf1116 H2
    const v2 = await h.session_open({ cmd: 'session_open', projectId: p.id }, { channel: 'mac' }) as OrchestratorView;
    const r = await h.stop_all({ cmd: 'stop_all', projectId: p.id, sessionId: v2.sessionId! }, { channel: 'mac' }) as { draining: string[]; untouched: string[] };
    expect(r).toMatchObject({ draining: [], untouched: [] });
  });
});
