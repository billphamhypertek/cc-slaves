import { expect, test } from 'bun:test';
import { checkBundle, chunkKey, type Budget } from '../check-bundle';

const budget: Budget = { lane: 't', reason: 't', chunks: { 'index.js': { limitKb: 100 } }, totalKb: 150 };

test('§1 bundle: the chunk key drops the hash', () => {
  expect(chunkKey('DeckView-C9Kq8kES.js')).toBe('DeckView.js');
  expect(chunkKey('index-BK9CpUK9.css')).toBe('index.css');
});
test('§1 bundle: a chunk over its limit, a total over budget and three.js in the dist are red', () => {
  expect(checkBundle([{ key: 'index.js', kb: 100, text: '' }], budget)).toEqual([]);
  expect(checkBundle([{ key: 'index.js', kb: 100.01, text: '' }], budget)).toEqual(['index.js: 100.01 KB gzip > 100 KB']);
  expect(checkBundle([{ key: 'index.js', kb: 90, text: '' }, { key: 'new.js', kb: 61, text: '' }], budget))
    .toEqual(['total: 151.00 KB gzip > 150 KB']);
  expect(checkBundle([{ key: 'x.js', kb: 1, text: 'new WebGLRenderer()' }], budget)).toHaveLength(1);
});
test('§1 bundle (spec v2.1 §5.6 ruling): the total caps JS only; CSS chunks keep their own limits', () => {
  const b: Budget = { ...budget, chunks: { ...budget.chunks, 'index.css': { limitKb: 10 } } };
  expect(checkBundle([{ key: 'index.js', kb: 100, text: '' }, { key: 'x.js', kb: 50, text: '' }, { key: 'index.css', kb: 9, text: '' }], b)).toEqual([]);
  expect(checkBundle([{ key: 'index.js', kb: 100, text: '' }, { key: 'index.css', kb: 11, text: '' }], b)).toEqual(['index.css: 11.00 KB gzip > 10 KB']);
});
test('§1 bundle (spec v2.1 §5.6, lane v21-t10): a lazy language chunk (`inTotal: false`) has its own limit and stays out of the total', () => {
  const b: Budget = { ...budget, chunks: { ...budget.chunks, 'en.js': { limitKb: 20, inTotal: false } } };
  expect(checkBundle([{ key: 'index.js', kb: 100, text: '' }, { key: 'x.js', kb: 50, text: '' }, { key: 'en.js', kb: 19, text: '' }], b)).toEqual([]);
  expect(checkBundle([{ key: 'index.js', kb: 100, text: '' }, { key: 'en.js', kb: 21, text: '' }], b)).toEqual(['en.js: 21.00 KB gzip > 20 KB']);
});
