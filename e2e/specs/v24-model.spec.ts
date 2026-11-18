// v2.4 §13 E2E "đổi model → chip + dòng hội thoại": the orchestrator's chip and picker on the real engine with fake-claude
// (control requests answered by fake-claude/src/control.ts). Idle change → applied at once + the §4.3 engine line; a change
// while a turn runs waits for the turn (§5.3, chip "→ … · chờ hết lượt"), can be cancelled; `model_not_found` → the red
// line in the open picker (MD6), or a toast once the picker is closed. Each test adds its own project (fresh orchestrator).
import type { Page } from '@playwright/test';
import { expect, ORCH, S, test, useEngine, type Scenario } from '../fixtures.ts';

/** Every spawn starts on Opus 5.5 · high; the settings file names `opus` (the "Theo mặc định" row). */
const CONTROL = { startModel: 'claude-opus-5-5', startEffort: 'high', sources: [{ source: 'userSettings', settings: { model: 'opus' } }] };
const eng = useEngine({ scenarios: { [ORCH]: { control: CONTROL, steps: S.idle() } } });

const chip = (page: Page) => page.locator('#inspector .mchip');
const menu = (page: Page) => page.locator('.mdmenu');
const row = (page: Page, label: string) => menu(page).locator('.mrow', { has: page.locator('b', { hasText: new RegExp(`^${label}$`) }) });
const level = (page: Page, l: string) => menu(page).locator('.lv', { hasText: new RegExp(`^${l}$`) });
const engineLines = (page: Page) => page.locator('#inspector .m-evt');

/** A project whose orchestrator plays `steps` (after the boot turn) with CONTROL + `control`; the page opens on it. */
async function open(page: Page, name: string, steps: Scenario['steps'], control: Record<string, unknown> = {}): Promise<void> {
  eng.scenario(ORCH, { control: { ...CONTROL, ...control }, steps: [...S.turn('Sẵn sàng'), ...steps] });
  await eng.addProject(name);
  await page.goto(eng.url());
  await page.locator('#top .tab', { hasText: name }).click();
  await expect(chip(page)).toHaveText('Opus 5.5 · high▾');
}
/** A turn that keeps running for `ms` after the PO message (the orchestrator is "running" meanwhile). */
const longTurn = (ms: number): Scenario['steps'] => [S.wait, S.partial('Đang xem lot-2'), S.sleep(ms), S.assistant('Xong lot-2'), S.result(), ...S.idle()];
async function startTurn(page: Page): Promise<void> {
  const input = page.getByLabel('Ô lệnh');
  await input.fill('review lot-2');
  await input.press('Enter');
  await expect(page.locator('#inspector')).toContainText('Đang xem lot-2');
}

test('§4.2 idle: a model click applies at once → chip shows the new model; effort within 2 s → one merged §4.3 line', async ({ page }) => {
  await open(page, 'm-idle', S.idle());
  await chip(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(row(page, 'Theo mặc định')).toHaveClass(/\bpick\b/); // ✓ = no pick yet
  await expect(level(page, 'high')).toHaveClass(/\blit\b/); // the running level is lit
  await row(page, 'Sonnet 5.5').click();
  await expect(chip(page)).toHaveText('Sonnet 5.5 · high▾');
  await expect(row(page, 'Sonnet 5.5')).toHaveClass(/\bpick\b/);
  await level(page, 'max').click();
  await expect(chip(page)).toHaveText('Sonnet 5.5 · max▾');
  await expect(level(page, 'max')).toHaveClass(/\blit\b/);
  await expect(engineLines(page).filter({ hasText: 'Đổi model' })).toHaveText(['Đổi model: Opus 5.5 → Sonnet 5.5 · effort: high → max']);
  await expect(page.locator('#inspector')).not.toContainText('Set model to'); // Claude Code's own replay line is not shown (§6.6)
});

test('§4.3 effort only: "Đổi effort: high → low", the model stays', async ({ page }) => {
  await open(page, 'm-effort', S.idle());
  await chip(page).click();
  await level(page, 'low').click();
  await expect(chip(page)).toHaveText('Opus 5.5 · low▾');
  await expect(engineLines(page).filter({ hasText: 'Đổi effort' })).toHaveText(['Đổi effort: high → low']);
  await expect(engineLines(page).filter({ hasText: 'Đổi model' })).toHaveCount(0);
});

test('§5.3 busy: the change waits for the turn (chip "→ … · chờ hết lượt", placeholder), then applies at the result', async ({ page }) => {
  await open(page, 'm-busy', longTurn(4000));
  await startTurn(page);
  await chip(page).click();
  await expect(menu(page)).toContainText('Điều phối đang chạy một lượt. Sẽ đổi khi lượt này xong');
  await row(page, 'Sonnet 5.5').click();
  await expect(chip(page)).toHaveText('Opus 5.5 → Sonnet 5.5 · chờ hết lượt▾');
  await expect(row(page, 'Sonnet 5.5')).toHaveClass(/\bpending\b/);
  await expect(page.getByLabel('Ô lệnh')).toHaveAttribute('placeholder', 'Gửi khi lượt này xong…');
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator('#inspector')).toContainText('Xong lot-2', { timeout: 15_000 });
  await expect(chip(page)).toHaveText('Sonnet 5.5 · high▾');
  await expect(engineLines(page).filter({ hasText: 'Đổi model' })).toHaveText(['Đổi model: Opus 5.5 → Sonnet 5.5']);
});

test('§5.3 busy: "Bỏ thay đổi đang chờ" → chip back, nothing applies at the result', async ({ page }) => {
  await open(page, 'm-cancel', longTurn(4000));
  await startTurn(page);
  await chip(page).click();
  await level(page, 'max').click();
  await expect(chip(page)).toHaveText('Opus 5.5 · high → max · chờ hết lượt▾');
  await menu(page).getByRole('button', { name: 'Bỏ thay đổi đang chờ' }).click();
  await expect(chip(page)).toHaveText('Opus 5.5 · high▾');
  await expect(level(page, 'high')).toHaveClass(/\blit\b/);
  await expect(page.locator('#inspector')).toContainText('Xong lot-2', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(chip(page)).toHaveText('Opus 5.5 · high▾');
  await expect(engineLines(page).filter({ hasText: /Đổi (model|effort)/ })).toHaveCount(0);
});

test('§4.2 MD6 model_not_found: red line in the open picker, the pick goes back, chip unchanged', async ({ page }) => {
  await open(page, 'm-err', S.idle(), { fail: { set_model: 'not_found' } });
  await chip(page).click();
  await row(page, 'Sonnet 5.5').click();
  await expect(menu(page).locator('.merr')).toHaveText('Không đổi được: Claude Code không nhận model claude-sonnet-5-5.');
  await expect(row(page, 'Theo mặc định')).toHaveClass(/\bpick\b/);
  await expect(row(page, 'Sonnet 5.5')).not.toHaveClass(/\bpick\b/);
  await expect(chip(page)).toHaveText('Opus 5.5 · high▾');
  await expect(engineLines(page).filter({ hasText: 'Đổi model' })).toHaveCount(0);
});

test('§4.2 model_not_found after the picker closed → an error toast', async ({ page }) => {
  await open(page, 'm-toast', S.idle(), { fail: { set_model: 'not_found' }, delayMs: { set_model: 1500 } });
  await chip(page).click();
  await row(page, 'Sonnet 5.5').click();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator('#toasts .toast')).toHaveText('Không đổi được: Claude Code không nhận model claude-sonnet-5-5.');
  await expect(chip(page)).toHaveText('Opus 5.5 · high▾');
});

test('§4.2 Y6 the other entry points: `/model` + Enter opens the picker and sends nothing; ⋯ of the Điều phối root → "Model / effort…" opens it', async ({ page }) => {
  const sent: string[] = [];
  page.on('websocket', ws => ws.on('framesent', f => {
    const c = (JSON.parse(String(f.payload)) as { command?: { cmd: string } }).command;
    if (c) sent.push(c.cmd);
  }));
  await open(page, 'm-entry', S.idle());
  const input = page.getByLabel('Ô lệnh');
  await input.fill('/model');
  await input.press('Enter');
  await expect(menu(page)).toBeVisible();
  await expect(input).toHaveValue('');
  expect(sent).not.toContain('send');
  await expect(page.locator('#inspector .m-po')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await page.locator('.react-flow__node[data-id^="orch:"]').first().locator('button.more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Model / effort…' }).click();
  await expect(menu(page)).toBeVisible();
  expect(sent).not.toContain('send');
});

test('§4.5 D55 lane: chip on the lane\'s Đang xem → a model → the lane chip shows it (lane_set_model on fake-claude)', async ({ page }) => {
  eng.scenario('lane-L7', { control: CONTROL, steps: S.idle() });
  eng.scenario(ORCH, { control: CONTROL, steps: [...S.turn('Sẵn sàng'), ...S.startLane(eng, 'L7'), ...S.idle()] });
  const pid = await eng.addProject('m-lane');
  await eng.openLane(pid, 'L7');
  await page.goto(eng.url());
  await page.locator('#top .tab', { hasText: 'm-lane' }).click();
  await page.locator('.react-flow__node[data-id="lane:L7"]').click();
  await expect(chip(page)).toHaveText('Opus 5.5 · high▾');
  await chip(page).click();
  await expect(menu(page)).toContainText('Model và effort · L7');
  await expect(row(page, 'Theo mặc định')).toHaveClass(/\bpick\b/);
  await row(page, 'Sonnet 5.5').click();
  await expect(chip(page)).toHaveText('Sonnet 5.5 · high▾');
  await expect(row(page, 'Sonnet 5.5')).toHaveClass(/\bpick\b/);
  await expect(engineLines(page).filter({ hasText: 'Đổi model' })).toHaveText(['Đổi model: Opus 5.5 → Sonnet 5.5']);
  // §6.6 Y45 `/model` to the lane opens the lane's picker, sends nothing; §4.5 "⋯" of the lane node from Điều phối → it too
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  const input = page.getByLabel('Ô lệnh');
  await input.fill('/model');
  await input.press('Enter');
  await expect(menu(page)).toContainText('Model và effort · L7');
  await expect(input).toHaveValue('');
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__node[data-id^="orch:"]').first().click();
  await expect(chip(page)).toHaveText('Opus 5.5 · high▾'); // Điều phối's own chip
  await input.fill('@L7 /effort'); // Y45 from Điều phối: the lane is selected first, then its picker opens
  await input.press('Enter');
  await expect(menu(page)).toContainText('Model và effort · L7');
  await expect(chip(page)).toHaveText('Sonnet 5.5 · high▾');
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__node[data-id^="orch:"]').first().click();
  await page.locator('.react-flow__node[data-id="lane:L7"]').locator('button.more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Model / effort…' }).click();
  await expect(menu(page)).toContainText('Model và effort · L7');
  await expect(chip(page)).toHaveText('Sonnet 5.5 · high▾');
});
