import { describe, expect, test } from 'bun:test';
import { addTokens, displayTokens, ZERO_TOKENS } from '../../../shared/protocol.ts';
import { classify, type MessageEvent, type ResultEvent } from '../../src/stream/parser.ts';
import { TokenMeter, usageOf } from '../../src/stream/tokens.ts';

const U = (i: number, o: number, w: number, r: number) =>
  ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: w, cache_read_input_tokens: r });
const asst = (id: string | null, usage: unknown, parent: string | null = null) =>
  classify({ type: 'assistant', uuid: `u-${Math.random()}`, parent_tool_use_id: parent, message: { ...(id ? { id } : {}), role: 'assistant', content: [], usage } }) as MessageEvent;
const result = (usage?: unknown) => classify({ type: 'result', subtype: 'success', is_error: false, result: '', ...(usage ? { usage } : {}) }) as ResultEvent;

describe('§5.3 token counts', () => {
  test('§5.3 W4 displayed tok = input + output + cacheWrite (cacheRead excluded)', () => {
    expect(displayTokens({ input: 1, output: 20, cacheWrite: 300, cacheRead: 999_999 })).toBe(321);
    expect(displayTokens(ZERO_TOKENS)).toBe(0);
  });

  test('§5.3 usageOf maps the four Claude usage fields; missing → 0; nothing → null', () => {
    expect(usageOf(U(1, 2, 3, 4))).toEqual({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
    expect(usageOf({ output_tokens: 5 })).toEqual({ input: 0, output: 5, cacheWrite: 0, cacheRead: 0 });
    expect(usageOf({})).toBeNull();
    expect(usageOf(null)).toBeNull();
  });

  test('§5.3 the parser reads result.usage', () => {
    expect(result(U(10, 20, 30, 40)).usage).toEqual({ input: 10, output: 20, cacheWrite: 30, cacheRead: 40 });
    expect(result().usage).toBeNull();
  });
});

describe('§5.3 W10 TokenMeter', () => {
  test('§5.3 W10 provisional sum within a turn, then result.usage replaces it exactly', () => {
    const m = new TokenMeter();
    expect(m.assistant(asst('m1', U(100, 10, 50, 1000)))).toBe(true);
    expect(m.assistant(asst('m2', U(5, 7, 0, 2000)))).toBe(true);
    expect(m.total).toEqual({ input: 105, output: 17, cacheWrite: 50, cacheRead: 3000 });
    const exact = m.result(result(U(200, 30, 60, 4000)));
    expect(exact).toEqual({ input: 200, output: 30, cacheWrite: 60, cacheRead: 4000 });
    expect(m.total).toEqual({ input: 200, output: 30, cacheWrite: 60, cacheRead: 4000 });
    expect(m.provisional).toEqual(ZERO_TOKENS);
    // next turn adds on top of the committed total
    m.assistant(asst('m3', U(1, 1, 1, 1)));
    expect(m.total).toEqual({ input: 201, output: 31, cacheWrite: 61, cacheRead: 4001 });
  });

  test('§5.3 W10 one API message split over several assistant lines (same message.id) counts once, last usage wins', () => {
    const m = new TokenMeter();
    m.assistant(asst('m1', U(100, 3, 0, 0)));
    expect(m.assistant(asst('m1', U(100, 40, 0, 0)))).toBe(true);
    expect(m.assistant(asst('m1', U(100, 40, 0, 0)))).toBe(false);
    expect(m.total).toEqual({ input: 100, output: 40, cacheWrite: 0, cacheRead: 0 });
  });

  test('§5.3 W10 an assistant line with no usage changes nothing', () => {
    const m = new TokenMeter();
    expect(m.assistant(asst('m1', undefined))).toBe(false);
    expect(m.total).toEqual(ZERO_TOKENS);
  });

  test('§5.3 W10 result without usage commits the provisional sum', () => {
    const m = new TokenMeter();
    m.assistant(asst('m1', U(3, 4, 5, 6)));
    expect(m.result(result())).toEqual({ input: 3, output: 4, cacheWrite: 5, cacheRead: 6 });
    expect(m.total).toEqual({ input: 3, output: 4, cacheWrite: 5, cacheRead: 6 });
  });

  test('§5.3 abandon returns the cut turn\'s provisional sum to store (null when the turn reported none)', () => {
    const m = new TokenMeter();
    expect(m.abandon()).toBeNull();
    m.assistant(asst('a', U(1, 2, 3, 4)));
    expect(m.abandon()).toEqual({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
    expect(m.abandon()).toBeNull(); // cleared: never stored twice
    expect(m.total).toEqual({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
  });

  test('§5.3 W10 cumulative across an account switch / new process: base carries, abandoned turn is kept', () => {
    const m = new TokenMeter({ input: 1000, output: 100, cacheWrite: 10, cacheRead: 1 }); // restored from DB
    m.assistant(asst('a', U(1, 2, 3, 4)));
    m.abandon(); // process died (cap switch) before result
    m.assistant(asst('b', U(10, 20, 30, 40))); // same lane on the new account
    m.result(result(U(10, 20, 30, 40)));
    expect(m.total).toEqual(addTokens({ input: 1001, output: 102, cacheWrite: 13, cacheRead: 5 }, { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 }));
  });
});
