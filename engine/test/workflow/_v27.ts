// spec v2.9 §12 parity: captures every v2.7 string the "Quy trình PO" pack must reproduce, through the live engine paths
// (spawn appendix, the sh skill gate run on a hook stdin, kickoff texts, "xong hết mục", MCP descriptions, rules.ts refusals,
// labels). The v2.7 capture is frozen in `_fixtures/v27-parity.json`; `parity-snapshot.test.ts` keeps the engine equal to it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchKind } from '../../../shared/issues.ts';
import { t } from '../../../shared/i18n/index.ts';
import { insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { IssueEvents } from '../../src/issues/events.ts';
import * as R from '../../src/issues/rules.ts';
import { createIssue, insertSpec, moveSpec, updateSpec } from '../../src/issues/store.ts';
import { listTools, sessionToolText } from '../../src/mcp/tools.ts';
import { skillGatePath, skillSettings, writeSkillDeny, writeSkillGate } from '../../src/session/skills.ts';
import { kickoffText } from '../../src/workflow/compile.ts';
import { DEFAULT_WORKFLOW } from '../../src/workflow/builtin/index.ts';
import { sessionStep, spawnPrompt, stepOf, wfText, workflowOf } from '../../src/workflow/runtime.ts';

export const SAMPLE = { project: 'cc-slaves', path: 'docs/specs/v25.md' } as const;

const KINDS = ['design', 'build', 'general', 'lane'] as const;
const PO = workflowOf(DEFAULT_WORKFLOW);

/** One session per kind, pinned the way the engine pins it (project on "Quy trình PO"). */
function pinnedDb(): Db {
  const db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'one', path: '/r/one' });
  for (const k of KINDS) {
    insertSession(db, { id: k, projectId: 'p1', kind: k === 'lane' ? 'lane' : 'orchestrator', account: null });
    if (k !== 'lane') db.query('UPDATE session SET orch_kind = ? WHERE id = ?').run(k, k);
    db.query('UPDATE session SET step = ?, workflow_rev = ? WHERE id = ?').run(k, PO.rev, k);
  }
  return db;
}

/** The reason per kind, from the engine's sh gate run on a PreToolUse stdin for the kind's first blocked skill. */
function gateReasons(db: Db): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'ccs-parity-'));
  const was = process.env.CC_SLAVES_HOME;
  process.env.CC_SLAVES_HOME = home;
  try {
    writeSkillGate();
    return Object.fromEntries(KINDS.map((k) => {
      const step = sessionStep(db, k).step;
      writeSkillDeny(k, step);
      const skill = /^Skill\((.*)\)$/.exec(step.deny[0]!)![1]!;
      const r = Bun.spawnSync(['sh', skillGatePath(), join(home, 'skill-deny', `${k}.tsv`)], { stdin: Buffer.from(JSON.stringify({ tool_input: { skill } })) });
      return [k, (JSON.parse(r.stdout.toString()) as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason];
    }));
  } finally {
    if (was === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = was;
    rmSync(home, { recursive: true, force: true });
  }
}

function settledText(): string {
  const db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'one', path: '/r/one' });
  insertSession(db, { id: 'b1', projectId: 'p1', kind: 'orchestrator', account: null });
  db.query("UPDATE session SET orch_kind = 'build' WHERE id = 'b1'").run();
  const sent: string[] = [];
  const ev = new IssueEvents({ db, send: (_s, text) => sent.push(text), running: () => true, hasRoom: () => true, timers: { set: () => 0, clear: () => {} } });
  const s = insertSpec(db, { projectId: 'p1', path: SAMPLE.path, title: 'v2.5', origin: 'app' });
  moveSpec(db, s.id, 'approved');
  moveSpec(db, s.id, 'active');
  updateSpec(db, s.id, { buildSession: 'b1' });
  const i = createIssue(db, { projectId: 'p1', kind: 'task', specId: s.id, source: 'spec', title: 'x' });
  db.query("UPDATE issue SET state = 'done' WHERE id = ?").run(i.id);
  ev.specSettled(s.id);
  db.close();
  return sent[0]!;
}

const mcp = (db: Db, role: 'orchestrator' | 'lane') => listTools(role, sessionToolText(db, role === 'lane' ? 'lane' : 'build')).map((x) => ({ name: x.name, description: x.description, schema: x.inputSchema }));

type Spec = R.SpecLite;
type Issue = R.IssueLite;
const spec = (o: Partial<Spec> = {}): Spec => ({
  id: 1, path: SAMPLE.path, state: 'draft', origin: 'app', designSession: 'd1', buildSession: 'b1', editSession: null,
  resumed: false, outsideBuild: false, openedAt: null, ...o,
});
const issue = (o: Partial<Issue> = {}): Issue => ({
  id: 10, key: 'T-1', num: 1, projectId: 'p1', specId: 1, state: 'todo', source: 'spec', laneId: null, reverts: null, revert: 'none', baseSha: null, ...o,
});
const W = wfText(PO);
const orch = (kind: OrchKind, sessionId = kind === 'design' ? 'd1' : 'b1', s: Spec | null = spec()): R.Caller =>
  ({ role: 'orchestrator', projectId: 'p1', sessionId, stepType: kind, spec: s, wf: W });
const lane = (held: Issue | null = null): R.Caller => ({ role: 'lane', projectId: 'p1', laneId: 7, laneName: 'D2', held, wf: W });

/** One sample per refusal branch of rules.ts (the msg of each `no(…)`). */
function refusals(): Record<string, string> {
  const r: Record<string, R.Verdict> = {
    'draft.kind': R.checkSpecDraft(orch('build'), null),
    'draft.foreign': R.checkSpecDraft(orch('design', 'x'), spec()),
    'draft.active': R.checkSpecDraft(orch('design'), spec({ state: 'active' })),
    'draft.done': R.checkSpecDraft(orch('design'), spec({ state: 'done' })),
    'approve.kind': R.checkSpecApprove(orch('general'), spec()),
    'approve.foreign': R.checkSpecApprove(orch('design', 'x'), spec()),
    'approve.state': R.checkSpecApprove(orch('design'), spec({ state: 'approved' })),
    'amend.kind': R.checkSpecAmend(orch('build'), spec()),
    'amend.foreign': R.checkSpecAmend(orch('design'), spec({ state: 'active' })),
    'amend.state': R.checkSpecAmend(orch('design'), spec({ editSession: 'd1', state: 'approved' })),
    'close.kind': R.checkSpecClose(orch('design'), spec(), []),
    'close.foreign': R.checkSpecClose(orch('build', 'x'), spec({ state: 'active' }), []),
    'close.state': R.checkSpecClose(orch('build'), spec({ state: 'approved' }), []),
    'close.open': R.checkSpecClose(orch('build'), spec({ state: 'active' }), [issue()]),
    'close.revert': R.checkSpecClose(orch('build'), spec({ state: 'active' }), [issue({ state: 'done', revert: 'pending' })]),
    'build.state': R.checkSpecBuild(W, spec(), null, false),
    'build.edit': R.checkSpecBuild(W, spec({ state: 'approved', editSession: 'e1' }), null, false),
    'build.after': R.checkSpecBuild(W, spec({ state: 'approved' }), spec({ id: 2, path: 'docs/specs/v24.md', state: 'active' }), false),
    'build.resume': R.checkSpecBuild(W, spec({ state: 'approved' }), null, true),
    'mark.origin': R.checkSpecMark(W, spec(), 'approved'),
    'mark.move': R.checkSpecMark(W, spec({ origin: 'imported', state: 'active' }), 'draft'),
    'assign.state': R.checkAssignable(W, issue({ state: 'doing' }), null, []),
    'assign.lane': R.checkAssignable(W, issue({ laneId: 3 }), null, []),
    'assign.blocked': R.checkAssignable(W, issue(), null, [{ key: 'T-2', state: 'todo' }]),
    'assign.spec': R.checkAssignable(W, issue(), spec({ state: 'approved' }), []),
    'createInto': R.checkCreateInto(W, spec({ state: 'done' })),
    'priority': R.checkPriorityFirst(W, issue(), false, ['T-2']),
    'takes.outside': R.checkLaneTakes(W, issue({ specId: null }), 'issue_assign', null),
    'takes.doing': R.checkLaneTakes(W, issue(), 'lane_start', { name: 'D2', issues: [issue({ id: 11, key: 'T-3', state: 'doing' })] }),
    'takes.outsideLane': R.checkLaneTakes(W, issue(), 'lane_start', { name: 'D2', issues: [issue({ id: 11, key: 'T-3', state: 'done', specId: null })] }),
    'linkScope.lane': R.checkLinkScope(lane(), { key: 'T-1', id: 10, specId: 1, sourceLane: null }, { key: 'T-2', id: 11, specId: 1, sourceLane: null }),
    'linkScope.spec': R.checkLinkScope(orch('build'), { key: 'T-1', id: 10, specId: 1, sourceLane: null }, { key: 'T-2', id: 11, specId: 2, sourceLane: null }),
    'link.project': R.checkLink(issue(), issue({ id: 11, key: 'T-2', projectId: 'p2' }), [], new Map()),
    'link.self': R.checkLink(issue(), issue(), [], new Map()),
    'link.cycle': R.checkLink(issue(), issue({ id: 11, key: 'T-2' }), [{ issueId: 11, blockedById: 10 }], new Map([[10, 'T-1'], [11, 'T-2']])),
    'done.role': R.checkIssueDone(orch('build'), issue(), null),
    'done.held': R.checkIssueDone(lane(issue({ id: 11, key: 'T-3' })), issue(), null),
    'done.trailer': R.checkIssueDone(lane(issue()), issue(), 'thiếu trailer'),
    'laneCreate': R.checkLaneCreate(lane() as Extract<R.Caller, { role: 'lane' }>, 'p2'),
    'dup.cancelled': R.checkDupTitle(W, 'x', [{ key: 'T-4', norm: 'x', cancelReason: 'không cần' }], []),
    'create.prior': R.checkIssueCreate(orch('build'), null, 'todo', 'prior'),
    'create.state': R.checkIssueCreate(orch('build'), null, 'doing', 'spec'),
    'create.resumed': R.checkIssueCreate(orch('build'), spec(), 'done', 'prior'),
    'create.source': R.checkIssueCreate(orch('build'), spec({ resumed: true }), 'done', 'spec'),
    'drop.kind': R.checkIssueDrop(orch('general'), issue(), 'r'),
    'drop.foreign': R.checkIssueDrop(orch('build', 'b1', spec({ id: 2 })), issue(), 'r'),
    'drop.state': R.checkIssueDrop(orch('build'), issue({ state: 'doing' }), 'r'),
    'drop.prior': R.checkIssueDrop(orch('build'), issue({ source: 'prior' }), 'r'),
    'drop.reason': R.checkIssueDrop(orch('build'), issue(), ' '),
    'revert.held': R.checkRevertConflict(lane(), issue()),
    'revert.kind': R.checkRevertConflict(lane(issue()), issue()),
    'tool.createBuild': R.checkSessionTool(orch('build') as Extract<R.Caller, { role: 'orchestrator' }>, 'issue_create', { createSpecId: 2 }),
    'tool.createOther': R.checkSessionTool(orch('general') as Extract<R.Caller, { role: 'orchestrator' }>, 'issue_create', { createSpecId: 2 }),
    'tool.design': R.checkSessionTool(orch('design') as Extract<R.Caller, { role: 'orchestrator' }>, 'lane_start'),
    'tool.designOutput': R.checkSessionTool(orch('design') as Extract<R.Caller, { role: 'orchestrator' }>, 'spec_output_add', { spec: spec({ id: 2 }) }),
    'tool.buildSpec': R.checkSessionTool(orch('build') as Extract<R.Caller, { role: 'orchestrator' }>, 'spec_draft', { spec: spec() }),
    'tool.generalSpec': R.checkSessionTool(orch('general') as Extract<R.Caller, { role: 'orchestrator' }>, 'spec_draft'),
    'tool.buildIssue': R.checkSessionTool(orch('build') as Extract<R.Caller, { role: 'orchestrator' }>, 'issue_update', { issue: issue({ specId: null }) }),
    'tool.buildOther': R.checkSessionTool(orch('build') as Extract<R.Caller, { role: 'orchestrator' }>, 'issue_update', { issue: issue({ specId: 2 }) }),
    'tool.generalIssue': R.checkSessionTool(orch('general') as Extract<R.Caller, { role: 'orchestrator' }>, 'issue_update', { issue: issue() }),
  };
  return Object.fromEntries(Object.entries(r).map(([k, v]) => {
    if (v.ok) throw new Error(`parity sample ${k} did not refuse`);
    return [k, v.msg];
  }));
}

export function captureV27() {
  const db = pinnedDb();
  const step = (k: (typeof KINDS)[number]) => sessionStep(db, k).step;
  const design = stepOf(PO, 'design')!;
  const build = stepOf(PO, 'build')!;
  const out = {
    appendix: Object.fromEntries(KINDS.map((k) => [k, spawnPrompt(db, k, false).text])),
    deny: Object.fromEntries(KINDS.map((k) => [k, skillSettings(k, step(k)).deny])),
    reason: gateReasons(db),
    firstText: {
      design: kickoffText(design, 'new', { project: SAMPLE.project }), edit: kickoffText(design, 'edit', { path: SAMPLE.path }),
      build: kickoffText(build, 'new', { path: SAMPLE.path }), buildOutside: kickoffText(build, 'new', { path: SAMPLE.path }, true),
      resume: kickoffText(build, 'resume', { path: SAMPLE.path }),
    },
    settled: settledText(),
    mcp: { orchestrator: mcp(db, 'orchestrator'), lane: mcp(db, 'lane') },
    refusals: refusals(),
    labels: {
      kind: W.names,
      group: t('vi', 'tasks.rail.group.designing'), building: t('vi', 'tasks.rail.group.building'), waiting: t('vi', 'tasks.rail.group.ready'), start: t('vi', 'tasks.rail.build'),
    },
  };
  db.close();
  return out;
}
