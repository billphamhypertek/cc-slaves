// v2.7 dev scene (spec §4–§6, mockup docs/specs/assets/2026-11-16-cc-slaves-v2.7-tasks.html): hagenta with specs in every
// lifecycle group and issues in every block / state the IS frames show — v2.5 active 8/13 (T-42…T-54, B-50 unseen), the
// outside-spec group, done specs (v2.4 18/18 …), v2.6 / v2.9 waiting to build, v2.8 in design — plus the lanes holding them.
// Frames are named after the mockup ids (`?f=IS2`); per-frame variations live in `issuesFrame`. Times are "now"-relative
// to the mockup's 14:32.
import type { IssueInfo, ProjectIssues, SpecInfo } from '../../shared/issues.ts';
import { progressOf } from '../../shared/issues.ts';
import { MOCK_PO_REV } from './wf-mock.ts';
import type { LaneView, Snapshot } from '../../shared/protocol.ts';

const M = 60_000, H = 60 * M, D = 24 * H;
export const IS_FRAMES = ['IS1', 'IS2', 'IS3', 'IS3b', 'IS4a', 'IS4b', 'IS4c', 'IS5', 'IS5b', 'IS6', 'IS7', 'IS8', 'IS8b', 'IS8c', 'IS9',
  'IS10', 'IS10b', 'IS10c', 'IS11', 'IS12', 'IS13', 'IS13b', 'IS14', 'IS15', 'IS16', 'IS17', 'IS18', 'IS19', 'IS20', 'IS21', 'IS21b',
  'IS22', 'IS22b'] as const;
export type IsFrame = (typeof IS_FRAMES)[number];
export const isIsFrame = (f: string): f is IsFrame => (IS_FRAMES as readonly string[]).includes(f);

const PID = 'hagenta';
/** the mockup's 14:32 is "now": `at(14, 12)` = 20 minutes ago */
const at = (h: number, m: number, day = 0) => Date.now() - ((14 * 60 + 32) - (h * 60 + m)) * M - day * D;

type SpecSeed = Partial<SpecInfo> & Pick<SpecInfo, 'id' | 'title' | 'state'>;
const specOf = (x: SpecSeed): SpecInfo => ({
  projectId: PID, path: `docs/specs/${x.state === 'done' ? 'done/' : ''}2026-11-${String(x.id).padStart(2, '0')}-${x.title.split(' ')[0]!.toLowerCase()}.md`,
  after: null, branch: null, sessions: { design: null, build: null, edit: null }, origin: 'app', outsideBuild: false, resumed: false, amendRev: 0,
  missing: false, groups: null, editing: false, progress: { done: 0, total: 0, scope: 0, cancelled: 0, amend: 0 }, approvedAt: null, openedAt: null,
  doneAt: null, createdAt: at(9, 0, 30 - x.id), overview: null,
  workflowRev: MOCK_PO_REV, step: x.state === 'done' ? null : x.state === 'active' ? 'build' : 'design', ...x,
});

type IssueSeed = Partial<IssueInfo> & { key: string; title: string };
let nextId = 1;
const issueOf = (specId: number | null, x: IssueSeed): IssueInfo => ({
  id: nextId++, projectId: PID, kind: x.key.startsWith('B-') ? 'bug' : 'task', specId, body: '', doneWhen: [], state: 'todo', revert: 'none',
  priority: specId === null, blockedBy: [], waitingOn: [], blocks: [], lane: null, commits: [], source: 'spec', sourceLane: null, sourceIssue: null,
  reverts: null, poSeen: true, poOk: false, cancelReason: null, files: [], events: [], createdAt: at(14, 5), doneAt: null, ...x,
});
const sha = (seed: number, i: number) => ((seed * 2654435761 + i * 40503) >>> 0).toString(16).padStart(8, '0').slice(0, 7);
const commits = (seed: number, n: number, branch: string | null = 'main', t = at(13, 0)) =>
  Array.from({ length: n }, (_, i) => ({ sha: sha(seed, i), branch, at: t - i * 7 * M }));
const done = (specId: number | null, key: string, title: string, n: number, t: number, over: Partial<IssueInfo> = {}) =>
  issueOf(specId, { key, title, state: 'done', commits: commits(Number(key.slice(2)), n, 'main', t), doneAt: t, createdAt: t - 2 * H, ...over });

/** IS2 v2.5 (spec 4): 13 issues (8 done, B-50 + T-53 extra scope) + T-37 cancelled. */
function v25(): IssueInfo[] {
  return [
    issueOf(4, { key: 'T-47', title: 'G4 · Màn Graph code: danh sách index + nút Dừng', state: 'doing', lane: { name: 'D2', state: 'running', phase: 'code' }, blocks: ['T-49'],
      commits: commits(47, 2, 'lane/d2', at(14, 29)), body: 'Màn Graph trong Bộ công cụ: liệt kê các repo đã index (tên, số file, lúc index xong), và nút **Dừng** cho lượt index đang chạy.',
      doneWhen: ['Danh sách đọc từ cbm, đúng thứ tự mới nhất trước', 'Dừng huỷ lượt index trong ≤ 2 giây', 'Test e2e của màn Graph xanh'],
      events: [{ ts: at(14, 5), type: 'created', data: { source: 'spec', state: 'todo' } }, { ts: at(14, 12), type: 'taken', data: { lane: 'D2' } }, { ts: at(14, 29), type: 'updated', data: { fields: ['commits'] } }] }),
    issueOf(4, { key: 'B-50', title: 'Daemon CBM không tắt khi đóng app', state: 'doing', priority: true, source: 'lane', sourceLane: 'D2', sourceIssue: 'T-47', poSeen: false,
      lane: { name: 'R5', state: 'running', phase: 'code' }, createdAt: at(14, 21),
      body: 'Đóng app xong, tiến trình CBM vẫn chạy nền và giữ cổng 7420. Lần mở sau báo "cổng đã dùng". D2 ghi: *"thấy khi chạy e2e màn Graph hai lần liên tiếp."*',
      doneWhen: ['Đóng app thì CBM tắt trong ≤ 3 giây', 'Mở lại app không báo cổng đã dùng', 'Có test cho đường đóng app'],
      events: [{ ts: at(14, 21), type: 'created', data: { source: 'lane', state: 'todo' } }, { ts: at(14, 22), type: 'taken', data: { lane: 'R5' } }] }),
    issueOf(4, { key: 'T-48', title: 'G5 · Wizard bước 3: đăng nhập context7', state: 'doing', lane: { name: 'D4', state: 'broken', phase: 'code' }, blocks: ['T-49'] }),
    issueOf(4, { key: 'T-44', title: 'G4 · Màn Graph code: biểu đồ phụ thuộc giữa các file', createdAt: at(14, 7), blocks: ['T-49'] }),
    issueOf(4, { key: 'T-49', title: 'G6 · Final gate + smoke', blockedBy: ['T-44', 'T-47', 'T-48'], waitingOn: ['T-44', 'T-47', 'T-48'] }),
    done(4, 'T-53', 'Wizard bước 2: nhớ lựa chọn MCP khi quay lại', 2, at(14, 18), { source: 'lane', sourceLane: 'D2', sourceIssue: 'T-46' }),
    done(4, 'T-46', 'G3 · Wizard bước 2: chọn MCP cần đăng nhập', 3, at(13, 40), { blocks: ['T-49', 'T-53'] }),
    done(4, 'T-45', 'G2 · Engine: lệnh dừng index + sự kiện tiến độ', 5, at(12, 50)),
    done(4, 'T-43', 'G2 · Wizard bước 1: chọn repo cần index', 3, at(12, 10)),
    done(4, 'T-42', 'G1 · Bảng index trong state.db', 2, at(11, 30)),
    done(4, 'T-41', 'G1 · Đọc danh sách repo từ cbm', 2, at(11, 0)),
    done(4, 'T-40', 'G0 · Đo thời gian index repo 2.000 file', 1, at(10, 30)),
    done(4, 'T-39', 'G0 · Khung màn Bộ công cụ', 2, at(10, 0)),
    issueOf(4, { key: 'T-37', title: 'G0 · So sánh cbm với ctags', state: 'cancelled', cancelReason: 'cbm đủ dùng, không cần ctags', doneAt: at(16, 0, 2), createdAt: at(9, 0, 2) }),
  ];
}

/** IS6 outside any spec: 4 open (every one priority, one lane per issue) + 14 done. */
function outside(): IssueInfo[] {
  const old = [20, 21, 22, 23, 24, 25, 26, 27, 28].map((n, i) => done(null, `B-${n}`, `Lỗi nhỏ đã sửa #${n}`, 1, at(10, 0, 3 + i)));
  return [
    issueOf(null, { key: 'B-52', title: 'Âm báo kêu hai lần khi lane xong', state: 'doing', source: 'po', lane: { name: 'F1', state: 'running', phase: 'code' }, commits: commits(52, 2, 'fix-b52', at(14, 20)) }),
    issueOf(null, { key: 'B-12', title: 'Tắt tiếng project vẫn còn âm cảnh báo quota', state: 'doing', source: 'po', lane: { name: 'B3', state: 'waiting_po', phase: 'code' } }),
    issueOf(null, { key: 'T-36', title: 'Cập nhật ảnh README cho bản phát hành', state: 'doing', source: 'po', lane: { name: 'C1', state: 'waiting_quota', phase: 'code' }, commits: commits(36, 1, 'fix-t36') }),
    issueOf(null, { key: 'B-51', title: 'Kéo tab project bị giật', source: 'po', createdAt: at(14, 28), files: [{ id: 1, name: 'tab-giat.png', size: 184_220 }] }),
    done(null, 'B-35', 'Thẻ Chờ PO nhấp nháy khi đổi project', 1, at(13, 50)),
    done(null, 'B-34', 'Ô nhắn mất chữ đang gõ khi lane xong', 2, at(13, 10)),
    done(null, 'T-33', 'Đổi thư mục log sang ~/.cc-slaves/logs', 1, at(12, 0)),
    done(null, 'B-32', 'Chip account hiện sai sau khi đăng nhập lại', 3, at(10, 40)),
    done(null, 'B-31', 'Cài lại app làm mất cột trái đã thu gọn', 1, at(9, 30)),
    ...old,
  ];
}

/** Done specs: every issue done (n commits), v2.4 shows T-15…T-19 on top and one cancelled. */
function doneSpec(specId: number, from: number, n: number, day: number): IssueInfo[] {
  return Array.from({ length: n }, (_, i) => done(specId, `T-${from + i}`, `Mục ${from + i}`, 1 + (i % 3), at(17, 0, day) - (n - i) * 20 * M));
}
function v24(): IssueInfo[] {
  const named = [['T-15', 'A4 · Hộp chi tiết Chờ PO', 4], ['T-16', 'A4 · Phím ⌥1–⌥9 cho phương án', 1], ['T-17', 'A4 · Hoàn tác 5 giây cho phương án đã chọn', 2],
    ['T-18', 'A5 · Review nhóm A1–A4', 1], ['T-19', 'G · Final gate + smoke', 2]] as const;
  return [...doneSpec(5, 2, 13, 3), ...named.map(([k, t, c], i) => done(5, k, t, c, at(17, 5, 3) + i * M)),
    issueOf(5, { key: 'T-1', title: 'A0 · Thử thư viện chip mới', state: 'cancelled', doneAt: at(10, 0, 4), cancelReason: 'giữ chip cũ' })];
}

const DONE_SPECS: [number, string, number, number][] = [ // id, title, issues, finished n days ago
  [6, 'v2.3 Code + Git', 26, 4], [7, 'v2.2 Skills & MCP', 31, 6], [8, 'v2.1 Node graph', 52, 8], [9, 'v2 Accounts', 38, 10], [10, 'v1.1 Deck', 24, 12], [11, 'v1 Engine', 40, 14],
];

/** IS19 (the mockup's 16:10, here before "now"): T-47 done, D2 on T-44, D4 running again; the "Bổ sung yêu cầu" round rev 2 added T-55…T-57, T-49 waits on
 *  them; v2.5 is being amended by the Thiết kế session `s-edit` (the Deck scene's node). */
function amendRound(issues: IssueInfo[], v: SpecInfo): IssueInfo[] {
  const amend = ([['T-55', 'G4b · Lọc danh sách index theo ngôn ngữ'], ['T-56', 'G4b · Ô tìm trong danh sách index'], ['T-57', 'G6 · e2e cho lọc + tìm trên màn Graph']] as const)
    .map(([key, title], i) => issueOf(4, { key, title, source: 'amend', createdAt: at(14, 22 + i), blocks: ['T-49'] }));
  const wait = ['T-44', 'T-48', ...amend.map(i => i.key)];
  const out = issues.map(i => i.key === 'T-47' ? { ...i, state: 'done' as const, lane: { name: 'D2', state: 'done', phase: 'done' }, commits: commits(47, 4, 'main', at(14, 15)), doneAt: at(14, 15) }
    : i.key === 'T-44' ? { ...i, state: 'doing' as const, lane: { name: 'D2', state: 'running', phase: 'code' } }
    : i.key === 'T-48' ? { ...i, lane: { name: 'D4', state: 'running', phase: 'code' } }
    : i.key === 'T-49' ? { ...i, blockedBy: wait, waitingOn: wait } : i);
  Object.assign(v, { editing: true, amendRev: 2, sessions: { design: null, build: 's-v25', edit: 's-edit' } });
  if (v.overview) v.overview = { ...v.overview, lastAmend: { rev: 2, issueCount: amend.length, at: at(14, 24) },
    lanes: [{ name: 'D2', key: 'T-44', state: 'running', phase: 'code' }, { name: 'R5', key: 'B-50', state: 'running', phase: 'code' }, { name: 'D4', key: 'T-48', state: 'running', phase: 'code' }] };
  return [...out, ...amend];
}

/** The ProjectIssues of hagenta for frame `f`. */
function hagentaIssues(f: IsFrame): ProjectIssues {
  nextId = 1;
  let issues = [...v25(), ...outside(), ...v24()];
  let from = 200;
  for (const [id, , n] of DONE_SPECS) { issues.push(...doneSpec(id, from, n, DONE_SPECS.find(x => x[0] === id)![3])); from += n; }
  const specs: SpecInfo[] = [
    specOf({ id: 1, title: 'v2.8 Thông báo điện thoại', state: 'draft', sessions: { design: 's-v28', build: null, edit: null }, createdAt: at(10, 0) }),
    specOf({ id: 2, title: 'v2.6 Updater', state: 'approved', groups: '7 nhóm · G0–G6', approvedAt: at(18, 0, 1), branch: 'v26' }),
    specOf({ id: 3, title: 'v2.9 Code graph', state: 'approved', groups: '5 nhóm · G0–G4', approvedAt: at(9, 30), after: { id: 4, path: 'docs/specs/2026-11-04-v2.5.md', title: 'v2.5 Toolkit graph', state: 'active' } }),
    specOf({ id: 4, title: 'v2.5 Toolkit graph', state: 'active', branch: 'v25', sessions: { design: null, build: 's-v25', edit: null }, approvedAt: at(13, 50), openedAt: at(14, 2),
      overview: { buildSession: { id: 's-v25', title: 'Build · v2.5', state: 'running' }, lanes: [{ name: 'D2', key: 'T-47', state: 'running', phase: 'code' }, { name: 'R5', key: 'B-50', state: 'running', phase: 'code' }, { name: 'D4', key: 'T-48', state: 'broken', phase: 'code' }],
        lastAmend: null, commits: 21, mergedInto: null } }),
    specOf({ id: 5, title: 'v2.4 Model + attach', state: 'done', approvedAt: at(14, 2, 4), openedAt: at(14, 2, 4), doneAt: at(18, 30, 3), branch: 'v24',
      overview: { buildSession: { id: 's-v24', title: 'Build · v2.4', state: 'closed' }, lanes: [], lastAmend: null, commits: 34, mergedInto: 'main' } }),
    ...DONE_SPECS.map(([id, title, , day]) => specOf({ id, title, state: 'done', doneAt: at(17, 0, day), approvedAt: at(9, 0, day + 2), openedAt: at(10, 0, day + 2) })),
  ];
  if (f === 'IS3b') issues = issues.map(i => (i.key === 'T-53' ? { ...i, poSeen: false } : i));
  if (f === 'IS5' || f === 'IS5b') { // §5.7-4 T-46 cancelled by the PO: T-54 reverts it (IS5 running, IS5b hit T-53)
    const conflict = f === 'IS5b';
    issues = issues.map(i => (i.key !== 'T-46' ? i : { ...i, revert: conflict ? 'conflict' : 'running', cancelReason: 'bước 2 thừa, gộp vào bước 3', lane: { name: 'D2', state: 'done', phase: 'done' },
      body: 'Bước 2 của wizard: liệt kê MCP cần đăng nhập, cho chọn cái nào đăng nhập ngay.', doneWhen: ['Danh sách MCP lấy từ cấu hình chung', 'Bỏ qua được từng MCP', 'Test e2e wizard xanh'],
      events: [{ ts: at(12, 20), type: 'taken', data: { lane: 'D2' } }, { ts: at(13, 40), type: 'done', data: { commits: ['9c1e2fa', '41b7d03', 'd88a6e1'] } },
        { ts: at(14, 33), type: 'cancelled', data: { by: 'po', reason: 'bước 2 thừa, gộp vào bước 3' } }, { ts: at(14, 34), type: 'revert', data: { to: 'running' } },
        ...(conflict ? [{ ts: at(14, 41), type: 'revert', data: { to: 'conflict' } }] : [])] }));
    issues.push(issueOf(4, { key: 'T-54', title: 'Hoàn tác T-46', reverts: 'T-46', source: 'po', priority: true, createdAt: at(14, 34),
      ...(conflict ? { state: 'cancelled', doneAt: at(14, 41), lane: { name: 'R6', state: 'done', phase: 'done' } } : { state: 'doing', lane: { name: 'R6', state: 'running', phase: 'code' } }) }));
  }
  if (f === 'IS16' || f === 'IS17') { // the first open, before v2.5 was ever built in cc-slaves: imported, "đang build dở"
    const v = specs.find(s => s.id === 4)!;
    Object.assign(v, { state: 'approved', origin: 'imported', outsideBuild: true, sessions: { design: null, build: null, edit: null }, openedAt: null, overview: null });
    const doneIds = new Set(specs.filter(s => s.state === 'done').map(s => s.id)); // the scan skips finished specs; nothing outside yet
    issues = issues.filter(i => i.specId !== 4 && i.specId !== null && !doneIds.has(i.specId));
    specs.splice(0, specs.length, ...specs.filter(s => !doneIds.has(s.id)));
  }
  const sp = (id: number) => specs.find(x => x.id === id)!;
  if (f === 'IS18') { // v2.6 being edited in a Thiết kế session; v2.9's file gone
    Object.assign(sp(2), { editing: true, origin: 'imported', sessions: { design: null, build: null, edit: 's-edit26' } });
    Object.assign(sp(3), { missing: true, origin: 'imported' });
  }
  if (f === 'IS15' || f === 'IS13b' || f === 'IS17') Object.assign(sp(2), { origin: 'imported' });
  if (f === 'IS13b') Object.assign(sp(3), { editing: true, sessions: { design: null, build: null, edit: 's-edit29' } }); // "Sửa v2.9" (R34 cap)
  if (f === 'IS19') issues = amendRound(issues, sp(4));
  for (const s of specs) if (s.origin === 'imported') s.approvedAt = null; // §4.8 "trước khi nhập (theo dòng trạng thái)"
  for (const s of specs) {
    s.progress = progressOf(issues.filter(i => i.specId === s.id));
    if (s.state !== 'active' && s.state !== 'done') s.overview = null;
  }
  return { projectId: PID, specs, issues, outside: progressOf(issues.filter(i => i.specId === null)) };
}

/** The lanes holding the issues above (the Deck traces of G5 read them). */
function issueLanes(base: LaneView, f: IsFrame): LaneView[] {
  const l = (name: string, state: LaneView['state'], task: string, note: string): LaneView =>
    ({ ...base, name, state, task, note, phase: 'code', cwd: `/Users/po/Works/Projects/hagenta-${name.toLowerCase()}`, openCards: [], failCount: state === 'broken' ? 3 : 0,
      lastError: state === 'broken' ? 'API Error: 529 overloaded_error' : null });
  return [l('D4', f === 'IS19' ? 'running' : 'broken', 'T-48', 'hỏng'), l('R5', 'running', 'B-50', 'đóng CBM'), l('F1', 'running', 'B-52', 'âm báo'), l('B3', 'waiting_po', 'B-12', 'hỏi PO'),
    l('C1', 'waiting_quota', 'T-36', 'chờ quota')];
}

/** Apply frame `f` to the base (F3) snapshot: issues on the Mac channel, the extra lanes; IS8 = an empty project first;
 *  IS8b = no data for hagenta yet (the mock never answers its `spec_scan`). */
export function issuesFrame(s: Snapshot, f: IsFrame): Snapshot {
  if (s.channel !== 'mac') return s;
  if (f === 'IS8') {
    s.projects = [s.projects[1]!, s.projects[0]!]; // cc-slaves opens first, with nothing in it
    s.issues = [{ projectId: 'cc-slaves', specs: [], issues: [], outside: progressOf([]) }, hagentaIssues('IS2')];
    return s;
  }
  const d2 = s.lanes.find(l => l.name === 'D2');
  if (d2) Object.assign(d2, { task: f === 'IS19' ? 'T-44' : 'T-47', note: 'màn Graph' });
  if (d2) s.lanes.push(...issueLanes(d2, f));
  s.issues = f === 'IS8b' ? [] : [hagentaIssues(f), { projectId: 'cc-slaves', specs: [], issues: [], outside: progressOf([]) }];
  if (f === 'IS16') s.projects[0] = { ...s.projects[0]!, specsImported: 4 };
  const o = s.orchestrators.find(x => x.projectId === PID);
  if (o) { // the Thiết kế / Build sessions of hagenta (the Deck frames replace them, deck-scene.ts)
    const kinds: [string, string, 'design' | 'build'][] = [['s-v25', 'Build · v2.5', 'build'], ['s-v28', 'Thiết kế · v2.8 Thông báo điện thoại', 'design'],
      ...(f === 'IS18' ? [['s-edit26', 'Sửa spec · 14:30', 'design'] as [string, string, 'design']] : [])];
    s.orchestrators.push(...kinds.map(([sessionId, title, orchKind], i) => ({ ...o, sessionId, title, orchKind, seq: (o.seq ?? 1) + i + 1 })));
  }
  return s;
}
