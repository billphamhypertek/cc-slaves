// v2.3 UX review (Git part) measured on the real web app over the dev mock engine (web/dev/mock-git.ts): I4 the clipped list
// fades while more is below, I5 branch state words whole at 1024 px, M1 the diff head keeps the path's tail, M5 a commit's
// diff has no conflict block, M6 the pressed "Nhờ …" keeps the accent. The looks are in v23-shots.spec.ts (G frames).
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.ts';
import { hideDevToasts, openDeck, useDev } from '../deck.ts';
import { node } from '../v21-seed.ts';

const dev = useDev();
test.describe.configure({ mode: 'parallel' });
const gv = (page: Page) => page.locator('#gitview');

async function open(page: Page, o: { g?: string; sel: string; narrow?: boolean }): Promise<void> {
  if (o.narrow) await page.setViewportSize({ width: 1024, height: 640 });
  await openDeck(page, dev.url('F3', `g=${o.g ?? 'G1'}`));
  await hideDevToasts(page);
  await node(page, o.sel).locator('button.hit').click();
  await page.keyboard.press('g');
  const drawer = page.getByRole('button', { name: 'Đóng ngăn' });
  if (o.narrow && await drawer.isVisible()) await drawer.click();
}
/** every `.gst` whose text is cut (scrollWidth over its box) */
const cutStates = (page: Page) => gv(page).locator('.gbrow .gst').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 0.5).map(e => e.textContent));

test('I5 G15 1024 × 640: no branch state word is cut, the merge text shrinks instead', async ({ page }) => {
  await open(page, { narrow: true, sel: 'lane:D15' });
  await expect(gv(page).locator('.gbrow.sel')).toContainText('lane/d15');
  await expect(gv(page).locator('.gbrow .gst').filter({ hasText: 'Đang chạy' }).first()).toBeVisible();
  expect(await cutStates(page)).toEqual([]);
});

test('I4 G16 40 files: Thay đổi fades while more is below, not once scrolled to the end; the head counts 40', async ({ page }) => {
  await open(page, { g: 'G16', sel: 'lane:D15' });
  const list = gv(page).getByRole('listbox', { name: 'Thay đổi' });
  await expect(gv(page).locator('.gfr')).toHaveCount(40);
  await expect(list).toHaveClass(/\bgfade\b/);
  await expect(gv(page).locator('.gblk.b2 .gfold')).toContainText('Thay đổi · 40 · lane/d15');
  await list.evaluate(e => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event('scroll')); });
  await expect(list).not.toHaveClass(/\bgfade\b/);
  await expect(list).toHaveClass(/\bgscroll\b/);
});

test('I4 G8 28 branches: Nhánh fades while more is below', async ({ page }) => {
  await open(page, { g: 'G8', sel: 'lane:D15' });
  await expect(gv(page).getByRole('listbox', { name: 'Nhánh' })).toHaveClass(/\bgfade\b/);
});

test('M4 G14 a one-row Nhánh is sized to its content, no fade', async ({ page }) => {
  await open(page, { g: 'G14', sel: 'orch:hagenta' });
  const nh = gv(page).getByRole('listbox', { name: 'Nhánh' });
  await expect(nh).toContainText('chưa có commit');
  expect(Math.round((await nh.boundingBox())!.height)).toBe(28);
  await expect(nh).not.toHaveClass(/\bgfade\b/);
});

// v2.4 §6.7 D53: at 1440 the denser head fits the whole 55-char path (21 px spare), so the cut is proven at 1280 × 800
test('M1 G4 the long spec path is cut in the middle: ".md" stays visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, { sel: 'orch:hagenta' });
  const p = gv(page).locator('.gvh .gpth');
  await expect(p).toHaveText(/…[^/]*\.md$/);
  expect(await p.evaluate(e => e.scrollWidth <= e.clientWidth + 0.5)).toBe(true);
});

test('M5 G3 a commit picked: its own diff (byQuota), no conflict block', async ({ page }) => {
  await open(page, { sel: 'orch:hagenta' });
  await gv(page).getByText('Merge lane/b2 vào main · gate xanh').click();
  await expect(gv(page).locator('.gfr.sel')).toContainText('lanes.ts');
  await expect(gv(page).locator('.gcd')).toContainText('byQuota');
  await expect(gv(page).locator('.gcfb')).toHaveCount(0);
});

test('M6 G9 the pressed "Nhờ D15 rebase…" keeps the accent; the other ask does not', async ({ page }) => {
  await open(page, { sel: 'lane:D15' });
  const b = gv(page).getByRole('button', { name: 'Nhờ D15 rebase…' });
  await b.click();
  await expect(b).toHaveClass(/\bon\b/);
  await expect(gv(page).getByRole('button', { name: 'Nhờ D15 commit…' })).not.toHaveClass(/\bon\b/);
});
