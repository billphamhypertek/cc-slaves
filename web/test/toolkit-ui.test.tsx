// v2.5 §6 TK2 / TK2-upd / TK1-chk / TK1-off / TK1-git the Bộ công cụ tab and the wizard step 3 (TK1 frames), rendered
// statically in vi and en.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../shared/i18n/index.ts';
import type { ToolkitRow, ToolkitView } from '../../shared/toolkit.ts';
import { LangProvider, type Lang } from '../src/lib/i18n.tsx';
import { ToolkitStep, ToolkitTab } from '../src/ui/Toolkit.tsx';

const html = (el: ReactElement, lang: Lang = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\u00a0/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const r = (key: ToolkitRow['key'], over: Partial<ToolkitRow> = {}): ToolkitRow => ({ key, kind: 'plugin', id: `${key}@claude-plugins-official`, state: 'installed', version: '1.0.0', mcpLoginIds: [], ...over });
const TK2: ToolkitView = {
  rows: [r('superpowers', { state: 'outdated', version: '7.0.0' }), r('ui-ux-pro-max', { id: 'ui-ux-pro-max@ui-ux-pro-max-skill', state: 'missing', version: undefined }),
    r('context7', { state: 'needs_login', version: 'b5b01ac4f889', mcpLoginIds: ['plugin:context7@claude-plugins-official:context7'] }),
    r('vercel', { state: 'needs_login', version: '0.50.0', mcpLoginIds: ['plugin:vercel@claude-plugins-official:vercel'] })],
  checkedAt: new Date(2026, 10, 17, 14, 2).getTime(),
};
const tab = (view: ToolkitView | undefined, lang: Lang = 'vi', connected = true) =>
  html(<ToolkitTab view={view} mcp={null} connected={connected} send={() => Promise.resolve()} toast={() => {}} onLogin={() => {}} onGraph={() => {}} onGraphUpdate={() => {}} />, lang);
const rowText = (h: string, key: string) => text(h.split(`data-key="${key}"`)[1]!.split('data-key=')[0]!);

describe('§6 TK2 the Bộ công cụ tab', () => {
  test('TK2 the graph tool row has "Mở Graph code" in the tab (any state), never in the wizard step 3', () => {
    const graph = (state: ToolkitRow['state']) => ({ rows: [r('graph', { kind: 'graph', id: undefined, state, version: state === 'missing' ? undefined : '0.12.1' })], checkedAt: TK2.checkedAt });
    expect(rowText(tab(graph('installed')), 'graph')).toMatch(/Đã cài 0\.12\.1 Mở Graph code/);
    expect(rowText(tab(graph('missing')), 'graph')).toMatch(/Chưa cài Cài Mở Graph code/);
    expect(rowText(tab(graph('installed'), 'en'), 'graph')).toContain('Open Graph code');
    expect(rowText(step(graph('installed')), 'graph')).not.toContain('Mở Graph code');
    expect(rowText(tab(TK2), 'superpowers')).not.toContain('Mở Graph code');
  });
  test('TK2: summary + "Kiểm tra", heads "Mục / Trạng thái", one plain button per row by state', () => {
    const h = tab(TK2);
    expect(text(h)).toContain('4 mục · 3 đã cài · 1 chưa cài · 1 có bản mới · 2 cần đăng nhập · kiểm tra lúc 14:02 Kiểm tra');
    expect(text(h)).toContain('Mục Trạng thái');
    expect(rowText(h, 'superpowers')).toContain('superpowers claude-plugins-official Quy trình làm việc cho lane: brainstorm, viết test trước, review. Có hook. Có bản mới (đang dùng 7.0.0 ) Cập nhật'); // the version is a <code> (mono)
    expect(h.split('data-key="superpowers"')[1]!.split('data-key=')[0]).toContain('(đang dùng <code>7.0.0</code>)');
    const sp = h.split('data-key="superpowers"')[1]!.split('data-key=')[0]!;
    expect(sp.split('class="tka"')[0]).toContain('<path d="m16 12-4-4-4 4"/>'); // the status: an up-arrow circle, not the button's refresh
    expect(sp.split('class="tka"')[1]).toContain('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/>');
    expect(tab({ rows: [r('context7', { state: 'disabled' })], checkedAt: 1 })).toContain('(bật lại bằng <code class="chip">/plugin</code>)');
    expect(rowText(h, 'ui-ux-pro-max')).toContain('ui-ux-pro-max nextlevelbuilder/ui-ux-pro-max-skill');
    expect(rowText(h, 'ui-ux-pro-max')).toContain('Chưa cài Cài');
    expect(rowText(h, 'context7')).toContain('Cần đăng nhập (OAuth) Đăng nhập');
    expect(rowText(h, 'vercel')).toContain('vercel claude-plugins-official 156 MB');
    expect(h).not.toContain('btn pri'); // §6 "Nút": row buttons and "Kiểm tra" are plain buttons
  });
  test('TK2-upd: "Đã cập nhật 7.0.2 · áp dụng từ lần chạy sau của mỗi lane", no button, summary without "có bản mới"', () => {
    const h = tab({ rows: [r('superpowers', { version: '7.0.2', updated: true })], checkedAt: TK2.checkedAt });
    expect(rowText(h, 'superpowers')).toContain('Đã cập nhật 7.0.2 · áp dụng từ lần chạy sau của mỗi lane');
    expect(rowText(h, 'superpowers')).not.toContain('Cập nhật ');
    expect(text(h)).not.toContain('có bản mới');
  });
  test('no view yet → the loading line at once; TK1-chk: never checked → the open check runs, a bar in place of each state', () => {
    expect(text(tab(undefined))).toContain('Đang kiểm tra máy này…');
    const chk = tab({ rows: TK2.rows });
    expect(text(chk)).toContain('Đang kiểm tra máy này… Kiểm tra');
    expect(chk.match(/class="tkskel"/g)?.length).toBe(4);
    expect(rowText(chk, 'superpowers')).not.toContain('Có bản mới');
  });
  test('TK1-off: offline band with the time + "Kiểm tra lại"; other errors show their line', () => {
    expect(text(tab({ ...TK2, checkError: { code: 'offline', line: 'x' } }))).toContain('Không kiểm tra được bản mới — mất mạng · kiểm lúc 14:02 Kiểm tra lại');
    expect(text(tab({ rows: [], checkError: { code: 'unknown', line: 'bad json' } }))).toContain('Không kiểm tra được bản mới: bad json Kiểm tra lại');
    expect(tab({ rows: [], checkError: { code: 'unknown', line: 'bad json' } })).toContain('<code>bad json</code>'); // the error line mono
  });
  test('TK1-git: rows "Cần git", no row button; the band names the cause with its own buttons', () => {
    const missing = tab({ rows: [r('vercel', { state: 'failed', version: undefined, error: { code: 'git_missing', line: '' } })], checkedAt: 1 });
    expect(text(missing)).toContain('Chưa có git — 4 plugin cần git để cài Cài git Kiểm tra lại');
    expect(rowText(missing, 'vercel')).toContain('Cần git');
    expect(rowText(missing, 'vercel')).not.toContain('Thử lại');
    expect(text(tab({ rows: [r('vercel', { state: 'failed', error: { code: 'git_license', line: '' } })] }))).toContain('sudo xcodebuild -license trong Terminal rồi Kiểm tra lại Chép lệnh Kiểm tra lại');
    expect(tab({ rows: [r('vercel', { state: 'failed', error: { code: 'git_license', line: '' } })] })).toContain('<code class="chip">sudo xcodebuild -license</code>');
  });
  test('engine lost → the v2.2 band and every button off (§6 *-lost)', () => {
    const h = tab({ ...TK2, rows: [...TK2.rows, r('graph', { kind: 'graph', id: undefined, version: '0.8.1', state: 'outdated', latest: '0.12.1' })] }, 'vi', false);
    expect(text(h)).toContain('Mất kết nối engine');
    const btns = h.match(/<button[^>]*>/g) ?? [];
    expect(btns.length).toBeGreaterThan(4);
    expect(btns.filter(b => !b.includes('disabled'))).toEqual([]);
  });
  test('English TK2', () => {
    const h = tab(TK2, 'en');
    expect(text(h)).toContain('4 items · 3 installed · 1 not installed · 1 update available · 2 need login · checked at 14:02 Check');
    expect(rowText(h, 'context7')).toContain('Needs login (OAuth) Log in');
  });
});

const miss = (key: ToolkitRow['key'], over: Partial<ToolkitRow> = {}) =>
  r(key, { state: 'missing', version: undefined, commands: [`claude plugin install ${over.id ?? `${key}@claude-plugins-official`}`], ...over });
const TK1: ToolkitView = { rows: [miss('superpowers'), miss('ui-ux-pro-max', { id: 'ui-ux-pro-max@ui-ux-pro-max-skill' }), miss('context7'), miss('vercel')], checkedAt: 1 };
const step = (view: ToolkitView | undefined, lang: Lang = 'vi') =>
  html(<ToolkitStep view={view} mcpView={undefined} projects={[]} graph={undefined} send={() => Promise.resolve()} toast={() => {}} onBack={() => {}} onNext={() => {}} />, lang);
const foot = (h: string) => text((h.split('class="mf"')[1] ?? '').slice(1));
const pri = (h: string) => /<button[^>]*class="btn pri"[^>]*>(.*?)<\/button>/.exec(h.split('class="mf"')[1] ?? '');

describe('§6 TK1 the wizard step 3 (same list component as the tab)', () => {
  test('TK1: every missing row ticked (D70), no row "Cài"; foot Quay lại · Để sau · "Cài 4 mục" (primary); "Sẽ chạy" closed', () => {
    const h = step(TK1);
    expect(h.match(/type="checkbox"[^>]*checked/g)?.length).toBe(4);
    expect(rowText(h, 'vercel')).toContain('Chưa cài');
    expect(rowText(h, 'vercel')).not.toContain('Chưa cài Cài');
    expect(foot(h).trim()).toBe('Quay lại Để sau Cài 4 mục');
    expect(pri(h)?.[0]).not.toContain('disabled');
    expect(text(h)).toContain('Sẽ chạy: claude plugin install …');
    expect(text(h)).not.toContain('marketplace add'); // TK1-cmd opens on click
  });
  test('"Sẽ chạy" closed names what the picked rows run: plugins and / or the graph tool installer (TK1, TK1-git)', () => {
    const g = r('graph', { kind: 'graph', id: undefined, state: 'missing', version: undefined, commands: ['curl … | bash'] });
    expect(text(step({ ...TK1, rows: [...TK1.rows, g] }))).toContain('Sẽ chạy: claude plugin install … · bộ cài của codebase-memory-mcp');
    expect(text(step({ ...TK1, rows: [g] }))).toContain('Sẽ chạy: bộ cài của codebase-memory-mcp');
    expect(text(step({ ...TK1, rows: [g] }))).not.toContain('claude plugin install');
    expect(text(step({ ...TK1, rows: [...TK1.rows, g] }, 'en'))).toContain("Will run: claude plugin install … · codebase-memory-mcp &#x27;s installer"); // static markup escapes the apostrophe
  });
  test('TK1-chk: never checked → the checking line, a bar per state, "Cài" without a number and off; "Để sau" works', () => {
    const h = step({ rows: TK1.rows });
    expect(text(h)).toContain('Đang kiểm tra máy này…');
    expect(h.match(/class="tkskel"/g)?.length).toBe(4);
    expect(foot(h).trim()).toBe('Quay lại Để sau Cài');
    expect(pri(h)?.[0]).toContain('disabled');
    expect(text(step(undefined))).toContain('Đang kiểm tra máy này…'); // no view yet
  });
  test('TK1-run: spinner + "Đang cài…" + the row\'s last 4 log lines; waiting "Chờ"; note; foot Quay lại off · Tiếp', () => {
    const log = ['l1', '$ claude plugin install vercel@claude-plugins-official --json', 'Cloning into …', 'Receiving objects: 61%', 'Resolving deltas: 12%'];
    const h = step({ rows: [r('superpowers', { version: '7.0.2' }), miss('vercel', { state: 'running', log }), miss('context7', { state: 'running' })], busy: 'vercel', checkedAt: 1 });
    expect(rowText(h, 'vercel')).toContain('Đang cài…');
    expect(rowText(h, 'vercel')).toContain('Receiving objects: 61%');
    expect(rowText(h, 'vercel')).not.toContain('l1');
    expect(rowText(h, 'context7')).toContain('Chờ');
    expect(text(h)).toContain('Bấm Tiếp thì việc cài vẫn chạy; phần còn lại xem ở Skills & MCP › Bộ công cụ.');
    expect(foot(h).trim()).toBe('Quay lại Tiếp');
    expect(h.split('class="mf"')[1]).toMatch(/<button class="btn" disabled="">Quay lại/);
    expect(pri(h)?.[1]).toBe('Tiếp');
  });
  test('TK1-done: "Đăng nhập" on the login rows, the "Đăng nhập sau" note, primary "Tiếp"', () => {
    const h = step({ rows: [r('superpowers'), r('context7', { state: 'needs_login', mcpLoginIds: ['plugin:context7@claude-plugins-official:context7'] })], checkedAt: 1 });
    expect(rowText(h, 'context7')).toContain('Cần đăng nhập (OAuth) Đăng nhập');
    expect(text(h)).toContain('Đăng nhập sau cũng được, ở Skills & MCP › Bộ công cụ.');
    expect(pri(h)?.[1]).toBe('Tiếp');
    expect(h).not.toContain('type="checkbox"');
  });
  test('TK1-all: "Máy này đã có đủ n mục." on top; a commit-id version in brackets', () => {
    const h = step({ rows: [r('superpowers', { version: '7.0.2' }), r('context7', { version: 'b5b01ac4f889aaaa' })], checkedAt: 1 });
    expect(text(h)).toContain('Máy này đã có đủ 2 mục.');
    expect(h).toMatch(/<p class="tkall st ok"[^>]*><svg[^>]*><circle cx="12" cy="12" r="10"\/><path d="m9 12 2 2 4-4"\/>/); // ✓ --ok, a status not a heading
    expect(rowText(h, 'context7')).toContain('Đã cài (b5b01ac)');
  });
  test('TK1-fail: cause + "Thử lại" + "Xem log" (log closed); other rows stay installed', () => {
    const h = step({ rows: [r('superpowers'), miss('vercel', { state: 'failed', error: { code: 'offline', line: 'x' }, log: ['fatal: unable to access'] })], checkedAt: 1 });
    expect(rowText(h, 'vercel')).toContain('Không tải được — kiểm tra mạng / VPN Thử lại Xem log');
    expect(h).not.toContain('fatal: unable to access');
    expect(rowText(h, 'superpowers')).toContain('Đã cài 1.0.0');
  });
  test('TK1-off: the offline band; ticks stay, "Cài n mục" off with "Cần mạng để cài"; TK1-off-err keeps it on', () => {
    const off = step({ ...TK1, checkError: { code: 'offline', line: 'x' } });
    expect(text(off)).toContain('Không kiểm tra được bản mới — mất mạng');
    expect(pri(off)?.[0]).toContain('disabled');
    expect(pri(off)?.[0]).toContain('title="Cần mạng để cài"');
    expect(pri(step({ ...TK1, checkError: { code: 'unknown', line: 'bad json' } }))?.[0]).not.toContain('disabled');
  });
  test('TK1-git: band + rows "Cần git" without a tick; "Cài n mục" counts only installable rows', () => {
    const g = { code: 'git_missing' as const, line: '' };
    const h = step({ rows: [miss('superpowers', { state: 'failed', error: g }), miss('vercel', { state: 'failed', error: g }), miss('context7')], checkedAt: 1 });
    expect(text(h)).toContain('Chưa có git — 4 plugin cần git để cài Cài git Kiểm tra lại');
    expect(rowText(h, 'vercel')).toContain('Cần git');
    expect(h.match(/type="checkbox"/g)?.length).toBe(3); // §6.1 "ô chọn tắt": the "Cần git" rows keep an empty, disabled box
    const box = (k: string) => h.split(`data-key="${k}"`)[1]!.split('data-key=')[0]!.match(/<input[^>]*>/)![0];
    for (const k of ['superpowers', 'vercel']) { expect(box(k)).toContain('disabled=""'); expect(box(k)).not.toContain('checked'); }
    expect(box('context7')).not.toContain('disabled');
    expect(foot(h).trim()).toBe('Quay lại Để sau Cài 1 mục');
  });
  test('English TK1', () => {
    expect(foot(step(TK1, 'en')).trim()).toBe('Back Later Install 4 items');
    expect(text(step(TK1, 'en'))).toContain('Will run: claude plugin install …');
  });
});
