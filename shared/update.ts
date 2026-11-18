// v2.6 §5.4 / §10.3 the update hold on the wire. `update_hold` / `update_commit` come only from the app's long-lived Mac
// WS (never in REMOTE_ALLOWED, §10.2); `engine.update` reaches every channel (§8 UP9); `update_ready` goes to the holding
// WS only. Additive: no PROTOCOL_VERSION bump.
import type { Target } from './protocol.ts';

/** §5.4-4 one session mid-turn while the app waits to update: `name` = the lane name, the orchestrator's session id, or
 *  the workflow draft id (a v2.9 author session, `projectId` `_workflow`). */
export interface UpdateBusy { projectId: string; kind: 'lane' | 'orchestrator' | 'workflow'; name: string; turnStartedAt: number }
/** §5.4-4 `engine.update`: `since` epoch ms (null when not held), `held` = messages kept back since then (§4.4). */
export interface UpdateInfo { hold: boolean; since: number | null; busy: UpdateBusy[]; held: number }
/** §5.4-9 `update_commit` ack: `ok: false` = a turn (self-started) is running, `busy` lists it; the app waits again. */
export type UpdateCommitResult = { ok: true } | { ok: false; busy: UpdateBusy[] };

export type UpdateCommand = { cmd: 'update_hold'; on: boolean } | { cmd: 'update_commit' };

export type UpdateEngineEvent =
  /** §10.3 these `held` PO lines (seq) were written to Claude Code: the label goes. Watched only. */
  | { type: 'po_written'; target: Target; seqs: number[] }
  /** §5.4-5 to the holding WS only (never broadcast): nothing is mid-turn, `state.db` was copied to `backup`. */
  | { type: 'update_ready'; backup: string };
