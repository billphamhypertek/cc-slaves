// spec v2.3 §10.1 ↑↓ / Enter walk the "Nhánh" and "Thay đổi" lists (preventDefault so the page does not scroll).
import { describe, expect, test } from 'bun:test';
import { nextOption } from '../../src/git/list-keys.ts';

describe('§10.1 nextOption', () => {
  test('§10.1 ↓ from the selected row goes to the next; ↑ to the previous; clamps at both ends', () => {
    expect(nextOption('ArrowDown', 1, 4)).toBe(2);
    expect(nextOption('ArrowUp', 1, 4)).toBe(0);
    expect(nextOption('ArrowUp', 0, 4)).toBe(0);
    expect(nextOption('ArrowDown', 3, 4)).toBe(3);
  });
  test('§10.1 nothing selected: ↓ starts at the first row, ↑ at the last; Enter keeps the row; other keys are not ours', () => {
    expect(nextOption('ArrowDown', -1, 4)).toBe(0);
    expect(nextOption('ArrowUp', -1, 4)).toBe(3);
    expect(nextOption('Enter', 2, 4)).toBe(2);
    expect(nextOption('a', 2, 4)).toBeNull();
    expect(nextOption('ArrowDown', -1, 0)).toBeNull();
  });
});
