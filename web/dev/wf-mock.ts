// v2.9 G5 dev mock of the workflow library the Tasks tab reads (`workflows` rows, `workflow_get {rev}`): the three
// built-ins with the labels / next / phases of engine/src/workflow/builtin (web never imports the engine, L2). Revs are fake.
import type { Command, Snapshot } from '../../shared/protocol.ts';
import type { WorkflowDetail, WorkflowRow } from '../../shared/workflows.ts';

type Step = NonNullable<WorkflowDetail['steps']>[number];
const PHASES = ['queue', 'spec', 'code', 'review', 'gate', 'merge', 'done'];
const step = (id: string, type: Step['type'], name: string, o: Partial<Step> = {}): Step =>
  ({ id, type, name, labels: {}, next: null, phases: null, ...o });
const general = step('general', 'general', 'Chung');
const design = (waiting: string, start: string, to: string): Step =>
  step('design', 'design', 'Thiết kế', { labels: { group: 'Đang thiết kế', waiting, start }, next: { to, start: 'button' } });
const build = step('build', 'build', 'Build', { labels: { group: 'Đang build' }, next: { to: 'done', start: null } });

export const MOCK_PO_REV = 'a1b2c3d4e5f6'.padEnd(64, '0');
const detail = (rev: string, name: string, docLabel: string, steps: Step[]): WorkflowDetail => ({ rev, files: {}, errors: [], warnings: [], name, docLabel, steps });
export const MOCK_DETAILS: readonly WorkflowDetail[] = [
  detail(MOCK_PO_REV, 'Quy trình PO', 'Spec', [design('Chờ build', 'Bắt đầu build', 'build'), build, general, step('lane', 'lane', 'Lane', { phases: PHASES })]),
  detail('b2c3d4e5f6a1'.padEnd(64, '0'), 'Spec + Plan', 'Spec', [design('Chờ plan', 'Bắt đầu plan', 'plan'),
    step('plan', 'design', 'Plan', { labels: { group: 'Đang viết plan', waiting: 'Chờ build', start: 'Bắt đầu build' }, next: { to: 'build', start: 'button' } }),
    build, general, step('lane', 'lane', 'Lane', { phases: PHASES })]),
  detail('c3d4e5f6a1b2'.padEnd(64, '0'), 'Giao thẳng', '', [general, step('lane', 'lane', 'Lane', { phases: ['queue', 'code', 'review', 'done'] })]),
];
const DESC = ['Thiết kế → duyệt → Build bằng lane → review nhóm → gate → merge. Không plan doc.', 'Thiết kế → Plan → Build; Build chạy plan qua lane.',
  'Không tài liệu: mỗi yêu cầu thành một mục, giao lane, review, merge.'];
const IDS = ['builtin:po', 'builtin:spec-plan', 'builtin:direct'];

/** The library rows (`usedBy` from the snapshot's `project.workflow`, default Quy trình PO). */
export function mockRows(s: Snapshot): WorkflowRow[] {
  return MOCK_DETAILS.map((d, i) => ({
    id: IDS[i]!, builtin: true, name: d.name, description: DESC[i]!, rev: d.rev, diskRev: d.rev, validAt: null, errors: [], warnings: [],
    basedOn: null, baseOutdated: false, dir: null, usedBy: s.projects.filter(p => (p.workflow ?? IDS[0]) === IDS[i]).map(p => ({ id: p.id, name: p.name })),
  }));
}

/** `workflow_get` / `project_set_workflow`; undefined = not a workflow command. */
export function wfReply(s: Snapshot, c: Command): { result: unknown } | undefined {
  if (c.cmd === 'workflow_get') return { result: MOCK_DETAILS.find((d, i) => ('rev' in c ? d.rev === c.rev : IDS[i] === c.id)) ?? null };
  if (c.cmd === 'project_set_workflow') {
    const p = s.projects.find(x => x.id === c.projectId);
    if (p) p.workflow = c.id;
    s.workflows = mockRows(s);
    return { result: undefined };
  }
  return undefined;
}
