// v2.4 §4.3 the engine line of a model / effort change (2 s merge) and the §5.5 command handlers (session_models,
// session_set_model, session_model_cancel, session_open / session_resume picks) against a stub engine.
import { describe, expect, test } from 'bun:test';
import type { Engine } from '../../src/engine.ts';
import { UNAVAILABLE } from '../../src/models.ts';
import { ModelError } from '../../src/session/model-control.ts';
import { stream } from '../../src/engine/events.ts';
import { buildHandlers } from '../../src/server/commands.ts';
import type { NewLine } from '../../src/server/lines.ts';
import { route } from '../../src/server/router.ts';
import { modelChangeLine, ModelLines } from '../../src/server/session-views.ts';
import type { Conn } from '../../src/server/ws.ts';

const F = { modelName: 'Fable 5.2', effort: 'high' }, S = { modelName: 'Sonnet 5.5', effort: 'high' }, SM = { modelName: 'Sonnet 5.5', effort: 'max' };

describe('§4.3 model change line', () => {
  test('§4.3 MD14 model only / effort only / both; nothing changed → no line; vi + en', () => {
    expect(modelChangeLine(F, S, 'vi')).toEqual({ kind: 'engine', text: 'Đổi model: Fable 5.2 → Sonnet 5.5' });
    expect(modelChangeLine(S, SM, 'vi')?.text).toBe('Đổi effort: high → max');
    expect(modelChangeLine(F, SM, 'vi')?.text).toBe('Đổi model: Fable 5.2 → Sonnet 5.5 · effort: high → max');
    expect(modelChangeLine(F, SM, 'en')?.text).toBe('Model changed: Fable 5.2 → Sonnet 5.5 · effort: high → max');
    expect(modelChangeLine({ modelName: 'Haiku 4.5', effort: null }, { modelName: 'Haiku 4.5', effort: 'low' }, 'vi')?.text).toBe('Đổi effort: — → low');
    expect(modelChangeLine(F, F, 'vi')).toBeNull();
  });
  test('§4.3 model then effort within 2 s → one merged line (first from → last to); later change → its own line', async () => {
    const out: { sid: string; line: NewLine }[] = [];
    const m = new ModelLines((sid, line) => out.push({ sid, line }), () => 'vi', 60);
    m.change('s1', F, S);
    await Bun.sleep(20);
    m.change('s1', S, SM);
    m.change('s2', S, SM); // another session: its own line
    expect(out).toEqual([]);
    await Bun.sleep(80);
    expect(out.map((o) => `${o.sid} ${o.line.text}`).sort()).toEqual(['s1 Đổi model: Fable 5.2 → Sonnet 5.5 · effort: high → max', 's2 Đổi effort: high → max']);
    m.change('s1', SM, S);
    await Bun.sleep(80);
    expect(out.at(-1)).toEqual({ sid: 's1', line: { kind: 'engine', text: 'Đổi effort: max → high' } });
  });
  test('R14 §4.3 another line about to be appended → the open line is written first; its timer then writes nothing', async () => {
    const log: string[] = [];
    const m = new ModelLines((sid, l) => log.push(`${sid} ${l.text}`), () => 'vi', 40);
    m.change('s1', F, S);
    m.flush('s2'); // nothing open there
    m.flush('s1');
    log.push('s1 reply on the new model');
    await Bun.sleep(80);
    expect(log).toEqual(['s1 Đổi model: Fable 5.2 → Sonnet 5.5', 's1 reply on the new model']);
  });
  test('R14 stream(): beforeAppend runs right before the lines are appended; an event with no line never calls it', () => {
    const log: string[] = [];
    const eng = {
      blocks: { stamp: () => [], event: () => [] }, inTurnSent: new Map(), hub: { broadcast: () => {}, watched: () => false },
      lines: { append: (_: string, l: NewLine[]) => { log.push(`append ${l[0]!.text}`); return []; } },
    } as unknown as Engine;
    const t = { kind: 'orchestrator', projectId: 'p1', sessionId: 's1' } as const;
    const ev = (kind: string, message: object) => ({ kind, uuid: null, sessionId: null, parentToolUseId: null, message }) as never;
    stream(eng, t, 's1', ev('assistant', { content: [] }), () => log.push('flush'));
    stream(eng, t, 's1', ev('assistant', { content: [{ type: 'text', text: 'hi' }] }), () => log.push('flush'));
    expect(log).toEqual(['flush', 'append hi']);
  });
  test('§4.3 a change and its undo within 2 s → no line', async () => {
    const out: NewLine[] = [];
    const m = new ModelLines((_, l) => out.push(l), () => 'vi', 30);
    m.change('s1', F, S);
    m.change('s1', S, F);
    await Bun.sleep(60);
    expect(out).toEqual([]);
  });
});

const conn: Conn = { channel: 'mac', watch: null, present: false, send: () => {} };

function fakeEngine(o: { setModel?: (c: unknown) => Promise<string>; orch?: boolean } = {}) {
  const calls: unknown[] = [];
  const orch = {
    projectId: 'p', modelScope: { account: 'a@x', dir: '/p' }, readModels: async () => ({ list: [], configured: null }),
    setModel: o.setModel ?? (async (c: unknown) => { calls.push(['set', c]); return 'now'; }),
    cancelModel: async () => { calls.push('cancel'); },
    view: () => ({}),
  };
  const e = {
    config: { modelDefaults: { orchestrator: { model: 'sonnet', effort: null }, lane: { model: null, effort: null } } },
    lanes: {
      modelScope: (p: string, n: string) => {
        if (n !== 'D2') throw new Error(`no lane ${p}/${n}`);
        return { account: 'l@x', dir: '/wt/D2', tier: { model: 'haiku', effort: 'medium', source: 'agent', agent: 'coder' }, own: async () => ({ list: [], configured: null }) };
      },
      setModel: async (p: string, n: string, c: unknown) => { calls.push(['laneSet', p, n, c]); return 'pending'; },
      cancelModel: async (p: string, n: string) => { calls.push(['laneCancel', p, n]); },
    },
    projectRow: (id: string) => (id === 'p' ? { id: 'p', name: 'P', path: '/p', orchestrator_account: 'home@x' } : null),
    orchestrators: {
      bySession: (sid: string) => (o.orch !== false && sid === 's1' ? orch : null),
      open: async (_p: string, i: unknown) => { calls.push(['open', i]); return orch; },
      resume: async (_s: string, i: unknown) => { calls.push(['resume', i]); return orch; },
    },
    orchView: (v: unknown) => v,
    held: { wake: async () => false }, // hotfix 2026-11-16 not held
    db: { query: () => ({ get: (sid: string) => (sid === 'old' ? { account: 'old@x' } : null) }) },
    models: { list: async (account: string, dir: string, own?: unknown, tier?: { model: string | null; source: string | null }) => { calls.push(['list', account, dir, typeof own, tier?.model ?? null, tier?.source ?? null]); return UNAVAILABLE; } },
  } as unknown as Engine;
  return { h: buildHandlers(e, conn), calls };
}
const run = (h: ReturnType<typeof fakeEngine>['h'], command: object) => route(h, { channel: 'mac' }, { type: 'command', id: '1', command });

describe('§5.5 model commands', () => {
  test('§5.4 session_models: sessionId → that session\'s account + own process; accountId → that account; none → project home', async () => {
    const f = fakeEngine();
    await run(f.h, { cmd: 'session_models', projectId: 'p', sessionId: 's1' });
    await run(f.h, { cmd: 'session_models', projectId: 'p', accountId: 'b@x' });
    await run(f.h, { cmd: 'session_models', projectId: 'p' });
    await run(f.h, { cmd: 'session_models', projectId: 'p', sessionId: 'old' }); // ended: its last account, probe
    // §5.6 every orchestrator path resolves Cài đặt › Điều phối (tier 3)
    expect(f.calls).toEqual([['list', 'a@x', '/p', 'function', 'sonnet', 'settings'], ['list', 'b@x', '/p', 'undefined', 'sonnet', 'settings'],
      ['list', 'home@x', '/p', 'undefined', 'sonnet', 'settings'], ['list', 'old@x', '/p', 'undefined', 'sonnet', 'settings']]);
    expect(await run(f.h, { cmd: 'session_models', projectId: 'nope' })).toMatchObject({ type: 'error', code: 'no_project' });
    expect(await run(f.h, { cmd: 'session_models', projectId: 'p', sessionId: 'zz' })).toMatchObject({ type: 'error', code: 'no_session' });
  });
  test('§5.5 session_set_model → { applied }; model null = "Theo mặc định"; effort null / nothing / bad → bad_input', async () => {
    const f = fakeEngine();
    expect(await run(f.h, { cmd: 'session_set_model', sessionId: 's1', model: 'sonnet', effort: 'max' })).toEqual({ type: 'ack', id: '1', result: { applied: 'now' } });
    await run(f.h, { cmd: 'session_set_model', sessionId: 's1', model: null });
    expect(f.calls).toEqual([['set', { model: 'sonnet', effort: 'max' }], ['set', { model: null }]]);
    for (const bad of [{ effort: null }, {}, { model: 3 }, { model: '' }, { effort: '' }]) {
      expect(await run(f.h, { cmd: 'session_set_model', sessionId: 's1', ...bad })).toMatchObject({ type: 'error', code: 'bad_input', key: 'errors.badModel' });
    }
    expect(await run(f.h, { cmd: 'session_set_model', sessionId: 'zz', model: 'sonnet' })).toMatchObject({ code: 'no_session' });
  });
  test('§5.5 errors model_not_found / timeout keep their code and get a catalog key', async () => {
    for (const code of ['model_not_found', 'timeout'] as const) {
      const f = fakeEngine({ setModel: async () => { throw new ModelError(code, 'x'); } });
      expect(await run(f.h, { cmd: 'session_set_model', sessionId: 's1', model: 'nope' }))
        .toMatchObject({ type: 'error', code, key: code === 'timeout' ? 'errors.modelTimeout' : 'errors.modelNotFound' });
    }
  });
  test('§5.6 session_models {lane} → the lane\'s account, cwd, own process and tiers; lane_set_model / lane_model_cancel → the lane manager', async () => {
    const f = fakeEngine();
    await run(f.h, { cmd: 'session_models', projectId: 'p', lane: 'D2' });
    expect(await run(f.h, { cmd: 'lane_set_model', projectId: 'p', name: 'D2', model: null, effort: 'low' })).toEqual({ type: 'ack', id: '1', result: { applied: 'pending' } });
    expect(await run(f.h, { cmd: 'lane_model_cancel', projectId: 'p', name: 'D2' })).toEqual({ type: 'ack', id: '1' });
    expect(f.calls).toEqual([['list', 'l@x', '/wt/D2', 'function', 'haiku', 'agent'], ['laneSet', 'p', 'D2', { model: null, effort: 'low' }], ['laneCancel', 'p', 'D2']]);
    for (const bad of [{ effort: null }, {}, { model: '' }]) {
      expect(await run(f.h, { cmd: 'lane_set_model', projectId: 'p', name: 'D2', ...bad })).toMatchObject({ type: 'error', code: 'bad_input', key: 'errors.badModel' });
    }
    expect(await route(f.h, { channel: 'remote' }, { type: 'command', id: '1', command: { cmd: 'lane_set_model', projectId: 'p', name: 'D2', model: 'opus' } })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  });
  test('§5.5 session_model_cancel → the session\'s cancelModel', async () => {
    const f = fakeEngine();
    expect(await run(f.h, { cmd: 'session_model_cancel', sessionId: 's1' })).toEqual({ type: 'ack', id: '1' });
    expect(f.calls).toEqual(['cancel']);
  });
  test('§5.5 session_open / session_resume pass model / effort (null kept = "Theo mặc định"); absent stays absent', async () => {
    const f = fakeEngine();
    await run(f.h, { cmd: 'session_open', projectId: 'p', model: 'sonnet', effort: null });
    await run(f.h, { cmd: 'session_resume', sessionId: 'old', mode: 'parallel', model: null, effort: 'low' });
    await run(f.h, { cmd: 'session_open', projectId: 'p' });
    expect(f.calls).toEqual([['open', { model: 'sonnet', effort: null }], ['resume', { mode: 'parallel', model: null, effort: 'low' }], ['open', {}]]);
    expect(await run(f.h, { cmd: 'session_open', projectId: 'p', effort: 5 })).toMatchObject({ code: 'bad_input' });
  });
});
