import { PROTOCOL_VERSION, type AccountView, type CardView, type LaneView, type Snapshot } from '../../shared/protocol.ts';
import type { IssueInfo, ProjectIssues, SpecInfo } from '../../shared/issues.ts';
import { MOCK_DETAILS, MOCK_PO_REV } from '../dev/wf-mock.ts';
import { makeT } from '../../shared/i18n/core.ts';
import '../../shared/i18n/vi.ts'; // poSlots() reads the vi words
import { railSlots, type RailSlots, type WfDoc } from '../src/lib/wf-tasks.ts';

export const lane = (name: string, over: Partial<LaneView> = {}): LaneView => ({
  projectId: 'p1', name, state: 'running', phase: 'code', task: 'B2', note: null, account: 'pm@x', cwd: '/w/' + name,
  worktreeExists: true, agent: null, model: null, effort: null, failCount: 0, lastError: null, costUsd: 1, openCards: [],
  turnStartedAt: null, contextPct: 40, switches: 0, updatedAt: 1, ...over,
});

export const account = (email: string, over: Partial<AccountView> = {}): AccountView => ({
  id: null, login: 'ok', email, plan: '20x', role: 'primary', week: 99, five: null, hard: false, terminal: false, loggedOut: false, lanes: 0,
  weekPct: 48, fivePct: 31, weekResetsAt: null, fiveResetsAt: null, fetchedAt: 1, fresh: true, status: 'ok',
  headroomPct: 51, full: false, sharedCfg: { ok: true, issues: [] },
  refresh: { state: 'idle', at: null }, nextCheckAt: null, quotaError: null, fullWhy: null, admitBlock: null, pastReset: null, fiveWindow: true,
  ...over,
});

export const card = (id: number, over: Partial<CardView> = {}): CardView => ({
  id, kind: 'ask', projectId: 'p1', source: 'D2', status: 'open', createdAt: id * 1000, resolvedAt: null,
  title: 'D2 hỏi', question: 'Tách hay gộp?', options: [{ label: 'Tách' }, { label: 'Gộp' }], recommended: null, ...over,
});

export const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  engine: {
    version: '0.1.0', protocol: PROTOCOL_VERSION, claudePath: '/c', claudeVersion: '2.1.330', shellEnvOk: true, startedAt: 0,
    costTodayUsd: 41.2, remote: { enabled: false, hostname: null }, setupNeeded: false, ccUpdated: null,
  },
  channel: 'mac',
  projects: [{ id: 'p1', name: 'hagenta', path: '/w/hagenta', orchestratorAccount: 'a@x', gchatWebhookSet: false, gchatSendCommandText: false }],
  orchestrators: [{ projectId: 'p1', state: 'running', account: 'a@x', homeAccount: 'a@x', lastError: null, costUsd: 0, contextPct: 41, talkingTo: null }],
  lanes: [lane('D2'), lane('D15')], accounts: [account('a@x', { role: 'orchestrator' }), account('pm@x')],
  cards: [], config: {}, setup: null, login: null, quota: { cooldownUntil: null, queueEndsAt: null }, ...over,
});

// v2.7 Tasks (shared/issues.ts wire views)
const NO_PROGRESS = { done: 0, total: 0, scope: 0, cancelled: 0, amend: 0 };
export const specInfo = (id: number, over: Partial<SpecInfo> = {}): SpecInfo => ({
  id, projectId: 'p1', path: `docs/specs/s${id}.md`, title: `S${id}`, state: 'active', after: null, branch: null,
  sessions: { design: null, build: null, edit: null }, origin: 'app', outsideBuild: false, resumed: false, amendRev: 0, missing: false,
  groups: null, editing: false, progress: NO_PROGRESS, approvedAt: null, openedAt: null, doneAt: null, createdAt: id, overview: null,
  workflowRev: MOCK_PO_REV, step: null, ...over,
});
export const issueInfo = (num: number, over: Partial<IssueInfo> = {}): IssueInfo => ({
  id: num, projectId: 'p1', key: `T-${num}`, kind: 'task', specId: 1, title: `I${num}`, body: '', doneWhen: [], state: 'todo', revert: 'none',
  priority: false, blockedBy: [], waitingOn: [], blocks: [], lane: null, commits: [], source: 'spec', sourceLane: null, sourceIssue: null,
  reverts: null, poSeen: true, poOk: false, cancelReason: null, files: [], events: [], createdAt: num, doneAt: null, ...over,
});
export const projIssues = (specs: SpecInfo[], issues: IssueInfo[], projectId = 'p1'): ProjectIssues => ({ projectId, specs, issues, outside: NO_PROGRESS });

/** v2.9 §4.7 Quy trình PO as the Tasks tab reads it (the mock detail) and its rail slots / TasksCtx.wf. */
export const PO_DOC: WfDoc = { ...MOCK_DETAILS[0]!, steps: MOCK_DETAILS[0]!.steps! };
export const poSlots = (): RailSlots => railSlots(makeT('vi'), PO_DOC, new Map([[MOCK_PO_REV, PO_DOC]]));
export const poWf = () => ({ id: 'builtin:po', rows: [], cur: PO_DOC, docs: new Map([[MOCK_PO_REV, PO_DOC]]), slots: poSlots(), openWorkflows: () => {}, fallback: null });
