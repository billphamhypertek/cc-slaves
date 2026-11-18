// v2.7 §5.5 hard rules (G6) and the spec lifecycle guards, pure over plain data. Every refusal is Vietnamese and names the
// right way; the caller (MCP tool / WS command) loads the rows, asks here, and only then writes through store.ts.
// v2.9 §5.6 / §5.7 the refusals carry the workflow's document label, step names and "start" label, and the §5.7 rules are its
// flags (`WfText`, built by workflow/runtime.ts from the pinned rev); the background rules always hold.
import type { IssueRow, IssueSource, IssueState, OrchKind, SpecRow, SpecState } from '../../../shared/issues.ts';
import type { Rules } from '../workflow/vocab.ts';

export type Verdict = { ok: true; existing?: string } | { ok: false; msg: string };
export type IssueLite = Pick<IssueRow, 'id' | 'key' | 'num' | 'projectId' | 'specId' | 'state' | 'source' | 'laneId' | 'reverts' | 'revert' | 'baseSha'>;
export type SpecLite = Pick<SpecRow, 'id' | 'path' | 'state' | 'origin' | 'designSession' | 'buildSession' | 'editSession' | 'resumed' | 'outsideBuild' | 'openedAt'>;
export interface DepEdge { issueId: number; blockedById: number }

/** v2.9 §5.6 the workflow's words in a refusal (`doc` lower case, `Doc` as written) + its §5.7 rules. */
export interface WfText { doc: string; Doc: string; names: Record<OrchKind, string>; start: string; rules: Rules }

export type Caller =
  | { role: 'lane'; projectId: string; laneId: number; laneName: string; held: IssueLite | null; wf: WfText }
  /** `spec` = the spec the session is bound to: a doc step wrote / edits it, Build builds it; Chung has none. */
  | { role: 'orchestrator'; projectId: string; sessionId: string; stepType: OrchKind; spec: SpecLite | null; wf: WfText };
type Orch = Extract<Caller, { role: 'orchestrator' }>;
type LaneCaller = Extract<Caller, { role: 'lane' }>;

const OK: Verdict = { ok: true };
const no = (msg: string): Verdict => ({ ok: false, msg });
const keys = (l: readonly { key: string }[]) => l.map((i) => i.key).join(', ');
const STATE_VI: Record<IssueState, string> = { todo: 'chưa làm', doing: 'đang làm', done: 'đã xong', cancelled: 'đã huỷ' };
const SPEC_STATE_VI: Record<SpecState, string> = { draft: 'bản nháp', approved: 'đã duyệt', active: 'đang build', done: 'đã xong' };

// ---------- derived views (§5.1 blocked, §5.4 priority + ready order) ----------
const PRIORITY_SOURCES: ReadonlySet<IssueSource> = new Set(['po', 'lane', 'orchestrator']);

export interface IssueView<T extends IssueLite = IssueLite> {
  issue: T;
  /** Blockers not `done`; a `cancelled` blocker still blocks until the orchestrator unlinks it (§5.1). */
  blockedBy: string[];
  priority: boolean;
  /** Open (`todo`) issues waiting on this one. */
  waiters: number;
  ready: boolean;
}

/** §5.1 / §5.4 over one project's issues + deps: blocked, priority (first bullet), waiters, ready. */
export function viewIssues<T extends IssueLite>(issues: readonly T[], deps: readonly DepEdge[]): IssueView<T>[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const blockers = new Map<number, T[]>();
  const waiting = new Map<number, T[]>();
  for (const d of deps) {
    const issue = byId.get(d.issueId);
    const blocker = byId.get(d.blockedById);
    if (!issue || !blocker) continue;
    const b = blockers.get(issue.id) ?? [];
    b.push(blocker);
    blockers.set(issue.id, b);
    if (issue.state === 'todo') { const w = waiting.get(blocker.id) ?? []; w.push(issue); waiting.set(blocker.id, w); }
  }
  return issues.map((issue) => {
    const open = (blockers.get(issue.id) ?? []).filter((b) => b.state !== 'done');
    const waiters = waiting.get(issue.id) ?? [];
    const unblocks = waiters.some((w) => (blockers.get(w.id) ?? []).every((b) => b.id === issue.id || b.state === 'done'));
    return {
      issue, blockedBy: open.map((b) => b.key), waiters: waiters.length,
      priority: PRIORITY_SOURCES.has(issue.source) || unblocks,
      ready: issue.state === 'todo' && issue.laneId === null && open.length === 0,
    };
  });
}

/** §5.4 ready order (NC §4): priority first → more waiters → lower number. */
export function readyOrder<T extends IssueLite>(views: readonly IssueView<T>[]): IssueView<T>[] {
  return views.filter((v) => v.ready)
    .sort((a, b) => Number(b.priority) - Number(a.priority) || b.waiters - a.waiters || a.issue.num - b.issue.num);
}

// ---------- spec lifecycle (§5.2, v2.9 §5.3) ----------
const SPEC_MOVES: Record<SpecState, readonly SpecState[]> = { draft: ['approved', 'done'], approved: ['draft', 'active'], active: ['done'], done: [] };

/** The state machine store.ts enforces: draft → approved → active → done, plus approved → draft (re-draft / spec_mark / the
 *  next doc step) and v2.9 §5.3 draft → done (a doc step whose edge goes to Xong, approved). */
export function specMoveOk(from: SpecState, to: SpecState): boolean {
  return SPEC_MOVES[from].includes(to);
}

const lower = (s: string) => s.toLocaleLowerCase('vi');
const bound = (c: Orch, s: SpecLite) => s.designSession === c.sessionId || s.editSession === c.sessionId;
const onlyKind = (c: Caller, kind: OrchKind, tool: string): Verdict | null =>
  c.role === 'orchestrator' && c.stepType === kind ? null : no(`${tool} chỉ dành cho phiên ${c.wf.names[kind]}`);

/** §5.2-1 / §5.2-8: a design session drafts a new spec, or re-drafts the one it wrote / edits (not while it is built). */
export function checkSpecDraft(c: Caller, spec: SpecLite | null): Verdict {
  const k = onlyKind(c, 'design', 'spec_draft');
  if (k || c.role !== 'orchestrator') return k ?? OK;
  if (!spec) return OK;
  const { doc, Doc, names } = c.wf;
  if (!bound(c, spec)) return no(`${doc} ${spec.path} thuộc phiên ${names.design} khác: PO mở "Sửa ${doc}" trên tab Tasks để sửa nó`);
  if (spec.state === 'active') return no(`${doc} ${spec.path} đang build: ghi phần sửa rồi gọi spec_amend {path, summary} khi PO duyệt`);
  if (spec.state === 'done') return no(`${doc} ${spec.path} đã xong: yêu cầu mới là ${doc} mới (+ ${Doc} mới)`);
  return OK;
}

/** §5.2-2 (D86): only from the design session bound to that spec, only from `draft`. */
export function checkSpecApprove(c: Caller, spec: SpecLite): Verdict {
  const k = onlyKind(c, 'design', 'spec_approve');
  if (k || c.role !== 'orchestrator') return k ?? OK;
  const { doc, names } = c.wf;
  if (!bound(c, spec)) return no(`spec_approve ${spec.path}: chỉ phiên ${names.design} đã viết / đang sửa ${doc} này được gọi`);
  if (spec.state !== 'draft') return no(`${doc} ${spec.path} ${SPEC_STATE_VI[spec.state]}, không phải bản nháp: gọi spec_draft sau khi sửa, rồi spec_approve khi PO nói duyệt`);
  return OK;
}

/** §5.2-9: only the design session editing an `active` spec. */
export function checkSpecAmend(c: Caller, spec: SpecLite): Verdict {
  const k = onlyKind(c, 'design', 'spec_amend');
  if (k || c.role !== 'orchestrator') return k ?? OK;
  const { doc, names } = c.wf;
  if (spec.editSession !== c.sessionId) return no(`spec_amend ${spec.path}: chỉ phiên ${names.design} đang bổ sung ${doc} này được gọi`);
  if (spec.state !== 'active') return no(`${doc} ${spec.path} chưa build (${SPEC_STATE_VI[spec.state]}): sửa rồi gọi spec_draft / spec_approve`);
  return OK;
}

/** §5.2-5: the spec's own build session, no open issue, no revert under way. */
export function checkSpecClose(c: Caller, spec: SpecLite, issues: readonly IssueLite[]): Verdict {
  const k = onlyKind(c, 'build', 'spec_close');
  if (k || c.role !== 'orchestrator') return k ?? OK;
  const { doc, names } = c.wf;
  if (spec.buildSession !== c.sessionId) return no(`spec_close ${spec.path}: chỉ phiên ${names.build} của ${doc} này được đóng nó`);
  if (spec.state !== 'active') return no(`${doc} ${spec.path} không ở trạng thái build (${SPEC_STATE_VI[spec.state]})`);
  const open = issues.filter((i) => i.state === 'todo' || i.state === 'doing');
  if (open.length) return no(`${doc} ${spec.path} còn mục mở: ${keys(open)} — làm xong hoặc issue_drop (todo) trước`);
  const rev = issues.filter((i) => i.revert === 'pending' || i.revert === 'running');
  if (rev.length) return no(`${doc} ${spec.path} còn hoàn tác đang chạy: ${keys(rev)} — chờ mục hoàn tác xong`);
  return OK;
}

/** §5.2-3 / §5.2-6 / §5.2-8 / §5.2-10: WS `spec_build` (PO) — v2.9 §5.3 opens the step after the spec's approved one. */
export function checkSpecBuild(w: WfText, spec: SpecLite, after: SpecLite | null, resume: boolean): Verdict {
  const { doc, names } = w;
  if (spec.state !== 'approved') return no(`${doc} ${spec.path} chưa duyệt (${SPEC_STATE_VI[spec.state]}): PO duyệt trong phiên ${names.design} trước`);
  if (spec.editSession) return no(`${doc} ${spec.path} đang sửa: đóng phiên ${names.design} đang sửa trước`);
  if (after && after.state !== 'done') return no(`${doc} ${spec.path} chờ ${doc} ${after.path} xong trước`);
  if (resume && !spec.outsideBuild) return no(`${doc} ${spec.path} chưa build ngoài cc-slaves: dùng ${w.start}`);
  return OK;
}

/** §5.2-7 menu ⋯ `spec_mark`: an imported spec that was never built, between draft and approved. */
export function checkSpecMark(w: WfText, spec: SpecLite, to: SpecState): Verdict {
  const { doc } = w;
  if (spec.origin !== 'imported' || spec.openedAt !== null) return no(`${doc} ${spec.path}: chỉ đổi tay ${doc} nhập vào chưa từng build`);
  if ((to !== 'draft' && to !== 'approved') || !specMoveOk(spec.state, to)) return no(`${doc} ${spec.path}: không đổi ${SPEC_STATE_VI[spec.state]} → ${SPEC_STATE_VI[to]} được`);
  return OK;
}

// ---------- §5.5 hard rules (v2.9 §5.7: the workflow's flags) ----------
/** §5.5-1: assign only a `todo`, unblocked, unheld issue of an `active` spec (or outside any spec). */
export function checkAssignable(w: WfText, issue: IssueLite, spec: SpecLite | null, blockers: readonly { key: string; state: IssueState }[]): Verdict {
  if (issue.state !== 'todo') return no(`${issue.key} ${STATE_VI[issue.state]}: chỉ giao được mục chưa làm — xem issues_list`);
  if (issue.laneId !== null) return no(`${issue.key} đã có lane: giao mục sẵn sàng khác`);
  const open = blockers.filter((b) => b.state !== 'done');
  if (open.length) return no(`${issue.key} chờ ${keys(open)}: giao mục sẵn sàng khác, hoặc gỡ phụ thuộc nếu không còn cần`);
  if (spec && spec.state !== 'active') return no(`${issue.key} thuộc ${w.doc} ${spec.path} chưa vào build (${SPEC_STATE_VI[spec.state]}): PO bấm ${w.start} trước`);
  return OK;
}

/** §5.5-1 end: never a new issue into a `done` spec — a bug in a finished feature is outside any spec. */
export function checkCreateInto(w: WfText, spec: SpecLite | null): Verdict {
  const { doc } = w;
  return spec?.state === 'done' ? no(`${doc} ${spec.path} đã xong: bug ở tính năng của ${doc} đã xong là mục ngoài ${doc} — issue_create {spec: null}`) : OK;
}

/** §5.5-2 (`priority_first`): a non-priority issue of spec X waits while X has a ready priority issue not given out. */
export function checkPriorityFirst(w: WfText, issue: IssueLite, priority: boolean, readyPriority: readonly string[]): Verdict {
  if (!w.rules.priority_first || priority || issue.specId === null) return OK;
  const first = readyPriority.filter((k) => k !== issue.key);
  return first.length ? no(`giao ${first.map((k) => `${k}↑`).join(', ')} trước: mục ưu tiên sẵn sàng đi trước ${issue.key}`) : OK;
}

/** §5.5-3 (`outside_item_new_lane`): outside-spec issues only via a new lane, an outside-spec lane takes no other; §5.5-4
 *  (`one_item_per_lane`): a lane holds one `doing` issue. */
export function checkLaneTakes(w: WfText, issue: IssueLite, via: 'lane_start' | 'issue_assign', lane: { name: string; issues: readonly IssueLite[] } | null): Verdict {
  const { doc, rules } = w;
  if (rules.outside_item_new_lane && via === 'issue_assign' && issue.specId === null) return no(`${issue.key} ngoài ${doc}: chỉ giao bằng lane_start (lane mới riêng)`);
  if (!lane) return OK;
  const doing = rules.one_item_per_lane ? lane.issues.find((i) => i.state === 'doing') : undefined;
  if (doing) return no(`lane ${lane.name} đang giữ ${doing.key}: một lane giữ tối đa một mục — giao cho lane rảnh khác hoặc lane_start`);
  const outside = rules.outside_item_new_lane ? lane.issues.find((i) => i.specId === null) : undefined;
  if (outside) return no(`lane ${lane.name} đã làm mục ngoài ${doc} ${outside.key}: không nhận mục khác — dùng lane_start`);
  return OK;
}

/** §5.5-5 (NC §3): `issue` waits on `blocker`; refused across projects, on itself, or when it closes a cycle. */
type LinkEnd = Pick<IssueRow, 'key' | 'id' | 'specId' | 'sourceLane'>;

/** R-B16 (review B IMPORTANT-2, MINOR-3) both ends of an `issue_link` (add or remove) inside the caller's scope: a lane = the
 * issue it holds or one it created; an orchestrator = `key`'s scope (`checkSessionTool`: Build its spec, Chung outside any
 * spec) — so `blocked_by` must share `key`'s spec. A cross-spec dependency is never linked. */
export function checkLinkScope(c: Caller, issue: LinkEnd, blocker: LinkEnd): Verdict {
  const foreign = c.role === 'lane' ? [issue, blocker].find((x) => x.id !== c.held?.id && x.sourceLane !== c.laneId) : undefined;
  if (foreign) return no(`lane chỉ liên kết mục nó giữ / nó tạo (${foreign.key} không phải) — báo Điều phối`);
  const { doc } = c.wf;
  return issue.specId === blocker.specId ? OK : no(`${issue.key} và ${blocker.key} khác ${doc}: phụ thuộc chỉ trong cùng ${doc}; việc của ${doc} khác → báo PO`);
}

export function checkLink(issue: IssueLite, blocker: IssueLite, deps: readonly DepEdge[], keyOf: ReadonlyMap<number, string>): Verdict {
  if (issue.projectId !== blocker.projectId) return no(`${issue.key} và ${blocker.key} ở hai project khác nhau: chỉ liên kết mục cùng project`);
  if (issue.id === blocker.id) return no(`${issue.key} không chờ chính nó được`);
  const next = new Map<number, number[]>();
  for (const d of deps) { const l = next.get(d.issueId) ?? []; l.push(d.blockedById); next.set(d.issueId, l); }
  const from = new Map<number, number>([[blocker.id, blocker.id]]);
  const queue = [blocker.id];
  while (queue.length) {
    const at = queue.shift()!;
    if (at === issue.id) {
      const path = [issue.id];
      for (let p = issue.id; p !== blocker.id; p = from.get(p)!) path.push(from.get(p)!);
      const chain = [issue.id, ...path.reverse()].map((id) => keyOf.get(id) ?? `#${id}`);
      return no(`${issue.key} chờ ${blocker.key} tạo vòng: ${chain.join(' → ')} — bỏ một liên kết trước`);
    }
    for (const n of next.get(at) ?? []) if (!from.has(n)) { from.set(n, at); queue.push(n); }
  }
  return OK;
}

/** §5.5-6: only the issue the lane holds; `trailerRefusal` = `checkIssueCommits` `{kind: 'refused'}.message` (null = commits ok). */
export function checkIssueDone(c: Caller, issue: IssueLite, trailerRefusal: string | null): Verdict {
  if (c.role !== 'lane') return no('issue_done chỉ dành cho lane đang giữ mục');
  if (c.held?.id !== issue.id) return no(`${issue.key} không phải mục lane ${c.laneName} đang giữ${c.held ? ` (lane giữ ${c.held.key})` : ''}`);
  return trailerRefusal === null ? OK : no(trailerRefusal);
}

/** §5.5-7: a lane creates only in its own project. */
export function checkLaneCreate(c: LaneCaller, projectId: string): Verdict {
  return c.projectId === projectId ? OK : no('lane chỉ tạo mục trong project của nó');
}

/** §5.5-7 (A5, `no_recreate_cancelled`): a title equal to one the PO cancelled → refused with the PO's reason; equal to an
 *  open one → that key. */
export function checkDupTitle(
  w: WfText, norm: string, cancelledByPo: readonly { key: string; norm: string; cancelReason: string | null }[], open: readonly { key: string; norm: string }[],
): Verdict {
  const c = w.rules.no_recreate_cancelled ? cancelledByPo.find((i) => i.norm === norm) : undefined;
  if (c) return no(`trùng ${c.key} PO đã huỷ${c.cancelReason ? ` — lý do: ${c.cancelReason}` : ''}. Không tạo lại; hỏi PO (po_ask) nếu thật sự cần`);
  const o = open.find((i) => i.norm === norm);
  return o ? { ok: true, existing: o.key } : OK;
}

/** §5.2-10 + §5.5-1: `state: done` only from the build session of a `resumed` spec with `source: prior`. */
export function checkIssueCreate(c: Caller, spec: SpecLite | null, state: IssueState, source: IssueSource): Verdict {
  const into = checkCreateInto(c.wf, spec);
  if (!into.ok) return into;
  if (state === 'todo') return source === 'prior' ? no('source prior chỉ dùng với state done (phần làm trước khi nhập)') : OK;
  if (state !== 'done') return no(`issue_create không nhận state ${state}: tạo mục todo`);
  const resumedOwn = c.role === 'orchestrator' && c.stepType === 'build' && spec !== null && spec.buildSession === c.sessionId && spec.resumed;
  if (!resumedOwn) return no(`issue_create {state: done} chỉ dành cho phiên ${c.wf.names.build} của ${c.wf.doc} vào bằng Tiếp tục build`);
  return source === 'prior' ? OK : no('issue_create {state: done} cần source: prior');
}

/** §5.5-8 / §5.2-9: Build drops a `todo`, non-prior issue of its own spec, with a reason. */
export function checkIssueDrop(c: Caller, issue: IssueLite, reason: string): Verdict {
  const k = onlyKind(c, 'build', 'issue_drop');
  if (k || c.role !== 'orchestrator') return k ?? OK;
  if (issue.specId === null || issue.specId !== c.spec?.id) return no(`${issue.key} không thuộc ${c.wf.doc} của phiên này`);
  if (issue.state !== 'todo') return no(`${issue.key} ${STATE_VI[issue.state]}: chỉ bỏ được mục chưa làm; huỷ mục đang làm / đã xong là việc của PO`);
  if (issue.source === 'prior') return no(`${issue.key} là phần làm trước khi nhập: không bỏ được`);
  if (!reason.trim()) return no('issue_drop cần reason');
  return OK;
}

/** §5.7-5: only the lane holding the revert issue. */
export function checkRevertConflict(c: Caller, issue: IssueLite): Verdict {
  if (c.role !== 'lane' || c.held?.id !== issue.id) return no(`issue_revert_conflict: chỉ lane đang giữ ${issue.key} được gọi`);
  return issue.reverts === null ? no(`${issue.key} không phải mục hoàn tác`) : OK;
}

// ---------- §5.5-8 tools by session kind ----------
const FAMILY = /^(issue_|issues_|lane_|lanes_|spec_)/;
const DESIGN_TOOLS: ReadonlySet<string> = new Set(['spec_draft', 'spec_approve', 'spec_output_add', 'issues_list', 'issue_get', 'issue_create']);
const OWN_SPEC_TOOLS: ReadonlySet<string> = new Set(['spec_set_branch', 'spec_close', 'spec_output_add']);

export interface ToolTarget {
  /** The issue the call acts on (key argument / lane_start {issue}). */
  issue?: IssueLite | null;
  /** The spec the call names (spec_* tools). */
  spec?: SpecLite | null;
  /** issue_create: the spec the new issue goes into (null = outside any spec). */
  createSpecId?: number | null;
}

/** §5.5-8 which lane / issue / spec tools each orchestrator step type may call, and on what. Other tools pass. */
export function checkSessionTool(c: Orch, tool: string, t: ToolTarget = {}): Verdict {
  if (!FAMILY.test(tool)) return OK;
  const own = c.spec?.id ?? null;
  const ownSpec = t.spec != null && t.spec.id === own;
  const { doc, Doc, names, start } = c.wf;
  if (tool === 'issue_create' && t.createSpecId != null && (c.stepType !== 'build' || t.createSpecId !== own)) {
    return no(c.stepType === 'build' ? `phiên ${names.build} chỉ tạo mục cho ${doc} của nó, hoặc ngoài ${doc} ({spec: null})` : `phiên ${names[c.stepType]} chỉ tạo mục ngoài ${doc}: issue_create {spec: null}`);
  }
  if (c.stepType === 'design') {
    if (tool === 'spec_amend' && ownSpec && c.spec?.state === 'active') return OK;
    if (!DESIGN_TOOLS.has(tool)) return no(`phiên ${names.design} không gọi ${tool}: ${lower(names.design)} xong để PO bấm ${start}; việc ngoài ${doc} là của phiên ${names.general}`);
    return tool === 'spec_output_add' && !ownSpec ? no(`spec_output_add chỉ cho ${doc} phiên này gắn`) : OK;
  }
  if (tool.startsWith('spec_')) {
    if (c.stepType === 'build' && OWN_SPEC_TOOLS.has(tool) && ownSpec) return OK;
    return no(c.stepType === 'build' ? `phiên ${names.build} chỉ gọi spec_set_branch / spec_close / spec_output_add cho ${doc} của nó` : `phiên ${names.general} không gọi ${tool}: ${doc} mới dùng "+ ${Doc} mới" trên tab Tasks`);
  }
  if (!t.issue) return OK;
  if (c.stepType === 'build' && t.issue.specId !== own) return no(`${t.issue.key} không thuộc ${doc} của phiên ${names.build} này: ${t.issue.specId === null ? `mục ngoài ${doc} là việc của phiên ${names.general}` : `việc của phiên ${names.build} ${doc} đó`}`);
  if (c.stepType === 'general' && t.issue.specId !== null) return no(`${t.issue.key} thuộc một ${doc}: việc của phiên ${names.build} ${doc} đó; phiên ${names.general} chỉ làm mục ngoài ${doc}`);
  return OK;
}
