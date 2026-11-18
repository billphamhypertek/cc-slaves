// Held projects (hotfix 2026-11-16): after an app restart, or right after `project_add`, nothing of a project runs until
// the PO presses "Tiếp tục" / "Bắt đầu" (`project_resume`) or talks to it (send, a card answer, a lane command that
// runs it). Its sessions / lanes wait `paused` (in memory only), so 100 added projects cost no token at launch.
import type { ProjectView } from '../../../shared/protocol.ts';
import type { Engine } from '../engine.ts';

export type HeldKind = 'start' | 'resume';

export class HeldProjects {
  private readonly kinds = new Map<string, HeldKind>();

  constructor(private readonly e: Pick<Engine, 'db' | 'orchestrators' | 'lanes' | 'projectView' | 'broadcast'>) {}

  mark(projectId: string, kind: HeldKind): void { this.kinds.set(projectId, kind); }

  /**
   * A project held by recovery / a reopen: "resume" once it ever talked (a lane, or a message delivered to one of its
   * sessions); a project added but never answered stays "start" (A-M3).
   */
  markRestored(projectId: string): void {
    const talked = this.e.db.query<{ n: number }, [string, string]>(
      `SELECT EXISTS(SELECT 1 FROM lane WHERE project_id = ?)
         OR EXISTS(SELECT 1 FROM outbox o JOIN session s ON s.id = o.session_id WHERE s.project_id = ? AND o.delivered_at IS NOT NULL) AS n`,
    ).get(projectId, projectId)!.n;
    this.mark(projectId, talked ? 'resume' : 'start');
  }
  drop(projectId: string): void { this.kinds.delete(projectId); }

  /** `ProjectView.held`: null when not held or when nothing of it is paused any more (e.g. its lanes were stopped). */
  view(projectId: string): ProjectView['held'] {
    const kind = this.kinds.get(projectId);
    if (!kind) return null;
    const sessions = this.e.orchestrators.list(projectId).filter((o) => o.view().state === 'paused').length;
    const lanes = this.e.lanes.list(projectId).filter((v) => v.state === 'paused').length;
    return sessions + lanes > 0 ? { kind, sessions, lanes } : null;
  }

  /**
   * Resume a held project: its paused lanes and sessions run what recovery used to run, `held` → null (broadcast).
   * The one hook every PO path calls first (send, card answer, lane / session commands). False = it was not held.
   */
  async wake(projectId: string): Promise<boolean> {
    if (!this.unmark(projectId)) return false;
    await this.e.orchestrators.unpause(projectId);
    return true;
  }

  /**
   * v2.6 §5.5-4 (R22, R15) the boot after an update, for a project not held at `update_commit`: like `wake`, but an
   * orchestrator with nothing unsent only turns idle (no boot, no resume message); lanes resume as in `wake`.
   */
  async wakeAfterUpdate(projectId: string): Promise<void> {
    if (!this.unmark(projectId)) return;
    await Promise.all(this.e.orchestrators.list(projectId).map((o) => o.wakeAfterUpdate()));
  }

  /** Held → not held (broadcast) and its paused lanes run; false = it was not held. */
  private unmark(projectId: string): boolean {
    if (!this.kinds.delete(projectId)) return false;
    const v = this.e.projectView(projectId);
    if (v) this.e.broadcast({ type: 'project', project: v });
    this.e.lanes.unpause(projectId);
    return true;
  }
}
