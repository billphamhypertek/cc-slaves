// F9 (v2.1 §4.8, N4-k): "Chế độ danh sách" = one lane table (LANE · VIỆC · TRẠNG THÁI · ACCOUNT · CHI PHÍ), rows in R1 order
// (Chờ PO first), the blocking question in VIỆC, no Chờ PO / Account board; one click on the list button (T4 parity), L toggles back.
import { expect, ORCH, recordBudget, S, test, useEngine } from '../fixtures.ts';

const eng = useEngine({
  scenarios: (e) => ({
    [ORCH]: { steps: [...S.turn('Sẵn sàng'), ...S.startLane(e, 'D2'), ...S.startLane(e, 'D3'), ...S.startLane(e, 'D4'), ...S.idle()] },
    'lane-D2': { steps: [S.wait, S.mcp('po_ask', { question: 'Gộp migration không?', options: [{ label: 'Có' }, { label: 'Không' }] }), S.result(), ...S.idle()] },
    'lane-D3': { steps: S.idle() },
    'lane-D4': { steps: [S.wait, S.assistant('Đang chạy test dài'), S.sleep(120_000), S.result()] },
  }),
});

test('§4.8 N4-k F9 list mode = one lane table in R1 order', async ({ page }) => {
  const pid = await eng.addProject('shop');
  await eng.openLane(pid, 'D2', 'waiting_po');
  await eng.openLane(pid, 'D3', 'idle');
  await eng.openLane(pid, 'D4', 'running');
  await page.goto(eng.url());
  await page.getByRole('button', { name: 'Chế độ danh sách' }).click();
  const list = page.locator('#listview');
  await expect(list).toBeVisible();
  await expect(list.locator('th')).toHaveText(['', 'Lane', 'Việc', 'Trạng thái', 'Account', 'Chi phí', '']);
  await expect(list.locator('tbody tr td.nm')).toHaveText(['D2', 'D4', 'D3']); // Chờ PO · Đang làm · Rảnh
  await expect(list.locator('tbody tr').first().locator('td.wk')).toContainText('Gộp migration không?');
  await expect(list.locator('tbody tr').first().locator('td.st')).toHaveText('Chờ PO');
  // R43 M3 D53 density: lane rows 28 px (--h-ctl), the head 24 px (--h-ctl-sm), as every other list
  expect((await list.locator('tbody tr').first().boundingBox())!.height).toBeLessThanOrEqual(30);
  expect((await list.locator('thead th').first().boundingBox())!.height).toBeLessThanOrEqual(25);
  await expect(list.locator('.board')).toHaveCount(0); // §4.8 the left column keeps Chờ PO; no second copy
  await list.locator('tbody tr', { hasText: 'D4' }).click();
  await expect(list.locator('tbody tr.on td.nm')).toHaveText('D4'); // row click = select the lane like a node click
  recordBudget('F9 mở chế độ danh sách', 1, 1);
  await page.keyboard.press('l');
  await expect(list).toBeHidden();
});
