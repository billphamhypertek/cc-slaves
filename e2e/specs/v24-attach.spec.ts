// v2.4 §13 E2E "dán ảnh → chip → gửi → nhãn trong hội thoại" on the real engine with fake-claude (temp homes,
// CC_SLAVES_ATTACH = <dir>/attach): a pasted image uploads at once (§6.3) and shows its thumbnail; a Finder drop (the Mac
// app's native drop, stubbed `window.__TAURI__`) stays a path checked by `POST /attach/path`; the send writes ONE user line
// (§6.4: the text block with the path list, then the image block) and the conversation shows one `po` line with its labels
// (§6.3 DK7). A path inside the cc-slaves home is a red chip that locks send (§6.2 / §10.2 A9); "×" during the upload drops
// the engine copy (§6.5); `/compact` with a chip is refused in the composer (§6.6 DK14). §8: the remote channel (dev mock
// `remote=1`) has no paste / drop / chip at all.
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, ORCH, S, test, useEngine } from '../fixtures.ts';
import { useDev } from '../deck.ts';
import { dragOver, drop, nativeDrop, paste, stubTauri } from '../v24-attach-io.ts';

const eng = useEngine({ scenarios: { [ORCH]: { steps: [...S.turn('Sẵn sàng'), ...S.idle()] } } });
test.describe.configure({ mode: 'serial' }); // one orchestrator, one stdin log

const ins = (page: Page) => page.locator('#inspector');
const input = (page: Page) => page.getByLabel('Ô lệnh');
const tray = (page: Page) => ins(page).locator('.tray');
const send = (page: Page) => ins(page).locator('.cbar .send');
type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
/** Every `user` line fake-claude got on stdin whose text block contains `needle`. */
const stdinUser = (needle: string): Block[][] => eng.read(`stdin-${ORCH}.log`).split('\n').filter(Boolean)
  .map(l => JSON.parse(l) as { type: string; message?: { content: string | Block[] } })
  .filter(o => o.type === 'user')
  .map(o => (typeof o.message!.content === 'string' ? [{ type: 'text', text: o.message!.content }] : o.message!.content))
  .filter(c => c.some(b => b.type === 'text' && b.text!.includes(needle)));
const attachDirs = () => { try { return readdirSync(eng.file('attach')); } catch { return []; } };

let projectAdded = false;
async function open(page: Page): Promise<void> {
  if (!projectAdded) { await eng.addProject('att'); projectAdded = true; }
  await stubTauri(page);
  await page.goto(eng.url());
  await page.locator('#top .tab', { hasText: 'att' }).click();
  await expect(input(page)).toBeEnabled();
  await input(page).focus();
}

test('§6.1–§6.4 paste an image + drop a file by path → chips → send: one po line with labels; stdin = text + path list, then the image block', async ({ page }) => {
  mkdirSync(eng.file('docs'), { recursive: true });
  const md = eng.file('docs/ghi-chu.md');
  writeFileSync(md, '# ghi chú\n');
  await open(page);
  await paste(page, [{ name: 'image.png', img: { hue: 210 } }]);
  const img = tray(page).locator('.ich');
  await expect(img.locator('img.th')).toHaveAttribute('src', /^blob:/); // §6.2 the thumbnail is a blob: URL
  await expect(img.locator('.sp')).toHaveCount(0); // uploaded (§6.3)
  const pasted = (await img.getAttribute('title'))!.split(' · ')[0]!;
  expect(pasted).toMatch(/^ảnh-\d{6}\.png$/); // §6.3 an unnamed paste is "ảnh-HHMMSS.png"
  await nativeDrop(page, [md]);
  await expect(tray(page).locator('.fch')).toHaveAttribute('title', 'ghi-chu.md');
  await expect(tray(page).locator('.fch .tag')).toHaveCount(0); // a Finder path is the original, not "bản sao"
  await expect(input(page)).toBeFocused(); // T2: the composer takes the caret after a drop
  await input(page).fill('Lỗi này từ đâu ra?');
  await expect(send(page)).not.toHaveAttribute('aria-disabled');
  await input(page).press('Enter');
  await expect(tray(page)).toHaveCount(0); // §6.3 sent → no chip left
  const po = ins(page).locator('.m-po', { hasText: 'Lỗi này từ đâu ra?' });
  await expect(po.locator('.m-lb')).toHaveText([`ảnh · ${pasted}`, 'ghi-chu.md']);
  await expect.poll(() => stdinUser('Lỗi này từ đâu ra?').length).toBe(1);
  const [text, image, ...rest] = stdinUser('Lỗi này từ đâu ra?')[0]!;
  // v2.7 §5.1 (R-B21): the pasted image's copy is named first (issue_file takes it), then the file; both by their realpath (A9)
  const [head, copyLine, fileLine, ...more] = text!.text!.split('\n- ');
  expect(head).toBe('[PO] Lỗi này từ đâu ra?\n\nFile PO đính kèm (đường dẫn trên máy này):');
  const id = copyLine!.slice(realpathSync(eng.file('attach')).length + 1).split('/')[0]!;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(copyLine).toBe(`${realpathSync(eng.file('attach'))}/${id}/${pasted} (ảnh, bản sao tạm)`);
  expect([fileLine, ...more]).toEqual([realpathSync(md)]);
  expect(image).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
  expect(Buffer.from(image!.source!.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
  expect(rest).toEqual([]);
  await page.waitForTimeout(500); // the replay came back (fake-claude replays at once): still one po line (§10.2 echoed)
  await expect(po).toHaveCount(1);
});

test('§6.2 / §10.2 A9 a dropped path inside the cc-slaves home → red chip, send locked (Enter sends nothing); × → sends', async ({ page }) => {
  await open(page);
  await nativeDrop(page, [eng.file('home/state.db')]);
  const chip = tray(page).locator('.fch.bad');
  await expect(chip.locator('.s')).toHaveText('Nằm trong vùng cc-slaves bảo vệ');
  await input(page).fill('đọc state giúp');
  await expect(send(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(send(page)).toHaveAttribute('data-tip', 'Bỏ file lỗi để gửi');
  await input(page).press('Enter');
  await send(page).click({ force: true }); // aria-disabled: Playwright would wait for it
  await page.waitForTimeout(500);
  expect(stdinUser('đọc state giúp')).toEqual([]);
  await expect(input(page)).toHaveValue('đọc state giúp'); // §6.2 the text stays
  await chip.getByRole('button', { name: 'state.db, bỏ' }).click();
  await input(page).press('Enter');
  await expect.poll(() => stdinUser('đọc state giúp').length).toBe(1);
  expect(stdinUser('đọc state giúp')[0]).toEqual([{ type: 'text', text: '[PO] đọc state giúp' }]);
});

test('§6.3 / §6.5 × during the upload: the chip goes, the engine copy is deleted, the message goes without it', async ({ page }) => {
  await open(page);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  await page.route(u => u.pathname === '/attach', async (route) => { await gate; await route.continue(); });
  const before = attachDirs().length;
  await paste(page, [{ name: 'image.png', img: { hue: 30 } }]);
  const chip = tray(page).locator('.ich');
  await expect(chip.locator('.sp')).toBeVisible(); // §6.3 DK4 the spinner while it uploads …
  await expect(send(page)).toHaveAttribute('data-tip', 'Đang tải lên…'); // … and send locked
  await chip.getByRole('button', { name: /^ảnh-\d{6}\.png, bỏ$/ }).click();
  await expect(tray(page)).toHaveCount(0);
  const del = page.waitForResponse(r => r.request().method() === 'DELETE' && new URL(r.url()).pathname.startsWith('/attach/'));
  release();
  expect((await del).status()).toBe(204); // the upload landed after "×": its copy is deleted at once
  await expect.poll(attachDirs).toHaveLength(before);
  await input(page).fill('bỏ ảnh rồi');
  await input(page).press('Enter');
  await expect.poll(() => stdinUser('bỏ ảnh rồi').length).toBe(1);
  expect(stdinUser('bỏ ảnh rồi')[0]!.map(b => b.type)).toEqual(['text']);
});

test('§6.6 DK14 `/compact` with a chip → the red line, send locked, nothing written; chips + text stay', async ({ page }) => {
  await open(page);
  await paste(page, [{ name: 'image.png', img: { hue: 120 } }]);
  await expect(tray(page).locator('.ich .sp')).toHaveCount(0);
  await input(page).fill('/compact');
  await expect(ins(page).locator('.aline.bad')).toHaveText('Lệnh /compact không nhận file đính kèm');
  await expect(send(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(ins(page).locator('.slash')).toHaveCount(0); // the red line explains instead of the / popup
  await input(page).press('Enter');
  await page.waitForTimeout(500);
  expect(eng.read(`stdin-${ORCH}.log`)).not.toContain('/compact');
  await expect(tray(page).locator('.ich')).toHaveCount(1);
  await expect(input(page)).toHaveValue('/compact');
});

test.describe('§8 remote channel', () => {
  const dev = useDev();
  test('no attach affordance: paste / drop / drag-over make no chip, no drop label', async ({ page }) => {
    await page.goto(dev.url('DK5', 'remote=1'));
    await expect(input(page)).toBeEnabled();
    await input(page).focus();
    await paste(page, [{ name: 'image.png', img: { hue: 10 } }]);
    await drop(page, [{ name: 'doanh-thu.xlsx', size: 48 * 1024 }]);
    await dragOver(page);
    await page.waitForTimeout(500);
    await expect(tray(page)).toHaveCount(0);
    await expect(ins(page).locator('.inrow.drop')).toHaveCount(0);
    await expect(page.locator('#toasts .toast.drop')).toHaveCount(0);
  });
});
