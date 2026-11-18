// spec v2.9 §4.2–§4.7 / §5.3 the Quy trình screen's pure part (web/src/lib/workflow.ts): the model read back from
// `workflow_edit`, node / edge texts, layout, and the canvas changes as edits with the shape rules checked first (WF3d).
import { describe, expect, test } from 'bun:test';
import { makeT } from '../../shared/i18n/index.ts';
import type { WorkflowDocView, WorkflowRow } from '../../shared/workflows.ts';
import {
  connect, connectReason, DONE_H, dropReason, edgeLabel, enforceLine, freeId, impactLine, insertStep, installedSkills, issueText, keyInsertReason, layoutOf, NODE_H, parseLayout,
  removeStep, renameNew, rowSub, sameFiles, sizeLine, stepById, tasksFlow, wfModel,
} from '../src/lib/workflow.ts';

const tr = makeT('vi');
const doc = (fm: Record<string, unknown>, body = ''): WorkflowDocView => ({ fm, body, readOnly: [] });
const deny = (n: number) => Array.from({ length: n }, (_, i) => ({ skill: `superpowers:s${i}`, reason: 'vì' }));
function po(over: Record<string, WorkflowDocView> = {}) {
  return wfModel({
    'WORKFLOW.md': doc({ name: 'PO của tôi', description: 'd', doc_label: 'Spec', rules: { priority_first: false, max_doc_sessions: 2 } }, 'Chung.'),
    'steps/design.md': doc({ type: 'design', name: 'Thiết kế', docs: 'docs/specs', labels: { group: 'Đang thiết kế', waiting: 'Chờ build', start: 'Bắt đầu build' }, skills_deny: deny(5), next: { to: 'build', start: 'button' } }, Array.from({ length: 40 }, () => 'x'.repeat(59)).join('\n')),
    'steps/build.md': doc({ type: 'build', name: 'Build', skills_deny: deny(4), next: { to: 'done' } }),
    'steps/general.md': doc({ type: 'general', name: 'Chung', skills_deny: deny(5) }),
    'steps/lane.md': doc({ type: 'lane', phases: ['queue', 'spec', 'code', 'review', 'gate', 'merge', 'done'], skills_deny: ['superpowers:brainstorming'] }),
    ...over,
  });
}
const row = (over: Partial<WorkflowRow> = {}): WorkflowRow => ({
  id: 'po-cua-toi', builtin: false, name: 'PO của tôi', description: '', rev: 'r', diskRev: 'r', validAt: 1, errors: [], warnings: [],
  basedOn: null, baseOutdated: false, usedBy: [], dir: '/h/workflows/po-cua-toi', ...over,
});

describe('§4.2 the model and its texts', () => {
  test('chain from the head, Chung + Lane apart, rules with defaults, deny entries of both forms', () => {
    const m = po();
    expect(m.chain).toEqual(['design', 'build']);
    expect([m.general?.id, m.lane?.id]).toEqual(['general', 'lane']);
    expect(m.rules).toEqual({ flags: { priority_first: false, one_item_per_lane: true, outside_item_new_lane: true, no_recreate_cancelled: true }, max: 2 });
    expect(m.lane!.deny).toEqual([{ skill: 'superpowers:brainstorming', reason: null }]);
  });

  test('node lines say what the step enforces and its size; Lane counts phases', () => {
    const m = po();
    expect(enforceLine(tr, stepById(m, 'design')!)).toBe('chặn 5 skill · không mở lane');
    expect(enforceLine(tr, stepById(m, 'build')!)).toBe('chặn 4 skill · mở lane');
    expect(enforceLine(tr, stepById(m, 'general')!)).toBe('chặn 5 skill · mở lane riêng');
    expect(enforceLine(tr, m.lane!)).toBe('7 pha · chặn 1 skill');
    // v29-ux M9 no deny = "không chặn skill", never "chặn 0 skill"
    expect(enforceLine(tr, po({ 'steps/build.md': doc({ type: 'build', name: 'Build', next: { to: 'done' } }) }).steps.find(s => s.type === 'build')!)).toBe('không chặn skill · mở lane');
    expect(sizeLine(tr, stepById(m, 'design')!)).toBe('40 dòng · ≈ 600 token');
    expect(sizeLine(tr, stepById(m, 'build')!)).toBe('lời dặn trống');
  });

  test('§4.9 edge labels: button / auto / approved into Xong / drained after Build; mini map short forms', () => {
    const m = po();
    expect(edgeLabel(tr, stepById(m, 'design')!)).toBe('duyệt rồi bấm Bắt đầu');
    expect(edgeLabel(tr, stepById(m, 'design')!, true)).toBe('bấm Bắt đầu');
    expect(edgeLabel(tr, stepById(m, 'build')!)).toBe('hết mục');
    const auto = po({ 'steps/design.md': doc({ type: 'design', next: { to: 'build', start: 'auto' } }) });
    expect(edgeLabel(tr, stepById(auto, 'design')!)).toBe('duyệt xong tự chạy');
    const noBuild = po({ 'steps/design.md': doc({ type: 'design', next: { to: 'done' } }) });
    expect(edgeLabel(tr, stepById(noBuild, 'design')!)).toBe('duyệt xong');
  });

  test('layout: chain left → right, Xong after it, Lane under Build; saved places win; a bad layout file is ignored', () => {
    const m = po();
    const at = layoutOf(m, parseLayout('{"general":{"x":5,"y":6},"zz":{"x":1,"y":1}}'));
    expect(at.design!.y).toBe(at.build!.y);
    expect(at.done!.x).toBeGreaterThan(at.build!.x);
    expect(at.lane!.x).toBe(at.build!.x);
    expect(at.general).toEqual({ x: 5, y: 6 });
    expect(at.zz).toBeUndefined();
    expect(parseLayout('{nope')).toEqual({});
  });

  test('layout: Xong sits level with the row it ends; no doc steps (Giao thẳng) → Xong follows Lane, never alone', () => {
    const m = po();
    const at = layoutOf(m, {});
    expect(at.done!.y + DONE_H / 2).toBe(at.build!.y + NODE_H / 2);
    const direct = wfModel({
      'WORKFLOW.md': doc({ name: 'Giao thẳng', description: 'd', doc_label: '' }),
      'steps/general.md': doc({ type: 'general', name: 'Chung' }),
      'steps/lane.md': doc({ type: 'lane', phases: ['queue', 'code', 'review', 'done'] }),
    });
    const d = layoutOf(direct, {});
    expect(d.done!.x).toBeGreaterThan(d.lane!.x);
    expect(d.done!.y + DONE_H / 2).toBe(d.lane!.y + NODE_H / 2);
  });

  test('layout WF3b: a chain step with no saved place re-flows the chain, Xong and Lane; Chung keeps its saved place', () => {
    const m = po();
    const all = layoutOf(m, {});
    const saved = { design: { x: 900, y: 900 }, build: { x: 901, y: 901 }, done: { x: 902, y: 902 }, lane: { x: 903, y: 903 }, general: { x: 5, y: 6 } };
    expect(layoutOf(m, saved).design).toEqual({ x: 900, y: 900 }); // every chain step placed: saved wins
    const { build: _b, ...noBuild } = saved;
    const at = layoutOf(m, noBuild);
    expect(at.design).toEqual(all.design);
    expect(at.done).toEqual(all.done);
    expect(at.lane).toEqual(all.lane);
    expect(at.general).toEqual({ x: 5, y: 6 });
  });
});

describe('§5.3 canvas changes are checked before they happen (WF3d) and come out as edits', () => {
  test('drop rules: one Build, ≤ 4 docs, Chung / Lane never, a doc only on an edge leaving a doc, Build only before Xong', () => {
    const m = po();
    expect(dropReason(m, 'design', 'design')).toBeNull();
    expect(dropReason(m, 'design', 'build')).toBe('workflow.why.buildEnd');
    expect(dropReason(m, 'build', 'design')).toBe('workflow.why.oneBuild');
    expect(dropReason(m, 'general', null)).toBe('workflow.why.onlyOne');
    expect(dropReason(m, 'design', null)).toBe('workflow.why.onEdge');
    const four = po(Object.fromEntries([1, 2, 3].map(i => [`steps/d${i}.md`, doc({ type: 'design' })])));
    expect(dropReason(four, 'design', 'design')).toBe('workflow.why.maxDocs');
  });

  test('WF3a insert a doc on Thiết kế → Build: new file, the edge re-pointed, its labels back to auto (group kept)', () => {
    const ch = insertStep(tr, po(), 'design', 'design');
    expect(ch.select).toBe('doc');
    expect(ch.reset).toBe('design');
    expect(ch.edits).toEqual([
      { path: 'steps/doc.md', text: '' },
      { path: 'steps/doc.md', key: 'type', value: 'design' },
      { path: 'steps/doc.md', key: 'name', value: 'Soạn tài liệu' },
      { path: 'steps/doc.md', key: 'docs', value: 'docs/doc' },
      { path: 'steps/doc.md', key: 'next', value: { to: 'build', start: 'button' } },
      { path: 'steps/design.md', key: 'labels', value: { group: 'Đang thiết kế' } },
      { path: 'steps/design.md', key: 'next', value: { to: 'doc', start: 'button' } },
    ]);
  });

  test('a first doc on an empty chain ends at Xong and gives the pack a doc name (V10)', () => {
    const empty = wfModel({ 'WORKFLOW.md': doc({ name: 'Trống' }), 'steps/general.md': doc({ type: 'general' }), 'steps/lane.md': doc({ type: 'lane', phases: ['done'] }) });
    expect(dropReason(empty, 'design', null)).toBeNull();
    const ch = insertStep(tr, empty, 'design', null);
    expect(ch.edits).toContainEqual({ path: 'steps/doc.md', key: 'next', value: { to: 'done' } });
    expect(ch.edits).toContainEqual({ path: 'WORKFLOW.md', key: 'doc_label', value: 'Tài liệu' });
  });

  test('remove a doc: the step before points at what came after; removing Chung / Lane does nothing', () => {
    const m = wfModel({ 'WORKFLOW.md': doc({ doc_label: 'Spec' }),
      'steps/design.md': doc({ type: 'design', next: { to: 'plan', start: 'auto' } }), 'steps/plan.md': doc({ type: 'design', next: { to: 'build', start: 'button' } }),
      'steps/build.md': doc({ type: 'build', next: { to: 'done' } }), 'steps/general.md': doc({ type: 'general' }), 'steps/lane.md': doc({ type: 'lane' }) });
    expect(removeStep(m, 'plan').edits).toEqual([{ path: 'steps/plan.md', text: null }, { path: 'steps/design.md', key: 'next', value: { to: 'build', start: 'auto' } }]);
    expect(removeStep(m, 'general').edits).toEqual([]);
  });

  test('WF3d connect: Build only to Xong, no Chung / Lane, no loop, no second way in; a legal one re-points next', () => {
    const m = po({ 'steps/plan.md': doc({ type: 'design' }) });
    expect(connectReason(m, 'build', 'plan')).toBe('workflow.why.buildEnd');
    expect(connectReason(m, 'design', 'lane')).toBe('workflow.why.outside');
    expect(connectReason(m, 'general', 'design')).toBe('workflow.why.outside');
    expect(connectReason(m, 'design', 'design')).toBe('workflow.why.loop');
    expect(connectReason(m, 'plan', 'build')).toBe('workflow.why.oneIn');
    expect(connectReason(m, 'plan', 'design')).toBeNull();
    expect(connectReason(m, 'build', 'done')).toBeNull();
    expect(connect(m, 'plan', 'design').edits).toEqual([{ path: 'steps/plan.md', key: 'next', value: { to: 'design', start: 'button' } }]);
  });

  test('WF3b a new step takes its file name from its name; incoming next and the default docs folder follow', () => {
    const m = po({ 'steps/doc.md': doc({ type: 'design', name: 'Plan', docs: 'docs/doc', next: { to: 'build', start: 'button' } }),
      'steps/design.md': doc({ type: 'design', next: { to: 'doc', start: 'button' } }) });
    const ch = renameNew(m, { 'steps/doc.md': 'TEXT' }, 'doc', 'Plan')!;
    expect(ch.select).toBe('plan');
    expect(ch.edits).toEqual([
      { path: 'steps/doc.md', text: null }, { path: 'steps/plan.md', text: 'TEXT' },
      { path: 'steps/plan.md', key: 'docs', value: 'docs/plan' },
      { path: 'steps/design.md', key: 'next', value: { to: 'plan', start: 'button' } },
    ]);
    expect(freeId(m, 'Thiết kế')).toBe('thiet-ke');
    expect(freeId(m, 'Build')).toBe('build-2');
    expect(freeId(m, 'Done')).toBe('done-2');
  });
});

describe('v29-ux I4 / M10 check lines in the UI\'s words; the keyboard insert', () => {
  test('§4.9 no internal type, file name or frontmatter key reaches the UI; warnings lose their code marks', () => {
    expect(issueText(tr, { code: 'V5', msg: 'Gói cần đúng 1 bước general (đang có 0)' })).toBe('Gói cần đúng một bước Việc chung (đang có 0)');
    expect(issueText(tr, { code: 'V5', msg: 'Gói cần đúng 1 bước lane (đang có 2)' })).toBe('Gói cần đúng một bước Lane (đang có 2)');
    const all = [
      { code: 'V11', msg: '`notes.txt` không thuộc gói (chỉ WORKFLOW.md, steps/<id>.md)' }, { code: 'V9', msg: 'Bước lane thiếu `phases`' },
      { code: 'V12', msg: '`next` thiếu `to`' }, { code: 'V4', msg: 'Loại bước `foo` lạ: design, build, general hoặc lane' },
      { code: 'V1', msg: 'YAML hỏng ở dòng 3' }, { code: 'V13', msg: 'Khoá `foo` lạ' }, { code: 'V14', msg: 'Ô `{{x}}` lạ' },
    ].map(i => issueText(tr, i)).join(' | ');
    expect(all).not.toMatch(/`|notes\.txt|WORKFLOW\.md|steps\/|phases|next|\bto\b|YAML|\{\{|\b(general|design|build)\b|(?<!bằng )\blane\b/);
    expect(issueText(tr, { code: 'W', msg: 'Plugin `nope` chưa cài: lane sẽ bị chặn tới khi cài' })).toBe('Plugin nope chưa cài: lane sẽ bị chặn tới khi cài');
  });
  test('M10 Enter on a palette block: the selected edge takes it; none selected → how to pick one', () => {
    const m = po();
    expect(keyInsertReason(m, 'design', 'design')).toBeNull();
    expect(keyInsertReason(m, 'design', null)).toBe('workflow.why.pickEdge');
    expect(keyInsertReason(m, 'build', 'design')).toBe('workflow.why.oneBuild');
  });
});

describe('§4.6 / §4.7 / §6.2 texts around the canvas', () => {
  test('impact line names the projects and their open docs; none = "chưa dùng ở project nào"', () => {
    expect(impactLine(tr, row(), [])).toBe('chưa dùng ở project nào');
    const used = row({ usedBy: [{ id: 'p1', name: 'cc-slaves' }, { id: 'p2', name: 'hagenta' }] });
    const spec = (state: string) => ({ state }) as never;
    const issues = [{ projectId: 'p1', specs: [spec('active'), spec('done')], issues: [], outside: {} as never }];
    expect(impactLine(tr, used, issues)).toBe('Lưu → 2 project đang dùng gói này chạy bản mới · 1 tài liệu đang làm giữ bản cũ');
  });

  test('WF3c Tasks flow: own labels kept, the rest automatic from the next step; Ngoài <doc>, Xong', () => {
    const m = po({ 'steps/design.md': doc({ type: 'design', name: 'Thiết kế', next: { to: 'plan', start: 'button' } }),
      'steps/plan.md': doc({ type: 'design', name: 'Plan', next: { to: 'build', start: 'button' } }) });
    expect(tasksFlow(tr, m)).toBe('Đang thiết kế → Chờ plan [Bắt đầu plan] → Đang plan → Chờ build [Bắt đầu build] → Đang build → Ngoài spec → Xong');
  });

  test('library row second line: lỗi > mẫu gốc có bản mới > dùng ở n project > chưa dùng', () => {
    expect(rowSub(tr, row({ errors: [{ code: 'V1', msg: 'x' }], baseOutdated: true }))).toEqual({ text: 'lỗi', bad: true });
    expect(rowSub(tr, row({ baseOutdated: true })).text).toBe('mẫu gốc có bản mới');
    expect(rowSub(tr, row({ usedBy: [{ id: 'p', name: 'p' }] })).text).toBe('dùng ở 1 project');
    expect(rowSub(tr, row()).text).toBe('chưa dùng');
  });

  test('installed skill names as skills_deny writes them; file maps compare by text', () => {
    expect([...installedSkills([{ scope: 'plugin', id: 'plugin:superpowers@official:writing-plans', name: 'writing-plans' }, { scope: 'user', id: 'user:bmad-qa', name: 'bmad-qa' }])])
      .toEqual(['superpowers:writing-plans', 'bmad-qa']);
    expect(sameFiles({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
    expect(sameFiles({ a: '1' }, { a: '1', b: '' })).toBe(false);
  });
});
