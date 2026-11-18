// v2.2 §6 / §14.6 "So với mockup": every frame of docs/specs/assets/screens/v22-mockup/ (K0-a … K15-*, ACC, S1 … S11)
// driven into its state on the real app — real engine, fake-claude (scripted init / stream steps), the fake stdio MCP of
// e2e/v22-shots-seed.ts, fake-mcp + fake AS (K3 / K13), fake `claude mcp`, file-backed fake `security`, temp homes — and
// saved as docs/specs/assets/screens/v22-<frame>.png at the mockup's window (1440 × 900; -narrow / S4-narrow 1024 × 640;
// K0-d 1180 × 900). Looks are judged later by an independent UX review against the mockup PNG of the same name; here
// only "the state is reached". Four states are page-side patches of the engine's view (K1-load, K3-find, K3e-timeout,
// K4e-cli: the engine cannot hold them still) — listed in the lane report ⑤.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { B2, expect, ORCH, PM, S, test, useEngine, type E2eEngine } from '../fixtures.ts';
import {
  MACHINE_INIT, breakSharedLink, loggedIn, machineJson, patchView, seedMachine, seedSkillIssues, stdioServer, streamLanes, streamOrch,
} from '../v22-shots-seed.ts';

const DIR = join(import.meta.dirname, '../../docs/specs/assets/screens');
const NARROW = { width: 1024, height: 640 };

async function shot(page: Page, frame: string): Promise<void> {
  await page.waitForTimeout(400);
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `v22-${frame}.png`) });
}
const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'Skills & MCP' });
const rowOf = (sheet: Locator, name: string) => sheet.locator('.smr', { has: sheet.page().locator('.nm', { hasText: new RegExp(`^${name}$`) }) });

async function openSheet(e: E2eEngine, page: Page, tab: 'MCP' | 'Skills' | 'Thư mục chung' = 'MCP'): Promise<Locator> {
  await page.goto(e.url());
  await page.locator('#top .smk-l').click();
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  if (tab !== 'MCP') await sheet.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
  return sheet;
}
const lang = (e: E2eEngine, l: 'vi' | 'en') => e.cmd({ cmd: 'config_update', patch: { ui: { lang: l } } });
/** The boot catalog is built and its §5.4b auto checks are done (project_add on a loaded machine waits otherwise). */
const settled = (e: E2eEngine) => expect.poll(async () => {
  const v = (await e.snapshot()).skillsMcp;
  return !!v && !v.mcp.rows.some((r) => r.checking);
}, { timeout: 60_000 }).toBe(true);

// ---------------------------------------------------------------------------------------------------------------------
test.describe('§6 K0-a / K1-empty / K1-load — a machine with no MCP and no issue', () => {
  const eng = useEngine({ repos: ['hagenta'] });
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    writeFileSync(eng.file('claude.json'), JSON.stringify({ mcpServers: {} }));
    await eng.addProject('hagenta');
  });

  test('K0-a no issue: icon + label, no number', async ({ page }) => {
    await page.goto(eng.url());
    await expect(page.locator('#top .smk-l')).toBeVisible();
    await expect(page.locator('#top .smk-n')).toHaveCount(0);
    await shot(page, 'K0-a');
  });
  test('K1-empty only cc_slaves', async ({ page }) => {
    const sheet = await openSheet(eng, page);
    await expect(sheet.locator('.smempty')).toBeVisible();
    await shot(page, 'K1-empty');
  });
  test('K1-load the catalog still building (patched: no view yet)', async ({ page }) => {
    await patchView(page, () => null);
    await page.goto(eng.url());
    await expect(page.locator('#inspector')).toBeVisible();
    await page.keyboard.press('Meta+k');
    await page.getByRole('textbox', { name: 'Tìm hành động, lane, project' }).fill('Skills & MCP');
    await page.keyboard.press('Enter');
    await expect(sheetOf(page).locator('.smlist[aria-busy=true]')).toBeVisible();
    await shot(page, 'K1-load');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('§6 K0–K15 the mockup default machine (MCP red 2, Skills yellow 4, Thư mục chung yellow 1)', () => {
  const eng = useEngine({
    repos: ['hagenta', 'cc-slaves'],
    scenarios: (e) => { seedMachine(e); return { [ORCH]: { steps: [...S.startLane(e, 'D2'), ...S.startLane(e, 'B3'), ...S.idle()] }, [PM]: MACHINE_INIT, [B2]: MACHINE_INIT }; },
  });
  test.describe.configure({ mode: 'serial' });
  const view = async () => (await eng.snapshot()).skillsMcp!;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await settled(eng);
    const pid = await eng.addProject('hagenta');
    await eng.addProject('cc-slaves');
    await eng.cmd({ cmd: 'mcp_toggle', id: 'user:codebase-memory-mcp', on: false });
    await eng.cmd({ cmd: 'mcp_check', id: 'user:codebase-memory-mcp' });
    await eng.openLane(pid, 'D2');
    await eng.openLane(pid, 'B3');
    breakSharedLink(eng);
    await expect.poll(async () => (await view()).counts, { timeout: 30_000 }).toMatchObject({ mcp: { red: 2 }, skills: { yellow: 4 }, shared: { yellow: 1 } });
  });

  test('K0-b the two numbers', async ({ page }) => {
    await page.goto(eng.url());
    await expect(page.locator('#top .smk-n.red')).toHaveText('2');
    await shot(page, 'K0-b');
  });
  test('K0-c hover the red number', async ({ page }) => {
    await page.goto(eng.url());
    await page.locator('#top .smk-n.red').hover();
    await page.waitForTimeout(1200);
    await shot(page, 'K0-c');
  });
  test('K0-c2 hover the yellow number', async ({ page }) => {
    await page.goto(eng.url());
    await page.locator('#top .smk-n.yellow').hover();
    await page.waitForTimeout(1200);
    await shot(page, 'K0-c2');
  });
  test('K0-d window 1180 px: icon + two numbers', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.goto(eng.url());
    await expect(page.locator('#top .smk-n.red')).toBeVisible();
    await shot(page, 'K0-d');
  });
  test('K1 the label opens MCP', async ({ page }) => {
    const sheet = await openSheet(eng, page);
    await expect(rowOf(sheet, 'vercel')).toContainText('Cần đăng nhập');
    await expect(rowOf(sheet, 'miro')).toContainText('14');
    await shot(page, 'K1');
  });
  test('K1-claudeai the connector line opened', async ({ page }) => {
    const sheet = await openSheet(eng, page);
    await sheet.locator('.smcai').click();
    await expect(sheet.locator('.smcai-x')).toBeVisible();
    await sheet.locator('.smcai').scrollIntoViewIfNeeded();
    await shot(page, 'K1-claudeai');
  });
  test('K1-src "⋯" on a plugin server', async ({ page }) => {
    const sheet = await openSheet(eng, page);
    await sheet.getByRole('button', { name: 'Thao tác với vercel' }).click();
    await expect(sheet.getByRole('menuitem').first()).toBeVisible();
    await shot(page, 'K1-src');
  });
  test('K2 miro opened in place: logged in, the 14 tools of its lane report (R-I2)', async ({ page }) => {
    await patchView(page, loggedIn('miro'));
    const sheet = await openSheet(eng, page);
    await rowOf(sheet, 'miro').locator('.rowbtn').click();
    await expect(sheet.locator('.smdet .smlogin.ok')).toContainText('Đã đăng nhập');
    await expect(sheet.locator('.smdet .smtools')).toContainText('Công cụ · 14');
    await expect(sheet.locator('.smdet .smtools')).toContainText('Hiện 2 công cụ nữa');
    await shot(page, 'K2');
  });
  test('K2-key hcm (local ~): header masked', async ({ page }) => {
    const sheet = await openSheet(eng, page);
    await rowOf(sheet, 'hcm').locator('.rowbtn').click();
    await expect(sheet.locator('.smdet')).toContainText('••••');
    await sheet.locator('.smdet').scrollIntoViewIfNeeded();
    await shot(page, 'K2-key');
  });
  test('K1-narrow 1024 × 640', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await openSheet(eng, page);
    await shot(page, 'K1-narrow');
  });
  test('K15-K1 English MCP list', async ({ page }) => {
    await lang(eng, 'en');
    try {
      const sheet = await openSheet(eng, page);
      await expect(sheet).toContainText('Needs review');
      await shot(page, 'K15-K1');
    } finally { await lang(eng, 'vi'); }
  });

  // ---------- Skills (K8–K12) ----------
  test('K8 Skills tab', async ({ page }) => {
    const sheet = await openSheet(eng, page, 'Skills');
    await expect(sheet.locator('.skl')).toBeVisible();
    await shot(page, 'K8');
  });
  test('K8-plugin scrolled to the plugins, ui-ux-pro-max opened', async ({ page }) => {
    const sheet = await openSheet(eng, page, 'Skills');
    await sheet.getByRole('button', { name: 'Mở plugin ui-ux-pro-max' }).click();
    await sheet.locator('.skp', { hasText: 'ui-ux-pro-max' }).scrollIntoViewIfNeeded();
    await shot(page, 'K8-plugin');
  });
  test('K8-filter "taste"', async ({ page }) => {
    const sheet = await openSheet(eng, page, 'Skills');
    await sheet.getByRole('searchbox', { name: 'Lọc skill theo tên và mô tả' }).fill('taste');
    await expect(sheet.locator('.skr mark').first()).toBeVisible();
    await shot(page, 'K8-filter');
  });
  test('K8-menu "⋯" on a linked skill', async ({ page }) => {
    const sheet = await openSheet(eng, page, 'Skills');
    await sheet.getByRole('button', { name: 'Thao tác với h-ops' }).click();
    await expect(sheet.getByRole('menuitem', { name: 'Gỡ link…' })).toBeVisible();
    await shot(page, 'K8-menu');
  });
  test('K8-narrow 1024 × 640', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await openSheet(eng, page, 'Skills');
    await shot(page, 'K8-narrow');
  });
  test('K15-K8 English Skills tab', async ({ page }) => {
    await lang(eng, 'en');
    try {
      const sheet = await openSheet(eng, page, 'Skills');
      await expect(sheet.locator('.skl')).toBeVisible();
      await shot(page, 'K15-K8');
    } finally { await lang(eng, 'vi'); }
  });
  test('K12 Thư mục chung', async ({ page }) => {
    const sheet = await openSheet(eng, page, 'Thư mục chung');
    await expect(sheet.locator('table.sht')).toBeVisible();
    await shot(page, 'K12');
  });
  test('ACC the deck Account panel: b2@ says in words why it takes no lanes; its chip opens K12', async ({ page }) => {
    await page.goto(eng.url());
    await expect(page.locator('#top .smk')).toBeVisible();
    await page.keyboard.press('a');
    const row = page.locator(`.accp.open .acrow[data-email="${B2}"]`);
    await expect(row.locator('.achip')).toHaveText('⚠ cấu hình chung lỗi ›', { timeout: 30_000 });
    expect(await row.locator('.achip').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true); // the words are never cut
    await page.mouse.move(2, 2); // no row tooltip in the frame
    await shot(page, 'ACC');
    // the chip sits on the row's click layer: a click on it is the row's click → K12 (force: the layer, not the chip, takes the pointer)
    await row.locator('.achip').click({ force: true });
    const sheet = sheetOf(page);
    await expect(sheet.locator('table.sht')).toBeVisible();
    await expect(sheet.getByRole('tab', { name: /^Thư mục chung/ })).toHaveAttribute('aria-selected', 'true');
  });
  test('K9-git a pasted URL fetches; valid skills preselected', async ({ page }) => {
    const sheet = await openSheet(eng, page, 'Skills');
    await sheet.getByRole('button', { name: 'Thêm skill' }).click();
    const k9 = page.getByRole('dialog', { name: 'Thêm skill' });
    await k9.getByRole('textbox', { name: 'URL git' }).fill(`file://${join(eng.dir, 'gitrepo')}`);
    await k9.getByRole('textbox', { name: 'URL git' }).press('Enter');
    await expect(k9).toContainText('mọi skill hợp lệ đã chọn sẵn', { timeout: 15_000 });
    await shot(page, 'K9-git');
  });
  test('K9-folder a taken name blocks Thêm', async ({ page }) => {
    const sheet = await openSheet(eng, page, 'Skills');
    await sheet.getByRole('button', { name: 'Thêm skill' }).click();
    const k9 = page.getByRole('dialog', { name: 'Thêm skill' });
    await k9.getByRole('tab', { name: 'Thư mục' }).click();
    await k9.getByRole('textbox', { name: 'Thư mục' }).fill(join(eng.dir, 'src', 'h-ops'));
    await expect(k9).toContainText('Trùng tên');
    await shot(page, 'K9-folder');
  });
  test('K10-link unlink h-ops (confirm shown, then Huỷ)', async ({ page }) => {
    const sheet = await openSheet(eng, page, 'Skills');
    await sheet.getByRole('button', { name: 'Thao tác với h-ops' }).click();
    await sheet.getByRole('menuitem', { name: 'Gỡ link…' }).click();
    await expect(page.getByRole('dialog', { name: 'Gỡ link h-ops?' })).toBeVisible();
    await shot(page, 'K10-link');
  });
  test('K10-dir remove a real folder (confirm shown, then Huỷ)', async ({ page }) => {
    const sheet = await openSheet(eng, page, 'Skills');
    await sheet.getByRole('button', { name: 'Thao tác với codebase-memory' }).click();
    await sheet.getByRole('menuitem', { name: 'Xoá…' }).click();
    await expect(page.getByRole('dialog').last()).toContainText('Thùng rác');
    await shot(page, 'K10-dir');
  });

  // ---------- add / edit / remove (K4–K6) ----------
  const addDlg = async (page: Page) => {
    const sheet = await openSheet(eng, page);
    await sheet.getByRole('button', { name: 'Thêm MCP' }).click();
    return page.getByRole('dialog', { name: 'Thêm MCP' });
  };
  const PLAYWRIGHT = '{\n  "mcpServers": {\n    "playwright": {\n      "command": "npx",\n      "args": ["@playwright/mcp@latest"]\n    }\n  }\n}';
  test('K4 paste JSON: instant check + "Sẽ chạy:"', async ({ page }) => {
    const k4 = await addDlg(page);
    await k4.getByRole('textbox', { name: 'Dán JSON' }).fill(PLAYWRIGHT);
    await expect(k4).toContainText('claude mcp add-json -s user playwright');
    await shot(page, 'K4');
  });
  test('K4-bad broken JSON: line / column, Lưu blocked', async ({ page }) => {
    const k4 = await addDlg(page);
    await k4.getByRole('textbox', { name: 'Dán JSON' }).fill(PLAYWRIGHT.replace('"args"', 'args'));
    await expect(k4.getByRole('button', { name: 'Lưu' })).toBeDisabled();
    await shot(page, 'K4-bad');
  });
  test('K4-form remote, URL, header', async ({ page }) => {
    const k4 = await addDlg(page);
    await k4.getByRole('tab', { name: 'Điền form' }).click();
    await k4.locator('.frow input').first().fill('linear');
    await k4.getByRole('radio', { name: /Từ xa/ }).click();
    await k4.getByLabel('URL').fill('https://mcp.linear.app/mcp');
    await shot(page, 'K4-form');
  });
  test('K4e-race Claude Code keeps writing ~/.claude.json: error, form kept', async ({ page }) => {
    test.setTimeout(90_000);
    const plan = eng.file('mcp-plan.json');
    writeFileSync(plan, JSON.stringify({ 'add-json': ['lost', 'lost', 'lost', 'lost'] }));
    writeFileSync(eng.file('auth.env'), `export FAKE_CLAUDE_MCP_PLAN=${plan}\n`);
    try {
      const k4 = await addDlg(page);
      await k4.getByRole('textbox', { name: 'Dán JSON' }).fill(PLAYWRIGHT);
      await k4.getByRole('button', { name: 'Lưu' }).click();
      await expect(k4.getByRole('alert')).toBeVisible({ timeout: 60_000 });
      await shot(page, 'K4e-race');
    } finally { writeFileSync(eng.file('auth.env'), ''); }
  });
  test('K4e-cli `claude` not found (patched view: claude.found = false)', async ({ page }) => {
    await patchView(page, (v) => ({ ...v, claude: { ...v.claude, found: false } }));
    await openSheet(eng, page);
    await expect(sheetOf(page).locator('.band.bad')).toBeVisible();
    await shot(page, 'K4e-cli');
  });

  test.describe('vercel-team (user, remote) added', () => {
    test.beforeAll(async () => {
      writeFileSync(eng.file('claude.json'), JSON.stringify(machineJson(eng, { 'vercel-team': { type: 'http', url: 'https://mcp.vercel.com/team-hypertek' } }), null, 2));
      await expect.poll(async () => (await view()).mcp.rows.some((r) => r.name === 'vercel-team'), { timeout: 15_000 }).toBe(true);
    });
    const menuOf = async (page: Page) => {
      const sheet = await openSheet(eng, page);
      await sheet.getByRole('button', { name: 'Thao tác với vercel-team' }).click();
      return sheet;
    };
    test('K1-menu "⋯" on a user remote server', async ({ page }) => {
      const sheet = await menuOf(page);
      await expect(sheet.getByRole('menuitem', { name: 'Xoá…' })).toBeVisible();
      await shot(page, 'K1-menu');
    });
    test('K5 edit vercel-team, URL changed', async ({ page }) => {
      const sheet = await menuOf(page);
      await sheet.getByRole('menuitem', { name: 'Sửa' }).click();
      const k5 = page.getByRole('dialog', { name: 'Sửa vercel-team' });
      await k5.getByLabel('URL').fill('https://mcp.vercel.com/team-hypertek-v2');
      await expect(k5).toContainText('claude mcp remove -s user vercel-team');
      await shot(page, 'K5');
    });
    test('K4e-restore step 2 fails → old entry restored, form kept, Thử lại', async ({ page }) => {
      const plan = eng.file('mcp-plan.json');
      writeFileSync(plan, JSON.stringify({ 'add-json': ['fail'] }));
      writeFileSync(eng.file('auth.env'), `export FAKE_CLAUDE_MCP_PLAN=${plan}\n`);
      try {
        const sheet = await menuOf(page);
        await sheet.getByRole('menuitem', { name: 'Sửa' }).click();
        const k5 = page.getByRole('dialog', { name: 'Sửa vercel-team' });
        await k5.getByLabel('URL').fill('https://mcp.vercel.com/team-hypertek-v2');
        await k5.getByRole('button', { name: 'Lưu' }).click();
        await expect(k5.getByRole('alert')).toContainText('đã khôi phục entry cũ', { timeout: 30_000 });
        await shot(page, 'K4e-restore');
      } finally { writeFileSync(eng.file('auth.env'), ''); }
    });
    test('K6 remove vercel-team (confirm shown)', async ({ page }) => {
      const sheet = await menuOf(page);
      await sheet.getByRole('menuitem', { name: 'Xoá…' }).click();
      await expect(page.getByRole('dialog', { name: 'Xoá vercel-team?' })).toBeVisible();
      await shot(page, 'K6');
    });
    test('K14-changed ~/.claude.json changes while K5 is open', async ({ page }) => {
      const sheet = await menuOf(page);
      await sheet.getByRole('menuitem', { name: 'Sửa' }).click();
      const k5 = page.getByRole('dialog', { name: 'Sửa vercel-team' });
      await expect(k5).toBeVisible();
      writeFileSync(eng.file('claude.json'), `${JSON.stringify(machineJson(eng, { 'vercel-team': { type: 'http', url: 'https://mcp.vercel.com/team-hypertek' } }), null, 2)}\n\n`);
      await expect(k5).toContainText('~/.claude.json vừa đổi', { timeout: 15_000 });
      await shot(page, 'K14-changed');
    });
  });

  test('K14-json ~/.claude.json broken: band + Mở file', async ({ page }) => {
    const good = JSON.stringify(machineJson(eng), null, 2);
    writeFileSync(eng.file('claude.json'), good.replace('"mcpServers": {', '"mcpServers": {\n    "x": ,'));
    try {
      const sheet = await openSheet(eng, page);
      await expect(sheet).toContainText('Không đọc được ~/.claude.json', { timeout: 15_000 });
      await shot(page, 'K14-json');
    } finally {
      writeFileSync(eng.file('claude.json'), good);
      await expect.poll(async () => (await view()).claudeJson.ok, { timeout: 15_000 }).toBe(true);
    }
  });

  test.describe('K2-zero / K2-err extra servers checked', () => {
    test.beforeAll(async () => {
      const zero = stdioServer(eng, 0, 'zero');
      writeFileSync(eng.file('claude.json'), JSON.stringify(machineJson(eng, { 'miro-zero': zero, 'pg-local': { command: '/usr/bin/false', args: ['--serve'] } }), null, 2));
      await expect.poll(async () => (await view()).mcp.rows.filter((r) => r.name === 'miro-zero' || r.name === 'pg-local').length, { timeout: 15_000 }).toBe(2);
      await eng.cmd({ cmd: 'mcp_check', id: 'user:miro-zero' });
      await eng.cmd({ cmd: 'mcp_check', id: 'user:pg-local' });
      await expect.poll(async () => (await view()).mcp.rows.find((r) => r.name === 'pg-local')?.status, { timeout: 20_000 }).toBe('error');
    });
    test.afterAll(async () => { writeFileSync(eng.file('claude.json'), JSON.stringify(machineJson(eng), null, 2)); });
    test('K2-zero connected, 0 tools', async ({ page }) => {
      const sheet = await openSheet(eng, page);
      await rowOf(sheet, 'miro-zero').locator('.rowbtn').click();
      await shot(page, 'K2-zero');
    });
    test('K2-err a failing server: cause + fix + Xem log', async ({ page }) => {
      const sheet = await openSheet(eng, page);
      await rowOf(sheet, 'pg-local').locator('.rowbtn').click();
      await shot(page, 'K2-err');
    });
  });

  test('K7 a new .mcp.json entry of hagenta', async ({ page }) => {
    writeFileSync(join(eng.repo('hagenta'), '.mcp.json'), JSON.stringify({ mcpServers: { postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://app:pw@db/hagenta'] } } }));
    try {
      const sheet = await openSheet(eng, page);
      await expect(sheet.locator('.smr.pend')).toBeVisible({ timeout: 15_000 });
      await shot(page, 'K7');
    } finally { rmSync(join(eng.repo('hagenta'), '.mcp.json'), { force: true }); }
  });

  // ---------- K11 every issue kind ----------
  test.describe('K11 every skill issue', () => {
    test.beforeAll(async () => {
      seedSkillIssues(eng);
      mkdirSync(join(eng.dir, 'claude', '.git'), { recursive: true });
      await eng.cmd({ cmd: 'project_add', name: 'claude-home', path: join(eng.dir, 'claude') }); // its root holds ~/.claude/skills (#109687)
      await expect.poll(async () => (await view()).skills.issues.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(7);
    });
    test('K11 Cần xem with every kind', async ({ page }) => {
      await openSheet(eng, page, 'Skills');
      await shot(page, 'K11');
    });
    test('K11-ack after "Đã biết" on synced, the duplicate and #109687', async ({ page }) => {
      const sheet = await openSheet(eng, page, 'Skills');
      for (const code of ['missingSkillMd', 'duplicate', 'nestedSkillsDir']) {
        const row = code === 'missingSkillMd' ? sheet.locator(`.ski[data-code="${code}"]`, { hasText: 'synced' }) : sheet.locator(`.ski[data-code="${code}"]`).first();
        await row.getByRole('button', { name: 'Đã biết' }).click();
        await expect(row).toBeHidden();
      }
      await sheet.locator('.skack').click();
      await shot(page, 'K11-ack');
    });
    test('K11-fix "Chép vào ~/.claude" on a CC Switch link', async ({ page }) => {
      const sheet = await openSheet(eng, page, 'Skills');
      await sheet.locator('.ski[data-code="appLink"]', { hasText: 'find-skills' }).getByRole('button', { name: 'Chép vào ~/.claude' }).click();
      await page.waitForTimeout(300);
      await shot(page, 'K11-fix');
    });
  });

  test('K14-off engine lost: dimmed, switches locked (the engine is killed: last frame of this engine)', async ({ page }) => {
    const sheet = await openSheet(eng, page);
    await expect(rowOf(sheet, 'miro')).toBeVisible();
    await eng.kill();
    await expect(sheet.locator('.band.bad', { hasText: 'Mất kết nối' })).toBeVisible({ timeout: 15_000 });
    await shot(page, 'K14-off');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('§6 K3 / K3e / K13 MCP login (fake AS)', () => {
  const ID = 'user:vercel';
  const LANE = { init: { tools: ['Bash', 'mcp__cc_slaves__ask'], mcp_servers: [{ name: 'cc_slaves', status: 'connected' }] }, steps: S.idle() };
  const eng = useEngine({
    repos: ['hagenta', 'cc-slaves'], env: { E2E_FAKE_AS: '1' },
    scenarios: (e) => ({ [ORCH]: { steps: [...S.startLane(e, 'D2'), ...S.idle()] }, [PM]: LANE, [B2]: LANE }),
  });
  test.describe.configure({ mode: 'serial' });
  let bare: Server | null = null; // K3e-meta / K3e-net: a remote server that answers 401 and has no OAuth metadata
  const row = async (id = ID) => (await eng.snapshot()).skillsMcp?.mcp.rows.find((r) => r.id === id);
  /** fake-as.json is applied (then removed) on the AS's next request: knobs written before that merge. */
  const knobs = (k: Record<string, unknown>) => {
    const was = (JSON.parse(eng.read('fake-as.json') || '{}') as { as?: Record<string, unknown> }).as ?? {};
    writeFileSync(eng.file('fake-as.json'), JSON.stringify({ as: { ...was, ...k } }));
  };
  const card = (page: Page) => page.locator('#inbox .card:not(.done)', { hasText: 'MCP vercel cần đăng nhập' });

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    bare = createServer((_req, res) => { res.writeHead(_req.url?.startsWith('/.well-known') ? 404 : 401, { 'www-authenticate': 'Bearer' }); res.end(); });
    await new Promise<void>((r) => bare!.listen(0, '127.0.0.1', r));
    const barePort = (bare.address() as { port: number }).port;
    await expect.poll(() => eng.read('fake-as.origin'), { timeout: 10_000 }).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    writeFileSync(eng.file('claude.json'), JSON.stringify({ mcpServers: {
      vercel: { type: 'http', url: `${eng.read('fake-as.origin')}/v3/mcp` }, context7: { type: 'http', url: `http://127.0.0.1:${barePort}/mcp` },
    } }));
    await expect.poll(async () => (await row('user:context7'))?.id, { timeout: 30_000 }).toBe('user:context7');
    await settled(eng);
    const pid = await eng.addProject('hagenta');
    await eng.addProject('cc-slaves');
    await expect.poll(async () => (await row())?.oauth?.loggedIn, { timeout: 20_000 }).toBe(false);
    await eng.openLane(pid, 'D2');
    await eng.cmd({ cmd: 'mcp_check', id: ID });
    await eng.cmd({ cmd: 'mcp_check', id: 'user:context7' });
    await expect.poll(async () => (await eng.snapshot()).cards.some((c) => c.kind === 'mcp_login' && c.status === 'open'), { timeout: 20_000 }).toBe(true);
  });
  test.afterAll(() => { bare?.close(); });

  const loginFrom = async (page: Page, name = 'vercel') => {
    const sheet = await openSheet(eng, page);
    await rowOf(sheet, name).getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    return page.getByRole('dialog', { name: `Đăng nhập ${name}` });
  };
  /** Ends the login the frame left open (the engine side, whatever the dialog shows). */
  const cancel = async (id = ID) => {
    await eng.cmd({ cmd: 'mcp_login_cancel', id }).catch(() => undefined);
    await expect.poll(async () => (await row(id))?.oauth?.login ?? null).toBeNull();
  };

  test('K13 the Chờ PO card', async ({ page }) => {
    await page.goto(eng.url());
    await expect(card(page)).toBeVisible();
    await shot(page, 'K13');
  });
  test('K13-remote the phone: no button', async ({ page }) => {
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((m) => {
        const msg = JSON.parse(String(m)) as { snapshot?: { channel?: string } };
        if (msg.snapshot) msg.snapshot.channel = 'remote';
        ws.send(JSON.stringify(msg));
      });
    });
    await page.goto(eng.url());
    await expect(card(page)).toBeVisible();
    await shot(page, 'K13-remote');
  });
  test('K3-find finding the login server (patched: phase held at discovering)', async ({ page }) => {
    await patchView(page, (v) => ({ ...v, mcp: { ...v.mcp, rows: v.mcp.rows.map((r) => (r.id === ID && r.oauth ? { ...r, oauth: { ...r.oauth, error: null, login: { phase: 'discovering', url: null, until: null } } } : r)) } }));
    const dlg = await loginFrom(page);
    await expect(dlg).toContainText('Đang tìm máy chủ đăng nhập');
    await shot(page, 'K3-find');
    await cancel();
  });
  test('K3 waiting for the browser', async ({ page }) => {
    const dlg = await loginFrom(page);
    await expect(dlg).toContainText('Đang chờ trình duyệt', { timeout: 15_000 });
    await shot(page, 'K3');
    await cancel();
  });
  test('K15-K3 English: waiting for the browser', async ({ page }) => {
    await lang(eng, 'en');
    try {
      await page.goto(eng.url());
      await page.locator('#top .smk-l').click();
      const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
      await rowOf(sheet, 'vercel').getByRole('button', { name: 'Log in', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: /vercel$/ });
      await expect(dlg).toContainText(/browser/i, { timeout: 15_000 });
      await shot(page, 'K15-K3');
      await cancel();
    } finally { await lang(eng, 'vi'); }
  });
  test('K3e-denied the PO declined in the browser', async ({ page }) => {
    knobs({ deny: 'The user said no' });
    const dlg = await loginFrom(page);
    await expect(dlg).toContainText('Đang chờ trình duyệt', { timeout: 15_000 });
    await fetch((await row())!.oauth!.login!.url!);
    await expect(dlg).toContainText('Bạn đã từ chối trên trình duyệt', { timeout: 15_000 });
    await shot(page, 'K3e-denied');
    knobs({ deny: null });
    await cancel();
  });
  test('K3e-client no automatic registration: Client ID', async ({ page }) => {
    knobs({ noDcr: true });
    const dlg = await loginFrom(page);
    await expect(dlg).toContainText('nhập Client ID', { timeout: 15_000 });
    await shot(page, 'K3e-client');
    knobs({ noDcr: false });
    await cancel();
  });
  test('K3e-iss the server answers another issuer', async ({ page }) => {
    knobs({ issuer: 'https://auth.other.test' });
    const dlg = await loginFrom(page);
    await expect(dlg).toContainText('issuer khác', { timeout: 15_000 });
    await shot(page, 'K3e-iss');
    knobs({ issuer: null });
    await cancel();
  });
  test('K3e-s256 no PKCE S256', async ({ page }) => {
    knobs({ methods: ['plain'] });
    const dlg = await loginFrom(page);
    await expect(dlg).toContainText('S256', { timeout: 15_000 });
    await shot(page, 'K3e-s256');
    knobs({ methods: ['S256'] });
    await cancel();
  });
  test('K3e-timeout 10 minutes passed (patched: error timeout)', async ({ page }) => {
    await patchView(page, (v) => ({ ...v, mcp: { ...v.mcp, rows: v.mcp.rows.map((r) => (r.id === ID && r.oauth ? { ...r, oauth: { ...r.oauth, login: null, error: 'timeout' } } : r)) } }));
    const dlg = await loginFrom(page);
    await expect(dlg).toContainText('Hết giờ', { timeout: 15_000 });
    await shot(page, 'K3e-timeout');
    await cancel();
  });
  test('K3e-meta no OAuth metadata', async ({ page }) => {
    const dlg = await loginFrom(page, 'context7');
    await expect(dlg).toContainText('Không tìm thấy thông tin đăng nhập', { timeout: 15_000 });
    await shot(page, 'K3e-meta');
    await cancel('user:context7');
  });
  test('K3e-net network error', async ({ page }) => {
    await new Promise<void>((r) => { bare!.close(() => r()); bare!.closeAllConnections(); });
    bare = null;
    const dlg = await loginFrom(page, 'context7');
    await expect(dlg).toContainText('Lỗi mạng', { timeout: 15_000 });
    await shot(page, 'K3e-net');
    await cancel('user:context7');
  });
  test('K3-done the login round ends: dialog closed, toast, row connected', async ({ page }) => {
    const dlg = await loginFrom(page);
    await expect(dlg).toContainText('Đang chờ trình duyệt', { timeout: 15_000 });
    expect((await fetch((await row())!.oauth!.login!.url!)).status).toBe(200);
    await expect(dlg).toBeHidden({ timeout: 15_000 });
    const toast = page.locator('#toasts .toast', { hasText: 'đã đăng nhập' });
    await expect(toast).toBeVisible(); // F-M5 / R-I1: the frame proves the toast
    await expect.poll(async () => (await row())?.status, { timeout: 20_000 }).toBe('connected');
    await expect(rowOf(sheetOf(page), 'vercel')).toContainText('Đã kết nối');
    await expect(toast).toBeVisible();
    // R-I1 not covered by the open sheet: the top element at the toast's centre is the toast (hit-test with its pointer-events on)
    expect(await toast.evaluate((el) => {
      const box = el.getBoundingClientRect(), layer = el.parentElement!, was = layer.style.pointerEvents;
      layer.style.pointerEvents = 'auto'; el.setAttribute('style', 'pointer-events:auto');
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      layer.style.pointerEvents = was; el.removeAttribute('style');
      return !!top && el.contains(top);
    })).toBe(true);
    await shot(page, 'K3-done');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('§14.6 S1–S11 the stream (fake-claude stream steps)', () => {
  // 8 lanes at once: more lane accounts than the default two (each account takes a few lanes)
  const eng = useEngine({ accounts: [ORCH, PM, B2, 'b3@x.test', 'b4@x.test'], scenarios: (e) => ({ [ORCH]: streamOrch(e), ...streamLanes() }) });
  test.describe.configure({ mode: 'serial' });
  let pid = '';
  const lane = async (page: Page, name: string) => {
    await page.goto(eng.url());
    await page.locator(`.react-flow__node[data-id="lane:${name}"] .hit`).click();
    await expect(page.locator('#inspector .crumb')).toContainText(name);
    await page.mouse.move(2, 2); // off the node: no hover card in the frame
  };

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    pid = await eng.addProject('hagenta');
    for (const n of ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9']) await eng.openLane(pid, n, n === 'D5' ? 'idle' : 'running');
  });

  test('S2 a ts code block still open', async ({ page }) => {
    await lane(page, 'D3');
    await expect(page.locator('#inspector .md-copy')).toHaveText('Chép · đang stream');
    await shot(page, 'S2');
  });
  test('S3-a a table still streaming', async ({ page }) => {
    await lane(page, 'D4');
    await expect(page.locator('#inspector table')).toBeVisible();
    await shot(page, 'S3-a');
  });
  test('S3-b the finished table, scrolls sideways', async ({ page }) => {
    await lane(page, 'D5');
    await expect(page.locator('#inspector table')).toBeVisible();
    await shot(page, 'S3-b');
  });
  test('S4 lane D2: text, Đã xem group, Edit, Bash running', async ({ page }) => {
    await lane(page, 'D2');
    await expect(page.locator('#inspector .tr-row', { hasText: 'tail -n 5' })).toBeVisible();
    await shot(page, 'S4');
  });
  test('S5 the failed Bash opened', async ({ page }) => {
    await lane(page, 'D2');
    await page.locator('#inspector .tr-row', { hasText: 'store.test.ts' }).last().click();
    await expect(page.locator('#inspector .tr-box')).toBeVisible();
    // F-M5: the frame shows the footer "Xem hết · 48 dòng · exit 1" (the opened row scrolled into view)
    const foot = page.locator('#inspector .tr-box .tr-foot');
    await foot.scrollIntoViewIfNeeded();
    await expect(foot).toContainText('Xem hết');
    await expect(foot).toContainText('48 dòng · exit 1');
    await expect(foot).toBeInViewport();
    await shot(page, 'S5');
  });
  test('S11 "Ẩn công cụ" on: the failed Bash stays', async ({ page }) => {
    await lane(page, 'D2');
    await page.locator('#inspector .hidetools input').check();
    await shot(page, 'S11');
    await page.locator('#inspector .hidetools input').uncheck();
  });
  test('S4-narrow the 424 px drawer of a 1024 × 640 window', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await lane(page, 'D2');
    await shot(page, 'S4-narrow');
  });
  test('S10 English S4', async ({ page }) => {
    await lang(eng, 'en');
    try {
      await lane(page, 'D2');
      await expect(page.locator('#inspector .hidetools')).toContainText('Hide tools');
      await shot(page, 'S10');
    } finally { await lang(eng, 'vi'); }
  });
  test('S6 scrolled up mid-stream: "↓ mới"', async ({ page }) => {
    await lane(page, 'D6');
    await page.locator('#inspector .hist').hover();
    await page.mouse.wheel(0, -400);
    await expect(page.locator('#inspector .hist-new')).toBeVisible({ timeout: 15_000 });
    await shot(page, 'S6');
  });
  test('S7 "Đang nghĩ…" before the first word', async ({ page }) => {
    await lane(page, 'D7');
    await expect(page.locator('#inspector .m-think')).toBeVisible();
    await expect(page.locator('#inspector .m-think .m-sec')).toHaveText(/\d+ s/, { timeout: 10_000 }); // R-M1 the frame shows the seconds
    await shot(page, 'S7');
  });
  test('S8 the sub streams in its own Đang xem', async ({ page }) => {
    await lane(page, 'D8');
    await page.locator('.react-flow__node[data-id="sub:D8:sa_tests"] .hit').click();
    await expect(page.locator('#inspector')).toContainText('Subagent: đang chạy', { timeout: 15_000 });
    await shot(page, 'S8');
  });
  test('S1 the orchestrator streams markdown; two MCP rows stand alone', async ({ page }) => {
    await page.goto(eng.url());
    await expect(page.locator('#inspector .ohead')).toBeVisible();
    await eng.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: pid }, text: 'S1 báo tiến độ' });
    await expect(page.locator('#inspector [data-vk="msg_s1:0"]')).toBeVisible({ timeout: 15_000 });
    await shot(page, 'S1');
  });
  test('S9 connection lost mid-stream (the engine is killed: last frame of this engine)', async ({ page }) => {
    await lane(page, 'D9');
    await eng.kill();
    await expect(page.locator('#inspector')).toContainText('Mất kết nối', { timeout: 15_000 });
    await shot(page, 'S9');
  });
});
