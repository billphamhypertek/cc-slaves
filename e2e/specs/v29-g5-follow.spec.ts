// v2.9 §4.1 / §4.6 / §4.7 on the real engine: the Tasks rail carries the workflow chip (Quy trình PO), its menu lists the
// built-ins with ✓ on the one applied, another one opens the Áp dụng box (mini chain + impact), Áp dụng sends
// `project_set_workflow` (no Chung restart, ruling 22:36) and the rail follows the pack: Giao thẳng = only "Việc", no
// "+ Spec mới"; Spec + Plan back = the doc groups again. The effective-config line sits in the Điều phối head (Deck).
import { expect, ORCH, S, test, useEngine } from '../fixtures.ts';

test.use({ tasksStart: true });
const eng = useEngine({ scenarios: () => ({ [ORCH]: { steps: [...S.idle()] } }) });

test('§4.6 chip → Giao thẳng → Áp dụng: rail = only Việc; back to Spec + Plan; Chung not restarted; §4.7 the line on the Deck', async ({ page }) => {
  const pid = await eng.addProject('shop');
  const sid = (await eng.snapshot()).orchestrators.find(o => o.projectId === pid)?.sessionId;
  await page.goto(eng.url());
  const tasks = page.locator('#tasks');
  const chip = tasks.getByRole('button', { name: 'Quy trình PO' });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('title', 'Quy trình của project');

  await chip.click();
  const menu = page.getByRole('menu', { name: 'Quy trình cho shop' });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(3);
  await expect(menu.getByRole('menuitemradio', { name: /Quy trình PO/ })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: /Giao thẳng/ }).click();

  const box = page.getByRole('dialog', { name: 'Áp quy trình "Giao thẳng" cho project shop?' });
  await expect(box).toBeVisible();
  await expect(box).toContainText('Tài liệu mới và phiên Chung theo quy trình mới.');
  // WF6b on a new (empty) project the box sits in the centred empty state: it keeps the dialog look and reads left (v29-ux M1)
  await expect(box.locator('h2')).toHaveCSS('text-align', 'left');
  expect(await box.evaluate(e => getComputedStyle(e).borderTopLeftRadius)).not.toBe('0px');
  await box.getByRole('button', { name: 'Áp dụng' }).click();
  await expect(box).toBeHidden();
  await expect(tasks.getByRole('button', { name: 'Giao thẳng' })).toBeVisible();
  await expect.poll(async () => (await eng.snapshot()).projects.find(x => x.id === pid)?.workflow).toBe('builtin:direct');
  await expect(tasks.getByRole('button', { name: /Spec mới/ })).toHaveCount(0);

  // back to a doc pack: Huỷ leaves it, Áp dụng applies it
  await tasks.getByRole('button', { name: 'Giao thẳng' }).click();
  await page.getByRole('menuitemradio', { name: /Spec \+ Plan/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Huỷ' }).click();
  await expect(tasks.getByRole('button', { name: 'Giao thẳng' })).toBeVisible();
  await tasks.getByRole('button', { name: 'Giao thẳng' }).click();
  await page.getByRole('menuitemradio', { name: /Spec \+ Plan/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Áp dụng' }).click();
  await expect(tasks.getByRole('button', { name: 'Spec + Plan' })).toBeVisible();
  await expect.poll(async () => (await eng.snapshot()).projects.find(x => x.id === pid)?.workflow).toBe('builtin:spec-plan');
  expect((await eng.snapshot()).orchestrators.find(o => o.projectId === pid)?.sessionId).toBe(sid);

  // §4.1 "Xem quy trình này" opens the Quy trình screen on the applied pack; "Quản lý quy trình…" on the library (first row)
  await tasks.getByRole('button', { name: 'Spec + Plan' }).click();
  await page.getByRole('menuitem', { name: 'Xem quy trình này' }).click();
  const wf = page.locator('.wf');
  await expect(wf.locator('.wlib .lr[aria-current]')).toContainText('Spec + Plan');
  await expect(wf.locator('.wtb .wnm')).toContainText('Spec + Plan');
  await page.keyboard.press('Escape');
  await expect(wf).toHaveCount(0);
  await tasks.getByRole('button', { name: 'Spec + Plan' }).click();
  await page.getByRole('menuitem', { name: 'Quản lý quy trình…' }).click();
  await expect(wf.locator('.wlib .lr[aria-current]')).toContainText('Quy trình PO');
  await page.keyboard.press('Escape');
  await expect(wf).toHaveCount(0);

  await page.keyboard.press('d');
  await expect(page.locator('#left .wfl')).toHaveText(/^Quy trình PO · .+ · bản [0-9a-f]{6}$/);
});
