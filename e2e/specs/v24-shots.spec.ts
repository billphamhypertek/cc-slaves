// v2.4 §13 "Ảnh chụp mọi khung §7 để so với mockup": every frame of docs/specs/assets/screens/v24-mockup/ driven into its
// state on the real web app over the dev mock engine and saved as docs/specs/assets/screens/v24-<frame>.png at the
// mockup's window (1440 × 900; DK2 / DK3 also at 1024 × 640 → v24-DK2-1024 / v24-DK3-1024). MD frames: the deck frame DK5 with one Chờ PO card
// (`cards=1`, as the G2b self-check) and the mock's model scene `md=<frame>` (web/dev/mock-model.ts); what the mock does not
// carry is patched on the page's socket (e2e/v24-shots-seed.ts). Each frame asserts its key text, so a shot cannot
// silently show the wrong state; looks are judged by the independent UX review against the mockup PNG.
// DK frames (attachments, §6): the `DK` describe block at the end of this file.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.ts';
import { hideDevToasts, openDeck, useDev } from '../deck.ts';
import { orchSeq, shotV24, wire, type Wire, type WireCtl } from '../v24-shots-seed.ts';
import { dragOver, drop, mockAttach, nativeDrop, paste, stubTauri, type FileSpec, type MockAttach } from '../v24-attach-io.ts';

const dev = useDev();
test.describe.configure({ mode: 'parallel' });
test.use({ screenshot: 'only-on-failure' });

/** DK frames: `attach` answers the page's `/attach*` (the mock has none), `tauri` = the Mac app's native drop bridge,
 *  `toasts` keeps #toasts on screen (DK3 / DK10 drop label, DK11 toast) after clearing the mock's own. */
interface Open { md?: string; f?: string; cards?: number | null; remote?: boolean; wire?: Wire; attach?: MockAttach; tauri?: boolean; toasts?: boolean; narrow?: boolean }
async function open(page: Page, o: Open): Promise<WireCtl> {
  const ctl = await wire(page, o.wire ?? {});
  if (o.attach) await mockAttach(page, o.attach);
  if (o.tauri) await stubTauri(page);
  const q = [o.md ? `md=${o.md}` : '', o.cards === null ? '' : `cards=${o.cards ?? 1}`, o.remote ? 'remote=1' : ''].filter(Boolean).join('&');
  await openDeck(page, dev.url(o.f ?? 'DK5', q));
  if (o.toasts) { // the mock's own toasts at open are hidden, the frame's toast shows
    await page.evaluate(() => { for (const t of document.querySelectorAll('#toasts > *')) t.setAttribute('data-mock', ''); });
    await page.addStyleTag({ content: '#toasts > [data-mock]{display:none!important}' });
  } else await hideDevToasts(page);
  await page.addStyleTag({ content: '#reloadBand{display:none!important}' }); // the mock speaks protocol 1: its "vừa cập nhật" band
  if (!o.narrow) await expect(chip(page)).toBeVisible(); // 1024 × 640: the left column is a closed drawer
  else await expect(page.locator('.narrow')).toHaveCount(1);
  return ctl;
}
async function shot(page: Page, frame: string, hover = false): Promise<void> {
  if (!hover) await page.mouse.move(1, 1);
  await shotV24(page, frame);
}

const ins = (page: Page) => page.locator('#inspector');
const chip = (page: Page) => ins(page).locator('.mchip');
const menu = (page: Page) => page.locator('.mdmenu');
const row = (page: Page, label: string) => menu(page).locator('.mrow', { has: page.locator('b', { hasText: new RegExp(`^${label}$`) }) });
const dialog = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.mh') });
/** §4.2 open the picker from the chip; its rows are in (or the skeleton, MD8). */
async function picker(page: Page): Promise<void> {
  await chip(page).click();
  await expect(menu(page)).toBeVisible();
}
/** The deck root's "⋯" → `item` (v2.1 N5-b / N5-e). */
async function rootMenu(page: Page, item: string): Promise<void> {
  await page.locator('.react-flow__node[data-id^="orch:"]').first().locator('button.more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
}
/** v2.1 §4.14 "Lịch sử phiên…" → the ended "#2 · lot-2" in Đang xem (MD12), its "Chạy tiếp…" dialog (MD11). */
async function viewEnded(page: Page): Promise<void> {
  await rootMenu(page, 'Lịch sử phiên…');
  await page.getByRole('menu', { name: 'Lịch sử phiên' }).locator('button.srow', { hasText: '#2 · lot-2' }).first().click();
  await expect(ins(page)).toContainText('Phiên #2');
}
/** §4.4 "Mở phiên song song…" with the mockup's name + first message typed in. */
async function parallel(page: Page): Promise<void> {
  await rootMenu(page, 'Mở phiên song song…');
  await expect(dialog(page)).toContainText('Mở phiên song song');
  await dialog(page).locator('input.field').fill('hotfix');
  await dialog(page).locator('textarea.field').fill('Sửa lỗi đăng nhập SSO trên bản 2.3, không đụng lane của #2.');
}

// =====================================================================================================================
test.describe('MD', () => {
  test('MD1 the chip on its own line under the session name', async ({ page }) => {
    await open(page, { md: 'MD1' });
    await expect(chip(page)).toHaveText('Fable 5.2 · high▾');
    await shot(page, 'MD1');
  });
  test('R43 I1 MD1 the Điều phối meta line is one line with real numbers; "Ẩn công cụ" sits at the chip row\'s right end', async ({ page }) => {
    await open(page, { md: 'MD1' });
    const meta = ins(page).locator('.ohead .meta.mono');
    await expect(meta).toContainText('tok');
    const m = await meta.evaluate(e => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight), pad: parseFloat(getComputedStyle(e).paddingTop) + parseFloat(getComputedStyle(e).paddingBottom), tools: !!e.querySelector('.hidetools') }));
    expect(m.tools, '"Ẩn công cụ" is not inside the meta line').toBe(false);
    expect(m.h - m.pad, `meta ${m.h} px = one line of ${m.lh}`).toBeLessThan(m.lh * 1.5);
    expect(await meta.getAttribute('title')).toContain('ctx');
    const tools = await ins(page).locator('.ohead .hidetools').boundingBox(), c = await chip(page).boundingBox(), info = await ins(page).locator('.iinfo').boundingBox();
    expect(Math.abs(tools!.y + tools!.height / 2 - (c!.y + c!.height / 2)), 'same row as the chip').toBeLessThan(3);
    expect(info!.x + info!.width - (tools!.x + tools!.width), 'at the right end').toBeLessThan(24);
    // a longer line (bigger numbers, a titled session) ellipsises instead of wrapping
    const long = await meta.evaluate(e => { e.textContent = `${e.textContent} · ${e.textContent}`; return { h: e.getBoundingClientRect().height, sw: e.scrollWidth, cw: e.clientWidth }; });
    expect(long.h).toBeCloseTo(m.h, 0);
    expect(long.sw).toBeGreaterThan(long.cw);
  });
  test('R43 M2 the "Điều phối ▾" head button is ≥ 24 px tall without growing the head row', async ({ page }) => {
    await open(page, { md: 'MD1' });
    const b = await ins(page).locator('.oname').boundingBox(), r = await ins(page).locator('.ohead .row').boundingBox();
    expect(b!.height).toBeGreaterThanOrEqual(24);
    expect(r!.height, 'head row height (v24-MD1 committed: 28 + paddings)').toBeLessThanOrEqual(42);
  });
  test('R43 I2 Chờ PO with 1 / 2 rows shrinks to them: 4 px under the last row, no fade', async ({ page }) => {
    for (const n of [1, 2]) {
      await open(page, { md: 'MD1', cards: n });
      const cards = page.locator('#inbox .cards');
      await expect(cards.locator('.card')).toHaveCount(n);
      const g = await cards.evaluate(e => ({ pad: getComputedStyle(e).paddingBottom, gap: e.getBoundingClientRect().bottom - e.querySelectorAll('.card')[e.querySelectorAll('.card').length - 1]!.getBoundingClientRect().bottom, mask: getComputedStyle(e).maskImage }));
      expect(g.pad).toBe('4px');
      expect(g.gap, `${n} rows: band under the last row`).toBeLessThanOrEqual(5);
      expect(g.mask).toBe('none');
    }
  });
  test('MD2 picker open, idle: "Theo mặc định" ✓, 4 aliases, older (9), high lit, impact line', async ({ page }) => {
    await open(page, { md: 'MD2' });
    await picker(page);
    await expect(row(page, 'Theo mặc định')).toHaveClass(/\bpick\b/);
    await expect(menu(page).locator('.mrow.grp')).toContainText('Model cũ hơn (9)');
    await expect(menu(page).locator('.lv.lit')).toHaveText('high');
    await expect(menu(page).locator('.mimp')).toHaveText('Áp dụng từ lượt sau.');
    await shot(page, 'MD2');
  });
  test('MD2b a model just clicked: its row spins, the rest and the Effort row lock', async ({ page }) => {
    await open(page, { md: 'MD2b' });
    await picker(page);
    await row(page, 'Sonnet 5.5').click();
    await expect(row(page, 'Sonnet 5.5')).toHaveClass(/\bbusy\b/);
    await expect(row(page, 'Opus 5.5')).toBeDisabled();
    await expect(menu(page).locator('.lv').first()).toBeDisabled();
    await shot(page, 'MD2b');
  });
  test('MD3 older group open at the top of the list, an older model picked; "Opus 4.6 không có mức xhigh"', async ({ page }) => {
    await open(page, { md: 'MD3' });
    await picker(page);
    await expect(menu(page).locator('.mrow.grp')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'Opus 4.6')).toHaveClass(/\bpick\b/);
    await expect(menu(page).locator('.mnote')).toHaveText('Opus 4.6 không có mức xhigh');
    await shot(page, 'MD3');
  });
  test('MD4 busy, picker open: pending model chip, clock row, wait sentence + "Bỏ thay đổi đang chờ"', async ({ page }) => {
    await open(page, { md: 'MD4' });
    await expect(chip(page)).toHaveText('Fable 5.2 → Sonnet 5.5 · chờ hết lượt▾');
    await picker(page);
    await expect(row(page, 'Sonnet 5.5')).toHaveClass(/\bpending\b/);
    await expect(menu(page).locator('.mimp')).toContainText('Điều phối đang chạy một lượt. Sẽ đổi khi lượt này xong');
    await expect(menu(page).getByRole('button', { name: 'Bỏ thay đổi đang chờ' })).toBeVisible();
    await shot(page, 'MD4');
  });
  test('MD4b busy, picker closed, effort only: chip, the held message, the composer placeholder', async ({ page }) => {
    await open(page, { md: 'MD4b' });
    await expect(chip(page)).toHaveText('Fable 5.2 · high → max · chờ hết lượt▾');
    await expect(ins(page).locator('.m-po').filter({ hasText: 'Xong lượt này thì review lại lot-2.' })).toContainText('gửi khi lượt này xong');
    await expect(page.getByLabel('Ô lệnh')).toHaveAttribute('placeholder', 'Gửi khi lượt này xong…');
    await shot(page, 'MD4b');
  });
  test('MD5 a model without effort (Haiku 4.5): Effort row dim + reason; chip only the name', async ({ page }) => {
    await open(page, { md: 'MD5' });
    await expect(chip(page)).toHaveText('Haiku 4.5▾');
    await picker(page);
    await expect(menu(page).locator('.mnote')).toHaveText('Haiku 4.5 không có mức effort');
    await expect(menu(page).locator('.lv').first()).toBeDisabled();
    await shot(page, 'MD5');
  });
  test('MD6 error: red line in the picker, the pick back on the old value', async ({ page }) => {
    await open(page, { md: 'MD6' });
    await picker(page);
    await row(page, 'Sonnet 5.5').click();
    await expect(menu(page).locator('.merr')).toHaveText('Không đổi được: Claude Code không nhận model claude-sonnet-5-5.');
    await expect(row(page, 'Theo mặc định')).toHaveClass(/\bpick\b/);
    await expect(chip(page)).toHaveText('Fable 5.2 · high▾');
    await expect(menu(page).locator('.mimp')).toHaveText('Áp dụng từ lượt sau.'); // the mockup's session is idle
    await shot(page, 'MD6');
  });
  test('MD7 stopped session: the picker works, "Áp dụng khi phiên chạy lại."', async ({ page }) => {
    await open(page, { md: 'MD7' });
    await picker(page);
    await expect(menu(page).locator('.mimp')).toHaveText('Áp dụng khi phiên chạy lại.');
    await shot(page, 'MD7');
  });
  test('MD8 the list loading: grey skeleton rows, "Theo mặc định" + the running model still shown', async ({ page }) => {
    await open(page, { md: 'MD8' });
    await picker(page);
    await expect(menu(page).locator('.mskel')).toBeVisible();
    await expect(row(page, 'Theo mặc định')).toBeVisible();
    await shot(page, 'MD8');
  });
  test('MD8b no list: "Chưa lấy được danh sách model · Thử lại"', async ({ page }) => {
    await open(page, { md: 'MD8b' });
    await picker(page);
    await expect(menu(page).locator('.mfail')).toContainText('Chưa lấy được danh sách model');
    await expect(menu(page).locator('.mfail').getByRole('button', { name: 'Thử lại' })).toBeVisible();
    await shot(page, 'MD8b');
  });
  test('MD9 mismatch: amber dot on the chip; ✓ on the pick, amber dot on the running row, the explaining line', async ({ page }) => {
    await open(page, { md: 'MD9' });
    await expect(chip(page).locator('.adot')).toBeVisible();
    await picker(page);
    await expect(row(page, 'Opus 5.5')).toHaveClass(/\bpick\b/);
    await expect(row(page, 'Sonnet 5.5')).toHaveClass(/\brunning\b/);
    await expect(menu(page).locator('.mmis')).toContainText('không có Opus 5.5 — đang chạy Sonnet 5.5');
    await expect(menu(page).locator('.mimp')).toHaveCount(0);
    await shot(page, 'MD9');
  });
  test('MD10 "Mở phiên song song" with the Model · Effort row (defaults)', async ({ page }) => {
    await open(page, { md: 'MD2', wire: { snap: orchSeq(2) } });
    await parallel(page);
    await expect(dialog(page)).toContainText('chạy cạnh #2');
    await expect(dialog(page).locator('.mpick')).toHaveText('Theo mặc định (Fable 5.2)');
    await expect(dialog(page).locator('.mpicks select option:checked')).toHaveText('Theo mặc định (high)'); // v2.7.1 SA1: the account's default effort
    await shot(page, 'MD10');
  });
  test('MD10b the same dialog, the Model list open', async ({ page }) => {
    await open(page, { md: 'MD2', wire: { snap: orchSeq(2) } });
    await parallel(page);
    await dialog(page).locator('.mpick').click();
    await expect(page.getByRole('listbox')).toContainText('Sonnet 5.5');
    await expect(page.getByRole('listbox')).toContainText('Model cũ hơn (9)');
    await shot(page, 'MD10b');
  });
  test('MD10c the same dialog, no list: both fields "Theo mặc định" + "Chưa lấy được danh sách model · Thử lại"', async ({ page }) => {
    await open(page, { md: 'MD10c', wire: { snap: orchSeq(2) } });
    await parallel(page);
    await expect(dialog(page).locator('.mpick')).toHaveText(/^Theo mặc định/);
    await expect(dialog(page).locator('.mfail')).toContainText('Chưa lấy được danh sách model');
    await expect(dialog(page).locator('.btn.pri')).toBeEnabled();
    await shot(page, 'MD10c');
  });
  test('MD11 "Chạy tiếp" prefills the session\'s old picks', async ({ page }) => {
    await open(page, { md: 'MD11', wire: { snap: orchSeq(3) } });
    await viewEnded(page);
    await ins(page).getByRole('button', { name: 'Chạy tiếp…' }).click();
    await expect(dialog(page).locator('.mpick')).toHaveText('Opus 5.5');
    await expect(dialog(page).locator('.mpicks select')).toHaveValue('xhigh');
    await shot(page, 'MD11');
  });
  test('MD12 an ended session: model · effort as plain text, not clickable', async ({ page }) => {
    await open(page, { md: 'MD2', wire: { snap: orchSeq(3) } });
    await viewEnded(page);
    await expect(ins(page).locator('.meta.mono span').first()).toHaveText('Opus 5.5 · xhigh');
    await expect(chip(page)).toHaveCount(0);
    await shot(page, 'MD12');
  });
  test('MD13 offline: chip dimmed, the picker read only (every row dim) + the reason', async ({ page }) => {
    const ctl = await open(page, { md: 'MD2' });
    await picker(page); // the list arrives while online …
    await expect(row(page, 'Sonnet 5.5')).toBeEnabled(); // … and is in (cached) before the drop, else MD8b "no list" (raced under load)
    await page.keyboard.press('Escape');
    ctl.drop(); // … then the connection drops and stays down
    await expect(chip(page)).toHaveClass(/\boff\b/);
    await picker(page);
    await expect(menu(page).locator('.mro')).toContainText('Mất kết nối');
    await expect(row(page, 'Sonnet 5.5')).toBeDisabled();
    await shot(page, 'MD13');
  });
  test('MD14 the conversation line "Đổi model: Fable 5.2 → Sonnet 5.5 · effort: high → max"', async ({ page }) => {
    await open(page, { md: 'MD14' });
    await expect(chip(page)).toHaveText('Sonnet 5.5 · max▾');
    await expect(ins(page).locator('.m-evt', { hasText: 'Đổi model: Fable 5.2 → Sonnet 5.5 · effort: high → max' })).toBeVisible();
    await shot(page, 'MD14');
  });
});

// =====================================================================================================================
// DK frames (§6 attachments): the mockup's deck (DK5, one Chờ PO card as the MD frames: v2.1 cards are taller than the mockup's sketches), the composer fed through e2e/v24-attach-io.ts —
// a ⌘V / DOM drop of real `File`s (canvas PNGs → real thumbnails), the Mac app's native drop (`tauri`: absolute paths
// answered by the mocked `POST /attach/path`). DK7 / DK12 read the mock's v2.4 conversation scene (`f=DKM`).
const PATH = {
  xlsx: '/Users/po/Desktop/doanh-thu.xlsx',
  md: '/Users/po/Works/Projects/cc-slaves/docs/specs/2026-11-15-cc-slaves-v2.4-model-attach-design.md',
  docx: '/Users/po/Desktop/báo-cáo.docx',
  dir: '/Users/po/Desktop/bao-cao-t10',
  db: '/Users/po/.cc-slaves/state.db',
} as const;
const KB = 1024;
const FILES: MockAttach['path'] = {
  [PATH.xlsx]: { body: { kind: 'file', name: 'doanh-thu.xlsx', size: 48 * KB } },
  [PATH.md]: { body: { kind: 'file', name: '2026-11-15-cc-slaves-v2.4-model-attach-design.md', size: 18 * KB } },
  [PATH.docx]: { body: { kind: 'file', name: 'báo-cáo.docx', size: 31 * KB } },
  [PATH.dir]: { body: { kind: 'dir', name: 'bao-cao-t10' } },
  [PATH.db]: { status: 403, body: { error: 'blocked' } },
};
const DKO: Open = { attach: { path: FILES }, tauri: true };
const imgs = (n: number, from = 0): FileSpec[] => Array.from({ length: n }, (_, i) => ({ name: 'image.png', img: { hue: (from + i) * 47 } }));
const cmd = (page: Page) => page.getByLabel('Ô lệnh');
const tray = (page: Page) => ins(page).locator('.tray');
const sendBtn = (page: Page) => ins(page).locator('.cbar .send');
/** chips in, none still uploading (unless the frame wants it) */
const settled = (page: Page) => expect(tray(page).locator('.sp')).toHaveCount(0);
/** DK2: 3 pasted images + 3 Finder files. */
async function dk2(page: Page): Promise<void> {
  await paste(page, imgs(3));
  await nativeDrop(page, [PATH.xlsx, PATH.md, PATH.docx]);
  await expect(tray(page).locator('.ich, .fch')).toHaveCount(6);
  await settled(page);
}

test.describe('DK', () => {
  test('DK1 one image chip + the question being typed', async ({ page }) => {
    await open(page, DKO);
    await paste(page, imgs(1));
    await settled(page);
    await cmd(page).fill('Lỗi này từ đâu ra?');
    await expect(tray(page).locator('.ich img.th')).toHaveCount(1);
    await shot(page, 'DK1');
  });
  for (const narrow of [false, true]) {
    test(`DK2 3 images + xlsx + md (long name cut in the middle) + docx on 2 rows${narrow ? ' (1024 × 640)' : ''}`, async ({ page }) => {
      if (narrow) await page.setViewportSize({ width: 1024, height: 640 });
      await open(page, { ...DKO, narrow });
      if (narrow) await page.locator('.react-flow__node[data-id^="orch:"]').first().click(); // the drawer opens on the root
      await expect(chip(page)).toBeVisible();
      await dk2(page);
      await expect(tray(page).locator('.fch .nm').nth(1)).toHaveText(/^2026-.*….*design\.md$/); // §6.2 cut in the middle, tail kept
      await expect(tray(page).locator('.fch .s').first()).toHaveText('48 KB');
      await shot(page, narrow ? 'DK2-1024' : 'DK2');
    });
  }
  test('DK2b 2 chip rows + a 3-line question: the text stops at 3 lines, the conversation keeps its room', async ({ page }) => {
    await open(page, DKO);
    await dk2(page);
    await cmd(page).fill('So sánh 3 ảnh chụp màn hình này với bảng doanh thu tháng 10, xem số nào lệch, rồi đối chiếu với spec v2.4 và báo cáo gửi sếp. Nếu lệch quá 5 % thì ghi rõ dòng nào trong file xlsx và đề xuất cách sửa cho D2.');
    const m = await cmd(page).evaluate(e => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) }));
    expect(Math.abs(m.h - 3 * m.lh)).toBeLessThan(1); // §6.2 exactly 3 whole lines with chips, no cut half line (DK2b)
    await shot(page, 'DK2b');
  });
  test('P3 1024 × 640, 2 chip rows + the DK2b 3-line text: the composer stays ≥ 48 px below the Điều phối stat line (§6.2)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await open(page, { ...DKO, narrow: true });
    await page.locator('.react-flow__node[data-id^="orch:"]').first().click(); // the drawer opens on the root
    await expect(chip(page)).toBeVisible();
    await dk2(page);
    await cmd(page).fill('So sánh 3 ảnh chụp màn hình này với bảng doanh thu tháng 10, xem số nào lệch, rồi đối chiếu với spec v2.4 và báo cáo gửi sếp. Nếu lệch quá 5 % thì ghi rõ dòng nào trong file xlsx và đề xuất cách sửa cho D2.');
    await page.waitForTimeout(300); // the column fit settles
    const meta = (await ins(page).locator('.ohead .meta').boundingBox())!, comp = (await ins(page).locator('.inrow').boundingBox())!;
    expect(comp.y - (meta.y + meta.height), `composer ${comp.y} vs stat line bottom ${meta.y + meta.height}`).toBeGreaterThanOrEqual(48);
  });
  for (const narrow of [false, true]) {
    test(`DK3 files dragged over the window: dark layer, lit composer, "Thả để đính kèm cho Điều phối"${narrow ? ' (1024 × 640)' : ''}`, async ({ page }) => {
      if (narrow) await page.setViewportSize({ width: 1024, height: 640 });
      await open(page, { ...DKO, toasts: true, narrow });
      await dragOver(page); // narrow: the drawer stays closed, the whole window dims (§6.1 the label names the target)
      await expect(ins(page).locator('.inrow.drop')).toHaveCount(1);
      await expect(page.locator('#toasts .toast.drop')).toHaveText('Thả để đính kèm cho Điều phối');
      await shot(page, narrow ? 'DK3-1024' : 'DK3');
    });
  }
  test('DK4 a pasted image uploading (spinner + ×, send locked); the Finder xlsx has no spinner', async ({ page }) => {
    await open(page, { ...DKO, attach: { path: FILES, upload: () => 'hang' } });
    await paste(page, imgs(1, 2));
    await nativeDrop(page, [PATH.xlsx]);
    await cmd(page).fill('Lỗi này từ đâu ra? Số liệu ở file kèm.');
    await expect(tray(page).locator('.ich .sp')).toBeVisible();
    await expect(tray(page).locator('.fch .s')).toHaveText('48 KB');
    await expect(sendBtn(page)).toHaveAttribute('aria-disabled', 'true');
    await shot(page, 'DK4');
  });
  test('DK5 error chips (image over 20 MB · a folder · a blocked path), send locked with "Bỏ file lỗi để gửi" showing, the text kept', async ({ page }) => {
    await open(page, DKO);
    await drop(page, [{ name: 'ảnh-143015.png', img: { hue: 210 }, size: 21 * 1024 * KB }]);
    await nativeDrop(page, [PATH.dir, PATH.db]);
    await expect(tray(page).locator('.fch.bad .s')).toHaveText(['Quá 20 MB', 'Không nhận thư mục', 'Nằm trong vùng cc-slaves bảo vệ']);
    await cmd(page).fill('Xem giúp mấy cái này.');
    await sendBtn(page).hover();
    await expect(sendBtn(page)).toHaveAttribute('data-tip', 'Bỏ file lỗi để gửi');
    await shot(page, 'DK5', true); // the tip shows on hover: no mouse move
  });
  test('DK5b a failed upload: "Không tải lên được" + "Thử lại" in the chip', async ({ page }) => {
    await open(page, { ...DKO, attach: { path: FILES, upload: n => (n === 'ghi-chú.md' ? 'fail' : 'ok') } });
    await drop(page, [{ name: 'ghi-chú.md', size: 2 * KB, type: 'text/markdown' }]);
    await nativeDrop(page, [PATH.xlsx]);
    await expect(tray(page).locator('.fch.bad .s')).toHaveText('Không tải lên đượcThử lại');
    await expect(tray(page).locator('.fch.bad').getByRole('button', { name: 'Thử lại' })).toBeVisible();
    await cmd(page).fill('Ghi chú hôm qua đây.');
    await shot(page, 'DK5b');
  });
  test('DK6 25 files dropped: 20 chips (scrolled to the newest) + "Mỗi tin tối đa 20 file. Đã bỏ 5 file cuối."', async ({ page }) => {
    await open(page, DKO);
    await drop(page, imgs(25).map((f, i) => ({ ...f, name: `chup-${i + 1}.png` })));
    await expect(tray(page).locator('.ich')).toHaveCount(20);
    await settled(page);
    await expect(ins(page).locator('.aline')).toHaveText('Mỗi tin tối đa 20 file. Đã bỏ 5 file cuối.');
    await expect(tray(page)).toHaveClass(/\bsc\b/);
    await shot(page, 'DK6');
  });
  test('DK7 sent messages: text + labels (image, long name cut in the middle, copy); one "đã gửi vào lượt đang chạy"', async ({ page }) => {
    await open(page, { f: 'DKM' });
    const po = ins(page).locator('.m-po', { hasText: 'Lỗi này từ đâu ra?' });
    await expect(po.locator('.m-lb')).toHaveCount(3);
    await expect(po.locator('.m-lb').first()).toHaveText('ảnh · ảnh-142233.png');
    await expect(po.locator('.m-lb').nth(1)).toContainText('…');
    await expect(ins(page).locator('.m-po', { hasText: 'Ghi chú hôm qua đây.' }).locator('.m-lb')).toHaveText('ghi-chú.md · bản sao');
    await expect(ins(page).locator('.m-po', { hasText: 'Còn màn này nữa.' })).toContainText('đã gửi vào lượt đang chạy');
    await po.scrollIntoViewIfNeeded();
    await shot(page, 'DK7');
  });
  test('DK8 a "bản sao" chip hovered: the note above the strip', async ({ page }) => {
    await open(page, DKO);
    await drop(page, [{ name: 'ghi-chú.md', size: 2 * KB, type: 'text/markdown' }]);
    const c = tray(page).locator('.fch');
    await expect(c.locator('.tag')).toHaveText('bản sao');
    await c.hover();
    await expect(c).toHaveAttribute('data-tip', /^Đây là bản sao tạm/);
    await shot(page, 'DK8', true); // the note shows on hover: no mouse move
  });
  test('DK10 the target is lane D2: composer + chip; the drop label "… cho D2"', async ({ page }) => {
    await open(page, { ...DKO, toasts: true });
    await page.locator('.react-flow__node[data-id="lane:D2"]').click();
    await expect(ins(page).locator('.cbar .target')).toHaveText('D2');
    await paste(page, imgs(1));
    await settled(page);
    await dragOver(page);
    await expect(page.locator('#toasts .toast.drop')).toHaveText('Thả để đính kèm cho D2');
    await shot(page, 'DK10');
  });
  test('DK11 composer locked (offline): a drop → toast "Mất kết nối · chưa đính kèm được", no chip', async ({ page }) => {
    const ctl = await open(page, { ...DKO, toasts: true });
    ctl.drop();
    await expect(cmd(page)).toBeDisabled();
    await drop(page, [{ name: 'doanh-thu.xlsx', size: 48 * KB }]);
    await expect(page.locator('#toasts')).toContainText('Mất kết nối · chưa đính kèm được');
    await expect(tray(page)).toHaveCount(0);
    await shot(page, 'DK11');
  });
  test('DK12 a file gone when the message was written: the engine line "Không gửi được …: file không còn trên máy."', async ({ page }) => {
    await open(page, { f: 'DKM' });
    const line = ins(page).locator('.m-evt', { hasText: 'Không gửi được doanh-thu.xlsx: file không còn trên máy.' });
    await line.scrollIntoViewIfNeeded();
    await expect(line).toBeVisible();
    await shot(page, 'DK12');
  });
  test('DK13 plain browser: every dropped file is a "bản sao"', async ({ page }) => {
    await open(page, { attach: {} });
    await drop(page, [{ name: 'doanh-thu.xlsx', size: 48 * KB }, { name: 'ghi-chú.md', size: 2 * KB, type: 'text/markdown' }, { name: 'báo-cáo.docx', size: 31 * KB }]);
    await expect(tray(page).locator('.fch .tag')).toHaveText(['bản sao', 'bản sao', 'bản sao']);
    await settled(page);
    await shot(page, 'DK13');
  });
  test('DK14 `/compact` with a chip → the red line "Lệnh /compact không nhận file đính kèm", send locked', async ({ page }) => {
    await open(page, DKO);
    await paste(page, imgs(1));
    await settled(page);
    await cmd(page).fill('/compact');
    await expect(ins(page).locator('.aline.bad')).toHaveText('Lệnh /compact không nhận file đính kèm');
    await expect(sendBtn(page)).toHaveAttribute('aria-disabled', 'true');
    await shot(page, 'DK14');
  });
  test('DK15 chips only, no text: send works as usual', async ({ page }) => {
    await open(page, DKO);
    await paste(page, imgs(2));
    await settled(page);
    await expect(cmd(page)).toHaveValue('');
    await expect(sendBtn(page)).not.toHaveAttribute('aria-disabled');
    await shot(page, 'DK15');
  });
});

// =====================================================================================================================
// CP frames (§6.7 D52 Chờ PO as rows + the detail box): the mock's DKC deck (one open card per kind, web/dev/scenarios.ts
// cpCards) — B2's "bun run lint --fix" stands where the mockup draws B3's; its ✓ puts it in the 5 s undo as the mockup's third row.
test.describe('CP', () => {
  const rows = (page: Page) => page.locator('#inbox .card');
  const rowOf = (page: Page, t: string) => rows(page).filter({ hasText: t });
  const box = (page: Page) => page.locator('#cardbox');
  async function cp(page: Page, o: Open = {}): Promise<void> {
    await open(page, { f: 'DKC', cards: null, ...o });
    if (o.narrow) await page.locator('#inboxBtn').click();
    await rowOf(page, 'bun run lint --fix').getByRole('button', { name: 'Cho phép', exact: true }).click();
    await expect(rowOf(page, 'Đã chọn')).toContainText('gửi sau');
    await page.locator('#inbox .cards').evaluate(e => { e.scrollTop = 0; }); // the click scrolled B2's row into view (1024 × 640)
  }
  test('CP1 rows: permission ✓ ✕, ask ›, one row in its undo, broken 📄 ↻, Điều phối ↻, MCP / logged out ⇥', async ({ page }) => {
    await cp(page);
    await expect(rows(page).first()).toContainText('rm -rf build/');
    await expect(page.locator('#inbox')).toContainText('Hoàn tác');
    await shot(page, 'CP1');
  });
  test('R43 I2 a full Chờ PO keeps the 16 px fade band under its rows', async ({ page }) => {
    await open(page, { f: 'DKC', cards: 30 });
    const cards = page.locator('#inbox .cards');
    await expect(cards).toHaveClass(/gscroll/);
    // --s6: 16 px until hf1116 W4 (one step roomier), now 18 px — still inside the 20 px .gfade band
    expect(await cards.evaluate(e => getComputedStyle(e).paddingBottom)).toBe('18px');
  });
  test('R43 M1 offline, the detail box says why it is read only', async ({ page }) => {
    const ctl = await open(page, { f: 'DKC', cards: null });
    ctl.drop();
    await expect(page.locator('body.offline')).toHaveCount(1);
    await rowOf(page, 'rm -rf build/').click({ position: { x: 120, y: 15 } });
    await expect(box(page).locator('.mro')).toHaveText('Mất kết nối — chỉ đọc');
  });
  test('CP2 the ask box: question, full context, options ⌥1 / ⌥2 with "Đề xuất", "Khác…"', async ({ page }) => {
    await cp(page);
    await rowOf(page, 'Giữ API cũ hay tách module mới?').click();
    await expect(box(page)).toContainText('Đề xuất');
    await expect(box(page)).toContainText('Khác…');
    await shot(page, 'CP2');
  });
  test('CP2b the permission box: command, Cho phép ⌥1 · Cho phép luôn ⌥2 · Từ chối ⌥3, reason field', async ({ page }) => {
    await cp(page);
    await rowOf(page, 'rm -rf build/').click({ position: { x: 120, y: 15 } });
    await expect(box(page)).toContainText('Cho phép luôn trong phiên này');
    await shot(page, 'CP2b');
  });
  test('CP3 hover on a row icon: the "Cho phép ⌥1" tooltip', async ({ page }) => {
    await cp(page);
    await rowOf(page, 'rm -rf build/').getByRole('button', { name: 'Cho phép', exact: true }).hover();
    await page.waitForTimeout(600);
    await shot(page, 'CP3', true);
  });
  test('CP4 nothing waiting: "Không có việc chờ PO" + "Đã xử lý 3"', async ({ page }) => {
    await open(page, { f: 'DKC', cards: null, wire: { snap: s => {
      s.cards = s.cards.slice(0, 3).map(c => ({ ...c, status: 'answered' as const, resolvedAt: Date.now() - 60_000, answer: c.kind === 'permission' ? { behavior: 'allow' as const } : { option: 'Tách' } }));
      if (s.orchestrators[0]) { s.orchestrators[0].state = 'idle'; s.orchestrators[0].talkingTo = null; }
    } } });
    await expect(page.locator('#inbox')).toContainText('Không có việc chờ PO');
    await shot(page, 'CP4');
  });
  test('CP5 1024 × 640: the drawer, Chờ PO ≤ 30 % and scrolling, Đang xem under it', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await cp(page, { narrow: true });
    await expect(rows(page).first()).toBeVisible();
    await shot(page, 'CP5');
  });
  test('CP6 remote: Mac-only row buttons are 🔒; the MCP box says "Đăng nhập trên Mac"', async ({ page }) => {
    await cp(page, { remote: true });
    await rowOf(page, 'github').click({ position: { x: 120, y: 15 } });
    await expect(box(page)).toContainText('Đăng nhập trên Mac');
    await shot(page, 'CP6');
  });
  test('§6.7 the box opened by the first click after load: focused, no focus ring on the box itself', async ({ page }) => {
    await open(page, { f: 'DKC', cards: null });
    await rowOf(page, 'github').click({ position: { x: 120, y: 15 } });
    await expect(box(page).locator('.cpm')).toBeFocused();
    await expect(box(page).locator('.cpm')).toHaveCSS('box-shadow', 'none'); // the focused box container shows no ring
  });
});

// =====================================================================================================================
// LM frames (§4.5 D55 lane model): lane D2 of the DK5 deck (Opus 5.5 · medium, web/dev/mock-model.ts) in Đang xem; Settings ›
// Model reads the mock's list (tier 4 = Fable 5.2 · high) and `config.modelDefaults` patched on the socket.
test.describe('LM', () => {
  const d2 = (page: Page) => page.locator('.react-flow__node[data-id="lane:D2"]').click();
  test('LM1 a running lane: the chip under its name', async ({ page }) => {
    await open(page, { cards: null });
    await d2(page);
    await expect(chip(page)).toHaveText('Opus 5.5 · medium▾');
    // R43 M4 the account / tok line is one line, no "(vào · ra · cache)" split (it lives in the node tooltip)
    const meta = ins(page).locator('.lhead .meta.acc');
    await expect(meta).toContainText('tok');
    await expect(meta).not.toContainText('vào');
    const m = await meta.evaluate(e => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight), pad: parseFloat(getComputedStyle(e).paddingTop) + parseFloat(getComputedStyle(e).paddingBottom) }));
    expect(m.h - m.pad).toBeLessThan(m.lh * 1.5);
    expect(await meta.getAttribute('title')).toContain('tok');
    const longH = await meta.evaluate(e => { const t = e.textContent; e.textContent = `${t} · ${t}`; const h = e.getBoundingClientRect().height; e.textContent = t; return h; });
    expect(longH, 'a longer line ellipsises, never wraps').toBeCloseTo(m.h, 0);
    await shot(page, 'LM1');
  });
  test('LM2 a change waiting for the lane\'s turn: chip "→ Sonnet 5.5 · chờ hết lượt", picker open', async ({ page }) => {
    await open(page, { cards: null, wire: { snap: s => { const l = s.lanes.find(x => x.name === 'D2'); if (l) { l.state = 'running'; l.pending = { model: 'sonnet', modelName: 'Sonnet 5.5' }; } } } });
    await d2(page);
    await expect(chip(page)).toContainText('Sonnet 5.5 · chờ hết lượt');
    await picker(page);
    await expect(menu(page)).toContainText('Model và effort · D2');
    await expect(menu(page).getByRole('button', { name: 'Bỏ thay đổi đang chờ' })).toBeVisible();
    await shot(page, 'LM2');
  });
  test('LM3 Cài đặt › Model: Điều phối "Theo Claude Code", Lane Opus 5.5 · medium', async ({ page }) => {
    await open(page, { cards: null, wire: { snap: s => { (s.config as { modelDefaults?: unknown }).modelDefaults = { orchestrator: { model: null, effort: null }, lane: { model: 'opus', effort: 'medium' } }; } } });
    await page.locator('#top').getByRole('button', { name: /Cài đặt/ }).click();
    await page.getByRole('tab', { name: 'Model' }).click();
    await expect(page.getByRole('dialog')).toContainText('Model mặc định');
    await expect(page.getByRole('dialog')).toContainText('Theo Claude Code');
    await shot(page, 'LM3');
  });
  test('LM4 remote: the lane chip is text + 🔒', async ({ page }) => {
    await open(page, { cards: null, remote: true });
    await d2(page);
    await expect(ins(page).locator('span.mchip.ro')).toHaveText('Opus 5.5 · medium');
    await expect(ins(page).locator('button.mchip')).toHaveCount(0);
    await shot(page, 'LM4');
  });
});
