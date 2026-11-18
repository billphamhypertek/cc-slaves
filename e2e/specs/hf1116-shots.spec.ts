// Hot fix 2026-11-16 (docs/ref/hf1116-ux.md) self-check shots on the dev mock engine, each frame asserting its key state:
// 3 tabs, 40 tabs (strip scrolls + "Tất cả project (N)" list with a filter), the tab menu enabled / disabled, the held band
// (resume / start) and a long assistant message, at 1440 × 900 and 1024 × 640. What the mock does not carry (40 projects,
// `held`, `paused`) is patched into the snapshot on the page's socket. Shots go to $HF_SHOTS (default .e2e-results/hf1116).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { Snapshot } from '../../shared/protocol.ts';
import { expect, test } from '../fixtures.ts';
import { hideDevToasts, openDeck, useDev } from '../deck.ts';
import { wire } from '../v24-shots-seed.ts';

const dev = useDev();
const DIR = process.env.HF_SHOTS ?? join(import.meta.dirname, '../../.e2e-results/hf1116');
const manyTabs = (n: number) => (s: Snapshot): void => {
  const p = s.projects[0]!; // the copies have no lane and no Điều phối: nothing runs, "Đóng project" is enabled
  for (let i = s.projects.length; i < n; i++) s.projects.push({ ...p, id: `hf${i}`, name: i % 7 === 0 ? `dự-án-${i}-backend-services` : `project-${i}` });
};
const held = (kind: 'start' | 'resume') => (s: Snapshot): void => {
  s.projects[0]!.held = { kind, sessions: kind === 'resume' ? 2 : 0, lanes: kind === 'resume' ? 3 : 0 };
  for (const o of s.orchestrators) if (o.projectId === s.projects[0]!.id) o.state = 'paused';
  for (const l of s.lanes) if (l.projectId === s.projects[0]!.id && l.state !== 'done') l.state = 'paused';
};

async function open(page: Page, w: number, h: number, snap?: (s: Snapshot) => void): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await wire(page, snap ? { snap } : {});
  await openDeck(page, dev.url('DK5'));
  await hideDevToasts(page);
  await page.addStyleTag({ content: '#reloadBand{display:none!important}' });
  if (w < 1280 && !(await page.locator('body.drawer').count())) await page.locator('#inboxBtn').click();
  await page.mouse.move(1, 1);
}
async function shot(page: Page, name: string, w: number): Promise<void> {
  await page.waitForTimeout(350);
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `${name}-${w}.png`) });
}

for (const [w, h] of [[1440, 900], [1024, 640]] as const) {
  test(`hf1116 ${w}: 3 tabs — no list-all button, tabs readable`, async ({ page }) => {
    await open(page, w, h, manyTabs(3));
    await expect(page.locator('#top .tabs .tab')).toHaveCount(3);
    await expect(page.locator('#top .tab.all')).toHaveCount(0);
    for (const b of await page.locator('#top .tabs .tab').all()) expect((await b.boundingBox())!.width).toBeGreaterThanOrEqual(96);
    await shot(page, 'tabs3', w);
  });

  test(`hf1116 ${w}: 40 tabs — the strip scrolls, the active tab is in view, "Tất cả project (40)" lists + filters`, async ({ page }) => {
    await open(page, w, h, manyTabs(40));
    const all = page.locator('#top .tab.all');
    await expect(all).toHaveText('40');
    await expect(page.locator('#top .tabs')).toHaveClass(/fr/);
    const tabs = await page.locator('#top .tabs .tab').evaluateAll(es => es.map(e => e.getBoundingClientRect().width));
    expect(Math.min(...tabs)).toBeGreaterThanOrEqual(96);
    expect(Math.max(...tabs)).toBeLessThanOrEqual(200);
    await shot(page, 'tabs40', w);
    await all.click();
    const f = page.locator('.plist input');
    await expect(f).toBeFocused();
    await expect(page.locator('.plist li')).toHaveCount(40);
    await f.fill('DU-AN'); // case + diacritics ignored
    await expect(page.locator('.plist li')).toHaveCount(5); // dự-án-7, 14, 21, 28, 35
    await shot(page, 'tabs40-list', w);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('.plist')).toHaveCount(0);
    await expect(page.locator('#top .tab.on .pnm')).toHaveText('dự-án-14-backend-services');
    const on = (await page.locator('#top .tab.on').boundingBox())!, strip = (await page.locator('#top .tabs').boundingBox())!;
    expect(on.x).toBeGreaterThanOrEqual(strip.x - 1);
    expect(on.x + on.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
    await all.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.plist')).toHaveCount(0);
    await expect(all).toBeFocused();
  });

  test(`hf1116 ${w}: tab menu — busy project dimmed with its reason, idle one enabled with its tooltip`, async ({ page }) => {
    await open(page, w, h, manyTabs(3));
    await page.locator('#top .tabs .tab').first().click({ button: 'right' });
    const item = page.getByRole('menuitem', { name: /Đóng project/ });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toContainText(/Đang chạy .* — dừng hoặc chờ xong rồi đóng/);
    await shot(page, 'menu-disabled', w);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.locator('#top .tabs .tab').nth(1).focus();
    await page.keyboard.press('Shift+F10');
    await expect(item).not.toHaveAttribute('aria-disabled', 'true');
    await expect(item).toHaveAttribute('title', 'Ẩn khỏi thanh tab, giữ lịch sử. Thêm lại thư mục này để mở lại.');
    await shot(page, 'menu-enabled', w);
  });

  for (const kind of ['resume', 'start'] as const) {
    test(`hf1116 ${w}: held band (${kind}) in the Điều phối box, composer usable`, async ({ page }) => {
      await open(page, w, h, held(kind));
      const band = page.locator('#inspector .m-sys.held');
      await expect(band).toContainText(kind === 'resume' ? 'Đang tạm dừng từ lần mở app trước · 2 phiên Điều phối, 3 lane đang chờ' : 'Điều phối chưa chạy');
      await expect(band.getByRole('button')).toHaveText(kind === 'resume' ? 'Tiếp tục' : 'Bắt đầu');
      await expect(page.locator('#cmd')).toHaveAttribute('placeholder', kind === 'resume' ? 'Gửi để tiếp tục…' : 'Gửi để bắt đầu…');
      await expect(page.locator('#cmd')).toBeEnabled();
      await shot(page, `held-${kind}`, w);
    });
  }

  test(`hf1116 ${w}: a long assistant message reads at --md / 1.6, nothing clipped`, async ({ page }) => {
    await open(page, w, h);
    const md = page.locator('#inspector .hist .md').last();
    await expect(md).toBeVisible();
    expect(await md.evaluate(e => [getComputedStyle(e).fontSize, getComputedStyle(e).lineHeight])).toEqual(['14px', '22.4px']);
    await shot(page, 'convo', w);
  });
}
