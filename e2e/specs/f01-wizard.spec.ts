// v2 §6 F1 (spec v2 §4.3 "Cài đặt lần đầu với 1 account" ≤ 7 clicks; v2.5 §6 + T2 adds step 3 "Bộ công cụ" = 1 click → ≤ 8):
// first run with no account → the wizard opens on step 1 (✓ Claude Code), step 2 is the Settings › Account list (A1 → A3 →
// A4; the login returns to the list, no A5), step 3 Bộ công cụ ("Để sau"), step 4 sets roles (first account = Điều phối),
// step 5 "Để sau". Real engine, fake-claude `auth login`
// (e2e/engine-entry.ts); the browser step is the fake's `.fake-auth-go` file. Screenshots behind E2E_SHOTS=1.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { Clicks, expect, recordBudget, test, useEngine } from '../fixtures.ts';
import { shot as shotAs } from '../shots.ts';

const NEW = 'po@x.test';
const eng = useEngine({ accounts: [], poEmail: false });
test.use({ viewport: { width: 1280, height: 800 } });

const shot = (page: Page, name: string) => shotAs(page, `v2-wizard-${name}`);

test('§6A F1 step 1 switches to English (top-right), applied at once and persisted; the next step renders English', async ({ page }) => {
  await page.goto(eng.url());
  const vi = page.getByRole('dialog', { name: 'Cài đặt lần đầu' });
  await vi.getByRole('combobox', { name: 'Ngôn ngữ' }).selectOption('en');
  const wiz = page.getByRole('dialog', { name: 'First-run setup' });
  await expect(wiz.locator('.stepper')).toHaveText(/1\. Tools.*2\. Account.*3\. Toolkit.*4\. Roles & caps.*5\. Done/);
  await expect(wiz).toContainText('Claude Code 2.1.330 installed');
  await expect.poll(async () => JSON.stringify((await eng.snapshot()).config.ui)).toBe('{"lang":"en"}'); // config.json ui.lang
  await shot(page, 'en-1');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await expect(wiz).toContainText('No accounts yet');
  await expect(wiz).toContainText('Add at least 1 account.');
  await expect(wiz.getByRole('button', { name: 'Add account' })).toBeVisible();
  await shot(page, 'en-2');
  // back to Vietnamese for the next test (one engine per file)
  await wiz.getByRole('button', { name: 'Back' }).click();
  await wiz.getByRole('combobox', { name: 'Language' }).selectOption('vi');
  await expect(vi).toBeVisible();
  await expect(vi.getByRole('combobox', { name: 'Ngôn ngữ' })).toHaveValue('vi');
});

test('v2.5 §6 F1 5 steps with 1 account ≤ 8 clicks (§4.3 + T2); no CC Switch anywhere', async ({ page }) => {
  writeFileSync(eng.file('browser-private'), '1');
  writeFileSync(eng.file('auth.env'), `export FAKE_CLAUDE_AUTH_EMAIL=${NEW}\n`);
  await page.goto(eng.url());
  const wiz = page.getByRole('dialog', { name: 'Cài đặt lần đầu' });
  const c = new Clicks(page);

  // step 1: Claude Code
  await expect(wiz.locator('.stepper')).toHaveText(/1\. Công cụ.*2\. Account.*3\. Bộ công cụ.*4\. Vai trò & ngưỡng.*5\. Xong/);
  await expect(wiz).toContainText('Claude Code 2.1.330 đã cài');
  await expect(wiz).not.toContainText('CC Switch');
  // hf1116 (b) the optional Git block (real git, temp HOME = no identity, no gh in e2e); it never gates "Tiếp"
  const gitBlock = wiz.getByRole('region', { name: 'Git (tuỳ chọn)' });
  await expect(gitBlock).toContainText('Danh tính commit');
  await expect(gitBlock).toContainText('Chưa có gh');
  await expect(wiz.getByRole('button', { name: 'Tiếp' })).toBeEnabled();
  await shot(page, '1');
  await c.on(wiz.getByRole('button', { name: 'Tiếp' }));

  // step 2: the Account list (A1 empty) → A3 → A4 → back to the list, no A5
  await expect(wiz).toContainText('Chưa có account');
  await expect(wiz).toContainText('Cần ít nhất 1 account.');
  await expect(wiz.getByRole('button', { name: 'Tiếp' })).toBeDisabled();
  await shot(page, '2');
  await c.on(wiz.getByRole('button', { name: 'Thêm account' }));
  const a3 = page.getByRole('dialog', { name: 'Thêm account' });
  await c.on(a3.getByRole('button', { name: 'Đăng nhập' }));
  const a4 = page.getByRole('dialog', { name: 'Đang chờ đăng nhập' });
  await expect(a4.locator('code.url')).toContainText('https://claude.ai/oauth/authorize');
  await shot(page, '2-login');
  await c.on(a4.getByRole('button', { name: 'Mở cửa sổ riêng tư' }));
  await expect.poll(async () => JSON.stringify((await eng.snapshot()).login)).toContain('"state":"waiting_browser"');
  writeFileSync(join(eng.dir, 'accts', (await eng.snapshot()).login!.id, '.fake-auth-go'), ''); // the browser finished
  await expect(a4).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Đã đăng nhập' })).toHaveCount(0); // A5 skipped in F1
  await expect(wiz.locator(`tr[data-email="${NEW}"]`)).toContainText('✓');
  await shot(page, '2-list');
  await expect(wiz.locator('table.acc-t th', { hasText: 'Vai trò' })).toHaveCount(0); // M1: roles come at step 4
  await c.on(wiz.getByRole('button', { name: 'Tiếp' }));

  // step 3: Bộ công cụ (v2.5 §6, never gates) → "Để sau"
  await expect(wiz.locator('.stepper .now')).toHaveText('3. Bộ công cụ');
  await c.on(wiz.getByRole('button', { name: 'Để sau' }));

  // step 4: roles — the first account is Điều phối; defaults kept
  await expect(wiz).toContainText('Chọn một account Điều phối.');
  // G4 UX I1: the only account orchestrates and runs lanes — its lane cap is real and editable
  await expect(wiz).toContainText('Account duy nhất: vừa điều phối vừa chạy lane.');
  await expect(wiz.getByLabel(`Tối đa lane ${NEW}`)).toBeEnabled();
  await expect(wiz.getByLabel(`Tối đa lane ${NEW}`)).toHaveValue('3');
  await expect(wiz.getByRole('radio', { name: 'Điều phối' })).toHaveAttribute('aria-checked', 'true'); // A5 controls (M2)
  await expect(wiz).not.toContainText('Email của PO');
  await shot(page, '3');
  await c.on(wiz.getByRole('button', { name: 'Tiếp' }));

  // step 5: done
  await expect(wiz.getByRole('button', { name: 'Thêm project đầu tiên' })).toBeVisible();
  await expect(wiz).toContainText('1 account');
  await expect(wiz).toContainText('Điều phối + lane: po@');
  await expect(wiz).not.toContainText('Cấu hình chung ✓'); // M11: one ✓ (the icon)
  await shot(page, '4');
  await c.on(wiz.getByRole('button', { name: 'Để sau' }));
  await expect(wiz).toBeHidden();

  expect(c.n).toBeLessThanOrEqual(8);
  recordBudget('F1 first run with 1 account', c.n, 8);
  const snap = await eng.snapshot();
  expect(snap.accounts.map(a => [a.email, a.role])).toEqual([[NEW, 'orchestrator']]);
  expect((snap.config.laneCaps as Record<string, number> | undefined)?.[NEW] ?? 3).toBe(3); // not 0 (I1)
  expect(snap.setup?.done).toBe(true);
  expect(JSON.stringify(snap.setup)).not.toMatch(/ccSwitch|inCcSwitch/);
});

test('§6A F1 step 4 in English (RolesTable): headers, caps controls and the one-account note', async ({ page }) => {
  await eng.cmd({ cmd: 'config_update', patch: { ui: { lang: 'en' } } });
  await page.goto(eng.url());
  await expect(page.locator('#screen .boot')).toHaveCount(0); // ⌘, needs the app: on the starting screen the key is lost
  await page.keyboard.press('Meta+Comma');
  const set = page.getByRole('dialog', { name: 'Settings' });
  await set.getByRole('tab', { name: 'Project' }).click();
  await set.getByRole('button', { name: 'Check setup' }).click();
  const wiz = page.getByRole('dialog', { name: 'First-run setup' });
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Later' }).click(); // v2.5 step 3 Toolkit
  await expect(wiz.locator('table.t th')).toHaveText(['Account', 'Role', 'Weekly cap', '5h', 'Max lanes']);
  await expect(wiz).toContainText('Only account: orchestrates and runs lanes.');
  await expect(wiz.getByRole('radio', { name: 'Orchestrator' })).toHaveAttribute('aria-checked', 'true');
  await expect(wiz.getByLabel(`Max lanes ${NEW}`)).toHaveValue('3');
  await shot(page, 'en-3');
  await eng.cmd({ cmd: 'config_update', patch: { ui: { lang: 'vi' } } });
  await expect(page.getByRole('dialog', { name: 'Cài đặt lần đầu' })).toBeVisible();
});
