// F7 (§6.7, §7.4): three abnormal deaths in a row → lane Hỏng + card "Lane D2 hỏng" with Chạy lại / Xem log /
// Giao điều phối xử lý; "Xem log" retargets the console without resolving; "Chạy lại" resumes the lane.
// Retry delays (20 s, 60 s) are scaled by E2E_LANE_TIME_SCALE.
import { expect, ORCH, PM, S, settle, test, useEngine } from '../fixtures.ts';

const eng = useEngine({
  env: { E2E_LANE_TIME_SCALE: '0.02' },
  scenarios: (e) => ({
    [ORCH]: { steps: [...S.turn('Sẵn sàng'), ...S.startLane(e, 'D2'), ...S.idle()] },
    [PM]: { steps: [S.wait, S.partial('đang làm'), { die: { partial: '{"type":"assis' } }] },
  }),
});

test('F7 broken after 3 deaths → "Chạy lại" resumes', async ({ page }) => {
  const pid = await eng.addProject('shop');
  await page.goto(eng.url());
  await eng.openLane(pid, 'D2', 'broken');
  // v2.4 §6.7 D52: the row "D2 Hỏng: <last line>" with 📄 Xem log · ↻ Chạy lại; the box has every button
  const card = page.locator('#inbox .card.bad', { hasText: 'Hỏng:' });
  await expect(card).toBeVisible();
  await expect(card.locator('.src')).toHaveText('D2');
  for (const b of ['Xem log', 'Chạy lại']) await expect(card.getByRole('button', { name: b })).toBeVisible();
  expect((await eng.snapshot()).lanes.find((l) => l.name === 'D2')?.failCount).toBe(3);
  await settle(page);
  await card.click();
  const box = page.locator('#cardbox');
  await expect(box).toContainText('Lane D2 hỏng');
  for (const b of ['Chạy lại', 'Xem log', 'Giao điều phối xử lý']) await expect(box.getByRole('button', { name: b })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);

  await settle(page);
  await card.getByRole('button', { name: 'Xem log' }).click();
  await expect(page.locator('#inspector')).toContainText('D2');
  await expect(card).toBeVisible(); // view_log never resolves the card

  eng.scenario(PM, { steps: S.idle() }); // the next spawn works
  await settle(page);
  await card.getByRole('button', { name: 'Chạy lại' }).click();
  await expect.poll(async () => (await eng.health()).lanes.find((l) => l.name === 'D2')?.state, { timeout: 15_000 }).toBe('idle');
  await expect(page.locator('#inbox .card', { hasText: 'Hỏng:' }).getByRole('button', { name: 'Chạy lại' })).toHaveCount(0);
});
