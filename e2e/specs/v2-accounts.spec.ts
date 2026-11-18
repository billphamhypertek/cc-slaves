// v2 §6 A1–A9 + F16 (spec v2 §4.3 step budgets): Settings › Account against a real engine and fake-claude `auth …`
// (e2e/engine-entry.ts: fake `claude`, fake default browser, fake `security`). The browser step of a login is the
// fake's `.fake-auth-go` file in the login's account dir. Screenshots of every frame behind E2E_SHOTS=1.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { Clicks, expect, ORCH, PM, recordBudget, settle, test, useEngine } from '../fixtures.ts';
import { shot as shotAs } from '../shots.ts';

const eng = useEngine();
test.use({ viewport: { width: 1280, height: 800 } });

/** E2E_SHOTS=1: the frame at 1280×800 and 1024×640; no dialog / cell / button may overflow sideways (e2e/shots.ts). */
const shot = (page: Page, name: string) => shotAs(page, `v2-${name}`);

const authEnv = (vars: Record<string, string>) => writeFileSync(eng.file('auth.env'), Object.entries(vars).map(([k, v]) => `export ${k}=${v}\n`).join(''));
const dirOf = async (email: string) => join(eng.dir, 'accts', (await eng.snapshot()).accounts.find(a => a.email === email)!.id!);
/** "The browser finished": fake-claude writes the login once this file exists in the login's account dir. */
async function browserDone(dir?: string): Promise<void> {
  let d = dir;
  if (!d) {
    await expect.poll(async () => JSON.stringify((await eng.snapshot()).login)).toContain('"state":"waiting_browser"');
    d = join(eng.dir, 'accts', (await eng.snapshot()).login!.id);
  }
  writeFileSync(join(d, '.fake-auth-go'), '');
}
const clearGo = (d: string) => rmSync(join(d, '.fake-auth-go'), { force: true });

async function accountTab(page: Page) {
  await page.goto(eng.url());
  await expect(page.locator('#inspector, .deck, #top').first()).toBeVisible();
  await page.keyboard.press('Meta+Comma');
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  await dlg.getByRole('tab', { name: /Account/ }).click();
  await expect(dlg.locator('table.acc-t')).toBeVisible();
  // G4 UX 5(a): remote access is off (v3) → no tab, no 🌐 in the top bar
  await expect(dlg.getByRole('tab', { name: 'Truy cập từ xa' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Truy cập từ xa' })).toHaveCount(0);
  return dlg;
}
const row = (page: Page, email: string) => page.locator(`tr[data-email="${email}"]`);

test.beforeEach(() => { rmSync(eng.file('auth.env'), { force: true }); });

test('§6 A1 empty state (no account)', async ({ page }) => {
  // A1 needs zero accounts, which the F1 wizard owns at boot (T8): the WS snapshot is rewritten in the page instead.
  await page.routeWebSocket(/\/ws/, ws => {
    const server = ws.connectToServer();
    server.onMessage(m => {
      const msg = JSON.parse(String(m)) as { type: string; snapshot?: { accounts: unknown[] }; event?: { type: string } };
      if (msg.type === 'snapshot') msg.snapshot!.accounts = [];
      if (msg.type === 'event' && msg.event?.type === 'account') return; // A1 = zero accounts for the whole test (boot events too)
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto(eng.url());
  await expect(page.locator('#top')).toBeVisible();
  await page.keyboard.press('Meta+Comma');
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  await dlg.getByRole('tab', { name: /Account/ }).click();
  await expect(dlg).toContainText('Chưa có account');
  await expect(dlg.getByRole('button', { name: 'Thêm account' })).toBeVisible();
  await shot(page, 'A1');
});

test('§4.3 T3 add account ≤ 4 clicks (A3 → A4 → A5 Lưu)', async ({ page }) => {
  writeFileSync(eng.file('browser-private'), '1');
  authEnv({ FAKE_CLAUDE_AUTH_EMAIL: 'new@x.test' });
  const dlg = await accountTab(page);
  await expect(row(page, ORCH)).toContainText('Điều phối');
  await shot(page, 'A2');
  const c = new Clicks(page);
  await c.on(dlg.getByRole('button', { name: 'Thêm account' }));
  const a3 = page.getByRole('dialog', { name: 'Thêm account' });
  await expect(a3).toContainText('Dùng cửa sổ riêng tư');
  await shot(page, 'A3');
  await c.on(a3.getByRole('button', { name: 'Đăng nhập' }));
  const a4 = page.getByRole('dialog', { name: 'Đang chờ đăng nhập' });
  await expect(a4.locator('code.url')).toContainText('https://claude.ai/oauth/authorize');
  await expect(a4.getByRole('button', { name: 'Mở cửa sổ riêng tư' })).toHaveClass(/pri/);
  await expect(a4.getByRole('button', { name: 'Mở cửa sổ riêng tư' })).toBeFocused(); // M6: Enter opens, never cancels
  await expect(a4.getByRole('button', { name: 'Sao chép link' })).toBeVisible();
  await expect(a4).toContainText(/(10:00|09:5\d)/);
  await shot(page, 'A4');
  await c.on(a4.getByRole('button', { name: 'Mở cửa sổ riêng tư' }));
  await expect.poll(() => eng.read('browser.log')).toContain('"Google Chrome","--args","--incognito"');
  await a4.getByRole('button', { name: 'Dán mã' }).click(); // the paste field (not part of the T3 path)
  await expect(a4.getByLabel('Mã trên trang đăng nhập')).toBeVisible();
  await shot(page, 'A4P');
  await browserDone();
  const a5 = page.getByRole('dialog', { name: 'Đã đăng nhập' });
  await expect(a5).toContainText('new@x.test');
  await expect(a5.getByRole('radio', { name: 'Chính' })).toHaveAttribute('aria-checked', 'true');
  await expect(a5.getByLabel('Ngưỡng tuần')).toHaveValue('99');
  await expect(a5).not.toContainText('thiết lập cũ');
  await shot(page, 'A5');
  await c.on(a5.getByRole('button', { name: 'Lưu' }));
  await expect(a5).toBeHidden();
  await expect(row(page, 'new@x.test')).toContainText('Chính');
  expect(c.n).toBeLessThanOrEqual(4);
  recordBudget('v2 T3 thêm account', c.n, 4);
  const a = (await eng.snapshot()).accounts.find(x => x.email === 'new@x.test')!;
  expect([a.role, a.week, a.hard]).toEqual(['primary', 99, false]);
  rmSync(eng.file('browser-private'));
});

test('smoke 2026-11-15: a page reload during a login → "Thêm account" shows the running login (A4 + Huỷ), not a dead A3', async ({ page }) => {
  let dlg = await accountTab(page);
  await dlg.getByRole('button', { name: 'Thêm account' }).click();
  await page.getByRole('dialog', { name: 'Thêm account' }).getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('dialog', { name: 'Đang chờ đăng nhập' }).locator('code.url')).toContainText('oauth');
  const id = (await eng.snapshot()).login!.id;
  dlg = await accountTab(page); // page.goto again = reload; the engine login keeps running
  await dlg.getByRole('button', { name: 'Thêm account' }).click();
  const a4 = page.getByRole('dialog', { name: 'Đang chờ đăng nhập' });
  await expect(a4.locator('code.url').first()).toContainText('oauth');
  await expect(a4).toContainText('không cần mã'); // localhost link: any profile on this Mac finishes by itself
  await a4.getByRole('button', { name: 'Dán mã' }).click();
  await expect(a4).toContainText('dán mã hiện ra');
  await expect(a4.getByRole('button', { name: 'Sao chép link lấy mã' })).toBeVisible();
  await a4.getByRole('button', { name: 'Huỷ' }).click();
  await expect.poll(async () => (await eng.snapshot()).login?.state).toBe('cancelled');
  await expect.poll(() => existsSync(join(eng.dir, 'accts', id))).toBe(false);
});

test('§6 A3 cancel leaves nothing; A7c auth error; A7e duplicate', async ({ page }) => {
  const dlg = await accountTab(page);
  await dlg.getByRole('button', { name: 'Thêm account' }).click();
  await page.getByRole('dialog', { name: 'Thêm account' }).getByRole('button', { name: 'Đăng nhập' }).click();
  const a4 = page.getByRole('dialog', { name: 'Đang chờ đăng nhập' });
  await expect(a4.getByRole('button', { name: 'Sao chép link' })).toHaveClass(/pri/); // no private window here
  await expect(a4.getByRole('button', { name: 'Mở cửa sổ riêng tư' })).toHaveCount(0);
  const id = (await eng.snapshot()).login!.id;
  await a4.getByRole('button', { name: 'Huỷ' }).click();
  await expect(a4).toBeHidden();
  await expect.poll(async () => (await eng.snapshot()).login?.state).toBe('cancelled');
  await expect.poll(() => existsSync(join(eng.dir, 'accts', id))).toBe(false);

  authEnv({ FAKE_CLAUDE_AUTH: 'fail' });
  await dlg.getByRole('button', { name: 'Thêm account' }).click();
  await page.getByRole('dialog', { name: 'Thêm account' }).getByRole('button', { name: 'Đăng nhập' }).click();
  const a7c = page.getByRole('dialog', { name: 'Đăng nhập lỗi' });
  await expect(a7c).toContainText('Kiểm tra mạng / proxy.');
  await expect(a7c.getByRole('button', { name: 'Thử lại' })).toBeVisible();
  await shot(page, 'A7c');
  await a7c.getByRole('button', { name: 'Đóng', exact: true }).last().click();

  authEnv({ FAKE_CLAUDE_AUTH_EMAIL: PM });
  await dlg.getByRole('button', { name: 'Thêm account' }).click();
  await page.getByRole('dialog', { name: 'Thêm account' }).getByRole('button', { name: 'Đăng nhập' }).click();
  await browserDone();
  const a7e = page.getByRole('dialog', { name: 'Account đã có' });
  await expect(a7e).toContainText('pm@ đã có.');
  await expect(a7e.getByRole('button', { name: 'Đăng nhập lại pm@' })).toBeVisible();
  await shot(page, 'A7e');
  await a7e.getByRole('button', { name: 'Đóng', exact: true }).last().click();
});

test('§6 A7f typed email ≠ real → "Huỷ đăng nhập real@" drops it', async ({ page }) => {
  authEnv({ FAKE_CLAUDE_AUTH_EMAIL: 'real@x.test' });
  const dlg = await accountTab(page);
  await dlg.getByRole('button', { name: 'Thêm account' }).click();
  const a3 = page.getByRole('dialog', { name: 'Thêm account' });
  await a3.getByLabel('Email (tuỳ chọn)').fill('typed@x.test');
  await a3.getByRole('button', { name: 'Đăng nhập' }).click();
  await browserDone();
  const a7f = page.getByRole('dialog', { name: 'Khác email đã nhập' });
  await expect(a7f).toContainText('Đã đăng nhập real@, không phải typed@.');
  await expect(a7f.getByRole('button', { name: 'Giữ real@' })).toHaveClass(/pri/);
  await shot(page, 'A7f');
  await a7f.getByRole('button', { name: 'Huỷ đăng nhập real@' }).click();
  await expect(a7f).toBeHidden();
  await expect.poll(async () => (await eng.snapshot()).accounts.some(a => a.email === 'real@x.test')).toBe(false);
});

test('§4.3 logout ≤ 3, then T2 relogin from the ✗ chip ≤ 2', async ({ page }) => {
  const dlg = await accountTab(page);
  const c = new Clicks(page);
  await c.on(row(page, PM).getByRole('button', { name: `Thao tác cho ${PM}` }));
  await shot(page, 'A2-menu');
  await c.on(page.getByRole('menu').getByRole('menuitem', { name: 'Đăng xuất…' }));
  const a8l = page.getByRole('dialog', { name: `Đăng xuất ${PM}?` });
  await expect(a8l).toContainText('Không thu hồi token trên claude.ai.');
  await expect(a8l).toContainText('Không có lane nào phải chuyển.');
  await shot(page, 'A8L');
  await c.on(a8l.getByRole('button', { name: 'Đăng xuất' }));
  await expect(a8l).toBeHidden();
  await expect(row(page, PM)).toContainText('✗ đăng xuất');
  recordBudget('v2 đăng xuất', c.n, 3);
  expect(c.n).toBeLessThanOrEqual(3);
  // a logged-out row has no "Đăng xuất" item
  await row(page, PM).getByRole('button', { name: `Thao tác cho ${PM}` }).click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Đăng xuất…' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const dir = await dirOf(PM);
  clearGo(dir);
  const t2 = new Clicks(page);
  await t2.on(row(page, PM).getByRole('button', { name: /✗ đăng xuất/ }));
  const a6 = page.getByRole('dialog', { name: `Đăng nhập lại ${PM}` });
  await expect(a6).toContainText(`Đăng nhập đúng ${PM}.`);
  await t2.on(a6.getByRole('button', { name: 'Sao chép link' }));
  await browserDone(dir);
  await expect(a6).toBeHidden();
  await expect(row(page, PM)).toContainText('✓');
  recordBudget('v2 T2 đăng nhập lại từ màn Account', t2.n, 2);
  expect(t2.n).toBeLessThanOrEqual(2);
  clearGo(dir);
  void dlg;
});

test('§4.3 T2 relogin from the F16 card ≤ 2 (card → A6 → nút mở)', async ({ page }) => {
  // F16: signing out the account a live orchestrator runs on raises the logged_out card (v1 §7.5 handover)
  await eng.addProject('shop');
  await eng.cmd({ cmd: 'account_logout', email: ORCH });
  await page.goto(eng.url());
  const card = page.locator('article.card', { hasText: 'orch@ đã đăng xuất' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await shot(page, 'F16');
  await settle(page);
  const dir = await dirOf(ORCH);
  clearGo(dir);
  const c = new Clicks(page);
  await c.on(card.getByRole('button', { name: 'Đăng nhập lại' }));
  const a6 = page.getByRole('dialog', { name: `Đăng nhập lại ${ORCH}` });
  await expect(a6.getByRole('button', { name: 'Sao chép link' })).toBeEnabled();
  await shot(page, 'A6');
  await c.on(a6.getByRole('button', { name: 'Sao chép link' }));
  await browserDone(dir);
  await expect(a6).toBeHidden();
  await expect.poll(async () => (await eng.snapshot()).accounts.find(a => a.email === ORCH)?.login).toBe('ok');
  await expect(page.locator('article.card:not(.done)', { hasText: 'orch@ đã đăng xuất' })).toHaveCount(0);
  recordBudget('v2 T2 đăng nhập lại từ thẻ F16', c.n, 2);
  expect(c.n).toBeLessThanOrEqual(2);
  clearGo(dir);
});

test('§6 F16 after a cancelled relogin of the same account: the card adopts the new login; Huỷ cancels it (G4 IMPORTANT-1)', async ({ page }) => {
  if (!(await eng.snapshot()).projects.length) await eng.addProject('shop');
  await eng.cmd({ cmd: 'account_logout', email: ORCH });
  // a relogin of ORCH tried and given up: snap.login keeps that view, with the row id the next relogin reuses
  await eng.cmd({ cmd: 'account_login', email: ORCH });
  await expect.poll(async () => (await eng.snapshot()).login?.state).toBe('waiting_browser');
  await eng.cmd({ cmd: 'account_login_cancel' });
  await expect.poll(async () => (await eng.snapshot()).login?.state).toBe('cancelled');
  await page.goto(eng.url());
  const card = page.locator('article.card:not(.done)', { hasText: 'orch@ đã đăng xuất' }); // the earlier F16 card is done
  await expect(card).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await card.getByRole('button', { name: 'Đăng nhập lại' }).click();
  const a6 = page.getByRole('dialog', { name: `Đăng nhập lại ${ORCH}` });
  await expect(a6.getByRole('button', { name: 'Sao chép link' })).toBeEnabled();
  await a6.getByRole('button', { name: 'Huỷ' }).click();
  await expect(a6).toBeHidden();
  await expect.poll(async () => (await eng.snapshot()).login?.state).toBe('cancelled'); // the slot is free again
  const dir = await dirOf(ORCH); // the slot is usable: a new relogin starts and finishes (ORCH back to ✓ for the next tests)
  clearGo(dir);
  await eng.cmd({ cmd: 'account_login', email: ORCH });
  await browserDone(dir);
  await expect.poll(async () => (await eng.snapshot()).accounts.find(a => a.email === ORCH)?.login).toBe('ok');
  clearGo(dir);
});

test('§4.3 T6 delete ≤ 3; orchestrator row: Xoá locked "Đang là Điều phối"', async ({ page }) => {
  await accountTab(page);
  await row(page, ORCH).getByRole('button', { name: `Thao tác cho ${ORCH}` }).click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: /Xoá account…/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('menu')).toContainText('Đang là Điều phối');
  await shot(page, 'A8B');
  await page.keyboard.press('Escape');
  const c = new Clicks(page);
  await c.on(row(page, 'new@x.test').getByRole('button', { name: 'Thao tác cho new@x.test' }));
  await c.on(page.getByRole('menu').getByRole('menuitem', { name: 'Xoá account…' }));
  const a8 = page.getByRole('dialog', { name: 'Xoá new@x.test?' });
  await expect(a8).toContainText('Mục keychain');
  await expect(a8).toContainText('Lịch sử, memory');
  await shot(page, 'A8');
  await c.on(a8.getByRole('button', { name: 'Xoá' }));
  await expect(a8).toBeHidden();
  await expect(row(page, 'new@x.test')).toHaveCount(0);
  recordBudget('v2 T6 xoá account', c.n, 3);
  expect(c.n).toBeLessThanOrEqual(3);
  expect(eng.read('security.log')).toContain('delete-generic-password'); // the fake, never /usr/bin/security
});

test('§6 A9 merge (v2.2 K12): ⚠ chip → Thư mục chung; clash → list, nothing changed; then Gộp moves the files; §5.2 new entry → Dùng chung', async ({ page }) => {
  const dir = await dirOf(PM);
  const home = join(eng.dir, 'claude');
  rmSync(join(dir, 'plans'), { recursive: true, force: true });
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(join(dir, 'plans', 'a.md'), 'mine');
  mkdirSync(join(home, 'plans'), { recursive: true });
  writeFileSync(join(home, 'plans', 'a.md'), 'theirs'); // clash
  mkdirSync(join(home, 'hooks'), { recursive: true }); // §5.2 new unknown entry → root watch → re-check
  const dlg = await accountTab(page);
  // v2.2 §7: the old toolbar button ("Cấu hình chung ✓" / "⚠ n") is gone, the list lives in K12. Not /Cấu hình chung/: the
  // row's "Cấu hình chung lỗi: …" chip below may already be up (the engine sees plans/ at once) — that raced 3/16.
  await expect(dlg.getByRole('button', { name: /^Cấu hình chung (✓|⚠)/ })).toHaveCount(0);
  await expect(page.locator('#inbox article.card', { hasText: 'hooks' })).toHaveCount(0); // 5(b): not a Chờ PO item
  const chip = row(page, PM).getByRole('button', { name: /Cấu hình chung lỗi/ });
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await chip.click(); // v2.2 §6 "Bảng Account": the chip opens K12
  const k12 = page.getByRole('dialog', { name: 'Skills & MCP' });
  await expect(k12.getByRole('tab', { name: /Thư mục chung/ })).toHaveAttribute('aria-selected', 'true');
  const a9 = k12.locator(`tr[data-email="${PM}"]`);
  await expect(a9).toContainText('plans: thư mục thật ở chỗ phải là link', { timeout: 15_000 });
  await shot(page, 'A9');
  await a9.getByRole('button', { name: 'Gộp vào ~/.claude' }).click();
  const clash = page.getByRole('dialog', { name: 'Trùng tên file' });
  await expect(clash).toContainText('a.md');
  await expect(clash).toContainText(/pm@ \d\d\/\d\d \d\d:\d\d · chung \d\d\/\d\d \d\d:\d\d/); // I2: owner + mtime of both copies
  await expect(clash).toContainText('chung: ');
  await shot(page, 'A9C');
  await clash.getByRole('button', { name: 'Mở Finder' }).click(); // I2: open -R on the account copy (engine path)
  await expect.poll(() => eng.read('exec.log')).toContain(JSON.stringify(['open', '-R', join(dir, 'plans', 'a.md')]));
  // I3: after the dry run the A9 card (Chờ PO) says what can be done
  await expect.poll(async () => (await eng.snapshot()).cards.find(c => c.kind === 'shared_cfg' && c.status === 'open')?.actions?.find(a => a.id === 'shared_cfg_merge')?.label).toBe('Xem trùng tên');
  expect(readdirSync(join(dir, 'plans'))).toEqual(['a.md']); // nothing moved
  rmSync(join(home, 'plans', 'a.md'));
  await clash.getByRole('button', { name: 'Thử lại' }).click();
  const merge = page.getByRole('dialog', { name: /Gộp plans của pm@/ });
  await expect(merge).toContainText('a.md');
  await shot(page, 'A9-merge');
  await merge.getByRole('button', { name: 'Gộp' }).click();
  await expect(merge).toBeHidden();
  await expect.poll(() => existsSync(join(home, 'plans', 'a.md'))).toBe(true);
  await expect.poll(async () => (await eng.snapshot()).accounts.find(a => a.email === PM)?.sharedCfg.ok, { timeout: 15_000 }).toBe(true);
  await expect(a9).toContainText('11 / 11 link', { timeout: 15_000 });
  await expect(a9.getByRole('button', { name: 'Gộp vào ~/.claude' })).toHaveCount(0);

  const fresh = k12.locator('.band', { hasText: 'hooks' }); // §5.2 the new-entry question (G4 UX 5(b)), now in K12
  await expect(fresh).toBeVisible();
  await expect(k12.locator('.shc', { hasText: 'Lạ' })).toContainText('hooks');
  await shot(page, 'CFG');
  await fresh.getByRole('button', { name: 'Dùng chung' }).click();
  await expect(k12.getByRole('switch', { name: 'Dùng chung hooks' })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await eng.snapshot()).config.sharedExtra).toEqual(['hooks']);
});

test('§6A Settings › Engine › Ngôn ngữ: English applies at once; A2 renders English', async ({ page }) => {
  const dlg = await accountTab(page);
  await dlg.getByRole('tab', { name: 'Engine' }).click();
  await dlg.getByRole('combobox', { name: 'Ngôn ngữ' }).selectOption('en');
  const en = page.getByRole('dialog', { name: 'Settings' });
  await en.getByRole('tab', { name: 'Account & caps' }).click();
  await expect(en.locator('table.acc-t th').first()).toHaveText('Account');
  await expect(en.getByRole('button', { name: 'Add account' })).toBeVisible();
  await expect(row(page, ORCH)).toContainText('Orchestrator');
  await shot(page, 'A2-en');
  await en.getByRole('button', { name: 'Edit roles & caps' }).click();
  await expect(en.locator('table.t:not(.acc-t) th').nth(2)).toHaveText('Weekly cap');
  await shot(page, 'A5-roles-en');
  // F24 account (Đang xem › Account) in English (from the account panel row, v2.1 §4.7; the deck needs a project)
  if (!(await eng.snapshot()).projects.length) await eng.addProject('shop');
  await page.keyboard.press('Escape');
  await expect(en).toBeHidden();
  await page.keyboard.press('a');
  await page.locator('.accp.open .gmore').click(); // §4.7 the idle "Ready" group starts folded; PM sits in it
  await page.locator(`.accp.open .acrow[data-email="${PM}"] .hit`).click();
  const panel = page.locator('#inspector.k-account');
  await expect(panel.locator('.crumb')).toContainText('Account');
  await expect(panel).toContainText(PM);
  await expect(panel).toContainText('Running on this account');
  await expect(panel.getByRole('button', { name: 'Edit caps' })).toBeVisible();
  await shot(page, 'F24-en');
  await eng.cmd({ cmd: 'config_update', patch: { ui: { lang: 'vi' } } });
  await expect(panel).toContainText('Đang chạy trên account này');
});
