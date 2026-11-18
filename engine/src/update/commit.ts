// v2.6 §5.4 / §10.3 the update gate: one switch in front of every stdin write (`SessionProcess.flush`) and every spawn
// (`LaneManager.spawn`, `Orchestrator.spawn`) — never an `if (hold)` per call site. Held: rows stay in the outbox, a spawn
// waits for the release (or the next boot's recovery, §5.4-3). Sealed (`update_commit` ok, §5.4-9): control lines stop too,
// except permission answers. Plus §5.4-5 the `VACUUM INTO` backup of `state.db` (newest 3 kept).
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateBusy } from '../../../shared/update.ts';
import type { Db } from '../db.ts';

export class UpdateGate {
  private held = false;
  private sealed = false;
  private readonly deferred: (() => void)[] = [];
  /** §5.4-4 spawns between `Bun.spawn` and the end of the self-check (busy), by their `SessionProcess`. */
  private readonly starting = new Map<object, UpdateBusy>();
  /** §4.4 sessions whose write or spawn this gate kept back (the `held` count reads only these). */
  private readonly blockedIds = new Set<string>();

  /** `opened` runs after a release: every live process writes what waited. */
  constructor(private readonly opened: () => void = () => {}) {}

  /** Outbox rows may go to stdin. */
  get writes(): boolean { return !this.held; }
  /** Control lines (interrupt, `control_request`) may go; permission answers always do (§5.4-9). */
  get controls(): boolean { return !this.sealed; }

  /** `update_hold` on / released (off, holder WS closed): a release runs the deferred spawns, then `opened`. */
  hold(on: boolean): void {
    if (on) { this.held = true; return; }
    if (!this.held) return;
    this.held = false;
    this.sealed = false;
    this.blockedIds.clear();
    for (const run of this.deferred.splice(0)) run();
    this.opened();
  }

  /** §5.4-9 `update_commit` ok: from now on nothing but permission answers. */
  seal(): void { if (this.held) this.sealed = true; }

  /** A flush of `sessionId` was refused (its rows stay queued). */
  refused(sessionId: string): void { this.blockedIds.add(sessionId); }

  /** Held → `run` waits for the release (true: the caller spawns nothing now). Not held → false. */
  defer(sessionId: string, run: () => void): boolean {
    if (!this.held) return false;
    this.blockedIds.add(sessionId);
    this.deferred.push(run);
    return true;
  }

  spawnBegan(key: object, b: UpdateBusy): void { this.starting.set(key, b); }
  spawnEnded(key: object): void { this.starting.delete(key); }
  /** §5.4-4 the spawns running now (a deferred one is not here, R11). */
  spawning(): UpdateBusy[] { return [...this.starting.values()]; }
  blocked(): string[] { return [...this.blockedIds]; }
}

const KEEP = 3;
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

/** §5.4-5 `VACUUM INTO <dir>/state-<version>-<yyyymmdd-hhmm>.db`, then only the newest 3 `state-*.db` stay. */
export function backupState(db: Db, o: { dir: string; version: string; now?: Date }): string {
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const path = join(o.dir, `state-${o.version}-${stamp(o.now ?? new Date())}.db`);
  rmSync(path, { force: true }); // a second ready in the same minute: VACUUM INTO refuses an existing file
  db.run('VACUUM INTO ?', [path]);
  const old = readdirSync(o.dir).filter((f) => /^state-.*\.db$/.test(f)).map((f) => join(o.dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || b.localeCompare(a));
  for (const f of old.slice(KEEP)) rmSync(f, { force: true });
  return path;
}
