// v2.8 §4.9 D98 on the seeded engine (Mac app, stubbed `__TAURI__`): with the Account panel open, the node "⋯" menu opened
// from the keyboard → "Mở phiên song song…" (a press in the menu layer) → the start dialog SA1 → its main button → the step
// list SA3: presses inside both dialogs and the step list closing never close the panel.
import type { Page } from '@playwright/test';
import { expect, ORCH, PM, S, test } from '../fixtures.ts';
import { fakeTauri, node, openApp, PID, useSeeded } from '../v21-seed.ts';

const eng = useSeeded({ scenarios: { default: { steps: S.idle() } }, seed: { [ORCH]: { fivePct: 10, weekPct: 10 }, [PM]: { fivePct: 10, weekPct: 30 } } },
  e => ({ project: { id: PID, name: 'shop', path: e.repo('shop'), account: ORCH }, sessions: [{ id: 's3', seq: 3, account: ORCH }], lanes: [] }));
const panel = (page: Page) => page.locator('.accp.open');

test.beforeEach(async ({ page }) => { await fakeTauri(page); });

test('§4.9 SA1 / SA3 over the open panel: presses inside, then the step list closing, keep the panel open', async ({ page }) => {
  await openApp(page, eng.url());
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('a');
  await expect(panel(page)).toBeVisible();
  await node(page, 'orch:s3').locator('button.more').focus();
  await page.keyboard.press('Enter'); // the keyboard opens the menu: no press outside the panel
  await page.getByRole('menu').getByRole('menuitem', { name: 'Mở phiên song song…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.locator('.apick')).toHaveText(/^Tự chọn · sẽ dùng/);
  await dlg.locator('h2').click();
  await expect(panel(page)).toBeVisible();
  eng.slowBoot(3000); // step 2 runs long enough to press inside the step list
  await dlg.locator('.btn.pri').click();
  await expect(dlg.locator('.sst')).toHaveCount(4, { timeout: 1000 });
  await dlg.locator('.sst').first().click();
  await expect(panel(page)).toBeVisible();
  await expect(dlg).toHaveCount(0, { timeout: 20_000 }); // step 4 → the box closes by itself
  eng.slowBoot(0);
  await expect(panel(page)).toBeVisible();
});
