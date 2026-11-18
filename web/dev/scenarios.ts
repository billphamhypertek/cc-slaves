// Scripted snapshots for the dev mock engine — data copied from the mockup (ACC0, LANES0, CARD, CON_BASE).
import { BASE, crowd, EXTRA, scene } from '../test/deck/scene.ts';
import { PROTOCOL_VERSION, type AccountView, type CardView, type DoneLanesPage, type LaneView, type OrchestratorView, type GitSetup, type SetupStatus, type Snapshot, type StreamLine, type SubagentView, type TokenCounts } from '../../shared/protocol.ts';
import { keyedText, makeT, t, type Key, type Params } from '../../shared/i18n/index.ts';
import { fmtHm } from '../src/lib/format.ts';
import { ACC_FRAMES, accFrame, isAccFrame } from './acc-scene.ts';
import { deckTraces } from './deck-scene.ts';
import { IS_FRAMES, isIsFrame, issuesFrame } from './issues-scene.ts';

const H = 3_600_000, M = 60_000;
export const FRAMES = ['F3', 'F4', 'F7', 'F10', 'F11', 'F13', 'F15', 'F16', 'F17',
  'F1a', 'F1b', 'F1c', 'F1d', 'F1e', 'F2', 'F8', 'F9', 'F12', 'F22', 'F24', 'F25', // second row: lane g3-web-b
  'DK5', 'DK30', 'DK300', 'DK5L', 'DK30L', 'DK300L', // v1.1 deck: 5 / 30 / 300 accounts × 10 lanes (L = 24 lanes)
  'DK0', 'DKF', 'DKN', 'DK30P', 'DKS', 'DKX', // v1.1 §4.6: project without lanes · every account full · zone overflow "+n"
  ...ACC_FRAMES, // v2.7.1 account panel (web/dev/acc-scene.ts)
  'DKM', // v2.4 §6.3 / §5.3 / §4.3: the conversation with attachment labels, a held message, the engine lines
  'DKC', // v2.4 §6.7 D52 CP1: one Chờ PO row per kind (10 kinds) + one resolved
  'DKXN', // §4.15 §3 Rev 18/11: the DKX done lanes with 0 live lanes (the Xong shelf right under the root)
  ...IS_FRAMES] as const; // v2.7 Tasks: one frame per mockup id (web/dev/issues-scene.ts)
export type Frame = (typeof FRAMES)[number];

const acc = (email: string, plan: string, role: AccountView['role'], week: number, hard: boolean, used: number, five: number, resetIn: number): AccountView => ({
  id: null, login: 'ok', email, plan, role, week, five: null, hard, terminal: false, loggedOut: false, lanes: 0, weekPct: used, fivePct: five,
  weekResetsAt: Date.now() + resetIn, fiveResetsAt: Date.now() + 3 * H, fetchedAt: Date.now() - 2 * M, fresh: true, status: 'ok',
  headroomPct: Math.max(0, week - used), full: hard ? used >= week - 1 : used >= week,
  sharedCfg: { ok: true, issues: [] },
  refresh: { state: 'idle', at: null }, nextCheckAt: null, quotaError: null, fullWhy: null, admitBlock: null, pastReset: null, fiveWindow: true,
});

const lane = (name: string, account: string, phase: LaneView['phase'], task: string, note: string): LaneView => ({
  projectId: 'hagenta', name, state: 'running', phase, task, note, account, cwd: `/Users/po/Works/Projects/hagenta-${name.toLowerCase()}`,
  worktreeExists: true, agent: 'coder-medium', model: 'opus', effort: 'medium', failCount: 0, lastError: null, costUsd: 18.4,
  openCards: [], turnStartedAt: Date.now() - 40_000, contextPct: 63, switches: 1, updatedAt: Date.now(),
});

let cardSeq = 40;
/** MINOR-4: the `titleKey` / `params` (+ the vi `title`) the engine sends for that card. */
const keyed = (titleKey: Key, params: Params) => ({ titleKey, params, title: t('vi', titleKey, params) });
/** The permission title as `permissionTitleKey` builds it (`{source}` stays raw; the web maps `orchestrator`). */
const perm = (source: string, tool: string, main: string) =>
  ({ titleKey: 'cards.permission', params: { source, tool, main }, title: t('vi', 'cards.permission', { source: source === 'orchestrator' ? t('vi', 'common.role.orchestrator') : source, tool, main }) });
const ask = (over: Partial<CardView>): CardView => ({
  id: ++cardSeq, kind: 'ask', projectId: 'hagenta', source: 'orchestrator', status: 'open', createdAt: Date.now() - (60 - cardSeq) * M,
  resolvedAt: null, title: '', ...over,
});

const doneCard = (): CardView => ask({ source: 'orchestrator', status: 'answered', title: 'Chạy D15 trên bo24990?', question: 'Chạy D15 trên bo24990?', resolvedAt: Date.now() - 30 * M, answer: { option: 'Đồng ý' } });

export function snapshotFor(f: Frame, channel: 'mac' | 'remote'): Snapshot {
  if (f.startsWith('DK')) return liveTimes(deckFrame(f, channel));
  if (isAccFrame(f)) return accFrame(f, liveTimes(deckFrame('DK5', channel)));
  if (isIsFrame(f)) return liveTimes(deckTraces(issuesFrame(snapshotFor('F3', channel), f), f));
  cardSeq = 40;
  const accounts = [
    acc('bo@example.org', 'Max 5x', 'orchestrator', 99, false, 48, 31, 4 * 24 * H + 16 * H),
    acc('pm@example.net', '20x', 'primary', 99, false, 68, 42, 2 * 24 * H + 6 * H),
    acc('bo24990@example.com', '20x', 'primary', 99, false, 87, 55, 21 * H + 40 * M),
    acc('dev2609@example.com', '20x', 'primary', 60, true, 98, 12, 3 * 24 * H + 15 * H),
    acc('ba@example.net', 'Max 5x', 'backup', 70, true, 37, 8, 5 * 24 * H + 17 * H),
  ];
  accounts[1]!.lanes = 1; accounts[2]!.lanes = 1;
  const lanes = [lane('D2', 'pm@example.net', 'code', 'B2', 'group A lot-2'), lane('D15', 'bo24990@example.com', 'review', 'E5g', 're-review')];
  const orch: OrchestratorView = { projectId: 'hagenta', state: 'running', account: 'bo@example.org', homeAccount: 'bo@example.org', lastError: null, costUsd: 4.1, contextPct: 41, talkingTo: null };
  let cards: CardView[] = [doneCard()];
  const s: Snapshot = {
    engine: { version: '0.1.0', protocol: PROTOCOL_VERSION, claudePath: '/Users/po/.local/bin/claude', claudeVersion: '2.1.325', shellEnvOk: true, startedAt: Date.now() - 6 * H,
      costTodayUsd: 41.2, remote: { enabled: true, hostname: 'slaves.example.test' }, setupNeeded: false, ccUpdated: null },
    channel, quota: { cooldownUntil: null, queueEndsAt: null },
    projects: [
      { id: 'hagenta', name: 'hagenta', path: '/Users/po/Works/Projects/hagenta', orchestratorAccount: 'bo@example.org', gchatWebhookSet: true, gchatSendCommandText: false },
      { id: 'cc-slaves', name: 'cc-slaves', path: '/Users/po/Works/Projects/cc-slaves', orchestratorAccount: 'bo@example.org', gchatWebhookSet: false, gchatSendCommandText: false },
    ],
    orchestrators: [orch, { ...orch, projectId: 'cc-slaves', state: 'idle', contextPct: 12 }],
    lanes, accounts, cards, config: {}, setup: null, login: null,
  };
  if (f === 'F4') {
    lanes[0]!.state = 'waiting_po';
    cards = [
      ask({ source: 'D2', title: 'D2 hỏi về migration 105', question: 'Migration 105 thêm cột `phase_note` cho B2 lot-2. Tách thành 2 release theo docs/operations.md hay gộp một lần?',
        options: [{ label: 'Gộp 1 release' }, { label: 'Tách 2 release' }, { label: 'Hoãn sang lot-3' }], recommended: 'Tách 2 release',
        context: 'Lot-2 đổi schema bảng lanes. docs/operations.md yêu cầu migration thêm cột có default chạy 2 release khi bảng đang có ghi. Tách: thêm 1 bước deploy, không khoá bảng. Gộp: nhanh hơn ~30 phút, rủi ro khoá bảng 2–3 s trên local-check.' }),
      ask({ title: 'Merge E5', question: 'D15 re-review xong E5g sạch. Merge E5 vào phase2.1 ngay hay chờ D2 xong lot-2?', options: [{ label: 'Merge ngay' }, { label: 'Chờ D2' }], recommended: 'Merge ngay' }),
      ask({ title: 'Tên nhánh', question: 'Tên nhánh cho E5h là gì?', options: [] }),
      doneCard(),
    ];
    lanes[0]!.openCards = [cards[0]!.id];
  }
  if (f === 'F7') {
    lanes[0]!.state = 'broken'; lanes[0]!.failCount = 3; lanes[0]!.lastError = 'API Error: 529 overloaded_error';
    // the engine: title `cards.laneBroken`, body = the lane's lastError (Claude's own text → no bodyKey)
    cards = [ask({ kind: 'broken', source: null, ...keyed('cards.laneBroken', { name: 'D2' }), context: 'API Error: 529 overloaded_error',
      actions: [{ id: 'lane_resume', label: 'Chạy lại', labelKey: 'cardText.act.resume' }, { id: 'view_log', label: 'Xem log', labelKey: 'cardText.act.viewLog' }, { id: 'hand_to_orchestrator', label: 'Giao điều phối xử lý', labelKey: 'cardText.act.handToOrch' }] }), doneCard()];
  }
  if (f === 'F11') {
    // the engine: an exit reason it composed itself → keyed (`errors.exitCode`) in the view and as the card's bodyKey
    const why = { key: 'errors.exitCode', params: { code: 1 } };
    orch.state = 'stopped'; orch.lastError = keyedText(makeT('vi'), why); orch.lastErrorKeyed = why;
    cards = [ask({ kind: 'orchestrator_down', source: null, ...keyed('cards.orchestratorDown', { project: 'hagenta' }), context: orch.lastError, bodyKey: why.key, bodyParams: why.params,
      actions: [{ id: 'restart_orchestrator', label: 'Khởi động lại', labelKey: 'cardText.act.restart' }, { id: 'new_orchestrator', label: 'Phiên mới (kèm handoff)', labelKey: 'cardText.act.newSession' }] }), doneCard()];
  }
  if (f === 'F15') {
    lanes[0]!.state = 'waiting_po';
    cards = [
      ask({ kind: 'permission', source: 'D2', ...perm('D2', 'Bash', 'rm -rf build/'), canAllowAlways: true, context: 'Bash: rm -rf build/\ncwd: /Users/po/Works/Projects/hagenta-d2\nlý do: dọn bản build cũ trước khi chạy check:structure' }),
      ask({ kind: 'permission', source: 'D15', ...perm('D15', 'Edit', 'docs/specs/d15-e5.md'), status: 'answered', resolvedAt: Date.now() - 20 * M, answer: { behavior: 'allow' } }),
      ask({ kind: 'permission', source: 'D2', ...perm('D2', 'Bash', 'npm run migrate:local'), status: 'cancelled', resolvedAt: Date.now() - 40 * M }),
      ask({ kind: 'permission', source: 'orchestrator', ...perm('orchestrator', 'Bash', 'git push origin phase2.1'), status: 'expired', resolvedAt: Date.now() - 90 * M }),
    ];
  }
  if (f === 'F16') {
    accounts[3]!.loggedOut = true; accounts[3]!.login = 'out'; accounts[3]!.status = 'unknown';
    cards = [ask({ kind: 'logged_out', projectId: null, source: null, title: 'dev@ đã đăng xuất', titleKey: 'cards.loggedOut', params: { who: 'dev@' }, key: accounts[3]!.email, // v2 §6 F16
      actions: [{ id: 'account_relogin', label: 'Đăng nhập lại', labelKey: 'cardText.act.relogin' }] }), doneCard()];
  }
  if (f === 'F17') {
    cards = [
      // the engine (wire.ts `version`): ok → keyed title + body; bad → keyed title + keyed body (failure.reason, G5 NEW-1)
      ask({ kind: 'cc_updated', projectId: null, source: null, ...keyed('cards.ccUpdatedOk', { version: '2.1.330' }), context: t('vi', 'cardText.body.ccUpdatedOk'), bodyKey: 'cardText.body.ccUpdatedOk',
        actions: [{ id: 'dismiss', label: t('vi', 'cardText.act.seen'), labelKey: 'cardText.act.seen' }] }),
      ask({ kind: 'cc_updated', projectId: null, source: null, ...keyed('cards.ccUpdatedBad', { version: '2.1.331' }), context: t('vi', 'errors.start_old_version', { version: '2.1.331', min: '2.1.300' }), bodyKey: 'errors.start_old_version', bodyParams: { version: '2.1.331', min: '2.1.300' },
        actions: [{ id: 'setup_check', label: t('vi', 'cardText.act.recheck'), labelKey: 'cardText.act.recheck' }, { id: 'dismiss', label: t('vi', 'cardText.act.seen'), labelKey: 'cardText.act.seen' }] }),
      doneCard(),
    ];
  }
  if (f === 'F24') { accounts[3]!.full = true; accounts[3]!.headroomPct = 0; }
  if (f === 'F9') {
    lanes[0]!.state = 'waiting_po';
    lanes.push({ ...lane('D7', 'pm@example.net', 'done', 'C1', 'xong, đã merge'), state: 'done' },
      { ...lane('D9', 'ba@example.net', 'queue', 'F2', 'chờ quota'), state: 'waiting_quota' },
      { ...lane('D11', 'bo24990@example.com', 'code', 'A4', 'rảnh sau commit'), state: 'idle' },
      { ...lane('D3', 'pm@example.net', 'code', 'B1', 'hỏng'), state: 'broken', failCount: 3, lastError: 'API Error: 529 overloaded_error' });
    cards = [ask({ source: 'D2', title: 'D2 hỏi về migration 105', question: 'Migration 105: tách 2 release hay gộp một lần?', options: [{ label: 'Gộp 1 release' }, { label: 'Tách 2 release' }], recommended: 'Tách 2 release' }),
      ask({ title: 'Merge E5', question: 'Merge E5 vào phase2.1 ngay hay chờ D2 xong lot-2?', options: [{ label: 'Merge ngay' }, { label: 'Chờ D2' }], recommended: 'Merge ngay' }), doneCard()];
  }
  const wiz = /^F1[a-e]$/.test(f);
  if (f === 'F2' || wiz) {
    s.projects = []; s.orchestrators = []; s.lanes = []; cards = [];
    if (wiz) { s.engine.setupNeeded = true; s.setup = setupFor(f); if (f === 'F1a' || f === 'F1b') s.accounts = []; }
  }
  if (f === 'F13') {
    s.engine.startedAt = Date.now();
    orch.state = 'starting';
    lanes.forEach(l => { l.state = 'starting'; });
  }
  s.cards = cards;
  return liveTimes(s);
}

/** v2.4 §6.7 CP1 (mockup `CP_ALL`): every kind that reaches Chờ PO, as the engine sends it, + one answered permission. */
function cpCards(): CardView[] {
  const t0 = Date.now() - 30 * M;
  let n = 0;
  const c = (over: Partial<CardView>): CardView => ({ id: 700 + ++n, kind: 'ask', projectId: 'p1', source: null, status: 'open', createdAt: t0 + n * M, resolvedAt: null, title: '', ...over });
  const a = (id: string, labelKey: Key) => ({ id, label: t('vi', labelKey), labelKey });
  return [
    c({ kind: 'permission', source: 'D2', ...perm('D2', 'Bash', 'rm -rf build/ && bun run build'), canAllowAlways: true,
      context: 'rm -rf build/ && bun run build\n# cwd ../hagenta-d2 · nhánh lane/d2' }),
    c({ source: 'D15', ...keyed('cards.ask', { source: 'D15', question: 'Giữ API cũ hay tách module mới?' }), question: 'Giữ API cũ hay tách module mới?',
      options: [{ label: 'Tách', description: 'billing-v2, sửa 9 import, chạy lại e2e' }, { label: 'Giữ', description: 'giữ API cũ, thêm adapter' }], recommended: 'Tách',
      context: 'Module billing đang export 14 hàm cũ; D2, B3 và R5 import thẳng. Tách module mới thì sửa import ở 9 file và chạy lại gate e2e. Giữ thì thêm một adapter mỏng, nợ kỹ thuật để lại cho v2.5.' }),
    c({ kind: 'permission', source: 'B2', ...perm('B2', 'Bash', 'bun run lint --fix') }),
    c({ kind: 'broken', key: 'lane:R5', ...keyed('cards.laneBroken', { name: 'R5' }), context: 'npm ERR! Lifecycle script failed\nexit 1 · `npm run test:unit`',
      actions: [a('lane_resume', 'cardText.act.resume'), a('view_log', 'cardText.act.viewLog'), a('hand_to_orchestrator', 'cardText.act.handToOrch')] }),
    c({ kind: 'orchestrator_down', ...keyed('cards.orchestratorDown', { project: 'hagenta' }), context: 'exit 1 (đã tự khởi động lại 1 lần)',
      actions: [a('restart_orchestrator', 'cardText.act.restart'), a('new_orchestrator', 'cardText.act.newSession')] }),
    c({ kind: 'mcp_login', projectId: null, key: 'github', ...keyed('cards.mcpLogin', { name: 'github', lanes: 'D2, B3', scope: '' }),
      actions: [a('mcp_login', 'cardText.act.login'), a('mcp_snooze', 'cardText.act.later')] }),
    c({ kind: 'logged_out', projectId: null, key: 'acc07@example.org', ...keyed('cards.loggedOut', { who: 'acc07@' }), actions: [a('account_relogin', 'cardText.act.relogin')] }),
    c({ kind: 'shared_cfg', projectId: null, key: 'acc07@example.org/skills', ...keyed('cards.sharedCfgNotLinked', { who: 'acc07@', name: 'skills' }),
      context: '- skills/review/SKILL.md\n- skills/deploy/SKILL.md\n- skills/notes.md', actions: [a('shared_cfg_merge', 'cardText.act.merge'), a('dismiss', 'cardText.act.later')] }),
    c({ kind: 'account_orphan', projectId: null, key: '/Users/po/.cc-slaves-accounts/old', ...keyed('cards.accountOrphan', { email: 'old@example.org' }),
      bodyKey: 'cardText.body.orphan', bodyParams: { dir: '~/.cc-slaves-accounts/old', email: 'old@example.org' },
      actions: [a('account_orphan_adopt', 'cardText.act.adopt'), a('account_orphan_delete', 'cardText.act.delete')] }),
    c({ kind: 'cc_updated', projectId: null, ...keyed('cards.ccUpdatedOk', { version: '2.1.330' }), bodyKey: 'cardText.body.ccUpdatedOk', actions: [a('dismiss', 'cardText.act.seen')] }),
    c({ kind: 'permission', source: 'D2', ...perm('D2', 'Bash', 'bun test engine/test'), status: 'answered', resolvedAt: Date.now() - 2 * M, answer: { behavior: 'allow' } }),
  ];
}

/** Orchestrator console history (CON_BASE + 600 older generated lines so scroll-up paging has something to load). */
export function orchHistory(): StreamLine[] {
  const t0 = Date.now() - 3 * H;
  const old: StreamLine[] = Array.from({ length: 600 }, (_, i) => ({ seq: i + 1, ts: t0 + i * 1000, kind: i % 3 ? 'engine' : 'assistant', text: i % 3 ? `[cc-slaves] sự kiện cũ #${i + 1}` : `Tin cũ của điều phối #${i + 1}` }));
  const base: Omit<StreamLine, 'seq' | 'ts'>[] = [
    { kind: 'po', text: 'chạy tiếp D2 lot-2, D15 re-review E5g sau khi E5f fix xong' },
    { kind: 'assistant', text: 'Đã đọc handoff của hai lane. D2 tiếp B2 group A lot-2 trên pm@; D15 re-review E5g, account tự chọn.' },
    { kind: 'tool_use', tool: 'Bash', text: 'git log --oneline -3 phase2.1' },
    { kind: 'tool_result', text: 'a41c2e7 feat(d2): B2 group A lot-1\n9be03d1 fix(d15): E5f findings\n77f0c12 docs: D2 handoff 2026-11-14' },
    { kind: 'tool_use', tool: 'lane_start', text: 'D15 · brief .local-check/briefs/D15-E5g.md · account: tự chọn → bo24990' },
    { kind: 'tool_result', text: 'ok' },
    { kind: 'engine', text: '[cc-slaves] lane D15 đổi bước: Review · E5g re-review' },
    { kind: 'tool_use', tool: 'lane_message', text: 'D2 · "[Điều phối] chạy integration lot-2 trước khi commit"' },
    { kind: 'po', text: 'ưu tiên D2 trước D15', inTurn: true },
  ];
  return [...old, ...base.map((l, i) => ({ ...l, seq: 601 + i, ts: Date.now() - (base.length - i) * 20_000 }))];
}

/** §4.11b the deck Điều phối (project p1, frames DK*): mockup N1-a's 4 rows; §4.14 N5-e ended session #2 has its own talk;
 *  the expired #1 has none (its transcript is gone). */
/** v2.4 frame DKM: DK7 labels (image, long name cut in the middle, copy, "đã gửi vào lượt đang chạy"), DK12 file gone,
 *  MD14 model change, MD4b a message held for the change. */
const V24_LINES: Omit<StreamLine, 'seq' | 'ts'>[] = [
  { kind: 'po', text: 'Lỗi này từ đâu ra? Số liệu ở file kèm.', att: [{ kind: 'image', name: 'ảnh-142233.png', copy: true },
    { kind: 'file', name: '2026-11-15-cc-slaves-v2.4-model-attach-design.md' }, { kind: 'file', name: 'doanh-thu.xlsx' }] },
  { kind: 'assistant', text: 'Lỗi từ dòng trống cuối file lot-2; đã nhắn D2 sửa parser.' },
  { kind: 'po', text: 'Ghi chú hôm qua đây.', att: [{ kind: 'file', name: 'ghi-chú.md', copy: true }] },
  { kind: 'tool_use', tool: 'Read', text: 'ghi-chú.md' },
  { kind: 'po', text: 'Còn màn này nữa.', inTurn: true, att: [{ kind: 'image', name: 'ảnh-142702.png', copy: true }] },
  { kind: 'po', text: 'So với số tuần trước giúp anh.', att: [{ kind: 'image', name: 'ảnh-091512.png', copy: true }, { kind: 'file', name: 'doanh-thu.xlsx' }] },
  { kind: 'engine', text: 'Không gửi được doanh-thu.xlsx: file không còn trên máy.' },
  { kind: 'engine', text: 'Đổi model: Fable 5.2 → Sonnet 5.5 · effort: high → max' },
  { kind: 'po', text: 'Xong lượt này thì review lại lot-2.', afterModelChange: true },
];

export function deckOrchHistory(sessionId: string | null): StreamLine[] {
  const base: Omit<StreamLine, 'seq' | 'ts'>[] = sessionId === 's1' ? [] : sessionId === 'sm' ? V24_LINES : sessionId === 's2' ? [
    { kind: 'tool_use', tool: 'lane_message', text: 'D9 · "review lot-2 sau khi D7 xong"' },
    { kind: 'assistant', text: 'D7 xong phần parser; còn merge. Ghi vào handoff để phiên sau làm tiếp.' },
  ] : [
    { kind: 'tool_use', tool: 'Read', text: 'docs/HANDOFF.md' },
    { kind: 'assistant', text: 'Đã giao D2 port parser lot-2; B2 đang chạy gate e2e.' },
    { kind: 'tool_use', tool: 'lane_message', text: 'D2 · "chạy integration lot-2 trước khi commit"' },
    { kind: 'assistant', text: 'D15 đang hỏi PO về API cũ — chờ PO trả lời ở thẻ phía trên.' },
  ];
  return base.map((l, i) => ({ ...l, seq: i + 1, ts: Date.now() - (base.length - i) * 40_000 }));
}

export function laneHistory(name: string): StreamLine[] {
  const base: Omit<StreamLine, 'seq' | 'ts'>[] = name === 'D2' ? [
    { kind: 'engine', text: '[cc-slaves] D2 · session 41ac…9e · pm@ · lượt 214' },
    { kind: 'engine', text: '[Điều phối → D2] chạy integration lot-2 trước khi commit' },
    { kind: 'assistant', text: 'Đã nhận. Chạy 2 file integration lot-2 trước, xong mới commit Task 3.' },
    { kind: 'tool_use', tool: 'Bash', text: 'npx vitest run tests/integration/base-lot2' }, { kind: 'tool_result', text: '✓ 14 passed' },
    { kind: 'po', text: 'nhớ giữ migration 105 tách 2 release' },
    { kind: 'assistant', text: 'Rõ — 105 tách 2 release theo docs/operations.md. Em ghi vào handoff của D2.' },
    { kind: 'tool_use', tool: 'Edit', text: 'src/base/lot2/serialize.ts (+9 −2)' },
  ] : [{ kind: 'engine', text: `[cc-slaves] ${name} · bo24990 · lượt 96` }];
  return base.map((l, i) => ({ ...l, seq: i + 1, ts: Date.now() - (base.length - i) * 30_000 }));
}

export const ORCH_STREAM = 'D2 đang ở Code: typecheck xanh, còn 2 file integration của lot-2. D15 vừa nhận brief re-review, ước chừng 20 phút. Em sẽ báo khi có lane cần anh quyết.';

/** F1 setup states (spec §6.1): F1a nothing installed · F1b Claude Code installing · F1c–e Claude Code installed, 3/5 logged in. */
function setupFor(f: string): SetupStatus {
  const none = f === 'F1a' || f === 'F1b';
  const rows: [string, boolean][] = [['bo@example.org', true], ['pm@example.net', true], ['bo24990@example.com', true], ['dev2609@example.com', false], ['ba@example.net', false]];
  return {
    claude: none ? { found: false, path: null, version: null, ok: false } : { found: true, path: '~/.local/bin/claude', version: '2.1.325', ok: true },
    accounts: none ? [] : rows.map(([email, loggedIn]) => ({ email, loggedIn })),
    poEmail: null, done: false, git: GIT_SETUP.ok,
  };
}

const NO_ID = { name: null, email: null };
const ID = { name: 'Bill Pham', email: 'bo@example.org' };
/** hf1116 (b) the Git block states (`?f=F1c&gs=<scene>`, Cài đặt › Git, the Git tab). */
export const GIT_SETUP = {
  ok: { state: 'ok', version: '2.54.0', detail: null, identity: ID, gh: 'ok', ghUser: 'po', ghLogin: null },
  fresh: { state: 'ok', version: '2.54.0', detail: null, identity: NO_ID, gh: 'logged_out', ghUser: null, ghLogin: null },
  nogh: { state: 'ok', version: '2.54.0', detail: null, identity: ID, gh: 'missing', ghUser: null, ghLogin: null },
  ghwait: { state: 'ok', version: '2.54.0', detail: null, identity: ID, gh: 'logged_out', ghUser: null, ghLogin: { state: 'waiting', code: '3E86-1480', url: 'https://github.com/login/device', detail: null } },
  missing: { state: 'missing', version: null, detail: null, identity: NO_ID, gh: 'missing', ghUser: null, ghLogin: null },
  license: { state: 'license', version: null, detail: null, identity: NO_ID, gh: 'logged_out', ghUser: null, ghLogin: null },
} as const satisfies Record<string, GitSetup>;
export type GitSetupScene = keyof typeof GIT_SETUP;
/** The scene's git state on the frame's setup (a frame with no wizard gets a done setup: Cài đặt › Git, the Git tab). */
export function withGitSetup(s: Snapshot, scene: GitSetupScene): void {
  s.setup = { ...(s.setup ?? { ...setupFor('F1c'), done: true }), git: structuredClone(GIT_SETUP[scene]) };
}

export const INSTALL_LOG: Record<string, string[]> = {
  claude: ['$ curl -fsSL https://claude.ai/install.sh | bash', 'Downloading claude 2.1.325 (58.4 MB)... 100.0%', 'Verifying checksum... ok', 'Installing to /Users/po/.local/bin/claude', '✓ Claude Code 2.1.325 installed'],
  ccswitch: ['GitHub Releases farion1231/cc-switch → CC-Switch_4.0.23_universal.dmg', 'Đang tải… 100%', 'codesign --verify: hợp lệ · Team ID R8UR22V2F9 (đúng Team ID ghim)', 'Chép vào /Applications/CC Switch.app', '✓ CC Switch 4.0.23 đã cài'],
  claude_update: ['$ claude update', 'Updating to 2.1.330…', '✓ updated'],
};

/** F25: D2's subagents (spawn order) and one subagent's activity. */
export const SUBS: SubagentView[] = [
  { taskId: 's1', toolUseId: 'tu-s1', description: 'Rà lỗi integration lot-2', subagentType: 'reviewer-high', background: false, status: 'running', totalTokens: 41200, toolUses: 12, lastTool: 'Bash' },
  { taskId: 's2', toolUseId: 'tu-s2', description: 'Tìm chỗ dùng phase_note', subagentType: 'Explore', background: true, status: 'completed', totalTokens: 9800, toolUses: 6, lastTool: 'Grep' },
  { taskId: 's3', toolUseId: 'tu-s3', description: 'Viết test serialize', subagentType: 'coder-medium', background: false, status: 'completed', totalTokens: 22100, toolUses: 9, lastTool: 'Edit' },
];
/** v2.1 §5.3 dev deck: the subagents of every running lane (the engine sends them to the local app). */
export const DECK_SUBS: Record<string, SubagentView[]> = {
  D2: [
    { taskId: 'd2a', toolUseId: 'tu-d2a', description: 'Chạy lại integration lot-2', subagentType: 'tests', background: false, status: 'running', totalTokens: 42_000, toolUses: 12, lastTool: 'Bash', endedAt: null },
    { taskId: 'd2b', toolUseId: 'tu-d2b', description: 'Rà diff lot-2', subagentType: 'review', background: false, status: 'running', totalTokens: 18_000, toolUses: 7, lastTool: 'Read', endedAt: null },
    { taskId: 'd2c', toolUseId: 'tu-d2c', description: 'Tìm chỗ dùng phase_note', subagentType: 'explore', background: true, status: 'completed', totalTokens: 9_000, toolUses: 6, lastTool: 'Grep', endedAt: Date.now() + 10 * 60_000 },
  ],
  B2: [
    { taskId: 'b2a', toolUseId: 'tu-b2a', description: 'e2e nhóm A', subagentType: 'e2e-a', background: false, status: 'running', totalTokens: 31_000, toolUses: 9, lastTool: 'Bash', endedAt: null },
    { taskId: 'b2b', toolUseId: 'tu-b2b', description: 'e2e nhóm B', subagentType: 'e2e-b', background: false, status: 'failed', totalTokens: 27_000, toolUses: 8, lastTool: 'Bash', endedAt: Date.now() },
  ],
};
export function subHistory(taskId: string): StreamLine[] {
  const s = SUBS.find(x => x.taskId === taskId);
  const base: Omit<StreamLine, 'seq' | 'ts'>[] = [
    { kind: 'subagent', text: `Prompt: ${s?.description ?? taskId} — đọc tests/integration/base-lot2.test.ts, chạy lại, báo nguyên nhân.` },
    { kind: 'tool_use', tool: 'Read', text: 'tests/integration/base-lot2.test.ts' }, { kind: 'tool_result', text: '212 dòng' },
    { kind: 'tool_use', tool: 'Bash', text: 'npx vitest run tests/integration/base-lot2' }, { kind: 'tool_result', text: '✗ 1 failed: phase_note default' },
    { kind: 'assistant', text: s?.status === 'running' ? 'Lỗi do default của phase_note là NULL; đang kiểm migration 105…' : 'Xong: default phase_note phải là chuỗi rỗng; đã sửa migration 105.' },
  ];
  return base.map((l, i) => ({ ...l, seq: 900 + i, ts: Date.now() - (base.length - i) * 15_000, parentToolUseId: s?.toolUseId ?? null }));
}

/** N-e: tokens that agree with a cost (~130k shown tok per $, like the mockup's "412k tok ≈ $3,18"). */
const spent = (usd: number): TokenCounts => {
  const shown = Math.round(usd * 130_000);
  return { input: Math.round(shown * 0.1), output: Math.round(shown * 0.25), cacheWrite: Math.round(shown * 0.65), cacheRead: shown * 5 };
};
const noTokens = (t: TokenCounts | null | undefined) => !t || t.input + t.output + t.cacheWrite + t.cacheRead === 0;

/** §5.3 the deck frames reuse the unit-test seed (`updatedAt: 1`, `turnStartedAt: 1000 + i`, accounts `fetchedAt: 1` with no
 *  reset times): stamp real ms times on lanes and accounts (I1-mock), and give every paid lane / Điều phối its tokens (N-e). */
function liveTimes(s: Snapshot): Snapshot {
  const now = Date.now();
  s.lanes.forEach((l, i) => {
    if (l.updatedAt < 1e12) l.updatedAt = now - (i + 1) * 7 * M;
    if (l.turnStartedAt !== null && l.turnStartedAt < 1e12) l.turnStartedAt = now - (25 + i * 13) * 1000;
  });
  s.accounts.forEach((a, i) => {
    if ((a.fetchedAt ?? 0) < 1e12) a.fetchedAt = now - 2 * M;
    if (a.weekResetsAt === null || a.weekResetsAt < 1e12 || a.weekResetsAt <= now) a.weekResetsAt = now + (1 + i % 6) * 24 * H + 5 * H;
    if (a.fiveResetsAt === null || a.fiveResetsAt < 1e12 || a.fiveResetsAt <= now) a.fiveResetsAt = now + (1 + i % 4) * H;
  });
  for (const x of [...s.lanes, ...s.orchestrators]) if (x.costUsd > 0 && noTokens(x.tokens)) x.tokens = spent(x.costUsd);
  for (const c of s.cards) if (c.createdAt < 1e12) c.createdAt = now - 2 * M; // m-4 a seed card (D15 asks) came in ≈ 2 min ago
  return s;
}

function deckFrame(f: Frame, channel: 'mac' | 'remote'): Snapshot {
  if (f === 'DK0') { const s = scene(5, []); s.orchestrators[0]!.state = 'idle'; return { ...s, cards: [], channel }; }
  if (f === 'DKF') { // §4.6 "Mọi account đầy": every column empty orange, lanes wait for quota, orchestrator waits too
    const s = scene(5);
    for (const a of s.accounts) Object.assign(a, { full: true, headroomPct: 0, weekResetsAt: Date.now() + 20 * H });
    for (const l of s.lanes) if (l.state === 'running' || l.state === 'starting') l.state = 'waiting_quota';
    s.orchestrators[0]!.state = 'waiting_quota';
    return { ...s, channel };
  }
  if (f === 'DK30P') { // CR-M4: DK30 + a second project, to switch project with the F9 side panel open
    const s = scene(30), p0 = s.projects[0]!;
    s.projects.push({ ...p0, id: 'p2', name: 'cc-slaves', path: '/w/cc-slaves' });
    s.orchestrators.push({ ...s.orchestrators[0]!, projectId: 'p2', state: 'idle', talkingTo: null });
    return { ...s, channel };
  }
  if (f === 'DKS') { // v2.1 §4.14 N5-c two running sessions (#3, #4 · hotfix), each owning its lanes; history has #1, #2
    const s = scene(5), o = s.orchestrators[0]!;
    Object.assign(o, { sessionId: 's3', seq: 3, title: null, talkingTo: 'D2' });
    s.orchestrators.push({ ...o, sessionId: 's4', seq: 4, title: 'hotfix', account: s.accounts[2]!.email, homeAccount: s.accounts[2]!.email, talkingTo: null, contextPct: 18 });
    s.lanes.forEach((l, i) => { l.ownerSession = i % 3 === 2 ? 's4' : 's3'; l.ownerSeq = i % 3 === 2 ? 4 : 3; });
    s.cards.forEach((c, i) => { c.sessionId = i % 2 ? 's4' : 's3'; c.seq = i % 2 ? 4 : 3; });
    return { ...s, channel };
  }
  if (f === 'DKX') return doneFrame(channel);
  if (f === 'DKXN') { const s = doneFrame(channel); return { ...s, lanes: s.lanes.filter(l => l.state === 'done'), orchestrators: s.orchestrators.slice(0, 1), cards: [] }; }
  if (f === 'DKC') return { ...scene(5), cards: cpCards(), channel };
  if (f === 'DKM') { const s = deckFrame('DK5', channel); Object.assign(s.orchestrators[0]!, { sessionId: 'sm', seq: 3 }); return s; }
  if (f === 'DKN') return { ...scene(5, crowd(30, 25)), channel }; // 25 lanes in Hàng chờ → 21 small discs + "+4"
  const n = Number(/\d+/.exec(f)![0]), s = scene(n, f.endsWith('L') ? [...BASE, ...EXTRA] : BASE);
  s.orchestrators[0]!.talkingTo = 'D2';
  // v2.1 §5.3 tokens (the engine always sends them; the test seed predates them)
  s.lanes.forEach((l, i) => { l.tokens = { input: 20_000 + i * 7_000, output: 30_000 + i * 9_000, cacheWrite: 90_000 + i * 31_000, cacheRead: 900_000 + i * 140_000 }; l.costUsd = 0.7 + i * 0.41; });
  s.orchestrators[0]!.tokens = { input: 120_000, output: 260_000, cacheWrite: 720_000, cacheRead: 6_100_000 };
  s.orchestrators[0]!.costUsd = 8.3;
  // v2.1 §4.2 M1 R5 Hỏng: the exit reason on its node line, and the engine's broken card (source null, key lane:R5) in Chờ PO
  const r5 = s.lanes.find(l => l.name === 'R5');
  if (r5) {
    // m-4 the node's exit time and its card's time are one event on one clock
    const exit = Date.now() - 6 * M;
    Object.assign(r5, { failCount: 1, updatedAt: exit, lastError: `exit 1 lúc ${fmtHm(exit)}` });
    s.cards.push(ask({ kind: 'broken', projectId: 'p1', source: null, key: 'lane:R5', createdAt: exit, ...keyed('cards.laneBroken', { name: 'R5' }), context: 'exit 1 · npm run test:unit',
      actions: [{ id: 'lane_resume', label: 'Chạy lại', labelKey: 'cardText.act.resume' }, { id: 'view_log', label: 'Xem log', labelKey: 'cardText.act.viewLog' },
        { id: 'hand_to_orchestrator', label: 'Giao điều phối xử lý', labelKey: 'cardText.act.handToOrch' }] }));
  }
  // v2.1 §4.15 the done lanes carry a measured branch (E4 / E1 unmerged), and the header's "n chưa merge" counts them (M13)
  s.lanes.filter(l => l.state === 'done').forEach((l, i) => {
    l.branch = { name: `lane/${l.name.toLowerCase()}`, base: 'main', state: i % 2 ? 'merged' : 'unmerged', ahead: i % 2 ? 0 : 2, files: 4, add: 120, del: 9, measuredAt: Date.now() - 4 * M };
  });
  s.projects[0]!.unmerged = unmergedCount(s.lanes);
  s.stats = { at: Date.now(), tokens5h: { input: 0, output: 900_000, cacheWrite: 1_100_000, cacheRead: 0 },
    projects: { [s.projects[0]!.id]: { tokensToday: { input: 300_000, output: 1_400_000, cacheWrite: 2_500_000, cacheRead: 30_000_000 }, costTodayUsd: 38.1 } } };
  return { ...s, channel };
}

/** v2.1 §4.15 §3 `done_lanes_list` like the engine (db.ts listDoneLanes): rows filtered, newest first; total / unmerged / unknown
 *  count every done lane of the project (M4: "Tất cả n" keeps the total under a filter). */
export function doneLanesPage(lanes: LaneView[], c: { query?: string; session?: string; unmerged?: boolean; limit?: number }): DoneLanesPage {
  const q = (c.query ?? '').toLowerCase();
  const rows = lanes.filter(l => (!q || `${l.name} ${l.task ?? ''}`.toLowerCase().includes(q)) && (!c.session || l.ownerSession === c.session)
    && (!c.unmerged || l.branch?.state === 'unmerged' || l.branch?.state === 'unknown'));
  return { lanes: rows.slice(0, c.limit), total: lanes.length, unmerged: unmergedCount(lanes), unknown: lanes.filter(l => l.branch?.state === 'unknown').length, next: null };
}

/** §4.15 the engine's `unmergedCount`: done lanes whose measured branch is unmerged. */
const unmergedCount = (lanes: LaneView[]) => lanes.filter(l => l.state === 'done' && l.branch?.state === 'unmerged').length;

/** v2.1 §4.15 N6-a / N6-c / N6-e / N6-f: three running sessions, 20 lanes, 9 done lanes (measured branches). */
export const DONE_LANES: LaneView[] = [];
function doneFrame(channel: 'mac' | 'remote'): Snapshot {
  const s = scene(5, [...BASE, ...EXTRA]), o = s.orchestrators[0]!, now = Date.now();
  Object.assign(o, { sessionId: 's3', seq: 3, title: null, talkingTo: 'D2' });
  s.orchestrators.push({ ...o, sessionId: 's4', seq: 4, title: 'hotfix', account: s.accounts[2]!.email, homeAccount: s.accounts[2]!.email, talkingTo: null, contextPct: 18 },
    { ...o, sessionId: 's5', seq: 5, title: 'docs', account: s.accounts[1]!.email, homeAccount: s.accounts[1]!.email, talkingTo: null, contextPct: 9 });
  const live = s.lanes.filter(l => l.state !== 'done').slice(0, 20);
  live.forEach((l, i) => { const k = i % 3; l.ownerSession = `s${3 + k}`; l.ownerSeq = 3 + k; });
  // N-c / N6-d: the #4 hotfix tree has an H-lane, so ⌘K "h" finds it by name (and "Mở cây #4" once that tree is collapsed)
  Object.assign(live.find(l => l.name === 'V4')!, { name: 'H4', task: 'sửa lỗi đăng nhập SSO', cwd: '/Users/po/Works/Projects/hagenta-h4' });
  const br = (state: NonNullable<LaneView['branch']>['state'], name: string, ahead = 0, over = {}) =>
    ({ name: `lane/${name.toLowerCase()}`, base: 'main', state, ahead, files: ahead * 3, add: ahead * 85, del: ahead * 14, measuredAt: now - 4 * M, ...over });
  const done = (name: string, h: number, b: NonNullable<LaneView['branch']>, task: string, seq = 3): LaneView => ({
    ...live[0]!, name, state: 'done', phase: 'done', task, note: null, ownerSession: `s${seq}`, ownerSeq: seq, updatedAt: now - h * H, branch: b,
    worktreeExists: h < 30, cwd: `/Users/po/Works/Projects/hagenta-${name.toLowerCase()}`, openCards: [], turnStartedAt: null });
  DONE_LANES.length = 0;
  DONE_LANES.push(done('M11', 1, br('unmerged', 'M11', 4), 'group C lot-2'), done('M2', 2, br('merged', 'M2', 0, { pr: { number: 415, state: 'merged' } }), 'parser lot-1', 4),
    done('M1', 3, br('unknown', 'M1', 0, { reason: 'repo đang khoá' }), 'docs index', 5), done('M7', 5, br('unmerged', 'M7', 2), 'tests lot-3'),
    done('M4', 26, br('merged', 'M4'), 'ui fix', 4), done('M9', 30, br('gone', 'M9'), 'spike', 3), done('M12', 50, br('none', 'M12'), 'audit', 5),
    done('M5', 75, br('merged', 'M5'), 'migrate', 3), done('M3', 9 * 24, br('merged', 'M3'), 'old lane', 4));
  s.lanes = [...live, ...DONE_LANES.filter(l => now - l.updatedAt < 7 * 24 * H)];
  s.projects[0]!.unmerged = unmergedCount(s.lanes);
  // §4.14 I9 a lane's card carries its owner session's #n (the engine: `cardSeq`)
  s.cards.forEach(c => { const l = s.lanes.find(x => x.name === c.source); if (l) { c.seq = l.ownerSeq ?? null; c.sessionId = l.ownerSession ?? null; } });
  return { ...s, channel };
}
