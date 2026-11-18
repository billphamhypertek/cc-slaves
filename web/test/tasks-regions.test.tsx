// v2.7 G4a §4.3 the Tasks regions: rail, issue list, issue detail — block order, `↑` hidden in Ngoài spec, the right cluster,
// §5.6 seen-on-leave (not on open), history sentences (R-B11), §6 IS10 narrow switch, IS16 import line, §6 build locks.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts';
import type { IssueInfo } from '../../shared/issues.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { issueCmds, readTasksUi } from '../src/lib/issues.ts';
import { cancelBothKeys, canOk, detailRows, historyLines, seenOnLeave, type DetailCtx } from '../src/tasks/IssueDetail.model.ts';
import { clusterOf, effectiveSel, headSub, isNarrowTasks, showUp, type ClusterCtx } from '../src/tasks/IssueList.model.ts';
import { IssueList } from '../src/tasks/IssueList.tsx';
import { IssueDetail } from '../src/tasks/IssueDetail.tsx';
import { SpecRail } from '../src/tasks/SpecRail.tsx';
import { TIP_W, tipPos } from '../src/tasks/LockTip.tsx';
import { canCancel } from '../src/tasks/CancelPop.tsx';
import type { TasksCtx } from '../src/tasks/tasks-ctx.ts';
import { tasksLive } from '../src/tasks/TasksRoot.tsx';
import { issueInfo, poWf, projIssues, specInfo } from './fixtures.ts';

const tr = makeT('vi');
const NOW = new Date(2026, 10, 17, 14, 32).getTime();
const at = (h: number, m: number, day = 0) => new Date(2026, 10, 17 - day, h, m).getTime();
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const cx = (all: IssueInfo[] = [], quota: number | null = null): ClusterCtx => ({ tr, now: NOW, quotaAt: () => quota, all });

function ctx(pi = projIssues([specInfo(1, { title: 'v2.5 Toolkit graph', sessions: { design: null, build: 's1', edit: null } })], []), over: Partial<TasksCtx> = {}): TasksCtx {
  const live = { ...tasksLive(null, 'p1'), quotaAt: () => null };
  return { project: { id: 'p1', name: 'hagenta', path: '/w/hagenta' }, pi, ui: readTasksUi(null, 'p1'), setUi: () => {}, cmds: issueCmds(() => Promise.resolve(), 'p1'), locked: false,
    capFull: false, sessions: [], toDeck: () => {}, toCode: () => {}, start: () => {}, ask: null, setPop: () => {}, live, send: () => Promise.resolve(), now: NOW, narrow: false, wf: poWf(), ...over };
}

describe('§4.3 list blocks + rows', () => {
  const issues = [
    issueInfo(44), issueInfo(49, { waitingOn: ['T-44'] }), issueInfo(47, { state: 'doing', lane: { name: 'D2', state: 'running', phase: 'code' } }),
    issueInfo(42, { state: 'done', doneAt: 5 }), issueInfo(37, { state: 'cancelled' }), issueInfo(50, { key: 'B-50', kind: 'bug', state: 'doing', priority: true, poSeen: false, source: 'lane' }),
  ];
  test('§4.3 blocks render in the fixed order Đang làm · Sẵn sàng · Bị chặn · Xong · Huỷ (Huỷ folded)', () => {
    const h = text(html(<IssueList c={ctx(projIssues([specInfo(1)], issues))} sel={{ spec: 1 }} open={null} side={false} onSpecName={() => {}} />));
    const order = ['Đang làm', 'Sẵn sàng', 'Bị chặn', 'Xong', 'Huỷ'].map(b => h.indexOf(` ${b} `));
    expect(order.every(n => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h).not.toContain('T-37'); // Huỷ folded by default
  });
  test('§4.2-4 IS3b Phát sinh only when the list came from the card: that block alone + the "Phát sinh ×" chip', () => {
    const c = ctx(projIssues([specInfo(1)], issues));
    const raw = html(<IssueList c={{ ...c, ui: { ...c.ui, arising: true } }} sel={{ spec: 1 }} open={null} side={false} onSpecName={() => {}} />);
    const h = text(raw);
    expect(h).toContain(' Phát sinh 1 ');
    expect(h).toContain('B-50');
    for (const b of [' Đang làm ', ' Sẵn sàng ', ' Xong ']) expect(h).not.toContain(b); // filtered: the other blocks hide
    expect(raw).toMatch(/<button type="button" class="lchip" aria-pressed="true" title="Bỏ lọc Phát sinh">Phát sinh/);
    expect(text(html(<IssueList c={c} sel={{ spec: 1 }} open={null} side={false} onSpecName={() => {}} />))).not.toContain(' Phát sinh ');
  });
  test('§4.3 ↑ marks a priority issue in a spec; hidden in Ngoài spec (every issue is priority there)', () => {
    const b = issueInfo(52, { key: 'B-52', kind: 'bug', priority: true, specId: null });
    expect(showUp(b, { spec: 1 })).toBe(true);
    expect(showUp(b, 'outside')).toBe(false);
    expect(showUp({ ...b, state: 'cancelled' }, { spec: 1 })).toBe(false);
    const h = html(<IssueList c={ctx(projIssues([], [b]))} sel="outside" open={null} side={false} onSpecName={() => {}} />);
    expect(h).not.toContain('class="up"');
    expect(text(h)).toContain('1 mục mở · mọi mục đều ưu tiên');
  });
  test('§4.3 the right cluster per lane / issue state', () => {
    const lane = (state: string, phase: string | null = 'code') => issueInfo(1, { state: 'doing', lane: { name: 'D2', state, phase } });
    expect(clusterOf(lane('running'), cx())).toEqual({ text: 'D2 · code', tone: null });
    expect(clusterOf(lane('waiting_po'), cx())).toEqual({ text: 'D2 · chờ PO', tone: 'warn' });
    expect(clusterOf(lane('broken'), cx())).toEqual({ text: 'D2 · hỏng', tone: 'bad' });
    expect(clusterOf(lane('waiting_quota'), cx([], at(15, 0))).text).toBe('D2 · chờ quota · 15:00');
    expect(clusterOf(issueInfo(49, { waitingOn: ['T-47', 'T-48'] }), cx()).text).toBe('chờ T-47, T-48');
    expect(clusterOf(issueInfo(44, { createdAt: at(14, 7) }), cx()).text).toBe('sẵn sàng · chưa giao 25 phút');
    const done = issueInfo(53, { state: 'done', commits: [{ sha: 'a', branch: 'main', at: 1 }, { sha: 'b', branch: 'main', at: 2 }] });
    expect(clusterOf(done, cx())).toEqual({ text: '2 commit', tone: null });
    expect(clusterOf({ ...done, poSeen: false }, cx())).toEqual({ text: 'xong · 2 commit', tone: 'new' });
  });
  test('§6 IS19 an amend todo reads grey "bổ sung" (vi) / "added" (en), a waiting one keeps "chờ …"', () => {
    const amend = issueInfo(55, { source: 'amend', createdAt: at(14, 7) });
    expect(clusterOf(amend, cx())).toEqual({ text: 'bổ sung', tone: null });
    expect(clusterOf(amend, { ...cx(), tr: makeT('en') })).toEqual({ text: 'added', tone: null });
    expect(clusterOf({ ...amend, waitingOn: ['T-55'] }, cx()).text).toBe('chờ T-55');
  });
  test('§5.7 revert running → "đang hoàn tác · T-54"; conflict → red "hoàn tác vướng T-53"', () => {
    const t46 = issueInfo(46, { state: 'done', revert: 'running', blocks: ['T-49', 'T-53'] });
    const all = [t46, issueInfo(54, { reverts: 'T-46', state: 'doing' }), issueInfo(53, { state: 'done' }), issueInfo(49)];
    expect(clusterOf(t46, cx(all)).text).toBe('đang hoàn tác · T-54');
    expect(clusterOf({ ...t46, revert: 'conflict' }, cx(all))).toEqual({ text: 'hoàn tác vướng T-53', tone: 'bad' });
  });
  test('§4.3 head line: "· 2 phát sinh thêm · 1 huỷ"; a done spec "xong dd/mm"', () => {
    const xs = [issueInfo(1), issueInfo(2, { source: 'lane' }), issueInfo(3, { source: 'po' }), issueInfo(4, { state: 'cancelled' }), issueInfo(5, { source: 'po', reverts: 'T-1' })];
    const pi = projIssues([specInfo(1), specInfo(2, { state: 'done', doneAt: at(17, 5, 3) })], xs);
    expect(headSub(pi, { spec: 1 }, xs, tr, NOW)).toBe('2 phát sinh thêm · 1 huỷ');
    expect(headSub(pi, { spec: 2 }, [xs[3]!], tr, NOW)).toBe('xong 14/11 · 1 huỷ');
  });
  test('§4.3 default selection: the first building spec', () => {
    const pi = projIssues([specInfo(1, { state: 'draft' }), specInfo(2, { state: 'active' })], []);
    expect(effectiveSel(pi, null)).toEqual({ spec: 2 });
    expect(effectiveSel(pi, { spec: 1 })).toEqual({ spec: 1 });
    expect(effectiveSel(pi, { spec: 9 })).toEqual({ spec: 2 });
  });
  test('R-B20 "Bổ sung yêu cầu" locked: the reason is a LockTip (cap full, offline), never a native title', () => {
    const pi = projIssues([specInfo(1, { state: 'active' })], [issueInfo(1)]);
    const head = (over: Partial<TasksCtx>) => html(<IssueList c={ctx(pi, over)} sel={{ spec: 1 }} open={null} side={false} onSpecName={() => {}} />);
    expect(head({ capFull: true })).toMatch(/<span class="ltip" data-tip="Đã đủ 3 phiên[^"]*"><span class="split"><button type="button" class="lbtn" disabled="">Bổ sung yêu cầu<\/button>/);
    expect(head({ locked: true })).toMatch(/<span class="ltip" data-tip="[^"]+"><span class="split"><button type="button" class="lbtn" disabled="">Bổ sung yêu cầu/);
    expect(head({ capFull: true })).not.toMatch(/title="Đã đủ/);
    expect(head({})).toMatch(/<span class="split"><button type="button" class="lbtn" title="Bắt đầu ngay[^"]*">Bổ sung yêu cầu/); // free: no LockTip
  });
  test('§4.3 detail open next to the three buttons: filter folds to a select, no progress bar, 8/13 kept', () => {
    const pi = projIssues([specInfo(1, { state: 'active' })], [issueInfo(1, { state: 'done' }), issueInfo(2)]);
    const wide = html(<IssueList c={ctx(pi)} sel={{ spec: 1 }} open="T-2" side onSpecName={() => {}} />);
    expect(wide).toMatch(/<button type="button" class="lfsel" aria-label="Lọc theo loại" aria-haspopup="menu" aria-expanded="false">Tất cả<svg/);
    expect(wide).not.toContain('<select');
    expect(wide).not.toContain('class="tpg');
    expect(text(wide)).toContain('1/2');
    expect(text(wide)).toContain('Xem trên Deck');
    expect(html(<IssueList c={ctx(pi)} sel={{ spec: 1 }} open={null} side={false} onSpecName={() => {}} />)).toContain('class="tpg'); // IS3b nothing beside: the bar shows
    const ov = html(<IssueList c={ctx(pi)} sel={{ spec: 1 }} open={null} side onSpecName={() => {}} />); // IS22 the overview beside
    expect(ov).toContain('class="lseg"');
    expect(ov).not.toContain('class="tpg');
    expect(text(wide)).toContain('Bổ sung yêu cầu');
    expect(html(<IssueList c={ctx(pi)} sel={{ spec: 1 }} open={null} side={false} onSpecName={() => {}} />)).toContain('class="lseg"');
  });
});

describe('§6 IS10 narrow window', () => {
  test('§6 < 1100 px is narrow', () => {
    expect(isNarrowTasks(1099)).toBe(true);
    expect(isNarrowTasks(1100)).toBe(false);
  });
  test('§6 IS10 narrow: spec menu button + "⋯" in the list head, the cluster stays in the row (CSS puts it under the title), detail = overlay with close', () => {
    const pi = projIssues([specInfo(1, { title: 'v2.5 Toolkit graph' })], [issueInfo(2)]);
    const c = ctx(pi, { narrow: true });
    const h = html(<IssueList c={c} sel={{ spec: 1 }} open={null} side={false} onSpecName={() => {}} />);
    expect(h).toContain('class="tlist nw"');
    expect(h).toContain('class="lspec"');
    expect(h).toContain('aria-label="Thêm thao tác"');
    expect(h).toContain('class="tpg'); // narrow keeps the bar (no overview beside it)
    expect(text(h)).not.toContain('Xem trên Deck'); // inside the ⋯ menu
    const d = html(<IssueDetail c={c} issue={pi.issues[0]!} onClose={() => {}} />);
    expect(d).toContain('tdet idet ov');
    expect(d).toContain('aria-label="Đóng"');
    expect(d).toMatch(/<div class="dmeta">.*<button type="button" class="dcx" aria-expanded="false">Huỷ<\/button>/s); // G4b IS4 Huỷ in the head
  });
});

describe('§5.6 seen on leave (R19)', () => {
  const arising = issueInfo(50, { key: 'B-50', source: 'lane', poSeen: false });
  const seen = issueInfo(47);
  test('§5.6 opening never counts; leaving an unseen issue sends seen; an already seen one sends nothing', () => {
    expect(seenOnLeave(null, 'B-50', [arising])).toBeNull();
    expect(seenOnLeave('B-50', 'B-50', [arising])).toBeNull();
    expect(seenOnLeave('B-50', 'T-47', [arising, seen])).toBe('B-50');
    expect(seenOnLeave('B-50', null, [arising])).toBe('B-50');
    expect(seenOnLeave('T-47', 'B-50', [arising, seen])).toBeNull();
    expect(seenOnLeave('B-50', null, [{ ...arising, poSeen: true }])).toBeNull(); // Cho làm already set it
  });
});

describe('§4.3 detail: history, table, buttons', () => {
  const spec = specInfo(4, { title: 'v2.5 Toolkit graph' });
  const x = (all: IssueInfo[] = []): DetailCtx => ({ tr, now: NOW, spec, all, quotaAt: () => null, lanes: [] });
  test('§5.1 history sentences in plain Vietnamese, VN time, commits as lines', () => {
    const i = issueInfo(47, { specId: 4, state: 'doing', lane: { name: 'D2', state: 'running', phase: 'code' }, commits: [{ sha: 'e07b31d99', branch: 'lane/d2', at: at(14, 29) }],
      events: [{ ts: at(14, 5), type: 'created', data: { source: 'spec', state: 'todo' } }, { ts: at(14, 12), type: 'taken', data: { lane: 'D2' } }, { ts: at(14, 29), type: 'updated', data: { fields: ['commits'] } }] });
    const b50 = issueInfo(50, { key: 'B-50', source: 'lane', sourceLane: 'D2', sourceIssue: 'T-47', createdAt: at(14, 21) });
    expect(historyLines(i, x([i, b50])).map(h => `${h.at} ${h.text}`)).toEqual(['14:05 Tạo từ spec v2.5', '14:12 Điều phối mở lane D2', '14:21 D2 ghi thêm việc phát sinh B-50', '14:29 D2 commit e07b31d']);
  });
  test('R-B11 a PO cancel on a still-done issue reads "PO huỷ (hoàn tác)"; on a todo "PO huỷ"; older days show dd/mm', () => {
    const ev = (ts: number) => [{ ts, type: 'cancelled', data: { by: 'po', reason: 'bước 2 thừa' } }];
    expect(historyLines(issueInfo(46, { state: 'done', revert: 'pending', events: ev(at(14, 33)) }), x())[0]!.text).toBe('PO huỷ (hoàn tác): "bước 2 thừa"');
    expect(historyLines(issueInfo(44, { state: 'cancelled', events: ev(at(14, 33)) }), x())[0]!.text).toBe('PO huỷ: "bước 2 thừa"');
    expect(historyLines(issueInfo(44, { state: 'cancelled', events: ev(at(15, 20, 3)) }), x())[0]!.at).toBe('14/11 15:20');
    expect(historyLines(issueInfo(44, { events: [{ ts: 1, type: 'cancelled', data: { by: 'orchestrator', reason: null } }] }), x())[0]!.text).toBe('Điều phối bỏ mục');
  });
  test('§5.7 revert events and Cho làm read as sentences', () => {
    const t46 = issueInfo(46, { state: 'done', revert: 'running', events: [
      { ts: 1, type: 'revert', data: { to: 'pending' } }, { ts: 2, type: 'revert', data: { to: 'running' } }, { ts: 3, type: 'po_ok', data: {} }] });
    expect(historyLines(t46, x([t46, issueInfo(54, { reverts: 'T-46' })])).map(h => h.text)).toEqual(['Chờ lane nhận việc hoàn tác', 'Tạo T-54 để hoàn tác', 'PO cho làm']);
  });
  test('§4.3 UX-M5 wording + order as the mockup: "mở lane R5 (ưu tiên)", "lane R6 nhận", "R6 dừng: T-53 đã xây trên T-46 · T-54 huỷ", commits before "Xong"', () => {
    const b50 = issueInfo(50, { key: 'B-50', specId: 4, priority: true, lane: { name: 'R5', state: 'running', phase: 'code' }, events: [{ ts: 1, type: 'taken', data: { lane: 'R5' } }] });
    expect(historyLines(b50, x([b50]))[0]!.text).toBe('Điều phối mở lane R5 (ưu tiên)');
    const t53 = issueInfo(53, { state: 'done', blockedBy: ['T-46'] }), t52 = issueInfo(52, { state: 'done', blockedBy: ['T-46'] });
    const t54 = issueInfo(54, { reverts: 'T-46', state: 'cancelled', lane: { name: 'R6', state: 'done', phase: 'done' } });
    const t46 = issueInfo(46, { state: 'done', revert: 'conflict', blocks: ['T-49', 'T-52', 'T-53'], events: [
      { ts: 2, type: 'revert', data: { to: 'running' } }, { ts: 3, type: 'revert', data: { to: 'conflict' } }] });
    expect(historyLines(t46, x([t46, t52, t53, t54, issueInfo(49)])).map(h => h.text)).toEqual(['Tạo T-54 để hoàn tác · lane R6 nhận', 'R6 dừng: T-53 đã xây trên T-46 · T-54 huỷ']);
    expect(historyLines({ ...t46, blocks: [] }, x([t54]))[1]!.text).toBe('Hoàn tác vướng — đã dừng, chưa đổi gì');
    const d = issueInfo(45, { state: 'done', lane: { name: 'D2', state: 'done', phase: 'done' }, commits: [{ sha: '6df7ddc00', branch: 'main', at: 50 }],
      events: [{ ts: 50, type: 'done', data: { commits: ['6df7ddc'] } }] });
    expect(historyLines(d, x([d])).map(h => h.text)).toEqual(['D2 commit 6df7ddc', 'Xong · 1 commit']);
  });
  test('§4.3 table: source of a lane issue, Ưu tiên, Đang chặn vs Mục dựa vào, commit on main', () => {
    const b = issueInfo(50, { key: 'B-50', kind: 'bug', specId: 4, source: 'lane', sourceLane: 'D2', sourceIssue: 'T-47', priority: true, blocks: ['T-49'] });
    const rows = Object.fromEntries(detailRows(b, x()).map(r => [r.label, r.value]));
    expect(rows['Nguồn']).toBe('Lane D2 phát hiện lúc làm T-47');
    expect(rows['Ưu tiên']).toBe('↑ bug, làm trước mục thường');
    expect(rows['Đang chặn']).toBe('T-49');
    expect(rows['Commit']).toBe('chưa có');
    const d = issueInfo(46, { state: 'done', doneAt: at(13, 40), blocks: ['T-53'], commits: [{ sha: '9c1e2fa00', branch: 'main', at: 1 }] });
    const r2 = Object.fromEntries(detailRows(d, x()).map(r => [r.label, r.value]));
    expect(r2['Trạng thái']).toBe('Xong · 13:40');
    expect(r2['Mục dựa vào']).toBe('T-53');
    expect(r2['Commit']).toBe('9c1e2fa · trên main');
  });
  test('§5.6 Cho làm only on an unseen arising issue of a spec not done; §5.7 Huỷ hidden while reverting / conflict card open', () => {
    const b = issueInfo(50, { source: 'lane', poSeen: false });
    expect(canOk(b, spec)).toBe(true);
    expect(canOk({ ...b, poOk: true }, spec)).toBe(false);
    expect(canOk(b, { ...spec, state: 'done' })).toBe(false);
    expect(canOk(issueInfo(1, { poSeen: false, source: 'po' }), spec)).toBe(false);
    expect(canCancel(issueInfo(46, { state: 'done' }))).toBe(true);
    expect(canCancel(issueInfo(46, { state: 'done', revert: 'running' }))).toBe(false);
    expect(canCancel(issueInfo(46, { state: 'done', revert: 'conflict' }))).toBe(false);
    expect(canCancel(issueInfo(54, { reverts: 'T-46' }))).toBe(false);
    expect(canCancel(issueInfo(44, { state: 'cancelled' }))).toBe(false);
  });
  test('§5.7-5 IS5b the red strip with Giữ T-46 · Huỷ cả hai…; issue keys in text are links', () => {
    const t46 = issueInfo(46, { specId: 1, state: 'done', revert: 'conflict', blocks: ['T-53'] });
    const card = { id: 9, kind: 'revert_conflict', projectId: 'p1', status: 'open', params: { key: 'T-46', blocker: 'T-53' }, actions: [{ id: 'revert_keep', label: 'Giữ T-46' }] };
    const c = ctx(projIssues([specInfo(1)], [t46, issueInfo(53, { state: 'done' })]));
    const h = html(<IssueDetail c={{ ...c, live: { ...c.live, cards: [card as never] } }} issue={t46} onClose={() => {}} />);
    expect(text(h).replace(/ \)/g, ')')).toContain('Hoàn tác T-46 vướng T-53 (đã merge, dựa vào T-46). Chưa đổi gì trên main.');
    expect(text(h)).toContain('Giữ T-46');
    expect(text(h)).toContain('Huỷ cả hai…');
    expect(h.match(/class="dcx"/g)?.length).toBe(1); // only the strip's Huỷ cả hai…, no Huỷ in the head
    expect(cancelBothKeys(t46, 'T-53')).toEqual(['T-53', 'T-46']); // IS4 for both, the dependant first
    expect(cancelBothKeys(t46, null)).toEqual(['T-46']);
    expect(h).toContain('<button type="button" class="tkey">T-53</button>');
  });
});

describe('§4.3 rail', () => {
  test('§4.3 groups, Bắt đầu build, "sau v2.5" lock, Xem thêm, IS16 import line, outside-build yellow, missing red', () => {
    const v25 = specInfo(4, { title: 'v2.5 Toolkit graph', state: 'active' });
    const specs = [specInfo(1, { title: 'v2.8 Thông báo', state: 'draft' }), specInfo(2, { title: 'v2.6 Updater', state: 'approved' }),
      specInfo(3, { title: 'v2.9 Code graph', state: 'approved', after: { id: 4, path: v25.path, title: v25.title, state: 'active' } }), v25,
      specInfo(5, { title: 'v2.7 Imported', state: 'approved', outsideBuild: true }), specInfo(6, { title: 'v2.0 Old', state: 'done', missing: true }),
      ...[7, 8, 9, 10, 11, 12].map(n => specInfo(n, { state: 'done', doneAt: n }))];
    const c = ctx(projIssues(specs, [issueInfo(90, { specId: null })]));
    const h = html(<SpecRail c={{ ...c, live: { ...c.live, importNotice: 3 } }} sel={{ spec: 4 }} pick={() => {}} />);
    const t = text(h);
    for (const g of ['Đang thiết kế', 'Chờ build', 'Đang build', 'Ngoài spec', 'Xong']) expect(t).toContain(g);
    expect(t.indexOf('Đang thiết kế')).toBeLessThan(t.indexOf('Chờ build'));
    expect(t).toContain('Đã nhập 3 spec có sẵn từ docs/specs · Ẩn');
    expect(t).toContain('sau v2.5');
    expect((t.match(/Bắt đầu build/g) ?? []).length).toBe(1); // not on the after-locked one, not on the outside-build one
    expect(h).toContain('class="warn">đang build dở ngoài cc-slaves');
    expect(t).toContain('Xem thêm 2');
    expect(t).toContain('Bug &amp; việc lẻ');
    expect(html(<SpecRail c={{ ...c, capFull: true }} sel={null} pick={() => {}} />)).toMatch(/<span class="ltip" data-tip="Đã đủ 3 phiên[^"]*"><span class="split"><button type="button" class="sbtn" disabled="">Bắt đầu build/);
    expect(html(<SpecRail c={{ ...c, ui: { ...c.ui, specDoneOpen: true } }} sel={null} pick={() => {}} />)).toContain('class="bad">mất file');
  });
});

describe('UX review part C (rail, list head)', () => {
  const v25 = specInfo(4, { title: 'v2.5 Toolkit graph', state: 'active' });
  const after = { id: 4, path: v25.path, title: v25.title, state: 'active' as const };
  test('I6 IS18 / IS13b a Chờ build spec being edited shows grey "đang sửa" instead of the button (wins over "sau v2.5")', () => {
    const specs = [specInfo(2, { title: 'v2.9 Code graph', state: 'approved', editing: true, after, sessions: { design: null, build: null, edit: 'e1' } }), v25];
    const h = html(<SpecRail c={ctx(projIssues(specs, []))} sel={null} pick={() => {}} />);
    expect(h).toContain('<span class="sx">đang sửa</span>');
    expect(text(h)).not.toContain('Bắt đầu build');
    expect(text(h)).not.toContain('sau v2.5');
  });
  test('M7 locked "+ Spec mới" and "sau v2.5" carry the reason as a styled tooltip (no native title)', () => {
    const specs = [specInfo(3, { title: 'v2.9 Code graph', state: 'approved', after }), v25];
    const h = html(<SpecRail c={ctx(projIssues(specs, []), { capFull: true })} sel={null} pick={() => {}} />);
    expect(h).toMatch(/<span class="ltip" data-tip="Đã đủ 3 phiên Thiết kế \/ Build — đóng bớt một phiên"><span class="split"><button type="button" class="snew" disabled="">/);
    expect(h).toMatch(/<span class="ltip" data-tip="Build sau khi v2.5 xong"><span class="sbtn off">sau v2.5<\/span>/);
    expect(h).not.toContain('title="Đã đủ');
    const free = html(<SpecRail c={ctx(projIssues([v25], []))} sel={null} pick={() => {}} />);
    expect(free).not.toContain('ltip');
  });
  test('M7 the tooltip sits right of its anchor, flips left at the window edge, never off-screen', () => {
    expect(tipPos({ left: 150, right: 240, top: 50, bottom: 74 }, 1440)).toEqual({ left: 248, top: 62 });
    expect(tipPos({ left: 1300, right: 1400, top: 50, bottom: 74 }, 1440)).toEqual({ left: 1300 - 8 - TIP_W, top: 62 });
  });
  test('M8 IS16 "Ẩn" keeps to the import line (text clips, the link never wraps)', () => {
    const c = ctx(projIssues([v25], []));
    const h = html(<SpecRail c={{ ...c, live: { ...c.live, importNotice: 4 } }} sel={null} pick={() => {}} />);
    expect(h).toMatch(/<p class="simp"><span title="[^"]+">Đã nhập 4 spec có sẵn từ docs\/specs<\/span> · <button type="button" class="lnk">Ẩn<\/button><\/p>/);
    const css = readFileSync(new URL('../src/tasks/SpecRail.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.srail \.simp\{display:flex;[^}]*white-space:nowrap/);
  });
  test('I10 IS19 the wide list head keeps the subtitle whole (the name gives way); "đang bổ sung · Tới phiên" leads the buttons', () => {
    const css = readFileSync(new URL('../src/tasks/IssueList.css', import.meta.url), 'utf8');
    expect(css).toContain('.tsk .tlist:not(.nw) .lsub{flex:none}');
    const s = specInfo(1, { title: 'v2.5 Toolkit graph', state: 'active', editing: true, sessions: { design: null, build: 's1', edit: 'e1' } });
    const t = text(html(<IssueList c={ctx(projIssues([s], [issueInfo(1)]))} sel={{ spec: 1 }} open={null} side={false} onSpecName={() => {}} />));
    expect(t.indexOf('đang bổ sung')).toBeGreaterThan(0);
    expect(t.indexOf('đang bổ sung')).toBeLessThan(t.indexOf('Xem trên Deck'));
    const beside = html(<IssueList c={ctx(projIssues([s], [issueInfo(1)]))} sel={{ spec: 1 }} open={null} side onSpecName={() => {}} />);
    expect(beside).toContain('class="lfsel"'); // overview beside + amending → the filter folds to make room
    const plain = { ...s, editing: false, sessions: { ...s.sessions, edit: null } };
    expect(html(<IssueList c={ctx(projIssues([plain], [issueInfo(1)]))} sel={{ spec: 1 }} open={null} side onSpecName={() => {}} />)).toContain('class="lseg"');
  });
});

