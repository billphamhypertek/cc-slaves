// v2.6 §5.4 the update hold: the app's long-lived Mac WS sends `update_hold {on: true}`; from then the engine reports
// `engine.update` (hold, since, busy, held) and the hold lives exactly as long as that connection (§5.4-6, R5, R10).
// In memory only: an engine restart starts unheld (§5.4-8). It drives the write / spawn gate (`commit.ts`).
import type { UpdateBusy, UpdateCommitResult, UpdateInfo } from '../../../shared/update.ts';
import type { Db } from '../db.ts';
import { UpdateGate } from './commit.ts';

export interface UpdateHoldDeps<C extends object> {
  /** §5.4-4 the sessions mid-turn right now. */
  busy: () => UpdateBusy[];
  /** §4.4 messages received since `sinceMs` that `gate` keeps back. */
  held: (sinceMs: number, gate: UpdateGate) => number;
  /** §5.4-5 nothing is mid-turn: back up, tell `holder` (`update_ready`); a throw = not done (tried again after `RETRY_MS`). */
  ready?: (holder: C) => void;
  /** The first failure of a streak of `ready` (the engine logs it once). */
  failed?: (err: Error) => void;
  gate?: UpdateGate;
  /** §5.5-4 (R22) a commit was accepted: runs before the ack (the engine records who to wake after the restart). */
  committed?: () => void;
  /** A sealed hold was released (no update restart came): the engine drops the R22 resume file. */
  released?: () => void;
  /** `engine.update` moved: the engine broadcasts `{type:'engine'}`. */
  changed: () => void;
  now?: () => number;
  /** How often a held engine re-reads busy / held (0 = never, tests call `refresh`). */
  tickMs?: number;
}

/** Orchestrator ruling (v26-rv-e MINOR-1): a failing backup is tried again at most this often. */
const RETRY_MS = 30_000;
const OFF: UpdateInfo = { hold: false, since: null, busy: [], held: 0 };

export class UpdateHold<C extends object = object> {
  readonly gate: UpdateGate;
  /** The connection that holds (compared by identity only). */
  private holder: C | null = null;
  /** `update_ready` went for this idle stretch (a turn starting again re-arms it). */
  private readySent = false;
  /** A failure streak of `ready`: the next try is not before this time. */
  private retryAt: number | null = null;
  private since: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = JSON.stringify(OFF);

  constructor(private readonly d: UpdateHoldDeps<C>) { this.gate = d.gate ?? new UpdateGate(); }

  /** `update_hold {on: true}`: the newest connection holds (an app that reconnected); `since` stays. */
  on(c: C): void {
    this.holder = c;
    this.gate.hold(true);
    this.since ??= (this.d.now ?? Date.now)();
    const ms = this.d.tickMs ?? 1000;
    if (this.timer === null && ms > 0) this.timer = setInterval(() => this.refresh(), ms);
    this.refresh();
  }

  /** `update_hold {on: false}`: only the holder releases (the webview never drops the app's hold). */
  off(c: C): void { if (c === this.holder) this.release(); }

  /** §5.4-6 a WS closed: the holder's → released. */
  closed(c: C): void { if (c === this.holder) this.release(); }

  /** §5.4-9 `update_commit` from the holder: busy again → `{ok: false, busy}`; null = this connection does not hold. */
  /** `ok` seals the gate in the same tick (no turn can be written in between). */
  commit(c: C): UpdateCommitResult | null {
    if (c !== this.holder) return null;
    const busy = this.d.busy();
    if (busy.length) { this.readySent = false; return { ok: false, busy }; } // the app waits for a new update_ready (A1)
    this.gate.seal();
    this.d.committed?.();
    return { ok: true };
  }

  view(): UpdateInfo {
    if (this.since === null) return OFF;
    return { hold: true, since: this.since, busy: this.d.busy(), held: this.d.held(this.since, this.gate) };
  }

  /** Re-read the view; `changed` only when it moved (a turn started / ended, a message was held). Busy empty → ready. */
  refresh(): void {
    const view = this.view();
    if (view.busy.length) this.readySent = false;
    else if (this.holder !== null && !this.readySent) this.tryReady(this.holder);
    const v = JSON.stringify(view);
    if (v === this.last) return;
    this.last = v;
    this.d.changed();
  }

  /** Engine stop: no timer left behind, and the sockets the stop closes release nothing (the update restart keeps the resume file). */
  stop(): void {
    this.holder = null;
    this.stopTimer();
  }

  private tryReady(holder: C): void {
    const now = (this.d.now ?? Date.now)();
    if (this.retryAt !== null && now < this.retryAt) return;
    try {
      this.d.ready?.(holder);
      this.readySent = true;
      this.retryAt = null;
    } catch (err) {
      if (this.retryAt === null) this.d.failed?.(err as Error);
      this.retryAt = now + RETRY_MS;
    }
  }

  private release(): void {
    const sealed = !this.gate.controls;
    this.holder = null;
    this.since = null;
    this.readySent = false;
    this.retryAt = null;
    this.stopTimer();
    this.gate.hold(false);
    if (sealed) this.d.released?.();
    this.refresh();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

interface LaneTurns { listAll(): { projectId: string; name: string; turnStartedAt: number | null }[] }
interface OrchTurns { all(): { projectId: string; currentSessionId: string; turnStartedAt: number | null }[] }

/** §5.4-4 busy = a live session with `turnStartedAt` set (a lane by name, an orchestrator by its session id), or a
 *  spawn running (`spawning`, one entry per session). */
export function sessionsBusy(lanes: LaneTurns, orchs: OrchTurns, spawning: readonly UpdateBusy[] = []): UpdateBusy[] {
  const out: UpdateBusy[] = [];
  for (const l of lanes.listAll()) if (l.turnStartedAt !== null) out.push({ projectId: l.projectId, kind: 'lane', name: l.name, turnStartedAt: l.turnStartedAt });
  for (const o of orchs.all()) {
    if (o.turnStartedAt !== null) out.push({ projectId: o.projectId, kind: 'orchestrator', name: o.currentSessionId, turnStartedAt: o.turnStartedAt });
  }
  const same = (a: UpdateBusy, b: UpdateBusy) => a.projectId === b.projectId && a.kind === b.kind && a.name === b.name;
  for (const s of spawning) if (!out.some((b) => same(b, s))) out.push(s);
  return out;
}

/** §4.4 "Đang giữ n tin": undelivered outbox rows created since the hold began, of the sessions the gate kept back. */
export function heldSince(db: Db, sinceMs: number, gate: UpdateGate): number {
  const ids = gate.blocked();
  if (ids.length === 0) return 0;
  return db.query<{ n: number }, (string | number)[]>(
    `SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL AND created_at >= ? AND session_id IN (${ids.map(() => '?').join(',')})`,
  ).get(Math.floor(sinceMs / 1000), ...ids)!.n;
}
