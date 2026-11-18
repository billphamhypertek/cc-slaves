// v2.3 §14 "So với mockup": every frame of docs/specs/assets/screens/v23-mockup/ (D0, C1–C29, G1–G16) driven into its
// state on the real web app over the dev mock engine (web/dev: code-fs.ts + mock-git.ts carry the mockup's one mock set —
// hagenta, D15 Chờ PO with a conflict on lanes.ts, D2 running and merging clean, a41c09e on main) and saved as
// docs/specs/assets/screens/v23-<frame>.png at the mockup's window (1440 × 900; C17 / G15 1024 × 640). What the mock
// cannot hold still or lacks is patched on the page's socket (e2e/v23-shots-seed.ts). Each frame asserts its key text, so
// a shot cannot silently show the wrong state; looks are judged by the independent UX review against the mockup PNG.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Command } from '../../shared/protocol.ts';
import { expect, test } from '../fixtures.ts';
import { hideDevToasts, openDeck, useDev } from '../deck.ts';
import { node } from '../v21-seed.ts';
import { cityGame, cityReply, lot2, lot2Reply, wire, type Wire, type WireCtl } from '../v23-shots-seed.ts';

const DIR = join(import.meta.dirname, '../../docs/specs/assets/screens');
const dev = useDev();
test.describe.configure({ mode: 'parallel' });
test.use({ screenshot: 'only-on-failure' });

// ---------- the mockup's tab sets (§14 rev 4) ----------
const P_MD = 'docs/specs/2026-11-16-auth-design.md', P_AUTH = 'engine/src/auth.ts';
type Set = { tabs: [string, boolean][]; active: string | null };
const D15_SET = (active = P_AUTH): Set => ({ tabs: [[P_MD, true], [P_AUTH, false], ['engine/src/lanes.ts', false]], active });
const BASE_SET = (pv?: string, active = pv ?? P_AUTH): Set => ({ tabs: [[P_AUTH, false], ['engine/src/config.ts', false], ['docs/HANDOFF.md', false], ...(pv ? [[pv, true] as [string, boolean]] : [])], active });
const MANY: Set = { tabs: ['CLAUDE.md', 'README.md', 'docs/HANDOFF.md', 'engine/src/config.ts', 'engine/test/auth.ts', P_AUTH, 'engine/src/lot2/index.ts', 'web/src/index.ts', 'engine/src/store.ts', 'engine/src/lanes.ts', 'package.json'].map(p => [p, false]), active: P_AUTH };

interface Open { g?: string; en?: boolean; narrow?: boolean; sel?: string; tabs?: Record<string, Set>; key?: 'c' | 'g'; wire?: Wire }
async function open(page: Page, o: Open): Promise<WireCtl> {
  if (o.narrow) await page.setViewportSize({ width: 1024, height: 640 });
  const ctl = await wire(page, o.wire ?? {});
  if (o.tabs) await page.addInitScript((v) => localStorage.setItem('ccs.code.tabs', v), JSON.stringify({ hagenta: o.tabs }));
  await openDeck(page, dev.url('F3', [`g=${o.g ?? 'G1'}`, o.en ? 'lang=en' : ''].filter(Boolean).join('&')));
  await hideDevToasts(page);
  await page.addStyleTag({ content: '#reloadBand{display:none!important}' }); // the mock speaks protocol 1: its "vừa cập nhật" band
  if (o.sel) await node(page, o.sel).locator('button.hit').click();
  if (o.key) await page.keyboard.press(o.key);
  const drawer = page.getByRole('button', { name: 'Đóng ngăn' }); // narrow: the node click opened the left-column drawer
  if (o.narrow && await drawer.isVisible()) await drawer.click();
  return ctl;
}
async function shot(page: Page, frame: string): Promise<void> {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `v23-${frame}.png`) });
}

const cv = (page: Page) => page.locator('#codeview');
const gv = (page: Page) => page.locator('#gitview');
const path = (page: Page) => cv(page).locator('.cvh .pth');
const tabs = (page: Page) => cv(page).locator('.ctabs [role=tab]');
const editBtn = (page: Page, name = 'Sửa') => cv(page).getByRole('button', { name, exact: true });
const lock = (page: Page) => expect(editBtn(page)).toHaveAttribute('aria-disabled', 'true');
/** §5.1 I1 the tree opened itself down to the shown file (no clicks: restored tabs, a source switch, a reopen). */
const treeShows = (page: Page, file: string) => expect(cv(page).locator(`.ctree [data-path="${file}"]`)).toBeVisible();
/** I2 no dead band: the top bar stays at the top of the window while offline on Deck / Code / Git */
const topAtZero = async (page: Page) => expect((await page.locator('#top').boundingBox())!.y).toBe(0);
/** Double-click `word` on line `line` (1-based) of the viewer: CodeMirror selects it (read mode keeps the selection). */
async function pickWord(page: Page, line: number, word: string): Promise<void> {
  const box = await cv(page).locator('.cm-line').nth(line - 1).evaluate((el, w) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.textContent!.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length);
      const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  }, word);
  expect(box, `"${word}" on line ${line}`).not.toBeNull();
  await page.mouse.dblclick(box!.x, box!.y);
}
/** C6: in the project folder (orchestrator idle) fix "flase" on line 4 of auth.ts: Sửa keeps the selection, type, unsaved. */
async function editAuth(page: Page): Promise<void> {
  await expect(path(page)).toHaveText(P_AUTH);
  await pickWord(page, 4, 'flase');
  await editBtn(page).click();
  await expect(cv(page).locator('.cvh .edp')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#codeview .cm-editor'))).toBe(true); // "Sửa" → focus in the text
  await page.keyboard.type('false');
  await expect(tabs(page).filter({ hasText: 'auth.ts' }).locator('button.x.dt')).toBeVisible();
}
const BASE_EDIT: Open = { sel: 'orch:hagenta', key: 'c', tabs: { base: BASE_SET() } };
const writeTo = (code: 'conflict' | 'gone'): Wire => ({
  reply: (c: Command) => {
    if (c.cmd !== 'fs_write' || c.recreate) return undefined;
    if (code === 'gone') return { ok: { ok: false, code: 'gone' } };
    const disk = c.text.replace('đều trả false.', 'đều trả flase.').replace('if (!tok) return false', 'if (!tok) return null');
    return { ok: { ok: false, code: 'conflict', disk: { kind: 'text', text: disk, size: disk.length, hash: 'disk2', eol: 'lf', bom: false } } };
  },
});

// =====================================================================================================================
test('D0 the Deck with the Deck · Code · Git switch', async ({ page }) => {
  await open(page, {});
  const sw = page.getByRole('tablist', { name: 'Chế độ' });
  await expect(sw.getByRole('tab', { name: /Deck/, selected: true })).toBeVisible();
  await expect(sw.getByRole('tab', { name: /Code/ })).toBeVisible();
  await expect(sw.getByRole('tab', { name: /Git/ })).toBeVisible();
  await shot(page, 'D0');
});

test.describe('Code', () => {
  test('C1 D15 worktree, auth.ts, "Sửa" locked by the live lane', async ({ page }) => {
    await open(page, { sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET() } });
    await expect(cv(page).locator('.csrcw')).toContainText('D15 · worktree');
    await expect(path(page)).toHaveText(P_AUTH);
    await expect(tabs(page)).toHaveCount(3);
    await expect(tabs(page).first()).toHaveClass(/\bpv\b/);
    await lock(page);
    await expect(editBtn(page)).toHaveAttribute('title', /D15 còn phiên sống/);
    await shot(page, 'C1');
  });
  test('C2 project folder, orchestrator idle: "Sửa" open', async ({ page }) => {
    await open(page, BASE_EDIT);
    await expect(cv(page).locator('.csrcw')).toContainText('thư mục project');
    await expect(path(page)).toHaveText(P_AUTH);
    await expect(editBtn(page)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(cv(page).locator('.cign')).toHaveAttribute('aria-pressed', 'false');
    await shot(page, 'C2');
  });
  test('C3 the lane spec in "Đọc" (markdown + outline) in the preview tab', async ({ page }) => {
    await open(page, { sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET(P_MD) } });
    await expect(cv(page).getByRole('button', { name: 'Đọc', pressed: true })).toBeVisible();
    await expect(cv(page).locator('h1')).toHaveText('Auth: token rỗng và khoá xoay vòng');
    await expect(tabs(page).first()).toHaveClass(/\bpv\b/);
    await shot(page, 'C3');
  });
  test('C4 the same spec in "Nguồn"', async ({ page }) => {
    await open(page, { sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET(P_MD) } });
    await cv(page).getByRole('button', { name: 'Nguồn' }).click();
    await expect(cv(page).getByRole('button', { name: 'Nguồn', pressed: true })).toBeVisible();
    await expect(cv(page).locator('.cm-content')).toContainText('# Auth: token rỗng và khoá xoay vòng');
    await shot(page, 'C4');
  });
  test('C5 ⌘P from the Deck finds by name in the D15 worktree', async ({ page }) => {
    await open(page, { sel: 'lane:D15' });
    await page.keyboard.press('Meta+p');
    const find = page.getByRole('dialog', { name: 'Tìm file' });
    await find.getByRole('textbox').fill('auth');
    await expect(find.getByRole('option').filter({ hasText: '2026-11-16-auth-design.md' })).toHaveCount(1);
    await expect(find).toContainText('Đang tìm trong worktree D15');
    await shot(page, 'C5');
  });
  test('C6 editing in the project folder: "Lưu ⌘S" · "Huỷ", foot "Đang sửa · chưa lưu"', async ({ page }) => {
    await open(page, BASE_EDIT);
    await editAuth(page);
    await expect(cv(page).locator('.cvh .edp')).toHaveText('Đang sửa');
    await expect(cv(page).locator('.vf')).toContainText('Đang sửa · chưa lưu · Esc để thoát');
    await shot(page, 'C6');
  });
  test('C7 save while the disk changed (baseHash): the two-column dialog, no auto merge', async ({ page }) => {
    await open(page, { ...BASE_EDIT, wire: writeTo('conflict') });
    await editAuth(page);
    await page.keyboard.press('Meta+s');
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('File đã đổi trên đĩa trong lúc anh sửa');
    await expect(dlg).toContainText('Trên đĩa (mới)');
    await expect(dlg).toContainText('Không tự gộp — chọn một bản.');
    await shot(page, 'C7');
  });
  test('C8 D2 running in its worktree: "Sửa" greyed → the reason + "Nhắn D2…"', async ({ page }) => {
    await open(page, { sel: 'lane:D2', key: 'c', tabs: { 'lane:D2': { tabs: [['engine/src/lot2/parser.ts', false], ['engine/test/parser.test.ts', false]], active: 'engine/src/lot2/parser.ts' } },
      wire: { reply: lot2Reply, patch: lot2 } });
    await expect(cv(page).locator('.csrcw')).toContainText('D2 · worktree');
    await expect(path(page)).toHaveText('engine/src/lot2/parser.ts');
    await editBtn(page).click({ force: true }); // aria-disabled: the click still shows why (§5.3 V2)
    await expect(cv(page).locator('.vf')).toContainText('D2 còn phiên sống trong thư mục này');
    await expect(cv(page).getByRole('button', { name: 'Nhắn D2…' })).toBeVisible();
    await shot(page, 'C8');
  });
  test('C9 an svg drawn as an image', async ({ page }) => {
    await open(page, { sel: 'orch:hagenta', key: 'c', tabs: { base: BASE_SET('docs/specs/assets/logo/logo-d0.svg') } });
    await expect(cv(page).locator('.cimg img')).toBeVisible();
    await shot(page, 'C9');
  });
  test('C10 a large file: the band, the first 2 MB, one "VS Code" button', async ({ page }) => {
    await open(page, { sel: 'orch:hagenta', key: 'c', tabs: { base: BASE_SET('bun.lock') } });
    await expect(cv(page).locator('.cband.warn')).toContainText('Tệp lớn');
    await expect(cv(page).getByRole('button', { name: 'VS Code' })).toBeVisible();
    await shot(page, 'C10');
  });
  test('C11 a project without git: Code as for any project', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ccs.code.tabs', JSON.stringify({ 'city-game': { base: { tabs: [['drafts/brief.md', false], ['notes.txt', false]], active: 'drafts/brief.md' } } })));
    await open(page, { wire: { snap: cityGame, reply: cityReply } });
    await page.locator('#top').getByRole('button', { name: /city-game/ }).click();
    await page.keyboard.press('c');
    await expect(cv(page).locator('.csrcw')).toContainText('thư mục project');
    await expect(cv(page).locator('h1')).toHaveText('City game · brief');
    await treeShows(page, 'drafts/brief.md');
    await shot(page, 'C11');
  });
  test('C12 D7 has no worktree any more → the project folder + the band; the folder\'s tabs empty', async ({ page }) => {
    await open(page, { wire: { snap: (s) => { const d7 = s.lanes.find(l => l.name === 'D7'); if (d7) d7.worktreeExists = false; } } });
    await page.keyboard.press('Meta+k');
    await page.getByRole('textbox', { name: 'Tìm hành động, lane, project' }).fill('D7');
    await page.keyboard.press('Enter');
    await page.keyboard.press('c');
    await expect(cv(page)).toContainText('D7 không còn worktree · đang xem thư mục project');
    await expect(cv(page)).toContainText('Chọn một file trong cây hoặc ⌘P');
    await shot(page, 'C12');
  });
  test('C13 loading: skeleton tree, thin bar on the viewer', async ({ page }) => {
    await open(page, { sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET() }, wire: { reply: (c) => (c.cmd === 'fs_list' || c.cmd === 'fs_read' ? 'hold' : undefined) } });
    await expect(cv(page).locator('.cside .cskel')).toBeVisible();
    await expect(cv(page).locator('.cbar')).toBeVisible();
    await expect(cv(page).locator('.cbody .cskel')).toBeVisible();
    await expect(cv(page)).not.toContainText('Không đọc được');
    await shot(page, 'C13');
  });
  test('C14 a read error: the reason + Thử lại', async ({ page }) => {
    await open(page, { sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET() },
      wire: { reply: (c) => (c.cmd === 'fs_read' && c.path === P_AUTH ? { err: 'EACCES · không có quyền đọc' } : undefined) } });
    await expect(cv(page)).toContainText('Không đọc được engine/src/auth.ts');
    await expect(cv(page).getByRole('button', { name: 'Thử lại' })).toBeVisible();
    await treeShows(page, P_AUTH);
    await shot(page, 'C14');
  });
  test('C15 the file changed on disk while the PO read (scrolled): "File vừa đổi · Tải lại", no auto reload', async ({ page }) => {
    let n = 0;
    const long = (v: number) => `${Array.from({ length: 60 }, (_, i) => `export const k${i} = ${i}`).join('\n')}\n// v${v}\n`;
    const ctl = await open(page, { sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET() },
      wire: { reply: (c) => (c.cmd === 'fs_read' && c.path === P_AUTH ? { ok: { kind: 'text', text: long(++n), size: 900, hash: `v${n}`, eol: 'lf', bom: false } } : undefined) } });
    await expect(path(page)).toHaveText(P_AUTH);
    await cv(page).locator('.cm-scroller').evaluate((el) => { el.scrollTop = 400; el.dispatchEvent(new Event('scroll')); });
    await cv(page).locator('.cbody').evaluate((el) => { el.scrollTop = 400; el.dispatchEvent(new Event('scroll')); });
    ctl.event({ type: 'code_changed', projectId: 'hagenta', src: { kind: 'lane', laneId: 'D15' }, paths: [P_AUTH] });
    await expect(cv(page).locator('.cband.acc')).toContainText('File vừa đổi');
    await expect(cv(page).getByRole('button', { name: 'Tải lại' })).toBeVisible();
    await shot(page, 'C15');
  });
  test('C16 the connection drops while editing: text kept, "Lưu" and send greyed + the reason', async ({ page }) => {
    const ctl = await open(page, BASE_EDIT);
    await editAuth(page);
    ctl.drop();
    await expect(cv(page).locator('.coff')).toContainText('Mất kết nối');
    await expect(cv(page).locator('.vf')).toContainText('chưa lưu được');
    await expect(editBtn(page, 'Lưu ⌘S')).toHaveAttribute('aria-disabled', 'true');
    await topAtZero(page);
    await shot(page, 'C16');
  });
  test('C17 window 1024 × 640: drawer left column, 240 px tree, no md outline', async ({ page }) => {
    await open(page, { narrow: true, sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET(P_MD) } });
    await expect(cv(page).locator('h1')).toHaveText('Auth: token rỗng và khoá xoay vòng');
    expect(Math.round((await cv(page).locator('.cside').boundingBox())!.width)).toBe(240);
    await expect(cv(page).locator('.md-toc')).toHaveCount(0);
    await shot(page, 'C17');
  });
  test('C18 English: C1', async ({ page }) => {
    await open(page, { en: true, sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET() } });
    await expect(cv(page).locator('.csrcw')).toContainText('D15 · worktree');
    await expect(editBtn(page, 'Edit')).toHaveAttribute('aria-disabled', 'true');
    await shot(page, 'C18');
  });
  test('C19 after ⌘S: foot "Đã lưu hh:mm"', async ({ page }) => {
    // the save is answered here: the dev mock keeps saved text for every later page (C22 / C23 still need "flase")
    await open(page, { ...BASE_EDIT, wire: { reply: (c) => (c.cmd === 'fs_write' ? { ok: { ok: true, hash: 'saved' } } : undefined) } });
    await editAuth(page);
    await page.keyboard.press('Meta+s');
    await expect(cv(page).locator('.vf')).toContainText('Đã lưu');
    await expect(cv(page).locator('.cvh .edp')).toHaveCount(0);
    await expect(cv(page).locator('.cm-activeLineGutter')).toHaveText('4'); // I3 the save keeps the cursor where it was
    await shot(page, 'C19');
  });
  test('C20 not UTF-8 (Latin-1): readable, "Sửa" greyed "Không phải UTF-8"', async ({ page }) => {
    await open(page, { sel: 'orch:hagenta', key: 'c', tabs: { base: BASE_SET('fixtures/menu-latin1.csv') } });
    await expect(cv(page).locator('.cvh .meta')).toContainText('Không phải UTF-8');
    await lock(page);
    await shot(page, 'C20');
  });
  test('C21 a binary file: "Tệp nhị phân · 182 KB" + "Mở trong VS Code"; "Sửa" greyed', async ({ page }) => {
    await open(page, { sel: 'orch:hagenta', key: 'c', tabs: { base: BASE_SET('docs/specs/assets/logo/logo-d0.icns') } });
    await expect(cv(page)).toContainText('Tệp nhị phân · 182 KB');
    await expect(cv(page).getByRole('button', { name: 'Mở trong VS Code' })).toBeVisible();
    await lock(page);
    await shot(page, 'C21');
  });
  test('C22 save when the file was deleted on disk: Tạo lại · Bỏ · Huỷ', async ({ page }) => {
    await open(page, { ...BASE_EDIT, wire: writeTo('gone') });
    await editAuth(page);
    await page.keyboard.press('Meta+s');
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('File đã bị xoá trên đĩa');
    await expect(dlg.getByRole('button', { name: 'Tạo lại bằng bản của anh' })).toBeVisible();
    await shot(page, 'C22');
  });
  test('C23 "Huỷ" with unsaved text → "Bỏ thay đổi chưa lưu?"', async ({ page }) => {
    await open(page, BASE_EDIT);
    await editAuth(page);
    await cv(page).getByRole('button', { name: 'Huỷ', exact: true }).click();
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('Bỏ thay đổi chưa lưu?');
    await expect(dlg).toContainText('Huỷ sẽ bỏ thay đổi này.');
    await shot(page, 'C23');
  });
  test('C24 "Hiện file bị bỏ qua" on: .local, node_modules, .env dim and readable', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ccs.code.showIgnored', JSON.stringify({ hagenta: true })));
    await open(page, { sel: 'orch:hagenta', key: 'c', tabs: { base: BASE_SET('.local/reports/d15-auth-report.md') } });
    await expect(cv(page).locator('.cign')).toHaveAttribute('aria-pressed', 'true');
    await expect(cv(page).locator('.ctree .tr.ign').first()).toBeVisible();
    await expect(cv(page).locator('h1')).toHaveText('D15 · báo cáo auth');
    await shot(page, 'C24');
  });
  test('C25 one click on store.ts replaces the preview tab (auth-design.md)', async ({ page }) => {
    await open(page, { sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET() } });
    await treeShows(page, 'engine/src/store.ts');
    await cv(page).locator('.ctree [data-path="engine/src/store.ts"]').click();
    await expect(tabs(page)).toHaveCount(3);
    await expect(tabs(page).first()).toHaveClass(/\bpv\b/);
    await expect(tabs(page).first()).toContainText('store.ts');
    await expect(tabs(page).filter({ hasText: 'auth-design.md' })).toHaveCount(0);
    await shot(page, 'C25');
  });
  test('C26 many tabs: the bar scrolls sideways; twin names get their parent dir', async ({ page }) => {
    await open(page, { sel: 'orch:hagenta', key: 'c', tabs: { base: MANY } });
    await expect(tabs(page)).toHaveCount(11);
    await expect(cv(page).locator('.ctabs .pd')).toHaveText(['test', 'src', 'lot2', 'src']);
    expect(await cv(page).locator('.ctabs').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(cv(page).locator('.ctabs')).toHaveClass(/\bfl\b.*\bfr\b/); // M3 both clipped edges fade
    // v2.4 §6.8 D54: the 6 px horizontal gutter sits under the tabs, which fill the rest (never clipped by it)
    expect(await cv(page).locator('.ctabs').evaluate((el: HTMLElement) => [el.offsetHeight - el.clientHeight - 1, (el.querySelector('.ftb') as HTMLElement).offsetHeight === el.clientHeight])).toEqual([6, true]);
    const mid = (b: { x: number; width: number } | null) => b!.x + b!.width / 2;
    expect(Math.abs(mid(await cv(page).locator('.ctabs .ftb.on').boundingBox()) - mid(await cv(page).locator('.ctabs').boundingBox()))).toBeLessThan(40); // M3 centred
    await shot(page, 'C26');
  });
  test('C27 closing a ● tab with ⌘W → Huỷ · Bỏ · Lưu', async ({ page }) => {
    await open(page, BASE_EDIT);
    await editAuth(page);
    await page.keyboard.press('Meta+w');
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('Đóng tab sẽ bỏ thay đổi này.');
    await expect(dlg.getByRole('button', { name: 'Bỏ', exact: true })).toBeVisible();
    await shot(page, 'C27');
  });
  test('C28 the chip to the project folder: its own tab set (config.ts as left)', async ({ page }) => {
    await open(page, { sel: 'lane:D15', key: 'c', tabs: { 'lane:D15': D15_SET(), base: BASE_SET(undefined, 'engine/src/config.ts') } });
    await cv(page).locator('.csrcw > button').first().click();
    await page.getByRole('listbox', { name: 'Nguồn' }).getByRole('option', { name: /thư mục project/ }).click();
    await expect(cv(page).locator('.csrcw')).toContainText('thư mục project');
    await expect(path(page)).toHaveText('engine/src/config.ts');
    await expect(tabs(page)).toHaveCount(3);
    await treeShows(page, 'engine/src/config.ts');
    await shot(page, 'C28');
  });
  test('C29 hot exit: reopened, auth.ts comes back with ● and "Thay đổi chưa lưu từ lần trước"', async ({ page }) => {
    await open(page, BASE_EDIT);
    await editAuth(page);
    await page.waitForTimeout(800); // the IndexedDB write is debounced
    await page.reload();
    // v2.7 §4.1 D91: the app reopens in Tasks (no `ccs.mode`), so the reopen goes back to Code itself
    await page.locator('.dhead [role=tab]', { hasText: 'Code' }).click();
    await page.locator('#codeview').waitFor();
    await hideDevToasts(page);
    await page.addStyleTag({ content: '#reloadBand{display:none!important}' });
    await expect(cv(page).locator('.cband.acc')).toContainText('Thay đổi chưa lưu từ lần trước');
    await expect(tabs(page).filter({ hasText: 'auth.ts' }).locator('button.x.dt')).toBeVisible();
    await treeShows(page, P_AUTH);
    await shot(page, 'C29');
  });
});

test.describe('Git', () => {
  const row = (page: Page) => gv(page).locator('.gbrow.sel');
  test('G1 lane/d15: 1 conflict, conflict file picked, "Nhờ D15 rebase…" + "Nhờ D15 commit…"', async ({ page }) => {
    await open(page, { sel: 'lane:D15', key: 'g' });
    await expect(row(page)).toContainText('lane/d15');
    await expect(row(page)).toContainText('1 xung đột');
    await expect(gv(page).locator('.gfr.sel')).toContainText('lanes.ts');
    await expect(gv(page).getByRole('button', { name: 'Nhờ D15 rebase…' })).toBeVisible();
    await expect(gv(page).getByRole('button', { name: 'Nhờ D15 commit…' })).toBeVisible();
    await shot(page, 'G1');
  });
  test('G2 lane/d2 merges clean: "Nhờ Điều phối merge…" + "D2 đang chạy"', async ({ page }) => {
    await open(page, { sel: 'lane:D2', key: 'g' });
    await expect(row(page)).toContainText('merge sạch');
    await expect(gv(page).getByRole('button', { name: 'Nhờ Điều phối merge…' })).toBeVisible();
    await expect(gv(page).locator('.gwl')).toContainText('D2 đang chạy');
    await shot(page, 'G2');
  });
  test('G3 a commit picked in the graph: Thay đổi = files of a41c09e, first file picked, × back', async ({ page }) => {
    await open(page, { sel: 'orch:hagenta', key: 'g' });
    await gv(page).getByText('Merge lane/b2 vào main · gate xanh').click();
    await expect(gv(page).locator('.gcmh')).toContainText('Merge lane/b2 vào main · gate xanh');
    await expect(gv(page).locator('.gcmh')).toContainText('cha 7be3f10');
    await expect(gv(page).locator('.gfr.sel')).toContainText('lanes.ts');
    await expect(gv(page).getByRole('button', { name: 'Về nhánh' })).toBeVisible();
    await shot(page, 'G3');
  });
  test('G4 the base branch: "Chưa commit trong thư mục project" + "Nhờ Điều phối commit…"', async ({ page }) => {
    await open(page, { sel: 'orch:hagenta', key: 'g' });
    await expect(row(page)).toContainText('main');
    await expect(row(page)).toContainText('1 file chưa commit');
    await expect(gv(page)).toContainText('Chưa commit trong thư mục project');
    await expect(gv(page).getByRole('button', { name: 'Nhờ Điều phối commit…' })).toBeVisible();
    await shot(page, 'G4');
  });
  test('G5 measuring again: the old result dimmed + "đang đo…"', async ({ page }) => {
    await open(page, { g: 'G5', sel: 'lane:D15', key: 'g' });
    await expect(gv(page)).toContainText('đang đo lại…');
    await expect(row(page).locator('.old')).toBeVisible();
    await shot(page, 'G5');
  });
  test('G6 not measured: "Không đo được · Thử lại" only on the branch row', async ({ page }) => {
    await open(page, { g: 'G6', sel: 'lane:D15', key: 'g' });
    await expect(row(page)).toContainText('Không đo được · Thử lại');
    await expect(gv(page).getByRole('button', { name: 'Nhờ D15 rebase…' })).toHaveCount(0);
    await shot(page, 'G6');
  });
  test('G7 a project without git (city-game): Git says so, Code still works', async ({ page }) => {
    await open(page, { wire: { snap: cityGame, reply: cityReply } });
    await page.locator('#top').getByRole('button', { name: /city-game/ }).click();
    await page.keyboard.press('g');
    await expect(gv(page)).toContainText('Project này không dùng git');
    await expect(gv(page).getByRole('button', { name: 'Sang Code' })).toBeVisible();
    await shot(page, 'G7');
  });
  test('G8 20+ lanes: "Lọc nhánh", the merged branches folded', async ({ page }) => {
    await open(page, { g: 'G8', sel: 'lane:D15', key: 'g' });
    await expect(gv(page).getByRole('textbox', { name: 'Lọc nhánh' })).toBeVisible();
    await expect(gv(page)).toContainText('14 nhánh đã merge');
    await shot(page, 'G8');
  });
  test('G9 after "Nhờ D15 rebase…": the composer targets D15 with the sentence, not sent', async ({ page }) => {
    await open(page, { sel: 'lane:D15', key: 'g' });
    await gv(page).getByRole('button', { name: 'Nhờ D15 rebase…' }).click();
    await expect(page.getByLabel('Ô lệnh')).toHaveValue('Rebase lane/d15 lên main rồi giải xung đột ở engine/src/lanes.ts; chạy lại test liên quan.');
    await shot(page, 'G9');
  });
  test('G10 D18 changed nothing: lane/d18 picked, Thay đổi empty with a sentence', async ({ page }) => {
    await open(page, { g: 'G10', sel: 'lane:D18', key: 'g' });
    await expect(row(page)).toContainText('lane/d18');
    await expect(gv(page)).toContainText('Lane chưa đổi file nào so với main.');
    await shot(page, 'G10');
  });
  test('G11 offline: what loaded stays, "Nhờ …" and send greyed', async ({ page }) => {
    const ctl = await open(page, { sel: 'lane:D15', key: 'g' });
    await expect(gv(page).locator('.gfr.sel')).toContainText('lanes.ts');
    await expect(gv(page)).toContainText('main cũng sửa chỗ này'); // the diff loaded before the link drops
    ctl.drop();
    await expect(gv(page).getByRole('button', { name: 'Nhờ D15 rebase…' })).toBeDisabled();
    await expect(gv(page).locator('.gfr.sel')).toContainText('lanes.ts');
    await topAtZero(page);
    await shot(page, 'G11');
  });
  test('G12 English: G1', async ({ page }) => {
    await open(page, { en: true, sel: 'lane:D15', key: 'g' });
    await expect(row(page)).toContainText('1 conflict');
    await expect(gv(page).getByRole('button', { name: 'Ask D15: rebase…' })).toBeVisible();
    await shot(page, 'G12');
  });
  test('G13 after "Nhờ Điều phối merge…" on D2: composer → Điều phối, Đang xem still D2, Git still lane/d2', async ({ page }) => {
    await open(page, { sel: 'lane:D2', key: 'g' });
    await gv(page).getByRole('button', { name: 'Nhờ Điều phối merge…' }).click();
    await expect(page.getByLabel('Ô lệnh')).toHaveValue(/^Merge lane\/d2 \(2 commit, 4 file\) vào main sau khi chạy lại gate\./);
    await expect(row(page)).toContainText('lane/d2');
    await expect(page.locator('#inspector .crumb')).toContainText('D2');
    await shot(page, 'G13');
  });
  test('G14 a repo with no commit: "main · chưa có commit", untracked files, "Chưa có commit nào"', async ({ page }) => {
    await open(page, { g: 'G14', sel: 'orch:hagenta', key: 'g', wire: { snap: (s) => { s.projects[0]!.name = 'scratch'; } } });
    await expect(row(page)).toContainText('chưa có commit');
    await expect(gv(page)).toContainText('Chưa có commit nào');
    await expect(gv(page).locator('.gfr').first()).toContainText('README.md');
    await shot(page, 'G14');
  });
  test('G15 window 1024 × 640: drawer, Source Control 300 px', async ({ page }) => {
    await open(page, { narrow: true, sel: 'lane:D15', key: 'g' });
    await expect(row(page)).toContainText('lane/d15');
    expect(Math.round((await gv(page).locator('.gside').boundingBox())!.width)).toBe(300);
    await shot(page, 'G15');
  });
  test('G16 40 changed files: Thay đổi scrolls, conflicts first, "Nhờ …" pinned under the list', async ({ page }) => {
    await open(page, { g: 'G16', sel: 'lane:D15', key: 'g' });
    await expect(gv(page).locator('.gfr')).toHaveCount(40);
    await expect(gv(page).locator('.gfr').first()).toContainText('lanes.ts');
    await expect(gv(page).getByRole('button', { name: 'Nhờ D15 rebase…' })).toBeInViewport();
    await shot(page, 'G16');
  });
});

