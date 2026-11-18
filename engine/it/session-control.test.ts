// v2.4 G1a: SessionProcess.control(), beforeFirstWrite, the hold flag, and the fake-claude pieces they drive (§5.2, §5.3,
// §6.6, §10.2).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, type Db } from '../src/db.ts';
import { Outbox } from '../src/outbox.ts';
import { childEnv } from '../src/session/env.ts';
import { SessionProcess, type SessionOptions } from '../src/session/process.ts';
import { UpdateGate } from '../src/update/commit.ts';
import type { StreamEvent } from '../src/stream/parser.ts';

const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const EMAIL = 'po@example.com';
const SAVED = { home: process.env.CC_SLAVES_HOME, cj: process.env.CLAUDE_JSON };
const ARGS = { settingsPath: '/h/deny.json', mcpConfigPath: '/h/mcp.json', appendSystemPrompt: 'vai trò' };

let tmp: string;
let db: Db;
let outbox: Outbox;
let live: SessionProcess[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-ctl-'));
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

/** A scenario: answer every user line containing "go" with a short success result, forever. */
function make(scenario: Record<string, unknown>, over: Partial<SessionOptions> = {}) {
  const file = join(tmp, 'scenario.json');
  writeFileSync(file, JSON.stringify(scenario));
  const stdin = join(tmp, 'stdin.log');
  const s = new SessionProcess({
    sessionId: 'sess-1', resume: false, projectId: 'p1', lane: 'orchestrator', runN: 1, args: ARGS, cwd: tmp,
    account: { email: EMAIL, configDir: join(tmp, 'acct') }, outbox, command: ['bun', FAKE],
    env: () => ({
      ...childEnv({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, { configDir: join(tmp, 'acct') }),
      FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_STDIN_LOG: stdin,
    }),
    initTimeoutMs: 5000,
    ...over,
  });
  live.push(s);
  const events: StreamEvent[] = [];
  s.on('event', (e) => events.push(e));
  async function until(pred: (e: StreamEvent) => boolean, ms = 5000): Promise<StreamEvent> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timeout; got ${events.map((e) => e.kind).join(',')}`);
      await Bun.sleep(20);
    }
  }
  const stdinLines = (): Record<string, unknown>[] => {
    try { return readFileSync(stdin, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  const userTexts = () => stdinLines().filter((l) => l.type === 'user').map((l) => (l.message as { content: unknown }).content);
  const results = () => events.filter((e) => e.kind === 'result').length;
  return { s, events, until, stdinLines, userTexts, results };
}

const failure = (p: Promise<unknown>) => p.then(() => 'resolved', (e: Error) => e.message);
const LOOP = { steps: [{ waitUser: 'never-sent' }] }; // every other message → a quick success result

describe('SessionProcess.control (v2.4 §10.2)', () => {
  test('§10.2 control() resolves with the response of its own request id; error replies carry error_code', async () => {
    const f = make(LOOP);
    outbox.enqueue('sess-1', 'go', null);
    expect(await f.s.start()).toMatchObject({ ok: true });
    const [models, settings, bad, odd] = await Promise.all([
      f.s.control({ subtype: 'list_models' }), f.s.control({ subtype: 'get_settings' }),
      f.s.control({ subtype: 'set_model', model: 'no-such-model' }), f.s.control({ subtype: 'no_such_subtype' }),
    ]);
    expect(models.ok && (models.response.models as { value: string }[]).map((m) => m.value)).toContain('sonnet');
    expect(settings).toMatchObject({ ok: true, response: { applied: { model: 'claude-fake', effort: null } } });
    expect(bad).toEqual({ ok: false, error: "Model 'no-such-model' not found", errorCode: 'not_found' });
    expect(odd).toMatchObject({ ok: false, errorCode: 'unsupported_request' });
  });

  test('§5.3 fake-claude set_model + apply_flag_settings: applied follows; bad effort keeps the old one; Set model replay has a foreign uuid', async () => {
    const f = make(LOOP);
    const m = outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    expect(await f.s.control({ subtype: 'set_model', model: 'sonnet[1m]' })).toEqual({ ok: true, response: { model: 'claude-sonnet-5-5[1m]' } });
    await f.s.control({ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } });
    await f.s.control({ subtype: 'apply_flag_settings', settings: { effortLevel: 'banana' } });
    const g = await f.s.control({ subtype: 'get_settings' });
    expect(g).toMatchObject({ ok: true, response: { applied: { model: 'claude-sonnet-5-5[1m]', effort: 'low' } } });
    expect(g.ok && (g.response.sources as { source: string }[]).map((x) => x.source)).toEqual(['userSettings', 'flagSettings']);
    const set = await f.until((e) => e.kind === 'user' && JSON.stringify(e.raw).includes('Set model to Sonnet 5.5'));
    expect(set.kind === 'user' && set.isReplay && set.uuid !== m.uuid).toBe(true);
  });

  test('§5.2 control() rejects at once when the process exits (no reply flag), not after a timeout', async () => {
    const f = make({ ...LOOP, control: { fail: { get_settings: 'silent' } } });
    outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    let settled = false;
    const p = f.s.control({ subtype: 'get_settings' });
    void p.then(() => { settled = true; }, () => { settled = true; });
    await Bun.sleep(300);
    expect(settled).toBe(false); // the fake never answers
    const t0 = Date.now();
    void f.s.terminate(500);
    expect(await failure(p)).toMatch(/exited/);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await failure(f.s.control({ subtype: 'get_settings' }))).toMatch(/exited/); // a dead process: at once
  });

  test('§5.2 fake-claude flags: delay, unsupported_request, applied pinned away from the request', async () => {
    const f = make({ ...LOOP, control: { delayMs: { list_models: 300 }, fail: { set_model: 'unsupported_request' }, pin: { model: 'claude-opus-5-5' } } });
    outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    const t0 = Date.now();
    await f.s.control({ subtype: 'list_models' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(await f.s.control({ subtype: 'set_model', model: 'sonnet' })).toMatchObject({ ok: false, errorCode: 'unsupported_request' });
    expect(await f.s.control({ subtype: 'get_settings' })).toMatchObject({ ok: true, response: { applied: { model: 'claude-opus-5-5' } } });
  });

  test('§5.1 fake-claude startModel / startEffort: what a spawn without --model / --effort runs (init + applied)', async () => {
    const f = make({ ...LOOP, control: { startModel: 'claude-opus-5-5', startEffort: 'high' } });
    outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    expect(await f.s.control({ subtype: 'get_settings' })).toMatchObject({ ok: true, response: { applied: { model: 'claude-opus-5-5', effort: 'high' } } });
    const init = await f.until((e) => e.kind === 'init');
    expect(init.kind === 'init' && init.model).toBe('claude-opus-5-5');
  });
});

describe('SessionOptions.beforeFirstWrite (v2.4 §5.2)', () => {
  test('§5.2 handshake control_requests reach stdin before the first user line; set_model before it → init carries the new model', async () => {
    const f = make(LOOP, {
      beforeFirstWrite: async (p) => {
        await p.control({ subtype: 'get_settings' });
        await p.control({ subtype: 'set_model', model: 'haiku' });
      },
    });
    outbox.enqueue('sess-1', 'go', null);
    const r = await f.s.start();
    expect(r).toMatchObject({ ok: true, init: { model: 'claude-haiku-5-5' } });
    expect(f.stdinLines().map((l) => l.type)).toEqual(['control_request', 'control_request', 'user']);
  });

  test('§5.2 a hook that hangs or throws never blocks the first batch', async () => {
    const hang = make(LOOP, { beforeFirstWrite: () => new Promise(() => {}), handshakeTimeoutMs: 200 });
    outbox.enqueue('sess-1', 'go', null);
    const t0 = Date.now();
    expect(await hang.s.start()).toMatchObject({ ok: true });
    expect(Date.now() - t0).toBeLessThan(2500);
    await hang.s.terminate(500);
    const thrower = make(LOOP, { sessionId: 'sess-2', beforeFirstWrite: async () => { throw new Error('boom'); } });
    outbox.enqueue('sess-2', 'go 2', null);
    expect(await thrower.s.start()).toMatchObject({ ok: true });
    await thrower.until(() => thrower.results() >= 1);
    expect(thrower.userTexts()).toEqual(['go', 'go 2']); // one stdin log for both processes
    expect(thrower.s.recentLines[0]).toBe(JSON.stringify({ cc_slaves: 'handshake_failed', error: 'boom' })); // §5.2 logged
  });

  test('§5.2 a message sent while the hook runs goes out after the first batch, not before', async () => {
    let sendDuring: (() => void) | null = null;
    const f = make(LOOP, {
      beforeFirstWrite: async (p) => { sendDuring?.(); await p.control({ subtype: 'get_settings' }); },
    });
    sendDuring = () => { f.s.send('go second', null); };
    outbox.enqueue('sess-1', 'go first', null);
    await f.s.start();
    await f.until(() => f.results() >= 2);
    expect(f.userTexts()).toEqual(['go first', 'go second']);
    expect(f.stdinLines()[0]!.type).toBe('control_request');
  });
});

describe('SessionProcess hold flag in flush() (v2.4 §5.3)', () => {
  test('§5.3 while held flush() writes nothing; release() writes the queue in order', async () => {
    const f = make(LOOP);
    outbox.enqueue('sess-1', 'go 1', null);
    await f.s.start();
    await f.until(() => f.results() >= 1);
    f.s.hold();
    expect(f.s.held).toBe(true);
    f.s.send('go 2', null);
    f.s.send('go 3', null);
    expect(f.s.flush()).toBe(0);
    await Bun.sleep(200);
    expect(f.userTexts()).toEqual(['go 1']);
    expect(f.s.release()).toBe(2);
    await f.until(() => f.results() >= 3);
    expect(f.userTexts()).toEqual(['go 1', 'go 2', 'go 3']);
  });

  test('§5.3 / §10.2 a new process never starts held', async () => {
    const f = make(LOOP);
    f.s.hold();
    outbox.enqueue('sess-1', 'go 1', null);
    await f.s.start();
    expect(f.s.held).toBe(false);
    f.s.send('go 2', null);
    await f.until(() => f.results() >= 2);
    expect(f.userTexts()).toEqual(['go 1', 'go 2']);
  });
});

describe('fake-claude replay forms (v2.4 §6.6, §10.2)', () => {
  test('§10.2 image blocks are replayed whole with our uuid, after imageReplayDelayMs', async () => {
    const f = make({ ...LOOP, imageReplayDelayMs: 300 });
    outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    const uuid = 'u-img-1';
    const content = [{ type: 'text', text: 'go xem ảnh' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }];
    const t0 = Date.now();
    f.s.writeLine(`${JSON.stringify({ type: 'user', uuid, message: { role: 'user', content } })}\n`);
    const r = await f.until((e) => e.kind === 'user' && e.uuid === uuid);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    // A5 (G3b): the event carries the stripped form; the decoded size (6 bytes) shows the block came back whole.
    const stripped = [content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '<lược 6 byte>' } }];
    expect(r.kind === 'user' && r.isReplay && (r.raw.message as { content: unknown }).content).toEqual(stripped);
  });

  test('§6.6 /name replays as <command-name> with our uuid; skills add a foreign-uuid replay; /context answers <synthetic> + 0 turns; /resume has no replay', async () => {
    const f = make({ ...LOOP, skills: ['find-skills'] });
    outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    await f.until(() => f.results() >= 1);
    const say = (uuid: string, text: string) => f.s.writeLine(`${JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } })}\n`);
    say('u-skill', '/find-skills pdf');
    const cmd = await f.until((e) => e.kind === 'user' && e.uuid === 'u-skill');
    expect(JSON.stringify(cmd.raw)).toContain('<command-name>/find-skills</command-name>');
    expect(JSON.stringify(cmd.raw)).toContain('<command-args>pdf</command-args>');
    await f.until((e) => e.kind === 'user' && e.uuid !== 'u-skill' && JSON.stringify(e.raw).includes('Base directory for this skill'));
    await f.until(() => f.results() >= 2);
    say('u-ctx', '/context');
    await f.until(() => f.results() >= 3);
    expect(f.events.some((e) => e.kind === 'user' && e.uuid === 'u-ctx')).toBe(true);
    const syn = f.events.filter((e) => e.kind === 'assistant' && JSON.stringify(e.raw).includes('<synthetic>'));
    expect(syn.length).toBe(1);
    say('u-res', '/resume');
    await f.until(() => f.results() >= 4);
    expect(f.events.some((e) => e.kind === 'user' && e.uuid === 'u-res')).toBe(false);
    expect(JSON.stringify(f.events.at(-2)?.raw)).toContain("/resume isn't available in this environment.");
  });

  test('§6.6 a <synthetic> assistant line (usage all 0, /context) leaves contextTokens / contextPct (→ ctx_last) unchanged', async () => {
    const usage = { input_tokens: 40000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 };
    const f = make({ steps: [{ waitUser: 'go' }, { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: 'ok' }], usage } } }, { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, permission_denials: [] } }, { waitUser: 'never-sent' }] });
    outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    await f.until(() => f.results() >= 1);
    expect([f.s.contextTokens, f.s.contextPct]).toEqual([40000, 20]);
    f.s.writeLine(`${JSON.stringify({ type: 'user', uuid: 'u-ctx', message: { role: 'user', content: '/context' } })}\n`);
    await f.until(() => f.results() >= 2);
    expect(f.events.some((e) => e.kind === 'assistant' && JSON.stringify(e.raw).includes('<synthetic>'))).toBe(true);
    expect([f.s.contextTokens, f.s.contextPct]).toEqual([40000, 20]);
  });

  test('§10.2 foreignReplay step: a replayed user line whose uuid is not ours', async () => {
    const f = make({ steps: [{ waitUser: true }, { foreignReplay: '<command-message>x</command-message>' }, { emit: { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 1 } }] });
    const m = outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    const r = await f.until((e) => e.kind === 'user' && JSON.stringify(e.raw).includes('<command-message>x'));
    expect(r.kind === 'user' && r.isReplay && r.uuid !== m.uuid).toBe(true);
  });
});

describe('SessionProcess behind the v2.6 update gate (§5.4)', () => {
  const gated = (g: UpdateGate) => ({ update: { gate: g, kind: 'lane' as const } });

  test('§5.4-1 held: nothing reaches stdin, a v2.4 release() writes nothing (R9); the gate opens → the queue in order', async () => {
    const g = new UpdateGate();
    const f = make(LOOP, gated(g));
    outbox.enqueue('sess-1', 'go 1', null);
    await f.s.start();
    await f.until(() => f.results() >= 1);
    g.hold(true);
    f.s.send('go 2', null);
    f.s.hold();
    expect(f.s.release()).toBe(0);
    await Bun.sleep(200);
    expect(f.userTexts()).toEqual(['go 1']);
    expect(g.blocked()).toEqual(['sess-1']);
    g.hold(false);
    expect(g.blocked()).toEqual([]);
    expect(f.s.flush()).toBe(1);
    await f.until(() => f.results() >= 2);
    expect(f.userTexts()).toEqual(['go 1', 'go 2']);
  });

  test('§5.4-4 a spawn is busy from start() to the end of its self-check, then not (the turn is the session\'s own)', async () => {
    const g = new UpdateGate();
    let mid: unknown = null;
    const f = make(LOOP, { ...gated(g), beforeFirstWrite: async () => { mid = g.spawning(); } });
    outbox.enqueue('sess-1', 'go 1', null);
    const started = f.s.start();
    expect(g.spawning()).toEqual([{ projectId: 'p1', kind: 'lane', name: 'orchestrator', turnStartedAt: expect.any(Number) as number }]);
    expect((await started).ok).toBe(true);
    expect(mid).toEqual([{ projectId: 'p1', kind: 'lane', name: 'orchestrator', turnStartedAt: expect.any(Number) as number }]); // handshake = mid-spawn
    expect(g.spawning()).toEqual([]);
  });

  test('§5.4-4 an orchestrator spawn is named by its session id; a failed self-check leaves no busy entry', async () => {
    const g = new UpdateGate();
    const f = make({ steps: [{ exit: 1 }] }, { update: { gate: g, kind: 'orchestrator' } });
    outbox.enqueue('sess-1', 'go 1', null);
    const started = f.s.start();
    expect(g.spawning().map((b) => [b.kind, b.name])).toEqual([['orchestrator', 'sess-1']]);
    expect((await started).ok).toBe(false);
    expect(g.spawning()).toEqual([]);
  });

  test('§5.4-4 (ruling 12:20) a workflow author spawn is named by its draft id (`lane`), like AuthorSessions.busy', async () => {
    const g = new UpdateGate();
    const f = make({ steps: [{ exit: 1 }] }, { lane: 'draft-1', update: { gate: g, kind: 'workflow' } });
    outbox.enqueue('sess-1', 'go 1', null);
    const started = f.s.start();
    expect(g.spawning().map((b) => [b.kind, b.name])).toEqual([['workflow', 'draft-1']]);
    await started;
  });

  test('§5.4-9 sealed: control() and interrupt write nothing; a permission answer (writeLine) still goes', async () => {
    const g = new UpdateGate();
    const f = make({ steps: [{ waitUser: true }, { sleep: 2000 }] }, gated(g));
    outbox.enqueue('sess-1', 'go 1', null);
    await f.s.start();
    g.hold(true);
    g.seal();
    expect(g.controls).toBe(false);
    expect(await failure(f.s.control({ subtype: 'get_settings' }))).toBe('update_sealed');
    expect(await f.s.interrupt()).toEqual({ result: null, timedOut: false });
    expect(f.s.writeLine(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'perm-1', response: { behavior: 'allow' } } })}\n`)).toBe(true);
    await Bun.sleep(150);
    expect(f.stdinLines().map((l) => l.type)).toEqual(['user', 'control_response']);
    g.hold(false);
    expect(g.controls).toBe(true);
  });
});
