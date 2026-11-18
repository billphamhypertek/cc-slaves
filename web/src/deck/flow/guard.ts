// v2.1 §4.12 "Chống bấm nhầm" (v1 U1): a node that just moved because the layout changed ignores clicks for 1 s.
export const MOVE_GUARD_MS = 1000;

export class MoveGuard {
  private pos = new Map<string, string>();
  private moved = new Map<string, number>();
  /** Call with every node after each layout; a node whose position changed is armed at `now`. */
  update(nodes: readonly { id: string; x: number; y: number }[], now: number): void {
    for (const n of nodes) {
      const k = `${n.x},${n.y}`, prev = this.pos.get(n.id);
      if (prev !== undefined && prev !== k) this.moved.set(n.id, now);
      this.pos.set(n.id, k);
    }
  }
  allow(id: string, now: number): boolean {
    const t = this.moved.get(id);
    return t === undefined || now - t >= MOVE_GUARD_MS;
  }
}

/** §4.12 the "⋯" menu: a pointer click obeys the guard; the keyboard (ContextMenu / ⇧F10) never does. */
export const menuAllowed = (g: MoveGuard, id: string, now: number, via: 'pointer' | 'key') => via === 'key' || g.allow(id, now);
