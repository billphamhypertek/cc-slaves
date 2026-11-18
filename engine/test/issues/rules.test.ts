import { describe, expect, test } from 'bun:test';
import {
  checkAssignable, checkCreateInto, checkDupTitle, checkIssueCreate, checkIssueDone, checkIssueDrop, checkLaneCreate,
  checkLaneTakes, checkLink, checkPriorityFirst, checkRevertConflict, checkSessionTool, checkSpecAmend, checkSpecApprove,
  checkSpecBuild, checkSpecClose, checkSpecDraft, checkSpecMark, specMoveOk, type Caller, type IssueLite, type SpecLite,
} from '../../src/issues/rules.ts';
import { wfText } from '../../src/workflow/runtime.ts';
import { PO } from '../_fixtures/po-pack.ts';

/** Quy trình PO's texts + rules (v2.9 §5.6 / §5.7). */
const W = wfText(PO);

const iss = (o: Partial<IssueLite> & { num: number }): IssueLite => ({
  id: o.num, key: `T-${o.num}`, projectId: 'p1', specId: 1, state: 'todo', source: 'spec', laneId: null, reverts: null,
  revert: 'none', baseSha: null, ...o,
});
const sp = (o: Partial<SpecLite> = {}): SpecLite => ({
  id: 1, path: 'docs/specs/a.md', state: 'active', origin: 'app', designSession: null, buildSession: null, editSession: null,
  resumed: false, outsideBuild: false, openedAt: null, ...o,
});
const orch = (kind: 'design' | 'build' | 'general', spec: SpecLite | null = null, sessionId = 's1'): Caller & { role: 'orchestrator' } =>
  ({ role: 'orchestrator', projectId: 'p1', sessionId, stepType: kind, spec, wf: W });
const lane = (held: IssueLite | null = null): Caller => ({ role: 'lane', projectId: 'p1', laneId: 7, laneName: 'D2', held, wf: W });
const msg = (v: { ok: boolean; msg?: string }) => (v.ok ? 'OK' : v.msg);

describe('§5.5 hard rules', () => {
  test('§5.5-1 assign refused when not todo / held / blocked / spec not active; accepted otherwise', () => {
    expect(msg(checkAssignable(W, iss({ num: 49, state: 'done' }), sp(), []))).toMatch(/^T-49 đã xong/);
    expect(msg(checkAssignable(W, iss({ num: 49, laneId: 3 }), sp(), []))).toMatch(/T-49 đã có lane/);
    expect(msg(checkAssignable(W, iss({ num: 49 }), sp(), [{ key: 'T-46', state: 'todo' }, { key: 'T-47', state: 'done' }, { key: 'T-48', state: 'cancelled' }])))
      .toMatch(/^T-49 chờ T-46, T-48/);
    expect(msg(checkAssignable(W, iss({ num: 49 }), sp({ state: 'approved' }), []))).toMatch(/chưa vào build.*Bắt đầu build/);
    expect(checkAssignable(W, iss({ num: 49 }), sp(), [{ key: 'T-46', state: 'done' }]).ok).toBe(true);
    expect(checkAssignable(W, iss({ num: 49, specId: null }), null, []).ok).toBe(true);
  });

  test('§5.5-1 no new issue into a done spec → points to {spec: null}', () => {
    expect(msg(checkCreateInto(W, sp({ state: 'done' })))).toMatch(/ngoài spec — issue_create \{spec: null\}/);
    expect(checkCreateInto(W, sp()).ok).toBe(true);
    expect(checkCreateInto(W, null).ok).toBe(true);
  });

  test('§5.5-2 non-priority issue refused while a ready priority issue waits; priority / outside spec pass', () => {
    expect(msg(checkPriorityFirst(W, iss({ num: 50 }), false, ['B-12', 'T-50']))).toMatch(/^giao B-12↑ trước/);
    expect(checkPriorityFirst(W, iss({ num: 50 }), false, ['T-50']).ok).toBe(true);
    expect(checkPriorityFirst(W, iss({ num: 50 }), true, ['B-12']).ok).toBe(true);
    expect(checkPriorityFirst(W, iss({ num: 50, specId: null }), false, ['B-12']).ok).toBe(true);
  });

  test('§5.5-3 outside-spec issue only via lane_start; a lane that held an outside-spec issue takes no other', () => {
    const out = iss({ num: 13, specId: null });
    expect(msg(checkLaneTakes(W, out, 'issue_assign', { name: 'D2', issues: [] }))).toMatch(/chỉ giao bằng lane_start/);
    expect(checkLaneTakes(W, out, 'lane_start', null).ok).toBe(true);
    expect(msg(checkLaneTakes(W, iss({ num: 50 }), 'issue_assign', { name: 'D2', issues: [iss({ num: 13, specId: null, state: 'done' })] })))
      .toMatch(/đã làm mục ngoài spec T-13/);
  });

  test('§5.5-4 a lane holds at most one doing issue', () => {
    expect(msg(checkLaneTakes(W, iss({ num: 50 }), 'issue_assign', { name: 'D2', issues: [iss({ num: 47, state: 'doing', laneId: 7 })] })))
      .toMatch(/lane D2 đang giữ T-47/);
    expect(checkLaneTakes(W, iss({ num: 50 }), 'issue_assign', { name: 'D2', issues: [iss({ num: 47, state: 'done', laneId: 7 })] }).ok).toBe(true);
  });

  test('§5.5-5 issue_link cycle → refused with the chain; cross-project and self refused; a DAG link accepted', () => {
    const a = iss({ num: 1 }), b = iss({ num: 2 }), c = iss({ num: 3 });
    const keyOf = new Map([[1, 'T-1'], [2, 'T-2'], [3, 'T-3']]);
    const deps = [{ issueId: 2, blockedById: 3 }, { issueId: 3, blockedById: 1 }]; // T-2 waits T-3 waits T-1
    expect(msg(checkLink(a, b, deps, keyOf))).toBe('T-1 chờ T-2 tạo vòng: T-1 → T-2 → T-3 → T-1 — bỏ một liên kết trước');
    expect(checkLink(b, a, deps, keyOf).ok).toBe(true);
    expect(msg(checkLink(a, a, [], keyOf))).toMatch(/chính nó/);
    expect(msg(checkLink(a, iss({ num: 9, projectId: 'p2' }), [], keyOf))).toMatch(/hai project khác nhau/);
    expect(checkLink(c, a, [{ issueId: 2, blockedById: 1 }], keyOf).ok).toBe(true);
  });

  test('§5.5-6 issue_done only the held issue; the trailer refusal is the one checkIssueCommits wrote; null = commits ok', () => {
    const held = iss({ num: 47, state: 'doing', laneId: 7, baseSha: 'b0' });
    expect(msg(checkIssueDone(lane(iss({ num: 48 })), held, null))).toMatch(/T-47 không phải mục lane D2 đang giữ \(lane giữ T-48\)/);
    expect(msg(checkIssueDone(orch('build'), held, 'x'))).toMatch(/chỉ dành cho lane/);
    const refusal = 'Từ chối issue_done T-47: 2 commit thiếu trailer — `git rebase b0 --exec …`';
    expect(msg(checkIssueDone(lane(held), held, refusal))).toBe(refusal);
    expect(checkIssueDone(lane(held), held, null).ok).toBe(true);
  });

  test('§5.5-7 lane creates only in its project; dup of a PO-cancelled title refused with the reason; dup of open → its key', () => {
    expect(msg(checkLaneCreate(lane() as Caller & { role: 'lane' }, 'p2'))).toMatch(/project của nó/);
    expect(checkLaneCreate(lane() as Caller & { role: 'lane' }, 'p1').ok).toBe(true);
    const cancelled = [{ key: 'T-40', norm: 'sửa nút huỷ', cancelReason: 'không cần nữa' }];
    expect(msg(checkDupTitle(W, 'sửa nút huỷ', cancelled, []))).toBe('trùng T-40 PO đã huỷ — lý do: không cần nữa. Không tạo lại; hỏi PO (po_ask) nếu thật sự cần');
    expect(checkDupTitle(W, 'đổi màu', cancelled, [{ key: 'T-41', norm: 'đổi màu' }])).toEqual({ ok: true, existing: 'T-41' });
    expect(checkDupTitle(W, 'mới', cancelled, [{ key: 'T-41', norm: 'đổi màu' }])).toEqual({ ok: true });
  });
});

describe('§5.5-8 tools by session kind', () => {
  const own = sp({ id: 1, buildSession: 's1' });
  test('§5.5-8 Thiết kế: only spec_draft / spec_approve / issues_list / issue_get / issue_create {spec: null}', () => {
    const d = orch('design', sp({ state: 'draft', designSession: 's1' }));
    for (const t of ['spec_draft', 'spec_approve', 'issues_list', 'issue_get', 'po_ask', 'notify']) expect(checkSessionTool(d, t).ok).toBe(true);
    expect(checkSessionTool(d, 'issue_create', { createSpecId: null }).ok).toBe(true);
    expect(msg(checkSessionTool(d, 'issue_create', { createSpecId: 1 }))).toMatch(/chỉ tạo mục ngoài spec/);
    for (const t of ['lane_start', 'issue_assign', 'lanes_list', 'spec_close', 'issue_link', 'spec_amend']) {
      expect(msg(checkSessionTool(d, t, { spec: d.spec }))).toMatch(/phiên Thiết kế không gọi/);
    }
  });

  test('§5.5-8 Thiết kế bound to an active spec may spec_amend that spec only', () => {
    const active = sp({ state: 'active', editSession: 's1' });
    const d = orch('design', active);
    expect(checkSessionTool(d, 'spec_amend', { spec: active }).ok).toBe(true);
    expect(msg(checkSessionTool(d, 'spec_amend', { spec: sp({ id: 2 }) }))).toMatch(/không gọi spec_amend/);
  });

  test('§5.5-8 Build: issue / lane tools only on its spec; spec_set_branch / spec_close only its spec; {spec: null} ok', () => {
    const b = orch('build', own);
    expect(checkSessionTool(b, 'lane_start', { issue: iss({ num: 47 }) }).ok).toBe(true);
    expect(checkSessionTool(b, 'lane_start', {}).ok).toBe(true); // review / gate lane without an issue
    expect(msg(checkSessionTool(b, 'issue_assign', { issue: iss({ num: 13, specId: null }) }))).toMatch(/mục ngoài spec là việc của phiên Chung/);
    expect(msg(checkSessionTool(b, 'issue_update', { issue: iss({ num: 60, specId: 2 }) }))).toMatch(/không thuộc spec của phiên Build/);
    expect(checkSessionTool(b, 'spec_close', { spec: own }).ok).toBe(true);
    expect(msg(checkSessionTool(b, 'spec_set_branch', { spec: sp({ id: 2 }) }))).toMatch(/cho spec của nó/);
    expect(msg(checkSessionTool(b, 'spec_approve', { spec: own }))).toMatch(/cho spec của nó/);
    expect(checkSessionTool(b, 'issue_create', { createSpecId: null }).ok).toBe(true);
    expect(checkSessionTool(b, 'issue_create', { createSpecId: 1 }).ok).toBe(true);
    expect(msg(checkSessionTool(b, 'issue_create', { createSpecId: 2 }))).toMatch(/chỉ tạo mục cho spec của nó/);
  });

  test('§5.5-8 Chung: issue / lane tools only outside any spec; no spec_* tool', () => {
    const g = orch('general');
    expect(checkSessionTool(g, 'lane_start', { issue: iss({ num: 13, specId: null }) }).ok).toBe(true);
    expect(checkSessionTool(g, 'lane_start', {}).ok).toBe(true);
    expect(msg(checkSessionTool(g, 'issue_assign', { issue: iss({ num: 47 }) }))).toMatch(/phiên Chung chỉ làm mục ngoài spec/);
    expect(msg(checkSessionTool(g, 'spec_draft', {}))).toMatch(/\+ Spec mới/);
    expect(checkSessionTool(g, 'issue_create', { createSpecId: null }).ok).toBe(true);
    expect(msg(checkSessionTool(g, 'issue_create', { createSpecId: 1 }))).toMatch(/phiên Chung chỉ tạo mục ngoài spec/);
    expect(checkSessionTool(g, 'accounts_usage').ok).toBe(true);
  });
});

describe('§5.2 spec lifecycle guards', () => {
  test('§5.2 state machine: draft → approved → active → done, approved → draft, v2.9 §5.3 draft → done (approved into Xong); nothing else', () => {
    expect([specMoveOk('draft', 'approved'), specMoveOk('approved', 'active'), specMoveOk('active', 'done'), specMoveOk('approved', 'draft'), specMoveOk('draft', 'done')])
      .toEqual([true, true, true, true, true]);
    expect([specMoveOk('draft', 'active'), specMoveOk('active', 'draft'), specMoveOk('done', 'active'), specMoveOk('approved', 'done')])
      .toEqual([false, false, false, false]);
  });

  test('§5.2-1 / -8 spec_draft: design only; own spec; not while active / done', () => {
    expect(checkSpecDraft(orch('design'), null).ok).toBe(true);
    expect(checkSpecDraft(orch('design'), sp({ state: 'draft', designSession: 's1' })).ok).toBe(true);
    expect(checkSpecDraft(orch('design'), sp({ state: 'approved', editSession: 's1' })).ok).toBe(true);
    expect(msg(checkSpecDraft(orch('build'), null))).toMatch(/chỉ dành cho phiên Thiết kế/);
    expect(msg(checkSpecDraft(orch('design'), sp({ state: 'draft', designSession: 's9' })))).toMatch(/phiên Thiết kế khác/);
    expect(msg(checkSpecDraft(orch('design'), sp({ state: 'active', editSession: 's1' })))).toMatch(/spec_amend/);
  });

  test('§5.2-2 spec_approve only from the design session bound to that spec, only from draft', () => {
    expect(checkSpecApprove(orch('design'), sp({ state: 'draft', designSession: 's1' })).ok).toBe(true);
    expect(checkSpecApprove(orch('design'), sp({ state: 'draft', editSession: 's1' })).ok).toBe(true);
    expect(msg(checkSpecApprove(orch('design'), sp({ state: 'draft', designSession: 's2' })))).toMatch(/chỉ phiên Thiết kế đã viết/);
    expect(msg(checkSpecApprove(orch('general'), sp({ state: 'draft', designSession: 's1' })))).toMatch(/chỉ dành cho phiên Thiết kế/);
    expect(msg(checkSpecApprove(orch('design'), sp({ state: 'approved', designSession: 's1' })))).toMatch(/đã duyệt, không phải bản nháp/);
  });

  test('§5.5 header: refusals name the spec state in Vietnamese, never the raw enum', () => {
    const d = orch('design');
    const all = [
      msg(checkSpecApprove(d, sp({ state: 'approved', designSession: 's1' }))),
      msg(checkSpecAmend(d, sp({ state: 'approved', editSession: 's1' }))),
      msg(checkSpecClose(orch('build'), sp({ state: 'done', buildSession: 's1' }), [])),
      msg(checkSpecBuild(W, sp({ state: 'draft' }), null, false)),
      msg(checkSpecMark(W, sp({ origin: 'imported', state: 'draft' }), 'done')),
      msg(checkAssignable(W, iss({ num: 1 }), sp({ state: 'approved' }), [])),
    ];
    expect(all.join(' | ')).toMatch(/\(đã duyệt\).*\(đã xong\).*\(bản nháp\).*bản nháp → đã xong.*\(đã duyệt\)/);
    for (const m of all) expect(m).not.toMatch(/\b(?<!spec_)(draft|approved|active|done)\b/);
  });

  test('§5.2-9 spec_amend: wrong session / not active refused', () => {
    expect(checkSpecAmend(orch('design'), sp({ editSession: 's1' })).ok).toBe(true);
    expect(msg(checkSpecAmend(orch('design'), sp({ editSession: 's2' })))).toMatch(/đang bổ sung spec này/);
    expect(msg(checkSpecAmend(orch('build'), sp({ editSession: 's1' })))).toMatch(/phiên Thiết kế/);
    expect(msg(checkSpecAmend(orch('design'), sp({ state: 'approved', editSession: 's1' })))).toMatch(/chưa build/);
  });

  test('§5.2-5 spec_close refused while open issues / a revert runs; own build session only', () => {
    const s = sp({ buildSession: 's1' });
    expect(msg(checkSpecClose(orch('build', s), s, [iss({ num: 1, state: 'done' }), iss({ num: 2, state: 'doing', laneId: 1 })]))).toMatch(/còn mục mở: T-2/);
    expect(msg(checkSpecClose(orch('build', s), s, [iss({ num: 1, state: 'done', revert: 'running' })]))).toMatch(/hoàn tác đang chạy: T-1/);
    expect(msg(checkSpecClose(orch('build', s, 's2'), s, []))).toMatch(/chỉ phiên Build của spec này/);
    expect(checkSpecClose(orch('build', s), s, [iss({ num: 1, state: 'done', revert: 'conflict' }), iss({ num: 2, state: 'cancelled' })]).ok).toBe(true);
  });

  test('§5.2-3 / -6 / -8 / -10 spec_build: approved, not being edited, after done, resume only outside_build', () => {
    const a = sp({ state: 'approved' });
    expect(checkSpecBuild(W, a, null, false).ok).toBe(true);
    expect(msg(checkSpecBuild(W, sp({ state: 'draft' }), null, false))).toMatch(/chưa duyệt/);
    expect(msg(checkSpecBuild(W, sp({ state: 'approved', editSession: 's1' }), null, false))).toMatch(/đang sửa/);
    expect(msg(checkSpecBuild(W, a, sp({ id: 2, path: 'docs/specs/v24.md', state: 'active' }), false))).toMatch(/chờ spec docs\/specs\/v24.md xong/);
    expect(checkSpecBuild(W, a, sp({ id: 2, state: 'done' }), false).ok).toBe(true);
    expect(msg(checkSpecBuild(W, a, null, true))).toMatch(/Bắt đầu build/);
    expect(checkSpecBuild(W, sp({ state: 'approved', outsideBuild: true }), null, true).ok).toBe(true);
  });

  test('§5.2-7 spec_mark: imported, never built, draft ↔ approved only', () => {
    expect(checkSpecMark(W, sp({ origin: 'imported', state: 'draft' }), 'approved').ok).toBe(true);
    expect(checkSpecMark(W, sp({ origin: 'imported', state: 'approved' }), 'draft').ok).toBe(true);
    expect(msg(checkSpecMark(W, sp({ origin: 'app', state: 'draft' }), 'approved'))).toMatch(/spec nhập vào chưa từng build/);
    expect(msg(checkSpecMark(W, sp({ origin: 'imported', state: 'approved', openedAt: 5 }), 'draft'))).toMatch(/chưa từng build/);
    expect(msg(checkSpecMark(W, sp({ origin: 'imported', state: 'approved' }), 'active'))).toMatch(/đã duyệt → đang build/);
  });

  test('§5.2-10 issue_create {state: done} only from the build session of a resumed spec with source prior', () => {
    const r = sp({ buildSession: 's1', resumed: true });
    expect(checkIssueCreate(orch('build', r), r, 'done', 'prior').ok).toBe(true);
    expect(msg(checkIssueCreate(orch('build', r), r, 'done', 'spec'))).toMatch(/cần source: prior/);
    const nr = sp({ buildSession: 's1' });
    expect(msg(checkIssueCreate(orch('build', nr), nr, 'done', 'prior'))).toMatch(/Tiếp tục build/);
    expect(msg(checkIssueCreate(orch('general'), null, 'done', 'prior'))).toMatch(/Tiếp tục build/);
    expect(msg(checkIssueCreate(orch('build', r), r, 'todo', 'prior'))).toMatch(/source prior chỉ dùng với state done/);
    expect(msg(checkIssueCreate(orch('build', r), r, 'doing', 'spec'))).toMatch(/không nhận state doing/);
    expect(msg(checkIssueCreate(orch('build', r), sp({ state: 'done' }), 'todo', 'spec'))).toMatch(/đã xong/);
    expect(checkIssueCreate(lane(), r, 'todo', 'lane').ok).toBe(true);
  });

  test('§5.2-9 issue_drop: build, own spec, todo, not prior, with a reason', () => {
    const b = orch('build', sp({ id: 1, buildSession: 's1' }));
    expect(checkIssueDrop(b, iss({ num: 5 }), 'không còn cần').ok).toBe(true);
    expect(msg(checkIssueDrop(b, iss({ num: 5, state: 'doing', laneId: 1 }), 'x'))).toMatch(/chỉ bỏ được mục chưa làm/);
    expect(msg(checkIssueDrop(b, iss({ num: 5, source: 'prior' }), 'x'))).toMatch(/làm trước khi nhập/);
    expect(msg(checkIssueDrop(b, iss({ num: 5, specId: 2 }), 'x'))).toMatch(/không thuộc spec/);
    expect(msg(checkIssueDrop(b, iss({ num: 5 }), '  '))).toMatch(/cần reason/);
    expect(msg(checkIssueDrop(orch('general'), iss({ num: 5 }), 'x'))).toMatch(/phiên Build/);
  });

  test('§5.7-5 issue_revert_conflict only from the lane holding the revert issue', () => {
    const r = iss({ num: 60, reverts: 46, state: 'doing', laneId: 7 });
    expect(checkRevertConflict(lane(r), r).ok).toBe(true);
    expect(msg(checkRevertConflict(lane(null), r))).toMatch(/chỉ lane đang giữ T-60/);
    const plain = iss({ num: 61, state: 'doing', laneId: 7 });
    expect(msg(checkRevertConflict(lane(plain), plain))).toMatch(/không phải mục hoàn tác/);
  });
});

describe('v2.9 §5.7 rule flags off: the rule does not apply', () => {
  const off = (k: keyof typeof W.rules) => ({ ...W, rules: { ...W.rules, [k]: false } });
  test('v2.9 priority_first off → a non-priority item goes while a priority one waits', () => {
    expect(checkPriorityFirst(W, iss({ num: 50 }), false, ['B-12']).ok).toBe(false);
    expect(checkPriorityFirst(off('priority_first'), iss({ num: 50 }), false, ['B-12']).ok).toBe(true);
  });
  test('v2.9 one_item_per_lane off → a lane holding a doing item takes another', () => {
    const l = { name: 'D2', issues: [iss({ num: 3, state: 'doing' })] };
    expect(checkLaneTakes(W, iss({ num: 4 }), 'lane_start', l).ok).toBe(false);
    expect(checkLaneTakes(off('one_item_per_lane'), iss({ num: 4 }), 'lane_start', l).ok).toBe(true);
  });
  test('v2.9 outside_item_new_lane off → an outside item is assignable; an outside-item lane takes others', () => {
    const o = off('outside_item_new_lane');
    expect(checkLaneTakes(W, iss({ num: 4, specId: null }), 'issue_assign', null).ok).toBe(false);
    expect(checkLaneTakes(o, iss({ num: 4, specId: null }), 'issue_assign', null).ok).toBe(true);
    const l = { name: 'D2', issues: [iss({ num: 3, state: 'done', specId: null })] };
    expect(checkLaneTakes(W, iss({ num: 4 }), 'lane_start', l).ok).toBe(false);
    expect(checkLaneTakes(o, iss({ num: 4 }), 'lane_start', l).ok).toBe(true);
  });
  test('v2.9 no_recreate_cancelled off → a title equal to a cancelled one is created', () => {
    const c = [{ key: 'T-4', norm: 'x', cancelReason: 'không cần' }];
    expect(checkDupTitle(W, 'x', c, []).ok).toBe(false);
    expect(checkDupTitle(off('no_recreate_cancelled'), 'x', c, [])).toEqual({ ok: true });
  });
});

describe('v2.9 §5.6 refusals speak the workflow\'s words', () => {
  const X = { ...W, doc: 'plan', Doc: 'Plan', start: 'Bắt đầu code', names: { design: 'Lập plan', build: 'Code', general: 'Chung' } };
  test('v2.9 doc label, step names and the start label come from the workflow', () => {
    expect(msg(checkSpecBuild(X, sp({ state: 'draft' }), null, false))).toBe('plan docs/specs/a.md chưa duyệt (bản nháp): PO duyệt trong phiên Lập plan trước');
    expect(msg(checkAssignable(X, iss({ num: 9 }), sp({ state: 'approved' }), []))).toMatch(/thuộc plan .*PO bấm Bắt đầu code trước$/);
    expect(msg(checkCreateInto(X, sp({ state: 'done' })))).toMatch(/^plan .* mục ngoài plan/);
  });
});
