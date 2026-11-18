// v2.1 deck intents (spec §4.11), keys 1–9 and the
// Chờ PO card glow (§4.11, v1 U6). Pure: the App turns a DeckIntent into its own state changes.

/** v2.1 §4.11 node clicks → what the App does. */
export type DeckIntent =
  | { t: 'lane'; name: string } | { t: 'account'; email: string }
  /** §4.14 click a root = view that session (and it becomes the composer target). */
  | { t: 'orch'; root?: string }
  | { t: 'card'; cardId: number | null; lane: string | null }
  | { t: 'sub'; lane: string; taskId: string | null }
  /** "+n" sub: select the parent lane (Đang xem scrolls to its subagents). */
  | { t: 'more'; lane: string }
  | { t: 'orch_restart'; root?: string }
  | { t: 'add_project' }
  /** §4.15 §2 "n lane khác" row: open that tree again; §4.15 §3 "n lane xong cũ hơn…": the done list. */
  | { t: 'expand'; root: string } | { t: 'done_list' }
  /** v2.7 §4.2-3 the issue chip of a lane node: Tasks on that issue. */
  | { t: 'issue'; key: string };

/** v2.1 §4.11 keys 1–9 → the n-th lane of the layout key order (tree order over visible lanes, the shelf excluded). */
export const keyLane = (keys: readonly string[], n: number): string | null => keys[n - 1] ?? null;

export const FLASH_MS = 1200;
type ClassEl = { classList: { add(c: string): void; remove(c: string): void } };
/** §4.4 / U6: the focused Chờ anh card glows 1.2 s. Returns false when no focused card is rendered. */
export function flashCard(root: { querySelector(s: string): ClassEl | null }, later: (f: () => void, ms: number) => unknown = setTimeout): boolean {
  const el = root.querySelector('#inbox .card.focus');
  if (!el) return false;
  el.classList.remove('flash');
  el.classList.add('flash');
  later(() => el.classList.remove('flash'), FLASH_MS);
  return true;
}

/** §4.5 / §4.15 §2 row nodes: "+n" → its lane's subagents, "n lane khác" (`row:<root>`) → open that tree. */
export function rowIntent(kind: 'more' | 'collapsedRow', id: string, lane: string | null): DeckIntent {
  return kind === 'more' ? { t: 'more', lane: lane! } : { t: 'expand', root: id.slice('row:'.length) };
}
/** §4.14 clicking a root card ("orch:<sessionId>") = view that session (Đang xem + the composer / watch target). */
export const rootIntent = (nodeId: string): DeckIntent => ({ t: 'orch', root: nodeId.slice('orch:'.length) });
