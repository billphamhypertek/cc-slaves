// v2.1 §5.3 W9 / §4.5 subagents of each lane, built from its `system/task_*` events (v1 §3.3-20: a subagent carries
// `subagent_type`; background Bash tasks do not). Completed ones get `endedAt` (the web hides them 60 s later); the
// engine drops a failed one when the lane's turn ends and a completed one once it is over 60 s old.
import type { SubagentView, Target } from '../../../shared/protocol.ts';
import type { TaskEvent } from '../stream/parser.ts';

const COMPLETED_KEEP_MS = 60_000;
const FAILED = new Set(['failed', 'error', 'killed', 'stopped', 'cancelled']);

const keyOf = (t: Target) => (t.kind === 'lane' ? `l\u0000${t.projectId}\u0000${t.name}` : `o\u0000${t.projectId}`);

export class SubagentTracker {
  private readonly byTarget = new Map<string, { target: Target; subs: Map<string, SubagentView> }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Applies one task event; true when that target's list changed. */
  task(t: Target, e: TaskEvent): boolean {
    if (e.taskId === null) return false;
    const k = keyOf(t);
    if (e.kind === 'task_started') {
      if (!e.isSubagent) return false;
      let slot = this.byTarget.get(k);
      if (!slot) { slot = { target: t, subs: new Map() }; this.byTarget.set(k, slot); }
      slot.subs.set(e.taskId, {
        taskId: e.taskId, toolUseId: e.toolUseId ?? '', description: e.description ?? '', subagentType: e.subagentType ?? '',
        background: e.isBackgrounded, status: 'running', totalTokens: null, toolUses: null, lastTool: null, startedAt: this.now(), endedAt: null,
      });
      return true;
    }
    const s = this.byTarget.get(k)?.subs.get(e.taskId);
    if (!s) return false;
    if (e.totalTokens !== null) s.totalTokens = e.totalTokens;
    if (e.toolUses !== null) s.toolUses = e.toolUses;
    if (e.lastToolName !== null) s.lastTool = e.lastToolName;
    const st = e.status;
    const end = (status: 'completed' | 'failed') => { if (s.status === 'running') { s.status = status; s.endedAt = this.now(); } };
    if (st !== null && FAILED.has(st)) end('failed');
    else if (st === 'completed' || (e.kind === 'task_notification' && st === null)) end('completed');
    return true;
  }

  /** The lane's turn ended (`result`): failed ones go, completed ones past 60 s go. True when the list changed. */
  turnEnded(t: Target): boolean {
    const slot = this.byTarget.get(keyOf(t));
    if (!slot) return false;
    const cut = this.now() - COMPLETED_KEEP_MS;
    let changed = false;
    for (const [id, s] of slot.subs) {
      if (s.status === 'failed' || (s.status === 'completed' && (s.endedAt ?? 0) < cut)) { slot.subs.delete(id); changed = true; }
    }
    return changed;
  }

  list(t: Target): SubagentView[] {
    return [...(this.byTarget.get(keyOf(t))?.subs.values() ?? [])].map((s) => ({ ...s }));
  }

  /** Every target of a project that has (or had) subagents, in first-seen order. */
  forProject(projectId: string): { target: Target; subagents: SubagentView[] }[] {
    return [...this.byTarget.values()].filter((x) => x.target.projectId === projectId)
      .map((x) => ({ target: x.target, subagents: this.list(x.target) }));
  }

  /** A lane was removed. */
  forget(t: Target): void { this.byTarget.delete(keyOf(t)); }
}
