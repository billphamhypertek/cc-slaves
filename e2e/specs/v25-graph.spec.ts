// v2.5 §6 / §8 E2E the Graph code tab (lane G5a), light + dark: GR1 and its row states, T4 "Index lại" (spins ≤ 100 ms) →
// GR1-run, T7 switch → GR1-offp, T8 "Dọn…" → GR-clean (+ list) → "Dọn 92 index" with exactly the listed roots → -run → -done,
// T5 GR0-old → GR-upd (from old) → GR-run → GR1, GR1-new → GR-upd-ready, GR0, GR-err, GR-err-upd, GR-empty → Cài đặt › Project.
// G5b: K1-graph (the user's codebase-memory-mcp row locked → Graph code), Z20 (row "Đăng nhập" a plain button), GR-k0 (ⓘ2 → ⓘ3,
// hover line, the number opens the first tab with an issue), ⌘K "Bộ công cụ" / "Graph code", TK2 "Mở Graph code".
// Real e2e engine for the sheet; the graph side is the scripted engine of e2e/v25-graph-mock.ts (the real tool never runs).
// Shots (`E2E_SHOTS=1`) go to .e2e-results/v25-g6/<frame>[-1024][-dark].png (e2e/v25-graph-mock.ts `v25Shot`), never into docs/.
import type { Locator, Page } from '@playwright/test';
import { Clicks, expect, msUntil, recordBudget, test, useEngine } from '../fixtures.ts';
import { installCmd, mcpRow, mockGraph, mockupView, needsLogin, ORPHANS, v25Shot } from '../v25-graph-mock.ts';
import type { GraphView } from '../../shared/graph.ts';
import type { ToolkitRow, ToolkitView } from '../../shared/toolkit.ts';

const row = (sheet: Locator, name: string) => sheet.locator(`.grr[data-project="${name}"]`);
/** No row, cell, button or dialog wider than its box. */
const noSideways = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.grtab, .grr, .grr .btn, .grs, .grlast, .grd, .grd .btn, .gr0')]
  .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className));
const view = (f: (v: GraphView) => void = () => {}): GraphView => { const v = mockupView(); f(v); return v; };
const MCP_ROWS = [needsLogin('context7'), needsLogin('vercel'), mcpRow('onedevtool'),
  mcpRow('codebase-memory-mcp', { config: { command: '/Users/po/.local/bin/codebase-memory-mcp' }, tools: 17, forLanes: false })];
const tk = (key: ToolkitRow['key'], over: Partial<ToolkitRow> = {}): ToolkitRow => ({ key, kind: 'plugin', id: `${key}@claude-plugins-official`, state: 'installed', version: '1.0.0', mcpLoginIds: [], ...over });
const TOOLKIT: ToolkitView = { rows: [tk('superpowers', { version: '7.0.2' }), tk('context7', { state: 'needs_login', version: 'b5b01ac4f889', mcpLoginIds: ['plugin:context7@claude-plugins-official:context7'] }),
  tk('graph', { kind: 'graph', id: undefined, version: '0.12.1' })], checkedAt: new Date(2026, 10, 18, 14, 2).getTime() };

for (const theme of ['light', 'dark'] as const) {
  test.describe(`§6 Graph code tab (${theme}, scripted graph engine)`, () => {
    test.describe.configure({ mode: 'serial' });
    const eng = useEngine();
    test.use({ viewport: { width: 1440, height: 900 }, theme });

    async function open(page: Page, c: Clicks): Promise<Locator> {
      await page.goto(eng.url());
      await c.on(page.locator('#top .smk-l'));
      const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
      await c.on(sheet.getByRole('tab', { name: /^Graph code/ }));
      await expect(sheet.locator('.grtab')).toBeVisible();
      return sheet;
    }
    /** 1440 × 900 and 1024 × 640 (the 1024 one is the frame's -narrow), each checked for sideways overflow. */
    const shot = (page: Page, frame: string) => v25Shot(page, frame, theme, async w => { expect(await noSideways(page), `${frame} ${w}`).toEqual([]); });

    test('GR1 → T4 "Index lại" spins ≤ 100 ms → GR1-run; T7 switch → GR1-offp; GR1-states / -nogit', async ({ page }) => {
      const g = await mockGraph(page, view());
      const t4 = new Clicks(page);
      const sheet = await open(page, t4);
      await expect(sheet.getByRole('tab', { name: /^Graph code/ })).toHaveText(/Graph code\s*6$/);
      await expect(sheet.locator('.grh1 > *')).toHaveText(['codebase-memory-mcp 0.12.1', 'mới nhất', 'kiểm tra lúc 14:02']); // the dots are CSS
      await expect(sheet.locator('.grsum > span')).toHaveText(['6 project', '5 đã index', '2,0 GB (gồm thư mục lane)']);
      await expect(row(sheet, 'cc-slaves')).toContainText('Đã index · 15.899 node · 101 MB · 14:02 16/11');
      await expect(row(sheet, 'cc-slaves')).toContainText('3 thư mục lane · 310 MB');
      await expect(sheet.locator('.grlast')).toHaveText('Index trên máy: 140 · 10,0 GB — 92 của thư mục đã xoá (7,7 GB) Dọn…');
      expect(g.sent[0]).toEqual({ cmd: 'graph_check' }); // opening the tab checks (no force)
      // BANNED look: a hovered row is a neutral grey step, never a coloured border / shadow
      await row(sheet, 'h-ops').hover();
      expect(await row(sheet, 'h-ops').evaluate(el => { const s = getComputedStyle(el); return { l: s.borderLeftWidth, sh: s.boxShadow }; })).toEqual({ l: '0px', sh: 'none' });
      await shot(page, 'GR1');

      const hg = row(sheet, 'hagenta');
      const ms = await msUntil(page, () => t4.on(hg.getByRole('button', { name: 'Index lại' })), { spin: `document.querySelector('.grr[data-project="hagenta"] .spin')` });
      expect(ms.spin).toBeLessThan(100);
      await expect(hg).toContainText(/Đang index · 0:0\d · lane vẫn dùng index cũ/);
      await expect(hg.getByRole('button', { name: 'Dừng' })).toBeVisible();
      await expect(hg.locator('.grsub .old')).toHaveText('153.761 node · 820 MB · 13:40 16/11');
      expect(g.sent).toContainEqual({ cmd: 'graph_index', projectId: 'p-hagenta' });
      expect(t4.n).toBe(3);
      recordBudget(`v25 T4 graph reindex (${theme})`, t4.n, 3);
      g.set(v => { Object.assign(v.projects[2]!, { state: 'queued', ahead: 1 }); });
      await expect(row(sheet, 'h-cowork')).toContainText('Chờ tới lượt (đang index hagenta)');
      await shot(page, 'GR1-run');

      const t7 = new Clicks(page);
      const s7 = await open(page, t7);
      await t7.on(s7.getByRole('switch', { name: 'Lane dùng graph trong hagent-os' }));
      await expect(row(s7, 'hagent-os')).toContainText('Tắt cho lane · lane vẫn tìm bằng grep / đọc file');
      await expect(row(s7, 'hagent-os').getByRole('button')).toHaveCount(0);
      expect(g.sent).toContainEqual({ cmd: 'graph_toggle', projectId: 'p-hagent-os', on: false });
      expect(t7.n).toBe(3);
      recordBudget(`v25 T7 graph lane switch (${theme})`, t7.n, 3);
      await shot(page, 'GR1-offp');

      g.set(v => {
        Object.assign(v.projects[2]!, { state: 'stale' }); Object.assign(v.projects[3]!, { state: 'ready', on: true });
        Object.assign(v.projects[4]!, { state: 'failed', error: 'index failed: worker exited with status 1', git: false }); Object.assign(v.projects[1]!, { state: 'ready' });
      });
      await expect(row(s7, 'h-ops')).toContainText('Lỗi: index failed: worker exited with status 1');
      await expect(row(s7, 'h-ops').getByRole('button', { name: 'Thử lại' })).toBeVisible();
      await expect(row(s7, 'h-ops')).toContainText('không phải git · index lại mỗi khi lane bắt đầu chạy');
      await expect(row(s7, 'h-cowork')).toContainText('Index bản cũ · vẫn dùng được');
      await shot(page, 'GR1-states');
    });

    test('T8 "Dọn…" → GR-clean (+ list) → "Dọn 92 index" sends exactly the listed roots → GR-clean-run → -done', async ({ page }) => {
      const g = await mockGraph(page, view());
      const c = new Clicks(page);
      const sheet = await open(page, c);
      await c.on(sheet.getByRole('button', { name: 'Dọn…' }));
      const dlg = page.getByRole('dialog', { name: 'Dọn index của thư mục đã xoá' });
      await expect(dlg).toContainText('92 index · 7,7 GB. Thư mục của chúng không còn trên máy nên các index này không dùng được nữa.');
      await expect(dlg).toContainText('Giữ nguyên: 46 index của thư mục còn tồn tại.');
      await expect(dlg).toContainText('Bỏ qua: 2 index không kiểm chắc được (ổ ngoài, Google Drive, thư mục không đọc được).');
      await shot(page, 'GR-clean');
      await dlg.getByRole('button', { name: /Xem danh sách/ }).click();
      await expect(dlg.locator('.grolr')).toHaveCount(92);
      await expect(dlg.locator('.grolr').first()).toContainText('~/Works/Projects/hagenta-w1');
      await shot(page, 'GR-clean-list');
      await dlg.getByRole('button', { name: /Xem danh sách/ }).click();
      await c.on(dlg.getByRole('button', { name: 'Dọn 92 index' }));
      await expect(dlg).toBeHidden();
      expect(g.sent.find(x => x.cmd === 'graph_clean')).toEqual({ cmd: 'graph_clean', roots: ORPHANS.rows.map(r => r.root_path) });
      await expect(sheet.locator('.grlast')).toHaveText('Đang dọn… 31 / 92');
      await shot(page, 'GR-clean-run');
      await expect(sheet.locator('.grlast')).toHaveText('Đã dọn 92 index · thu lại 7,7 GB · Index trên máy: 48 · 2,3 GB', { timeout: 5000 });
      expect(c.n).toBe(4);
      recordBudget(`v25 T8 graph clean (${theme})`, c.n, 4);
      await shot(page, 'GR-clean-done');
      g.set(v => { v.tool.clean = { state: 'done', done: 92, total: 92, freedBytes: 7.5 * 1024 ** 3, failed: 2, failedRoots: ['/Users/po/a', '/Users/po/b'], error: 'database is locked' }; });
      await expect(sheet.locator('.grlast')).toHaveText('Đã dọn 90 · thu lại 7,5 GB · 2 không xoá được (database is locked) Xem Thử lại');
      await sheet.getByRole('button', { name: 'Xem', exact: true }).click();
      await expect(sheet.locator('.grtab > pre.tklog')).toHaveText('~/a\n~/b');
      await shot(page, 'GR-clean-fail');
    });

    test('T5 GR0-old → "Cập nhật…" → GR-upd (from old) → "Cập nhật" → GR-run → GR1', async ({ page }) => {
      const g = await mockGraph(page, view(v => { Object.assign(v.tool, { state: 'old', version: '0.8.1' }); v.projects = []; }));
      const c = new Clicks(page);
      const sheet = await open(page, c);
      await expect(sheet.getByRole('tab', { name: /^Graph code/ })).toHaveText(/^Graph code$/);
      await expect(sheet.locator('.gr0')).toContainText('Bản 0.8.1 cũ hơn bản cc-slaves cần (0.12.1).');
      await expect(sheet.locator('.gr0 .pth')).toHaveText('~/.local/bin/codebase-memory-mcp');
      await shot(page, 'GR0-old');
      await c.on(sheet.getByRole('button', { name: 'Cập nhật…' }));
      const dlg = page.getByRole('dialog', { name: /^Cập nhật codebase-memory-mcp/ });
      await expect(dlg.locator('h2')).toHaveText('Cập nhật codebase-memory-mcp 0.8.1 → 0.12.1');
      await expect(dlg.locator('.k6 li')).toHaveText([
        '140 index (10,0 GB) vẫn dùng được; mỗi index dựng lại khi được index lần tới',
        '4 lane đang chạy vẫn dùng bản 0.8.1 tới lần chạy kế của lane; không lượt nào bị cắt',
        '8 phiên Claude Code khác đang mở (terminal, VS Code) vẫn dùng bản 0.8.1 cho tới khi mở lại phiên',
        '3 tiến trình codebase-memory-mcp khác (không phải Claude Code) vẫn dùng bản cũ cho tới khi chạy lại',
        'Giữ nguyên: cấu hình trong ~/.claude']);
      await expect(dlg.locator('.cmd')).toContainText('$curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/v0.12.1/install.sh');
      await shot(page, 'GR-upd');
      await c.on(dlg.getByRole('button', { name: 'Cập nhật', exact: true }));
      await expect(sheet.locator('.grrun h3')).toHaveText('Đang cập nhật codebase-memory-mcp 0.8.1 → 0.12.1');
      await expect(sheet.locator('.grrun .st-cur')).toHaveText('Tải và cài', { timeout: 3000 });
      await shot(page, 'GR-run');
      await expect(sheet.locator('.grr')).toHaveCount(6, { timeout: 5000 });
      expect(g.sent.filter(x => x.cmd === 'graph_update')).toHaveLength(1);
      expect(c.n).toBe(4);
      recordBudget(`v25 T5 graph update (${theme})`, c.n, 4);
    });

    test('GR1-new → GR-upd-ready (graph pauses, sessions lose it, switches kept)', async ({ page }) => {
      await mockGraph(page, view(v => { v.tool.latest = '0.13.0'; v.tool.command = installCmd('0.13.0'); }));
      const sheet = await open(page, new Clicks(page));
      await expect(sheet.locator('.grh1')).toContainText('có bản 0.13.0');
      await shot(page, 'GR1-new');
      await sheet.getByRole('button', { name: 'Cập nhật…' }).click();
      const dlg = page.getByRole('dialog', { name: /^Cập nhật codebase-memory-mcp/ });
      await expect(dlg.locator('.k6 li').nth(1)).toHaveText('4 lane đang chạy: graph tạm ngưng khoảng 1 phút, lane dùng grep trong lúc đó');
      await expect(dlg.locator('.k6 li').last()).toHaveText('Giữ nguyên: cấu hình trong ~/.claude, công tắc Lane dùng');
      await shot(page, 'GR-upd-ready');
      await page.keyboard.press('Escape'); // Esc closes the dialog first, the sheet stays
      await expect(dlg).toBeHidden();
      await expect(sheet).toBeVisible();
    });

    test('GR0, GR-err (red tab number, muted list), GR-err-upd, GR-empty → Cài đặt › Project', async ({ page }) => {
      const g = await mockGraph(page, view(v => { Object.assign(v.tool, { state: 'missing', version: undefined, path: undefined, latest: '0.12.1' }); v.projects = []; }),
        { sm: v => { v.counts.graph = { red: 1, yellow: 0 }; } });
      const sheet = await open(page, new Clicks(page));
      await expect(sheet.locator('.gr0')).toContainText('Chưa có codebase-memory-mcp');
      await expect(sheet.locator('.gr0')).toContainText('github.com/DeusData/codebase-memory-mcp · bản 0.12.1 · 50 MB tải · 335 MB trên đĩa');
      const cmd = sheet.locator('.gr0 .cmd'); // fu I-2: the GR-upd command box (--term-bg, padded), not plain mono text
      expect(await cmd.evaluate(el => { const c = getComputedStyle(el); return { bg: c.backgroundColor !== 'rgba(0, 0, 0, 0)', pad: c.paddingLeft !== '0px', border: c.borderTopWidth }; }))
        .toEqual({ bg: true, pad: true, border: '1px' });
      await shot(page, 'GR0');
      const ms = await msUntil(page, () => sheet.getByRole('button', { name: 'Cài', exact: true }).click(), { spin: `document.querySelector('.gr0 .spin, .grrun')` });
      expect(ms.spin).toBeLessThan(100);
      await expect(sheet.locator('.grrun h3')).toHaveText('Đang cài codebase-memory-mcp 0.12.1');
      await expect(sheet.locator('.grr')).toHaveCount(6, { timeout: 5000 });

      g.set(v => { Object.assign(v.tool, { state: 'error', error: 'Một phiên khác đang chạy công cụ với thư mục index khác (~/.cache/cbm-test)', log: ['front exited 1'] }); });
      await expect(sheet.locator('.grband')).toContainText('codebase-memory-mcp không khởi động được: Một phiên khác đang chạy công cụ với thư mục index khác (~/.cache/cbm-test)');
      await expect(sheet.getByRole('tab', { name: /^Graph code/ }).locator('.b.red')).toHaveText('1');
      await expect(sheet.locator('.grdim .grr .btn')).toHaveCount(0);
      await shot(page, 'GR-err');
      await sheet.getByRole('button', { name: 'Thử lại' }).click();
      await expect(sheet.locator('.grband')).toHaveCount(0);

      g.set(v => { Object.assign(v.tool, { state: 'old', version: '0.8.1', path: '/Users/po/.local/bin/codebase-memory-mcp', failed: { kind: 'update', line: 'curl: (6) Could not resolve host: raw.githubusercontent.com' }, log: ['curl: (6) Could not resolve host: raw.githubusercontent.com'] }); v.projects = []; });
      await expect(sheet.locator('.grband')).toContainText('Cập nhật hỏng: curl: (6) Could not resolve host: raw.githubusercontent.com · bản 0.8.1 còn nguyên');
      await expect(sheet.getByRole('button', { name: 'Cập nhật…' })).toHaveCount(0);
      await expect(sheet.locator('.grlog')).toHaveCount(0); // fu M-7: the log stays closed until "Xem log"
      await shot(page, 'GR-err-upd');
      await sheet.getByRole('button', { name: 'Xem log' }).click();
      await expect(sheet.locator('.grlog')).toBeVisible();

      g.set(v => { delete v.tool.failed; Object.assign(v.tool, { state: 'ready', version: '0.12.1' }); v.projects = []; });
      await expect(sheet.locator('.grempty')).toHaveText('Chưa có project nào — thêm trong Cài đặt › Project');
      await expect(sheet.locator('.grlast')).toContainText('Index trên máy: 140');
      await shot(page, 'GR-empty');
      await sheet.getByRole('button', { name: 'Cài đặt › Project' }).click();
      await expect(page.getByRole('dialog', { name: 'Cài đặt' })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Cài đặt' }).getByRole('tab', { name: 'Project' })).toHaveAttribute('aria-selected', 'true');
    });

    test('G5b K1-graph + Z20 in the MCP tab → Graph code; ⌘K "Bộ công cụ" → TK2 "Mở Graph code"; ⌘K "Graph code"; GR-k0', async ({ page }) => {
      let red = { mcp: 2, graph: 0 };
      await mockGraph(page, view(), { toolkit: TOOLKIT, sm: v => {
        v.mcp.rows = [...v.mcp.rows.filter(r => r.builtin), ...(red.mcp ? MCP_ROWS : MCP_ROWS.slice(2))];
        v.mcp.servers = v.mcp.rows.length; v.mcp.forLanes = v.mcp.rows.length;
        v.counts = { mcp: { red: red.mcp, yellow: 0 }, skills: { red: 0, yellow: 4 }, shared: { red: 0, yellow: 1 }, graph: { red: red.graph, yellow: 0 }, total: { red: red.mcp + red.graph, yellow: 5 } };
      } });
      const g5b = (frame: string) => v25Shot(page, frame, theme);
      await page.goto(eng.url());
      await page.locator('#top .smk-l').click();
      const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
      const cbm = sheet.locator('.smr', { has: page.locator('.nm', { hasText: /^codebase-memory-mcp$/ }) });
      // K1-graph: locked in Dùng cho lane right after cc_slaves, "của cc-slaves", no switch, no menu
      const used = sheet.locator('section', { has: page.locator('.smr .nm', { hasText: /^codebase-memory-mcp$/ }) });
      await expect(used.locator('h4')).toHaveText(/^Dùng cho lane 3/);
      await expect(used.locator('.smr .nm')).toHaveText(['cc_slaves', 'codebase-memory-mcp', 'onedevtool']);
      await expect(cbm).toContainText(/Đã kết nối\s*codebase-memory-mcp\s*của cc-slaves\s*cục bộ\s*17 công cụ/);
      await expect(cbm.getByRole('switch')).toHaveCount(0);
      await expect(cbm.locator('.mn button')).toHaveCount(0);
      // Z20: the row "Đăng nhập" is a plain button (not the filled primary)
      const login = sheet.locator('.smr', { has: page.locator('.nm', { hasText: /^context7$/ }) }).getByRole('button', { name: 'Đăng nhập', exact: true });
      await expect(login).toHaveAttribute('class', 'btn');
      const bg = (l: Locator) => l.evaluate(el => getComputedStyle(el).backgroundColor);
      expect(await bg(login)).not.toBe(await bg(sheet.getByRole('button', { name: 'Thêm MCP' }))); // not the filled primary
      // BANNED look: the lock line is neutral text, its row hover a grey step
      const link = cbm.getByRole('button', { name: 'của cc-slaves · quản lý ở Graph code' });
      await link.hover();
      expect(await cbm.evaluate(el => { const s = getComputedStyle(el); return { l: s.borderLeftWidth, sh: s.boxShadow }; })).toEqual({ l: '0px', sh: 'none' });
      const color = (l: Locator) => l.evaluate(el => getComputedStyle(el).color);
      expect(await color(link)).toBe(await color(cbm.locator('.nm'))); // hover: --fg
      await page.mouse.move(1, 1);
      expect(await color(link)).toBe(await color(cbm.locator('.src'))); // at rest: --fg-2, never the accent
      await g5b('K1-graph');
      await link.click();
      await expect(sheet.getByRole('tab', { name: /^Graph code/ })).toHaveAttribute('aria-selected', 'true');
      await expect(sheet.locator('.grtab')).toBeVisible();

      // ⌘K "Bộ công cụ" → TK2; the graph tool row's "Mở Graph code" → the Graph code tab
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await page.keyboard.press('Meta+k');
      await page.getByRole('textbox', { name: 'Tìm hành động, lane, project' }).fill('Bộ công cụ');
      await page.keyboard.press('Enter');
      await expect(sheet.getByRole('tab', { name: /^Bộ công cụ/ })).toHaveAttribute('aria-selected', 'true');
      const gr = sheet.locator('.tkr[data-key="graph"]');
      await expect(gr).toContainText('Đã cài 0.12.1');
      await expect(sheet.locator('.tkr[data-key="superpowers"]').getByRole('button', { name: 'Mở Graph code' })).toHaveCount(0);
      await g5b('TK2-graph');
      await gr.getByRole('button', { name: 'Mở Graph code' }).click();
      await expect(sheet.getByRole('tab', { name: /^Graph code/ })).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Meta+k');
      await page.getByRole('textbox', { name: 'Tìm hành động, lane, project' }).fill('Graph code');
      await page.keyboard.press('Enter');
      await expect(sheet.getByRole('tab', { name: /^Graph code/ })).toHaveAttribute('aria-selected', 'true');

      // GR-k0: the graph fails while on → ⓘ2 becomes ⓘ3; the hover names it; the number opens the first tab with an issue
      red = { mcp: 2, graph: 1 };
      await page.reload();
      const num = page.locator('#top .smk-n.red');
      await expect(num).toHaveText('3');
      await expect(num).toHaveAttribute('title', '2 MCP cần đăng nhập / lỗi\nGraph code: codebase-memory-mcp không chạy được\nBấm: mở tab MCP');
      await g5b('GR-k0');
      await num.click();
      await expect(sheet.getByRole('tab', { name: /^MCP/ })).toHaveAttribute('aria-selected', 'true');
      red = { mcp: 0, graph: 1 };
      await page.reload();
      await expect(num).toHaveText('1');
      await expect(num).toHaveAttribute('title', 'Graph code: codebase-memory-mcp không chạy được\nBấm: mở tab Graph code');
      await num.click();
      await expect(sheet.getByRole('tab', { name: /^Graph code/ })).toHaveAttribute('aria-selected', 'true');
    });
  });
}
