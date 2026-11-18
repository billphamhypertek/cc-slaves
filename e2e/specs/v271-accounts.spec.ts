// v2.7.1 §4.3–§4.6 the wide account panel on dev frames (web/dev/acc-scene.ts, mock engine): 400 px at 1440 / 380 px at 1024,
// every email whole, "Làm mới" sends `quota_refresh` and reads "đang làm mới" within 100 ms (§5), an Ultra row has one bar and
// no 5-hour text (D103), the remote channel has no ⟳ (AC9). E2E_SHOTS=1 also shoots AC1–AC12 next to the mockup PNGs.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.ts';
import { blur, hideDevToasts, openDeck, useDev } from '../deck.ts';

const dev = useDev();
const SHOT_DIR = join(import.meta.dirname, '../../docs/specs/assets/screens/v271-app');
const panel = (page: Page) => page.locator('.accp.open');
const row = (page: Page, email: string) => page.locator(`.accp.open .acrow[data-email="${email}"]`);
async function openPanel(page: Page, frame: string, q = ''): Promise<void> {
  await openDeck(page, dev.url(frame, q));
  await hideDevToasts(page);
  await blur(page);
  if (!(await panel(page).isVisible())) await page.locator('.accp.mini').click(); // ?acc=ready opens it with Sẵn sàng unfolded
  await expect(panel(page)).toBeVisible();
}
/** Emails whose text is cut (scrollWidth past the box). */
const cutEmails = (page: Page) => page.locator('.accp.open .em').evaluateAll(els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));

test('§4.3 AC1 / AC8 panel 400 px at 1440×900 and 380 px at 1024×640; every email whole (≤ 24 characters)', async ({ page }) => {
  for (const [w, h, pw] of [[1440, 900, 400], [1024, 640, 380]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openPanel(page, 'AC1', 'acc=ready');
    expect(Math.round((await panel(page).boundingBox())!.width)).toBe(pw);
    await expect(page.locator('.accp.open .em')).toHaveCount(5);
    expect(await cutEmails(page)).toEqual([]);
    // §4.3 row heights: 2 lines ≈ 50 px, 3 lines ≈ 68 px (no global `.acts` / `.sub` rule may push line 3 down)
    expect(Math.round((await row(page, 'bo24990@example.com').boundingBox())!.height)).toBe(68);
    expect(Math.round((await row(page, 'dev2609@example.com').boundingBox())!.height)).toBe(50);
    await expect(row(page, 'ba@example.net').locator('.l3')).toContainText(w > 1279 ? 'Đầy: tuần đã dùng 73 % (ngưỡng cứng 70 %, dừng ở 69 %)' : 'Đầy: tuần đã dùng 73 % (dừng ở 69 %)');
  }
});

test('§4.3 AC8 an email longer than the column is cut at the end and whole in the row tooltip', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openPanel(page, 'AC8', 'acc=ready');
  const r = row(page, 'nv.longer.account.alt@example.com');
  await r.scrollIntoViewIfNeeded();
  expect(await cutEmails(page)).toEqual(['nv.longer.account.alt@example.com']);
  await r.hover();
  await expect(page.locator('.accp-tip')).toContainText('nv.longer.account.alt@example.com');
  // UX MINOR-3 the hover buttons cover the number column: the number gives way (no half-covered "cò…"), the tooltip carries it
  await expect(r.locator('.apc')).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('.accp-tip')).toContainText(/còn \d+ % · tuần: dùng/);
});

test('D103 AC12 an Ultra row has exactly one bar (week) and no 5-hour text; a Max row has two', async ({ page }) => {
  await openPanel(page, 'AC1', 'acc=ready');
  for (const ultra of ['dev2609@example.com', 'pm@example.net', 'bo24990@example.com']) {
    const r = row(page, ultra);
    await expect(r.locator('.bl')).toHaveCount(1);
    await expect(r.locator('.b5')).toHaveCount(0);
    expect(await r.innerText()).not.toMatch(/5 ?g|5 giờ/);
    await r.hover();
    await expect(page.locator('.accp-tip')).not.toContainText('5 giờ');
  }
  await expect(row(page, 'ba@example.net').locator('.bl')).toHaveCount(2);
  await expect(row(page, 'ba@example.net').locator('.b5 i i')).not.toHaveClass(/\bf\b/);
  await expect(row(page, 'ba@example.net').locator('.bw i i')).toHaveClass(/\bf\b/);
});

test('§4.4 / §5 "Làm mới": `quota_refresh` sent, "đang làm mới" ≤ 100 ms, rows queue then finish', async ({ page }) => {
  const sent: string[] = [];
  page.on('websocket', ws => ws.on('framesent', f => { if (typeof f.payload === 'string') sent.push(f.payload); }));
  await openPanel(page, 'AC1', 'acc=ready');
  const btn = page.locator('.accp.open .ah .aref');
  await expect(btn).toBeEnabled();
  // read after one microtask: no socket frame (a macrotask) can have come back yet, so this is the click's own state, not the ack's
  const [early, ms] = await btn.evaluate(b => new Promise<[string, number]>(res => {
    const t0 = performance.now();
    const upd = document.querySelector('.accp.open .upd')!;
    (b as HTMLButtonElement).click();
    queueMicrotask(() => res([upd.textContent ?? '', performance.now() - t0]));
  }));
  expect(early).toMatch(/đang làm mới/);
  expect(ms).toBeLessThanOrEqual(100);
  await expect.poll(() => sent.some(s => /"cmd":"quota_refresh"/.test(s) && !/"account"/.test(s))).toBe(true);
  await expect(btn).toBeDisabled();
  await expect(btn).toContainText('Đang làm mới');
  await expect(page.locator('.accp.open .abnr.queue')).toContainText('cách nhau 20 giây');
  // review-b IMPORTANT-1: the live `quota` event (not a seeded frame) carries the queue end into the band
  await expect(page.locator('.accp.open .abnr.queue')).toContainText(/Xong hết lúc ≈ \d\d:\d\d/);
  await expect(page.locator('.accp.open .l3 .st').first()).toBeVisible();
  // the mock asks one account every 3 s; the queue ends and the button comes back
  await expect(btn).toContainText('Làm mới', { timeout: 30_000 });
  await expect(btn).not.toContainText('Đang');
});

test('§4.4 the row ⟳ (hover) asks one account; ⋯ has "Làm mới số liệu" with "lần trước HH:MM"', async ({ page }) => {
  const sent: string[] = [];
  page.on('websocket', ws => ws.on('framesent', f => { if (typeof f.payload === 'string') sent.push(f.payload); }));
  await openPanel(page, 'AC1', 'acc=ready');
  const r = row(page, 'pm@example.net');
  await r.hover();
  await r.locator('.aref').click();
  await expect.poll(() => sent.some(s => /"cmd":"quota_refresh"/.test(s) && /"account":"pm@example.net"/.test(s))).toBe(true);
  await expect(page.locator('.accp-tip')).toBeVisible();
  await r.locator('.amore').click();
  await expect(page.locator('.accp-tip')).toHaveCount(0); // UX MINOR-4 the ⋯ menu alone (the click itself: web/test/deck/v271-fc-tip.test.tsx)
  const item = page.locator('.amenu [role=menuitem]').nth(1);
  await expect(item).toContainText('Làm mới số liệu');
  await expect(item).toContainText(/lần trước \d\d:\d\d/);
});

test('§4.4 review-b MINOR-2 ⋯ "Làm mới số liệu" asks through the panel: the row reads "chờ lượt…" ≤ 100 ms, then the item is dimmed (60 s floor)', async ({ page }) => {
  const sent: string[] = [];
  page.on('websocket', ws => ws.on('framesent', f => { if (typeof f.payload === 'string') sent.push(f.payload); }));
  await openPanel(page, 'AC1', 'acc=ready');
  const r = row(page, 'pm@example.net');
  await r.hover();
  await r.locator('.amore').click();
  const item = page.locator('.amenu [role=menuitem]', { hasText: 'Làm mới số liệu' });
  await expect(item).not.toHaveAttribute('aria-disabled', 'true');
  const [early, ms] = await item.evaluate(b => new Promise<[string, number]>(res => {
    const t0 = performance.now();
    (b as HTMLButtonElement).click();
    queueMicrotask(() => res([document.querySelector('.accp.open .acrow[data-email="pm@example.net"] .l3')?.textContent ?? '', performance.now() - t0]));
  }));
  expect(early).toContain('chờ lượt…');
  expect(ms).toBeLessThanOrEqual(100);
  await expect.poll(() => sent.some(s => /"cmd":"quota_refresh"/.test(s) && /"account":"pm@example.net"/.test(s))).toBe(true);
  // the mock answers within ~3 s: fetchedAt is now → the item is dimmed with the row ⟳'s reason
  await r.hover();
  await r.locator('.amore').click();
  await expect(item).toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 });
  await expect(item).toContainText(/Vừa cập nhật lúc \d\d:\d\d — làm mới lại được lúc \d\d:\d\d/);
});

test('§4.4 AC3 429: band + "Thử lại sau m:ss" dimmed; the collapsed card shows ⏸', async ({ page }) => {
  await openPanel(page, 'AC3', 'acc=ready');
  await expect(page.locator('.accp.open .abnr.blocked')).toContainText('Anthropic tạm chặn lượt hỏi số liệu tới');
  const btn = page.locator('.accp.open .ah .aref');
  await expect(btn).toBeDisabled();
  await expect(btn).toContainText(/Thử lại sau \d:\d\d/);
  await page.locator('.accp.open .ah .acb', { hasText: '›' }).click();
  await expect(page.locator('.accp.mini .chev.hold')).toHaveText('⏸');
});

test('§4.6 AC9 remote: no ⟳ anywhere, no +, "tự cập nhật mỗi 5 phút"', async ({ page }) => {
  await openPanel(page, 'AC1', 'acc=ready&remote=1');
  await expect(page.locator('.accp.open .aref')).toHaveCount(0);
  await expect(page.locator('.accp.open .aadd')).toHaveCount(0);
  await expect(page.locator('.accp.open .upd')).toContainText('tự cập nhật mỗi 5 phút');
});

test('§4.7 keyboard: Tab reaches the row, then its ⟳ and ⋯ (shown on focus); the row aria-label reads its state', async ({ page }) => {
  await openPanel(page, 'AC1', 'acc=ready');
  const r = row(page, 'pm@example.net');
  await r.locator('.hit').focus();
  await page.keyboard.press('Tab');
  await expect(r.locator('.aref')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(r.locator('.amore')).toBeFocused();
  await expect(r.locator('.acts')).toHaveCSS('opacity', '1');
  await expect(r.locator('.hit')).toHaveAttribute('aria-label', /^pm@example\.net · còn 31 %/);
});

test.describe('E2E_SHOTS: AC1–AC12 next to the mockup', () => {
  test.skip(!process.env.E2E_SHOTS, 'shots only with E2E_SHOTS=1');
  test('shoot', async ({ page }) => {
    mkdirSync(SHOT_DIR, { recursive: true });
    const shot = (id: string) => page.screenshot({ path: join(SHOT_DIR, `${id}.png`) });
    for (const [id, frame, q] of [['AC1', 'AC1', ''], ['AC2', 'AC2', ''], ['AC3', 'AC3', ''], ['AC7', 'AC7', ''], ['AC9', 'AC1', 'remote=1']] as const) {
      await openPanel(page, frame, `acc=ready${q ? `&${q}` : ''}`);
      await page.mouse.move(700, 880);
      await shot(id);
    }
    await openPanel(page, 'AC1', 'acc=ready');
    await row(page, 'pm@example.net').hover();
    await row(page, 'pm@example.net').locator('.amore').click();
    await shot('AC4');
    await page.keyboard.press('Escape');
    await openPanel(page, 'AC5', 'acc=ready');
    await row(page, 'ba@example.net').hover();
    await shot('AC5');
    await openPanel(page, 'AC1', 'acc=ready');
    await row(page, 'pm@example.net').hover();
    await shot('AC12');
    await page.setViewportSize({ width: 1024, height: 640 });
    await openPanel(page, 'AC8', 'acc=ready');
    await row(page, 'nv.longer.account.alt@example.com').hover();
    await shot('AC8');
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDeck(page, dev.url('AC2'));
    await hideDevToasts(page);
    await page.locator('.accp.mini').hover();
    await shot('AC11');
  });
});
