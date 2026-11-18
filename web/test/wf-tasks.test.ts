// v2.9 §4.7 the Tasks tab follows the pack: rail groups / waiting groups / start labels per doc step (labels or the
// generated "Đang / Chờ / Bắt đầu" + step name), the chain order, Giao thẳng (no doc), the {doc} / {design} / {build}
// names the catalog strings take, and the effective-config line.
import { describe, expect, test } from 'bun:test';
import { makeT } from '../../shared/i18n/core.ts';
import '../../shared/i18n/vi.ts';
import type { WorkflowDetail } from '../../shared/workflows.ts';
import { specRail } from '../src/lib/issues.ts';
import { railSlots, stepLabels, wfLine, wfNames, type WfDoc } from '../src/lib/wf-tasks.ts';
import { MOCK_DETAILS, MOCK_PO_REV } from '../dev/wf-mock.ts';
import { issueInfo as issue, projIssues as pi, specInfo as spec } from './fixtures.ts';

const tr = makeT('vi');
const [PO, SP, DIRECT] = MOCK_DETAILS as [WorkflowDetail, WorkflowDetail, WorkflowDetail];
const doc = (d: WorkflowDetail): WfDoc => ({ ...d, steps: d.steps! });
type Step = WfDoc['steps'][number];
/** A pack whose design step "Ý tưởng" has no labels and starts "Duyệt" by button; "Duyệt" auto-starts Build. */
const BARE: WfDoc = {
  rev: 'r-bare', name: 'Gói trần', docLabel: 'Ghi chú', steps: [
    { id: 'idea', type: 'design', name: 'Ý tưởng', labels: {}, next: { to: 'review', start: 'button' }, phases: null },
    { id: 'review', type: 'design', name: 'Duyệt', labels: {}, next: { to: 'build', start: 'auto' }, phases: null },
    { id: 'build', type: 'build', name: 'Làm', labels: {}, next: { to: 'done', start: null }, phases: null },
  ] as Step[],
};

describe('v2.9 §4.7 step labels', () => {
  test('§4.7 the pack labels win (Quy trình PO = the v2.7 words)', () => {
    expect(stepLabels(tr, doc(PO), 'design')).toEqual({ group: 'Đang thiết kế', waiting: 'Chờ build', start: 'Bắt đầu build' });
    expect(stepLabels(tr, doc(PO), 'build')).toEqual({ group: 'Đang build', waiting: null, start: null });
    expect(stepLabels(tr, doc(SP), 'design')).toEqual({ group: 'Đang thiết kế', waiting: 'Chờ plan', start: 'Bắt đầu plan' });
  });
  test('§4.7 empty labels are generated from the step names (lower case); an auto edge has no waiting group / button', () => {
    expect(stepLabels(tr, BARE, 'idea')).toEqual({ group: 'Đang ý tưởng', waiting: 'Chờ duyệt', start: 'Bắt đầu duyệt' });
    expect(stepLabels(tr, BARE, 'review')).toEqual({ group: 'Đang duyệt', waiting: null, start: null });
    expect(stepLabels(tr, BARE, 'build')).toEqual({ group: 'Đang làm', waiting: null, start: null });
    expect(stepLabels(tr, BARE, 'gone')).toBeNull();
  });
});

describe('v2.9 §4.7 rail by pack', () => {
  const docs = new Map([[MOCK_PO_REV, doc(PO)], [SP.rev, doc(SP)], [BARE.rev, BARE]]);
  test('§4.7 Quy trình PO: the v2.7 groups, labels and order (parity)', () => {
    const r = specRail(pi([spec(5, { state: 'done', doneAt: 5, step: null }), spec(1, { state: 'active' }), spec(2, { state: 'draft', step: 'design' }),
      spec(3, { state: 'approved', step: 'design' })], [issue(1, { specId: null })]), railSlots(tr, doc(PO), docs));
    expect(r.map(g => [g.group, g.label])).toEqual([['designing', 'Đang thiết kế'], ['ready', 'Chờ build'], ['building', 'Đang build'],
      ['outside', 'Ngoài spec'], ['done', 'Xong']]);
    expect(r.find(g => g.group === 'ready')!.start).toBe('Bắt đầu build');
  });
  test('§4.7 Spec + Plan: a spec at Plan sits in "Đang viết plan" between "Chờ plan" and "Chờ build"; chain order kept', () => {
    const at = (id: number, state: 'draft' | 'approved', step: string) => spec(id, { state, step, workflowRev: SP.rev });
    const r = specRail(pi([at(1, 'approved', 'plan'), at(2, 'draft', 'plan'), at(3, 'approved', 'design'), at(4, 'draft', 'design')], []),
      railSlots(tr, doc(SP), docs));
    expect(r.map(g => `${g.label}:${g.specs.map(s => s.id).join(',')}`)).toEqual(['Đang thiết kế:4', 'Chờ plan:3', 'Đang viết plan:2', 'Chờ build:1']);
    expect(r.map(g => g.start)).toEqual([null, 'Bắt đầu plan', null, 'Bắt đầu build']);
  });
  test('§6.1 a spec pinned to an older rev keeps its own labels; a group of the same words merges', () => {
    const r = specRail(pi([spec(1, { state: 'approved', step: 'design' }), spec(2, { state: 'approved', step: 'idea', workflowRev: BARE.rev })], []),
      railSlots(tr, doc(SP), docs));
    expect(r.map(g => g.label)).toEqual(['Chờ build', 'Chờ duyệt']);
  });
  test('§4.7 Giao thẳng: only "Việc" (the outside group), shown even with no issue yet', () => {
    const slots = railSlots(tr, doc(DIRECT), docs);
    expect(specRail(pi([], []), slots).map(g => [g.group, g.label])).toEqual([['outside', 'Việc']]);
    expect(slots.outsideRow).toBe('Tất cả việc');
    expect(railSlots(tr, doc(PO), docs).outsideRow).toBe('Bug & việc lẻ');
  });
  test('§4.6 after Áp dụng Giao thẳng the specs still open keep their old rev: their groups in lifecycle order, before Việc', () => {
    const r = specRail(pi([spec(1, { state: 'approved', step: 'design', createdAt: 1 }), spec(2, { state: 'draft', step: 'design', createdAt: 2 })], []),
      railSlots(tr, doc(DIRECT), docs));
    expect(r.map(g => g.label)).toEqual(['Đang thiết kế', 'Chờ build', 'Việc']);
  });
});

describe('v2.9 §4.7 names + effective config', () => {
  test('§4.7 {doc} / {design} / {build} of a pack (absent = the catalog default)', () => {
    expect(wfNames(doc(SP))).toEqual({ doc: 'Spec', docLow: 'spec', design: 'Thiết kế', designLow: 'thiết kế', build: 'Build', buildLow: 'build' });
    expect(wfNames(BARE)).toEqual({ doc: 'Ghi chú', docLow: 'ghi chú', design: 'Ý tưởng', designLow: 'ý tưởng', build: 'Làm', buildLow: 'làm' });
    expect(wfNames(doc(DIRECT))).toEqual({ doc: 'Việc', docLow: 'việc' });
    expect(tr('tasks.rail.group.outside', wfNames(BARE))).toBe('Ngoài ghi chú');
    expect(tr('tasks.rail.group.outside')).toBe('Ngoài spec');
  });
  test('§4.7 "Quy trình PO · Build · bản a1b2c3" and the hover (blocked skills + rules on)', () => {
    const wf = { rev: MOCK_PO_REV, name: 'Quy trình PO', step: 'build', stepName: 'Build', deny: ['superpowers:writing-plans'], rules: ['priority_first', 'one_item_per_lane'], maxDoc: 3 };
    const l = wfLine(tr, wf);
    expect(l.text).toBe('Quy trình PO · Build · bản a1b2c3');
    expect(l.tip).toBe('Skill bị chặn: superpowers:writing-plans\nLuật bật: Giao mục ưu tiên trước · Một lane một mục · 3 phiên tài liệu cùng lúc');
    expect(wfLine(tr, { ...wf, deny: [], rules: [] }).tip).toBe('Skill bị chặn: không có\nLuật bật: 3 phiên tài liệu cùng lúc');
  });
});
