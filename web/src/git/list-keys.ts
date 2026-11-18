// spec v2.3 §10.1 keyboard on the Git lists: ↑↓ move the selection (it opens like a click), Enter re-opens the row;
// preventDefault so the column does not scroll under the key. Rows are the list's `[role=option]` children.
import type { KeyboardEvent } from 'react';

/** The row a key leads to from `cur` (-1 = none selected) among `n` rows; null = not a list key / empty list. */
export function nextOption(key: string, cur: number, n: number): number | null {
  if (!n) return null;
  if (key === 'ArrowDown') return cur < 0 ? 0 : Math.min(n - 1, cur + 1);
  if (key === 'ArrowUp') return cur < 0 ? n - 1 : Math.max(0, cur - 1);
  if (key === 'Enter') return cur < 0 ? null : cur;
  return null;
}

/** `onKeyDown` of a `role=listbox`: clicks the row the key leads to and keeps it in view. */
export function onListKey(e: KeyboardEvent<HTMLElement>): void {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=option]')];
  const i = nextOption(e.key, rows.findIndex(r => r.getAttribute('aria-selected') === 'true'), rows.length);
  if (i === null) return;
  e.preventDefault();
  rows[i]!.click();
  rows[i]!.scrollIntoView({ block: 'nearest' });
}
