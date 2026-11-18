// v2.1 §4.14 part B with fake-claude: resume an ended orchestrator session (`--resume <same id>`, first message lists
// what changed, lock by id, cap 3 / replace), "Không chạy tiếp được" (transcript gone), new sessions from handoff /
// last 50 lines, "Chạy tiếp lane" (worktree rebuilt from the lane branch, merged branch refused), per-session home on
// restart, remote gate of the new commands. Temp homes + temp git repos; never real quota or the Keychain.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account } from '../src/accounts/registry.ts';
import { QuotaTracker } from '../src/accounts/quota.ts';
import type { Caps } from '../src/config.ts';
import { getLane, insertEvent, insertLane, insertProject, insertSession, openDb, upsertQuota, type Db } from '../src/db.ts';
import { LaneManager, type LaneManagerDeps } from '../src/lane/manager.ts';
import { continuePreview, prepareContinue, type ContinueDeps } from '../src/lane/continue.ts';
import { Orchestrators, type OrchestratorDeps, type OrchestratorEvent } from '../src/orchestrator/session.ts';
import { transcriptPath } from '../src/orchestrator/resume.ts';
import { recover } from '../src/recovery.ts';
import { Outbox } from '../src/outbox.ts';
import { ALL_COMMANDS, route, type Handlers } from '../src/server/router.ts';
import { fromFirst } from '../src/server/commands.ts';
import { LineStore } from '../src/server/lines.ts';
import { listSessions } from '../src/server/session-views.ts';
import { execIn } from '../src/setup/setup.ts';
import { REMOTE_ALLOWED } from '../../shared/protocol.ts';
import { rejects } from '../test/_fixtures/rejects.ts';
import { ModelCache } from '../src/models.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const A = 'a@x.test';
const B = 'b@x.test';
const CAPS = { default: { week: 98, five: 95 }, [O]: { role: 'orchestrator', week: 99, five: 97 }, [A]: { role: 'primary', week: 99 }, [B]: { role: 'primary', week: 99 } } as Caps;
const SAVED = { home: process.env.CC_SLAVES_HOME, claude: process.env.CLAUDE_HOME };
const FUTURE5 = 4102444800;
const FUTURE7 = 4103049600;

type Step = Record<string, unknown>;
const assistant: Step = { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: 'ok' }] } } };
const result: Step = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'Xong.', num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } };
const LOOP = { steps: Array.from({ length: 8 }, () => [{ waitUser: true }, assistant, result]).flat() };

let tmp: string; let db: Db; let repo: string;
let spawns: { account: string; trace: string; stdin: string }[];
let closers: (() => Promise<void>)[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-resume-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  db = openDb(join(tmp, 'state.db'));
  repo = join(tmp, 'p1');
  mkdirSync(repo, { recursive: true });
  insertProject(db, { id: 'p1', name: 'P1', path: repo, orchestratorAccount: O });
  spawns = []; closers = [];
  const now = Math.floor(Date.now() / 1000);
  for (const a of [O, A, B]) upsertQuota(db, { account: a, fivePct: 10, weekPct: 10, fiveResetsAt: FUTURE5, weekResetsAt: FUTURE7, source: 'api', fetchedAt: now, status: 'ok' });
});
afterEach(async () => {
  for (const c of closers) await c();
  db.close();
  for (const [k, v] of [['CC_SLAVES_HOME', SAVED.home], ['CLAUDE_HOME', SAVED.claude]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(tmp, { recursive: true, force: true });
});

const account = (email: string): Account => ({ email, id: null, configDir: join(tmp, `cfg-${email}`), keychainService: `k-${email}`, planTier: 'max', terminal: false });

function setup() {
  const accounts = [O, A, B].map(account);
  const events: OrchestratorEvent[] = [];
  const outbox = new Outbox(db);
   
  let m: LaneManager; let orchs: Orchestrators;
  const tracker = new QuotaTracker({ db, source: { fetchUsage: () => Promise.reject(new Error('no network')) }, onAccountChanged: (e) => { m.accountChanged(e); orchs.accountChanged(e); } });
  const env = (a: Account) => {
    const n = spawns.length + 1;
    const file = join(tmp, `scn-${n}.json`);
    writeFileSync(file, JSON.stringify(LOOP));
    const trace = join(tmp, `trace-${n}.json`);
    const stdin = join(tmp, `stdin-${n}.jsonl`);
    spawns.push({ account: a.email, trace, stdin });
    return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_TRACE: trace, FAKE_CLAUDE_STDIN_LOG: stdin };
  };
  const od: OrchestratorDeps = {
    db, outbox, accounts: () => accounts, quota: tracker, caps: () => CAPS, command: ['bun', FAKE], mcpPort: 1, env,
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 500 }, closeGraceMs: 300, handoffTimeoutMs: 5000, modelCache: new ModelCache(),
  };
  orchs = new Orchestrators(od);
  orchs.on((e) => events.push(e));
  const ld: LaneManagerDeps = {
    db, outbox, accounts: () => accounts, quota: tracker, caps: () => CAPS, config: () => ({ maxLanes: 8, maxLanesPerAccount: 3 }),
    command: ['bun', FAKE], mcpPort: 1, env, notify: (p, t, lane) => orchs.notify(p, t, lane),
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 300 }, closeGraceMs: 300,
  };
  m = new LaneManager(ld);
  closers.push(() => orchs.shutdown(), () => m.shutdown());
  return { orchs, m, events, outbox, od };
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await Bun.sleep(15); }
}
const answered = (sid: string) => db.query("SELECT 1 FROM event WHERE session_id = ? AND type = 'result'").get(sid) !== null;
const received = (i: number): string[] => {
  const f = spawns[i]?.stdin;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: string } })
    .filter((l) => l.type === 'user').map((l) => l.message!.content);
};
const argv = (i: number): string[] => (JSON.parse(readFileSync(spawns[i]!.trace, 'utf8')) as { argv: string[] }).argv;
const row = (id: string) => db.query<{ seq: number; state: string; ended_at: number | null; end_reason: string | null }, [string]>('SELECT seq, state, ended_at, end_reason FROM session WHERE id = ?').get(id)!;
const owner = (name: string) => getLane(db, 'p1', name)?.ownerSession;
const transcript = (cwd: string, sid: string) => { const p = transcriptPath(join(tmp, 'claude'), cwd, sid); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, '{}\n'); return p; };

/** #1 running, #2 opened, answered, given lanes D7 + D9, then ended (lanes → #1); D7 then goes done. Returns ids. */
async function endedSession(orchs: Orchestrators) {
  const o1 = await orchs.start('p1');
  await until(() => answered(o1.currentSessionId), '#1 answered');
  const o2 = await orchs.open('p1', { account: A });
  const s1 = o1.currentSessionId; const s2 = o2.currentSessionId;
  await until(() => answered(s2), '#2 answered');
  insertLane(db, { projectId: 'p1', name: 'D7', cwd: join(tmp, 'wt-D7'), ownerSession: s2, state: 'idle' });
  insertLane(db, { projectId: 'p1', name: 'D9', cwd: join(tmp, 'wt-D9'), ownerSession: s2, state: 'idle' });
  await orchs.end(s2, s1);
  db.query("UPDATE lane SET state = 'done', done_at = ? WHERE name = 'D7'").run(Math.floor(Date.now() / 1000));
  return { s1, s2 };
}

describe('§4.14 resume an ended session', () => {
  test('§4.14 resume runs `claude --resume <old id>` (no fork), keeps #2, first message lists the lanes that changed', async () => {
    const { orchs, events } = setup();
    const { s1, s2 } = await endedSession(orchs);
    transcript(repo, s2);
    const pv = orchs.preview(s2);
    expect(pv.resumable).toBe(true);
    expect(pv.sinceStop).toEqual([{ name: 'D7', kind: 'done', seq: 1, at: expect.any(Number) }, { name: 'D9', kind: 'moved', seq: 1, at: null }]);
    expect(pv.parallelAllowed).toBe(true);
    // §4.14 each stored turn carries the account's five_pct before / after it (estimate samples)
    const ev = JSON.parse(db.query<{ json: string }, [string]>("SELECT json FROM event WHERE session_id = ? AND type = 'result' LIMIT 1").get(s2)!.json);
    expect(ev).toMatchObject({ account: A, fiveBefore: 10, fiveAfter: 10 });
    const before = spawns.length;
    const o = await orchs.resume(s2, { mode: 'parallel' });
    await until(() => received(before).length > 0, 'resumed process got its first message');
    const a = argv(before);
    expect(a[a.indexOf('--resume') + 1]).toBe(s2);
    expect(a).not.toContain('--fork-session');
    expect(a).not.toContain('--session-id');
    expect(received(before)[0]).toMatch(/^\[cc-slaves\] Phiên này được nối lại sau \d+ phút\. Từ lúc dừng: D7 xong, D9 → #1\. Gọi `lanes_list` trước khi ra lệnh\.$/);
    expect(o.currentSessionId).toBe(s2);
    expect(row(s2)).toMatchObject({ seq: 2, ended_at: null, end_reason: null });
    expect(orchs.list('p1').map((x) => x.currentSessionId)).toEqual([s1, s2]); // its root goes last
    expect(events.some((e) => e.type === 'boundary' && e.sessionId === s2 && e.boundary.type === 'resume' && e.boundary.mode === 'parallel')).toBe(true);
  });

  test('§4.14 M3 the last account now orchestrates another session → the preview proposes a free one and says why', async () => {
    const { orchs } = setup();
    const { s2 } = await endedSession(orchs);
    transcript(repo, s2);
    expect(orchs.preview(s2).account).toBe(A); // A free → stays on its last account
    const o3 = await orchs.open('p1', { account: A });
    await until(() => answered(o3.currentSessionId), '#3 answered');
    const pv = orchs.preview(s2);
    expect(pv.account).toBe(B); // O runs #1, A runs #3
    expect(pv.accountReason).toEqual({ key: 'console.resumeLastBusy', params: { account: A, n: 2 } });
  });

  test('D103 the last account is low → the reason says what is left: the 5 hours on Max, the week on Ultra (never "chỉ còn 0 %")', async () => {
    const { orchs, od } = setup();
    const { s2 } = await endedSession(orchs);
    transcript(repo, s2);
    const t = Math.floor(Date.now() / 1000);
    upsertQuota(db, { account: A, fivePct: 98, weekPct: 10, fiveResetsAt: FUTURE5, weekResetsAt: FUTURE7, source: 'api', fetchedAt: t, status: 'ok' });
    expect(orchs.preview(s2).accountReason).toEqual({ key: 'console.resumeLastLow', params: { account: A, n: 2, left: 2 } }); // Max: 5 hours
    od.accounts().find((a) => a.email === A)!.planTier = 'default_claude_ultra';
    upsertQuota(db, { account: A, fivePct: null, weekPct: 99.4, fiveResetsAt: null, weekResetsAt: FUTURE7, source: 'api', fetchedAt: t, status: 'ok', fiveWindow: false });
    const pv = orchs.preview(s2);
    expect(pv.account).not.toBe(A);
    expect(pv.accountReason).toEqual({ key: 'console.resumeLastLow', params: { account: A, n: 2, left: 1 } }); // Ultra: the week
  });

  test('§4.14 transcript jsonl deleted → resumable=false + reason (list and preview); resume refused, nothing spawned', async () => {
    const { orchs } = setup();
    const { s2 } = await endedSession(orchs);
    const p = transcript(repo, s2);
    rmSync(p);
    const pv = orchs.preview(s2);
    expect(pv.resumable).toBe(false);
    expect(pv.reason).toEqual({ key: 'errors.noTranscript', params: { days: 30 } });
    const list = listSessions(db, 'p1', new Map(orchs.list('p1').map((o) => [o.currentSessionId, o.view()])), (id) => orchs.resumability(id), 30);
    expect(list.ended[0]).toMatchObject({ sessionId: s2, resumable: false, reason: { key: 'errors.noTranscript' } });
    const before = spawns.length;
    await rejects(orchs.resume(s2, { mode: 'parallel' })).toThrow('Claude Code đã xoá bản ghi sau 30 ngày');
    expect(spawns.length).toBe(before);
  });

  test('§4.14 a session that never answered → "chưa từng trả lời"', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    insertSession(db, { id: 'dead', projectId: 'p1', kind: 'orchestrator', account: A });
    db.query("UPDATE session SET seq = 9, ended_at = 1, state = 'done' WHERE id = 'dead'").run();
    transcript(repo, 'dead');
    expect(orchs.preview('dead').reason).toEqual({ key: 'errors.neverAnswered', params: { n: 9 } });
  });

  test('§4.14 never resume an id with a live process: running one refused; two resumes at once → one wins', async () => {
    const { orchs } = setup();
    const { s1, s2 } = await endedSession(orchs);
    transcript(repo, s2);
    await rejects(orchs.resume(s1, { mode: 'parallel' })).toMatchObject({ code: 'session_live' });
    const r = await Promise.allSettled([orchs.resume(s2, { mode: 'parallel' }), orchs.resume(s2, { mode: 'parallel' })]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'session_live' });
    await until(() => orchs.bySession(s2)?.view().state === 'idle', 's2 idle'); // hf1117-perf resume answers before the boot
    expect(spawns.filter((s) => { try { const a = argv(spawns.indexOf(s)); return a[a.indexOf('--resume') + 1] === s2; } catch { return false; } })).toHaveLength(1);
  });

  test('§4.14 + v2.7 R34 at the cap (first Chung free): parallel refused; "Thay #n" works — replaced one ends (replaced), its lanes move to the resumed one', async () => {
    const { orchs } = setup();
    const { s1, s2 } = await endedSession(orchs);
    transcript(repo, s2);
    const o3 = await orchs.open('p1', {});
    const o4 = await orchs.open('p1', {});
    const o5 = await orchs.open('p1', {});
    insertLane(db, { projectId: 'p1', name: 'D5', cwd: join(tmp, 'wt-D5'), ownerSession: o3.currentSessionId, state: 'idle' });
    expect(orchs.preview(s2).parallelAllowed).toBe(false);
    await rejects(orchs.resume(s2, { mode: 'parallel' })).toMatchObject({ code: 'session_cap' });
    await orchs.resume(s2, { mode: 'replace', replaceId: o3.currentSessionId });
    expect(row(o3.currentSessionId)).toMatchObject({ end_reason: 'replaced', state: 'done' });
    expect(owner('D5')).toBe(s2);
    expect(orchs.list('p1').map((o) => o.currentSessionId)).toEqual([s1, o4.currentSessionId, o5.currentSessionId, s2]);
  });
});

describe('§4.14 "Thay phiên" never shows 4 running (g3 IMPORTANT-2)', () => {
  test('§4.14 resume "Thay #3": the count stays at the cap (3 + the free Chung, R34) while #3 writes its handoff; resumed root goes last', async () => {
    const { orchs } = setup();
    const { s2 } = await endedSession(orchs);
    transcript(repo, s2);
    const o3 = await orchs.open('p1', {});
    await orchs.open('p1', {});
    const o4 = await orchs.open('p1', {});
    const lens: number[] = [];
    const p = orchs.resume(s2, { mode: 'replace', replaceId: o3.currentSessionId });
    lens.push(orchs.list('p1').length);
    const t = setInterval(() => lens.push(orchs.list('p1').length), 5);
    await p;
    clearInterval(t);
    lens.push(orchs.list('p1').length);
    expect(Math.max(...lens)).toBe(4);
    expect(lens.at(-1)).toBe(4);
    expect(orchs.list('p1').map((o) => o.currentSessionId).slice(-2)).toEqual([o4.currentSessionId, s2]);
  });

  test('§4.14 open "Thay #2": the new session is not counted before #2 has ended', async () => {
    const { orchs } = setup();
    const a = await orchs.start('p1');
    await until(() => answered(a.currentSessionId), 'a answered');
    const b = await orchs.open('p1', {});
    await orchs.open('p1', {});
    await orchs.open('p1', {}); // v2.7 R34 the first Chung is free
    await until(() => answered(b.currentSessionId), 'b answered');
    const p = orchs.open('p1', { first: 'x', replaceId: b.currentSessionId });
    expect(orchs.list('p1')).toHaveLength(4);
    expect(await orchs.open('p1', { first: 'y' }).catch((e: unknown) => e)).toMatchObject({ code: 'session_cap' }); // no 4th slips in
    const c = await p;
    expect(orchs.list('p1')).toHaveLength(4);
    expect(orchs.list('p1').at(-1)).toBe(c);
  });

  test('§4.14 "Thay" the only running session: the pending replacer is its receiver (not "last session")', async () => {
    const { orchs } = setup();
    const a = await orchs.start('p1');
    await until(() => answered(a.currentSessionId), 'a answered');
    insertLane(db, { projectId: 'p1', name: 'D3', cwd: join(tmp, 'wt-D3'), ownerSession: a.currentSessionId, state: 'idle' });
    const c = await orchs.open('p1', { first: 'x', replaceId: a.currentSessionId });
    expect(orchs.list('p1')).toEqual([c]);
    expect(owner('D3')).toBe(c.currentSessionId);
    expect(row(a.currentSessionId).end_reason).toBe('replaced');
  });

  test('§4.14 two "Thay" resumes of one id at once → one wins (the row lock holds while the replacer is pending)', async () => {
    const { orchs } = setup();
    const { s2 } = await endedSession(orchs);
    transcript(repo, s2);
    const o3 = await orchs.open('p1', {});
    const o4 = await orchs.open('p1', {});
    const r = await Promise.allSettled([
      orchs.resume(s2, { mode: 'replace', replaceId: o3.currentSessionId }),
      orchs.resume(s2, { mode: 'replace', replaceId: o4.currentSessionId }),
    ]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'session_live' });
    await until(() => orchs.bySession(s2)?.view().state === 'idle', 's2 idle'); // hf1117-perf resume answers before the boot
  });
});

describe('§4.14 a resumed root stays last after an engine restart (g3 MINOR-1)', () => {
  test('§4.14 #1, #3 running, #2 resumed → restart restores #1, #3, #2', async () => {
    const { orchs, od } = setup();
    const { s2 } = await endedSession(orchs);
    transcript(repo, s2);
    await orchs.open('p1', {});
    await orchs.resume(s2, { mode: 'parallel' });
    const before = orchs.list('p1').map((o) => o.view().seq);
    expect(before).toEqual([1, 3, 2]);
    await orchs.shutdown();
    const again = new Orchestrators(od);
    closers.push(() => again.shutdown());
    await recover({ db, lanes: { restore: () => { throw new Error('no lane rows here'); }, list: () => [] }, orchestrators: again, ps: async () => [] });
    expect(again.list('p1').map((o) => o.view().seq)).toEqual(before);
  });
});

describe('§4.14 new session from handoff / last 50 lines', () => {
  test('§4.14 "từ handoff #n" / "từ 50 dòng cuối": new #n, count to the cap (+ the free Chung, R34), "Thay" frees a place', async () => {
    const { orchs } = setup();
    const { s2 } = await endedSession(orchs);
    db.query("UPDATE session SET handoff_path = '.local-check/h/orchestrator-2.md' WHERE id = ?").run(s2);
    const lines = new LineStore(db);
    lines.append(s2, [{ kind: 'assistant', text: 'đang làm D7' }]);
    const e = { db, lines } as unknown as Parameters<typeof fromFirst>[0];
    expect(fromFirst(e, 'p1', { sessionId: s2, kind: 'handoff' })).toBe('Phiên điều phối mới. Đọc .local-check/h/orchestrator-2.md rồi `lanes_list` và tiếp tục.');
    const tail = fromFirst(e, 'p1', { sessionId: s2, kind: 'tail' });
    expect(tail).toContain('assistant: đang làm D7');
    const a = await orchs.open('p1', { first: tail });
    expect(row(a.currentSessionId).seq).toBe(3);
    const b = await orchs.open('p1', { first: fromFirst(e, 'p1', { sessionId: s2, kind: 'handoff' }) });
    expect(row(b.currentSessionId).seq).toBe(4);
    await orchs.open('p1', { first: tail });
    await rejects(orchs.open('p1', { first: tail })).toMatchObject({ code: 'session_cap' });
    const c = await orchs.open('p1', { first: tail, replaceId: a.currentSessionId });
    expect(row(c.currentSessionId).seq).toBe(6);
    expect(row(a.currentSessionId).end_reason).toBe('replaced');
    expect(orchs.list('p1')).toHaveLength(4);
  });

  test('§4.14 "từ handoff" of a session without one → refused', async () => {
    const { orchs } = setup();
    const { s2 } = await endedSession(orchs);
    db.query('UPDATE session SET handoff_path = NULL WHERE id = ?').run(s2);
    expect(() => fromFirst({ db, lines: new LineStore(db) }, 'p1', { sessionId: s2, kind: 'handoff' }))
      .toThrow('Phiên #2 không có handoff');
  });
});

describe('§4.14 restart keeps each session on its own home (T3 ⑥)', () => {
  test('§4.14 a parallel session opened on A restores with home A, not the project home', async () => {
    const { orchs, od } = setup();
    await orchs.start('p1');
    const o2 = await orchs.open('p1', { account: A });
    const sid = o2.currentSessionId;
    await orchs.shutdown();
    const again = new Orchestrators(od);
    closers.push(() => again.shutdown());
    const r = db.query<{ id: string; project_id: string; account: string | null; state: string; account_home: string | null }, [string]>('SELECT * FROM session WHERE id = ?').get(sid)!;
    expect(r.account_home).toBe(A);
    const o = await again.restore(r);
    expect(o.view().home).toBe(A);
  });
});

// ---------- §4.14 / §4.15 "Chạy tiếp lane" ----------
const git = async (cwd: string, ...a: string[]) => {
  const r = await execIn(process.env)(['git', '-C', cwd, ...a]);
  if (r.code !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
async function doneLane(): Promise<{ wt: string; sid: string }> {
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 't@x'); await git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'base');
  const wt = join(tmp, 'wt-D7');
  await git(repo, 'worktree', 'add', '-q', '-b', 'lane/d7', wt);
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  await git(wt, 'add', '.'); await git(wt, 'commit', '-qm', 'd7 work');
  const sid = 'lane-d7';
  insertSession(db, { id: sid, projectId: 'p1', kind: 'lane', account: A });
  const l = insertLane(db, { projectId: 'p1', name: 'D7', cwd: wt, sessionId: sid, state: 'idle' });
  db.query("UPDATE lane SET state = 'done', done_at = 1, branch = 'lane/d7' WHERE id = ?").run(l.id);
  db.query("UPDATE session SET state = 'done', ctx_last = 50000 WHERE id = ?").run(sid);
  insertEvent(db, { sessionId: sid, type: 'result', json: { usage: null } });
  const ob = new Outbox(db).enqueue(sid, 'brief', null);
  db.query('UPDATE outbox SET delivered_at = 1 WHERE uuid = ?').run(ob.uuid);
  transcript(wt, sid);
  return { wt, sid };
}
const cdeps = (): ContinueDeps => ({ db, exec: execIn(process.env), claudeHome: join(tmp, 'claude'), repoOf: () => repo });

describe('§4.14 "Chạy tiếp lane"', () => {
  test('§4.14 worktree deleted → rebuilt from lane/d7, lane leaves Xong under #1 and resumes its own session', async () => {
    const { orchs, m } = setup();
    const o1 = await orchs.start('p1');
    const { wt, sid } = await doneLane();
    rmSync(wt, { recursive: true, force: true });
    const pv = await continuePreview(cdeps(), 'p1', 'D7');
    expect(pv).toMatchObject({ resumable: true, worktreeExists: false, branch: 'lane/d7', ahead: 1, ctxLast: 50000, account: A });
    const before = spawns.length;
    const prep = await prepareContinue(cdeps(), 'p1', 'D7');
    expect(prep.rebuilt).toBe('lane/d7');
    expect(existsSync(join(wt, 'b.txt'))).toBe(true);
    expect(await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('lane/d7');
    m.reopen('p1', 'D7', { ownerSession: o1.currentSessionId, account: A, text: 'chạy tiếp' });
    await until(() => spawns.length > before && received(before).length > 0, 'lane resumed');
    const a = argv(before);
    expect(a[a.indexOf('--resume') + 1]).toBe(sid);
    expect(received(before)[0]).toBe('[cc-slaves] chạy tiếp'); // the continue text is the first line, not the resume note
    expect(getLane(db, 'p1', 'D7')).toMatchObject({ ownerSession: o1.currentSessionId });
    expect(getLane(db, 'p1', 'D7')!.state).not.toBe('done');
  });

  test('§4.14 M3 the lane last account now runs a Điều phối → the preview leaves the account to the lane picker (null)', async () => {
    setup();
    await doneLane();
    expect((await continuePreview(cdeps(), 'p1', 'D7')).account).toBe(A);
    const busy = { ...cdeps(), busy: () => [A] };
    expect(await continuePreview(busy, 'p1', 'D7')).toMatchObject({ account: null, accountLast: A });
    expect((await prepareContinue(busy, 'p1', 'D7')).account).toBeNull();
  });

  test('§4.14 merged lane branch → refused (no rebuild, nothing spawned)', async () => {
    setup();
    const { wt } = await doneLane();
    await git(repo, 'merge', '-q', 'lane/d7');
    rmSync(wt, { recursive: true, force: true });
    expect((await continuePreview(cdeps(), 'p1', 'D7')).reason).toEqual({ key: 'errors.laneMerged', params: { branch: 'lane/d7' } });
    await rejects(prepareContinue(cdeps(), 'p1', 'D7')).toThrow('Không chạy tiếp được: nhánh lane/d7 đã merge');
    expect(existsSync(wt)).toBe(false);
  });

  test('§4.14 branch deleted → "không còn nhánh"; lane transcript expired → refused', async () => {
    setup();
    const { wt, sid } = await doneLane();
    rmSync(transcriptPath(join(tmp, 'claude'), wt, sid));
    expect((await continuePreview(cdeps(), 'p1', 'D7')).reason).toEqual({ key: 'errors.laneNoTranscript' });
    await git(repo, 'worktree', 'remove', '--force', wt);
    await git(repo, 'branch', '-D', 'lane/d7');
    expect((await continuePreview(cdeps(), 'p1', 'D7')).reason).toEqual({ key: 'errors.laneNoBranch', params: { branch: 'lane/d7' } });
  });
});

describe('§4.14 "Chạy tiếp lane" first message (g3 IMPORTANT-1)', () => {
  test('§4.14 a continued lane reads the continue text first, never the "You were interrupted" resume note', async () => {
    const { orchs, m } = setup();
    const o1 = await orchs.start('p1');
    await doneLane();
    const before = spawns.length;
    m.reopen('p1', 'D7', { ownerSession: o1.currentSessionId, account: A, text: 'PO chạy tiếp lane này' });
    await until(() => received(before).length > 0, 'continued lane got a line');
    await Bun.sleep(100);
    expect(received(before)).toEqual(['[cc-slaves] PO chạy tiếp lane này']);
  });
});

describe('§4.14 remote channel', () => {
  test('§4.14 every new part-B command is refused remotely (none added to REMOTE_ALLOWED)', async () => {
    const h = Object.fromEntries(ALL_COMMANDS.map((c) => [c, () => 'ran'])) as unknown as Handlers;
    for (const cmd of ['session_resume', 'session_resume_preview', 'session_rename', 'lane_continue', 'lane_continue_preview'] as const) {
      expect(REMOTE_ALLOWED.has(cmd)).toBe(false);
      const r = await route(h, { channel: 'remote' }, { type: 'command', id: '1', command: { cmd } });
      expect(r).toMatchObject({ type: 'error', code: 'forbidden_remote' });
    }
  });
});

describe('§4.14 "Đổi chủ lane" undo (5 s, web timer)', () => {
  test('§4.14 undo drops the note the receiver has not read yet; only a session that already read one is told', async () => {
    const { orchs } = setup();
    const o1 = await orchs.start('p1');
    const s1 = o1.currentSessionId;
    await until(() => answered(s1) && o1.view().state === 'idle', '#1 idle');
    insertSession(db, { id: 's2', projectId: 'p1', kind: 'orchestrator', account: A });
    db.query("UPDATE session SET seq = 2, state = 'stopped' WHERE id = 's2'").run();
    await orchs.restore({ id: 's2', project_id: 'p1', account: A, state: 'stopped' });
    insertLane(db, { projectId: 'p1', name: 'D2', cwd: join(tmp, 'wt-D2'), ownerSession: s1, state: 'idle' });
    const notes = (sid: string) => db.query<{ text: string }, [string]>("SELECT text FROM outbox WHERE session_id = ? AND text LIKE '%lane D2%' ORDER BY rowid").all(sid).map((r) => r.text);
    await orchs.reassign('p1', 'D2', 's2');
    expect(notes('s2')).toHaveLength(1); // stopped: queued, unsent
    expect(notes(s1)).toHaveLength(1);
    await orchs.reassign('p1', 'D2', s1, true);
    expect(owner('D2')).toBe(s1);
    expect(notes('s2')).toEqual([]); // dropped, never told
    expect(notes(s1)).toHaveLength(2); // #1 had read "chuyển sang #2" → told it is back
    expect(notes(s1)[1]).toContain('từ phiên #2 sang phiên này');
  });
});
