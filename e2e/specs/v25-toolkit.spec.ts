// v2.5 §6 / §8 E2E the Bộ công cụ tab (lane G4a): TK2 after the tab's own check (superpowers has a new release, ui-ux-pro-max
// and context7 missing, vercel installed), "Cài" spins at once and ends "Đã cài 2.15.0", T3 "Cập nhật" in 3 clicks ends TK2-upd,
// light + dark, 1440 × 900 and 1024 × 640 without sideways overflow. Lane G4b: the wizard step 3 (TK1 → TK1-cmd → "Cài 4 mục"
// spins at once → TK1-done / Tiếp → step 4) on a machine with nothing installed. Real engine + fake-claude `plugin` (temp HOME: the fake
// writes `$HOME/.claude` = a link to the engine's CLAUDE_HOME); never the real ~/.claude or any network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { Clicks, expect, msUntil, recordBudget, test, useEngine, type E2eEngine } from '../fixtures.ts';
import { v25Shot } from '../v25-graph-mock.ts';

const FAKE = resolve(import.meta.dirname, '../../fake-claude/src/index.ts');
const remote = (spSha: string) => ({
  'anthropics/claude-plugins-official': { name: 'claude-plugins-official', head: 'b5b01ac4f889aaaa', plugins: [
    { name: 'superpowers', sha: spSha, pluginVersion: spSha === 's1' ? '7.0.0' : '7.0.2' },
    { name: 'context7', files: { 'README.md': 'c7' } },
    { name: 'vercel', sha: 'v1', pluginVersion: '0.50.0' },
  ] },
  'nextlevelbuilder/ui-ux-pro-max-skill': { name: 'ui-ux-pro-max-skill', head: 'u1', plugins: [{ name: 'ui-ux-pro-max', version: '2.15.0' }] },
});

/** Before the engine starts: the fake "network", superpowers 7.0.0 + vercel installed through the fake CLI, then a new
 *  superpowers release (7.0.2) published, so the tab's check finds it. */
/** The fake "network" with superpowers 7.0.2 published; with `installed`, superpowers 7.0.0 + vercel installed first. */
function seed(e: E2eEngine, installed = true): void {
  const remoteFile = join(e.dir, 'plugin-remote.json');
  const user = join(e.dir, 'user');
  mkdirSync(join(e.dir, 'claude'), { recursive: true });
  mkdirSync(user, { recursive: true });
  symlinkSync(join(e.dir, 'claude'), join(user, '.claude'));
  writeFileSync(join(e.dir, 'auth.env'), `export FAKE_CLAUDE_PLUGIN_REMOTE=${JSON.stringify(remoteFile)}\n`);
  writeFileSync(remoteFile, JSON.stringify(remote(installed ? 's1' : 's2')));
  if (!installed) return;
  const cli = (...a: string[]) => execFileSync(process.execPath, [FAKE, 'plugin', ...a, '--json'], { env: { PATH: process.env.PATH ?? '', HOME: user, FAKE_CLAUDE_PLUGIN_REMOTE: remoteFile }, stdio: 'ignore' });
  cli('marketplace', 'add', 'anthropics/claude-plugins-official');
  cli('install', 'superpowers@claude-plugins-official');
  cli('install', 'vercel@claude-plugins-official');
  writeFileSync(remoteFile, JSON.stringify(remote('s2')));
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`§6 TK2 Bộ công cụ tab (${theme}, real engine + fake-claude)`, () => {
    test.describe.configure({ mode: 'serial' });
    const eng = useEngine({ scenarios: e => { seed(e); return {}; } });
    test.use({ viewport: { width: 1440, height: 900 }, theme });

    async function open(page: Page, c: Clicks): Promise<Locator> {
      await page.goto(eng.url());
      await c.on(page.locator('#top .smk-l'));
      const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
      await c.on(sheet.getByRole('tab', { name: /^Bộ công cụ/ }));
      await expect(sheet.locator('.tklist')).toBeVisible();
      return sheet;
    }
    const sum = (sheet: Locator) => () => sheet.locator('.smsum').innerText().then(t => t.replace(/\u00a0/g, ' ')); // statLine NBSPs
    const row = (sheet: Locator, key: string) => sheet.locator(`.tkr[data-key="${key}"]`);
    /** No row, cell or button wider than its box (the v2.2 shots rule, here without writing into docs/). */
    const noSideways = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.tktab, .tkr, .tkr .btn, .tks, .tkn')]
      .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className));

    test('TK2: the tab checks on open, summary numbers match the rows, light / dark at 1440 and 1024 without sideways overflow', async ({ page }) => {
      const sheet = await open(page, new Clicks(page));
      await expect.poll(sum(sheet), { timeout: 15_000 }).toMatch(/^4 mục · 2 đã cài · 2 chưa cài · 1 có bản mới · kiểm tra lúc \d\d:\d\d/);
      await expect(sheet.getByRole('tab', { name: /^Bộ công cụ/ })).toHaveText(/Bộ công cụ\s*4$/);
      await expect(row(sheet, 'superpowers')).toContainText('Có bản mới (đang dùng 7.0.0)');
      await expect(row(sheet, 'superpowers').getByRole('button')).toHaveText('Cập nhật');
      await expect(row(sheet, 'ui-ux-pro-max')).toContainText('Chưa cài');
      await expect(row(sheet, 'vercel')).toContainText('Đã cài 0.50.0');
      await expect(row(sheet, 'vercel').getByRole('button')).toHaveCount(0);
      // BANNED look: a hovered row is a neutral grey step, never a coloured border
      await row(sheet, 'vercel').hover();
      const hov = await row(sheet, 'vercel').evaluate(el => { const s = getComputedStyle(el); return { l: s.borderLeftWidth, sh: s.boxShadow }; });
      expect(hov).toEqual({ l: '0px', sh: 'none' });
      await v25Shot(page, 'TK2', theme, async w => { expect(await noSideways(page), `${w}`).toEqual([]); });
    });

    test('"Cài" spins within 100 ms and ends "Đã cài 2.15.0"; T3 "Cập nhật" = 3 clicks → TK2-upd', async ({ page }) => {
      const c = new Clicks(page);
      const sheet = await open(page, c);
      const ux = row(sheet, 'ui-ux-pro-max');
      await expect(ux.getByRole('button', { name: 'Cài' })).toBeVisible({ timeout: 15_000 });
      const ms = await msUntil(page, () => ux.getByRole('button', { name: 'Cài' }).click(), { spin: `document.querySelector('.tkr[data-key="ui-ux-pro-max"] .spin')` });
      expect(ms.spin).toBeLessThan(100); // loading feedback ≤ 100 ms from pointerdown
      await expect(ux).toContainText('Đã cài 2.15.0', { timeout: 20_000 });
      await expect.poll(sum(sheet)).toMatch(/^4 mục · 3 đã cài · 1 chưa cài · 1 có bản mới/);

      const t3 = new Clicks(page);
      const s2 = await open(page, t3);
      const sp = row(s2, 'superpowers');
      await t3.on(sp.getByRole('button', { name: 'Cập nhật' }));
      await expect(sp).toContainText('Đã cập nhật 7.0.2 · áp dụng từ lần chạy sau của mỗi lane', { timeout: 20_000 });
      await expect(s2.locator('.smsum')).not.toContainText('có bản mới');
      expect(t3.n).toBe(3);
      recordBudget(`v25 T3 toolkit update (${theme})`, t3.n, 3);
      await v25Shot(page, 'TK2-upd', theme);
    });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`§6 TK1 wizard step 3 Bộ công cụ (${theme}, real engine + fake-claude, nothing installed)`, () => {
    const eng = useEngine({ scenarios: e => { seed(e, false); return {}; } });
    test.use({ viewport: { width: 1440, height: 900 }, theme });
    const shot = (page: Page, name: string) => v25Shot(page, name, theme);

    test('TK1: ticks on, "Sẽ chạy" opens TK1-cmd, "Cài 4 mục" spins within 100 ms, rows end installed, "Tiếp" → step 4', async ({ page }) => {
      await page.goto(eng.url());
      await expect(page.locator('#top .smk-l')).toBeVisible(); // the app is up before the shortcut
      await page.keyboard.press('Meta+Comma');
      const set = page.getByRole('dialog', { name: 'Cài đặt' });
      await set.getByRole('tab', { name: 'Project' }).click();
      await set.getByRole('button', { name: 'Kiểm tra cài đặt' }).click();
      const wiz = page.getByRole('dialog', { name: 'Cài đặt lần đầu' });
      await wiz.getByRole('button', { name: 'Tiếp' }).click();
      await wiz.getByRole('button', { name: 'Tiếp' }).click();
      await expect(wiz.locator('.stepper')).toHaveText(/1\. Công cụ.*2\. Account.*3\. Bộ công cụ.*4\. Vai trò & ngưỡng.*5\. Xong/);
      await expect(wiz).toContainText('Những thứ lane của bạn dùng hằng ngày. Cài vào ~/.claude, terminal cũng dùng được.');
      const inst = wiz.getByRole('button', { name: 'Cài 4 mục' });
      await expect(inst).toBeEnabled({ timeout: 15_000 });
      await expect(wiz.getByRole('checkbox')).toHaveCount(4);
      for (const cb of await wiz.getByRole('checkbox').all()) await expect(cb).toBeChecked();
      await expect(wiz.locator('.tkr[data-key="vercel"]')).toContainText('Chưa cài');
      await expect(wiz.locator('.tkr[data-key="vercel"]').getByRole('button')).toHaveCount(0); // no row "Cài" in the wizard (D70)
      // BANNED look: a hovered row is a neutral grey step
      await wiz.locator('.tkr[data-key="vercel"]').hover();
      expect(await wiz.locator('.tkr[data-key="vercel"]').evaluate(el => { const s = getComputedStyle(el); return { l: s.borderLeftWidth, sh: s.boxShadow }; })).toEqual({ l: '0px', sh: 'none' });
      expect(await page.evaluate(() => [...document.querySelectorAll('.wiz, .wiz .tkr, .wiz .tks, .wiz .tkn, .wiz .mf .btn')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className))).toEqual([]);
      await shot(page, 'TK1');
      // unticking one updates the count; tick it again
      await wiz.getByRole('checkbox', { name: 'context7' }).uncheck();
      await expect(wiz.getByRole('button', { name: 'Cài 3 mục' })).toBeVisible();
      await wiz.getByRole('checkbox', { name: 'context7' }).check();
      await wiz.getByRole('button', { name: /Sẽ chạy/ }).click();
      await expect(wiz.locator('.tkcmd pre')).toHaveText([
        '$ claude plugin marketplace add anthropics/claude-plugins-official', '$ claude plugin install superpowers@claude-plugins-official',
        '$ claude plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill', '$ claude plugin install ui-ux-pro-max@ui-ux-pro-max-skill',
        '$ claude plugin install context7@claude-plugins-official', '$ claude plugin install vercel@claude-plugins-official'].join('\n'));
      await shot(page, 'TK1-cmd');
      const ms = await msUntil(page, () => inst.click(), { spin: `document.querySelector('.wiz .mf .btn.pri .spin, .wiz .tkr .spin')` });
      expect(ms.spin).toBeLessThan(100); // loading feedback ≤ 100 ms from pointerdown
      for (const k of ['superpowers', 'ui-ux-pro-max', 'context7', 'vercel']) await expect(wiz.locator(`.tkr[data-key="${k}"]`)).toContainText('Đã cài', { timeout: 30_000 });
      await expect(wiz.getByRole('button', { name: 'Tiếp' })).toBeEnabled();
      await shot(page, 'TK1-done-real'); // the real engine never reports needs_login; the TK1-done frame is v25-frames'
      await wiz.getByRole('button', { name: 'Tiếp' }).click();
      await expect(wiz.locator('.stepper .now')).toHaveText('4. Vai trò & ngưỡng');
      await wiz.getByRole('button', { name: 'Quay lại' }).click(); // back to step 3: everything installed → TK1-all
      await expect(wiz).toContainText('Máy này đã có đủ 4 mục.', { timeout: 15_000 });
      await expect(wiz.getByRole('checkbox')).toHaveCount(0);
      await shot(page, 'TK1-all');
    });
  });
}
