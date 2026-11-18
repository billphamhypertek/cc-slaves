// spec v2.3 §6.2 "Mở ở Code": the Git view's request reaches the Code view whether it mounts after (pending) or already listens.
import { expect, test } from 'bun:test';
import { onCodeOpen, requestCodeOpen, type CodeOpen } from '../../src/lib/code-open.ts';

test('§6.2 a request made before Code mounts is pending; later ones reach the listener until off()', () => {
  requestCodeOpen({ kind: 'base' }, 'engine/src/lanes.ts');
  const got: CodeOpen[] = [];
  const sub = onCodeOpen(r => got.push(r));
  expect(sub.pending?.path).toBe('engine/src/lanes.ts');
  requestCodeOpen({ kind: 'lane', laneId: 'D15' }, 'a.ts');
  sub.off();
  requestCodeOpen({ kind: 'base' }, 'b.ts');
  expect(got.map(r => r.path)).toEqual(['a.ts']);
  expect(got[0]!.n).toBe(sub.pending!.n + 1);
});

test('§6.2 the pending request is taken once: a second mount does not replay it', () => {
  requestCodeOpen({ kind: 'base' }, 'x.ts');
  const a = onCodeOpen(() => {});
  a.off();
  const b = onCodeOpen(() => {});
  b.off();
  expect(a.pending?.path).toBe('x.ts');
  expect(b.pending).toBeNull();
});
