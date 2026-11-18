// hotfix 2026-11-16 H3 implicit resume: every PO path that would run something of a held project calls the one
// `held.wake` hook first (send, card answer, card actions that run a session / lane, lane_resume, orchestrator restart).
// Stub engine: records the order of calls.
import { expect, test } from 'bun:test';
import type { Engine } from '../../src/engine.ts';
import { buildHandlers } from '../../src/server/commands.ts';
import { route } from '../../src/server/router.ts';
import type { Conn } from '../../src/server/ws.ts';

function fakeEngine(laneState = 'paused') {
  const calls: string[] = [];
  const orch = { projectId: 'p', currentSessionId: 's1', view: () => ({ state: 'paused' }), restart: async () => { calls.push('restart'); }, send: async () => { calls.push('orch.send'); return 'u'; } };
  const sys = { id: 2, kind: 'orchestrator_down', projectId: 'p', sessionId: 's1', status: 'open', payload: { actions: [{ label: 'x', action: 'restart_orchestrator' }] } };
  const e = {
    held: { wake: async (id: string) => { calls.push(`wake:${id}`); return true; } },
    cards: {
      get: (id: number) => (id === 1 ? { id: 1, kind: 'ask', projectId: 'p' } : id === 2 ? sys : null),
      answer: async () => { calls.push('answer'); return { id: 1 }; },
      resolveSystem: () => { calls.push('resolve'); return sys; },
    },
    cardViewOf: (c: unknown) => c,
    lanes: {
      get: () => ({ state: laneState, sessionId: 'sl' }),
      resume: async () => { calls.push('lanes.resume'); },
    },
    orchestrators: { get: () => orch, route: () => orch, bySession: () => orch },
    markInTurn: () => {},
    update: { gate: { writes: true } },
  } as unknown as Engine;
  return { h: buildHandlers(e, {} as Conn), calls };
}
const run = (h: ReturnType<typeof fakeEngine>['h'], command: object) => route(h, { channel: 'mac' }, { type: 'command', id: '1', command });

test('hf1116 H3 send / card answer / card action wake the project before they act', async () => {
  const f = fakeEngine();
  await run(f.h, { cmd: 'send', target: { kind: 'orchestrator', projectId: 'p' }, text: 'hi' });
  await run(f.h, { cmd: 'card_answer', id: 1, answer: { option: 'a' } });
  await run(f.h, { cmd: 'card_action', id: 2, action: 'restart_orchestrator' });
  await run(f.h, { cmd: 'orchestrator_restart', projectId: 'p' });
  expect(f.calls).toEqual(['wake:p', 'orch.send', 'wake:p', 'answer', 'wake:p', 'restart', 'resolve', 'wake:p', 'restart']);
});

test('hf1116 H3 lane_resume of a paused lane = resume its project (no not_halted); of a stopped lane = wake + resume', async () => {
  const paused = fakeEngine('paused');
  expect(await run(paused.h, { cmd: 'lane_resume', projectId: 'p', name: 'D1' })).toMatchObject({ type: 'ack' });
  expect(paused.calls).toEqual(['wake:p']);
  const stopped = fakeEngine('stopped');
  await run(stopped.h, { cmd: 'lane_resume', projectId: 'p', name: 'D1' });
  expect(stopped.calls).toEqual(['wake:p', 'lanes.resume']);
});
