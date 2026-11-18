import { describe, expect, test } from 'bun:test';
import { buildItems, fold, fuzzyScore, laneRows, rankItems, type PalItem } from '../src/lib/palette.ts';
import { account, lane, snapshot } from './fixtures.ts';
import { makeT } from '../../shared/i18n/index.ts';
const VI = makeT('vi');
const ctx = (selectedLane: string | null, keys: string[] = ['D2', 'D15']) => ({ projectId: 'p1', selectedLane, keys, offline: false, tauri: true });

describe('§8.5 F22 palette fuzzy match', () => {
  test('subsequence matches, non-subsequence does not', () => {
    expect(fuzzyScore('d2', 'D2 · hagenta')).not.toBeNull();
    expect(fuzzyScore('hgt', 'hagenta')).not.toBeNull();
    expect(fuzzyScore('xyz', 'hagenta')).toBeNull();
  });
  test('Vietnamese diacritics are ignored (dung → Dừng, đ → d)', () => {
    expect(fold('Dừng Đã')).toBe('dung da');
    expect(fuzzyScore('dung', 'Dừng D2')).not.toBeNull();
  });
  test('prefix and contiguous beat scattered', () => {
    expect(fuzzyScore('cai', 'Cài đặt')!).toBeGreaterThan(fuzzyScore('cai', 'Chuyển account D2… (ai)')!);
    expect(fuzzyScore('d2', 'D2 · hagenta')!).toBeGreaterThan(fuzzyScore('d2', 'Dừng an toàn tất cả 2')!);
  });
  test('every action, lane and project is an item', () => {
    const snap = snapshot({ lanes: [lane('D2'), lane('D15')], accounts: [account('a@x', { role: 'orchestrator' }), account('pm@x')] });
    const items = buildItems(VI, snap, ctx('D2'));
    const labels = items.map(i => i.label);
    expect(labels).toContain('D2 · hagenta · Code B2');
    expect(labels).toContain('D15 · hagenta · Code B2');
    expect(labels).toContain('hagenta');
    expect(labels).toContain('D2 · Nhắn');
    expect(labels).toContain('D2 · Ngắt lượt');
    expect(labels).toContain('D2 · Dừng…');
    expect(labels).toContain('D2 · Chuyển account › Tự chọn');
    expect(labels).toContain('D2 · Mở VS Code');
    expect(labels).toContain('Điều phối · Dừng an toàn tất cả lane…');
    expect(labels).toContain('Cài đặt');
    expect(labels).toContain('Chế độ danh sách');
    expect(labels).toContain('account pm@');
    expect(items.find(i => i.label === 'hagenta')?.kbd).toBe('⌘1');
    expect(items.find(i => i.label.startsWith('D2 ·'))?.kbd).toBe('1');
  });
  test('remote channel drops Mac-only actions', () => {
    const items = buildItems(VI, snapshot({ channel: 'remote' }), ctx('D2')).map(i => i.label);
    expect(items).not.toContain('D2 · Mở VS Code');
    expect(items).not.toContain('Điều phối · Dừng an toàn tất cả lane…');
    expect(items).not.toContain('Thêm project');
    expect(items).not.toContain('Kiểm tra cài đặt');
    expect(items).toContain('D2 · Ngắt lượt');
  });
  test('§6 ⌘K "Skills & MCP" + "Thêm MCP…" on the Mac only (D32: setup screens are Mac-only)', () => {
    const mac = buildItems(VI, snapshot(), ctx('D2'));
    expect(mac.find(i => i.label === 'Skills & MCP')?.act).toEqual({ t: 'skillsMcp' });
    expect(mac.find(i => i.label === 'Thêm MCP…')?.act).toEqual({ t: 'mcpAdd' });
    expect(mac.find(i => i.label === 'Đăng nhập MCP…')?.act).toEqual({ t: 'mcpLogin' }); // §6 ⌘K "Đăng nhập MCP…"
    expect(mac.find(i => i.label === 'Bộ công cụ')?.act).toEqual({ t: 'toolkit' }); // v2.5 §6 ⌘K opens that tab
    expect(mac.find(i => i.label === 'Graph code')?.act).toEqual({ t: 'graph' });
    expect(buildItems(makeT('en'), snapshot(), ctx('D2')).map(i => i.label)).toEqual(expect.arrayContaining(['Toolkit', 'Graph code']));
    const remote = buildItems(VI, snapshot({ channel: 'remote' }), ctx('D2')).map(i => i.label);
    expect(remote).not.toContain('Skills & MCP');
    expect(remote).not.toContain('Thêm MCP…');
    expect(remote).not.toContain('Đăng nhập MCP…');
    expect(remote).not.toContain('Bộ công cụ');
    expect(remote).not.toContain('Graph code');
  });
  test('ranking: best match first, empty query keeps everything in order', () => {
    const items = buildItems(VI, snapshot(), ctx(null));
    expect(rankItems(items, '')).toHaveLength(items.length);
    expect(rankItems(items, 'cai dat')[0]!.label).toBe('Cài đặt');
    expect(rankItems(items, 'd15')[0]!.label).toStartWith('D15');
    expect(rankItems(items, 'zzzz')).toEqual([]);
  });
  test('§4.15 §2 N-c a lane row matches on its name and task, never on the project name in its label ("h" ≠ hagenta)', () => {
    const items = buildItems(VI, snapshot(), ctx(null));
    expect(items.find(i => i.id === 'lane:p1:D2')!.label).toContain('hagenta');
    expect(rankItems(items, 'h').filter(i => i.group === 'lane')).toEqual([]);
    expect(rankItems(items, 'b2').filter(i => i.group === 'lane').map(i => i.id)).toEqual(['lane:p1:D2', 'lane:p1:D15']); // task B2
    expect(rankItems(items, 'h').some(i => i.group === 'project')).toBe(true); // the project row still matches by name
  });
});

describe('§4.15 §2 ⌘K finds hidden and done lanes (N6-d)', () => {
  const o = (sessionId: string, seq: number, title: string | null = null) => ({ projectId: 'p1', state: 'running' as const, account: 'a@x', homeAccount: 'a@x',
    lastError: null, costUsd: 0, contextPct: 1, talkingTo: null, sessionId, seq, title });
  const snap = snapshot({ orchestrators: [o('s3', 3), o('s4', 4, 'hotfix')],
    lanes: [lane('D2', { ownerSession: 's3', ownerSeq: 3 }), lane('H4', { state: 'idle', ownerSession: 's4', ownerSeq: 4, phase: null, task: null }), lane('D11', { state: 'done', ownerSession: 's3', ownerSeq: 3, phase: null, task: null })] });
  test('§4.15 §2 each lane row names its session and state; a hidden lane says "ẩn"; done lanes are listed', () => {
    const items = buildItems(VI, snap, { ...ctx(null, ['D2']), hidden: ['H4'] }).filter(i => i.group === 'lane');
    const h4 = items.find(i => i.id === 'lane:p1:H4')!, d11 = items.find(i => i.id === 'lane:p1:D11')!;
    expect(h4.label).toBe('H4 · #4 · hotfix · hagenta · ẩn');
    expect([h4.hint, h4.kbd]).toEqual(['Rảnh', undefined]);
    expect(d11.label).toBe('D11 · #3 · hagenta');
    expect(d11.hint).toBe('Xong');
    expect(rankItems(items, 'h4')[0]!.act).toEqual({ t: 'lane', projectId: 'p1', name: 'H4' });
  });
});

describe('§4.11 / §4.15 §2 ⌘K order LANE → HÀNH ĐỘNG → PROJECT (N2-k, N6-d)', () => {
  const o = (sessionId: string, seq: number, title: string | null = null) => ({ projectId: 'p1', state: 'running' as const, account: 'a@x', homeAccount: 'a@x',
    lastError: null, costUsd: 0, contextPct: 1, talkingTo: null, sessionId, seq, title });
  const accts = Array.from({ length: 12 }, (_, i) => account(`acc${i}@x`));
  const snap = snapshot({ orchestrators: [o('s3', 3), o('s4', 4, 'hotfix')], accounts: accts,
    lanes: [lane('D2', { ownerSession: 's3', ownerSeq: 3 }), lane('D20', { ownerSession: 's3', ownerSeq: 3 }), lane('D15', { ownerSession: 's3', ownerSeq: 3 }),
      lane('H1', { ownerSession: 's4', ownerSeq: 4 }), lane('H4', { state: 'idle', ownerSession: 's4', ownerSeq: 4, phase: null, task: null })] });
  const c = { ...ctx('D15', ['D2', 'D20', 'D15']), hidden: ['H1', 'H4'] };
  const rank = (q: string) => rankItems(buildItems(VI, snap, c), q, (p, n) => laneRows(VI, snap, c, p, n));
  test('§4.11 "d2": LANE first (prefix: D2 before D20), then ≤ 6 actions of D2 only, then PROJECT', () => {
    const r = rank('d2');
    expect([...new Set(r.map(i => i.group))].slice(0, 2)).toEqual(['lane', 'action']);
    expect(r.filter(i => i.group === 'lane').map(i => i.id)).toEqual(['lane:p1:D2', 'lane:p1:D20']);
    const acts = r.filter(i => i.group === 'action');
    expect(acts.length).toBeLessThanOrEqual(6);
    expect(acts.length).toBeGreaterThan(0);
    expect(acts.every(i => i.id.startsWith('m:lane:p1:D2:'))).toBe(true);
    expect(acts.map(i => i.label)).toContain('D2 · Nhắn');
  });
  test('§4.11 a lane with more than 6 actions shows exactly its first 6 (the cap, not the menu length)', () => {
    const many = Array.from({ length: 9 }, (_, i): PalItem => ({ id: `m:${i}`, group: 'action', label: `a${i}`, icon: 'list', act: { t: 'lane', projectId: 'p1', name: 'D2' } }));
    const acts = rankItems(buildItems(VI, snap, c), 'd2', () => many).filter(i => i.group === 'action');
    expect(acts.map(i => i.id)).toEqual(many.slice(0, 6).map(i => i.id));
  });
  test('§4.15 §2 "h": the H lanes of the collapsed tree (with "ẩn"), then "Mở cây #4 · hotfix"', () => {
    const r = rank('h');
    expect(r[0]!.group).toBe('lane');
    expect(r.filter(i => i.group === 'lane').map(i => i.id)).toEqual(['lane:p1:H1', 'lane:p1:H4']);
    expect(r.find(i => i.id === 'lane:p1:H1')!.label).toContain('ẩn');
    const acts = r.filter(i => i.group === 'action');
    expect(acts.map(i => i.label)).toEqual(['Mở cây #4 · hotfix']);
    expect(acts[0]!.act).toEqual({ t: 'lane', projectId: 'p1', name: 'H1' });
  });
  test('§4.11 no lane-name prefix: lanes and actions fuzzy as before ("dung an toan" → Điều phối · Dừng an toàn…)', () => {
    const r = rank('dung an toan');
    expect(r.find(i => i.group === 'action')!.label).toStartWith('Điều phối · Dừng an toàn');
    expect(r.filter(i => i.group === 'action').length).toBeLessThanOrEqual(6);
  });
});
