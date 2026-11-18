// §8.2 "Dừng an toàn tất cả": every live lane gets the drain message (reducer `drainText`, with its handoff path);
// it ends its turn in draining → stopped. Lanes not yet running are stopped at once by the reducer.
import type { LaneState } from '../db.ts';
import type { LaneManager, LaneView } from './manager.ts';

export interface StopAllSummary {
  /** Drain message sent; ends in stopped after its turn. */
  draining: string[];
  /** Stopped right away (starting/switching/waiting_quota have no turn to finish). */
  stopped: string[];
  /** Already halted or done: untouched. */
  untouched: string[];
  /** Lane states right after the call, per name. */
  states: Record<string, LaneState>;
}

const DRAINABLE: readonly LaneState[] = ['running', 'idle', 'waiting_po'];
const STOPPABLE: readonly LaneState[] = ['starting', 'switching', 'waiting_quota'];
const label = (v: LaneView) => `${v.projectId}/${v.name}`;

/** v2.1 §4.14 "Dừng an toàn lane của #n": `sessionId` keeps only the lanes `ownerOf` says that session owns. */
export interface StopAllFilter {
  projectId?: string;
  sessionId?: string;
  ownerOf?: (projectId: string, name: string) => string | null;
}

export async function stopAll(m: LaneManager, o: StopAllFilter = {}): Promise<StopAllSummary> {
  const lanes = m.listAll().filter((v) => (o.projectId === undefined || v.projectId === o.projectId)
    && (o.sessionId === undefined || o.ownerOf?.(v.projectId, v.name) === o.sessionId));
  const s: StopAllSummary = { draining: [], stopped: [], untouched: [], states: {} };
  await Promise.all(lanes.map(async (v) => {
    if (DRAINABLE.includes(v.state)) { await m.stop(v.projectId, v.name, 'drain'); s.draining.push(label(v)); }
    else if (STOPPABLE.includes(v.state)) { await m.stop(v.projectId, v.name, 'drain'); s.stopped.push(label(v)); }
    else s.untouched.push(label(v));
  }));
  for (const v of lanes) s.states[label(v)] = m.get(v.projectId, v.name)?.state ?? v.state;
  for (const k of ['draining', 'stopped', 'untouched'] as const) s[k].sort();
  return s;
}
