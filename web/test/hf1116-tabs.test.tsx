// Hot fix 2026-11-16 (docs/ref/hf1116-ux.md): "Đóng project" on a tab (blocked with its reason), the neighbour that takes
// over, the "Tất cả project (N)" list + filter, and the new `paused` state in every state map (neutral, no animation).
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LaneState, OrchestratorState, OrchestratorView, ProjectView } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { closeBlock, projectActions, type MenuCtx } from '../src/lib/actions.ts';
import { rowCounts } from '../src/lib/done.ts';
import { heldBand, heldPlaceholder } from '../src/lib/inspector.ts';
import { LANE_CLASS, laneState, orchState } from '../src/lib/labels.ts';
import { laneSubject } from '../src/lib/model.ts';
import { impactLine } from '../src/lib/model-menu.ts';
import { filterProjects, moveActive, tabNeighbour } from '../src/lib/tabs.ts';
import { buildFlow } from '../src/deck/flow/model.ts';
import { Glyph } from '../src/deck/flow/Glyph.tsx';
import { menuItemsFor, runMenuAct, type MenuHost } from '../src/ui/menuRun.ts';
import { ProjectListBox } from '../src/ui/ProjectList.tsx';
import { lane, snapshot } from './fixtures.ts';

const VI = makeT('vi'), EN = makeT('en');
const orch = (state: OrchestratorState, over: Partial<OrchestratorView> = {}): OrchestratorView => ({ projectId: 'p1', state, account: 'a@x', homeAccount: 'a@x',
  lastError: null, costUsd: 0, contextPct: 10, talkingTo: null, sessionId: 's1', seq: 1, ...over });
const proj = (id: string, name: string, over: Partial<ProjectView> = {}): ProjectView => ({ id, name, path: `/w/${id}`, orchestratorAccount: null,
  gchatWebhookSet: false, gchatSendCommandText: false, ...over });
const idle = (lanes: LaneState[], o: OrchestratorState = 'idle') => snapshot({ lanes: lanes.map((s, i) => lane(`L${i}`, { state: s })), orchestrators: [orch(o)] });
const ctx = (s = idle([]), channel: 'mac' | 'remote' = 'mac'): MenuCtx => ({ tr: VI, snap: { ...s, channel }, offline: false, tauri: true, now: Date.now() });

describe('hf1116 W1 "Đóng project": blocked with the reason while something runs', () => {
  test('hf1116 W1 every running lane state blocks; idle / waiting_po / stopped / broken / done / paused do not', () => {
    for (const s of ['starting', 'running', 'switching', 'draining', 'waiting_quota'] as const)
      expect(closeBlock(VI, idle([s]), 'p1')).toBe('Đang chạy 1 lane — dừng hoặc chờ xong rồi đóng');
    for (const s of ['idle', 'waiting_po', 'stopped', 'broken', 'done', 'paused'] as const) expect(closeBlock(VI, idle([s]), 'p1')).toBeNull();
  });
  test('hf1116 W1 every running Điều phối state blocks; idle / stopped / paused do not', () => {
    for (const o of ['starting', 'running', 'switching', 'waiting_quota'] as const)
      expect(closeBlock(VI, idle([], o), 'p1')).toBe('Đang chạy Điều phối — dừng hoặc chờ xong rồi đóng');
    for (const o of ['idle', 'stopped', 'paused'] as const) expect(closeBlock(VI, idle([], o), 'p1')).toBeNull();
  });
  test('hf1116 W1 both: "Đang chạy 2 lane · Điều phối — …"; another project\'s lanes never count; en plural', () => {
    const s = idle(['running', 'draining', 'idle'], 'running');
    expect(closeBlock(VI, s, 'p1')).toBe('Đang chạy 2 lane · Điều phối — dừng hoặc chờ xong rồi đóng');
    expect(closeBlock(VI, s, 'p2')).toBeNull();
    expect(closeBlock(EN, s, 'p1')).toBe('Running 2 lanes · Orchestrator — stop it or wait for it to finish, then close');
  });
  test('hf1116 W1 the item: "Đóng project", tooltip says nothing is lost, act project_close; dimmed with the reason when busy', () => {
    const [it] = projectActions({ id: 'p1' }, ctx());
    expect(it).toMatchObject({ label: 'Đóng project', icon: 'x', tip: 'Ẩn khỏi thanh tab, giữ lịch sử. Thêm lại thư mục này để mở lại.', act: { t: 'project', a: 'close', projectId: 'p1' } });
    expect(it!.disabled).toBeUndefined();
    expect(projectActions({ id: 'p1' }, ctx(idle(['running'])))[0]!.disabled).toBe('Đang chạy 1 lane — dừng hoặc chờ xong rồi đóng');
  });
  test('hf1116 W1 remote channel: no item (project_close is Mac only); a gone project: no menu', () => {
    expect(projectActions({ id: 'p1' }, ctx(idle([]), 'remote'))).toEqual([]);
    expect(menuItemsFor({ k: 'project', id: 'p1' }, ctx(), () => undefined).map(i => i.id)).toEqual(['close']);
    expect(menuItemsFor({ k: 'project', id: 'gone' }, ctx(), () => undefined)).toEqual([]);
  });
  test('hf1116 W1 the runner hands the close to the shell (no confirm dialog)', () => {
    const log: string[] = [];
    runMenuAct({ t: 'project', a: 'close', projectId: 'p1' }, { closeProject: (id: string) => log.push(`close ${id}`), confirm: () => { log.push('confirm'); return true; } } as unknown as MenuHost);
    expect(log).toEqual(['close p1']);
  });
  test('hf1116 W1 closing the active tab selects its right neighbour, else its left one; the last tab → none', () => {
    expect(tabNeighbour(['a', 'b', 'c'], 'b')).toBe('c');
    expect(tabNeighbour(['a', 'b', 'c'], 'c')).toBe('b');
    expect(tabNeighbour(['a', 'b', 'c'], 'a')).toBe('b');
    expect(tabNeighbour(['a'], 'a')).toBeNull();
    expect(tabNeighbour(['a', 'b'], 'x')).toBeNull();
  });
});

describe('hf1116 W2 "Tất cả project (N)"', () => {
  const ps = [proj('p1', 'Dự án Một'), proj('p2', 'Du an hai'), proj('p3', 'hagenta'), proj('p4', 'ĐỒNG BỘ')];
  test('hf1116 W2 the filter ignores case and Vietnamese diacritics both ways; blank = all', () => {
    expect(filterProjects(ps, 'dự').map(p => p.id)).toEqual(['p1', 'p2']);
    expect(filterProjects(ps, 'DU AN').map(p => p.id)).toEqual(['p1', 'p2']);
    expect(filterProjects(ps, 'dong').map(p => p.id)).toEqual(['p4']);
    expect(filterProjects(ps, '  ').map(p => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(filterProjects(ps, 'zzz')).toEqual([]);
  });
  test('hf1116 W2 ↑ / ↓ wrap around; an empty list stays at 0', () => {
    expect(moveActive(0, 3, -1)).toBe(2);
    expect(moveActive(2, 3, 1)).toBe(0);
    expect(moveActive(1, 3, 1)).toBe(2);
    expect(moveActive(0, 0, 1)).toBe(0);
  });
  test('hf1116 W2 rows: name, Chờ PO badge, unread dot (not on the current tab), "Tạm dừng" chip when held; filter focused', () => {
    const rows = [proj('p1', 'hagenta'), proj('p2', 'cc-slaves', { held: { kind: 'resume', sessions: 1, lanes: 2 } }), proj('p3', 'docs')];
    const h = renderToStaticMarkup(<LangProvider lang="vi"><ProjectListBox projects={rows} projectId="p1" pendingByProject={{ p2: 4 }} unread={new Set(['p1', 'p3'])}
      anchor={{ current: null }} onPick={() => {}} onClose={() => {}} /></LangProvider>);
    expect(h).toMatch(/<input type="text"[^>]*placeholder="Lọc theo tên…"/);
    expect(h).toContain('aria-label="Tất cả project (3)"');
    const row = (id: string) => h.match(new RegExp(`<li[^>]*id="pl-${id}"[^>]*>(.*?)</li>`))![1]!;
    expect(row('p2')).toContain('<span class="pill held">Tạm dừng</span>');
    expect(row('p2')).toContain('<span class="bdg">4</span>');
    expect(row('p1')).not.toContain('unread');
    expect(row('p3')).toContain('class="unread"');
    expect(row('p1')).not.toContain('held');
    expect(h).toMatch(/<li[^>]*aria-selected="true"[^>]*id="pl-p1"|<li id="pl-p1"[^>]*aria-selected="true"/);
  });
});

describe('hf1116 W3 the paused state everywhere states are mapped', () => {
  test('hf1116 W3 labels: lane "Tạm dừng" (neutral class), Điều phối "Điều phối tạm dừng", counts "n tạm dừng"', () => {
    expect(LANE_CLASS.paused).toBe('');
    expect(laneState(VI, 'paused')).toBe('Tạm dừng');
    expect(orchState(VI, 'paused')).toBe('Điều phối tạm dừng');
    expect(orchState(EN, 'paused')).toBe('Orchestrator paused');
    expect(rowCounts(VI, { paused: 3, running: 1 })).toBe('1 chạy · 3 tạm dừng');
  });
  test('hf1116 W3 the band text per kind and the composer placeholder', () => {
    expect(heldBand(VI, { kind: 'resume', sessions: 1, lanes: 0 })).toEqual({
      text: 'Đang tạm dừng từ lần mở app trước · 1 phiên Điều phối, 0 lane đang chờ. Không tốn token cho tới khi bạn tiếp tục.', button: 'Tiếp tục' });
    expect(heldBand(VI, { kind: 'start', sessions: 0, lanes: 0 })).toEqual({ text: 'Điều phối chưa chạy. Gửi tin nhắn đầu tiên hoặc bấm Bắt đầu.', button: 'Bắt đầu' });
    expect(heldPlaceholder(VI, { kind: 'resume', sessions: 1, lanes: 0 })).toBe('Gửi để tiếp tục…');
    expect(heldPlaceholder(VI, { kind: 'start', sessions: 0, lanes: 0 })).toBe('Gửi để bắt đầu…');
  });
  test('hf1116 W3 glyph: a grey pause sign, nothing animated even with the motion gate open', () => {
    const h = renderToStaticMarkup(<Glyph state="paused" live />);
    expect(h).toContain('so-paused');
    expect(h.match(/<rect/g)?.length).toBe(2);
    expect(h).not.toMatch(/a-(spin|orb|wave|blink|swf)/);
  });
  test('hf1116 W3 deck: a paused root takes the pause glyph and says "Tạm dừng" on line 2; a paused lane keeps its glyph state', () => {
    const s = snapshot({ orchestrators: [orch('paused')], lanes: [lane('D2', { state: 'paused', ownerSession: 's1' })] });
    const m = buildFlow({ snap: s, projectId: 'p1', subagents: {}, selected: null, now: 1, tr: VI, live: true });
    const root = m.nodes.find(n => n.data.kind === 'orchestrator')!.data as { glyph: string; line2: { kind: string } };
    expect(root.glyph).toBe('paused');
    expect(root.line2.kind).toBe('paused');
    const ln = m.nodes.find(n => n.data.kind === 'lane')!.data as { glyph: string };
    expect(ln.glyph).toBe('paused');
    expect(m.animated).toBe(false);
  });
  test('hf1116 W3 model picker: a paused lane / session applies "khi chạy lại" (no process), like stopped', () => {
    const subj = laneSubject(VI, lane('D2', { state: 'paused' }))!;
    expect(subj.state).toBe('paused');
    expect(impactLine(VI, subj, 'D2', false, 'lane')!.text).toBe(impactLine(VI, { ...subj, state: 'stopped' }, 'D2', false, 'lane')!.text);
  });
});
