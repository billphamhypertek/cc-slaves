// v2.2 §6 / §8 E2E Skills & MCP, Skills + Thư mục chung tabs (lane G6b1): K8 filter + plugin fold + Lane switch (T3), K9
// folder (link) + git (valid skills preselected, T6), K10 unlink (T8), K11 copy over a CC Switch link (T7) + "Đã biết" lowers
// the K0 number, K12 columns + switch, Account keeps no moved text, 1024 × 640 K8 no sideways overflow, K8 in English.
// Real engine + fake claude; every skill folder is under the temp dir: CLAUDE_HOME = $E2E_DIR/claude, the app home of the
// skills checks (`~/.cc-switch`, `~/.Trash`) = $E2E_DIR/user (e2e/engine-entry.ts login env).
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { B2, Clicks, expect, recordBudget, test, useEngine, type E2eEngine } from '../fixtures.ts';

const md = (dir: string, name: string, desc: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`); };

/** Runs inside setup, before the engine starts (the `scenarios` hook): skills, a plugin, a git repo, a folder to add. */
function seed(e: E2eEngine): void {
  const skills = join(e.dir, 'claude', 'skills');
  mkdirSync(skills, { recursive: true });
  md(join(e.dir, 'src', 'h-ops-skill'), 'h-ops', 'Unified DevOps toolkit for a server fleet');
  symlinkSync(join(e.dir, 'src', 'h-ops-skill'), join(skills, 'h-ops'));
  md(join(skills, 'gpt-taste'), 'gpt-taste', 'Elite UX/UI and GSAP motion engineer');
  md(join(e.dir, 'user', '.cc-switch', 'skills', 'find-skills'), 'find-skills', 'Find skills for a task');
  symlinkSync(join(e.dir, 'user', '.cc-switch', 'skills', 'find-skills'), join(skills, 'find-skills'));
  mkdirSync(join(skills, 'learned'), { recursive: true }); // no SKILL.md
  const plug = join(e.dir, 'claude', 'plugins', 'cache', 'm', 'ui-kit', '1.0');
  md(join(plug, 'skills', 'banner-design'), 'banner-design', 'Banner design for social heroes');
  md(join(plug, 'skills', 'slides'), 'slides', 'Strategic HTML presentations with taste');
  writeFileSync(join(e.dir, 'claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'ui-kit@m': [{ scope: 'user', installPath: plug }] } }));
  writeFileSync(join(e.dir, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ui-kit@m': true } }));
  const repo = join(e.dir, 'gitrepo');
  md(join(repo, 'skills', 'pdf'), 'pdf', 'PDF tools'); md(join(repo, 'skills', 'docx'), 'docx', 'Word tools');
  md(join(repo, 'skills', 'gpt-taste'), 'gpt-taste', 'taken name'); md(join(repo, 'skills', 'Template Skill'), 'template', 'bad chars');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=e2e@x.test', '-c', 'user.name=e2e', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'skills');
  md(join(e.dir, 'src', 'new-skill'), 'new-skill', 'A folder skill');
}

test.describe('§6 Skills & MCP — Skills + Thư mục chung (real engine)', () => {
  const eng = useEngine({ repos: ['hagenta'], scenarios: e => { seed(e); return {}; } });
  test.use({ viewport: { width: 1280, height: 800 } });
  const view = async () => (await eng.snapshot()).skillsMcp!;
  const skills = () => join(eng.dir, 'claude', 'skills');

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    await eng.addProject('hagenta');
    await expect.poll(async () => (await view()).skills.rows.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(5);
  });

  async function open(page: Page, c?: Clicks): Promise<Locator> {
    await page.goto(eng.url());
    const label = page.locator('#top .smk-l');
    if (c) await c.on(label); else await label.click();
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    const tab = sheet.getByRole('tab', { name: /^Skills/ });
    if (c) await c.on(tab); else await tab.click();
    await expect(sheet.locator('.skl')).toBeVisible();
    return sheet;
  }
  const userRow = (sheet: Locator, name: string) => sheet.locator('.skr', { has: sheet.page().locator('.nm', { hasText: new RegExp(`^${name}$`) }) });
  const issue = (sheet: Locator, code: string, text: string) => sheet.locator(`.ski[data-code="${code}"]`, { hasText: text });

  test('§6 K8 summary + groups; K8-plugin folded with its own switch; K8-filter finds plugin skills; T3 skill switch ≤ 3', async ({ page }) => {
    const c = new Clicks(page);
    const sheet = await open(page, c);
    await expect(sheet.locator('.smsum')).toContainText(/\d+ skill · \d+ của bạn · 2 từ 1 plugin · ~\d+ token mô tả mỗi lane/);
    await expect(sheet.locator('section', { hasText: 'Của bạn' })).toContainText('gpt-taste');
    await expect(sheet).toContainText('hagenta: không có .claude/skills');
    const plugin = sheet.locator('.skp', { hasText: 'ui-kit' });
    await expect(plugin).toContainText('2 skill');
    await expect(plugin).toContainText('plugin · m');
    await expect(plugin).not.toContainText('banner-design');
    await plugin.getByRole('button', { name: 'Mở plugin ui-kit' }).click();
    await expect(plugin).toContainText('banner-design');
    await expect(plugin.locator('.skr.kid').first()).toContainText('Tắt cả plugin để tắt skill này');
    await expect(plugin.locator('.skr.kid [role=switch]')).toHaveCount(0);
    await sheet.getByRole('switch', { name: 'Dùng plugin ui-kit cho lane' }).click();
    await expect.poll(async () => (await eng.snapshot()).config.plugins).toEqual({ offForLanes: ['ui-kit@m'] });
    await sheet.getByRole('switch', { name: 'Dùng plugin ui-kit cho lane' }).click();

    await c.on(sheet.getByRole('switch', { name: 'Dùng skill gpt-taste cho lane' }));
    await expect.poll(async () => ((await eng.snapshot()).config.skills as { offForLanes: string[] }).offForLanes).toEqual(['user:gpt-taste']);
    recordBudget('v2.2 T3 bật/tắt skill cho lane', c.n, 3); expect(c.n).toBeLessThanOrEqual(3);
    await sheet.getByRole('switch', { name: 'Dùng skill gpt-taste cho lane' }).click();

    await plugin.getByRole('button', { name: 'Mở plugin ui-kit' }).click(); // fold again: the filter must open it by itself
    await expect(plugin).not.toContainText('slides');
    await sheet.getByRole('searchbox', { name: 'Lọc skill theo tên và mô tả' }).fill('taste');
    await expect(sheet).toContainText('Khớp "taste" 2');
    await expect(sheet.locator('.skr mark').first()).toHaveText('taste');
    await expect(sheet.locator('.skp', { hasText: 'ui-kit' })).toContainText('slides'); // a description hit in a folded plugin
    await expect(sheet.locator('.skp', { hasText: 'ui-kit' })).not.toContainText('banner-design');
    await expect(sheet.locator('.skrev')).toHaveCount(0);
  });

  test('§6 K9 folder: the engine dry run blocks a taken name (K9-folder lines); link (default) → absolute symlink', async ({ page }) => {
    const sheet = await open(page);
    await sheet.getByRole('button', { name: 'Thêm skill' }).click();
    const k9 = page.getByRole('dialog', { name: 'Thêm skill' });
    await k9.getByRole('tab', { name: 'Thư mục' }).click();
    await k9.getByRole('textbox', { name: 'Thư mục' }).fill(join(eng.dir, 'src', 'h-ops-skill'));
    await expect(k9).toContainText('Có SKILL.md');
    await expect(k9).toContainText('name: h-ops · ký tự hợp lệ');
    await expect(k9).toContainText('Trùng tên: ~/.claude/skills/h-ops đã có (link → chính thư mục này)');
    await expect(k9).toContainText('Sửa lỗi trên để thêm');
    await expect(k9.getByRole('button', { name: 'Thêm', exact: true })).toBeDisabled();
    await k9.getByRole('textbox', { name: 'Thư mục' }).fill(join(eng.dir, 'src', 'new-skill'));
    await expect(k9).toContainText('name: new-skill · ký tự hợp lệ');
    await expect(k9.getByRole('radio', { name: /Liên kết/ })).toBeChecked();
    await k9.getByRole('button', { name: 'Thêm', exact: true }).click();
    await expect(k9).toBeHidden();
    expect(lstatSync(join(skills(), 'new-skill')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(skills(), 'new-skill'))).toMatch(/\/src\/new-skill$/);
    await expect(userRow(sheet, 'new-skill')).toBeVisible();
  });

  test('§6 K9 git: fetch on Enter, every valid skill preselected, taken / bad names blocked; T6 ≤ 5', async ({ page }) => {
    const c = new Clicks(page);
    const sheet = await open(page, c);
    await c.on(sheet.getByRole('button', { name: 'Thêm skill' }));
    const k9 = page.getByRole('dialog', { name: 'Thêm skill' });
    await k9.getByRole('textbox', { name: 'URL git' }).fill(`file://${join(eng.dir, 'gitrepo')}`);
    c.n++; await k9.getByRole('textbox', { name: 'URL git' }).press('Enter'); // the ⌘V / Enter step
    await expect(k9).toContainText('Tìm thấy 4 skill · mọi skill hợp lệ đã chọn sẵn', { timeout: 15_000 });
    await expect(k9.getByRole('checkbox', { name: 'pdf' })).toBeChecked();
    await expect(k9.getByRole('checkbox', { name: 'docx' })).toBeChecked();
    await expect(k9.getByRole('checkbox', { name: /gpt-taste/ })).toBeDisabled();
    await expect(k9.getByRole('checkbox', { name: /Template Skill/ })).not.toBeChecked();
    await expect(k9).toContainText('Đã có ~/.claude/skills/gpt-taste — không ghi đè');
    await expect(k9).toContainText('PDF tools'); // K9-git: each candidate's description
    await expect(k9).toContainText('name "template" ≠ tên thư mục "Template Skill" — không thêm được');
    await c.on(k9.getByRole('button', { name: 'Thêm 2 skill' }));
    await expect(k9).toBeHidden({ timeout: 15_000 });
    expect(existsSync(join(skills(), 'pdf', 'SKILL.md')) && existsSync(join(skills(), 'docx', 'SKILL.md'))).toBe(true);
    await expect(userRow(sheet, 'pdf')).toBeVisible();
    recordBudget('v2.2 T6 thêm skill', c.n, 5); expect(c.n).toBeLessThanOrEqual(5);
  });

  test('§6 K10 unlink: the target stays; T8 skill ≤ 5', async ({ page }) => {
    const c = new Clicks(page);
    const sheet = await open(page, c);
    await c.on(sheet.getByRole('button', { name: 'Thao tác với h-ops' }));
    await c.on(sheet.getByRole('menuitem', { name: 'Gỡ link…' }));
    const k10 = page.getByRole('dialog', { name: 'Gỡ link h-ops?' });
    await expect(k10).toContainText(/Gỡ link h-ops\. Thư mục gốc .*\/src\/h-ops-skill giữ nguyên\./);
    await expect(k10).toContainText('Lane đang chạy dùng tới lần chạy sau.');
    await c.on(k10.getByRole('button', { name: 'Gỡ link' }));
    await expect(k10).toBeHidden();
    expect(existsSync(join(skills(), 'h-ops'))).toBe(false);
    expect(existsSync(join(eng.dir, 'src', 'h-ops-skill', 'SKILL.md'))).toBe(true);
    recordBudget('v2.2 T8 xoá skill', c.n, 5); expect(c.n).toBeLessThanOrEqual(5);
  });

  test('§6 K11 copy over a CC Switch link (T7 ≤ 3); "Đã biết" lowers the K0 number (C23 / C25)', async ({ page }) => {
    const before = (await view()).counts;
    expect(before.skills.yellow).toBe(2); // find-skills (CC Switch) + learned (no SKILL.md)
    await page.goto(eng.url());
    const k0 = page.locator('#top .smk');
    await expect(k0.locator('.smk-n.yellow')).toHaveText(String(before.total.yellow));
    const c = new Clicks(page);
    await c.on(k0.locator('.smk-n.yellow')); // C25: the yellow number opens the tab of its first issue
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await expect(sheet.getByRole('tab', { name: /^Skills/ })).toHaveAttribute('aria-selected', 'true');
    const app = issue(sheet, 'appLink', 'find-skills');
    await expect(app).toContainText('(CC Switch) — gỡ CC Switch là mất');
    await expect(app.getByRole('button', { name: 'Đã biết' })).toHaveCount(0); // lane-breaking: no "Đã biết"
    await c.on(app.getByRole('button', { name: 'Chép vào ~/.claude' }));
    await expect(app).toBeHidden({ timeout: 15_000 });
    expect(lstatSync(join(skills(), 'find-skills')).isDirectory()).toBe(true);
    expect(existsSync(join(eng.dir, 'user', '.cc-switch', 'skills', 'find-skills', 'SKILL.md'))).toBe(true); // CC Switch folder kept
    recordBudget('v2.2 T7 sửa skill lỗi', c.n, 3); expect(c.n).toBeLessThanOrEqual(3);

    const learned = issue(sheet, 'missingSkillMd', 'learned');
    await learned.getByRole('button', { name: 'Đã biết' }).click();
    await expect(sheet.locator('.skack')).toContainText('Đã biết · 1');
    const yel = (n: number) => (n ? expect(k0.locator('.smk-n.yellow')).toHaveText(String(n), { timeout: 10_000 }) : expect(k0.locator('.smk-n.yellow')).toHaveCount(0, { timeout: 10_000 }));
    await yel(before.total.yellow - 2);
    await sheet.locator('.skack').click();
    await sheet.getByRole('button', { name: 'Bỏ đã biết' }).click();
    await yel(before.total.yellow - 1);
  });

  test('§6 K12 Thư mục chung: the v2 §5.2 columns, the switch of an unknown entry, account × links', async ({ page }) => {
    mkdirSync(join(eng.dir, 'claude', 'hooks'), { recursive: true });
    await page.goto(eng.url());
    await page.locator('#top .smk-l').click();
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await sheet.getByRole('tab', { name: /^Thư mục chung/ }).click();
    const col = sheet.locator('.shc');
    await expect(col.nth(0).locator('h4')).toContainText('Dùng chung'); await expect(col.nth(0)).toContainText('skills');
    await expect(col.nth(1).locator('h4')).toContainText('Chép'); await expect(col.nth(1)).toContainText('settings.local.json');
    await expect(col.nth(2).locator('h4')).toContainText('Riêng');
    await expect(col.nth(3).locator('h4')).toContainText('Lạ');
    const sw = sheet.getByRole('switch', { name: 'Dùng chung hooks' });
    await expect(sw).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
    await sw.click();
    await expect.poll(async () => (await eng.snapshot()).config.sharedExtra).toEqual(['hooks']);
    await expect(sheet.locator(`table.sht tr[data-email="${B2}"]`)).toContainText(/(\d+) \/ \1 link/);
    await expect(sheet).not.toContainText('MCP user');
  });

  test('§7 Account: no shared-config list or MCP text in the table and the delete dialog (A6–A9 moved to K12 / K13)', async ({ page }) => {
    await page.goto(eng.url());
    await expect(page.locator('#top .smk')).toBeVisible(); // the ⌘, handler is mounted with the top bar
    await page.keyboard.press('Meta+Comma');
    const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
    await dlg.getByRole('tab', { name: /Account/ }).click();
    await expect(dlg.locator('table.acc-t')).toBeVisible();
    for (const t of ['Cấu hình chung', 'Dùng chung', 'MCP']) await expect(dlg).not.toContainText(t);
    await page.locator(`tr[data-email="${B2}"]`).getByRole('button', { name: `Thao tác cho ${B2}` }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Xoá account…' }).click();
    const del = page.getByRole('dialog', { name: `Xoá ${B2}?` });
    await expect(del).toContainText('Skills, plugins');
    await expect(del).not.toContainText('MCP');
  });

  test('§6 narrow 1024 × 640: K8 has no sideways overflow; explanations wrap', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    const sheet = await open(page);
    expect(Math.round((await sheet.boundingBox())!.width)).toBe(944);
    const over = await sheet.evaluate(el => [el, ...el.querySelectorAll('.smbody, .skl, .skr, .ski, .ski .why, .smsum')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className));
    expect(over).toEqual([]);
  });

  test('§6 K15 K8 in English (ui.lang en): no sideways overflow', async ({ page }) => {
    await eng.cmd({ cmd: 'config_update', patch: { ui: { lang: 'en' } } });
    try {
      await page.setViewportSize({ width: 1024, height: 640 });
      await page.goto(eng.url());
      await page.locator('#top .smk-l').click();
      const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
      await sheet.getByRole('tab', { name: /^Skills/ }).click();
      await expect(sheet.locator('.smsum')).toContainText(/\d+ skills · \d+ yours · 2 from 1 plugins/);
      await expect(sheet).toContainText('Yours');
      const over = await sheet.evaluate(el => [el, ...el.querySelectorAll('.smbody, .skl, .skr, .ski, .ski .why, .smsum')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className));
      expect(over).toEqual([]);
    } finally { await eng.cmd({ cmd: 'config_update', patch: { ui: { lang: 'vi' } } }); }
  });
});
