// hf1117-p2 (perf audit C2): unchanged deck nodes keep their object identity so React Flow keeps their handle bounds.
import { describe, expect, test } from 'bun:test';
import type { Node } from '@xyflow/react';
import { keepStable } from '../../src/deck/flow/stable.ts';

const node = (id: string, data: Record<string, unknown>, x = 0): Node =>
  ({ id, type: 'lane', position: { x, y: 0 }, data, width: 200, height: 60, measured: { width: 200, height: 60 } });

describe('hf1117-p2 keepStable', () => {
  test('an unchanged node keeps the previous object; a changed or new one is the new object', () => {
    const prev = [node('a', { tok: '1k', tail: { pts: [1, 2] } }), node('b', { tok: '2k' })];
    const next = [node('a', { tok: '1k', tail: { pts: [1, 2] } }), node('b', { tok: '3k' }), node('c', {})];
    const out = keepStable(prev, next);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
    expect(out[2]).toBe(next[2]);
  });
  test('a change deep in the data (spark points) is the new object', () => {
    const prev = [node('a', { tail: { kind: 'spark', pts: [1, 2] } })];
    const next = [node('a', { tail: { kind: 'spark', pts: [1, 3] } })];
    expect(keepStable(prev, next)[0]).toBe(next[0]);
  });
  test('a moved node (same data) is the new object', () => {
    const prev = [node('a', { tok: '1k' })];
    const next = [node('a', { tok: '1k' }, 40)];
    expect(keepStable(prev, next)[0]).toBe(next[0]);
  });
  test('order follows next; a node gone from next is dropped', () => {
    const prev = [node('a', {}), node('b', {})];
    const out = keepStable(prev, [node('b', {})]);
    expect(out.map(n => n.id)).toEqual(['b']);
    expect(out[0]).toBe(prev[1]);
  });
});
