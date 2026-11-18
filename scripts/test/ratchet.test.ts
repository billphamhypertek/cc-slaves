import { expect, test } from 'bun:test';
import { compare, shrink } from '../ratchet';

const base = { 'web/src/a.tsx': { 'r/x': 2 } };

test('§1 ratchet: a new error, or more of one rule in a file, is red', () => {
  expect(compare(base, base, 'x')).toEqual([]);
  expect(compare({ 'web/src/a.tsx': { 'r/x': 3 } }, base, 'x')).toHaveLength(1);
  expect(compare({ ...base, 'engine/src/b.ts': { 'r/x': 1 } }, base, 'x')).toEqual(['engine/src/b.ts r/x: 1 > baseline 0']);
});
test('§1 ratchet: a count that fell is red until --update, which only shrinks and never adds', () => {
  expect(compare({}, base, 'x')[0]).toContain('--update');
  expect(shrink({ 'web/src/a.tsx': { 'r/x': 1 } }, base)).toEqual({ 'web/src/a.tsx': { 'r/x': 1 } });
  expect(shrink({ 'web/src/a.tsx': { 'r/x': 5 }, 'x.ts': { 'r/y': 1 } }, base)).toEqual(base);
  expect(shrink({}, base)).toEqual({});
});
