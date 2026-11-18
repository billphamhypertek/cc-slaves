// spec v2.3 §4.2 the Code source follows Đang xem, one way (a chip / branch click never changes Đang xem): a lane with a
// worktree → that worktree; anything else → the project folder, with the reason when Đang xem is a lane (C12 band).
import type { LaneView } from '../../../shared/protocol.ts';
import { selLane, type Selection } from '../lib/inspector.ts';

export interface CodeSrc {
  /** the lane whose worktree is the source; null = the project folder. */
  lane: string | null;
  /** Đang xem is a lane but the project folder is shown: its worktree is gone (C12) / it runs in the repo (v2.1 §4.15). */
  note: { k: 'noWorktree' | 'direct'; lane: string } | null;
}

export function srcFor(sel: Selection, lanes: readonly Pick<LaneView, 'name' | 'worktreeExists' | 'branch'>[]): CodeSrc {
  const name = selLane(sel);
  const l = name === null ? undefined : lanes.find(x => x.name === name);
  if (!l) return { lane: null, note: null };
  if (l.branch?.state === 'none') return { lane: null, note: { k: 'direct', lane: l.name } };
  if (!l.worktreeExists) return { lane: null, note: { k: 'noWorktree', lane: l.name } };
  return { lane: l.name, note: null };
}

/** A chip pick (V3) holds while Đang xem still maps to the source it was made from (`from` = that source's key) and the
 *  picked lane still has its worktree; otherwise the source follows Đang xem again. */
export function pickedSrc(follow: CodeSrc, followKey: string, picked: { from: string; lane: string | null } | null, worktrees: ReadonlySet<string>): CodeSrc {
  if (!picked || picked.from !== followKey || (picked.lane !== null && !worktrees.has(picked.lane))) return follow;
  return { lane: picked.lane, note: null };
}
