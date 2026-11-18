// v2.7 §5.3 engine → orchestrator `[cc-slaves] …` messages about issues, routed §5.3: an issue of a spec → that spec's
// Build session; outside any spec → the running Chung session, else the session that created it (not a Thiết kế one),
// else the newest Chung session's outbox. Never a Thiết kế session. Also the lane hold / return hook (§5.3, R15).
// `send` is the Orchestrators wiring (live process, else the outbox), never notify/notify.ts (that one is for the PO).
import type { Db } from '../db.ts';
import type { IssueRow, OrchKind, SpecRow } from '../../../shared/issues.ts';
import type { LaneIssueHook, LaneRef } from '../lane/manager/types.ts';
import { getIssue, getSpec, issueViews, laneIssues, listIssues, readyIssues, releaseIssue } from './store.ts';
import { render } from '../workflow/compile.ts';
import { readRev } from '../workflow/runtime.ts';

export interface EventTimers { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }
export interface IssueEventPorts {
  db: Db;
  /** Deliver to an orchestrator session: its live process, else its outbox. */
  send: (sessionId: string, text: string) => void;
  /** Does the session have a live runtime now. */
  running: (sessionId: string) => boolean;
  /** §5.4 a lane slot free right now (the outside-spec reminder only fires then). */
  hasRoom: (projectId: string) => boolean;
  timers?: EventTimers;
}

/** §5.4 R10: an outside-spec issue still `todo` this long after creation is recalled once. */
const REMIND_MS = 10 * 60_000;
const READY_MAX = 6;
const P = '[cc-slaves]';
const keys = (l: readonly string[]) => l.join(', ');
/** §5.1 a cancelled blocker still blocks until the orchestrator unlinks it. */
const blockedNote = (open: readonly string[]) =>
  (open.length ? ` ${keys(open)} bị chặn tới khi Điều phối gỡ / sửa phụ thuộc (issue_link {remove: true}).` : '');
const realTimers: EventTimers = {
  set: (fn, ms) => { const h = setTimeout(fn, ms); h.unref(); return h; },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class IssueEvents implements LaneIssueHook {
  private readonly timers: EventTimers;
  private readonly reminders = new Set<unknown>();

  constructor(private readonly p: IssueEventPorts) { this.timers = p.timers ?? realTimers; }

  // ---------- issue events ----------
  /** §5.4 a new outside-spec issue: "mở lane riêng" now, one reminder after 10 min while still unassigned. */
  issueCreated(i: IssueRow): void {
    if (i.specId !== null || i.state !== 'todo') return;
    this.toIssue(i, `${P} ${i.key} (ngoài spec) mới — mở lane riêng: ${i.title}`, i.createdBySession);
    const h = this.timers.set(() => {
      this.reminders.delete(h);
      const now = getIssue(this.p.db, i.id);
      if (now?.state !== 'todo' || now.laneId !== null || !this.p.hasRoom(i.projectId)) return;
      this.toIssue(now, `${P} ${i.key} (ngoài spec) vẫn chưa giao sau 10 phút — mở lane riêng: lane_start {issue: "${i.key}"}`);
    }, REMIND_MS);
    this.reminders.add(h);
  }

  /** §5.5-6 after `issue_done`: the issues it unblocked, then "spec xong hết mục" when it was the last open one. */
  issueDone(i: IssueRow): void {
    const views = issueViews(this.p.db, i.projectId);
    const waiting = this.p.db.query<{ issue_id: number }, [number]>('SELECT issue_id FROM issue_dep WHERE blocked_by_id = ?').all(i.id);
    for (const w of waiting) {
      const v = views.find((x) => x.issue.id === w.issue_id);
      if (v?.issue.state === 'todo' && v.blockedBy.length === 0) this.toIssue(v.issue, `${P} ${v.issue.key} hết bị chặn`);
    }
    if (i.specId !== null) this.specSettled(i.specId);
    if (i.reverts !== null) this.reverted(i.reverts, i.specId);
  }

  /** §5.7-6 a revert issue is done: its original is cancelled; whatever it blocks needs the orchestrator. */
  private reverted(origId: number, settled: number | null): void {
    const orig = getIssue(this.p.db, origId);
    if (!orig) return;
    this.toIssue(orig, `${P} ${orig.key} đã hoàn tác (huỷ).${blockedNote(this.dependants(orig.id).open)}`);
    if (orig.specId !== null && orig.specId !== settled) this.specSettled(orig.specId);
  }

  /** §5.5-5 a dependency removed: "hết bị chặn" when nothing blocks it any more. */
  unblocked(i: IssueRow): void {
    const v = issueViews(this.p.db, i.projectId).find((x) => x.issue.id === i.id);
    if (v?.issue.state === 'todo' && v.blockedBy.length === 0) this.toIssue(v.issue, `${P} ${i.key} hết bị chặn`);
  }

  /** §5.2-5 every issue of an active spec `done` / `cancelled`, no revert under way → the Build session closes it. */
  specSettled(specId: number): void {
    const s = getSpec(this.p.db, specId);
    if (s?.state !== 'active') return;
    const all = listIssues(this.p.db, s.projectId, { specId });
    const open = all.some((x) => x.state === 'todo' || x.state === 'doing' || x.revert === 'pending' || x.revert === 'running');
    const w = readRev(s.workflowRev); // ruling 22:36 a missing rev: the event is skipped (logged once), never thrown
    if (all.length === 0 || open || !w) return;
    this.toSpec(s, `${P} ${render(w.settled, { path: s.path })}`); // v2.9 §5.5 `settled` of the spec's rev
  }

  // ---------- §5.7 PO cancel / revert ----------
  /** §5.7-2 / -3 / -4 the PO confirmed IS4 on `i`: what the engine did, what the orchestrator does next. */
  poCancelled(i: IssueRow, f: { reason: string | null; lane: { name: string; branch: string | null } | null; revert: { issue: IssueRow; branch: string | null; shas: number } | null }): void {
    const why = f.reason ? ` — lý do: ${f.reason}` : '';
    const { open, done } = this.dependants(i.id);
    const stopped = f.lane ? ` Engine đã dừng và kết thúc lane ${f.lane.name}.` : '';
    if (f.revert) {
      const r = f.revert.issue;
      const on = f.revert.branch === null ? '' : ` trên \`${f.revert.branch}\``;
      this.toIssue(r, `${P} PO huỷ ${i.key} (đã xong)${why}.${stopped} Tạo ${r.key} "${r.title}" (ưu tiên): gộp ${f.revert.shas} commit${on} thành `
        + `một commit Revert, test, merge. Giao lane: lane_start {issue: "${r.key}"}.${done.length ? ` ${keys(done)} (đã xong) xây trên ${i.key}: hoàn tác có thể vướng.` : ''}`
        + blockedNote(open));
      return;
    }
    if (f.lane) {
      const br = f.lane.branch ? ` nhánh \`${f.lane.branch}\`` : ' nhánh';
      this.toIssue(i, `${P} PO huỷ ${i.key} (đang làm)${why}.${stopped} Xoá worktree +${br} của lane (chưa merge: không cần hoàn tác).${blockedNote(open)}`);
      return;
    }
    this.toIssue(i, `${P} PO huỷ ${i.key}: ${i.title}${why}.${blockedNote(open)}`);
  }

  /** §5.7-5 the revert lane hit a conflict: the revert issue is cancelled, the PO decides on the card. */
  revertConflict(orig: IssueRow, r: IssueRow, detail: string, blocker: string | null): void {
    this.toIssue(r, `${P} Hoàn tác ${orig.key} vướng${blocker ? ` ${blocker}` : ''}: ${detail}. ${r.key} đã huỷ, ${orig.key} vẫn xong, đã hỏi PO. `
      + `Kết thúc lane giữ ${r.key} (lane_finish); không thử lại khi PO chưa trả lời.`);
  }

  /** §5.7-5 "Giữ T-46": nothing is reverted. */
  revertKept(orig: IssueRow): void { this.toIssue(orig, `${P} PO giữ ${orig.key} (không hoàn tác).`); }

  /** Issues blocked by `id`: still open / already done. */
  private dependants(id: number): { open: string[]; done: string[] } {
    const rows = this.p.db.query<{ issue_id: number }, [number]>('SELECT issue_id FROM issue_dep WHERE blocked_by_id = ?').all(id)
      .map((d) => getIssue(this.p.db, d.issue_id)!).filter(Boolean);
    return {
      open: rows.filter((r) => r.state === 'todo' || r.state === 'doing').map((r) => r.key),
      done: rows.filter((r) => r.state === 'done').map((r) => r.key),
    };
  }

  /** §5.6 "Cho làm" (G3a calls it): a note, nothing to do. */
  poOk(i: IssueRow): void { this.toIssue(i, `${P} PO cho làm ${i.key}: ${i.title} (ghi nhận)`); }

  /** §5.2-9 `spec_amend` → the Build session, text verbatim. */
  amended(s: SpecRow, n: number, summary: string, sha: string | null): void {
    this.toSpec(s, `${P} Spec ${s.path} được bổ sung (lần ${n}): ${summary} · commit ${sha ? sha.slice(0, 7) : '(không có git)'}. ` +
      'Đọc diff, tạo mục mới (source amend), huỷ mục todo không còn cần, dừng / giao lại lane nếu việc đang làm bị đổi.');
  }

  // ---------- LaneManager hook (§5.3, R15) ----------
  /** Right after the "lane rảnh" message: what the lane's spec still has ready, priority marked ↑. */
  laneIdle(l: LaneRef): void {
    const s = this.laneSpec(l);
    if (s?.state !== 'active') return;
    const ready = readyIssues(this.p.db, s.projectId, s.id).slice(0, READY_MAX);
    if (ready.length === 0) return;
    this.toSpec(s, `${P} ${s.path} còn sẵn sàng: ${ready.map((v) => `${v.issue.key}${v.priority ? '↑' : ''}`).join(', ')}`);
  }

  /** `lane_finish` / done with the issue not done → back to `todo` (the only way an issue leaves its lane). */
  laneEnded(l: LaneRef, reason: string): void {
    for (const i of laneIssues(this.p.db, l.laneId).filter((x) => x.state === 'doing')) {
      const back = releaseIssue(this.p.db, i.id, reason);
      this.toIssue(back, `${P} ${i.key} trả về hàng (lane ${l.name} ${reason})`);
    }
  }

  /** A broken lane keeps its issue; the orchestrator decides. */
  laneBroken(l: LaneRef): void {
    for (const i of laneIssues(this.p.db, l.laneId).filter((x) => x.state === 'doing')) {
      this.toIssue(i, `${P} ${i.key} kẹt ở lane hỏng ${l.name}: resume hoặc finish`);
    }
  }

  stop(): void { for (const h of this.reminders) this.timers.clear(h); this.reminders.clear(); }

  // ---------- routing ----------
  private kindOf(sid: string): OrchKind | null {
    return this.p.db.query<{ orch_kind: OrchKind }, [string]>("SELECT orch_kind FROM session WHERE id = ? AND kind = 'orchestrator'").get(sid)?.orch_kind ?? null;
  }

  private toSpec(s: SpecRow, text: string): void {
    const sid = s.buildSession;
    if (sid !== null && this.kindOf(sid) === 'build') this.p.send(sid, text);
  }

  /** `skip` = the session that caused the event: it is not told about its own act. */
  private toIssue(i: IssueRow, text: string, skip: string | null = null): void {
    if (i.specId !== null) {
      const s = getSpec(this.p.db, i.specId);
      if (s && s.buildSession !== skip) this.toSpec(s, text);
      return;
    }
    const sid = this.outsideReceiver(i);
    if (sid !== null && sid !== skip) this.p.send(sid, text);
  }

  private outsideReceiver(i: IssueRow): string | null {
    const general = this.p.db.query<{ id: string }, [string]>(
      "SELECT id FROM session WHERE project_id = ? AND kind = 'orchestrator' AND orch_kind = 'general' AND ended_at IS NULL ORDER BY created_at DESC",
    ).all(i.projectId).map((r) => r.id);
    const live = general.find((id) => this.p.running(id));
    if (live) return live;
    const by = i.createdBySession;
    if (by !== null && this.kindOf(by) !== null && this.kindOf(by) !== 'design') return by;
    return general[0] ?? null;
  }

  /** The spec a lane works for: its latest issue's, else the spec its owner session builds. */
  private laneSpec(l: LaneRef): SpecRow | null {
    const last = laneIssues(this.p.db, l.laneId).filter((x) => x.specId !== null).at(-1);
    if (last) return getSpec(this.p.db, last.specId!);
    const id = this.p.db.query<{ id: number }, [number]>(
      'SELECT s.id FROM spec s JOIN lane l ON l.owner_session = s.build_session WHERE l.id = ?',
    ).get(l.laneId)?.id;
    return id === undefined ? null : getSpec(this.p.db, id);
  }
}
