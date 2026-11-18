// v2.4 §5.1–§5.3 the orchestrator's model / effort with fake-claude: handshake before the first message, change when idle,
// `pending` while busy (stdin held), cancel, failure, process gone / F21 while waiting, inheritance by a replacing session.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account } from '../src/accounts/registry.ts';
import { QuotaTracker } from '../src/accounts/quota.ts';
import { DEFAULT_CONFIG, type Caps, type ModelDefaults } from '../src/config.ts';
import { getSessionModel, insertProject, openDb, type Db } from '../src/db.ts';
import { Orchestrators, type OrchestratorDeps, type OrchestratorEvent, type OrchestratorState } from '../src/orchestrator/session.ts';
import { Outbox } from '../src/outbox.ts';
import { ModelCache } from '../src/models.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const A = 'a@x.test';
const CAPS: Caps = { default: { week: 98, five: 95 }, [O]: { role: 'orchestrator', week: 99, five: 97 }, [A]: { role: 'primary', week: 99 } };
const SAVED = process.env.CC_SLAVES_HOME;

type Step = Record<string, unknown>;
const assistant: Step = { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: '…' }] } } };
const result: Step = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } };
const wait: Step = { waitUser: true };
const turn = (ms = 0): Step[] => [wait, assistant, ...(ms ? [{ sleep: ms }] : []), result];
const turns = (n: number, ms = 0): Step[] => Array.from({ length: n }, () => turn(ms)).flat();

let tmp: string;
let db: Db;
let spawns: { account: string; n: number; trace: string; stdin: string }[];
let closers: (() => Promise<void>)[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-orch-model-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  db = openDb(join(tmp, 'state.db'));
  mkdirSync(join(tmp, 'p1'), { recursive: true });
  insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1'), orchestratorAccount: O });
  spawns = [];
  closers = [];
  defaults = DEFAULT_CONFIG.modelDefaults;
});
afterEach(async () => {
  for (const c of closers) await c();
  db.close();
  if (SAVED === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = SAVED;
  rmSync(tmp, { recursive: true, force: true });
});

const account = (email: string): Account => ({ email, id: null, configDir: join(tmp, `cfg-${email}`), keychainService: `k-${email}`, planTier: 'max', terminal: false });

let defaults: ModelDefaults = DEFAULT_CONFIG.modelDefaults;
function setup(scenario: (email: string, n: number) => object) {
  const accounts = [O, A].map(account);
  const counts = new Map<string, number>();
  const events: OrchestratorEvent[] = [];
  const outbox = new Outbox(db);
  const tracker = new QuotaTracker({ db, source: { fetchUsage: () => Promise.reject(new Error('no network in tests')) }, onAccountChanged: () => {} });
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
  const od: OrchestratorDeps = {
    db, outbox, accounts: () => accounts, quota: tracker, caps: () => CAPS, command: ['bun', FAKE], mcpPort: 1, env,
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 500 }, closeGraceMs: 300, handoffTimeoutMs: 5000, modelCache: new ModelCache(),
    modelDefaults: () => defaults,
  };
  const orchs = new Orchestrators(od);
  orchs.on((e) => events.push(e));
  closers.push(() => orchs.shutdown());
  return { orchs, events, outbox };
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
/** stdin of one fake process, as `user:<text>` / `ctl:<subtype>[:model]`. */
const stdin = (email: string, n: number): string[] => {
  const f = spawn(email, n)?.stdin;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: string }; request?: { subtype: string; model?: string } })
    .flatMap((l) => (l.type === 'user' ? [`user:${l.message!.content}`]
      : l.type === 'control_request' ? [`ctl:${l.request!.subtype}${l.request!.subtype === 'set_model' ? `:${l.request!.model ?? '{}'}` : ''}`] : []));
};
const users = (email: string, n: number) => stdin(email, n).filter((l) => l.startsWith('user:'));
const state = (orchs: Orchestrators) => orchs.get('p1')?.view().state;
/** hf1117-perf `open` answers before the claude boot: wait for the boot (its trace) before reading argv. */
const booted = (o: { view: () => { state: OrchestratorState } }) => until(() => o.view().state === 'idle', 'the new session idle');
const reach = (orchs: Orchestrators, s: OrchestratorState) => until(() => state(orchs) === s, `orchestrator ${s} (now ${state(orchs)})`);
const MODELS_PLUS_FAKE = { models: [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', supportedEffortLevels: ['low', 'high'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'high'] },
  { value: 'claude-fake', resolvedModel: 'claude-fake', displayName: 'Fake', supportedEffortLevels: ['low', 'high'] },
] };

describe('handshake (v2.4 §5.2)', () => {
  test('§5.2 pick null, applied ≠ configured default → set_model {default} before the first user line; view + last*', async () => {
    const { orchs } = setup(() => ({ steps: turns(4), control: { ...MODELS_PLUS_FAKE, sources: [{ source: 'userSettings', settings: { model: 'sonnet' } }] } }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    expect(stdin(O, 1).slice(0, 5)).toEqual(['ctl:get_settings', 'ctl:list_models', 'ctl:set_model:sonnet', 'ctl:get_settings', expect.stringMatching(/^user:/)]);
    expect(o.view()).toMatchObject({ modelName: 'Sonnet 5.5', modelPick: null, modelMismatch: false });
    expect(getSessionModel(db, o.currentSessionId)).toMatchObject({ lastModel: 'claude-sonnet-5-5', lastModelName: 'Sonnet 5.5' });
  });

  test('§5.2 a pick goes on argv; Claude Code runs another model → modelMismatch, no retry', async () => {
    const { orchs } = setup(() => ({ steps: turns(4), control: { pin: { model: 'claude-opus-5-5' } } }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    expect(await o.setModel({ model: 'sonnet' })).toBe('now');
    await o.restart();
    await reach(orchs, 'idle');
    expect(argvOf(O, 2)[argvOf(O, 2).indexOf('--model') + 1]).toBe('sonnet');
    expect(stdin(O, 2).filter((l) => l.startsWith('ctl:set_model'))).toEqual([]);
    expect(o.view().modelMismatch).toBe(true);
  });
});

describe('Cài đặt › Điều phối (v2.4 §5.6)', () => {
  test('§5.6 tier 3 on argv at spawn; a Settings change mid-run sends nothing (snapshot); the next spawn takes the new row', async () => {
    defaults = { orchestrator: { model: 'sonnet', effort: 'low' }, lane: { model: 'claude-fake', effort: null } };
    const { orchs } = setup(() => ({ steps: turns(4), control: { ...MODELS_PLUS_FAKE, sources: [{ source: 'userSettings', settings: { model: 'claude-fake' } }] } }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    const a1 = argvOf(O, 1);
    expect([a1[a1.indexOf('--model') + 1], a1[a1.indexOf('--effort') + 1]]).toEqual(['sonnet', 'low']);
    defaults = { orchestrator: { model: 'claude-fake', effort: null }, lane: defaults.lane };
    await o.send('hi', null);
    await until(() => users(O, 1).length >= 2, 'second turn');
    await reach(orchs, 'idle');
    await Bun.sleep(100); // the after-result re-read
    expect(stdin(O, 1).filter((l) => l.startsWith('ctl:set_model'))).toEqual([]); // no reset toward settings.json either
    expect(o.view()).toMatchObject({ modelPick: null, modelMismatch: false });
    await o.restart();
    await reach(orchs, 'idle');
    expect(argvOf(O, 2)[argvOf(O, 2).indexOf('--model') + 1]).toBe('claude-fake');
    expect(argvOf(O, 2)).not.toContain('--effort');
  });
});

describe('change mid-session (v2.4 §5.3)', () => {
  test('§5.3 idle → set_model now: view, pick, model_change event; nothing held', async () => {
    const { orchs, events } = setup(() => ({ steps: turns(4) }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    expect(await o.setModel({ model: 'sonnet', effort: 'low' })).toBe('now');
    expect(o.view()).toMatchObject({ modelName: 'Sonnet 5.5', effort: 'low', modelPick: 'sonnet', effortPick: 'low' });
    expect(events.find((e) => e.type === 'model_change')).toMatchObject({ to: { modelName: 'Sonnet 5.5', effort: 'low' } });
    await o.send('after');
    await until(() => users(O, 1).some((l) => l.includes('after')), 'message written');
  });

  test('§5.3 busy → pending; no change request before the result; PO + lane messages held until the control_response', async () => {
    const { orchs, events } = setup(() => ({ steps: [...turn(), ...turn(800), ...turns(4)] }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    await o.send('go');
    await reach(orchs, 'running');
    expect(await o.setModel({ model: 'sonnet' })).toBe('pending');
    expect(o.view().pending).toEqual({ model: 'sonnet', modelName: 'Sonnet 5.5' });
    await o.send('held PO');
    orchs.notify('p1', 'held lane');
    await Bun.sleep(200);
    expect(stdin(O, 1).some((l) => l.startsWith('ctl:set_model'))).toBe(false);
    expect(users(O, 1).some((l) => l.includes('held'))).toBe(false);
    await until(() => users(O, 1).some((l) => l.includes('held PO')), 'held rows written');
    const s = stdin(O, 1);
    expect(s.indexOf('ctl:set_model:sonnet')).toBeLessThan(s.findIndex((l) => l.includes('held PO')));
    expect(s.findIndex((l) => l.includes('held lane'))).toBeGreaterThan(s.indexOf('ctl:set_model:sonnet'));
    expect(o.view().pending).toBeUndefined();
    expect(o.view().modelPick).toBe('sonnet');
    expect(events.some((e) => e.type === 'model_change' && !e.error)).toBe(true);
  });

  test('§5.3 "Bỏ thay đổi đang chờ" → pending gone, held rows go out at once, no set_model', async () => {
    const { orchs } = setup(() => ({ steps: [...turn(), ...turn(1500), ...turns(4)] }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    await o.send('go');
    await reach(orchs, 'running');
    await o.setModel({ model: 'sonnet' });
    await o.send('held');
    await o.cancelModel();
    expect(o.view().pending).toBeUndefined();
    await until(() => users(O, 1).some((l) => l.includes('held')), 'flushed on cancel', 1000);
    await reach(orchs, 'idle');
    expect(stdin(O, 1).some((l) => l.startsWith('ctl:set_model'))).toBe(false);
    expect(o.view().modelPick).toBeNull();
  });

  test('§5.3 apply fails (not_found) → pending dropped, error event, held rows go out on the old model', async () => {
    const { orchs, events } = setup(() => ({ steps: [...turn(), ...turn(600), ...turns(4)], control: { fail: { set_model: 'not_found' } } }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    await o.send('go');
    await reach(orchs, 'running');
    await o.setModel({ model: 'nope' });
    await o.send('held');
    await until(() => users(O, 1).some((l) => l.includes('held')), 'held rows written after the failure');
    expect(events.find((e) => e.type === 'model_change')).toMatchObject({ error: { code: 'model_not_found' } });
    expect(o.view().pending).toBeUndefined();
    expect(o.view().modelPick).toBeNull();
  });

  test('§5.3 a written row unreplayed at the result → waits for the next result; then 2 s with no new turn → applied', async () => {
    // manual replay: "B" (written mid-turn) stays unreplayed at turn 2's result and never opens a turn
    const { orchs } = setup(() => ({ replay: 'manual', steps: [wait, { flushReplay: true }, assistant, result, wait, { flushReplay: true }, assistant, { sleep: 600 }, result] }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    const go = (await o.send('go'))!;
    // "B" only after "go" was replayed: else the fake's flushReplay step could replay "B" too
    await until(() => db.query<{ d: number | null }, [string]>('SELECT delivered_at AS d FROM outbox WHERE uuid = ?').get(go)?.d != null, 'go replayed');
    await o.send('B');
    expect(await o.setModel({ model: 'sonnet' })).toBe('pending');
    await reach(orchs, 'idle');
    const t0 = Date.now();
    await Bun.sleep(500);
    expect(stdin(O, 1).some((l) => l.startsWith('ctl:set_model'))).toBe(false);
    await until(() => stdin(O, 1).includes('ctl:set_model:sonnet'), 'applied after the grace');
    expect(Date.now() - t0).toBeGreaterThan(1200);
    await until(() => o.view().pending === undefined, 'pending cleared');
  });

  test('§5.3 idle but a written row still unreplayed → pending, then 2 s with no new turn → applied; a later message reaches stdin', async () => {
    const { orchs } = setup(() => ({ replay: 'manual', steps: [wait, { flushReplay: true }, assistant, result, wait, { flushReplay: true }, assistant, { sleep: 600 }, result, ...turns(3)] }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    const go = (await o.send('go'))!;
    await until(() => db.query<{ d: number | null }, [string]>('SELECT delivered_at AS d FROM outbox WHERE uuid = ?').get(go)?.d != null, 'go replayed');
    await o.send('B');
    expect(await o.setModel({ model: 'sonnet' })).toBe('pending');
    await reach(orchs, 'idle');
    await until(() => o.view().pending === undefined, 'first pending cleared');
    await reach(orchs, 'idle');
    // "B" is still written and unreplayed: this change goes pending on an idle process and needs its own grace
    expect(await o.setModel({ effort: 'high' })).toBe('pending');
    await o.send('C');
    await until(() => users(O, 1).includes('user:C'), 'C on stdin after the grace');
    expect(o.view().pending).toBeUndefined();
    expect(stdin(O, 1).indexOf('ctl:apply_flag_settings')).toBeLessThan(stdin(O, 1).indexOf('user:C'));
  });

  test('§5.2 a PO pick made while the after-result re-read is in flight is not undone by the once-per-process reset', async () => {
    const { orchs } = setup(() => ({ steps: turns(4), control: { ...MODELS_PLUS_FAKE, sources: [{ source: 'userSettings', settings: { model: 'sonnet' } }], pin: { model: 'claude-fake' }, delayMs: { get_settings: 700, set_model: 1500 } } }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    expect(await o.setModel({ model: 'default' })).toBe('now');
    await Bun.sleep(3000);
    expect(o.view().modelPick).toBe('default');
    expect(stdin(O, 1).filter((l) => l.startsWith('ctl:set_model'))).toEqual(['ctl:set_model:sonnet', 'ctl:set_model:default']);
  });

  test('§5.3 interrupt timed out (turn still alive) is not the end of the turn: pending stays until the real result', async () => {
    const { orchs } = setup(() => ({ steps: [...turn(), ...turn(1500), ...turns(4)] }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    await o.send('go');
    await reach(orchs, 'running');
    await o.setModel({ model: 'sonnet' });
    await o.interrupt(); // fake ignores it mid-sleep → timedOut after 500 ms
    expect(o.view().pending).toEqual({ model: 'sonnet', modelName: 'Sonnet 5.5' });
    expect(stdin(O, 1).some((l) => l.startsWith('ctl:set_model'))).toBe(false);
    await until(() => stdin(O, 1).includes('ctl:set_model:sonnet'), 'applied at the real result');
  });

  test('§5.3 no process (stopped) → saved; the next spawn gets it on argv', async () => {
    const { orchs } = setup(() => ({ steps: turns(4) }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    await orchs.shutdown();
    expect(await o.setModel({ effort: 'high' })).toBe('saved');
    expect(getSessionModel(db, o.currentSessionId).effortPick).toBe('high');
  });
});

describe('process gone while pending (v2.4 §5.3)', () => {
  test('§5.3 death mid-turn while pending → the change is the pick; the resumed process gets --model', async () => {
    const { orchs } = setup((_e, n) => ({ steps: n === 1 ? [...turn(), wait, assistant, { sleep: 400 }, { die: {} }] : turns(4) }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    await o.send('go');
    await reach(orchs, 'running');
    expect(await o.setModel({ model: 'sonnet' })).toBe('pending');
    await until(() => spawn(O, 2) !== undefined && existsSync(spawn(O, 2)!.trace), 'resumed');
    await reach(orchs, 'idle');
    expect(argvOf(O, 2)[argvOf(O, 2).indexOf('--model') + 1]).toBe('sonnet');
    expect(o.view().pending).toBeUndefined();
    expect(getSessionModel(db, o.currentSessionId).modelPick).toBe('sonnet');
  });

  test('§5.3 F21 while held → only the handoff request reaches the old stdin; held row moves to the new session, which inherits the pick', async () => {
    // the new process answers no control request: the new row has the picks without a handshake writing them
    const { orchs } = setup((_e, n) => (n === 1 ? { steps: [...turn(), ...turn(800), ...turns(3)] } : { steps: turns(4), control: { fail: { get_settings: 'unsupported_request' } } }));
    const o = await orchs.start('p1');
    await reach(orchs, 'idle');
    const old = o.currentSessionId;
    await o.send('go');
    await reach(orchs, 'running');
    await o.setModel({ effort: 'low' });
    await o.send('held one');
    const r = await o.newSession(join(tmp, 'handoff.md'));
    expect(r.sessionId).not.toBe(old);
    const before = users(O, 1);
    expect(before.some((l) => l.includes('held one'))).toBe(false);
    expect(before.some((l) => l.includes('handoff'))).toBe(true);
    await reach(orchs, 'idle');
    expect(users(O, 2).some((l) => l.includes('held one'))).toBe(true);
    expect(argvOf(O, 2)[argvOf(O, 2).indexOf('--effort') + 1]).toBe('low');
    expect(getSessionModel(db, r.sessionId).effortPick).toBe('low');
  });

  test('§5.1 open "Thay" → the replacing session inherits the replaced one\'s picks', async () => {
    const { orchs } = setup(() => ({ steps: turns(6) }));
    const a = await orchs.start('p1');
    await reach(orchs, 'idle');
    await a.setModel({ model: 'sonnet', effort: 'low' });
    const b = await orchs.open('p1', { replaceId: a.currentSessionId, first: 'hi' });
    await booted(b);
    expect(getSessionModel(db, b.currentSessionId)).toMatchObject({ modelPick: 'sonnet', effortPick: 'low' });
    const last = spawns.at(-1)!;
    const argv = argvOf(last.account, last.n);
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(orchs.preview(a.currentSessionId)).toMatchObject({ modelPick: 'sonnet', effortPick: 'low', modelName: 'Sonnet 5.5' });
  });

  test('§5.5 session_open model / effort → picks + argv; "Thay" with its own picks: the dialog wins over the inherited ones', async () => {
    const { orchs } = setup(() => ({ steps: turns(6) }));
    const a = await orchs.start('p1');
    await reach(orchs, 'idle');
    await a.setModel({ model: 'sonnet', effort: 'low' });
    const b = await orchs.open('p1', { first: 'hi', model: 'haiku', effort: 'high' });
    await booted(b);
    expect(getSessionModel(db, b.currentSessionId)).toMatchObject({ modelPick: 'haiku', effortPick: 'high' });
    let last = spawns.at(-1)!;
    let argv = argvOf(last.account, last.n);
    expect([argv[argv.indexOf('--model') + 1], argv[argv.indexOf('--effort') + 1]]).toEqual(['haiku', 'high']);
    const c = await orchs.open('p1', { replaceId: a.currentSessionId, first: 'hi', model: null });
    await booted(c);
    expect(getSessionModel(db, c.currentSessionId)).toMatchObject({ modelPick: null, effortPick: 'low' }); // null = "Theo mặc định"
    last = spawns.at(-1)!;
    argv = argvOf(last.account, last.n);
    expect(argv.includes('--model')).toBe(false);
    expect(argv[argv.indexOf('--effort') + 1]).toBe('low');
  });
});
