// v2.7.1 §4.3–§4.7 the wide account panel: row text per state (AC1, AC5, AC7, AC12), header "cập nhật" (L5), refresh (§4.4,
// D101 60 s floor, 429), remote (AC9), collapsed card (AC11), Max / Ultra (D103), the ⋯ "Làm mới số liệu" item (AC4).
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountView, Snapshot } from '../../../shared/protocol.ts';
import { accountPanel, freshlyUpdated, panelItems, virtualWindow, type PanelCtx, type PanelRow } from '../../src/deck/accounts.ts';
import { AccountPanel, type AccountPanelProps } from '../../src/deck/AccountPanel.tsx';
import { accountActions } from '../../src/lib/actions.ts';
import { RolesTable } from '../../src/ui/RolesTable.tsx';
import { account, lane, snapshot } from '../fixtures.ts';
import { makeT } from '../../../shared/i18n/index.ts';
const VI = makeT('vi');

const T = (h: number, m: number, s = 0, d = 17) => new Date(2026, 10, d, h, m, s).getTime();
const NOW = T(8, 12);
const MAX: Partial<AccountView> = { fiveWindow: true, plan: null };
const ULTRA: Partial<AccountView> = { fiveWindow: false, fivePct: null, fiveResetsAt: null, plan: null };
const ctx = (s: Snapshot, over: Partial<PanelCtx> = {}): PanelCtx => ({ lanes: s.lanes, orchestrators: s.orchestrators, projects: s.projects, projectId: 'p1',
  noNewLanes: {}, login: null, channel: s.channel, now: NOW, quota: s.quota, ...over });
const model = (accs: AccountView[], over: Partial<PanelCtx> = {}, snap: Partial<Snapshot> = {}) => {
  const s = snapshot({ accounts: accs, lanes: [], ...snap });
  return accountPanel(s.accounts, ctx(s, over), VI);
};
const rowOf = (a: AccountView, over: Partial<PanelCtx> = {}, snap: Partial<Snapshot> = {}): PanelRow =>
  model([a], over, snap).groups.flatMap(g => g.rows).find(r => r.email === a.email)!;
const l3 = (r: PanelRow) => r.l3.map(p => p.text);
const html = (s: Snapshot, over: Partial<AccountPanelProps> = {}) => renderToStaticMarkup(<AccountPanel snap={s} projectId="p1" now={NOW} open onToggle={() => {}}
  onAdd={() => {}} onRelogin={() => {}} onCfg={() => {}} onSelectAccount={() => {}} onMenu={() => {}} onCancelLogin={() => {}} hoverEmail={null} onHover={() => {}} {...over} />);

/** ba@ of the 08:05 case: Max, hard 70 %, week 73 % → full by week, stops at 69 %. */
const ba = account('ba@example.net', { ...MAX, role: 'backup', week: 70, hard: true, weekPct: 73, fivePct: 8, headroomPct: 0, full: true,
  weekResetsAt: T(5, 59, 0, 18), fiveResetsAt: T(13, 20), fetchedAt: T(8, 3), nextCheckAt: T(8, 8),
  fullWhy: { window: 'week', by: 'cap', usedPct: 73, cap: 70, leaveAt: 69, hard: true, resetsAt: T(5, 59, 0, 18) } });

describe('§4.5 row text per state', () => {
  test('AC1 Max full by week (hard): reason with the real stop point, reopen time, red only on the week bar, 4 lines at 400 px', () => {
    const r = rowOf(ba);
    expect(r.right).toBe('Đầy');
    expect(r.sub).toBe(''); // mockup AC1: no "chưa có lane" under a full row, line 3 says why
    expect(l3(r)).toEqual(['Đầy: tuần đã dùng 73 % (ngưỡng cứng 70 %, dừng ở 69 %)', '· mở lại 05:59 18/11']);
    expect(r.l3[0]!.tone).toBe('bad');
    expect(r.bars).toEqual([{ win: 'five', used: 8, tone: null, tick: null }, { win: 'week', used: 73, tone: 'f', tick: 69 }]);
    expect(r.h).toBe(86);
    expect(r.aria).toBe('ba@example.net · Đầy · Đầy vì tuần đã dùng 73 % — ngưỡng cứng của account này là 70 %: lane rời ở 69 %, việc mới chỉ nhận tới 67 %.');
  });
  test('UX MINOR-3 AC8 at 380 px the hover buttons cover the number, so the tooltip carries it: "còn N % · tuần: dùng …"', () => {
    const a = account('pm@example.net', { ...MAX, weekPct: 30, headroomPct: 70, fivePct: 10, weekResetsAt: null, fiveResetsAt: null, fetchedAt: T(8, 3) });
    const wk = (r: PanelRow) => r.tip.find(t => t.includes('tuần: dùng'));
    expect(wk(rowOf(a, { narrow: true }))).toMatch(/^còn 70 % · tuần: dùng 30 %/);
    expect(wk(rowOf(a))).toMatch(/^tuần: dùng 30 %/); // 400 px: the number stays visible, the tooltip is unchanged
  });
  test('AC8 at 380 px the hard cap drops out of line 3 (the tooltip keeps the whole sentence)', () => {
    const r = rowOf(ba, { narrow: true });
    expect(l3(r)[0]).toBe('Đầy: tuần đã dùng 73 % (dừng ở 69 %)');
    expect(r.tip[1]).toBe('Đầy vì tuần đã dùng 73 % — ngưỡng cứng của account này là 70 %: lane rời ở 69 %, việc mới chỉ nhận tới 67 %.');
  });
  test('AC5 tooltip: reason (red) / 5 giờ / tuần with "(còn …)" / data time + next check + after reset / Đổi ngưỡng', () => {
    const r = rowOf(ba);
    expect(r.tipBad).toBe(true);
    expect(r.tip.slice(1)).toEqual([
      'Đầy vì tuần đã dùng 73 % — ngưỡng cứng của account này là 70 %: lane rời ở 69 %, việc mới chỉ nhận tới 67 %.',
      '5 giờ: dùng 8 % · reset 13:20 17/11 (còn 5 giờ)',
      'tuần: dùng 73 % · reset 05:59 18/11 (còn 21 giờ)',
      'Số liệu lúc 08:03 · tự cập nhật lúc 08:08 và ngay sau 05:59 18/11',
      'Đổi ngưỡng: ⋯ → Sửa ngưỡng',
    ]);
  });
  test('soft week cap and 5-hour cap wording', () => {
    const soft = rowOf(account('s@x', { full: true, headroomPct: 0, weekPct: 92, week: 90, fullWhy: { window: 'week', by: 'cap', usedPct: 92, cap: 90, leaveAt: 90, hard: false, resetsAt: null } }));
    expect(l3(soft)).toEqual(['Đầy: tuần đã dùng 92 % (ngưỡng 90 %)']);
    const five = rowOf(account('f@x', { full: true, five: 95, fivePct: 96, fullWhy: { window: 'five', by: 'cap', usedPct: 96, cap: 95, leaveAt: 95, hard: false, resetsAt: T(13, 20) } }));
    expect(l3(five)).toEqual(['Đầy: 5 giờ đã dùng 96 % (ngưỡng 95 %)', '· mở lại 13:20 17/11']);
    expect(five.bars.map(b => b.tone)).toEqual(['f', null]); // Max full by 5 h: only the 5-hour bar is red
  });
  test('AC12 Ultra full by week (Anthropic): one bar (week), no 5-hour text anywhere in the row or its tooltip', () => {
    const u = account('b24@example.com', { ...ULTRA, full: true, headroomPct: 0, weekPct: 100, weekResetsAt: T(21, 40, 0, 20), fetchedAt: T(8, 3),
      fullWhy: { window: 'week', by: 'anthropic', usedPct: 100, cap: null, leaveAt: null, hard: false, resetsAt: T(21, 40, 0, 20) } });
    const r = rowOf(u);
    expect(l3(r)).toEqual(['Đầy: Anthropic báo hết lượt tuần', '· mở lại 21:40 20/11']);
    expect(r.bars.map(b => b.win)).toEqual(['week']);
    expect(r.tip.join('\n')).not.toMatch(/5 giờ/);
    const h = html(snapshot({ accounts: [u], lanes: [] }));
    const row = /data-email="b24@example.com".*?<\/span><\/div>/.exec(h)![0];
    expect(row).not.toContain('b5');
    expect(row).not.toContain('5g');
    expect(row).not.toContain('5 giờ');
    expect(h).toContain('dùng % · tuần'); // no Max account → the column header names the week only
    // an Ultra account whose usage reply still carries a 5-hour number: the plan decides (fiveWindow), not the field
    const stray = rowOf(account('u@x', { ...ULTRA, fivePct: 40, fiveResetsAt: T(13, 0), fetchedAt: T(8, 3) }));
    expect(stray.bars.map(b => b.win)).toEqual(['week']);
    expect(stray.tip.join('\n')).not.toMatch(/5 giờ/);
  });
  test('AC7 band 67–69 % (hard): not full, amber "Không nhận việc mới", the lane stop point; week bar amber', () => {
    const r = rowOf(account('kt@x', { week: 70, hard: true, weekPct: 68, fivePct: 20, headroomPct: 1, admitBlock: { usedPct: 68, admitMax: 67, cap: 70, leaveAt: 69 } }));
    expect(r.tone).toBe('warn');
    expect(r.right).toBe('còn 1 %');
    expect(l3(r)).toEqual(['Không nhận việc mới: tuần 68 % > 67 % (ngưỡng cứng 70 %)', '· lane đang chạy dừng ở 69 %']);
    expect(r.l3[0]!.tone).toBe('warn');
    expect(r.bars[1]).toEqual({ win: 'week', used: 68, tone: 'w', tick: 69 });
    expect(r.tip[1]).toContain('Không nhận việc mới vì tuần đã dùng 68 % > 67 %');
  });
  test('AC7 past the reset, not asked again: no "Đầy", "?" dimmed, "5 giờ đã reset … · đang hỏi lại ≈ …"', () => {
    const r = rowOf(account('acc25@x', { full: true, fivePct: 97, weekPct: 40, fullWhy: null, pastReset: { window: 'five', at: T(8, 0), recheckAt: T(8, 4) } }));
    expect(r.right).toBe('?');
    expect(r.dim).toBe(true);
    expect(r.tone).toBe('unk');
    expect(l3(r)).toEqual(['5 giờ đã reset 08:00 17/11', '· đang hỏi lại ≈ 08:04']);
    expect(r.l3[0]!.icon).toBe('clock');
    expect(r.issues).not.toContain('full');
  });
  test('AC7 a failed ask: old numbers kept, amber reason + data time + next try', () => {
    const r = rowOf(account('acc21@x', { fetchedAt: T(7, 41), nextCheckAt: T(8, 8), quotaError: { key: 'errors.quotaTimeout', at: T(8, 2) } }));
    expect(r.tone).toBe('warn');
    expect(l3(r)).toEqual(['Không lấy được số liệu: hết thời gian chờ', '· đang dùng số liệu lúc 07:41 · tự thử lại 08:08']);
    expect(r.right).toBe('còn 51 %');
  });
  test('AC7 needs a probe; no data yet asks for the first time; logged out has no line 3 and no bars', () => {
    expect(l3(rowOf(account('p@x', { status: 'needs_probe', headroomPct: null })))).toEqual(['Đăng nhập cần một lượt chạy thử mới đọc được số liệu · tự chạy khi account rảnh']);
    const first = rowOf(account('n@x', { fetchedAt: null, headroomPct: null, weekPct: null, fivePct: null }), { loadingFresh: new Set(['n@x']) });
    expect(l3(first)).toEqual(['đang hỏi lần đầu…']);
    expect(first.sub).toBe('chưa có số liệu');
    expect(first.right).toBe('?'); // AC7: "?" next to the skeleton, not blank
    const fresh = snapshot({ accounts: [account('n@x', { fetchedAt: null, headroomPct: null, weekPct: null, fivePct: null, refresh: { state: 'fetching', at: null } })], lanes: [] });
    expect(html(fresh, { initialReadyOpen: true })).toContain('<b class="apc">?</b>');
    const out = rowOf(account('o@x', { loggedOut: true, login: 'out' }));
    expect(out.l3).toEqual([]); expect(out.bars).toEqual([]); expect(out.h).toBe(50);
  });
  test('§4.4 refresh states on line 3: queued (≈ HH:MM:SS), fetching, 429 countdown, "✓ vừa cập nhật" after a full reason', () => {
    expect(l3(rowOf(account('q@x', { refresh: { state: 'queued', at: T(8, 12, 40) } })))).toEqual(['chờ lượt · ≈ 08:12:40']);
    expect(l3(rowOf(account('q@x', { refresh: { state: 'queued', at: T(8, 13) } })))).toEqual(['chờ lượt · ≈ 08:13']);
    expect(l3(rowOf(account('f@x', { refresh: { state: 'fetching', at: null } })))).toEqual(['đang hỏi…']);
    expect(l3(rowOf(account('q@x', { refresh: { state: 'queued', at: T(8, 13) } }), {}, { quota: { cooldownUntil: NOW + 100_000, queueEndsAt: null } }))).toEqual(['thử lại sau 1:40']);
    expect(l3(rowOf(ba, { justUpdated: new Map([[ba.email, NOW]]) }))).toEqual(['Đầy: tuần đã dùng 73 % (ngưỡng cứng 70 %, dừng ở 69 %)', '· mở lại 05:59 18/11', 'vừa cập nhật 08:12']);
    // a soft note gives way to the state (AC2: bo24990 "sắp hết" → "đang hỏi…")
    expect(l3(rowOf(account('l@x', { headroomPct: 6, weekResetsAt: T(21, 40, 0, 20) })))).toEqual(['sắp hết', '· reset tuần 21:40 20/11']);
    expect(l3(rowOf(account('l@x', { headroomPct: 6, refresh: { state: 'fetching', at: null } })))).toEqual(['đang hỏi…']);
  });
  test('AC5 "5 giờ vừa reset … · đã tự cập nhật …" right after a reset', () => {
    const r = rowOf(account('bin@x', { fiveResetsAt: T(13, 0), fetchedAt: T(8, 4) }));
    expect(l3(r)).toEqual(['5 giờ vừa reset 08:00 17/11 · đã tự cập nhật 08:04']);
    expect(l3(rowOf(account('u@x', { ...ULTRA, fiveResetsAt: T(13, 0), fetchedAt: T(8, 4) })))).toEqual([]); // Ultra: no 5-hour window
    expect(l3(rowOf(account('old@x', { fiveResetsAt: T(13, 0), fetchedAt: T(8, 1) })))).toEqual([]); // shown 10 min after the ask only
  });
  test('§4.3 row heights 2 / 3 / 4 lines go into the virtual window', () => {
    const accs = Array.from({ length: 61 }, (_, i) => (i === 0 ? ba : account(`a${i}@x`)));
    const items = panelItems(model(accs, {}), { readyOpen: true, filter: '' });
    const w = virtualWindow(items, 0, 600);
    expect(w.virtual).toBe(true);
    expect(w.total).toBe(30 + 86 + 30 + 28 + 60 * 50);
  });
});

describe('§4.3 L5 header "cập nhật HH:MM" and §4.4 refresh', () => {
  const accs = [account('pm@x', { fetchedAt: T(8, 3), nextCheckAt: T(8, 8) }), account('new@x', { fetchedAt: T(8, 12) }),
    account('err@x', { fetchedAt: T(7, 41), quotaError: { key: 'errors.quotaTimeout', at: T(8, 2) } }), account('none@x', { fetchedAt: null, headroomPct: null }),
    account('out@x', { loggedOut: true, login: 'out', fetchedAt: T(6, 0) })];
  test('oldest fetch of logged-in accounts with numbers and no error; tooltip names oldest / newest / skipped / next', () => {
    const h = model(accs).head;
    expect(h.label).toBe('cập nhật 08:03');
    expect(h.tip).toEqual(['Cũ nhất: pm@x lúc 08:03 · mới nhất 08:12', 'Không tính account đang lỗi (err@x: số liệu lúc 07:41) và account chưa có số liệu.', 'Tự cập nhật tiếp lúc 08:08']);
    expect(h.btn).toEqual({ text: 'Làm mới', tip: 'Làm mới số liệu mọi account', off: false, busy: false });
  });
  test('§5 ≤ 100 ms: the click (before the ack) already reads "đang làm mới…"; with the batch "đang làm mới 2/5" + the band', () => {
    expect(model(accs, { pending: { all: true, rows: new Set() } }).head.label).toBe('đang làm mới…');
    const q = (state: 'queued' | 'fetching' | 'idle', i: number) => account(`a${i}@x`, { refresh: { state, at: state === 'queued' ? T(8, 13) : null } });
    const five = [q('idle', 1), q('fetching', 2), q('queued', 3), q('queued', 4), q('queued', 5)];
    const h = model(five, { batch: five.map(a => a.email) }, { quota: { cooldownUntil: null, queueEndsAt: T(8, 14) } }).head;
    expect(h.label).toBe('đang làm mới 2/5');
    expect(h.btn).toMatchObject({ text: 'Đang làm mới', off: true, busy: true });
    expect(h.band).toEqual({ kind: 'queue', text: 'Hỏi Anthropic lần lượt từng account, cách nhau 20 giây để không bị chặn.', muted: 'Xong hết lúc ≈ 08:14.' });
  });
  test('AC3 429: the band says until when, the button counts down dimmed', () => {
    const h = model(accs, {}, { quota: { cooldownUntil: NOW + 100_000, queueEndsAt: null } }).head;
    expect(h.btn).toMatchObject({ text: 'Thử lại sau 1:40', off: true });
    expect(h.band).toEqual({ kind: 'blocked', text: 'Anthropic tạm chặn lượt hỏi số liệu tới 08:13. Lane vẫn chạy bình thường — chỉ con số chưa mới.', muted: 'Đang dùng số liệu lúc 08:03.' });
  });
  test('D101 the row ⟳ is dimmed < 60 s after the last ask; queued → "đang chờ lượt ≈ …"; offline dimmed with the reason', () => {
    expect(rowOf(account('r@x', { fetchedAt: NOW - 30_000 })).refresh).toEqual({ off: true, tip: 'Vừa cập nhật lúc 08:11 — làm mới lại được lúc 08:12' });
    expect(rowOf(account('r@x', { fetchedAt: NOW - 61_000 })).refresh).toEqual({ off: false, tip: 'Làm mới số liệu · r@x' });
    expect(rowOf(account('r@x', { refresh: { state: 'queued', at: T(8, 12, 40) } })).refresh).toEqual({ off: false, tip: 'đang chờ lượt ≈ 08:12:40' });
    expect(rowOf(account('r@x'), { offline: true }).refresh).toEqual({ off: true, tip: 'Mất kết nối' });
    const h = html(snapshot({ accounts: [account('r@x', { fetchedAt: NOW - 30_000 })], lanes: [] }), { initialReadyOpen: true });
    expect(h).toMatch(/<button[^>]*class="ib aref"[^>]*disabled=""/);
  });
  test('AC9 remote: no ⟳ in the header or rows, no "+", label "cập nhật … · tự cập nhật mỗi 5 phút"', () => {
    const m = model(accs, { channel: 'remote' });
    expect(m.head.btn).toBeNull();
    expect(m.head.label).toBe('cập nhật 08:03 · tự cập nhật mỗi 5 phút');
    expect(m.groups.flatMap(g => g.rows).every(r => r.refresh === null)).toBe(true);
    const h = html(snapshot({ channel: 'remote', accounts: accs, lanes: [] }));
    expect(h).not.toContain('aref');
    expect(h).not.toContain('aadd');
    const mac = html(snapshot({ accounts: accs, lanes: [] }));
    expect(mac).toContain('class="acb aref"');
  });
  test('UX MINOR-5 AC11 429: the card tooltip keeps "số liệu lúc HH:MM" (the header\'s oldest fetch)', () => {
    const m = model(accs, {}, { quota: { cooldownUntil: NOW + 60_000, queueEndsAt: null } });
    expect(m.collapsedTip[1]).toBe('Anthropic tạm chặn lượt hỏi tới 08:13 · số liệu lúc 08:03 · bấm để mở · phím A');
  });
  test('AC6 offline: "Mất kết nối · số liệu lúc HH:MM" and a dimmed icon-only ⟳', () => {
    const h = model(accs, { offline: true }).head;
    expect(h.label).toBe('Mất kết nối · số liệu lúc 08:03');
    expect(h.btn).toEqual({ text: null, tip: 'Mất kết nối', off: true, busy: false });
  });
  test('AC11 collapsed card: line 2 = data time · hint; busy → spinning arc + "xong ≈"; 429 → ⏸', () => {
    expect(model(accs).collapsedTip[1]).toBe('cập nhật 08:03 · bấm để mở · phím A');
    const busy = model(accs, { pending: { all: true, rows: new Set() } }, { quota: { cooldownUntil: null, queueEndsAt: T(8, 14) } });
    expect(busy.collapsedTip[1]).toBe('đang làm mới… · xong ≈ 08:14');
    const s = snapshot({ accounts: accs, lanes: [], quota: { cooldownUntil: NOW + 60_000, queueEndsAt: null } });
    const card = html(s, { open: false });
    expect(card).toContain('⏸');
    expect(card).toContain('Anthropic tạm chặn lượt hỏi tới 08:13');
  });
  test('§4.4 freshlyUpdated: fetching → idle with a new fetchedAt only', () => {
    const prev = new Map([['a@x', { state: 'fetching', at: 1 }], ['b@x', { state: 'fetching', at: 5 }], ['c@x', { state: 'queued', at: 1 }]]);
    expect(freshlyUpdated(prev, [account('a@x', { fetchedAt: 9 }), account('b@x', { fetchedAt: 5 }), account('c@x', { fetchedAt: 9 })])).toEqual(['a@x']);
  });
});

describe('§4.7 parity: column header, tags, ⋯ menu', () => {
  test('column header "dùng % · 5 giờ / tuần" when an account is Max', () => {
    expect(model([ba]).cols).toBe('dùng % · 5 giờ / tuần');
  });
  test('the orchestrator row says "Điều phối #n"; a free account "chưa có lane"', () => {
    const s = snapshot({ accounts: [account('o@x'), account('free@x')], lanes: [] });
    s.orchestrators = [{ ...s.orchestrators[0]!, account: 'o@x', seq: 1 }];
    const rows = accountPanel(s.accounts, ctx(s), VI).groups.flatMap(g => g.rows);
    expect(rows.find(r => r.email === 'o@x')!.sub).toBe('Điều phối #1');
    expect(rows.find(r => r.email === 'free@x')!.sub).toBe('chưa có lane');
  });
  test('AC4 ⋯ "Làm mới số liệu" second in the menu with "lần trước HH:MM"; none on remote or for a logged-out account', () => {
    const s = snapshot({ accounts: [account('pm@x', { fetchedAt: T(8, 3) })], lanes: [lane('D1', { account: 'pm@x' })] });
    const items = accountActions(s.accounts[0]!, { tr: VI, snap: s, now: NOW } as Parameters<typeof accountActions>[1]);
    expect(items[1]).toMatchObject({ id: 'refresh', label: 'Làm mới số liệu', hint: 'lần trước 08:03', act: { t: 'acc', a: 'refresh', email: 'pm@x' } });
    const remote = { ...s, channel: 'remote' as const };
    expect(accountActions(s.accounts[0]!, { tr: VI, snap: remote, now: NOW } as Parameters<typeof accountActions>[1]).some(i => i.id === 'refresh')).toBe(false);
    expect(accountActions(account('o@x', { loggedOut: true, login: 'out' }), { tr: VI, snap: s, now: NOW } as Parameters<typeof accountActions>[1]).some(i => i.id === 'refresh')).toBe(false);
  });
});

describe('review-b MINOR-2 ⋯ "Làm mới số liệu" 60 s floor (D101, same as the row ⟳)', () => {
  test('< 60 s after the last ask: dimmed with "Vừa cập nhật lúc … — làm mới lại được lúc …"; at 60 s live again', () => {
    const s = snapshot({ accounts: [], lanes: [] });
    const item = (fetchedAt: number) => accountActions(account('pm@x', { fetchedAt }), { tr: VI, snap: s, now: NOW } as Parameters<typeof accountActions>[1]).find(i => i.id === 'refresh')!;
    expect(item(NOW - 10_000).disabled).toBe('Vừa cập nhật lúc 08:11 — làm mới lại được lúc 08:12');
    expect(item(NOW - 59_999).disabled).toBeTruthy();
    expect(item(NOW - 60_000).disabled).toBeUndefined();
    expect(item(NOW - 60_000).hint).toBe('lần trước 08:11');
  });
});

describe('D103 Roles table', () => {
  test('Ultra shows the week only (no "5h ?"); Max keeps both', () => {
    const accs = [account('u@x', { ...ULTRA, weekPct: 40 }), account('m@x', { weekPct: 48, fivePct: 31 })];
    const rows = accs.map(a => ({ email: a.email, role: 'primary' as const, week: 99, hard: false, five: '', maxLanes: 4 }));
    const h = renderToStaticMarkup(<RolesTable rows={rows} accounts={accs} current={{ now: NOW, base: rows }} onChange={() => {}} />);
    expect(h).toContain('>40 %<');
    expect(h).not.toContain('5h ?');
    expect(h).toContain('48 % · 5h 31 %');
  });
  test('review-b MINOR-1 an Ultra row has no 5-hour cap field; the "5h" header only when some row is Max', () => {
    const u = account('u@x', { ...ULTRA, weekPct: 40 }), m = account('m@x', { weekPct: 48, fivePct: 31 });
    const rowsOf = (accs: AccountView[]) => accs.map(a => ({ email: a.email, role: 'primary' as const, week: 99, hard: false, five: '', maxLanes: 4 }));
    const html = (accs: AccountView[]) => renderToStaticMarkup(<RolesTable rows={rowsOf(accs)} accounts={accs} onChange={() => {}} />);
    const mixed = html([u, m]);
    expect(mixed).not.toContain('aria-label="Ngưỡng 5h u@x"');
    expect(mixed).toContain('aria-label="Ngưỡng 5h m@x"');
    expect(mixed).toContain('<th>5h</th>');
    expect(mixed.match(/<tr>/g)?.length).toBe(3); // header + 2 rows
    expect(mixed.match(/<td/g)?.length).toBe(10); // the Ultra row keeps its cell (empty): columns stay aligned
    const ultraOnly = html([u]);
    expect(ultraOnly).not.toContain('<th>5h</th>');
    expect(ultraOnly).not.toContain('Ngưỡng 5h');
    expect(ultraOnly.match(/<td/g)?.length).toBe(4);
  });
});
