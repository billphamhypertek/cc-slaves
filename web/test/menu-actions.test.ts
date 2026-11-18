// v2.1 T9 §4.12 "⋯" action menus: one pure source per kind (lane / Điều phối / subagent / account row), channel rules
// (§4.11 "Kênh và mất kết nối"), offline, "Chuyển account ▸" order, ⌘K = same source (N2-k), keys 1–9 = layout keyOrder.
import { describe, expect, test } from 'bun:test';
import { REMOTE_ALLOWED, type LaneState, type OrchestratorView, type Snapshot, type SubagentView } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
import { accountActions, actCmd, laneActions, orchActions, subActions, type MenuCtx, type MenuItem } from '../src/lib/actions.ts';
import { buildItems } from '../src/lib/palette.ts';
import { account, lane, snapshot } from './fixtures.ts';

const VI = makeT('vi');
const ctx = (snap: Snapshot = snapshot(), over: Partial<MenuCtx> = {}): MenuCtx => ({ tr: VI, snap, offline: false, tauri: true, now: Date.now(), ...over });
const ids = (items: MenuItem[]) => items.map(i => i.id);
const flat = (items: MenuItem[]): MenuItem[] => items.flatMap(i => [i, ...flat(i.submenu?.items ?? [])]);
const orch = (over: Partial<OrchestratorView> = {}): OrchestratorView => ({ projectId: 'p1', state: 'running', account: 'a@x', homeAccount: 'a@x', lastError: null,
  costUsd: 0, contextPct: 41, talkingTo: null, sessionId: 's1', seq: 1, ...over });
const two = (over: Partial<Snapshot> = {}) => snapshot({ orchestrators: [orch(), orch({ sessionId: 's2', seq: 2 })], ...over });
const sub = (over: Partial<SubagentView> = {}): SubagentView => ({ taskId: 't1', toolUseId: 'u1', subagentType: 'tests', description: 'unit', status: 'running',
  background: false, lastTool: null, toolUses: 3, totalTokens: 100, ...over });
const STATES: LaneState[] = ['starting', 'running', 'idle', 'waiting_po', 'waiting_quota', 'switching', 'stopped', 'broken', 'done'];

describe('§4.12 lane menu: rows of the table per state', () => {
  const of = (state: LaneState, snap?: Snapshot) => ids(laneActions(lane('D2', { state }), ctx(snap)));
  test('§4.12 Nhắn always; Ngắt lượt when running / chờ PO; Chạy lại in the same place when stopped / broken', () => {
    for (const s of STATES) expect(of(s)[0]).toBe('msg');
    expect(of('running')[1]).toBe('interrupt');
    expect(of('waiting_po')[1]).toBe('interrupt');
    expect(of('broken')[1]).toBe('resume');
    expect(of('stopped')[1]).toBe('resume');
    expect(of('idle')).not.toContain('interrupt');
    expect(of('idle')).not.toContain('resume');
    expect(of('running')).not.toContain('resume');
  });
  test('§4.12 Dừng… except stopped / done; Chuyển account ▸ except done', () => {
    for (const s of STATES) expect(of(s).includes('stop')).toBe(s !== 'stopped' && s !== 'done');
    for (const s of STATES) expect(of(s).includes('switch')).toBe(s !== 'done');
  });
  test('§4.12 Chuyển sang phiên ▸ only with > 1 running session, except done; the holding session dimmed "đang giữ"', () => {
    expect(of('running')).not.toContain('reassign');
    expect(of('running', two())).toContain('reassign');
    expect(of('done', two())).not.toContain('reassign');
    const r = laneActions(lane('D2', { ownerSession: 's1', ownerSeq: 1 }), ctx(two())).find(i => i.id === 'reassign')!;
    expect(r.submenu!.items.map(i => [i.label, i.disabled ?? null])).toEqual([['#1', 'đang giữ'], ['#2', null]]);
    expect(r.submenu!.items[1]!.act).toEqual({ t: 'lane_reassign', projectId: 'p1', name: 'D2', toSession: 's2' });
  });
  test('§4.12 Chạy tiếp lane… / Nhờ Điều phối merge… only on done lanes; merged branch dims Chạy tiếp and drops merge', () => {
    expect(of('running')).not.toContain('continue');
    expect(of('running')).not.toContain('merge');
    expect(of('done')).toEqual(expect.arrayContaining(['continue', 'merge']));
    const merged = laneActions(lane('D2', { state: 'done', branch: { name: 'b', base: 'main', state: 'merged', ahead: 0, files: 0, add: 0, del: 0, measuredAt: 1 } }), ctx());
    expect(merged.find(i => i.id === 'continue')!.disabled).toBe('Nhánh đã merge');
    expect(ids(merged)).not.toContain('merge');
  });
  test('§4.12 Mở VS Code always; Mở Terminal only inside the Tauri app', () => {
    for (const s of STATES) expect(of(s)).toContain('vscode');
    expect(ids(laneActions(lane('D2'), ctx(snapshot(), { tauri: true })))).toContain('terminal');
    expect(ids(laneActions(lane('D2'), ctx(snapshot(), { tauri: false })))).not.toContain('terminal');
  });
  test('§4.12 N2-c order: Nhắn · Ngắt lượt · Dừng… | Model / effort… (v2.4 §4.5) · Chuyển account ▸ | VS Code · Terminal (groups split by a rule)', () => {
    const items = laneActions(lane('D2'), ctx());
    expect(ids(items)).toEqual(['msg', 'interrupt', 'stop', 'model', 'switch', 'vscode', 'terminal']);
    expect(items.map(i => i.g)).toEqual([0, 0, 0, 1, 1, 3, 3]);
    expect(items.find(i => i.id === 'stop')!.danger).toBe(true);
  });
});

describe('§4.12 "Chuyển account ▸" (v1 §4.4): most headroom first, invalid accounts dimmed with the reason', () => {
  const snap = snapshot({
    accounts: [account('a@x', { role: 'orchestrator' }), account('low@x', { headroomPct: 31 }), account('pm@x', { headroomPct: 60 }), account('top@x', { headroomPct: 100 }),
      account('full@x', { full: true, headroomPct: 0 }), account('out@x', { loggedOut: true, login: 'out' }), account('pz@x', { headroomPct: 99 })],
    config: { noNewLanes: { 'pz@x': true } },
  });
  const sw = laneActions(lane('D2', { account: 'pm@x' }), ctx(snap)).find(i => i.id === 'switch')!.submenu!;
  test('§4.12 N2-d usable accounts sorted by headroom, then "Tự động", then the dimmed ones', () => {
    const usable = sw.items.filter(i => !i.disabled).map(i => i.id);
    expect(usable).toEqual(['sw:top@x', 'sw:low@x', 'sw:auto']);
    const dim = sw.items.filter(i => i.disabled);
    expect(sw.items.indexOf(dim[0]!)).toBeGreaterThan(sw.items.findIndex(i => i.id === 'sw:auto'));
  });
  test('§4.12 dimmed + reason: current account, full, logged out, "Không giao lane mới", orchestrator account', () => {
    const why = Object.fromEntries(sw.items.filter(i => i.disabled).map(i => [i.id, i.disabled]));
    expect(why['sw:pz@x']).toBe('Không giao lane mới');
    expect(why['sw:full@x']).toStartWith('ĐẦY');
    expect(why['sw:out@x']).toBeTruthy();
    expect(why['sw:pm@x']).toBeTruthy();
    expect(why['sw:a@x']).toBeTruthy();
    expect(sw.head).toBe('Chuyển D2 sang');
  });
  test('§4.12 a pick sends lane_switch_account with that account (auto = null)', () => {
    expect(sw.items.find(i => i.id === 'sw:top@x')!.act).toEqual({ t: 'lane_switch', projectId: 'p1', name: 'D2', account: 'top@x' });
    expect(sw.items.find(i => i.id === 'sw:auto')!.act).toEqual({ t: 'lane_switch', projectId: 'p1', name: 'D2', account: null });
  });
});

describe('§4.12 Điều phối menu (N2-f, N5-a, N5-n)', () => {
  test('§4.12 one session: Nhắn · Ngắt lượt | Mở phiên song song · Lịch sử · Phiên mới · Đổi tên | Kết thúc (dimmed) · Dừng an toàn tất cả', () => {
    const items = orchActions(orch(), ctx());
    expect(ids(items)).toEqual(['msg', 'interrupt', 'parallel', 'history', 'model', 'new', 'rename', 'end', 'stopAll']);
    expect(items.find(i => i.id === 'end')!.disabled).toBe('Chỉ có 1 phiên đang chạy — dùng "Phiên mới"');
    expect(items.find(i => i.id === 'new')!.label).toBe('Phiên mới…');
    expect(items.find(i => i.id === 'stopAll')!.danger).toBe(true);
  });
  test('§4.14 / v2.7 R34 at the cap (Chung + 3 Thiết kế / Build) "Mở phiên song song" is dimmed with the reason; history key H', () => {
    const three = snapshot({ orchestrators: [orch(), orch({ sessionId: 's2', seq: 2, orchKind: 'build' }), orch({ sessionId: 's3', seq: 3, orchKind: 'design' }), orch({ sessionId: 's4', seq: 4, orchKind: 'design' })] });
    const items = orchActions(orch(), ctx(three));
    expect(items.find(i => i.id === 'parallel')!.disabled).toBe('Đã đủ 3 phiên Thiết kế / Build — đóng bớt một phiên');
    expect(orchActions(orch(), ctx(two())).find(i => i.id === 'parallel')!.disabled).toBeUndefined();
    expect(items.find(i => i.id === 'history')!.kbd).toBe('H');
  });
  test('§4.12 stopped: Khởi động lại instead of Ngắt lượt (like the F11 card)', () => {
    const s = ids(orchActions(orch({ state: 'stopped' }), ctx()));
    expect(s).toContain('restart');
    expect(s).not.toContain('interrupt');
    expect(ids(orchActions(orch(), ctx()))).not.toContain('restart');
  });
  test('§4.12 > 1 session: Phiên mới (thay #n), Kết thúc enabled, split safe-stop, collapse items', () => {
    const items = orchActions(orch({ sessionId: 's2', seq: 2 }), ctx(two({ lanes: [lane('D2'), lane('D15'), lane('B1')] })));
    expect(ids(items)).toEqual(['msg', 'interrupt', 'parallel', 'history', 'model', 'new', 'rename', 'end', 'stopSession', 'stopProject', 'collapse', 'collapseOthers']);
    expect(items.find(i => i.id === 'new')!.label).toBe('Phiên mới (thay #2)…');
    expect(items.find(i => i.id === 'end')!.disabled).toBeUndefined();
    expect(items.find(i => i.id === 'stopProject')!.label).toBe('Dừng an toàn cả project (3 lane)…');
    expect(items.find(i => i.id === 'stopSession')!.act).toEqual({ t: 'orch', a: 'stopAll', projectId: 'p1', sessionId: 's2' });
    expect(items.find(i => i.id === 'stopProject')!.act).toEqual({ t: 'orch', a: 'stopAll', projectId: 'p1', sessionId: null });
  });
  test('§4.12 session items go to the T10 dialogs with the session id', () => {
    const items = orchActions(orch({ sessionId: 's2', seq: 2 }), ctx(two()));
    expect(items.find(i => i.id === 'rename')!.act).toEqual({ t: 'session', kind: 'rename', projectId: 'p1', sessionId: 's2' });
  });
});

describe('§4.12 subagent and account row menus', () => {
  test('§4.12 subagent: Xem · Nhắn lane cha về subagent này · Ngắt lượt lane cha (only while the parent runs)', () => {
    expect(ids(subActions(sub(), lane('D2'), ctx()))).toEqual(['view', 'msg', 'interrupt']);
    expect(ids(subActions(sub(), lane('D2', { state: 'idle' }), ctx()))).toEqual(['view', 'msg']);
    expect(subActions(sub(), lane('D2'), ctx())[1]!.label).toBe('Nhắn D2 về subagent này');
  });
  test('§4.12 account row (v2 A2 + v1 F24): every item in order', () => {
    const snap = snapshot({ lanes: [lane('D2', { account: 'pm@x' })] });
    expect(ids(accountActions(account('pm@x'), ctx(snap)))).toEqual(['view', 'refresh', 'relogin', 'terminal', 'pause', 'moveAll', 'caps', 'logout', 'delete']);
  });
  test('hf1116 T4 the terminal account has no Đăng xuất (sign out in the terminal); Xoá, Điều phối choices stay', () => {
    const snap = snapshot();
    expect(ids(accountActions(account('term@x', { terminal: true }), ctx(snap)))).toEqual(['view', 'refresh', 'terminal', 'pause', 'moveAll', 'caps', 'delete']);
  });
  test('hf1116 B-I2 "Đăng nhập lại" on the terminal account only once it is logged out (a live one would be replaced)', () => {
    const snap = snapshot();
    expect(ids(accountActions(account('term@x', { terminal: true, loggedOut: true }), ctx(snap)))).toContain('relogin');
    expect(ids(accountActions(account('term@x', { terminal: true, login: 'out' }), ctx(snap)))).toContain('relogin');
    expect(ids(accountActions(account('term@x', { terminal: true, login: 'expiring' }), ctx(snap)))).not.toContain('relogin');
  });
  test('§4.12 A8 lock: Xoá account dimmed with the reason while it has lanes / is the orchestrator; moveAll dimmed without lanes', () => {
    const snap = snapshot({ lanes: [lane('D2', { account: 'pm@x' })] });
    expect(accountActions(account('pm@x'), ctx(snap)).find(i => i.id === 'delete')!.disabled).toContain('D2');
    expect(accountActions(account('a@x', { role: 'orchestrator' }), ctx(snap)).find(i => i.id === 'delete')!.disabled).toBeTruthy();
    expect(accountActions(account('free@x'), ctx(snap)).find(i => i.id === 'moveAll')!.disabled).toBe('Không có lane đang chạy');
    expect(accountActions(account('free@x'), ctx(snap)).find(i => i.id === 'delete')!.disabled).toBeUndefined();
  });
  test('§4.12 paused account shows "Giao lane mới lại"; a logged-out account has no Đăng xuất', () => {
    const snap = snapshot({ config: { noNewLanes: { 'pm@x': true } } });
    expect(ids(accountActions(account('pm@x'), ctx(snap)))).toContain('unpause');
    expect(ids(accountActions(account('pm@x', { loggedOut: true, login: 'out' }), ctx(snap)))).not.toContain('logout');
  });
});

describe('§4.11 channel and offline (every action × every state)', () => {
  const remote = (over: Partial<Snapshot> = {}) => two({ channel: 'remote', ...over });
  const all = (c: MenuCtx): MenuItem[] => [
    ...STATES.flatMap(s => laneActions(lane('D2', { state: s, ownerSession: 's1' }), c)),
    ...(['running', 'stopped', 'starting', 'waiting_quota'] as const).flatMap(s => orchActions(orch({ state: s }), c)),
    ...subActions(sub(), lane('D2'), c), ...accountActions(account('pm@x'), c), ...accountActions(account('a@x', { role: 'orchestrator' }), c),
  ];
  test('§4.11 remote channel: no item (nor submenu item) outside REMOTE_ALLOWED', () => {
    const items = flat(all(ctx(remote())));
    expect(items.length).toBeGreaterThan(20);
    for (const i of items) if (i.act) { const c = actCmd(i.act); expect(c === null || REMOTE_ALLOWED.has(c)).toBe(true); }
  });
  test('§4.11 remote hides (never dims) restart, parallel, new, end, stop all, VS Code / Terminal, relogin, logout, delete', () => {
    const items = all(ctx(remote(), { tauri: false }));
    for (const id of ['restart', 'parallel', 'model', 'new', 'rename', 'end', 'stopAll', 'stopSession', 'stopProject', 'vscode', 'terminal', 'relogin', 'logout', 'delete', 'reassign', 'continue'])
      expect(ids(items)).not.toContain(id);
    expect(ids(items)).toEqual(expect.arrayContaining(['msg', 'interrupt', 'stop', 'switch', 'resume', 'history', 'merge']));
  });
  test('§4.11 the command map behind the remote filter (pinned)', () => {
    expect(actCmd({ t: 'lane', a: 'vscode', projectId: 'p1', name: 'D2' })).toBe('open_in_vscode');
    expect(actCmd({ t: 'lane', a: 'terminal', projectId: 'p1', name: 'D2' })).toBe('open_in_vscode');
    expect(actCmd({ t: 'orch', a: 'restart', projectId: 'p1', sessionId: null })).toBe('orchestrator_restart');
    expect(actCmd({ t: 'orch', a: 'stopAll', projectId: 'p1', sessionId: null })).toBe('stop_all');
    expect(actCmd({ t: 'session', kind: 'parallel', projectId: 'p1', sessionId: null })).toBe('session_open');
    expect(actCmd({ t: 'session', kind: 'history', projectId: 'p1', sessionId: null })).toBe('sessions_list');
    expect(actCmd({ t: 'acc', a: 'delete', email: 'x' })).toBe('account_delete');
    expect(actCmd({ t: 'acc', a: 'relogin', email: 'x' })).toBe('account_login');
    expect(actCmd({ t: 'lane_reassign', projectId: 'p1', name: 'D2', toSession: 's2' })).toBe('lane_reassign');
  });
  test('§4.12 offline: every item and submenu item dimmed with "Mất kết nối", none hidden', () => {
    const on = flat(all(ctx(two()))), off = flat(all(ctx(two(), { offline: true })));
    expect(off.map(i => i.id)).toEqual(on.map(i => i.id));
    for (const i of off) expect(i.disabled).toBe('Mất kết nối');
  });
});

describe('§4.12 one source: node / Inspector / F9 / ⌘K list the same items (N2-k)', () => {
  test('§4.12 ⌘K lists the selected lane\'s menu items (submenus flattened) with the same ids and act', () => {
    const snap = snapshot({ lanes: [lane('D2'), lane('D15')] });
    const menu = flat(laneActions(lane('D2'), ctx(snap))).filter(i => i.act);
    const pal = buildItems(VI, snap, { projectId: 'p1', selectedLane: 'D2', keys: ['D2', 'D15'], offline: false, tauri: true })
      .filter(i => i.id.startsWith('m:lane:p1:D2:'));
    expect(pal.map(i => i.id.slice('m:lane:p1:D2:'.length))).toEqual(menu.map(i => i.id));
    expect(pal.map(i => i.act)).toEqual(menu.map(i => ({ t: 'menu' as const, act: i.act! })));
  });
  test('§4.11 keys 1–9 hints in ⌘K follow the layout keyOrder, not the snapshot order', () => {
    const snap = snapshot({ lanes: [lane('D2'), lane('D15'), lane('B1')] });
    const pal = buildItems(VI, snap, { projectId: 'p1', selectedLane: null, keys: ['B1', 'D2'], offline: false, tauri: true });
    const kbd = (n: string) => pal.find(i => i.id === `lane:p1:${n}`)?.kbd;
    expect([kbd('B1'), kbd('D2'), kbd('D15')]).toEqual(['1', '2', undefined]);
  });
  test('§4.12 ⌘K shows the Điều phối menu of the viewed session; dimmed items carry the reason', () => {
    const pal = buildItems(VI, snapshot({ orchestrators: [orch()] }), { projectId: 'p1', selectedLane: null, keys: [], offline: false, tauri: true });
    const end = pal.find(i => i.id === 'm:orch:p1:s1:end')!;
    expect(end.disabled).toBe('Chỉ có 1 phiên đang chạy — dùng "Phiên mới"');
    expect(end.label).toBe('Điều phối · Kết thúc phiên…');
  });
});
