// v2.7 §5.0 / §7.2 / §7.3 with fake-claude: orchestrator sessions by kind (Thiết kế / Build / Chung) — orch_kind, the
// R34 cap, R26 one Chung, spec bindings (R-B8), `--settings` skill block + hook, Build resume in its cwd (R-B6),
// closeWhenIdle, the spec_draft rename hook. Temp homes; never real quota or the Keychain.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account } from '../src/accounts/registry.ts';
import { QuotaTracker } from '../src/accounts/quota.ts';
import type { Caps } from '../src/config.ts';
import { insertLane, insertProject, openDb, upsertQuota, type Db } from '../src/db.ts';
import { getSpec, insertSpec, moveSpec } from '../src/issues/store.ts';
import { ModelCache } from '../src/models.ts';
import { Orchestrators, type Orchestrator, type OrchestratorEvent } from '../src/orchestrator/session.ts';
import type { SessionRow } from '../src/orchestrator/session/types.ts';
import { Outbox } from '../src/outbox.ts';
import { writeSkillGate } from '../src/session/skills.ts';
import { rejects } from '../test/_fixtures/rejects.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test', A = 'a@x.test', B = 'b@x.test';
const CAPS: Caps = { default: { week: 98, five: 95 }, [O]: { role: 'orchestrator', week: 99, five: 97 }, [A]: { role: 'primary', week: 99 }, [B]: { role: 'primary', week: 99 } };
const SAVED = process.env.CC_SLAVES_HOME;
type Step = Record<string, unknown>;
const assistant: Step = { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: 'Đang làm…' }] } } };
const result: Step = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'Xong.', num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } };
const LOOP = { steps: Array.from({ length: 8 }, () => [{ waitUser: true }, assistant, result]).flat() };

let tmp: string;
let db: Db;
let spawns: { account: string; n: number; trace: string; stdin: string }[];
let closers: (() => Promise<void>)[];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-kinds-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  db = openDb(join(tmp, 'state.db'));
  mkdirSync(join(tmp, 'p1'), { recursive: true });
  insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1'), orchestratorAccount: O });
  spawns = [];
  closers = [];
  const now = Math.floor(Date.now() / 1000);
  for (const a of [O, A, B]) upsertQuota(db, { account: a, fivePct: 10, weekPct: 10, fiveResetsAt: 4102444800, weekResetsAt: 4103049600, source: 'api', fetchedAt: now, status: 'ok' });
});
afterEach(async () => {
  for (const c of closers) await c();
  db.close();
  if (SAVED === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = SAVED;
  rmSync(tmp, { recursive: true, force: true });
});

function setup(o: { env?: Record<string, string>; sessionSetup?: () => never; command?: string[] } = {}) {
  const accounts: Account[] = [O, A, B].map((email) => ({ email, id: null, configDir: join(tmp, `cfg-${email}`), keychainService: `k-${email}`, planTier: 'max', terminal: false }));
  const counts = new Map<string, number>();
  const events: OrchestratorEvent[] = [];
  const env = (a: Account) => {
    const n = (counts.get(a.email) ?? 0) + 1;
    counts.set(a.email, n);
    const file = join(tmp, `scn-${a.email}-${n}.json`);
    writeFileSync(file, JSON.stringify(LOOP));
    const trace = join(tmp, `trace-${a.email}-${n}.json`), stdin = join(tmp, `stdin-${a.email}-${n}.jsonl`);
    spawns.push({ account: a.email, n, trace, stdin });
    return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_TRACE: trace, FAKE_CLAUDE_STDIN_LOG: stdin, ...o.env };
  };
  const quota = new QuotaTracker({ db, source: { fetchUsage: () => Promise.reject(new Error('no network in tests')) }, onAccountChanged: () => {} });
  const orchs = new Orchestrators({
    db, outbox: new Outbox(db), accounts: () => accounts, quota, caps: () => CAPS, command: o.command ?? ['bun', FAKE], mcpPort: 1, env,
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 500 }, closeGraceMs: 300, handoffTimeoutMs: 5000, modelCache: new ModelCache(),
    ...(o.sessionSetup ? { sessionSetup: o.sessionSetup } : {}),
  });
  orchs.on((e) => events.push(e));
  closers.push(() => orchs.shutdown());
  return { orchs, events };
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
const sessionRow = (id: string) => db.query<{ title: string | null; state: string; end_reason: string | null; handoff_path: string | null }, [string]>(
  'SELECT title, state, end_reason, handoff_path FROM session WHERE id = ?').get(id)!;
const laneRow = (name: string, owner: string) => insertLane(db, { projectId: 'p1', name, cwd: join(tmp, `wt-${name}`), ownerSession: owner, state: 'idle' });

describe('v2.7 §5.0 orchestrator session kinds', () => {
  const kindOf = (sid: string) => db.query<{ k: string }, [string]>('SELECT orch_kind AS k FROM session WHERE id = ?').get(sid)!.k;
  const traceOf = (o: Orchestrator) => {
    const acct = o.view().account!;
    const n = spawns.filter((s) => s.account === acct).length;
    return JSON.parse(readFileSync(spawn(acct, n)!.trace, 'utf8')) as { argv: string[]; cwd: string };
  };
  const settingsOf = (o: Orchestrator) => {
    const a = traceOf(o).argv;
    return JSON.parse(readFileSync(a[a.indexOf('--settings') + 1]!, 'utf8')) as { permissions: { deny: string[] }; hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
  };
  /** Runs the session's own PreToolUse hook command on the G0 stdin shape for `skill`. */
  const hook = (o: Orchestrator, skill: string) => {
    const input = JSON.stringify({ session_id: 's', cwd: tmp, permission_mode: 'bypassPermissions', tool_name: 'Skill', tool_input: { skill } });
    // the command runs through `sh -c` as Claude Code runs a hook (the script path is quoted: review-B MINOR-2)
    return Bun.spawnSync(['sh', '-c', settingsOf(o).hooks.PreToolUse[0]!.hooks[0]!.command], { stdin: Buffer.from(input), stdout: 'pipe' }).stdout.toString();
  };
  const spec = (state: 'draft' | 'approved' = 'approved', path = 'docs/specs/a.md') => insertSpec(db, { projectId: 'p1', path, title: 'Spec A', origin: 'app', state });
  beforeEach(() => writeSkillGate());

  test('§5.0 R25 open design → orch_kind design, title "Thiết kế · HH:MM", first message as given; --settings lets brainstorming through', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    const o = await orchs.openKind('p1', { kind: 'design', firstMessage: 'Spec mới cho project.' });
    await reach(orchs, o.currentSessionId, 'idle');
    expect(kindOf(o.currentSessionId)).toBe('design');
    expect(o.kind).toBe('design');
    expect(sessionRow(o.currentSessionId).title).toMatch(/^Thiết kế · \d\d:\d\d$/);
    expect(received(o.view().account!, spawns.filter((s) => s.account === o.view().account).length)[0]).toBe('[cc-slaves] Spec mới cho project.');
    const s = settingsOf(o);
    expect(s.permissions.deny).not.toContain('Skill(superpowers:brainstorming)');
    expect(s.permissions.deny).toContain('Skill(superpowers:writing-plans)');
    expect(hook(o, 'superpowers:brainstorming')).toBe('');
    expect(traceOf(o).argv.join(' ')).toContain('You are a Thiết kế (design) session');
  });

  test('§5.0 §7.2 open build on a spec → orch_kind build, build_session bound after boot; --settings denies brainstorming with the reason', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    const sp = spec();
    const o = await orchs.openKind('p1', { kind: 'build', specId: sp.id, firstMessage: 'Build spec docs/specs/a.md.' });
    await reach(orchs, o.currentSessionId, 'idle');
    expect(kindOf(o.currentSessionId)).toBe('build');
    expect(getSpec(db, sp.id)!.buildSession).toBe(o.currentSessionId);
    expect(settingsOf(o).permissions.deny).toContain('Skill(superpowers:brainstorming)');
    expect(JSON.parse(hook(o, 'superpowers:brainstorming')).hookSpecificOutput.permissionDecisionReason).toStartWith('Bị chặn có chủ ý — phiên Build');
    expect(traceOf(o).argv.join(' ')).toContain('You are the Build session of one approved spec');
    await rejects(orchs.openKind('p1', { kind: 'build', firstMessage: 'x' })).toThrow(); // a Build session needs its spec
  });

  test('§5.2-10 R-B6 build resume → `--resume <id>` spawned in the given cwd; Build rules + first message sent once', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    const sp = spec();
    const wt = join(tmp, 'p1-wt');
    mkdirSync(wt);
    const prior = '0f6c1e9a-1111-4222-8333-944455556666';
    const o = await orchs.openKind('p1', { kind: 'build', specId: sp.id, firstMessage: 'Phiên này giờ là phiên Build.', resume: { sessionId: prior, cwd: wt } });
    await reach(orchs, prior, 'idle');
    expect(o.currentSessionId).toBe(prior);
    const t = traceOf(o);
    expect(t.cwd).toBe(realpathSync(wt));
    expect(t.argv[t.argv.indexOf('--resume') + 1]).toBe(prior);
    expect(t.argv).not.toContain('--session-id');
    const msgs = received(o.view().account!, spawns.filter((s) => s.account === o.view().account).length);
    expect(msgs[0]).toStartWith('[cc-slaves] Quy tắc cc-slaves cho phiên này (Build): You are the Build session');
    expect(msgs[1]).toBe('[cc-slaves] Phiên này giờ là phiên Build.');
    expect(getSpec(db, sp.id)!.buildSession).toBe(prior);
  });

  test('R-B13 (a) a resumed Build session keeps its cwd on the row; a restart (restore) spawns it there again; a root session stores null', async () => {
    const { orchs } = setup();
    const g = await orchs.start('p1');
    const sp = spec();
    const wt = join(tmp, 'p1-wt2');
    mkdirSync(wt);
    const prior = '1f6c1e9a-1111-4222-8333-944455556667';
    await orchs.openKind('p1', { kind: 'build', specId: sp.id, firstMessage: 'x', resume: { sessionId: prior, cwd: wt } });
    await reach(orchs, prior, 'idle');
    const cwdOf = (id: string) => db.query<{ cwd: string | null }, [string]>('SELECT cwd FROM session WHERE id = ?').get(id)!.cwd;
    expect(cwdOf(prior)).toBe(wt);
    expect(cwdOf(g.currentSessionId)).toBeNull();
    await orchs.shutdown();
    const again = setup().orchs;
    const row = db.query<SessionRow, [string]>('SELECT * FROM session WHERE id = ?').get(prior)!;
    const o = await again.restore(row);
    await reach(again, prior, 'idle');
    const last = spawns.filter((x) => x.account === o.view().account).at(-1)!; // a second setup() numbers its spawns from 1 again
    expect((JSON.parse(readFileSync(last.trace, 'utf8')) as { cwd: string }).cwd).toBe(realpathSync(wt));
  });

  test('R-B13 (b) F21 "Phiên mới" on a design / build session moves its spec bindings to the new session id', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    const draft = spec('draft', 'docs/specs/d.md');
    const d = await orchs.openKind('p1', { kind: 'design', specId: draft.id, firstMessage: 'x' });
    await reach(orchs, d.currentSessionId, 'idle');
    const old = d.currentSessionId;
    const r = await d.newSession();
    expect(r.sessionId).not.toBe(old);
    expect(getSpec(db, draft.id)!.designSession).toBe(r.sessionId);
    const b = spec('approved', 'docs/specs/b.md');
    const o = await orchs.openKind('p1', { kind: 'build', specId: b.id, firstMessage: 'y' });
    await reach(orchs, o.currentSessionId, 'idle');
    const nb = await o.newSession();
    expect(getSpec(db, b.id)!.buildSession).toBe(nb.sessionId);
  });

  test('§5.0 R34 2 build + 1 design + Chung open → a 4th design refused with the IS13b text; Chung never counted', async () => {
    const { orchs } = setup();
    await orchs.start('p1'); // Chung
    const a = spec('approved', 'docs/specs/a.md'), b = spec('approved', 'docs/specs/b.md');
    await orchs.openKind('p1', { kind: 'build', specId: a.id, firstMessage: 'a' });
    await orchs.openKind('p1', { kind: 'build', specId: b.id, firstMessage: 'b' });
    await orchs.openKind('p1', { kind: 'design', firstMessage: 'c' });
    const before = spawns.length;
    await rejects(orchs.openKind('p1', { kind: 'design', firstMessage: 'd' })).toThrow('Đã đủ 3 phiên Thiết kế / Build — đóng bớt một phiên');
    expect(spawns.length).toBe(before);
    expect(orchs.list('p1')).toHaveLength(4);
  });

  test('§5.0 R26 the one Chung cannot be ended (only Phiên mới replaces it); ending the last design / build leaves it alone', async () => {
    const { orchs } = setup();
    const g = (await orchs.start('p1')).currentSessionId;
    const d = await orchs.openKind('p1', { kind: 'design', firstMessage: 'x' });
    await reach(orchs, d.currentSessionId, 'idle');
    await rejects(orchs.end(g)).toThrow('Phiên Chung luôn mở — dùng Phiên mới để thay');
    const r = await orchs.end(d.currentSessionId);
    expect(r.to).toBe(g);
    expect(orchs.list('p1').map((o) => o.currentSessionId)).toEqual([g]);
    expect(stateOf(orchs, g)).toBe('idle');
  });

  test('§5.2-8 R-B8 design bound to an approved spec → edit_session; closed without spec_draft → edit_session cleared, still approved', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    const sp = spec('approved');
    const o = await orchs.openKind('p1', { kind: 'design', specId: sp.id, firstMessage: 'Sửa spec docs/specs/a.md: đọc spec, hỏi anh cần sửa gì.' });
    await reach(orchs, o.currentSessionId, 'idle');
    expect(getSpec(db, sp.id)!.editSession).toBe(o.currentSessionId);
    expect(getSpec(db, sp.id)!.designSession).toBeNull();
    await orchs.end(o.currentSessionId);
    expect(getSpec(db, sp.id)).toMatchObject({ editSession: null, state: 'approved' });
  });

  test('§5.2-8 the editing design session called spec_draft (spec back to draft) → closing it keeps edit_session', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    const sp = spec('approved');
    const o = await orchs.openKind('p1', { kind: 'design', specId: sp.id, firstMessage: 'x' });
    await reach(orchs, o.currentSessionId, 'idle');
    moveSpec(db, sp.id, 'draft'); // what G2b's spec_draft does to an approved spec
    await orchs.end(o.currentSessionId);
    expect(getSpec(db, sp.id)).toMatchObject({ editSession: o.currentSessionId, state: 'draft' });
  });

  test('§5.0 R26 ending a design / build session: its lanes default to the Chung session even when it is not the earliest', async () => {
    const { orchs } = setup();
    const g = (await orchs.start('p1')).currentSessionId;
    const d1 = await orchs.openKind('p1', { kind: 'design', firstMessage: 'x' });
    await reach(orchs, g, 'idle');
    const g2 = await orchs.open('p1', { first: 'thay', replaceId: g }); // the Chung now sits after d1
    const d2 = await orchs.openKind('p1', { kind: 'design', firstMessage: 'y' });
    await reach(orchs, d2.currentSessionId, 'idle');
    expect(orchs.list('p1').map((o) => o.currentSessionId)).toEqual([d1.currentSessionId, g2.currentSessionId, d2.currentSessionId]);
    laneRow('D2', d2.currentSessionId);
    expect(await orchs.end(d2.currentSessionId)).toMatchObject({ to: g2.currentSessionId, lanes: ['D2'] });
  });

  test('§4.8 design "Mở phiên" on a draft spec → design_session rebound to the new session (kept after it closes)', async () => {
    const { orchs } = setup();
    await orchs.start('p1');
    const sp = spec('draft');
    const o = await orchs.openKind('p1', { kind: 'design', specId: sp.id, firstMessage: 'x' });
    await reach(orchs, o.currentSessionId, 'idle');
    expect(getSpec(db, sp.id)!.designSession).toBe(o.currentSessionId);
    await orchs.end(o.currentSessionId);
    expect(getSpec(db, sp.id)!.designSession).toBe(o.currentSessionId);
  });

  test('§4.7 spec_draft rename hook: the design session takes the spec title (≤ 24 chars)', async () => {
    const { orchs, events } = setup();
    await orchs.start('p1');
    const o = await orchs.openKind('p1', { kind: 'design', firstMessage: 'x' });
    orchs.titleFromSpec(o.currentSessionId, 'Một tiêu đề spec rất dài vượt quá giới hạn');
    expect(sessionRow(o.currentSessionId).title).toBe('Một tiêu đề spec rất dài');
    expect(events.some((e) => e.type === 'orchestrator' && e.orchestrator.title === 'Một tiêu đề spec rất dài')).toBe(true);
  });

  test('§5.2-5 closeWhenIdle: the build session ends once its turn is over (handoff asked), lanes go to the Chung', async () => {
    const { orchs } = setup();
    const g = (await orchs.start('p1')).currentSessionId;
    const sp = spec();
    const o = await orchs.openKind('p1', { kind: 'build', specId: sp.id, firstMessage: 'x' });
    const sid = o.currentSessionId;
    laneRow('D1', sid);
    const done = orchs.closeWhenIdle(sid); // asked mid-boot: waits for idle
    const r = await done;
    expect(r).toMatchObject({ sessionId: sid, to: g, lanes: ['D1'] });
    expect(sessionRow(sid)).toMatchObject({ state: 'done', end_reason: 'handoff' });
    expect(sessionRow(sid).handoff_path).toContain('.local-check/handoff-');
    expect(orchs.bySession(sid)).toBeNull();
  });

  test('§5.0 R25 a pre-v2.7 session row is general; restore keeps the row\'s kind', async () => {
    const { orchs } = setup();
    const g = await orchs.start('p1');
    expect(kindOf(g.currentSessionId)).toBe('general');
    expect(g.kind).toBe('general');
  });
});

// hf1117-perf a real claude boot (SessionStart hooks) takes seconds: opening a session answers once its row and view exist
describe('hf1117-perf a session opens before its claude boots', () => {
  const BOOT = { FAKE_CLAUDE_BOOT_MS: '1500' };
  const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const r = await f(); return [r, performance.now() - t]; };
  beforeEach(() => writeSkillGate());

  test('openKind (Thiết kế bound to a spec / Build) and open (Chung) resolve while `starting`; the binding is there at once; the boot finishes in the background', async () => {
    const { orchs, events } = setup({ env: BOOT });
    await orchs.start('p1', undefined, true); // held: no process, like project_add
    const sp = insertSpec(db, { projectId: 'p1', path: 'docs/specs/a.md', title: 'Spec A', origin: 'app', state: 'approved' });
    const [b, tb] = await timed(() => orchs.openKind('p1', { kind: 'build', specId: sp.id, firstMessage: 'Build.' }));
    const [d, td] = await timed(() => orchs.openKind('p1', { kind: 'design', firstMessage: 'Spec mới.' }));
    const [g, tg] = await timed(() => orchs.open('p1', { first: 'song song' }));
    for (const t of [tb, td, tg]) expect(t).toBeLessThan(500);
    for (const o of [b, d, g]) expect(o.view().state).toBe('starting');
    expect(getSpec(db, sp.id)!.buildSession).toBe(b.currentSessionId); // R-B8 the row exists before the boot
    expect(events.some((e) => e.type === 'orchestrator' && e.orchestrator.sessionId === d.currentSessionId && e.orchestrator.state === 'starting')).toBe(true);
    for (const o of [b, d, g]) await reach(orchs, o.currentSessionId, 'idle');
  });

  test('a boot that throws (session files) lands as `stopped` + the orchestrator_down card with its reason, never a lost error', async () => {
    const { orchs, events } = setup({ sessionSetup: () => { throw new Error('đĩa đầy'); } });
    const [o, t] = await timed(() => orchs.openKind('p1', { kind: 'design', firstMessage: 'Spec mới.' }));
    expect(t).toBeLessThan(500);
    await reach(orchs, o.currentSessionId, 'stopped');
    const card = events.find((e) => e.type === 'system_card' && e.kind === 'orchestrator_down' && e.sessionId === o.currentSessionId);
    expect(card && card.type === 'system_card' ? card.reason : '').toContain('đĩa đầy');
    expect(sessionRow(o.currentSessionId).state).toBe('stopped');
  });

  test('a held session woken by unpause / restart answers before the boot; a claude that never starts ends `stopped` with the card', async () => {
    const { orchs, events } = setup({ env: BOOT });
    const o = await orchs.start('p1', undefined, true);
    const [, tu] = await timed(() => orchs.unpause('p1'));
    expect(tu).toBeLessThan(500);
    expect(o.view().state).toBe('starting');
    await reach(orchs, o.currentSessionId, 'idle');
    const [, tr] = await timed(() => o.restart());
    expect(tr).toBeLessThan(500);
    expect(o.view().state).toBe('starting');
    await reach(orchs, o.currentSessionId, 'idle');
    const bad = setup({ command: ['/nonexistent/claude'] });
    const x = await bad.orchs.openKind('p1', { kind: 'design', firstMessage: 'x' });
    await reach(bad.orchs, x.currentSessionId, 'stopped');
    expect(bad.events.some((e) => e.type === 'system_card' && e.kind === 'orchestrator_down' && e.sessionId === x.currentSessionId)).toBe(true);
    expect(events.some((e) => e.type === 'system_card')).toBe(false);
  });
});
