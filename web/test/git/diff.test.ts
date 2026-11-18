// spec v2.3 §6.2 the diff body rows (web/src/git/diff.ts): old | new numbers, hunks with context, conflict marker lines.
import { describe, expect, test } from 'bun:test';
import { conflictLines, HUNK_MAX, lineDiff, withContext, type DiffRow } from '../../src/git/diff.ts';

const sig = (rows: readonly DiffRow[]) => rows.map(r => `${r.k}${r.a ?? '-'}:${r.b ?? '-'} ${r.t}`);

describe('§6.2 lineDiff', () => {
  test('§6.2 a deleted line has only its old number, an added one only its new number (G1)', () => {
    const rows = lineDiff('a\nb\nc\n', 'a\nB\nB2\nc\n');
    expect(sig(rows)).toEqual(['c1:1 a', 'd2:- b', 'a-:2 B', 'a-:3 B2', 'c3:4 c']);
  });
  test('§6.2 absent old side (new file, G14) → every line added; absent new → every line deleted', () => {
    expect(sig(lineDiff('', '# scratch\n\nx'))).toEqual(['a-:1 # scratch', 'a-:2 ', 'a-:3 x']);
    expect(sig(lineDiff('x\ny', ''))).toEqual(['d1:- x', 'd2:- y']);
  });
  test('§6.2 an edit in the middle of a long file keeps the minimal script (Myers)', () => {
    const a = Array.from({ length: 50 }, (_, i) => `l${i}`);
    const b = [...a.slice(0, 20), 'new', ...a.slice(21, 40), ...a.slice(41)];
    const rows = lineDiff(a.join('\n'), b.join('\n'));
    expect(rows.filter(r => r.k !== 'c').map(r => `${r.k}${r.a ?? r.b} ${r.t}`)).toEqual(['d21 l20', 'a21 new', 'd41 l40']);
    expect(rows.at(-1)).toEqual({ k: 'c', a: 50, b: 49, t: 'l49' });
  });
  test('§6.2 interleaved edits: every old and new line appears once, numbers ascend on both sides', () => {
    const rows = lineDiff('x\na\ny\nb\nz', 'a\nq\nb\nr');
    expect(rows.filter(r => r.a !== null).map(r => r.t)).toEqual(['x', 'a', 'y', 'b', 'z']);
    expect(rows.filter(r => r.b !== null).map(r => r.t)).toEqual(['a', 'q', 'b', 'r']);
    expect(rows.filter(r => r.k === 'c').map(r => r.t)).toEqual(['a', 'b']);
  });
});

describe('§6.2 withContext', () => {
  test('§6.2 3 unchanged lines around a change; a long run between hunks folds into one gap, none at the ends (G1)', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const b = a.map((l, i) => (i === 10 || i === 25 ? 'X' : l));
    const items = withContext(lineDiff(a.join('\n'), b.join('\n')));
    expect(items[0]).toEqual({ k: 'c', a: 8, b: 8, t: 'l7' });
    expect(items.filter(x => 'gap' in x)).toEqual([{ gap: 8 }]);
    expect(items.at(-1)).toEqual({ k: 'c', a: 29, b: 29, t: 'l28' });
  });
  test('§6.2 identical sides → nothing to show', () => {
    expect(withContext(lineDiff('a\nb', 'a\nb'))).toEqual([]);
  });
});

describe('§6.2 conflictLines', () => {
  test('§6.2 markers vs base side vs lane side, ≤ 40 lines per hunk', () => {
    const merged = 'x\n<<<<<<< main\n  return a\n=======\n  return b\n>>>>>>> lane/d15\ny';
    expect(conflictLines(merged, { start: 2, end: 6 }).map(l => `${l.k} ${l.t}`)).toEqual(
      ['m <<<<<<< main', 'o   return a', 'm =======', 't   return b', 'm >>>>>>> lane/d15']);
    const long = ['<<<<<<< main', ...Array.from({ length: 60 }, () => 'z'), '=======', '>>>>>>> b'].join('\n');
    expect(conflictLines(long, { start: 1, end: 63 }).length).toBe(HUNK_MAX);
  });
});
