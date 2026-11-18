// F22 (§8.5): ⌘K → type "dừng an toàn" → Enter → confirm → stop_all: every lane gets the drain message and ends Đã dừng;
// the orchestrator is never drained (§6.20).
import { expect, ORCH, recordBudget, S, test, useEngine } from '../fixtures.ts';

const eng = useEngine({
  scenarios: (e) => ({ [ORCH]: { steps: [...S.turn('Sẵn sàng'), ...S.startLane(e, 'D2'), ...S.idle()] } }),
});

test('F22 ⌘K runs "Dừng an toàn"', async ({ page }) => {
  const pid = await eng.addProject('shop');
  await eng.openLane(pid, 'D2', 'idle');
  await page.goto(eng.url());
  await expect(page.locator('#inspector')).toBeVisible();
  let confirmText = '';
  page.on('dialog', (d) => { confirmText = d.message(); void d.accept(); });
  await page.keyboard.press('Meta+k');
  const pal = page.getByRole('dialog', { name: 'Bảng lệnh' });
  await pal.getByLabel('Tìm hành động, lane, project').fill('dừng an toàn');
  await expect(pal).toContainText('Dừng an toàn tất cả lane');
  await page.keyboard.press('Enter');
  await expect.poll(() => confirmText).toContain('Dừng an toàn tất cả lane?');
  await expect.poll(async () => (await eng.health()).lanes.find((l) => l.name === 'D2')?.state, { timeout: 15_000 }).toBe('stopped');
  expect(eng.read('stdin-pm@x.test.log')).toContain('Dừng an toàn: không nhận task mới');
  expect(eng.read(`stdin-${ORCH}.log`)).not.toContain('Dừng an toàn: không nhận task mới');
  expect((await eng.snapshot()).orchestrators[0]?.state).toBe('idle');
  recordBudget('F22 ⌘K dừng an toàn (click; phím ⌘K + gõ + Enter + xác nhận)', 0, 0);
});
