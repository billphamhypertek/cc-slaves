// v2.9 §12 E2E for G4, the Quy trình screen (§4): open from Cài đặt (WF1a), a built-in is view only + Nhân bản để sửa (T3,
// WF4 / WF13), edit an instruction → Lưu writes the file (T2, WF1b / WF2), drag Soạn tài liệu onto an edge (T4, WF3a–c), a
// refused connection says why (WF3d), toggle a rule → Lưu (T5, WF12), a file changed on disk under unsaved changes → the
// conflict dialog (WF5c), a broken hand edit → the band (WF5b), Nhập → preview → Thêm (T6, WF9 / WF9c, stubbed
// `window.__TAURI__` folder panel), Quy trình mới (WF11), Xoá (WF10b), leave with unsaved changes (WF8). The selected node is
// the neutral grey step — no coloured border (§4.2, BANNED look). Every frame is shot light + dark at 1440 and 1024 into
// `.local/shots/v29-g4/` (gitignored) for the mockup check.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { ORCH, S, expect, test, useEngine } from '../fixtures.ts';
import { hagentaRepo } from '../v23-repo.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SHOTS = join(ROOT, '.local', 'shots', 'v29-g4');
const PO = join(ROOT, 'engine', 'src', 'workflow', 'builtin', 'po');

/** the page's engine socket through a switch: `drop` closes it and refuses reconnects (v271-start SA9b). */
async function wire(page: Page): Promise<{ drop: () => void }> {
  let live: { close(): Promise<void> } | null = null, down = false;
  await page.routeWebSocket(/\/ws\?/, ws => {
    if (down) { void ws.close(); return; }
    live = ws;
    const server = ws.connectToServer();
    ws.onMessage(m => server.send(m));
    server.onMessage(m => ws.send(m));
  });
  return { drop: () => { down = true; void live?.close(); } };
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`v2.9 G4 Quy trình (${theme})`, () => {
    test.use({ theme });
    const eng = useEngine({ scenarios: () => ({ [ORCH]: { steps: [...S.idle()] } }) });
    test.describe.configure({ mode: 'serial' });
    const lib = () => join(eng.dir, 'home', 'workflows');
    const userDir = (): string => {
      const d = readdirSync(lib()).filter(n => !n.startsWith('.'));
      expect(d).toHaveLength(1);
      return join(lib(), d[0]!);
    };

    test.beforeAll(async () => {
      test.setTimeout(90_000);
      hagentaRepo(eng);
      await eng.addProject('hagenta');
      mkdirSync(SHOTS, { recursive: true });
    });

    /** One frame at 1440 × 900 and 1024 × 640, then back to the 1440 layout. */
    async function shot(page: Page, frame: string): Promise<void> {
      for (const [w, h] of [[1024, 640], [1440, 900]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(SHOTS, `${frame}-${theme}-${w}.png`) });
      }
    }

    async function open(page: Page): Promise<Locator> {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(eng.url());
      await page.locator('#top').getByRole('button', { name: 'Cài đặt', exact: true }).click();
      await page.getByRole('tab', { name: 'Quy trình', exact: true }).click();
      const wf = page.locator('.wf');
      await expect(wf.locator('.wlib .lr[data-row]').first()).toBeVisible();
      return wf;
    }
    /** a click on the canvas background (top middle: the palette is top left, Kiểm gói bottom right) opens Cài đặt quy trình */
    const bg = async (wf: Locator) => {
      await expect(wf.locator('.wtb .wnm')).toBeVisible();
      let b: { width: number } | null = null;
      await expect.poll(async () => (b = await wf.locator('.react-flow__pane').boundingBox()) !== null).toBe(true);
      await wf.locator('.react-flow__pane').click({ position: { x: b!.width / 2, y: 24 } });
    };
    const node = (wf: Locator, name: string) => wf.locator('.react-flow__node').filter({ has: wf.page().locator('.nm', { hasText: name }) });

    test('WF1a / WF4 opens from Cài đặt; a built-in is view only; T3 Nhân bản để sửa → name → Enter → own editable copy', async ({ page }) => {
      const wf = await open(page);
      await expect(wf.locator('.wlib .lr[data-row]')).toHaveCount(3); // the three built-ins, nothing of the user's yet
      await expect(wf.locator('.wlib .lr.empty')).toHaveText('Chưa có quy trình riêng — Nhân bản một mẫu để bắt đầu');
      await wf.locator('.wlib .lr', { hasText: 'Quy trình PO' }).click();
      await expect(wf.locator('.wtb .ro')).toHaveText('Mẫu có sẵn — chỉ xem');
      await expect(wf.locator('.wpal')).toHaveCount(0);
      await expect(node(wf, 'Thiết kế')).toBeVisible();
      // ruling 01:20: a deny of a skill not installed is a no-op (was 23 rows); v29-fx3: the engine now checks require_plugins
      // against the installed plugins (none in this harness), so the one row left is that real warning
      await expect(wf.locator('.wprob .pr')).toHaveText([/superpowers.* chưa cài/]);
      await shot(page, 'WF1a');
      await node(wf, 'Thiết kế').click();
      await expect(wf.locator('.wpp')).toContainText('Mẫu có sẵn không sửa được');
      await expect(wf.locator('.wpp .skl .sr').first()).toBeVisible();
      await expect(wf.locator('.wpp .skl .gone')).toHaveCount(0);
      await shot(page, 'WF4');

      await wf.locator('.wtb').getByRole('button', { name: 'Nhân bản để sửa' }).click();
      const pop = page.getByRole('dialog', { name: 'Tên quy trình mới' });
      await expect(pop.getByRole('textbox')).toHaveValue('Quy trình PO của tôi');
      await shot(page, 'WF13');
      await expect(pop).toContainText(/Chép cả gói \(\d+ file\) vào thư viện/); // I2 the count, never a raw {n}
      await pop.getByRole('textbox').fill('PO thử');
      await pop.getByRole('textbox').press('Enter');
      await expect(wf.locator('.wlib .lr[aria-current]')).toContainText('PO thử');
      await expect(wf.getByRole('button', { name: 'Lưu', exact: true })).toBeDisabled(); // nothing changed yet
      await expect(wf.locator('.wpal')).toBeVisible();
      expect(readFileSync(join(userDir(), 'WORKFLOW.md'), 'utf8')).toMatch(/^name: PO thử$/m);
    });

    test('T2 / WF1b–WF2 edit an instruction → Chưa lưu → Lưu writes the step file; the selected node is the neutral grey step', async ({ page }) => {
      const wf = await open(page);
      await wf.locator('.wlib .lr', { hasText: 'PO thử' }).click();
      const n = node(wf, 'Thiết kế');
      await n.click();
      await expect(n).toHaveClass(/selected/);
      const look = await n.locator('.wn').evaluate(e => { const s = getComputedStyle(e); return { b: s.borderTopColor, l: s.borderLeftColor, sh: s.boxShadow, bg: s.backgroundImage }; });
      const other = await node(wf, 'Build').locator('.wn').evaluate(e => { const s = getComputedStyle(e); return { b: s.borderTopColor, sh: s.boxShadow }; }); // unselected
      expect(look.b).toBe(other.b); // no coloured border on selection (BANNED look)
      expect(look.l).toBe(other.b);
      expect(look.sh).toBe(other.sh); // no ring either
      expect(look.bg).toContain('gradient'); // the --sel grey step
      await expect(wf.locator('.wpp')).toContainText('Lời dặn');
      await shot(page, 'WF1b');

      const ed = wf.locator('.wpp .cm-content');
      await ed.click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('\nGhi chú e2e T2.');
      await ed.blur();
      await expect(wf.locator('.wtb')).toContainText('Chưa lưu');
      await shot(page, 'WF2');
      await wf.getByRole('button', { name: 'Lưu', exact: true }).click();
      await expect(wf.locator('.wtb')).not.toContainText('Chưa lưu');
      expect(readFileSync(join(userDir(), 'steps', 'design.md'), 'utf8')).toContain('Ghi chú e2e T2.');
    });

    test('v29-fx3 1024: no impact line on a built-in; the overlay panel starts under the bar (Lưu in reach, the chain fits the seen part); ⋯ menu over the impact line; refit on resize; 6 px handles', async ({ page }) => {
      const wf = await open(page);
      const box = (l: Locator) => l.boundingBox().then(b => b!);
      const onTop = (l: Locator) => l.evaluate(e => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); });
      const xongRight = async () => { const b = await box(wf.locator('.react-flow__node[data-id="done"]')); return b.x + b.width; };
      await page.setViewportSize({ width: 1024, height: 640 });
      await wf.locator('.wlib .lr', { hasText: 'Quy trình PO' }).click();
      await expect(wf.locator('.wtb .ro')).toBeVisible();
      await expect(wf.locator('.wimp2')).toHaveCount(0); // I6 a built-in saves nothing: no "Lưu → …" line

      await page.setViewportSize({ width: 1440, height: 900 });
      await wf.locator('.wlib .lr', { hasText: 'PO thử' }).click();
      await expect(wf.locator('.wpal')).toBeVisible();
      await page.setViewportSize({ width: 1024, height: 640 }); // M4 the canvas fits again after the window shrank
      await expect.poll(async () => (await xongRight()) <= (await box(wf.locator('.wcv'))).x + (await box(wf.locator('.wcv'))).width).toBe(true);
      const imp = await box(wf.locator('.wimp2'));
      // M6 a round 6 px dot (unscaled by the zoom), not a lozenge; a short edge keeps ≥ 16 px (and its arrow) after its label
      const hd = await wf.locator('.react-flow__handle.hd').first().evaluate(e => { const c = getComputedStyle(e); return [c.width, c.height, c.paddingLeft]; });
      expect(hd).toEqual(['6px', '6px', '0px']);
      const zoom = Number((await wf.locator('.wpct').innerText()).replace(/\D/g, '')) / 100;
      const lbl = await box(wf.locator('.wel[data-edge="design"]'));
      expect(((await box(node(wf, 'Build'))).x - (lbl.x + lbl.width)) / zoom).toBeGreaterThanOrEqual(16);

      await node(wf, 'Thiết kế').click();
      const panel = wf.locator('.wpp.ovl');
      await expect(panel).toBeVisible();
      expect((await box(panel)).y).toBeGreaterThanOrEqual((await box(wf.locator('.wtb'))).y + (await box(wf.locator('.wtb'))).height - 1); // I1
      expect(await onTop(wf.locator('.wtb').getByRole('button', { name: 'Lưu', exact: true }))).toBe(true);
      expect(await onTop(wf.locator('.wtb').getByRole('button', { name: 'Sửa bằng lời' }))).toBe(true);
      await expect.poll(async () => (await xongRight()) <= (await box(panel)).x).toBe(true); // the chain fits the part still seen
      await panel.getByRole('button', { name: 'Đóng bảng' }).click();

      await wf.locator('.wtb').getByRole('button', { name: 'Thao tác khác' }).click();
      const first = wf.locator('.wmenu .mr').first();
      expect((await box(first)).y).toBeLessThan(imp.y + imp.height); // the menu's first row sits over the impact line…
      expect(await onTop(first)).toBe(true); // …and is drawn above it (M3)
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1440, height: 900 });

      // M10 the keyboard path of T4: a palette block and an edge label take focus; Enter on the label picks the edge, Enter on the
      // block inserts it there (none picked → how to pick one)
      const block = wf.locator('.wpal .pi2[data-type="design"]');
      await block.focus();
      await page.keyboard.press('Enter');
      await expect(wf.locator('.wtip')).toContainText('Chọn một đường nối');
      await wf.locator('.wel[data-edge="design"]').focus();
      await page.keyboard.press('Enter');
      await expect(wf.locator('.wel[data-edge="design"]')).toHaveAttribute('aria-pressed', 'true');
      await block.focus();
      await page.keyboard.press('Enter');
      await expect(wf.locator('.react-flow__node .wn:not(.end)')).toHaveCount(5); // 2 docs + Build + Chung + Lane
      await expect(wf.locator('.wtb')).toContainText('Chưa lưu');
      await wf.getByRole('button', { name: 'Bỏ thay đổi' }).click();
      await expect(wf.locator('.react-flow__node .wn:not(.end)')).toHaveCount(4);
    });

    test('T4 / WF3a–c drag Soạn tài liệu onto an edge → name it → Lưu writes a new step file; WF3d a refused drop says why', async ({ page }) => {
      const wf = await open(page);
      await wf.locator('.wlib .lr', { hasText: 'PO thử' }).click();
      await expect(node(wf, 'Thiết kế')).toBeVisible();
      await shot(page, 'WF3a');
      const before = readdirSync(join(userDir(), 'steps')).length;
      const pal = wf.locator('.wpal .pi2[data-type="design"]');
      const edge = wf.locator('.wel[data-edge]').filter({ hasText: /duyệt/ }).first();
      await pal.dragTo(edge);
      await expect(wf.locator('.wtb')).toContainText('Chưa lưu');
      expect(await wf.getByRole('status').filter({ hasText: 'Thả lên một cạnh' }).count()).toBe(0); // the edge took the drop, the pane did not refuse it too (counted at once: the tip lives 4 s)
      const name = wf.locator('.wpp').getByRole('textbox', { name: 'Tên' });
      await expect(name).toBeVisible();
      await name.fill('Review spec');
      await name.press('Enter');
      await expect(node(wf, 'Review spec')).toBeVisible();
      await shot(page, 'WF3b');
      await wf.getByRole('button', { name: 'Lưu', exact: true }).click();
      await expect(wf.locator('.wtb')).not.toContainText('Chưa lưu');
      expect(readdirSync(join(userDir(), 'steps')).length).toBe(before + 1);

      // WF3d: Build is already there — its palette item is dimmed and says why
      await expect(wf.locator('.wpal .pi2[data-type="build"]')).toHaveAttribute('aria-disabled', 'true');
      await expect(wf.locator('.wpal .pi2[data-type="general"]')).toHaveAttribute('title', 'Mỗi quy trình có đúng một bước Việc chung và một bước Lane');
      // a step dropped on the canvas (not on an edge) is refused with the reason
      const pane = (await wf.locator('.react-flow__pane').boundingBox())!;
      await wf.locator('.wpal .pi2[data-type="design"]').dragTo(wf.locator('.react-flow__pane'), { targetPosition: { x: pane.width / 2, y: 24 } });
      await expect(wf.getByRole('status').filter({ hasText: 'Thả lên một cạnh để chèn bước vào giữa' })).toBeVisible();
      await shot(page, 'WF3d');
    });

    test('T5 / WF12 a rule switch → Lưu writes WORKFLOW.md', async ({ page }) => {
      const wf = await open(page);
      await wf.locator('.wlib .lr', { hasText: 'PO thử' }).click();
      await bg(wf);
      const sw = wf.locator('.wpp').getByRole('switch', { name: 'Không tạo lại mục đã huỷ' });
      await expect(sw).toHaveAttribute('aria-checked', 'true');
      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', 'false');
      await shot(page, 'WF12');
      await wf.getByRole('button', { name: 'Lưu', exact: true }).click();
      await expect(wf.locator('.wtb')).not.toContainText('Chưa lưu');
      expect(readFileSync(join(userDir(), 'WORKFLOW.md'), 'utf8')).toMatch(/no_recreate_cancelled: false/);
    });

    test('WF5c a file changed on disk under unsaved changes → conflict dialog → Tải lại; WF5b a broken hand edit → the band', async ({ page }) => {
      const sock = await wire(page);
      const wf = await open(page);
      await wf.locator('.wlib .lr', { hasText: 'PO thử' }).click();
      await bg(wf);
      await wf.locator('.wpp').getByRole('switch', { name: 'Một lane một mục' }).click();
      await expect(wf.locator('.wtb')).toContainText('Chưa lưu');
      const f = join(userDir(), 'WORKFLOW.md');
      const good = readFileSync(f, 'utf8');
      writeFileSync(f, good.replace(/^description: .*$/m, 'description: sửa tay ngoài app'));
      await page.waitForTimeout(2_500); // the engine's 2 s library poll
      await wf.getByRole('button', { name: 'Lưu', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'File quy trình vừa đổi ngoài app' });
      await expect(dlg).toBeVisible();
      await expect(dlg.getByRole('button', { name: 'Tải lại' })).toBeFocused();
      await shot(page, 'WF5c');
      await dlg.getByRole('button', { name: 'Tải lại' }).click();
      await expect(dlg).toHaveCount(0);
      await expect(wf.locator('.wtb')).not.toContainText('Chưa lưu');
      await expect(wf.locator('.wpp').getByRole('textbox', { name: 'Mô tả' })).toHaveValue('sửa tay ngoài app');

      writeFileSync(f, good.replace(/^rules: .*$/m, 'rules: { priority_first: maybe'));
      await expect(wf.locator('.wban[role=alert]')).toContainText('File sửa tay bị lỗi', { timeout: 8_000 });
      await expect(wf.locator('.wlib .lr[aria-current] .s.bad')).toContainText('lỗi');
      // M8 a file that does not parse: the panel is view only with the fix-in-the-file note, never an empty editable form
      await expect(wf.locator('.wpp')).toContainText('sửa trong file, app tự đọc lại');
      await expect(wf.locator('.wpp').getByRole('textbox', { name: 'Mô tả' })).toHaveCount(0);
      await shot(page, 'WF5b');
      writeFileSync(f, good);
      await expect(wf.locator('.wban[role=alert]')).toHaveCount(0, { timeout: 8_000 });
      // v29-fx3 WF8b shot: a V5 break keeps the canvas editable, so the band pushes the palette down; at 1024 with the
      // panel over the canvas the refit still keeps every node clear of it
      const lane = join(userDir(), 'steps', 'lane.md');
      const laneGood = readFileSync(lane, 'utf8');
      writeFileSync(lane, laneGood.replace(/^phases: \[(.*), done\]$/m, 'phases: [$1]'));
      await expect(wf.locator('.wban[role=alert]')).toBeVisible({ timeout: 8_000 });
      await page.setViewportSize({ width: 1024, height: 640 });
      const pal = (await wf.locator('.wpal').boundingBox())!;
      const clash = () => wf.locator('.react-flow__node').evaluateAll((ns, p) => ns.map(n => n.getBoundingClientRect())
        .filter(b => b.right > 1024 || (b.top < p.y + p.height && b.left < p.x + p.width)).length, pal);
      await expect.poll(clash, { message: 'a node off screen or under the palette' }).toBe(0);
      await page.setViewportSize({ width: 1440, height: 900 });
      // broken + offline: one band, not two stacked on the same spot; offline wins, the row keeps "lỗi"
      sock.drop();
      await expect(wf.locator('.wban[role=status]')).toContainText('Mất kết nối', { timeout: 15_000 });
      await expect(wf.locator('.wban')).toHaveCount(1);
      await expect(wf.locator('.wlib .lr[aria-current] .s.bad')).toContainText('lỗi');
      writeFileSync(lane, laneGood);
    });

    test('WF8 leaving with unsaved changes asks first; Ở lại keeps them, Bỏ thay đổi leaves', async ({ page }) => {
      const wf = await open(page);
      await wf.locator('.wlib .lr', { hasText: 'PO thử' }).click();
      await bg(wf);
      await wf.locator('.wpp').getByRole('switch', { name: 'Một lane một mục' }).click();
      await expect(wf.locator('.wtb')).toContainText('Chưa lưu');
      await wf.locator('.wlib .lr', { hasText: 'Quy trình PO' }).click();
      const dlg = page.getByRole('dialog', { name: 'Bỏ thay đổi chưa lưu?' });
      await expect(dlg.getByRole('button', { name: 'Ở lại' })).toBeFocused();
      await shot(page, 'WF8');
      await dlg.getByRole('button', { name: 'Ở lại' }).click();
      await expect(wf.locator('.wtb')).toContainText('Chưa lưu');
      await wf.getByRole('button', { name: 'Bỏ thay đổi' }).click();
      await expect(wf.locator('.wtb')).not.toContainText('Chưa lưu');
    });

    test('T6 / WF9 Nhập → the folder panel → preview → a step\'s instruction viewer → Thêm adds the pack', async ({ page }) => {
      const src = join(eng.dir, 'import-pack');
      cpSync(PO, src, { recursive: true });
      writeFileSync(join(src, 'WORKFLOW.md'), readFileSync(join(src, 'WORKFLOW.md'), 'utf8').replace(/^name: .*$/m, 'name: Gói nhập'));
      await page.addInitScript(dir => {
        (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke: (cmd: string) => Promise.resolve(cmd === 'pick_folder' ? dir : null) } };
      }, src);
      const wf = await open(page);
      await wf.getByRole('button', { name: 'Nhập', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: /Gói nhập/ });
      await expect(dlg.locator('.kv2')).toBeVisible();
      await expect(dlg.locator('.pathl')).toContainText(src);
      await shot(page, 'WF9');
      await dlg.getByRole('button', { name: /Thiết kế/ }).click();
      const viewer = page.getByRole('dialog', { name: /Thiết kế/ });
      // WF9c the slots read as grey chips with their Vietnamese names (the read-only instruction box), never raw `{{…}}`
      await expect(viewer.locator('.mde .slot', { hasText: 'Công cụ của bước' })).toBeVisible();
      await expect(viewer.locator('.mde .cm-content')).not.toContainText('{{');
      await expect(viewer.locator('.mde .mf2')).toContainText('chỉ đọc');
      await shot(page, 'WF9c');
      await viewer.getByRole('button', { name: 'Xem trước' }).click();
      await page.getByRole('dialog', { name: /Gói nhập/ }).getByRole('button', { name: 'Thêm', exact: true }).click();
      await expect(wf.locator('.wlib .lr', { hasText: 'Gói nhập' })).toBeVisible();
      await expect(wf.locator('.wlib .lr[aria-current]')).toContainText('Gói nhập');
    });

    test('WF11 Quy trình mới → pick a template → name → Nhân bản; WF10b Xoá → the Trash dialog → the row is gone', async ({ page }) => {
      const wf = await open(page);
      await wf.getByRole('button', { name: 'Quy trình mới', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Quy trình mới' });
      await dlg.getByRole('listbox').getByRole('option').first().click();
      await expect(dlg.locator('.mini')).toBeVisible();
      // I3 / R9 "Trống" is the last template: Chung + Lane, no instruction; copied, never a library row
      const blank = dlg.getByRole('listbox').getByRole('option').last();
      await expect(blank).toContainText('Trống');
      await blank.click();
      await expect(dlg.locator('.pv')).toContainText('Chỉ Chung và Lane, không lời dặn');
      await expect(dlg.locator('.mini')).toContainText('+ Chung · Lane (4 pha)');
      await dlg.getByRole('textbox', { name: 'Tên' }).fill('Mới từ mẫu');
      await shot(page, 'WF11');
      await dlg.getByRole('button', { name: 'Nhân bản', exact: true }).click();
      await expect(wf.locator('.wlib .lr[aria-current]')).toContainText('Mới từ mẫu');
      await expect(wf.locator('.react-flow__node[data-id]:not([data-id="done"])')).toHaveCount(2);
      await expect(wf.locator('.wlib .lr', { hasText: 'Trống' })).toHaveCount(0);

      await wf.getByRole('button', { name: 'Thao tác khác' }).click();
      await shot(page, 'WF10a');
      await wf.getByRole('menuitem', { name: 'Xoá' }).click();
      const del = page.getByRole('dialog', { name: 'Xoá quy trình "Mới từ mẫu"?' });
      await expect(del).toContainText('Thùng rác');
      await shot(page, 'WF10b');
      await del.getByRole('button', { name: 'Xoá', exact: true }).click();
      await expect(wf.locator('.wlib .lr', { hasText: 'Mới từ mẫu' })).toHaveCount(0);
    });
  });
}
