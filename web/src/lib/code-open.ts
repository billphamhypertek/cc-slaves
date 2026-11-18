// spec v2.3 §6.2 "Mở ở Code": the Git view asks the Code view to open a file on disk (preview tab, §5.4) at a given source,
// without changing Đang xem (§4.2). A request made before Code mounts waits (the switch mounts it in the same tick, like
// ⌘P from Deck, R8) and is taken once; after that the Code view hears each new one.
import type { Src } from '../../../shared/protocol.ts';

export interface CodeOpen { src: Src; path: string; n: number }

let n = 0;
let pending: CodeOpen | null = null;
const fns = new Set<(r: CodeOpen) => void>();

export function requestCodeOpen(src: Src, path: string): void {
  const r = { src, path, n: ++n };
  if (!fns.size) { pending = r; return; }
  for (const fn of fns) fn(r);
}

/** The Code view: the request made before it mounted (null = none; taken, so a later mount does not replay it), then
 *  every new one. */
export function onCodeOpen(fn: (r: CodeOpen) => void): { pending: CodeOpen | null; off: () => void } {
  const p = pending;
  pending = null;
  fns.add(fn);
  return { pending: p, off: () => { fns.delete(fn); } };
}
