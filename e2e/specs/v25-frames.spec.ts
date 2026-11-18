// v2.5 §6.1 G6: the frames the G4a–G5b specs do not reach, light + dark, 1440 × 900 and 1024 × 640 (`v25Shot`, never into
// docs/): the wizard step 3 TK1-chk (check held), TK1-run, TK1-fail (log closed until clicked), TK1-done (login rows), TK1-mix (graph tool row below
// the min → "Cập nhật…" opens GR-upd over the wizard), TK1-off / -off-err, TK1-git / -git-lic, TK1-en; TK2-fail; TK2-lost (engine
// dropped); GR1-nogit, GR1-noorph, GR1-en, GR-upd-en. Real e2e engine for the app; the toolkit and graph views are the
// scripted ones of e2e/v25-graph-mock.ts (no `claude plugin`, no codebase-memory-mcp, no network).
import type { Locator, Page } from '@playwright/test';
import { expect, test, useEngine, type E2eEngine } from '../fixtures.ts';
import { mockGraph, mockupView, needsLogin, v25Shot, type GraphMock } from '../v25-graph-mock.ts';
import type { GraphView } from '../../shared/graph.ts';
import type { SkillsMcpView } from '../../shared/protocol.ts';
import type { ToolkitKey, ToolkitRow, ToolkitView } from '../../shared/toolkit.ts';

const ID: Record<ToolkitKey, string | undefined> = { superpowers: 'superpowers@claude-plugins-official', 'ui-ux-pro-max': 'ui-ux-pro-max@ui-ux-pro-max-skill',
  context7: 'context7@claude-plugins-official', vercel: 'vercel@claude-plugins-official', graph: undefined };
const VER: Record<ToolkitKey, string> = { superpowers: '7.0.2', 'ui-ux-pro-max': '2.15.0', context7: 'b5b01ac4f889', vercel: '0.50.0', graph: '0.12.1' };
const KEYS = Object.keys(ID) as ToolkitKey[];
const CHECKED = new Date(2026, 10, 18, 14, 2).getTime();
const tkRow = (key: ToolkitKey, over: Partial<ToolkitRow> = {}): ToolkitRow =>
  ({ key, kind: key === 'graph' ? 'graph' : 'plugin', ...(ID[key] ? { id: ID[key] } : {}), state: 'installed', version: VER[key], mcpLoginIds: [], ...over });
const missing = (key: ToolkitKey): ToolkitRow => tkRow(key, { state: 'missing', version: undefined, commands: key === 'graph'
  ? ['curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/v0.12.1/install.sh | … bash'] : [`claude plugin install ${ID[key]}`] });
const tkView = (rows: ToolkitRow[], over: Partial<ToolkitView> = {}): ToolkitView => ({ rows, checkedAt: CHECKED, ...over });
/** The sheet / wizard see context7 waiting for a login (the MCP catalog decides `needs_login`, lib/toolkit.ts). */
const c7Login = (v: SkillsMcpView) => { v.mcp.rows = [...v.mcp.rows.filter(r => r.builtin), needsLogin('context7')]; };
const lang = (e: E2eEngine, l: 'vi' | 'en') => e.cmd({ cmd: 'config_update', patch: { ui: { lang: l } } });

for (const theme of ['light', 'dark'] as const) {
  test.describe(`§6.1 G6 frames (${theme}, scripted toolkit + graph)`, () => {
    test.describe.configure({ mode: 'serial' });
    const eng = useEngine();
    test.use({ viewport: { width: 1440, height: 900 }, theme });
    const shot = (page: Page, frame: string) => v25Shot(page, frame, theme, async w => {
      expect(await page.evaluate(() => [...document.querySelectorAll('.wiz, .wiz .tkr, .wiz .tks, .wiz .tkn, .wiz .mf .btn, .tktab, .tkr .btn, .grtab, .grr, .grlast, .grd')]
        .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className)), `${frame} ${w}`).toEqual([]);
    });

    /** Settings › Project › "Kiểm tra cài đặt" → the wizard, then steps 1 and 2 → step 3 (as v25-toolkit TK1). */
    async function wizard(page: Page, next = ['Tiếp', 'Tiếp']): Promise<Locator> {
      await page.goto(eng.url());
      await expect(page.locator('#top .smk-l')).toBeVisible();
      await page.keyboard.press('Meta+Comma');
      const set = page.getByRole('dialog', { name: /^(Cài đặt|Settings)$/ });
      await set.getByRole('tab', { name: 'Project' }).click();
      await set.getByRole('button', { name: /^(Kiểm tra cài đặt|Check setup)$/ }).click();
      const wiz = page.getByRole('dialog', { name: /^(Cài đặt lần đầu|First-run setup)$/ });
      for (const n of next) await wiz.getByRole('button', { name: n, exact: true }).click();
      await expect(wiz.locator('.tklist')).toBeVisible();
      return wiz;
    }
    const row = (l: Locator, k: ToolkitKey) => l.locator(`.tkr[data-key="${k}"]`);
    /** fu I-1: one status column — every row's status cell starts at the same x, with or without a row button. */
    const statusX = (l: Locator) => l.locator('.tkr .tks').evaluateAll(els => [...new Set(els.map(e => Math.round(e.getBoundingClientRect().left)))]);

    test('TK1-chk (check held: bars, "Cài" off, "Để sau" on) → TK1-run (busy row log + clock, waiting row, Quay lại off, Tiếp on)', async ({ page }) => {
      const g: GraphMock = await mockGraph(page, mockupView(), { toolkit: tkView(KEYS.map(missing), { checkedAt: undefined }), holdCheck: true, sm: c7Login });
      const wiz = await wizard(page);
      await expect(wiz).toContainText('Đang kiểm tra máy này…');
      await expect(wiz.locator('.tkskel')).toHaveCount(5);
      await expect(wiz.locator('.mf .btn.pri')).toHaveText('Cài');
      await expect(wiz.locator('.mf .btn.pri')).toBeDisabled();
      await expect(wiz.getByRole('button', { name: 'Để sau' })).toBeEnabled();
      await shot(page, 'TK1-chk');
      g.tk(v => { v.checkedAt = CHECKED; });
      g.release();
      await expect(wiz.getByRole('button', { name: 'Cài 5 mục' })).toBeEnabled();

      g.tk(v => {
        v.rows = [tkRow('superpowers'), tkRow('ui-ux-pro-max'), tkRow('context7'),
          tkRow('vercel', { state: 'running', version: undefined, log: ['$ claude plugin install vercel@claude-plugins-official --json', "Cloning into '~/.claude/plugins/cache/claude-plugins-official/vercel'…",
            'Receiving objects:  61% (4127/6765), 94.20 MiB | 11.80 MiB/s', 'Resolving deltas:  12% (310/2584)'] }),
          tkRow('graph', { state: 'running', version: undefined })];
        v.busy = 'vercel';
      });
      await expect(row(wiz, 'vercel')).toContainText(/Đang cài… 0:0\d/);
      await expect(row(wiz, 'vercel').locator('.spin')).toBeVisible();
      await expect(row(wiz, 'vercel').locator('pre.tklog')).toHaveText(/Resolving deltas/);
      await expect(row(wiz, 'graph')).toContainText('Chờ');
      await expect(row(wiz, 'superpowers')).toContainText('Đã cài 7.0.2');
      await expect(row(wiz, 'context7').getByRole('button', { name: 'Đăng nhập' })).toBeVisible();
      await expect(wiz).toContainText('Bấm Tiếp thì việc cài vẫn chạy; phần còn lại xem ở Skills & MCP › Bộ công cụ.');
      await expect(wiz.getByRole('button', { name: 'Quay lại' })).toBeDisabled();
      await expect(wiz.getByRole('button', { name: 'Tiếp' })).toBeEnabled();
      await shot(page, 'TK1-run');
    });

    test('TK1-fail: the failed row names the cause, "Thử lại" + "Xem log" (closed until clicked); the others stay installed', async ({ page }) => {
      await mockGraph(page, mockupView(), { toolkit: tkView([tkRow('superpowers'), tkRow('ui-ux-pro-max'), tkRow('context7'),
        tkRow('vercel', { state: 'failed', version: undefined, error: { code: 'offline', line: 'fatal: unable to access' }, log: ['$ claude plugin install vercel@claude-plugins-official --json', 'fatal: unable to access \'https://github.com/vercel/vercel-plugin.git/\': Could not resolve host: github.com'] }),
        tkRow('graph')]) });
      const wiz = await wizard(page);
      const v = row(wiz, 'vercel');
      await expect(v).toContainText('Không tải được — kiểm tra mạng / VPN');
      await expect(v.getByRole('button', { name: 'Thử lại' })).toBeVisible();
      await expect(v.locator('pre.tklog')).toHaveCount(0);
      await expect(row(wiz, 'context7')).toContainText('Đã cài (b5b01ac)');
      await expect(wiz.getByRole('button', { name: 'Tiếp' })).toBeEnabled();
      expect(await statusX(wiz)).toHaveLength(1);
      for (const w of [1440, 1024]) { // both buttons stay inside the button column (no spill into the status column)
        await page.setViewportSize({ width: w, height: w === 1440 ? 900 : 640 });
        expect(await v.evaluate(el => Math.round(el.querySelector('.tka .btn')!.getBoundingClientRect().left - el.querySelector('.tks')!.getBoundingClientRect().right))).toBeGreaterThanOrEqual(16);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await shot(page, 'TK1-fail');
      await v.getByRole('button', { name: 'Xem log' }).click();
      await expect(v.locator('pre.tklog')).toContainText('Could not resolve host');
    });

    test('TK1-done: installed, context7 + vercel wait for a login ("Đăng nhập" on each), the "Đăng nhập sau" note, primary "Tiếp"', async ({ page }) => {
      const login = (k: 'context7' | 'vercel') => tkRow(k, { state: 'needs_login', mcpLoginIds: [`plugin:${k}@claude-plugins-official:${k}`] });
      await mockGraph(page, mockupView(), { toolkit: tkView([tkRow('superpowers'), tkRow('ui-ux-pro-max'), login('context7'), login('vercel'), tkRow('graph')]),
        sm: v => { v.mcp.rows = [...v.mcp.rows.filter(r => r.builtin), needsLogin('context7'), needsLogin('vercel')]; } });
      const wiz = await wizard(page);
      for (const k of ['context7', 'vercel'] as const) {
        await expect(row(wiz, k)).toContainText('Cần đăng nhập (OAuth)');
        await expect(row(wiz, k).getByRole('button', { name: 'Đăng nhập' })).toBeVisible();
      }
      await expect(row(wiz, 'superpowers')).toContainText('Đã cài 7.0.2');
      await expect(wiz).toContainText('Đăng nhập sau cũng được, ở Skills & MCP › Bộ công cụ.');
      await expect(wiz.getByRole('checkbox')).toHaveCount(0);
      await expect(wiz.locator('.mf .btn.pri')).toHaveText('Tiếp');
      expect(await statusX(wiz)).toHaveLength(1);
      await shot(page, 'TK1-done');
    });

    test('TK1-mix: one "Có bản mới …" pattern, disabled / off-for-lanes rows without a button, graph below the min → "Cập nhật…" opens GR-upd', async ({ page }) => {
      await mockGraph(page, ((v: GraphView) => { Object.assign(v.tool, { state: 'old', version: '0.8.1' }); return v; })(mockupView()), {
        toolkit: tkView([tkRow('superpowers', { state: 'outdated', version: '7.0.0' }), tkRow('ui-ux-pro-max', { state: 'outdated', version: '2.14.0', latest: '2.15.0' }),
          tkRow('context7', { state: 'disabled' }), tkRow('vercel', { offForLanes: true }), tkRow('graph', { state: 'outdated', version: '0.8.1', latest: '0.12.1' })]) });
      const wiz = await wizard(page);
      await expect(row(wiz, 'superpowers')).toContainText('Có bản mới (đang dùng 7.0.0)');
      await expect(row(wiz, 'ui-ux-pro-max')).toContainText('Có bản mới 2.14.0 → 2.15.0');
      await expect(row(wiz, 'context7')).toContainText('Đã cài · đang tắt trong Claude Code (bật lại bằng /plugin)');
      await expect(row(wiz, 'vercel')).toContainText('Đã cài 0.50.0 · tắt cho lane');
      for (const k of ['context7', 'vercel'] as const) await expect(row(wiz, k).getByRole('button')).toHaveCount(0);
      await expect(row(wiz, 'graph')).toContainText('Bản 0.8.1 — cc-slaves cần 0.12.1');
      await expect(row(wiz, 'context7').locator('.tks code.chip')).toHaveText('/plugin');
      expect(await statusX(wiz)).toHaveLength(1);
      await page.setViewportSize({ width: 1024, height: 640 });
      expect(await statusX(wiz)).toHaveLength(1);
      await page.setViewportSize({ width: 1440, height: 900 });
      await shot(page, 'TK1-mix');
      await row(wiz, 'graph').getByRole('button', { name: 'Cập nhật…' }).click();
      const dlg = page.getByRole('dialog', { name: /^Cập nhật codebase-memory-mcp/ });
      await expect(dlg.locator('h2')).toHaveText('Cập nhật codebase-memory-mcp 0.8.1 → 0.12.1');
      await dlg.getByRole('button', { name: 'Huỷ' }).click();
      await expect(dlg).toBeHidden();
      await expect(wiz).toBeVisible();
    });

    test('TK1-off ("Cài n mục" off, hover "Cần mạng để cài") → TK1-off-err (still on)', async ({ page }) => {
      const g = await mockGraph(page, mockupView(), { toolkit: tkView([tkRow('superpowers'), missing('ui-ux-pro-max'), missing('context7'), missing('vercel'), tkRow('graph')],
        { checkError: { code: 'offline', line: 'fatal: unable to access' } }) });
      const wiz = await wizard(page);
      await expect(wiz.locator('.band.warn')).toContainText('Không kiểm tra được bản mới — mất mạng · kiểm lúc 14:02');
      await expect(wiz.locator('.band.warn').getByRole('button', { name: 'Kiểm tra lại' })).toBeVisible();
      await expect(row(wiz, 'superpowers')).toContainText('Đã cài 7.0.2');
      await expect(wiz.getByRole('checkbox')).toHaveCount(3);
      const inst = wiz.getByRole('button', { name: 'Cài 3 mục' });
      await expect(inst).toBeDisabled();
      await expect(inst).toHaveAttribute('title', 'Cần mạng để cài');
      await shot(page, 'TK1-off');
      g.tk(v => { v.checkError = { code: 'unknown', line: 'error: marketplace.json: Unexpected end of JSON input' }; });
      await expect(wiz.locator('.band.warn')).toContainText('Không kiểm tra được bản mới: error: marketplace.json: Unexpected end of JSON input');
      await expect(inst).toBeEnabled();
      await expect(wiz.locator('.band.warn code')).toHaveCSS('font-family', /Mono/);
      await shot(page, 'TK1-off-err');
    });

    test('TK1-git ("Cài git" + "Kiểm tra lại", plugins "Cần git" without a tick, "Cài 1 mục") → TK1-git-lic ("Chép lệnh")', async ({ page }) => {
      const git = (code: 'git_missing' | 'git_license') => KEYS.map(k => k === 'graph' ? missing(k) : tkRow(k, { state: 'failed', version: undefined, error: { code, line: '' } }));
      const g = await mockGraph(page, mockupView(), { toolkit: tkView(git('git_missing')) });
      const wiz = await wizard(page);
      const band = wiz.locator('.band.warn');
      await expect(band).toContainText('Chưa có git — 4 plugin cần git để cài');
      await expect(band.getByRole('button', { name: 'Cài git' })).toBeVisible();
      await expect(band.getByRole('button', { name: 'Kiểm tra lại' })).toBeVisible();
      for (const k of ['superpowers', 'ui-ux-pro-max', 'context7', 'vercel'] as const) await expect(row(wiz, k)).toContainText('Cần git');
      await expect(wiz.getByRole('checkbox')).toHaveCount(5); // §6.1 "ô chọn tắt": the 4 "Cần git" rows keep an empty, disabled box
      for (const k of ['superpowers', 'ui-ux-pro-max', 'context7', 'vercel'] as const) {
        await expect(row(wiz, k).getByRole('checkbox')).toBeDisabled();
        await expect(row(wiz, k).getByRole('checkbox')).not.toBeChecked();
      }
      await expect(wiz.getByRole('button', { name: 'Cài 1 mục' })).toBeEnabled();
      await expect(wiz.locator('.tkcmd')).toHaveText('Sẽ chạy: bộ cài của codebase-memory-mcp'); // only the installable item's command
      await shot(page, 'TK1-git');
      g.tk(v => { v.rows = git('git_license'); });
      await expect(band).toContainText('Git bị chặn: chưa đồng ý giấy phép Xcode — chạy sudo xcodebuild -license trong Terminal rồi Kiểm tra lại');
      await expect(band.getByRole('button', { name: 'Chép lệnh' })).toBeVisible();
      await expect(band.locator('code.chip')).toHaveText('sudo xcodebuild -license');
      await expect(band.getByRole('button', { name: 'Cài git' })).toHaveCount(0);
      await shot(page, 'TK1-git-lic');
    });

    test('TK1-en, GR1-en, GR-upd-en: natural English ("Toolkit", "6 projects", "Lanes use the graph through cc-slaves.")', async ({ page }) => {
      await lang(eng, 'en');
      try {
        const g = await mockGraph(page, mockupView(), { toolkit: tkView([...KEYS.slice(0, 4).map(missing), tkRow('graph')]) });
        const wiz = await wizard(page, ['Next', 'Next']);
        await expect(wiz.locator('.stepper')).toHaveText(/1\. Tools.*3\. Toolkit.*4\. Roles & caps/);
        await expect(wiz.getByRole('button', { name: 'Install 4 items' })).toBeEnabled();
        await shot(page, 'TK1-en');
        await page.reload(); // the wizard has no Esc; a reload leaves it
        await page.locator('#top .smk-l').click();
        const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
        await sheet.getByRole('tab', { name: /^Code graph|^Graph code/ }).click();
        await expect(sheet.locator('.grtab')).toContainText('Lanes use the graph through cc-slaves.');
        await expect(sheet.locator('.grsum')).toContainText('6 projects');
        await shot(page, 'GR1-en');
        g.set(v => { Object.assign(v.tool, { state: 'old', version: '0.8.1', latest: '0.12.1' }); v.projects = []; }); // the mockup: GR-upd from GR0-old
        await sheet.locator('.gr0').getByRole('button', { name: /^Update…$/ }).click();
        const dlg = page.getByRole('dialog', { name: /^Update codebase-memory-mcp/ });
        await expect(dlg.locator('h2')).toHaveText('Update codebase-memory-mcp 0.8.1 → 0.12.1');
        await shot(page, 'GR-upd-en');
      } finally { await lang(eng, 'vi'); }
    });

    test('TK2-lost: engine lost → the v2.2 band, the tab dimmed', async ({ page }) => {
      const g = await mockGraph(page, mockupView(), { toolkit: tkView([tkRow('superpowers', { state: 'outdated', version: '7.0.0' }), missing('ui-ux-pro-max'), tkRow('context7'), tkRow('vercel'), tkRow('graph')]) });
      await page.goto(eng.url());
      await page.locator('#top .smk-l').click();
      const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
      await sheet.getByRole('tab', { name: /^Bộ công cụ/ }).click();
      await expect(sheet.locator('.tkr')).toHaveCount(5);
      g.drop();
      await expect(sheet.locator('.tktab .band.bad')).toHaveText('Mất kết nối engine — đang thử kết nối lại');
      await expect(sheet).toHaveClass(/\boff\b/);
      for (const b of await sheet.locator('.tktab button').all()) await expect(b).toBeDisabled(); // §6 *-lost: every button dimmed
      await shot(page, 'TK2-lost');
    });

    test('TK2-fail: a failed row\'s "Thử lại" + "Xem log" stay inside the button column at 1440 and 1024 (gate fix, as fu I-1)', async ({ page }) => {
      await mockGraph(page, mockupView(), { toolkit: tkView([tkRow('superpowers'), tkRow('ui-ux-pro-max'), tkRow('context7'),
        tkRow('vercel', { state: 'failed', version: undefined, error: { code: 'offline', line: 'fatal: unable to access' }, log: ['fatal: unable to access'] }), tkRow('graph')]) });
      await page.goto(eng.url());
      await page.locator('#top .smk-l').click();
      const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
      await sheet.getByRole('tab', { name: /^Bộ công cụ/ }).click();
      const v = row(sheet, 'vercel');
      await expect(v.getByRole('button')).toHaveText(['Thử lại', 'Xem log']);
      for (const w of [1440, 1024]) {
        await page.setViewportSize({ width: w, height: w === 1440 ? 900 : 640 });
        const gap = await v.evaluate(el => {
          const tka = el.querySelector('.tka')!.getBoundingClientRect(), b = el.querySelector('.tka .btn')!.getBoundingClientRect();
          return { inCol: Math.round(b.left - tka.left), toStatus: Math.round(b.left - el.querySelector('.tks')!.getBoundingClientRect().right) };
        });
        expect(gap.inCol, `${w}`).toBeGreaterThanOrEqual(0);
        expect(gap.toStatus, `${w}`).toBeGreaterThanOrEqual(16);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await shot(page, 'TK2-fail');
    });

    test('GR1-nogit (the muted "không phải git" line + "Index lại"), GR1-noorph ("Index trên máy: 48 · 2,3 GB", no "Dọn…")', async ({ page }) => {
      const g = await mockGraph(page, ((v: GraphView) => { v.projects[4]!.git = false; return v; })(mockupView()));
      await page.goto(eng.url());
      await page.locator('#top .smk-l').click();
      const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
      await sheet.getByRole('tab', { name: /^Graph code/ }).click();
      const ops = sheet.locator('.grr[data-project="h-ops"]');
      await expect(ops).toContainText('không phải git · index lại mỗi khi lane bắt đầu chạy, không theo từng lần sửa file');
      await expect(ops.getByRole('button', { name: 'Index lại' })).toBeVisible();
      await shot(page, 'GR1-nogit');
      g.set(v => { v.tool.indexes = { n: 48, bytes: 2.3 * 1024 ** 3 }; v.tool.orphans = { n: 0, bytes: 0, skipped: 0 }; });
      await expect(sheet.locator('.grlast')).toHaveText('Index trên máy: 48 · 2,3 GB');
      await expect(sheet.getByRole('button', { name: 'Dọn…' })).toHaveCount(0);
      await shot(page, 'GR1-noorph');
    });
  });
}
