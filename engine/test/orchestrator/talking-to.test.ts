import { describe, expect, test } from 'bun:test';
import { MCP_TOOL_PREFIX, talkingToOf } from '../../src/orchestrator/session/texts.ts';
import { Orchestrator, type OrchestratorDeps, type OrchestratorEvent } from '../../src/orchestrator/session.ts';

const use = (name: string, input: unknown) => ({ type: 'tool_use', id: 't', name, input });
const msg = (...content: unknown[]) => ({ role: 'assistant', content });

describe('talkingTo from an assistant message (v1.1 §5.2)', () => {
  test('v1.1 §5.2 the MCP server prefix matches the --mcp-config server key', () => {
    expect(MCP_TOOL_PREFIX).toBe('mcp__cc_slaves__');
  });

  test('v1.1 §5.2 a cc-slaves tool call with `name` → that lane name', () => {
    expect(talkingToOf(msg(use('mcp__cc_slaves__lane_message', { name: 'D2', text: 'hi' })))).toBe('D2');
    expect(talkingToOf(msg(use('mcp__cc_slaves__lane_tail', { name: 'B1', n: 5 })))).toBe('B1');
  });

  test('v1.1 §5.2 several calls in one message → the last one with `name` wins', () => {
    expect(talkingToOf(msg(
      use('mcp__cc_slaves__lane_start', { name: 'A1', cwd: '/w' }),
      { type: 'text', text: 'x' },
      use('mcp__cc_slaves__lane_message', { name: 'A2', text: 't' }),
      use('mcp__cc_slaves__lanes_list', {}),
    ))).toBe('A2');
  });

  test('v1.1 §5.2 tool without `name` / non-MCP tool / other MCP server / empty name → undefined (no change)', () => {
    expect(talkingToOf(msg(use('mcp__cc_slaves__lanes_list', {})))).toBeUndefined();
    expect(talkingToOf(msg(use('Bash', { name: 'D2', command: 'ls' })))).toBeUndefined();
    expect(talkingToOf(msg(use('mcp__other__thing', { name: 'D2' })))).toBeUndefined();
    expect(talkingToOf(msg(use('mcp__cc_slaves__lane_message', { name: '', text: 't' })))).toBeUndefined();
    expect(talkingToOf(msg(use('mcp__cc_slaves__lane_message', { name: 7 })))).toBeUndefined();
    expect(talkingToOf(msg({ type: 'text', text: 'mcp__cc_slaves__lane_message' }))).toBeUndefined();
    expect(talkingToOf({ role: 'assistant', content: 'plain' })).toBeUndefined();
    expect(talkingToOf(null)).toBeUndefined();
  });
});

// review CR-M1: events from a replaced (stale) process must not touch talkingTo (session.ts onStream `this.proc === proc`)
describe('talkingTo ignores a stale process (v1.1 §5.2)', () => {
  type Internals = { proc: unknown; talkingTo: string | null; onStream(p: unknown, email: string, e: unknown): void };
  const ev = (name: string) => ({ kind: 'assistant', uuid: null, sessionId: null, parentToolUseId: null, isReplay: false, raw: {},
    message: msg(use('mcp__cc_slaves__lane_message', { name, text: 't' })) });
  const result = { kind: 'result', subtype: 'success', isError: false, result: '', sessionId: null, totalCostUsd: null, sinceLastCostUsd: null, raw: {} };
  const make = () => {
    const events: OrchestratorEvent[] = [];
    const o = new Orchestrator({ db: { query: () => ({ get: () => null, run: () => {} }) } } as unknown as OrchestratorDeps, 'p1', 's1', null, '/w', { account: 'o@x', state: 'running' }, e => events.push(e));
    return { o, i: o as unknown as Internals, events };
  };

  test('v1.1 §5.2 the current process sets talkingTo; the old one (after a swap) changes nothing and emits nothing', () => {
    const { o, i, events } = make();
    const oldProc = { alive: false }, cur = { alive: true };
    i.proc = cur;
    i.onStream(cur, 'o@x', ev('D2'));
    expect(o.view().talkingTo).toBe('D2');
    const n = events.length;
    i.onStream(oldProc, 'o@x', ev('X'));
    i.onStream(oldProc, 'o@x', result);
    expect(o.view().talkingTo).toBe('D2');
    expect(events.length).toBe(n);
    i.onStream(cur, 'o@x', result);
    i.proc = null; // the queued result job then returns early (no db in this unit)
    expect(o.view().talkingTo).toBeNull();
  });
});
