// v2.9 §12 E2E for G6, author by prompt (§4.10 / §5.9): Quy trình mới → the description box → Tạo opens an author session
// (fake-claude, cwd `<home>/workflow-drafts/<id>/pack`, scenario `scn/lane-pack.json`) → the chat runs while the canvas draws the
// draft read-only (WF14 / WF15a) → Nháp xong (WF16a) → "lưu đi" saves by voice + Hoàn tác (WF16c) → Bỏ nháp; Sửa bằng lời on a
// user pack (WF2b dimmed under a hand edit, WF15b, WF16d, WF16h once the 30 s window passes); a broken draft stops after 3 Kiểm
// gói (WF16e); 3 drafts dim Tạo (WF14b); the account at its cap mid-turn → Tiếp tục / Để sau (WF16f / WF16g). Every frame is shot
// light + dark at 1440 and 1024 into `.local/shots/v29-g6/` (gitignored) for the mockup check.
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { ORCH, PM, S, expect, test, useEngine } from '../fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SHOTS = join(ROOT, '.local', 'shots', 'v29-g6');
const PO = join(ROOT, 'engine', 'src', 'workflow', 'builtin', 'po');

type Step = Record<string, unknown>;
const RESULT: Step = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } };
const SAVE: Step = { mcp: { server: 'cc_draft', tool: 'draft_save', args: {} } };
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
/** the built-in PO pack renamed, one fake-claude Write per file */
const pkg = (name: string): Step[] => walk(PO).map((f) => {
  const path = relative(PO, f);
  const text = readFileSync(f, 'utf8');
  return { write: { path, text: path === 'WORKFLOW.md' ? text.replace(/^name: .*$/m, `name: ${name}`) : text } };
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(`v2.9 G6 soạn bằng lời (${theme})`, () => {
    test.use({ theme });
    const eng = useEngine({ scenarios: () => ({ [ORCH]: { steps: [...S.idle()] } }) });
    test.describe.configure({ mode: 'serial' });
    const author = (steps: Step[]) => eng.scenario('lane-pack', { steps: [...steps, ...S.idle()] });

    test.beforeAll(() => { mkdirSync(SHOTS, { recursive: true }); });

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
    const describe = async (page: Page, wf: Locator, text: string) => {
      await wf.getByRole('button', { name: 'Quy trình mới', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Quy trình mới' });
      await dlg.getByRole('textbox', { name: 'Mô tả quy trình muốn có' }).fill(text);
      return dlg;
    };
    const chat = (wf: Locator) => wf.locator('.achat');
    const discard = async (page: Page, wf: Locator) => {
      await wf.locator('section[data-draft]').getByRole('button', { name: 'Bỏ nháp', exact: true }).click();
      await page.getByRole('dialog', { name: 'Bỏ bản nháp?' }).getByRole('button', { name: 'Bỏ nháp', exact: true }).click();
      await expect(wf.locator('section[data-draft]')).toHaveCount(0);
    };

    test('T7 / WF14 → WF15a → WF16a → "lưu đi" WF16c → Hoàn tác reopens the draft → Bỏ nháp', async ({ page }) => {
      author([{ waitUser: true }, ...pkg('PO có Plan'), { sleep: 5000 }, { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Đã thêm bước Plan trước Build.' }] } } }, RESULT,
        { waitUser: 'lưu đi' }, SAVE, RESULT]);
      const wf = await open(page);
      const dlg = await describe(page, wf, 'Giống Quy trình PO nhưng thêm bước Plan trước Build');
      await expect(dlg).toContainText('tốn quota thật');
      await shot(page, 'WF14');
      await dlg.getByRole('button', { name: 'Tạo', exact: true }).click();
      await expect(chat(wf)).toHaveAttribute('data-state', 'running');
      await expect(wf.locator('section[data-draft] .wn').first()).toBeVisible();
      await expect(chat(wf).getByRole('button', { name: 'Dừng' })).toBeVisible();
      await expect(wf.locator('section[data-draft] .wtag').first()).toHaveText('mới');
      await expect(chat(wf).locator('.aact')).toHaveCount(1); // one activity line per turn, the pack path (never /private/var/…)
      await expect(chat(wf).locator('.aact')).toHaveText(/^đang viết steps\/[a-z-]+\.md…$/);
      await shot(page, 'WF15a');
      await expect(chat(wf)).toHaveAttribute('data-state', 'idle', { timeout: 15_000 });
      await expect(chat(wf)).toContainText('Đã thêm bước Plan trước Build.');
      await expect(wf.getByTestId('draft-status')).toContainText('0 lỗi');
      await expect(wf.locator('.wlib [data-draft-row]')).toContainText('nháp');
      await shot(page, 'WF16a');

      const box = chat(wf).getByRole('textbox');
      await box.fill('lưu đi');
      await box.press('Enter');
      await expect(chat(wf)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
      await expect(chat(wf)).toContainText('Đã lưu "PO có Plan"');
      await expect(chat(wf).getByRole('button', { name: 'Hoàn tác' })).toBeVisible();
      // WF16c the saved pack on the canvas (its own bar: Sửa bằng lời …), the closed chat beside it
      await expect(wf.locator('.wlib .lr[aria-current]')).toContainText('PO có Plan');
      await expect(wf.locator('section[data-draft]')).toHaveCount(0);
      await expect(wf.locator('.wtb .wnm')).toContainText('PO có Plan');
      await expect(chat(wf)).toContainText('chưa áp cho project nào');
      await shot(page, 'WF16c');

      await chat(wf).getByRole('button', { name: 'Hoàn tác' }).click();
      await expect(chat(wf)).toContainText('Đã hoàn tác — bản nháp mở lại');
      await expect(chat(wf)).toHaveAttribute('data-state', 'idle');
      await expect(wf.locator('.wlib .lr[data-row]', { hasText: 'PO có Plan' })).toHaveCount(0);
      await discard(page, wf);
    });

    test('WF2b Sửa bằng lời dims under a hand edit; T8 / WF15b → WF16d saves the edited pack by voice; WF16h after 30 s', async ({ page }) => {
      test.setTimeout(120_000);
      const wf = await open(page);
      await wf.getByRole('button', { name: 'Quy trình mới', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Quy trình mới' });
      await dlg.getByRole('listbox').getByRole('option').first().click();
      await dlg.getByRole('textbox', { name: 'Tên' }).fill('Gói riêng');
      await dlg.getByRole('button', { name: 'Nhân bản', exact: true }).click();
      await expect(wf.locator('.wlib .lr[aria-current]')).toContainText('Gói riêng');

      await wf.locator('.react-flow__node').filter({ has: page.locator('.nm', { hasText: 'Build' }) }).first().click();
      const ed = wf.locator('.wpp .cm-content');
      await ed.click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('\nThêm một dòng.');
      await ed.blur();
      await expect(wf.locator('.wtb')).toContainText('Chưa lưu');
      const edit = wf.getByRole('button', { name: 'Sửa bằng lời', exact: true });
      await expect(edit).toBeDisabled();
      await expect(edit).toHaveAttribute('title', 'Lưu hoặc bỏ thay đổi trước');
      await shot(page, 'WF2b');
      await wf.getByRole('button', { name: 'Lưu', exact: true }).click();
      await expect(wf.locator('.wtb')).not.toContainText('Chưa lưu');

      const steps = readdirSync(join(PO, 'steps'));
      const build = steps.find((s) => s.startsWith('build'))!;
      author([{ waitUser: true }, { write: { path: `steps/${build}`, text: `${readFileSync(join(PO, 'steps', build), 'utf8')}\nChạy lint trước khi xong.\n` } }, { sleep: 400 },
        { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Build giờ chạy lint trước khi xong.' }] } } }, RESULT,
        { waitUser: 'lưu đi' }, SAVE, RESULT]);
      await edit.click();
      await expect(chat(wf)).toHaveAttribute('data-state', 'pending');
      await shot(page, 'WF15b');
      const box = chat(wf).getByRole('textbox');
      await box.fill('Build chạy lint trước khi xong');
      await box.press('Enter');
      await expect(chat(wf)).toHaveAttribute('data-state', 'idle', { timeout: 15_000 });
      await expect(wf.locator('section[data-draft] .wtag', { hasText: 'đổi' })).toHaveCount(1);
      await box.fill('lưu đi');
      await box.press('Enter');
      await expect(chat(wf)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
      await expect(chat(wf)).toContainText('Đã lưu "Gói riêng"');
      await expect(wf.locator('section[data-draft]')).toHaveCount(0);
      await expect(wf.locator('.wlib .lr[aria-current]')).toContainText('Gói riêng');
      await shot(page, 'WF16d');
      await expect(chat(wf)).toContainText('Hết thời gian hoàn tác', { timeout: 40_000 });
      await expect(chat(wf).getByRole('button', { name: 'Hoàn tác' })).toHaveCount(0);
      await shot(page, 'WF16h');
    });

    test('WF16e a broken draft: Kiểm gói goes back 3 times, then the fix stops; Lưu stays dimmed', async ({ page }) => {
      author([{ waitUser: true }, { write: { path: 'WORKFLOW.md', text: '---\nname: Hỏng\n---\n' } }, { write: { path: 'notes.txt', text: 'x' } }, RESULT]);
      const wf = await open(page);
      const dlg = await describe(page, wf, 'Một gói hỏng');
      await dlg.getByRole('button', { name: 'Tạo', exact: true }).click();
      await expect(chat(wf)).toContainText('Đã thử sửa 3 lần', { timeout: 20_000 });
      await expect(chat(wf).locator('.asys', { hasText: 'Kiểm gói' })).toHaveCount(3);
      await expect(wf.getByTestId('draft-status')).toHaveText('1 thay đổi · 3 lỗi'); // the engine's count: the stray notes.txt (V11) too
      // v29-ux I4 the UI's words (step types by UI name, no file / key names); the engine text + file only on hover
      await expect(wf.locator('.wprob')).toContainText('Thư mục gói có file lạ hoặc quá lớn');
      await expect(wf.locator('.wprob')).toContainText('Gói cần đúng một bước Việc chung (đang có 0)');
      await expect(wf.locator('.wprob .pr', { hasText: 'file lạ' })).toHaveAttribute('title', /notes\.txt/);
      for (const raw of [/`/, /notes\.txt/, /bước general/]) {
        await expect(wf.locator('.wprob')).not.toContainText(raw);
        await expect(chat(wf).locator('.asys', { hasText: 'Kiểm gói' }).first()).not.toContainText(raw);
      }
      await expect(chat(wf).locator('.asys', { hasText: 'Kiểm gói' }).first()).toContainText('Gói cần đúng một bước Lane (đang có 0)');
      await expect(wf.locator('section[data-draft]').getByRole('button', { name: 'Lưu', exact: true })).toBeDisabled();
      await shot(page, 'WF16e');
      // v29-fx3 shot: at 1024 beside the chat the Kiểm gói head stays one line (the count truncates, never wraps out of the 32 px row)
      await page.setViewportSize({ width: 1024, height: 640 });
      const head = wf.locator('.wprob .ph2');
      await expect.poll(() => head.evaluate(e => e.scrollHeight <= e.clientHeight && e.getBoundingClientRect().height <= 33)).toBe(true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await discard(page, wf);
    });

    test('WF14b 3 drafts open: Tạo and Sửa bằng lời dim with the reason', async ({ page }) => {
      author([]);
      for (const t of ['một', 'hai', 'ba']) await eng.cmd({ cmd: 'workflow_draft_start', fromId: null, text: t });
      const wf = await open(page);
      await expect(wf.locator('.wlib [data-draft-row]')).toHaveCount(3);
      await wf.getByRole('button', { name: 'Quy trình mới', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Quy trình mới' });
      await expect(dlg).toContainText('Đang có 3 bản nháp — lưu hoặc bỏ bớt');
      await expect(dlg.getByRole('textbox', { name: 'Mô tả quy trình muốn có' })).toBeDisabled();
      await expect(dlg.getByRole('button', { name: 'Tạo', exact: true })).toBeDisabled();
      await shot(page, 'WF14b');
      await page.keyboard.press('Escape');
      for (let i = 0; i < 3; i++) {
        await wf.locator('.wlib [data-draft-row]').first().click();
        await discard(page, wf);
      }
    });

    test('WF16f the account hits its cap mid-turn → Tiếp tục / Để sau; WF16g after Để sau the turn stops', async ({ page }) => {
      author([{ waitUser: true }, ...pkg('Hết quota'), S.rateLimit('seven_day', 1), { sleep: 30_000 }, RESULT]);
      const wf = await open(page);
      const dlg = await describe(page, wf, 'Gói sẽ hết quota');
      await dlg.getByRole('button', { name: 'Tạo', exact: true }).click();
      await expect(chat(wf)).toHaveAttribute('data-state', 'quota', { timeout: 15_000 });
      await expect(chat(wf)).toContainText(`Account ${ORCH} hết quota — đổi sang ${PM} (còn 90 %) và tiếp tục?`);
      await expect(chat(wf).locator('.aact')).toHaveCount(0); // the stopped turn's activity line went
      await expect(chat(wf).getByRole('button', { name: 'Tiếp tục' })).toBeVisible();
      await expect(wf.locator('section[data-draft]').getByRole('button', { name: 'Lưu', exact: true })).toBeDisabled();
      await shot(page, 'WF16f');
      await chat(wf).getByRole('button', { name: 'Để sau' }).click();
      await expect(chat(wf)).toContainText('Lượt đã dừng');
      await expect(chat(wf)).toHaveAttribute('data-state', 'idle');
      await expect(wf.locator('section[data-draft]').getByRole('button', { name: 'Lưu', exact: true })).toBeEnabled();
      await shot(page, 'WF16g');
      await discard(page, wf);
    });
  });
}
