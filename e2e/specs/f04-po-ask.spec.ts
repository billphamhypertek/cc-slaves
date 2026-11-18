// F4 (§6.4): a lane's po_ask → card in "Chờ PO" (Đề xuất first) → one click (T2 = 1) → "Đã chọn … · Hoàn tác (5)" →
// undo restores the card → choose again → after 5 s the lane receives "[cc-slaves] PO trả lời #<id>: …".
import { expect, ORCH, PM, recordBudget, S, settle, test, useEngine } from '../fixtures.ts';

const eng = useEngine({
  scenarios: (e) => ({
    [ORCH]: { steps: [...S.turn('Sẵn sàng'), ...S.startLane(e, 'D2'), ...S.idle()] },
    [PM]: { steps: [
      S.wait,
      S.mcp('po_ask', { question: 'Tách B2 thành hai PR hay gộp?', options: [{ label: 'Gộp' }, { label: 'Tách', description: 'dễ review' }], recommended: 'Tách', context: 'B2 sửa 14 file' }),
      S.assistant('Đã hỏi PO, chờ trả lời'), S.result(),
      ...S.turn('Đã nhận câu trả lời'), ...S.idle(),
    ] },
  }),
});

test('F4 po_ask card → answer with undo → the lane gets "PO trả lời #id"', async ({ page }) => {
  const pid = await eng.addProject('shop');
  await page.goto(eng.url());
  await eng.openLane(pid, 'D2', 'waiting_po'); // §7.4: an open card holds the lane in Chờ PO
  // v2.4 §6.7 D52: one row (the question, "›"); the options live in the detail box
  const q = page.locator('#inbox').locator('.card', { hasText: 'Tách B2 thành hai PR hay gộp?' });
  await expect(q).toBeVisible();
  // the undo row swaps the question for "Đã chọn …", so pin the row by its card id
  const card = page.locator(`#inbox .card[data-id="${await q.getAttribute('data-id')}"]`);
  await expect(card.getByRole('button', { name: 'Xem chi tiết' })).toBeVisible();
  const box = page.locator('#cardbox');
  const opts = box.locator('button.opt');

  await settle(page);
  await card.click(); // T2 step 1: open
  await expect(opts.first()).toContainText('Tách'); // recommended first, labelled
  await expect(opts.first().locator('.tag')).toHaveText('Đề xuất'); // the tag alone marks it, no accent outline (v28-fx)
  await opts.first().click(); // T2 step 2: choose → the box closes, the row shows the undo
  await expect(box).toHaveCount(0);
  await expect(card).toContainText('Hoàn tác (');
  await card.getByRole('button', { name: /Hoàn tác/ }).click();
  await expect(card.getByRole('button', { name: 'Xem chi tiết' })).toBeVisible();

  await settle(page);
  await card.click();
  await page.keyboard.press('Alt+2'); // §6.7 I2 ⌥n inside the open box (Gộp = option 2)
  await expect(box).toHaveCount(0);
  await expect(card).toContainText('Đã chọn “Gộp”');
  await expect(card).toContainText('Hoàn tác (1)', { timeout: 6_000 }); // §4.11b N1-k the last card keeps its full 5 s undo
  await expect.poll(() => eng.read(`stdin-${PM}.log`), { timeout: 12_000 }).toMatch(/\[cc-slaves\] PO trả lời #\d+: Gộp/);
  // §4.11b then the block folds to one line; "Đã xử lý 1 ▸" reopens the answered row; its box says what was answered
  await page.locator('#inbox.line').getByRole('button', { name: /Đã xử lý 1/ }).click();
  await expect(card).toContainText('Gộp');
  await card.click();
  await expect(box).toContainText('Đã trả lời: Gộp');
  recordBudget('T2 trả lời câu hỏi, ngồi Mac', 2, 2);
});
