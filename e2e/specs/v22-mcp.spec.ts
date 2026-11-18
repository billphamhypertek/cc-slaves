// v2.2 §6 / §8 E2E Skills & MCP, MCP tab (lane G6a): K0 numbers + hover + label → MCP + number → tab, K1 groups + Lane switch,
// K4 paste JSON → save (T5 ≤ 4), K5 edit (terminal line, restore with a failing fake `claude mcp`), K6, K7, K14, Esc,
// ⌘K "Thêm MCP…", Account shows no MCP text, 1024 × 640 no sideways overflow, K1 in English. Real engine + fake-claude:
// `claude mcp` writes $E2E_DIR/user/.claude.json (= $CLAUDE_JSON), never the real home (e2e/engine-entry.ts).
// Also the three LeftColumn wiring paths without coverage (prep concern): card click selects its lane, "×" up a level,
// "˄" folds Chờ PO — on the dev mock (web/dev), like v21-leftcol.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { SkillsMcpCounts } from '../../shared/protocol.ts';
import { blur, crumb, openDeck, useDev } from '../deck.ts';
import { B2, Clicks, expect, ORCH, PM, recordBudget, S, SUPERPOWERS, test, useEngine } from '../fixtures.ts';
import { stdioServer } from '../v22-shots-seed.ts';

const SERVERS = {
  linear: { type: 'http', url: 'https://mcp.linear.test/mcp' },
  onedev: { command: 'npx', args: ['-y', 'onedev-mcp'], env: { ONEDEV_TOKEN: 'tok-secret-1' } },
  cbm: { command: 'cbm', args: ['serve'] },
};
const PLUG = 'plugin:ctx7@m:ctx7';
const LANE_INIT = { init: { tools: ['Bash', 'mcp__cc_slaves__ask', 'mcp__onedev__run', 'mcp__onedev__list'], mcp_servers: [{ name: 'cc_slaves', status: 'connected' }, { name: 'linear', status: 'needs-auth' }, { name: 'onedev', status: 'connected' }] }, steps: S.idle() };

test.describe('§6 Skills & MCP — MCP tab (real engine)', () => {
  const eng = useEngine({
    repos: ['hagenta'],
    scenarios: e => ({ [ORCH]: { steps: [...S.startLane(e, 'D2'), ...S.idle()] }, [PM]: LANE_INIT, [B2]: LANE_INIT }),
  });
  test.use({ viewport: { width: 1280, height: 800 } });
  const cj = () => eng.file('claude.json');
  const servers = () => Object.keys((JSON.parse(readFileSync(cj(), 'utf8')) as { mcpServers?: object }).mcpServers ?? {});
  const view = async () => (await eng.snapshot()).skillsMcp!;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    writeFileSync(cj(), JSON.stringify({ mcpServers: SERVERS }, null, 2));
    writeFileSync(join(eng.repo('hagenta'), '.mcp.json'), JSON.stringify({ mcpServers: { postgres: { command: 'npx', args: ['-y', 'pg-mcp', 'postgresql://app:pw@db/x'] } } }));
    const pid = await eng.addProject('hagenta');
    await eng.cmd({ cmd: 'mcp_toggle', id: 'user:cbm', on: false });
    // K1-src: a user plugin whose .mcp.json declares a stdio server with 14 tools (F-I2 / F-I3)
    const plug = join(eng.dir, 'claude', 'plugins', 'cache', 'm', 'ctx7', '1.0');
    mkdirSync(plug, { recursive: true });
    writeFileSync(join(plug, '.mcp.json'), JSON.stringify({ mcpServers: { ctx7: stdioServer(eng, 14, 'ctx') } }));
    writeFileSync(join(eng.dir, 'claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'ctx7@m': [{ scope: 'user', installPath: plug }] } }));
    writeFileSync(join(eng.dir, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ctx7@m': true, ...SUPERPOWERS } }));
    await expect.poll(async () => (await view()).mcp.rows.some(r => r.id === PLUG), { timeout: 15_000 }).toBe(true);
    await eng.cmd({ cmd: 'mcp_check', id: PLUG });
    await expect.poll(async () => (await view()).mcp.rows.find(r => r.id === PLUG)?.tools, { timeout: 20_000 }).toBe(14);
    await eng.openLane(pid, 'D2');
    await expect.poll(async () => (await view()).mcp.rows.find(r => r.name === 'linear')?.status, { timeout: 20_000 }).toBe('needs_login');
  });
  test.beforeEach(() => { writeFileSync(eng.file('auth.env'), ''); });

  async function open(page: Page): Promise<Locator> {
    await page.goto(eng.url());
    await page.locator('#top .smk-l').click();
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await expect(sheet.getByRole('tab', { name: /^MCP/ })).toHaveAttribute('aria-selected', 'true');
    return sheet;
  }
  const rowOf = (sheet: Locator, name: string) => sheet.locator('.smr', { has: sheet.page().locator('.nm', { hasText: new RegExp(`^${name}$`) }) });

  test('§6 K0 the two C25 numbers, hover line; label → MCP; red / yellow number → its first tab', async ({ page }) => {
    const c = (await view()).counts;
    expect(c.mcp.red).toBe(1); // linear: needs login on a lane
    expect(c.mcp.yellow).toBe(1); // postgres: K7 pending
    await page.goto(eng.url());
    const k0 = page.locator('#top .smk');
    await expect(k0.locator('.smk-n.red')).toHaveText(String(c.total.red));
    await expect(k0.locator('.smk-n.yellow')).toHaveText(String(c.total.yellow));
    await expect(k0.locator('.smk-l')).toHaveAttribute('title', /^Skills & MCP · 1 MCP cần đăng nhập \/ lỗi · 1 MCP cần xem/);
    await expect(k0.locator('.smk-n.red')).toHaveAttribute('title', '1 MCP cần đăng nhập / lỗi\nBấm: mở tab MCP'); // F-M1 own hover per number
    await k0.locator('.smk-n.red').click();
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await expect(sheet.getByRole('tab', { name: /^MCP/ })).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.getByRole('tab', { name: /^MCP/ })).toContainText(`${c.mcp.red}`);
    await sheet.getByRole('tab', { name: /^Skills/ }).click();
    await expect(sheet.locator('.skl .smsum')).toContainText('skill'); // G6b: the Skills tab (K8)
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('§6 C25 / C17 label always opens MCP; the yellow number opens the tab of its first issue (Skills here)', async ({ page }) => {
    const counts: SkillsMcpCounts = { mcp: { red: 0, yellow: 0 }, skills: { red: 0, yellow: 4 }, shared: { red: 0, yellow: 1 }, total: { red: 0, yellow: 5 } };
    await page.routeWebSocket(/\/ws/, ws => {
      const server = ws.connectToServer();
      server.onMessage(m => {
        const msg = JSON.parse(String(m)) as { type: string; snapshot?: { skillsMcp?: { counts: unknown } }; event?: { type: string; view?: { counts: unknown } } };
        if (msg.snapshot?.skillsMcp) msg.snapshot.skillsMcp.counts = counts;
        if (msg.event?.type === 'skills_mcp') msg.event.view!.counts = counts;
        ws.send(JSON.stringify(msg));
      });
    });
    await page.goto(eng.url());
    const k0 = page.locator('#top .smk');
    await expect(k0.locator('.smk-n.red')).toHaveCount(0);
    await k0.locator('.smk-l').click();
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await expect(sheet.getByRole('tab', { name: /^MCP/ })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await k0.locator('.smk-n.yellow').click();
    await expect(sheet.getByRole('tab', { name: /^Skills/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('§6 K1 groups in order + K1-local + claude.ai line; the Lane switch moves a row and writes cc-slaves config (T3 ≤ 2, T4 ≤ 2)', async ({ page }) => {
    await page.goto(eng.url());
    const t3 = new Clicks(page);
    await t3.on('#top .smk-l');
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await expect(sheet.locator('.smlist section h4')).toHaveCount(3);
    const heads = await sheet.locator('.smlist section h4').allInnerTexts();
    expect(heads.map(h => h.replace(/\s+\d+$/, '').trim().toUpperCase())).toEqual(['CẦN XEM', 'DÙNG CHO LANE', 'TẮT CHO LANE']);
    await expect(rowOf(sheet, 'linear')).toContainText('Cần đăng nhập');
    await expect(rowOf(sheet, 'linear').getByRole('button', { name: 'Đăng nhập', exact: true })).toHaveAttribute('class', 'btn'); // v2.5 Z20: a plain row button
    await expect(sheet.locator('section', { hasText: 'Tắt cho lane' })).toContainText('cbm');
    await expect(sheet).toContainText('Connector claude.ai: không dùng trong lane — mỗi account một bộ');
    const sw = (await sheet.getByRole('switch', { name: 'Dùng cho lane: onedev' }).boundingBox())!;
    expect(Math.round(sw.height), 'v2.4 §6.7 D53 M2: the Lane switch is ≥ 24 px tall').toBeGreaterThanOrEqual(24);
    await t3.on(sheet.getByRole('switch', { name: 'Dùng cho lane: onedev' }));
    await expect(sheet.locator('section', { hasText: 'Tắt cho lane' })).toContainText('onedev');
    recordBudget('v2.2 T3 bật/tắt MCP cho lane', t3.n, 2); expect(t3.n).toBeLessThanOrEqual(2);
    await expect.poll(async () => (await view()).mcp.rows.find(r => r.name === 'onedev')?.forLanes).toBe(false);
    await sheet.getByRole('switch', { name: 'Dùng cho lane: onedev' }).click();
    await expect.poll(async () => (await view()).mcp.rows.find(r => r.name === 'onedev')?.forLanes).toBe(true);
    // K2 in place: secrets masked (T4: open → the row)
    await page.keyboard.press('Escape');
    const t4 = new Clicks(page);
    await t4.on('#top .smk-l');
    await t4.on(rowOf(sheet, 'onedev').locator('.rowbtn'));
    recordBudget('v2.2 T4 xem chi tiết MCP', t4.n, 2); expect(t4.n).toBeLessThanOrEqual(2);
    await expect(sheet.locator('.smdet')).toContainText('ONEDEV_TOKEN=••••');
    await expect(sheet.locator('.smdet')).not.toContainText('tok-secret-1');
    await expect(sheet.locator('.smdet')).toContainText('Lane đang dùng: D2');
  });

  test('§6 C25 F-I1 every count = rows shown (cc_slaves too); F-I2 K2 tools / login / log; F-I3 plugin "Mở file nguồn" + note', async ({ page }) => {
    const sheet = await open(page);
    const v = await view();
    await expect(sheet.locator('.smr')).toHaveCount(v.mcp.rows.length);
    await expect(sheet.locator('.smsum')).toContainText(`${v.mcp.rows.length} server · ${v.mcp.rows.filter(r => r.forLanes).length} bật cho lane`);
    for (const sec of await sheet.locator('.smlist section').all()) await expect(sec.locator('.smr')).toHaveCount(Number(await sec.locator('h4 > span').innerText()));
    await expect(rowOf(sheet, 'cc_slaves')).toContainText(/\d+ công cụ/);
    await rowOf(sheet, 'linear').locator('.rowbtn').click();
    await expect(sheet.locator('.smdet')).toContainText(/Đăng nhập\s*Chưa đăng nhập/);
    await sheet.getByRole('button', { name: 'Thao tác với ctx7' }).click();
    const menu = sheet.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Kiểm tra', 'Mở file nguồn', 'Sửa / xoá trong plugin ctx7'] /* stdio: no proxy log (orchestrator ruling) */);
    await sheet.getByRole('button', { name: 'Thao tác với ctx7' }).click(); // closes the menu (Esc would close the sheet)
    await rowOf(sheet, 'ctx7').locator('.rowbtn').click();
    const det = rowOf(sheet, 'ctx7').locator('.smdet');
    await expect(det).toContainText('Công cụ · 14');
    await expect(det.getByRole('button', { name: 'Xem log' })).toHaveCount(0);
    await expect(det).toContainText('/plugins/cache/m/ctx7/1.0/.mcp.json');
    await expect(det.getByRole('button', { name: 'Mở file nguồn' })).toBeVisible();
    await expect(det).toContainText('Sửa / xoá trong plugin ctx7');
    await expect(det.locator('.smtools li')).toHaveCount(12);
    await det.getByRole('button', { name: 'Hiện 2 công cụ nữa' }).click();
    await expect(det.locator('.smtools li')).toHaveCount(14);
  });

  test('§6 K4 paste JSON → Lưu (T5 ≤ 4 clicks); a taken name is blocked before writing; Esc closes K4 first', async ({ page }) => {
    await page.goto(eng.url());
    const c = new Clicks(page);
    await c.on('#top .smk-l');
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await c.on(sheet.getByRole('button', { name: 'Thêm MCP' }));
    const k4 = page.getByRole('dialog', { name: 'Thêm MCP' });
    await k4.getByRole('textbox', { name: 'Dán JSON' }).fill('{"onedev":{"command":"x"}}');
    await expect(k4).toContainText('Tên onedev đã có trong ~/.claude.json');
    await expect(k4.getByRole('button', { name: 'Lưu' })).toBeDisabled();
    await k4.getByRole('textbox', { name: 'Dán JSON' }).fill('{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}');
    c.n++; // ⌘V (typing is 0, a paste is one key, §4.3)
    await expect(k4).toContainText(`claude mcp add-json -s user playwright '{"command":"npx","args":["@playwright/mcp@latest"]}'`);
    await c.on(k4.getByRole('button', { name: 'Lưu' }));
    await expect(k4).toBeHidden();
    await expect(rowOf(sheet, 'playwright')).toBeVisible();
    expect(servers()).toContain('playwright');
    recordBudget('v2.2 T5 thêm MCP', c.n, 4); expect(c.n).toBeLessThanOrEqual(4);
    expect(c.n).toBeLessThanOrEqual(4);
    await sheet.getByRole('button', { name: 'Thêm MCP' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Thêm MCP' })).toBeHidden();
    await expect(sheet).toBeVisible();
  });

  test('§6 K5 edit: two commands; the 2nd add-json fails → old entry restored, form kept, "Thử lại" succeeds', async ({ page }) => {
    if (!servers().includes('playwright')) await eng.cmd({ cmd: 'mcp_add', name: 'playwright', config: { command: 'npx', args: ['@playwright/mcp@latest'] } });
    const sheet = await open(page);
    await rowOf(sheet, 'playwright').getByRole('button', { name: 'Thao tác với playwright' }).click();
    await sheet.getByRole('menuitem', { name: 'Sửa' }).click();
    const k5 = page.getByRole('dialog', { name: 'Sửa playwright' });
    await k5.getByLabel('Đối số').fill('@playwright/mcp@next');
    await expect(k5).toContainText('claude mcp remove -s user playwright');
    await expect(k5).toContainText('Bước 2 hỏng → tự thêm lại entry cũ rồi đọc lại');
    const plan = eng.file('mcp-plan.json');
    writeFileSync(plan, JSON.stringify({ 'add-json': ['fail'] }));
    writeFileSync(eng.file('auth.env'), `export FAKE_CLAUDE_MCP_PLAN=${plan}\n`);
    await k5.getByRole('button', { name: 'Lưu' }).click();
    await expect(k5.getByRole('alert')).toContainText('Không ghi được bản mới — đã khôi phục entry cũ');
    await expect(k5.getByLabel('Đối số')).toHaveValue('@playwright/mcp@next');
    const kept = (JSON.parse(readFileSync(cj(), 'utf8')) as { mcpServers: Record<string, { args: string[] }> }).mcpServers.playwright;
    expect(kept?.args).toEqual(['@playwright/mcp@latest']);
    writeFileSync(eng.file('auth.env'), '');
    await k5.getByRole('button', { name: 'Thử lại' }).click();
    await expect(k5).toBeHidden();
    await expect.poll(() => (JSON.parse(readFileSync(cj(), 'utf8')) as { mcpServers: Record<string, { args: string[] }> }).mcpServers.playwright?.args).toEqual(['@playwright/mcp@next']);
    // a remote server: the terminal re-login line
    await rowOf(sheet, 'linear').getByRole('button', { name: 'Thao tác với linear' }).click();
    await sheet.getByRole('menuitem', { name: 'Sửa' }).click();
    await expect(page.getByRole('dialog', { name: 'Sửa linear' })).toContainText('Terminal / VS Code sẽ phải đăng nhập lại linear một lần');
  });

  test('§6 K6 remove: the terminal-too line, lanes in use, then the row and the entry are gone', async ({ page }) => {
    if (!servers().includes('playwright')) await eng.cmd({ cmd: 'mcp_add', name: 'playwright', config: { command: 'npx' } });
    await page.goto(eng.url());
    const c = new Clicks(page);
    await c.on('#top .smk-l');
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await c.on(rowOf(sheet, 'playwright').getByRole('button', { name: 'Thao tác với playwright' }));
    await c.on(sheet.getByRole('menuitem', { name: 'Xoá…' }));
    const k6 = page.getByRole('dialog', { name: 'Xoá playwright?' });
    await expect(k6).toContainText('Xoá khỏi ~/.claude.json — terminal cũng mất server này.');
    await expect(k6).toContainText('Lane D2 đang dùng: mất từ lần chạy sau.');
    await c.on(k6.getByRole('button', { name: 'Xoá' }));
    await expect(k6).toBeHidden();
    recordBudget('v2.2 T8 xoá MCP', c.n, 4); expect(c.n).toBeLessThanOrEqual(4);
    await expect(rowOf(sheet, 'playwright')).toHaveCount(0);
    expect(servers()).not.toContain('playwright');
  });

  test('§6 K7 a new .mcp.json entry waits in Cần xem; "Bật cho lane" moves it to Dùng cho lane', async ({ page }) => {
    const sheet = await open(page);
    const k7 = sheet.locator('.smr.pend', { hasText: 'postgres' });
    await expect(k7).toContainText('project hagenta · mới trong hagenta/.mcp.json');
    await expect(k7).toContainText('postgresql://app:••••@db/x');
    await k7.getByRole('button', { name: 'Bật cho lane' }).click();
    await expect(sheet.locator('section', { hasText: 'Dùng cho lane' })).toContainText('postgres');
    await expect.poll(async () => (await view()).counts.mcp.yellow).toBe(0);
  });

  test('§6 K14 unreadable ~/.claude.json → band with its line; a change while K4 is open → "vừa đổi" + Tải lại', async ({ page }) => {
    const good = readFileSync(cj(), 'utf8');
    const sheet = await open(page);
    await sheet.getByRole('button', { name: 'Thêm MCP' }).click();
    const k4 = page.getByRole('dialog', { name: 'Thêm MCP' });
    writeFileSync(cj(), good.replace('"cbm"', '"cbm2"').replace('"cbm2"', '"cbm"') + '\n');
    await expect(k4).toContainText('~/.claude.json vừa đổi', { timeout: 10_000 });
    await k4.getByRole('button', { name: 'Tải lại' }).click();
    await expect(k4).not.toContainText('~/.claude.json vừa đổi');
    await page.keyboard.press('Escape');
    writeFileSync(cj(), '{\n  "mcpServers": {\n    "x": \n}\n');
    await expect(sheet).toContainText(/Không đọc được ~\/\.claude\.json \(dòng \d+\) — lane dùng bộ đọc được lần cuối/, { timeout: 10_000 });
    writeFileSync(cj(), good);
    await expect(sheet).not.toContainText('Không đọc được', { timeout: 10_000 });
  });

  test('§6 ⌘K "Thêm MCP…" opens K4 directly', async ({ page }) => {
    await page.goto(eng.url());
    await expect(page.locator('#top .smk')).toBeVisible();
    await page.keyboard.press('Meta+k');
    await page.getByRole('textbox', { name: 'Tìm hành động, lane, project' }).fill('Thêm MCP');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Thêm MCP' })).toBeVisible();
  });

  test('§7 Account shows no MCP text: table and the delete dialog', async ({ page }) => {
    await page.goto(eng.url());
    await expect(page.locator('#top .smk')).toBeVisible();
    await page.keyboard.press('Meta+Comma');
    const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
    await dlg.getByRole('tab', { name: /Account/ }).click();
    await expect(dlg.locator('table.acc-t')).toBeVisible();
    await expect(dlg).not.toContainText('MCP');
    await page.locator(`tr[data-email="${B2}"]`).getByRole('button', { name: `Thao tác cho ${B2}` }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Xoá account…' }).click();
    const del = page.getByRole('dialog', { name: `Xoá ${B2}?` });
    await expect(del).toBeVisible();
    await expect(del).not.toContainText('MCP');
    await del.getByRole('button', { name: 'Huỷ' }).click();
    await expect(dlg.getByRole('button', { name: /Cấu hình chung/ })).toHaveCount(0); // §7: the list moved to K12 (v22-skills.spec.ts)
  });

  test('§6 narrow 1024 × 640: K1 has no sideways overflow; the label hides, the numbers stay', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    const sheet = await open(page);
    await expect(page.locator('#top .smk-t')).toBeHidden();
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.width)).toBe(944);
    const over = await sheet.evaluate(el => [el, ...el.querySelectorAll('.smbody, .smr, .smr .why, .smsum')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className));
    expect(over).toEqual([]);
  });

  test('§6 K15 K1 in English (ui.lang en): no sideways overflow', async ({ page }) => {
    await eng.cmd({ cmd: 'config_update', patch: { ui: { lang: 'en' } } });
    try {
      await page.setViewportSize({ width: 1024, height: 640 });
      await page.goto(eng.url());
      await page.locator('#top .smk-l').click();
      const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
      await expect(sheet).toContainText('Needs review');
      await expect(sheet).toContainText('Used by lanes');
      await expect(sheet).toContainText(/\d+ servers · \d+ on for lanes/);
      const over = await sheet.evaluate(el => [el, ...el.querySelectorAll('.smbody, .smr, .smr .why, .smsum')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className));
      expect(over).toEqual([]);
    } finally { await eng.cmd({ cmd: 'config_update', patch: { ui: { lang: 'vi' } } }); }
  });
});

test.describe('§4.11 LeftColumn wiring (dev mock)', () => {
  const dev = useDev();
  const inbox = (page: Page) => page.locator('#inbox');
  test('a Chờ PO card click selects its lane; "×" goes up one level; "˄" folds Chờ PO', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    await inbox(page).locator('.card', { hasText: 'D15' }).first().click({ position: { x: 8, y: 8 } });
    await expect.poll(() => crumb(page)).toMatch(/^Điều phối › D15$/);
    await expect(page.locator('#cardbox')).toBeVisible(); // v2.4 §6.7 the row also opens its detail box; Esc closes it first
    await page.keyboard.press('Escape');
    await expect(page.locator('#cardbox')).toHaveCount(0);
    await expect.poll(() => crumb(page)).toMatch(/^Điều phối › D15$/);
    await page.locator('#inspector button.x').first().click();
    await expect.poll(() => crumb(page)).toBe('Điều phối');
    await blur(page);
    await inbox(page).getByRole('button', { name: /Thu gọn/ }).click();
    await expect(inbox(page)).toHaveClass(/line/);
    await expect(inbox(page).locator('.card')).toHaveCount(0);
  });
});

// UX review v22 F-I5 / F-M6 / F-M7 (lane ux-fix-b): K4 / K5 "Đăng nhập" segment, check line with the PATH lookup and the
// JSON line / column, write errors as a block on top + "Thử lại", the URL change naming the lanes that lose the server.
test.describe('§6 K4 / K5 Đăng nhập · checks · write errors (real engine)', () => {
  const eng = useEngine({
    repos: ['hagenta'],
    scenarios: e => ({ [ORCH]: { steps: [...S.startLane(e, 'D2'), ...S.idle()] }, [PM]: LANE_INIT, [B2]: LANE_INIT }),
  });
  test.use({ viewport: { width: 1280, height: 800 } });
  const cj = () => eng.file('claude.json');
  const entry = (n: string) => (JSON.parse(readFileSync(cj(), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers[n];
  const view = async () => (await eng.snapshot()).skillsMcp!;
  const failNext = (outcome: 'fail' | 'lost', n = 1) => {
    const plan = eng.file('mcp-plan.json');
    writeFileSync(plan, JSON.stringify({ 'add-json': Array(n).fill(outcome) }));
    writeFileSync(eng.file('auth.env'), `export FAKE_CLAUDE_MCP_PLAN=${plan}\n`);
  };

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    writeFileSync(cj(), JSON.stringify({ mcpServers: { linear: SERVERS.linear } }, null, 2));
    const pid = await eng.addProject('hagenta');
    await eng.openLane(pid, 'D2');
  });
  test.beforeEach(() => { writeFileSync(eng.file('auth.env'), ''); });

  async function k4(page: Page): Promise<Locator> {
    await page.goto(eng.url());
    await page.locator('#top .smk-l').click();
    await page.getByRole('dialog', { name: 'Skills & MCP' }).getByRole('button', { name: 'Thêm MCP' }).click();
    return page.getByRole('dialog', { name: 'Thêm MCP' });
  }
  async function k5(page: Page, name: string): Promise<Locator> {
    await page.goto(eng.url());
    await page.locator('#top .smk-l').click();
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await sheet.locator('.smr', { has: page.locator('.nm', { hasText: new RegExp(`^${name}$`) }) }).getByRole('button', { name: `Thao tác với ${name}` }).click();
    await sheet.getByRole('menuitem', { name: 'Sửa' }).click();
    return page.getByRole('dialog', { name: `Sửa ${name}` });
  }

  test('§6 K4 F-M6 paste: the check line names the command found on PATH; bad JSON names line + column and blocks Lưu', async ({ page }) => {
    const d = await k4(page);
    const box = d.getByRole('textbox', { name: 'Dán JSON' });
    await box.fill('{"mcpServers":{"shx":{"command":"sh","args":["-c","true"]}}}');
    await expect(d.locator('.okline')).toHaveText(/^1 server: shx · cục bộ · sh có trên PATH \(\/.*\/sh\) · tên chưa có$/);
    await box.fill('{"mcpServers":{"nope":{"command":"no-such-bin-ccs"}}}');
    await expect(d.locator('.warnline')).toHaveText('no-such-bin-ccs không có trên PATH — lane sẽ không chạy được server này');
    await box.fill('{\n  "mcpServers": {\n    "pw": {\n      "command": "npx"\n      "args": []\n    }\n  }\n}');
    await expect(d.locator('.err')).toHaveText('JSON sai ở dòng 5, cột 7 — kiểm dấu ngoặc / dấu phẩy');
    await expect(d.getByRole('button', { name: 'Lưu' })).toBeDisabled();
  });

  test('§6 K4-form F-I5 "Đăng nhập: Không": URL check line, saved as noLogin → the row has no login, a 401 is an error', async ({ page }) => {
    const d = await k4(page);
    await d.getByRole('tab', { name: 'Điền form' }).click();
    await d.getByRole('radio', { name: 'Từ xa (URL)' }).click();
    await d.getByLabel('Tên').fill('nolog');
    await d.getByLabel('URL').fill('https://nolog.test/mcp');
    const seg = d.getByRole('radiogroup', { name: 'Đăng nhập' });
    await expect(seg.getByRole('radio')).toHaveText(['Tự động (OAuth)', 'Không', 'Client ID']);
    await expect(seg.getByRole('radio', { name: 'Tự động (OAuth)' })).toHaveAttribute('aria-checked', 'true');
    await seg.getByRole('radio', { name: 'Không' }).click();
    await expect(d.locator('.okline')).toHaveText('URL https hợp lệ · tên chưa có');
    await d.getByRole('button', { name: 'Lưu' }).click();
    await expect(d).toBeHidden();
    expect(entry('nolog')).toEqual({ type: 'http', url: 'https://nolog.test/mcp' }); // never a key Claude Code does not know
    await expect.poll(async () => (await view()).mcp.rows.find(r => r.id === 'user:nolog')?.noLogin).toBe(true);
    const row = (await view()).mcp.rows.find(r => r.id === 'user:nolog')!;
    expect(row.oauth).toBeUndefined();
    expect(row.status).not.toBe('needs_login');
    const e5 = await k5(page, 'nolog');
    await expect(e5.getByRole('radio', { name: 'Không' })).toHaveAttribute('aria-checked', 'true');
  });

  test('§6 K5 F-I5 "Client ID": oauth.clientId in "Sẽ chạy:" and in the entry; the secret never in ~/.claude.json', async ({ page }) => {
    const d = await k5(page, 'linear');
    await d.getByRole('radio', { name: 'Client ID' }).click();
    await d.getByLabel('Client ID', { exact: true }).fill('cid-1');
    await d.getByLabel('Client secret (tuỳ chọn)').fill('sec-1');
    await expect(d).toContainText(`claude mcp add-json -s user linear '{"type":"http","url":"https://mcp.linear.test/mcp","oauth":{"clientId":"cid-1"}}'`);
    await d.getByRole('button', { name: 'Lưu' }).click();
    await expect(d).toBeHidden();
    expect(entry('linear')).toEqual({ ...SERVERS.linear, oauth: { clientId: 'cid-1' } });
    expect(readFileSync(cj(), 'utf8')).not.toContain('sec-1');
  });

  test('§6 K5 F-M7 URL change names the lane that loses the server; K4e-restore block on top with the exit text, "Thử lại" saves', async ({ page }) => {
    const d = await k5(page, 'linear');
    await d.getByLabel('URL').fill('https://mcp.linear.test/v2');
    await expect(d.locator('.band.warn')).toContainText('Đổi URL: đăng nhập hiện tại sẽ bị bỏ');
    await expect(d.locator('.band.warn')).toContainText('Lane D2 mất công cụ của server này tới khi đăng nhập.');
    failNext('fail');
    await d.getByRole('button', { name: 'Lưu' }).click();
    const block = d.getByRole('alert');
    await expect(block).toContainText('Không ghi được bản mới — đã khôi phục entry cũ');
    await expect(block).toContainText('`claude mcp add-json` trả exit 1 (fake-claude mcp: add-json failed (plan)). Đã thêm lại bản cũ và đọc lại: khớp. Terminal và lane vẫn có linear.');
    const top = await d.locator('h2').boundingBox(), blk = await block.boundingBox(), url = await d.getByLabel('URL').boundingBox();
    expect(blk!.y).toBeGreaterThan(top!.y);
    expect(blk!.y).toBeLessThan(url!.y); // on top of the form, not by the footer
    await expect(d.getByLabel('URL')).toHaveValue('https://mcp.linear.test/v2');
    writeFileSync(eng.file('auth.env'), '');
    await d.getByRole('button', { name: 'Thử lại' }).click();
    await expect(d).toBeHidden();
    expect(entry('linear')!.url).toBe('https://mcp.linear.test/v2');
  });

  test('§6 K4e-race F-M7 a lost write → red block "Claude Code đang ghi …" + why, primary "Thử lại"', async ({ page }) => {
    const d = await k4(page);
    await d.getByRole('textbox', { name: 'Dán JSON' }).fill('{"racy":{"command":"sh"}}');
    failNext('lost');
    await d.getByRole('button', { name: 'Lưu' }).click();
    const block = d.locator('.band.k4e.bad');
    await expect(block).toContainText('Claude Code đang ghi ~/.claude.json (một phiên terminal đang mở?) — thử lại', { timeout: 10_000 });
    await expect(block).toContainText('Đã ghi rồi đọc lại 2 lần: entry chưa khớp. Không tự sửa file. Server khác trong file còn nguyên.');
    await expect(d.getByRole('button', { name: 'Thử lại' })).toBeEnabled();
  });
});
