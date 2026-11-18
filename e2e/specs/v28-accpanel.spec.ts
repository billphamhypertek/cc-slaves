// v2.8 §4.9 D98 the open Account panel collapses on a press anywhere outside it, and that press still does its own job (a lane
// node is selected, a header tab switches); a press inside (head ⟳, row ⟳, ⋯ and its portal menu item, Lọc, "Hiện n account",
// the 429 band) keeps it; A6 opened from a row keeps it, inside and on close; hovering out keeps it; Esc / "›" / A as before.
// The step list (SA3 / SA4) case runs on a seeded engine: v28-accpanel-steps.spec.ts.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.ts';
import { blur, hideDevToasts, openDeck, useDev } from '../deck.ts';

const dev = useDev();
const panel = (page: Page) => page.locator('.accp.open');
const mini = (page: Page) => page.locator('.accp.mini');
const row = (page: Page, email: string) => page.locator(`.accp.open .acrow[data-email="${email}"]`);
async function openPanel(page: Page, frame: string, q = 'acc=ready'): Promise<void> {
  await openDeck(page, dev.url(frame, q));
  await hideDevToasts(page);
  await blur(page);
  if (!(await panel(page).isVisible())) await mini(page).click();
  await expect(panel(page)).toBeVisible();
}
/** A lane node whose left end shows between the left column and the open panel (the press lands on the node, outside). */
async function laneLeftOfPanel(page: Page) {
  const left = (await panel(page).boundingBox())!.x, col = (await page.locator('#left').boundingBox())!;
  const nodes = page.locator('.react-flow__node-lane');
  for (let i = 0; i < await nodes.count(); i++) {
    const b = await nodes.nth(i).boundingBox();
    if (b && b.x > col.x + col.width + 4 && b.x + 30 < left) return nodes.nth(i);
  }
  throw new Error('no lane node left of the panel');
}

test('§4.9 a press on a lane node collapses the panel AND selects the node (one press)', async ({ page }) => {
  await openPanel(page, 'AC1');
  const n = await laneLeftOfPanel(page);
  await n.click({ position: { x: 16, y: 20 } });
  await expect(panel(page)).toHaveCount(0);
  await expect(mini(page)).toBeVisible();
  await expect(n.locator('.nd')).toHaveClass(/\bsel\b/);
});

test('§4.9 a press on the deck header tab collapses the panel and switches the tab; on the empty deck it collapses', async ({ page }) => {
  await openPanel(page, 'AC1');
  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 200 } });
  await expect(panel(page)).toHaveCount(0);
  await mini(page).click();
  await expect(panel(page)).toBeVisible();
  const code = page.locator('.dhead [role=tab]').filter({ hasText: 'Code' });
  await code.click();
  await expect(code).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page)).toHaveCount(0);
});

test('v28-fx: an open panel hidden behind the Tasks tab survives the mouse press on "Deck" (it was not on screen)', async ({ page }) => {
  await openPanel(page, 'AC1');
  await page.removeLocatorHandler(page.locator('#tasks')); // stay on Tasks (the fixture clicks Deck whenever it shows)
  const tab = (name: string) => page.locator('.dhead [role=tab]').filter({ hasText: name });
  await tab('Tasks').focus();
  await page.keyboard.press('Enter'); // a key, not a press: the panel stays open, mounted but hidden
  await expect(tab('Tasks')).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page)).toHaveCount(1);
  await expect(panel(page)).toBeHidden();
  await tab('Deck').click();
  await expect(tab('Deck')).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page)).toBeVisible();
});

test('§4.9 presses inside keep it open: head ⟳, row ⟳, ⋯ → "Làm mới số liệu" (portal menu), "Hiện n account"', async ({ page }) => {
  await openPanel(page, 'AC1', '');
  await page.locator('.accp.open .ah .aref').click();
  await expect(panel(page)).toBeVisible();
  const r = row(page, 'pm@example.net');
  await r.hover();
  await r.locator('.aref').click();
  await expect(panel(page)).toBeVisible();
  await r.hover();
  await r.locator('.amore').click();
  const item = page.locator('.amenu [role=menuitem]', { hasText: 'Làm mới số liệu' });
  await expect(item).toBeVisible();
  expect(await item.evaluate(e => !!e.closest('.accp'))).toBe(false); // the menu lives outside the panel's DOM
  await item.click();
  await expect(page.locator('.amenu')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await page.locator('.accp.open .gmore').click();
  await expect(page.locator('.accp.open .gmore')).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page)).toBeVisible();
});

test('§4.9 the Lọc box (more than 8 accounts) and the 429 band keep it open', async ({ page }) => {
  await openPanel(page, 'DK30', '');
  await page.locator('.accp.open input.afilter').click();
  await page.locator('.accp.open input.afilter').fill('acc02');
  await expect(panel(page)).toBeVisible();
  await openPanel(page, 'AC3');
  await page.locator('.accp.open .abnr.blocked').click();
  await expect(panel(page)).toBeVisible();
});

test('§4.9 "Đăng nhập lại" opens A6 over the panel: a press inside A6 and closing A6 keep the panel open', async ({ page }) => {
  await openPanel(page, 'AC7');
  await row(page, 'acc19@example.net').locator('.hit').click();
  const a6 = page.getByRole('dialog');
  await expect(a6).toContainText(/Đăng nhập lại/);
  await a6.locator('h2, h3').first().click();
  await expect(panel(page)).toBeVisible();
  await a6.getByRole('button', { name: 'Huỷ' }).click(); // closing A6 with a press: the panel stays
  await expect(a6).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
});

test('§4.9 hovering out keeps it open; Esc, "›" and A as before', async ({ page }) => {
  await openPanel(page, 'AC1');
  await page.mouse.move(60, 400);
  await page.mouse.move(300, 500);
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press('a');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('a');
  await expect(panel(page)).toHaveCount(0);
  await mini(page).click();
  await page.locator('.accp.open .ah .acb', { hasText: '›' }).click();
  await expect(panel(page)).toHaveCount(0);
});
