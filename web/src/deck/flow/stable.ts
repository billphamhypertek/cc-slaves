// hf1117-p2 (perf audit 17/11 C2): React Flow re-parses every node whose object changed (`adoptUserNodes`); a node without
// `measured` loses its handle bounds there, so every wire to it renders nothing for one commit and re-mounts — the
// travelling dots restart at 0 on each `lane` event. DeckView gives each node `measured`, and hands back the previous
// object for a node that did not change, so React Flow skips it altogether.
// Node data must stay JSON; callbacks go through DeckCtx (a function, Set or undefined would compare equal here).
import type { Node } from '@xyflow/react';

/** `next` with every node equal to its namesake in `prev` replaced by that previous object (stable identity). */
export function keepStable(prev: readonly Node[], next: readonly Node[]): Node[] {
  const old = new Map(prev.map(n => [n.id, n]));
  // node objects are plain JSON built in one fixed key order (DeckView), so equal text = equal node
  return next.map(n => { const o = old.get(n.id); return o && JSON.stringify(o) === JSON.stringify(n) ? o : n; });
}
