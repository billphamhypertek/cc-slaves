import { describe, expect, test } from 'bun:test';
import { accKind, poolPct } from '../../src/deck/accounts.ts';
import { account } from '../fixtures.ts';

describe('account wall §4.5', () => {
  test('§4.5 "% kho" excludes orchestrator, logged-out and unknown; full counts 0', () => {
    const accs = [
      account('o@x', { role: 'orchestrator', headroomPct: 90 }),
      account('a@x', { headroomPct: 40 }), account('b@x', { headroomPct: 0, full: true }),
      account('c@x', { headroomPct: 80, loggedOut: true }), account('d@x', { headroomPct: null }),
      account('e@x', { headroomPct: 70, status: 'needs_probe' }), account('f@x', { headroomPct: 50 }),
    ];
    expect(poolPct(accs)).toBe(30); // (40 + 0 + 50) / 3
  });
  test('§4.5 full counts 0 even when the engine still reports a headroom', () => {
    expect(poolPct([account('a@x', { headroomPct: 20 }), account('b@x', { headroomPct: 7, full: true })])).toBe(10);
  });
  test('§4.5 no usable lane account → kho 0 %; v2.1 §4.7 the orchestrator as the only account counts', () => {
    expect(poolPct([account('o@x', { role: 'orchestrator' }), account('out@x', { loggedOut: true })])).toBe(0);
    expect(poolPct([account('o@x', { role: 'orchestrator' })])).toBe(51);
  });
  test('§5.2 kind: unknown = headroom null or status needs_probe / unknown; low = < 10', () => {
    expect(accKind(account('a', { status: 'unknown' }))).toBe('unknown');
    expect(accKind(account('a', { headroomPct: 9.9 }))).toBe('low');
    expect(accKind(account('a', { headroomPct: 10 }))).toBe('ok');
    expect(accKind(account('a', { full: true, loggedOut: true }))).toBe('out');
  });
});
