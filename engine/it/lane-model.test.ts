// v2.4 §5.6 D55 a lane's model / effort against fake-claude: tiers on argv, handshake, chip change now / pending (stdin
// held until result_ok), cancel, settle on cap / switch, Settings › Lane, mismatch, done lane.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account } from '../src/accounts/registry.ts';
import { QuotaTracker } from '../src/accounts/quota.ts';
import { DEFAULT_CONFIG, type Caps, type ModelDefaults } from '../src/config.ts';
import { getLane, insertProject, openDb, type Db, type LaneState } from '../src/db.ts';
import { LaneError, LaneManager, type LaneUiEvent } from '../src/lane/manager.ts';
import { ModelSource } from '../src/models.ts';
import { Outbox } from '../src/outbox.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const A = 'a@x.test';
const B = 'b@x.test';
const CAPS: Caps = { default: { week: 98, five: 95 } };
const SAVED = process.env.CC_SLAVES_HOME;

type Step = Record<string, unknown>;
const assistant: Step = { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: '…' }] } } };
const result: Step = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } };
const limit: Step = { emit: { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm", num_turns: 1, permission_denials: [] } };
const wait: Step = { waitUser: true };
const turn = (ms = 0, end: Step = result): Step[] => [wait, assistant, ...(ms ? [{ sleep: ms }] : []), end];
const turns = (n: number): Step[] => Array.from({ length: n }, () => turn()).flat();

let tmp: string;
let db: Db;
let mgr: LaneManager | null;
let defaults: ModelDefaults;
let spawns: { account: string; n: number; trace: string; stdin: string }[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-lmodel-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  db = openDb(join(tmp, 'state.db'));
  insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1') });
  spawns = [];
  mgr = null;
  defaults = DEFAULT_CONFIG.modelDefaults;
});
afterEach(async () => {
  await mgr?.shutdown();
  db.close();
  if (SAVED === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = SAVED;
  rmSync(tmp, { recursive: true, force: true });
});

const account = (email: string): Account => ({ email, id: null, configDir: join(tmp, `cfg-${email}`), keychainService: `k-${email}`, planTier: 'max', terminal: false });

function setup(scenario: (email: string, n: number) => object, handshakeTimeoutMs?: number) {
  const accounts = [A, B].map(account);
  const counts = new Map<string, number>();
  const logs: string[] = [];
  const tracker = new QuotaTracker({ db, source: { fetchUsage: () => Promise.reject(new Error('no network in tests')) }, onAccountChanged: () => {} });
  const m = new LaneManager({
    db, outbox: new Outbox(db), accounts: () => accounts, quota: tracker, caps: () => CAPS,
    config: () => ({ maxLanes: 8, maxLanesPerAccount: 3 }), command: ['bun', FAKE], mcpPort: 1,
    env: (a) => {
      const n = (counts.get(a.email) ?? 0) + 1;
      counts.set(a.email, n);
      const file = join(tmp, `scn-${a.email}-${n}.json`);
      writeFileSync(file, JSON.stringify(scenario(a.email, n)));
      const trace = join(tmp, `trace-${a.email}-${n}.json`), stdin = join(tmp, `stdin-${a.email}-${n}.jsonl`);
      spawns.push({ account: a.email, n, trace, stdin });
      return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_TRACE: trace, FAKE_CLAUDE_STDIN_LOG: stdin };
    },
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 300, sleep: async () => {}, ps: async () => [], ...(handshakeTimeoutMs ? { handshakeTimeoutMs } : {}) },
    closeGraceMs: 300, modelDefaults: () => defaults, log: (l) => logs.push(l),
  });
  mgr = m;
  const events: LaneUiEvent[] = [];
  m.on((e) => events.push(e));
  return { m, events, logs };
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
const spawnOf = (email: string, n: number) => spawns.find((s) => s.account === email && s.n === n);
const argvOf = (email: string, n: number): string[] => (JSON.parse(readFileSync(spawnOf(email, n)!.trace, 'utf8')) as { argv: string[] }).argv;
const flag = (argv: string[], f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
/** stdin of one fake process, as `user:<text>` / `ctl:<subtype>[:model]`. */
const stdin = (email: string, n: number): string[] => {
  const f = spawnOf(email, n)?.stdin;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: string }; request?: { subtype: string; model?: string } })
    .flatMap((l) => (l.type === 'user' ? [`user:${l.message!.content}`]
      : l.type === 'control_request' ? [`ctl:${l.request!.subtype}${l.request!.subtype === 'set_model' ? `:${l.request!.model ?? '{}'}` : ''}`] : []));
};
const sets = (email: string, n: number) => stdin(email, n).filter((l) => l.startsWith('ctl:set_model'));
const agentFile = (dir: string, file: string, fm: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, file), `---\n${fm}\n---\nbody\n`); };

describe('tiers on argv (v2.4 §5.6)', () => {
  test('§5.6 Settings › Lane → lane_start without model runs it (--model/--effort); lane_start model wins (tier 1)', async () => {
    defaults = { ...defaults, lane: { model: 'sonnet', effort: 'low' } };
    const { m } = setup(() => ({ steps: turns(3) }));
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    expect([flag(argvOf(A, 1), '--model'), flag(argvOf(A, 1), '--effort')]).toEqual(['sonnet', 'low']);
    expect(m.get('p1', 'D1')!.run).toEqual({ model: 'sonnet', modelName: 'Sonnet 5.5', effort: 'low' });
    await m.start(startArgs('D2', { model: 'opus' }));
    await reach(m, 'D2', 'idle');
    expect([flag(argvOf(A, 2), '--model'), flag(argvOf(A, 2), '--effort')]).toEqual(['opus', 'low']);
  });

  test('§5.6 agent frontmatter (by name:, project before account) beats Settings; not found → Settings + a log line', async () => {
    defaults = { ...defaults, lane: { model: 'sonnet', effort: 'low' } };
    const { m, logs } = setup(() => ({ steps: turns(3) }));
    const a = startArgs('D1', { agent: 'coder-medium' });
    agentFile(join(account(A).configDir, 'agents'), 'c.md', 'name: coder-medium\nmodel: haiku\neffort: high');
    agentFile(join(a.cwd, '.claude', 'agents', 'team'), 'coder.md', 'name: coder-medium\nmodel: opus\neffort: medium');
    await m.start(a);
    await reach(m, 'D1', 'idle');
    expect([flag(argvOf(A, 1), '--agent'), flag(argvOf(A, 1), '--model'), flag(argvOf(A, 1), '--effort')]).toEqual(['coder-medium', 'opus', 'medium']);
    await m.start(startArgs('D2', { agent: 'ghost' }));
    await reach(m, 'D2', 'idle');
    expect(flag(argvOf(A, 2), '--model')).toBe('sonnet');
    expect(logs.some((l) => l.includes('ghost'))).toBe(true);
  });

  test('§5.6 Settings › Lane model the account lacks → applied differs → modelMismatch (no set_model)', async () => {
    defaults = { ...defaults, lane: { model: 'sonnet', effort: null } };
    const { m } = setup(() => ({ steps: turns(3), control: { pin: { model: 'claude-opus-5-5' } } }));
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    await until(() => m.get('p1', 'D1')!.modelMismatch === true, 'mismatch');
    expect(sets(A, 1)).toEqual([]);
    // MD9 names the source: session_models {lane} answers from the lane's own process with defaultSource "settings"
    const sc = m.modelScope('p1', 'D1');
    const src = new ModelSource({ cache: m.modelCache, configDir: () => null, flagged: () => true, preSpawn: () => false, command: [], env: () => ({}) });
    expect(await src.list(sc.account!, sc.dir, sc.own, sc.tier)).toMatchObject({ defaultModel: 'sonnet', defaultModelName: 'Sonnet 5.5', defaultSource: 'settings', defaultEffort: null });
  });

  test('§5.6 session_models {lane} with an agent: defaultSource "agent" + its name', async () => {
    defaults = { ...defaults, lane: { model: 'sonnet', effort: 'low' } };
    const { m } = setup(() => ({ steps: turns(3) }));
    const a = startArgs('D1', { agent: 'reviewer-high' });
    agentFile(join(a.cwd, '.claude', 'agents'), 'r.md', 'name: reviewer-high\nmodel: opus\neffort: high');
    await m.start(a);
    await reach(m, 'D1', 'idle');
    const sc = m.modelScope('p1', 'D1');
    const src = new ModelSource({ cache: m.modelCache, configDir: () => null, flagged: () => true, preSpawn: () => false, command: [], env: () => ({}) });
    expect(await src.list(sc.account!, sc.dir, sc.own, sc.tier)).toMatchObject({ defaultModel: 'opus', defaultSource: 'agent', defaultAgent: 'reviewer-high', defaultEffort: 'high' });
  });
});

describe('chip change (v2.4 §5.6 / §5.3 on a lane)', () => {
  test('§5.6 idle → set_model now; LaneView.run + pick; model_change event (§4.3 line)', async () => {
    const { m, events } = setup(() => ({ steps: turns(3) }));
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    expect(await m.setModel('p1', 'D1', { model: 'sonnet', effort: 'high' })).toBe('now');
    expect(sets(A, 1)).toEqual(['ctl:set_model:sonnet']);
    expect(m.get('p1', 'D1')!.run).toMatchObject({ modelName: 'Sonnet 5.5', effort: 'high' });
    expect(getLane(db, 'p1', 'D1')).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(events.find((e) => e.type === 'model_change')).toMatchObject({ name: 'D1', to: { modelName: 'Sonnet 5.5', effort: 'high' } });
  });

  test('§5.6 "Theo mặc định" on a lane sends its tiers 2–4 resolved at the click (Settings › Lane changed since spawn)', async () => {
    const { m } = setup(() => ({ steps: turns(3) }));
    await m.start(startArgs('D1', { model: 'opus' }));
    await reach(m, 'D1', 'idle');
    defaults = { ...defaults, lane: { model: 'haiku', effort: null } };
    expect(await m.setModel('p1', 'D1', { model: null })).toBe('now');
    expect(sets(A, 1)).toEqual(['ctl:set_model:haiku']);
    expect(getLane(db, 'p1', 'D1')!.model).toBeNull();
    expect(m.get('p1', 'D1')).toMatchObject({ run: { modelName: 'Haiku 5.5' }, modelMismatch: false });
  });

  test('§5.6 busy → pending; no set_model before result; a lane_message sent meanwhile reaches stdin only after the control_response', async () => {
    const { m } = setup(() => ({ steps: [...turn(), ...turn(800), ...turns(3)] }));
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    await m.message('p1', 'D1', 'go', 'orchestrator');
    await until(() => stdin(A, 1).some((l) => l.includes('go')), 'turn 2 written');
    expect(await m.setModel('p1', 'D1', { model: 'sonnet' })).toBe('pending');
    expect(m.get('p1', 'D1')!.pending).toEqual({ model: 'sonnet', modelName: 'Sonnet 5.5' });
    await m.message('p1', 'D1', 'held', 'orchestrator');
    await Bun.sleep(200);
    expect(sets(A, 1)).toEqual([]);
    expect(stdin(A, 1).some((l) => l.includes('held'))).toBe(false);
    await until(() => stdin(A, 1).some((l) => l.includes('held')), 'held row written');
    const s = stdin(A, 1);
    expect(s.indexOf('ctl:set_model:sonnet')).toBeGreaterThan(-1);
    expect(s.indexOf('ctl:set_model:sonnet')).toBeLessThan(s.findIndex((l) => l.includes('held')));
    expect(m.get('p1', 'D1')!.pending).toBeUndefined();
    expect(getLane(db, 'p1', 'D1')!.model).toBe('sonnet');
    await reach(m, 'D1', 'idle');
  });

  test('§5.6 lane_model_cancel → held row goes out at once, no set_model, pick unchanged', async () => {
    const { m } = setup(() => ({ steps: [...turn(), ...turn(1500), ...turns(3)] }));
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    await m.message('p1', 'D1', 'go', 'orchestrator');
    await until(() => stdin(A, 1).some((l) => l.includes('go')), 'turn 2 written');
    await m.setModel('p1', 'D1', { model: 'sonnet' });
    await m.message('p1', 'D1', 'held', 'orchestrator');
    await m.cancelModel('p1', 'D1');
    expect(m.get('p1', 'D1')!.pending).toBeUndefined();
    await until(() => stdin(A, 1).some((l) => l.includes('held')), 'flushed on cancel', 1000);
    expect(sets(A, 1)).toEqual([]);
    expect(getLane(db, 'p1', 'D1')!.model).toBeNull();
  });

  test('§5.6 limit result while pending → settle: pick on the lane row, held row not written to the old process; the new account gets --model', async () => {
    const { m } = setup((email) => (email === A ? { steps: [...turn(), ...turn(600, limit)] } : { steps: turns(3) }));
    await m.start(startArgs('D1', { account: A }));
    await reach(m, 'D1', 'idle');
    await m.message('p1', 'D1', 'go', 'orchestrator');
    await until(() => stdin(A, 1).some((l) => l.includes('go')), 'turn 2 written');
    expect(await m.setModel('p1', 'D1', { model: 'sonnet' })).toBe('pending');
    await m.message('p1', 'D1', 'held', 'orchestrator');
    await until(() => spawnOf(B, 1) !== undefined && existsSync(spawnOf(B, 1)!.trace), 'switched to B');
    expect(getLane(db, 'p1', 'D1')!.model).toBe('sonnet');
    expect(stdin(A, 1).some((l) => l.includes('held'))).toBe(false);
    expect(sets(A, 1)).toEqual([]);
    expect(flag(argvOf(B, 1), '--model')).toBe('sonnet');
    await until(() => stdin(B, 1).some((l) => l.includes('held')), 'held row delivered on B');
  });

  test('§5.6 a change made before the handshake ended is applied in it, before the first user line', async () => {
    const { m } = setup(() => ({ steps: turns(3), control: { delayMs: { get_settings: 400 } } }));
    await m.start(startArgs('D1'));
    await until(() => m.get('p1', 'D1')!.alive, 'process up');
    expect(await m.setModel('p1', 'D1', { model: 'sonnet' })).toBe('pending');
    await reach(m, 'D1', 'idle');
    const s = stdin(A, 1);
    expect(s.indexOf('ctl:set_model:sonnet')).toBeGreaterThan(-1);
    expect(s.indexOf('ctl:set_model:sonnet')).toBeLessThan(s.findIndex((l) => l.startsWith('user:')));
    expect(m.get('p1', 'D1')!.pending).toBeUndefined();
  });

  test('§5.6 A1 slow handshake: the whole chain ≤ 5 s; nothing changes the model during the first turn; never applied twice', async () => {
    const { m } = setup(() => ({ steps: [...turn(4000), ...turns(2)], control: { delayMs: { get_settings: 2000, set_model: 4700 } } }));
    await m.start(startArgs('D1'));
    await until(() => m.get('p1', 'D1')!.alive, 'process up');
    expect(await m.setModel('p1', 'D1', { model: 'sonnet', effort: 'high' })).toBe('pending');
    await until(() => stdin(A, 1).some((l) => l.startsWith('user:')), 'first user line', 9000);
    await Bun.sleep(2500);
    expect(stateOf(m, 'D1')).toBe('running');
    const isChange = (l: string) => l.startsWith('ctl:set_model') || l === 'ctl:apply_flag_settings';
    const s = stdin(A, 1), first = s.findIndex((l) => l.startsWith('user:'));
    expect(s.slice(first + 1).filter(isChange)).toEqual([]);
    await reach(m, 'D1', 'idle');
    expect(sets(A, 1).filter((l) => l === 'ctl:set_model:sonnet').length).toBeLessThanOrEqual(1);
  });

  test('§5.6 A1 the first turn started before the handshake ended → the change waits for its result_ok, then goes out once', async () => {
    const { m } = setup(() => ({ steps: [...turn(3000), ...turns(2)], control: { delayMs: { get_settings: 2000 } } }), 1000);
    await m.start(startArgs('D1'));
    await until(() => m.get('p1', 'D1')!.alive, 'process up');
    expect(await m.setModel('p1', 'D1', { model: 'sonnet' })).toBe('pending');
    await until(() => stdin(A, 1).some((l) => l.startsWith('user:')), 'first user line (cap 1 s)');
    await Bun.sleep(1800); // the handshake has ended, the first turn still runs
    expect(stateOf(m, 'D1')).toBe('running');
    expect(sets(A, 1)).toEqual([]);
    expect(m.get('p1', 'D1')!.pending).toEqual({ model: 'sonnet', modelName: 'Sonnet 5.5' });
    await until(() => sets(A, 1).length > 0, 'applied at result_ok');
    await until(() => m.get('p1', 'D1')!.pending === undefined, 'pending cleared after the read-back');
    expect(sets(A, 1)).toEqual(['ctl:set_model:sonnet']);
  });

  test('§5.6 stopped → saved; lane_resume puts the pick on argv; a done lane → bad_state', async () => {
    const { m } = setup(() => ({ steps: turns(3) }));
    await m.start(startArgs('D1'));
    await reach(m, 'D1', 'idle');
    await m.stop('p1', 'D1', 'now');
    await reach(m, 'D1', 'stopped');
    expect(await m.setModel('p1', 'D1', { model: 'sonnet', effort: 'max' })).toBe('saved');
    await m.resume('p1', 'D1');
    await until(() => spawnOf(A, 2) !== undefined && existsSync(spawnOf(A, 2)!.trace), 'respawn');
    expect([flag(argvOf(A, 2), '--model'), flag(argvOf(A, 2), '--effort')]).toEqual(['sonnet', 'max']);
    await reach(m, 'D1', 'idle');
    await m.finish('p1', 'D1', true);
    await reach(m, 'D1', 'done');
    const e = await m.setModel('p1', 'D1', { model: 'opus' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LaneError);
    expect((e as LaneError).code).toBe('bad_state');
  });
});
