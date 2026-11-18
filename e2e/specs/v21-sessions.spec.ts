// v2.1 §6 "Phiên, e2e" (§4.14): two running sessions (#3 with D1–D3, #4 "hotfix" with H1–H2) and two ended ones (#1 at
// 71 % context, #2 at 88 % with a handoff), seeded into state.db before boot (e2e/v21-seed.ts). Real engine + fake-claude.
import type { Page } from '@playwright/test';
import { expect, ORCH, PM, test } from '../fixtures.ts';
import type { SeedLane, V21Seed } from '../v21-seed-db.ts';
import { node, nodeBoxes, openApp, overlaps, PID, useSeeded } from '../v21-seed.ts';

const eng = useSeeded({}, (e): V21Seed => {
  const lane = (name: string, owner: string, account: string): SeedLane => ({ name, owner, account, cwd: e.wt(name), task: `việc ${name}` });
  return {
    project: { id: PID, name: 'shop', path: e.repo('shop'), account: ORCH },
    sessions: [
      { id: 's1', seq: 1, account: ORCH, ended: { ctx: 142_000, handoff: false, transcript: true } },
      { id: 's2', seq: 2, account: PM, ended: { ctx: 176_000, handoff: true, transcript: true } },
      { id: 's3', seq: 3, account: ORCH },
      { id: 's4', seq: 4, account: PM, title: 'hotfix' },
    ],
    lanes: [lane('D1', 's3', ORCH), lane('D2', 's3', ORCH), lane('D3', 's3', ORCH), lane('H1', 's4', PM), lane('H2', 's4', PM)],
  };
});

const TREE = ['orch:s3', 'lane:D1', 'lane:D2', 'lane:D3', 'orch:s4', 'lane:H1', 'lane:H2'];
const target = (page: Page) => page.locator('#left .inrow button.target');
const list = (page: Page) => page.getByRole('menu', { name: 'Lịch sử phiên' });
const rootMenu = async (page: Page, sid: string) => {
  await node(page, `orch:${sid}`).locator('button.more').click();
  return page.getByRole('menu');
};
/** H is ignored while typing (§4.11): blur the composer first. */
const pressH = async (page: Page) => { await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press('h'); };
/** Ended session #n → Đang xem (read-only) through the H list. */
const viewEnded = async (page: Page, n: number) => {
  await pressH(page);
  await list(page).locator('button.srow', { hasText: `#${n}` }).click();
  await expect(page.locator('#inspector')).toContainText(`Phiên #${n}`);
};

test.beforeEach(async ({ page }) => { await openApp(page, eng.url()); });

test('§4.14 two roots do not overlap; each tree stays in its own band, #3 above #4', async ({ page }) => {
  const bs = await nodeBoxes(page);
  expect(overlaps(bs)).toEqual([]);
  const band = (ids: string[]) => { const b = bs.filter(x => ids.includes(x.id)); return { top: Math.min(...b.map(x => x.y)), bottom: Math.max(...b.map(x => x.y + x.h)) }; };
  const a = band(TREE.slice(0, 4)), b = band(TREE.slice(4));
  expect(a.bottom).toBeLessThan(b.top);
});

test('§4.14 a faint horizontal separator sits between the two trees', async ({ page }) => {
  const bs = await nodeBoxes(page);
  const sep = page.locator('.react-flow .tsep');
  await expect(sep).toHaveCount(1);
  const r = (await sep.boundingBox())!, h3 = bs.find(x => x.id === 'lane:D3')!, h4 = bs.find(x => x.id === 'orch:s4')!;
  expect(r.y).toBeGreaterThan(h3.y + h3.h);
  expect(r.y).toBeLessThan(h4.y);
  expect(await sep.evaluate(e => getComputedStyle(e).borderTopStyle)).toBe('dashed');
});

test('§4.14 "Cửa sổ < 1280 px": H with the drawer closed opens the list on-screen, inside the drawer, and a row clicks', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator('body')).not.toHaveClass(/\bdrawer\b/);
  await pressH(page);
  await expect(list(page)).toBeVisible();
  // H opens the drawer too: measure it at rest, not mid-slide (the list already sits at the drawer's final place)
  await page.locator('#left').evaluate(e => Promise.all(e.getAnimations().map(a => a.finished)));
  const r = (await list(page).boundingBox())!, left = (await page.locator('#left').boundingBox())!;
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.x + r.width).toBeLessThanOrEqual(left.x + left.width + 0.5);
  await list(page).locator('button.srow', { hasText: '#1' }).click();
  await expect(page.locator('#inspector')).toContainText('Phiên #1');
});

test('§4.14 clicking a root changes the composer target and the lit root', async ({ page }) => {
  await expect(target(page)).toContainText('Điều phối #3');
  await node(page, 'orch:s4').locator('button.hit').click();
  await expect(target(page)).toContainText('Điều phối #4');
  await expect(node(page, 'orch:s4').locator('.nd.orch')).toHaveClass(/\bsel\b/);
  await expect(node(page, 'orch:s3').locator('.nd.orch')).not.toHaveClass(/\bsel\b/);
});

// v2.7 R34: the count is Thiết kế / Build + a Chung beyond the first (two Chung sessions → 1)
test('§4.14 H opens the session list (running 1 / 3 per v2.7 R34, ended below), Esc closes it', async ({ page }) => {
  await pressH(page);
  await expect(list(page)).toBeVisible();
  await expect(list(page)).toContainText('Đang chạy · 1 / 3');
  await expect(list(page).locator('button.srow')).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(list(page)).toBeHidden();
});

test('§4.14 viewing an ended session: no composer, read-only note, deck unchanged, no root lit', async ({ page }) => {
  const before = await nodeBoxes(page);
  await viewEnded(page, 1);
  await expect(page.locator('#cmd')).toHaveCount(0);
  await expect(page.locator('#inspector')).toContainText('Chỉ xem — phiên đã kết thúc');
  expect(await nodeBoxes(page)).toEqual(before);
  await expect(page.locator('.react-flow .nd.orch.sel')).toHaveCount(0);
});

test('§4.14 resume dialog: 71 % → main "Chạy tiếp #1"; 88 % with handoff → main "Phiên mới từ handoff #2"', async ({ page }) => {
  await viewEnded(page, 1);
  await page.locator('#inspector').getByRole('button', { name: 'Chạy tiếp…' }).click();
  const d1 = page.getByRole('dialog');
  await expect(d1).toContainText('71 %');
  await expect(d1.locator('.btn.pri')).toHaveText('Chạy tiếp #1');
  await d1.getByRole('button', { name: 'Huỷ' }).click();
  await viewEnded(page, 2);
  await page.locator('#inspector').getByRole('button', { name: 'Chạy tiếp…' }).click();
  const d2 = page.getByRole('dialog');
  await expect(d2).toContainText('88 %');
  await expect(d2.locator('.btn.pri')).toHaveText('Phiên mới từ handoff #2');
  await expect(d2.getByRole('button', { name: 'Vẫn chạy tiếp' })).toBeVisible();
});

test('§4.14 > 1 running session: the root menu splits safe stop into "lane của #3" and "cả project (5 lane)"', async ({ page }) => {
  const m = await rootMenu(page, 's3');
  await expect(m.getByRole('menuitem', { name: 'Dừng an toàn lane của #3…' })).toBeVisible();
  await expect(m.getByRole('menuitem', { name: 'Dừng an toàn cả project (5 lane)…' })).toBeVisible();
  await expect(m.getByRole('menuitem', { name: 'Dừng an toàn tất cả lane…' })).toHaveCount(0);
});

test('§4.11 Tab walks root → its lanes → next root; keys 1–9 number lanes across roots in tree order', async ({ page }) => {
  await node(page, 'orch:s3').locator('button.hit').focus();
  const seen: string[] = [];
  for (let i = 0; i < 40 && seen.length < TREE.length; i++) {
    const id = await page.evaluate(() => document.activeElement?.closest('.react-flow__node')?.getAttribute('data-id') ?? null);
    if (id && id !== seen.at(-1) && TREE.includes(id)) seen.push(id);
    await page.keyboard.press('Tab');
  }
  expect(seen).toEqual(TREE);
  await page.locator('#map').click({ position: { x: 5, y: 300 } }); // focus off any input
  for (const [key, lane] of [['1', 'D1'], ['4', 'H1'], ['5', 'H2']] as const) {
    await page.keyboard.press(key);
    await expect(node(page, `lane:${lane}`).locator('.nd.lane')).toHaveClass(/\bsel\b/);
  }
});

// v2.7 R34: three Chung sessions count as 2 of the 3, so "Chạy song song" stays open (preselected) and so does the menu item
test('§4.14 + v2.7 R34 three running Chung sessions: "Chạy song song" still open and preselected, menu item enabled', async ({ page }) => {
  const m = await rootMenu(page, 's3');
  await m.getByRole('menuitem', { name: 'Mở phiên song song…' }).click();
  const open = page.getByRole('dialog');
  await expect(open.locator('.btn.pri')).toHaveText('Mở phiên #5');
  await open.locator('.btn.pri').click();
  await expect.poll(async () => (await eng.snapshot()).orchestrators.map(o => o.seq).sort(), { timeout: 20_000 }).toEqual([3, 4, 5]);
  const s5 = (await eng.snapshot()).orchestrators.find(o => o.seq === 5)!.sessionId!;
  await expect(node(page, `orch:${s5}`)).toBeVisible(); // the new root at the end
  await expect(page.locator('#inspector .ohead h2')).toHaveText('Điều phối #5'); // Đang xem moved to it
  await viewEnded(page, 1);
  await page.locator('#inspector').getByRole('button', { name: 'Chạy tiếp…' }).click();
  const d = page.getByRole('dialog');
  await expect(d.getByRole('radio', { name: /Chạy song song/ })).toBeEnabled();
  await expect(d.getByRole('radio', { name: /Chạy song song/ })).toHaveAttribute('aria-checked', 'true');
  await d.getByRole('button', { name: 'Huỷ' }).click();
  const m2 = await rootMenu(page, 's3');
  await expect(m2.getByRole('menuitem', { name: 'Mở phiên song song…' })).toBeEnabled();
});

// last: it leaves #1 running in the file's one seeded engine
test('§4.14 m-5 N5-h "Chạy tiếp #1" runs: Đang xem shows the divider "Chạy tiếp <time> · <acc> · song song | thay #m" and the engine\'s first line', async ({ page }) => {
  await viewEnded(page, 1);
  await page.locator('#inspector').getByRole('button', { name: 'Chạy tiếp…' }).click();
  await page.getByRole('dialog').locator('.btn.pri').click();
  await expect(page.locator('#inspector .ohead h2')).toHaveText('Điều phối #1', { timeout: 20_000 });
  const hist = page.locator('#inspector .hist');
  await expect(hist.locator('.m-div')).toContainText(/^Chạy tiếp \d\d[/-]\d\d \d\d:\d\d · .+ · (song song|thay #\d)$/, { timeout: 20_000 });
  await expect(hist).toContainText('Phiên này được nối lại sau', { timeout: 20_000 });
});
