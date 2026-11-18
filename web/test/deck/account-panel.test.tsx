// v2.1 §4.7 account panel (collapsed card + open panel), §4.10 rows, §4.11 key A / Esc ladder, §6 "Account".
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Snapshot, TokenStats } from '../../../shared/protocol.ts';
import { accountPanel, laneHoverClass, panelItems, poolPct, switchedAccounts, virtualWindow, PANEL_MAX_DOM, type PanelCtx } from '../../src/deck/accounts.ts';
import { AccountPanel, type AccountPanelProps } from '../../src/deck/AccountPanel.tsx';
import { keyAction, isTyping } from '../../src/lib/keys.ts';
import { escapeStep, type EscState } from '../../src/ui/shell.ts';
import { account, lane, snapshot } from '../fixtures.ts';
import { NOW, scene } from './scene.ts';
import { makeT } from '../../../shared/i18n/index.ts';
const VI = makeT('vi');

const stats: TokenStats = { at: NOW, tokens5h: { input: 1_000_000, output: 200_000, cacheWrite: 100_000, cacheRead: 9_000_000 }, projects: {} };
const ctxOf = (s: Snapshot, over: Partial<PanelCtx> = {}): PanelCtx =>
  ({ lanes: s.lanes, orchestrators: s.orchestrators, projects: s.projects, projectId: 'p1', noNewLanes: {}, login: s.login ?? null, channel: s.channel, now: NOW, stats: s.stats, ...over });
const model = (s: Snapshot, over: Partial<PanelCtx> = {}) => accountPanel(s.accounts, ctxOf(s, over), VI);
const props = (s: Snapshot, over: Partial<AccountPanelProps> = {}): AccountPanelProps => ({
  snap: s, projectId: 'p1', now: NOW, open: false, onToggle: () => {}, onAdd: () => {}, onRelogin: () => {}, onCfg: () => {},
  onSelectAccount: () => {}, onMenu: () => {}, onCancelLogin: () => {}, hoverEmail: null, onHover: () => {}, ...over,
});
const html = (s: Snapshot, over: Partial<AccountPanelProps> = {}) => renderToStaticMarkup(<AccountPanel {...props(s, over)} />);
const count = (h: string, re: RegExp) => (h.match(re) ?? []).length;

describe('§4.7 counts: 5 / 30 / 300 accounts (§6 Account)', () => {
  for (const [n, exp] of [[5, { ready: 0, inUse: 4, warn: 0, block: 1, unknown: 0 }], [30, { ready: 23, inUse: 2, warn: 2, block: 3, unknown: 0 }],
    [300, { ready: 285, inUse: 2, warn: 9, block: 4, unknown: 0 }]] as const) {
    test(`§6 ${n} accounts: buckets, legend, stacked bar segments and collapsed card agree`, () => {
      const s = scene(n), m = model(s);
      expect(m.n).toBe(n);
      expect(m.buckets).toEqual(exp);
      expect(Object.values(m.buckets).reduce((a, b) => a + b, 0)).toBe(n);
      expect(m.pool).toBe(poolPct(s.accounts));
      // legend hides zero groups; the stacked bar has one segment per non-zero bucket with the same count
      expect(m.legend.map(l => l.n)).toEqual(Object.values(exp).filter(v => v > 0));
      expect(m.bar.map(b => b.n)).toEqual(m.legend.map(l => l.n));
      expect(m.bar.reduce((a, b) => a + b.pct, 0)).toBeCloseTo(100, 5);
      const card = html(s);
      expect(card).toContain(`data-n="${n}"`);
      expect(card).toContain(`data-pool="${m.pool}"`);
      expect(count(card, /class="acnt bad"/g)).toBe(exp.block > 0 ? 1 : 0);
      expect(count(card, /class="acnt warn"/g)).toBe(exp.warn > 0 ? 1 : 0);
      expect(count(card, /class="acnt unk"/g)).toBe(0);
      if (exp.block) expect(card).toContain(`>${exp.block}<`);
    });
  }
  test('§4.7 groups in order Cần xem → Đang dùng → Sẵn sàng; Sẵn sàng closed by default ("▸ Hiện n account")', () => {
    const m = model(scene(30));
    expect(m.groups.map(g => g.id)).toEqual(['attention', 'inUse', 'ready']);
    expect(m.groups.map(g => g.rows.length)).toEqual([5, 2, 23]);
    const h = html(scene(30), { open: true });
    expect(h.indexOf('Cần xem')).toBeLessThan(h.indexOf('Đang dùng'));
    expect(h.indexOf('Đang dùng')).toBeLessThan(h.indexOf('Sẵn sàng'));
    expect(h).toContain('▸ Hiện 23 account');
    expect(count(h, /class="acrow/g)).toBe(7);
  });
  test('§4.7 attention sorted red → amber → grey; in-use = has a lane or is the orchestrator account', () => {
    const accs = [account('u@x', { headroomPct: null }), account('l@x', { headroomPct: 4 }), account('f@x', { full: true, headroomPct: 0 }),
      account('o@x', { role: 'orchestrator' }), account('busy@x'), account('r@x')];
    const s = snapshot({ accounts: accs, lanes: [lane('D2', { account: 'busy@x' }), lane('E1', { account: 'r@x', state: 'done' })],
      orchestrators: [{ ...snapshot().orchestrators[0]!, account: 'o@x' }] });
    const m = model(s);
    expect(m.groups[0]!.rows.map(r => r.email)).toEqual(['f@x', 'l@x', 'u@x']);
    expect(m.groups[1]!.rows.map(r => r.email)).toEqual(['o@x', 'busy@x']);
    expect(m.groups[2]!.rows.map(r => r.email)).toEqual(['r@x']); // a done lane does not hold an account
  });
});

describe('§4.7 colours (W15) and amber kinds', () => {
  test('§4.7 W15 red = full AND logged out (v1 F16)', () => {
    const s = snapshot({ accounts: [account('f@x', { full: true, headroomPct: 0 }), account('o@x', { loggedOut: true, login: 'out' }), account('ok@x')], lanes: [] });
    const m = model(s);
    expect(m.buckets.block).toBe(2);
    expect(m.groups[0]!.rows.map(r => [r.email, r.tone])).toEqual([['f@x', 'bad'], ['o@x', 'bad']]);
    expect(m.groups[0]!.rows[1]!.right).toBe('—');
    expect(m.groups[0]!.rows[0]!.right).toBe('Đầy');
  });
  test('§4.7 amber: low, v2 login ⚠ expiring, shared-config error, stale numbers (v2.2: no MCP on an account)', () => {
    const accs = [account('low@x', { headroomPct: 6 }), account('exp@x', { login: 'expiring' }),
      account('cfg@x', { sharedCfg: { ok: false, issues: [{ kind: 'missing-link', name: 'skills', path: '/a' }] } }),
      account('old@x', { fresh: false, fetchedAt: NOW - 3_600_000 })];
    const m = model(snapshot({ accounts: accs, lanes: [] }));
    expect(m.buckets.warn).toBe(4);
    expect(m.groups[0]!.rows.map(r => r.issues[0])).toEqual(['low', 'expiring', 'cfg', 'stale']);
    const tip = m.collapsedTip.join(' · ');
    for (const w of ['1 sắp hết', '1 đăng nhập sắp hết hạn', '1 cấu hình chung lỗi', '1 số liệu cũ']) expect(tip).toContain(w);
    expect(tip).not.toContain('MCP');
  });
  test('§4.7 grey = unknown; collapsed tooltip "Account · 30 · kho còn N % · 3 đầy · 2 sắp hết"', () => {
    expect(model(snapshot({ accounts: [account('u@x', { headroomPct: null })], lanes: [] })).buckets.unknown).toBe(1);
    const m = model(scene(30));
    expect(m.collapsedTip[0]).toBe(`Account · 30 · kho còn ${m.pool} % · 3 đầy · 2 sắp hết`);
  });
  test('§4.7 row click: logged out / ⚠ → A6, config error → shared-config list, else F24', () => {
    const accs = [account('o@x', { loggedOut: true, login: 'out' }), account('exp@x', { login: 'expiring' }),
      account('cfg@x', { sharedCfg: { ok: false, issues: [] } }), account('ok@x')];
    const rows = model(snapshot({ accounts: accs, lanes: [] })).groups.flatMap(g => g.rows);
    expect(Object.fromEntries(rows.map(r => [r.email, r.click]))).toEqual({ 'o@x': 'relogin', 'exp@x': 'relogin', 'cfg@x': 'cfg', 'ok@x': 'select' });
  });
});

describe('§4.7 rows', () => {
  test('v2.2 §6 ACC (F-I6) a shared-config error shows the chip "⚠ cấu hình chung lỗi ›" on its row (tip: "Không nhận lane: …"), not a lone mark', () => {
    const accs = [account('acc51@x', { sharedCfg: { ok: false, issues: [{ kind: 'real-entry', name: 'plans', path: '/a' }] } }), account('ok@x')];
    const s = snapshot({ accounts: accs, lanes: [] });
    const row = model(s).groups.flatMap(g => g.rows).find(r => r.email === 'acc51@x')!;
    expect(row.cfgChip).toBe(true);
    expect(row.sub).not.toContain('cấu hình chung lỗi'); // said once, by the chip
    expect(row.tip.join(' · ')).toContain('Không nhận lane: cấu hình chung lỗi');
    const h = html(s, { open: true });
    expect(h).toMatch(/<span class="achip warn">⚠ cấu hình chung lỗi ›<\/span>/);
    expect(count(h, /class="achip/g)).toBe(1);
  });
  test('§4.7 sub line "lane B2, R5 · other/Z1", role labels, headroom + two bars (used %)', () => {
    const s = scene(30);
    s.lanes.push(lane('Z1', { projectId: 'p2', account: s.accounts[1]!.email }));
    s.projects.push({ id: 'p2', name: 'other', path: '/w/o', orchestratorAccount: null, gchatWebhookSet: false, gchatSendCommandText: false });
    const m = model(s), rows = m.groups.flatMap(g => g.rows);
    const backup = rows.find(r => r.email === s.accounts[1]!.email)!;
    expect(backup.role).toBe('backup');
    expect(backup.sub).toBe('lane B2, R5 · other/Z1');
    expect(backup.right).toBe('còn 33 %');
    expect(backup.bars.map(b => [b.win, b.used])).toEqual([['five', 31], ['week', 48]]); // v2.7.1 L15: bars = used %
    const full = rows.find(r => r.email === s.accounts[2]!.email)!;
    expect(full.sub).toBe('lane C1');
    expect(full.l3.map(p => p.text).join(' ')).toMatch(/^Đầy · mở lại 08:00 18\/11$/);
    expect(rows.find(r => r.email === s.accounts[0]!.email)!.role).toBe('orch');
  });
  test('§4.7 row tooltip: plan, role, reset with time left (v2.7.1 §4.5), "số liệu lúc" when stale, Không giao lane mới', () => {
    const a = account('x@x', { fresh: false, fetchedAt: new Date(2026, 10, 17, 9, 5).getTime(), fiveResetsAt: NOW + 2 * 3_600_000 });
    const m = model(snapshot({ accounts: [a], lanes: [] }), { noNewLanes: { 'x@x': true } });
    const r = m.groups[0]!.rows[0]!;
    expect(r.l3.map(p => p.text)).toEqual(['số liệu lúc 09:05']);
    expect(r.sub).toContain('Không giao lane mới');
    const tip = r.tip.join('\n');
    expect(tip).toContain('20x'); expect(tip).toContain('Số liệu lúc 09:05'); expect(tip).toContain('(còn 2\u00a0giờ)');
  });
  test('UX-M8 N3-c / v2.7.1 §4.5 row tooltip lines: who · plan · role / 5 giờ used · reset (còn …) / tuần used · reset · dừng ở', () => {
    const a = account('x@x', { fiveResetsAt: NOW + 2 * 3_600_000, weekResetsAt: NOW + 50 * 3_600_000, fivePct: 31, headroomPct: 40 });
    const r = model(snapshot({ accounts: [a], lanes: [lane('C1', { account: 'x@x', state: 'running' })] })).groups.flatMap(g => g.rows)[0]!;
    expect(r.tip[0]).toBe('x@x · gói 20x · vai trò Chính');
    expect(r.tip[1]).toBe('5 giờ: dùng 31 % · reset 12:00 17/11 (còn 2\u00a0giờ)');
    expect(r.tip[2]).toBe('tuần: dùng 48 % · reset 12:00 19/11 (còn 2\u00a0ngày) · dừng ở 99 %');
  });
  test('§4.7 token line "5 giờ N tok" (input + output + cacheWrite) · "tuần dùng N %"', () => {
    const s = scene(30, undefined, { stats });
    const m = model(s);
    expect(m.tokens).toBe('5 giờ 1,3M tok');
    expect(m.week).toBe('tuần dùng 48 %');
    expect(model(scene(30)).tokens).toBeNull(); // pre-v2.1 engine: no stats
    expect(html(s, { open: true })).toContain('5 giờ 1,3M tok');
  });
  test('§4.7 v2 A3 single-flight: "+" locked with "Đang đăng nhập <email>"; the relogging row says "đang đăng nhập…" + Huỷ', () => {
    const s = scene(5, undefined, { login: { id: 'r1', mode: 'relogin', email: 'acc002@x-dev.test', state: 'waiting_browser', url: null, deadline: NOW + 60_000, error: null } as Snapshot['login'] });
    const h = html(s, { open: true });
    expect(h).toMatch(/<button[^>]*class="acb aadd"[^>]*disabled/);
    expect(h).toContain('Đang đăng nhập acc002@x-dev.test');
    expect(h).toContain('đang đăng nhập…');
    expect(h).toContain('>Huỷ<');
  });
  test('§4.7 every row has the "⋯" slot (T9)', () => {
    expect(count(html(scene(5), { open: true }), /class="ib amore"/g)).toBe(5);
  });
});

describe('§4.10 screens', () => {
  test('§4.10 "Chưa có account" (v2 A1): card shows 0 + grey dot; panel says Chưa có account + "+ Thêm account"', () => {
    const s = snapshot({ accounts: [], lanes: [] });
    const card = html(s);
    expect(card).toContain('data-n="0"');
    expect(card).toContain('class="acnt unk"');
    const h = html(s, { open: true });
    expect(h).toContain('Chưa có account');
    expect(h).toContain('+ Thêm account');
  });
  test('§4.10 "Mọi account đầy": pool 0, card red count = every lane account', () => {
    const accs = [account('o@x', { role: 'orchestrator', headroomPct: 40 }), ...Array.from({ length: 30 }, (_, i) => account(`f${i}@x`, { full: true, headroomPct: 0 }))];
    const m = model(snapshot({ accounts: accs, lanes: [] }));
    expect(m.pool).toBe(0);
    expect(m.buckets.block).toBe(30);
  });
  test('§4.7 / v2 §6 one account: ĐIỀU PHỐI label + its lanes, in Đang dùng; pool counts it (not 0)', () => {
    const one = account('pm@x', { role: 'orchestrator', headroomPct: 62 });
    const s = snapshot({ accounts: [one], lanes: [lane('D15', { account: 'pm@x' })], orchestrators: [{ ...snapshot().orchestrators[0]!, account: 'pm@x' }] });
    const m = model(s);
    expect(m.groups.find(g => g.id === 'inUse')!.rows.map(r => [r.email, r.role, r.sub])).toEqual([['pm@x', 'orch', 'Điều phối · lane D15']]);
    expect(m.pool).toBe(62);
    expect(html(s, { open: true })).toContain('ĐIỀU PHỐI');
  });
  test('§4.10 300 accounts: Sẵn sàng open still renders ≤ 80 row elements (virtualised)', () => {
    const h = html(scene(300), { open: true, initialReadyOpen: true });
    const rows = count(h, /class="acrow/g);
    expect(rows).toBeGreaterThan(10);
    expect(rows).toBeLessThanOrEqual(PANEL_MAX_DOM);
    expect(PANEL_MAX_DOM).toBeLessThanOrEqual(80);
    expect(h).toContain('Lọc account…');
  });
  test('§4.7 virtualWindow: only > 60 rows virtualise; window stays ≤ 80 items anywhere in the list', () => {
    const m = model(scene(300));
    const items = panelItems(m, { readyOpen: true, filter: '' });
    expect(virtualWindow(panelItems(model(scene(30)), { readyOpen: true, filter: '' }), 0, 800).virtual).toBe(false);
    for (const top of [0, 2000, 9000, 1e6]) {
      const w = virtualWindow(items, top, 800);
      expect(w.virtual).toBe(true);
      expect(w.end - w.start).toBeLessThanOrEqual(PANEL_MAX_DOM);
      expect(w.end).toBeLessThanOrEqual(items.length);
      expect(w.total).toBeGreaterThan(w.top);
    }
    expect(virtualWindow(items, 1e6, 800).end).toBe(items.length);
  });
  test('§4.7 filter box only when > 8 accounts; filter matches across groups and opens Sẵn sàng', () => {
    expect(html(scene(5), { open: true })).not.toContain('Lọc account…');
    const items = panelItems(model(scene(30)), { readyOpen: false, filter: 'ACC02' });
    const rows = items.filter(i => i.kind === 'row').map(i => i.kind === 'row' ? i.row.email : '');
    expect(rows.length).toBe(10); // acc020…acc029
    expect(rows.every(e => e.includes('acc02'))).toBe(true);
    expect(items.some(i => i.kind === 'more')).toBe(false);
  });
});

describe('§4.7 remote channel', () => {
  test('§4.7 remote: "+" hidden, logged-out row says "Đăng nhập lại trên Mac", A6 click → F24 instead', () => {
    const s = snapshot({ channel: 'remote', accounts: [account('o@x', { loggedOut: true, login: 'out' }), account('ok@x')], lanes: [] });
    const h = html(s, { open: true });
    expect(h).not.toMatch(/class="acb aadd"/);
    expect(h).toContain('Đăng nhập lại trên Mac');
    expect(model(s).groups[0]!.rows[0]!.click).toBe('select');
  });
});

describe('§4.10 Mất kết nối: the panel is read-only (buttons dimmed with the reason)', () => {
  const login = { id: 'r1', mode: 'relogin', email: 'acc002@x-dev.test', state: 'waiting_browser', url: null, deadline: NOW + 60_000, error: null } as Snapshot['login'];
  test('§4.10 offline: "+" and the relogging row\'s "Huỷ" are disabled with "Mất kết nối"; online they are live', () => {
    const off = html(scene(5), { open: true, offline: true });
    expect(off).toMatch(/<button[^>]*class="acb aadd"[^>]*disabled=""[^>]*title="Mất kết nối"/);
    const huy = /<button[^>]*class="alnk"[^>]*>Huỷ</;
    expect(html(scene(5, undefined, { login }), { open: true, offline: true })).toMatch(/<button[^>]*class="alnk"[^>]*disabled=""[^>]*title="Mất kết nối"[^>]*>Huỷ</);
    expect(html(scene(5, undefined, { login }), { open: true })).toMatch(huy);
    expect(html(scene(5, undefined, { login }), { open: true })).not.toMatch(/class="alnk"[^>]*disabled/);
    expect(html(scene(5), { open: true })).not.toMatch(/class="acb aadd"[^>]*disabled/);
  });
  test('§4.10 offline: empty state "+ Thêm account" disabled with the reason', () => {
    expect(html(snapshot({ accounts: [], lanes: [] }), { open: true, offline: true })).toMatch(/<button[^>]*class="nb"[^>]*disabled=""[^>]*title="Mất kết nối"/);
  });
  test('§4.10 offline: a ✗ / ⚠ row opens F24 read-only (not A6 / A9), its tip says why', () => {
    const s = snapshot({ accounts: [account('o@x', { loggedOut: true, login: 'out' }), account('ok@x')], lanes: [] });
    expect(model(s).groups[0]!.rows[0]!.click).toBe('relogin');
    const row = model(s, { offline: true }).groups[0]!.rows[0]!;
    expect(row.click).toBe('select');
    expect(row.tip).toContain('Mất kết nối');
    expect(model(s, { offline: true }).groups.flatMap(g => g.rows).find(r => r.email === 'ok@x')!.tip).not.toContain('Mất kết nối');
  });
  test('v1.1 UX-I4 text ≥ 10 px: the ĐIỀU PHỐI / DỰ PHÒNG tag uses the 10 px step', () => {
    const CSS = readFileSync(new URL('../../src/deck/AccountPanel.css', import.meta.url), 'utf8');
    expect(/\.accp \.atag\{[^}]*\}/.exec(CSS)![0]).toContain('font:600 var(--xxs)');
  });
});

describe('§4.7 lane switch glow (N3-k)', () => {
  test('§4.7 switchedAccounts: a lane that moved account lights the new account; first sight lights nothing', () => {
    const prev = new Map([['p1:D2', 'a@x'], ['p1:B2', 'b@x']]);
    expect(switchedAccounts(prev, [lane('D2', { account: 'c@x' }), lane('B2', { account: 'b@x' })])).toEqual(['c@x']);
    expect(switchedAccounts(new Map(), [lane('D2', { account: 'c@x' })])).toEqual([]);
    expect(switchedAccounts(prev, [lane('D2', { account: null })])).toEqual([]);
  });
  test('§4.7 row hover → its lanes light, other lanes dim .5; no hover → no class', () => {
    expect(laneHoverClass('a@x', 'a@x')).toBeUndefined();
    expect(laneHoverClass('b@x', 'a@x')).toBe('acc-dim');
    expect(laneHoverClass(null, 'a@x')).toBe('acc-dim');
    expect(laneHoverClass('a@x', null)).toBeUndefined();
  });
  test('§4.7 hover: lane hover highlights its account row (inverse of row hover)', () => {
    const s = scene(5);
    const h = html(s, { open: true, hoverEmail: s.accounts[1]!.email });
    expect(count(h, /class="acrow[^"]*\balit\b/g)).toBe(1);
  });
});

describe('§4.11 key A and Esc ladder', () => {
  const K = (key: string) => ({ key, code: `Key${key.toUpperCase()}`, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
  test('§4.11 A toggles the account panel; ignored while typing, incl. the "Lọc account…" box', () => {
    expect(keyAction(K('a'), false)).toEqual({ t: 'toggleAccounts' });
    expect(keyAction(K('A'), false)).toEqual({ t: 'toggleAccounts' });
    const filterBox = { matches: (sel: string) => sel.includes('input') };
    expect(keyAction(K('a'), isTyping(filterBox))).toBeNull();
  });
  const base: EscState = { palette: false, stopLane: false, moveAll: false, addOpen: false, settings: false, wizard: false, up: false, drawer: false };
  test('§4.11 Esc closes the open account panel before going up a level (Đang xem) and the drawer', () => {
    expect(escapeStep({ ...base, accPanel: true, up: true, drawer: true })).toBe('accPanel');
    expect(escapeStep({ ...base, accPanel: true, accDlg: true })).toBe('accDlg');
    expect(escapeStep({ ...base, accPanel: true, palette: true })).toBe('palette');
    expect(escapeStep({ ...base, accPanel: false, up: true })).toBe('up');
  });
});

describe('§4.7 overlay, never resizes the deck', () => {
  const CSS = readFileSync(new URL('../../src/deck/AccountPanel.css', import.meta.url), 'utf8');
  test('v2.7.1 §4.3 open panel = 400 px absolute overlay (380 px under 1280 px); collapsed card 44 px; nothing changes the deck frame', () => {
    expect(CSS).toMatch(/\.accp\.open\{[^}]*position:absolute[^}]*width:400px/);
    expect(CSS).toMatch(/@media \(max-width:1279px\)\{\.accp\.open\{width:380px\}\}/);
    expect(CSS).toMatch(/\.accp\.mini\{[^}]*position:absolute[^}]*width:44px/);
    expect(CSS).not.toMatch(/dframe|react-flow|#map/); // the panel CSS never touches the deck area
    const h = html(scene(30), { open: true });
    expect(h).toMatch(/^<aside[^>]*class="accp open"/);
  });
  test('§4.7 always collapsed by default (no persisted open state)', () => {
    expect(html(scene(30))).toMatch(/^<button[^>]*class="accp mini"/);
    expect(readFileSync(new URL('../../src/deck/AccountPanel.tsx', import.meta.url), 'utf8')).not.toMatch(/localStorage|lsGet|lsSet/);
  });
});

describe('hf1116 T4 deck account panel: the terminal login', () => {
  test('hf1116 T4 its row shows the neutral "Terminal" tag with the tooltip; other rows do not', () => {
    // both hold a lane → both in the open "đang dùng" group (the ready group starts folded)
    const s = snapshot({ accounts: [account('pm@x'), account('term@x', { terminal: true })], lanes: [lane('D1', { account: 'pm@x' }), lane('D2', { account: 'term@x' })] });
    expect(model(s).groups.flatMap(g => g.rows).find(r => r.email === 'term@x')!.terminal).toBe(true);
    const h = html(s, { open: true });
    const row = (e: string) => new RegExp(`data-email="${e}".*?class="ib amore"`).exec(h)![0];
    expect(row('term@x')).toContain('<span class="atag" title="Đăng nhập Claude Code có sẵn trên máy · dùng chung với terminal / VS Code">Terminal</span>');
    expect(row('pm@x')).not.toContain('>Terminal<');
  });
});
