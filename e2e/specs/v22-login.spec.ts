// v2.2 §5.3 / §6 / §8 E2E MCP login (lane G6b2): K13 card in every tab + the badge only on the tab of the lane missing the
// server (C26), K13-remote without buttons (C24), K3 full round from the card with the fake AS of fake-mcp (T2 = 1 click),
// a dead refresh token → "cần đăng nhập lại" + "Để sau", ⌘K "Đăng nhập MCP…". Real engine; the fake MCP + AS run inside
// the e2e engine (E2E_FAKE_AS, e2e/engine-entry.ts), the Keychain is the file-backed fake `security`, the "browser" is
// this test following the authorize link (the AS 302s straight back to the engine callback).
import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { B2, expect, ORCH, PM, recordBudget, S, settle, test, useEngine } from '../fixtures.ts';
import { shot } from '../shots.ts';

const ID = 'user:vercel';
const LANE = { init: { tools: ['Bash', 'mcp__cc_slaves__ask'], mcp_servers: [{ name: 'cc_slaves', status: 'connected' }] }, steps: S.idle() };

test.describe('§6 K3 / K13 MCP login (real engine + fake AS)', () => {
  const eng = useEngine({
    repos: ['hagenta', 'other'], env: { E2E_FAKE_AS: '1' },
    scenarios: e => ({ [ORCH]: { steps: [...S.startLane(e, 'D2'), ...S.idle()] }, [PM]: LANE, [B2]: LANE }),
  });
  test.use({ viewport: { width: 1280, height: 800 } });
  test.describe.configure({ mode: 'serial' });
  let hagenta = '', other = '';
  const row = async () => (await eng.snapshot()).skillsMcp?.mcp.rows.find(r => r.id === ID);
  const k13 = async () => (await eng.snapshot()).cards.find(c => c.kind === 'mcp_login' && c.status === 'open');
  const card = (page: Page) => page.locator('#inbox .card:not(.done)', { hasText: 'MCP vercel cần đăng nhập' }); // open ones (resolved stay listed)
  const box = (page: Page) => page.locator('#cardbox'); // v2.4 §6.7 the detail box (why line, every button)
  const openBox = async (page: Page) => { await settle(page); await card(page).click(); await expect(box(page)).toBeVisible(); };
  const tab = (page: Page, name: string) => page.locator('#top .tab', { has: page.locator('.pnm', { hasText: new RegExp(`^${name}$`) }) });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await expect.poll(() => eng.read('fake-as.origin'), { timeout: 10_000 }).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    writeFileSync(eng.file('claude.json'), JSON.stringify({ mcpServers: { vercel: { type: 'http', url: `${eng.read('fake-as.origin')}/v3/mcp` } } }));
    hagenta = await eng.addProject('hagenta');
    other = await eng.addProject('other');
    await expect.poll(async () => (await row())?.oauth?.loggedIn, { timeout: 20_000 }).toBe(false);
    await eng.openLane(hagenta, 'D2'); // D2's session carries the vercel proxy entry
    await eng.cmd({ cmd: 'mcp_check', id: ID }); // §5.4b the check meets the 401 → the server needs a login, D2 misses it
    await expect.poll(async () => (await k13())?.title, { timeout: 20_000 }).toBe('MCP vercel cần đăng nhập · D2 đang thiếu công cụ này');
  });

  test('§6 K13 / C26 the card shows in Chờ PO of every tab; the badge counts it only on the tab of D2', async ({ page }) => {
    expect((await k13())!.projectIds).toEqual([hagenta]);
    await page.goto(eng.url());
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('button')).toHaveCount(1); // §6.7 the row: ⇥ Đăng nhập only
    await expect(card(page).getByRole('button', { name: 'Đăng nhập' })).toBeVisible();
    await openBox(page);
    await expect(box(page).locator('.src')).toHaveText('MCP vercel');
    await expect(box(page)).toContainText('chưa đăng nhập · lane báo lỗi cho server này');
    await expect(box(page).locator('.bts').getByRole('button')).toHaveText(['Đăng nhập', 'Để sau']);
    await page.keyboard.press('Escape');
    await expect(tab(page, 'hagenta').locator('.bdg')).toHaveText('1');
    await expect(tab(page, 'other').locator('.bdg')).toHaveCount(0);
    await shot(page, 'v22-K13');
    await tab(page, 'other').click();
    await expect(card(page)).toBeVisible(); // a system card: in Chờ PO of every project tab
    expect(other).not.toBe('');
  });

  test('§6 K13-remote / C24: the phone sees the card with no button at all, only "Đăng nhập trên Mac"', async ({ page }) => {
    await page.routeWebSocket(/\/ws/, ws => {
      const server = ws.connectToServer();
      server.onMessage(m => {
        const msg = JSON.parse(String(m)) as { snapshot?: { channel?: string } };
        if (msg.snapshot) msg.snapshot.channel = 'remote';
        ws.send(JSON.stringify(msg));
      });
    });
    await page.goto(eng.url());
    await expect(card(page)).toBeVisible();
    // §6.7 CP6: the row keeps a 🔒 in place of ⇥; the box hides the Mac-only buttons and says why
    await expect(card(page).getByRole('button', { name: 'Đăng nhập' })).toBeDisabled();
    await expect(card(page).locator('.ia.lock')).toHaveAttribute('data-tip', 'Chỉ làm trên Mac');
    await openBox(page);
    await expect(box(page).locator('.bts')).toHaveCount(0);
    await expect(box(page)).toContainText('Đăng nhập trên Mac — kênh từ xa chỉ xem; cài đặt Skills & MCP làm trong app trên Mac.');
    await shot(page, 'v22-K13-remote');
  });

  test('§6 K3e-denied: the PO declines in the browser → cause + fix, "Thử lại"; K3e-client: no DCR → Client ID → the login goes on', async ({ page }) => {
    writeFileSync(eng.file('fake-as.json'), JSON.stringify({ as: { deny: 'The user said no' } }));
    await page.goto(eng.url());
    await card(page).getByRole('button', { name: 'Đăng nhập' }).click();
    const dlg = page.getByRole('dialog', { name: 'Đăng nhập vercel' });
    await expect(dlg).toContainText('Đang chờ trình duyệt', { timeout: 15_000 });
    expect((await fetch((await row())!.oauth!.login!.url!)).status).toBe(400); // the callback's error page
    await expect(dlg).toContainText('Bạn đã từ chối trên trình duyệt', { timeout: 15_000 });
    await shot(page, 'v22-K3e-denied');
    writeFileSync(eng.file('fake-as.json'), JSON.stringify({ as: { deny: null, noDcr: true } }));
    await dlg.getByRole('button', { name: 'Thử lại' }).click();
    await expect(dlg).toContainText('Máy chủ không cho đăng ký tự động — nhập Client ID', { timeout: 15_000 });
    await expect(dlg.getByRole('button', { name: 'Thử lại' })).toBeDisabled();
    await expect(dlg.locator('input[readonly]')).toHaveValue(/\/oauth\/mcp\/callback$/);
    await shot(page, 'v22-K3e-client');
    await dlg.getByLabel('Client ID').fill('cid-typed-by-po');
    await dlg.getByRole('button', { name: 'Thử lại' }).click();
    await expect(dlg).toContainText('Đang chờ trình duyệt', { timeout: 15_000 });
    expect((await row())!.oauth!.login!.url).toContain('client_id=cid-typed-by-po');
    expect(readFileSync(eng.file('claude.json'), 'utf8')).not.toContain('cid-typed-by-po'); // C18: Keychain only, never the config
    writeFileSync(eng.file('fake-as.json'), JSON.stringify({ as: { noDcr: false } }));
    await dlg.getByRole('button', { name: 'Huỷ' }).click();
    await expect(dlg).toBeHidden();
  });

  test('§6 K3 full round from the K13 card (T2 = 1 click): find → waiting + countdown → browser → closed, toast, card gone, row connected', async ({ page }) => {
    await page.goto(eng.url());
    await card(page).getByRole('button', { name: 'Đăng nhập' }).click(); // the one click of T2 (§4.3)
    recordBudget('T2 K13 → K3', 1, 2);
    const dlg = page.getByRole('dialog', { name: 'Đăng nhập vercel' });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Một lần cho mọi account.');
    await expect(dlg).toContainText('Đang chờ trình duyệt — đã mở trang đăng nhập', { timeout: 15_000 });
    await expect(dlg).toContainText(/còn (10:00|9:\d\d)/);
    await expect(dlg.getByRole('button', { name: 'Sao chép link' })).toBeEnabled();
    await shot(page, 'v22-K3');
    const url = (await row())!.oauth!.login!.url!;
    expect(url).toContain('code_challenge_method=S256');
    expect(eng.read('browser.log')).toContain(new URL(url).origin); // the engine opened the default browser itself
    const back = await fetch(url); // the "browser": the AS approves at once and 302s to the engine callback
    expect(back.status).toBe(200);
    expect(await back.text()).toContain('vercel');
    await expect(dlg).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(/vercel: đã đăng nhập/)).toBeVisible();
    await expect.poll(async () => (await row())?.oauth?.loggedIn, { timeout: 15_000 }).toBe(true);
    await expect(card(page)).toHaveCount(0);
    await expect(tab(page, 'hagenta').locator('.bdg')).toHaveCount(0);
    await expect.poll(async () => (await row())?.status, { timeout: 20_000 }).toBe('connected'); // the automatic check after login
    expect(readFileSync(eng.file('sec/security-items.json'), 'utf8')).toContain('cc-slaves-mcp'); // the fake Keychain, never the real one
  });

  test('§5.3 a dead refresh token (invalid_grant) → "cần đăng nhập lại" card; "Để sau" hides it and its badge', async ({ page }) => {
    writeFileSync(eng.file('fake-as.json'), JSON.stringify({ as: { refreshFail: 'invalid_grant' }, mcp: { requireToken: 'rotated-elsewhere' } }));
    await eng.cmd({ cmd: 'mcp_check', id: ID }); // upstream 401 → refresh → invalid_grant
    await expect.poll(async () => (await k13())?.title, { timeout: 20_000 }).toBe('MCP vercel cần đăng nhập lại · D2 đang thiếu công cụ này');
    await page.goto(eng.url());
    await expect(tab(page, 'hagenta').locator('.bdg')).toHaveText('1');
    await openBox(page);
    await expect(box(page)).toContainText(/làm mới token bị từ chối \(invalid_grant\) lúc \d\d:\d\d/);
    await box(page).getByRole('button', { name: 'Để sau' }).click(); // the box closes first, then the action
    await expect(box(page)).toHaveCount(0);
    await expect(page.locator('#inbox .card:not(.done)', { hasText: 'MCP vercel' })).toHaveCount(0);
    await expect(tab(page, 'hagenta').locator('.bdg')).toHaveCount(0);
    expect(await k13()).toBeUndefined();
  });

  test('§4.3 T2 second path: red number → "Đăng nhập" on the row → K3 (2 clicks)', async ({ page }) => {
    await page.goto(eng.url());
    await page.locator('#top .smk-n.red').click();
    const sheet = page.getByRole('dialog', { name: 'Skills & MCP' });
    await sheet.locator('.smr', { has: page.locator('.nm', { hasText: /^vercel$/ }) }).getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    recordBudget('T2 K0 red → K1 row → K3', 2, 2);
    const dlg = page.getByRole('dialog', { name: 'Đăng nhập vercel' });
    await expect(dlg).toContainText('Đang chờ trình duyệt', { timeout: 15_000 });
    await dlg.getByRole('button', { name: 'Huỷ' }).click();
    await expect(dlg).toBeHidden();
    await expect.poll(async () => (await row())?.oauth?.login ?? null).toBeNull();
  });

  test('§6 ⌘K "Đăng nhập MCP…" opens K3 for the server that needs it; Huỷ stops the wait', async ({ page }) => {
    await page.goto(eng.url());
    await expect(page.locator('#inspector')).toBeVisible();
    await page.keyboard.press('Meta+k');
    const pal = page.getByRole('dialog', { name: 'Bảng lệnh' });
    await pal.getByLabel('Tìm hành động, lane, project').fill('đăng nhập mcp');
    await expect(pal).toContainText('Đăng nhập MCP…');
    await page.keyboard.press('Enter');
    const dlg = page.getByRole('dialog', { name: 'Đăng nhập vercel' });
    await expect(dlg).toContainText('Đang chờ trình duyệt', { timeout: 15_000 });
    await dlg.getByRole('button', { name: 'Huỷ' }).click();
    await expect(dlg).toBeHidden();
    await expect.poll(async () => (await row())?.oauth?.login ?? null).toBeNull();
  });
});
