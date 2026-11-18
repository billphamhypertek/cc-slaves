// F3 (§6.3): T3 "ra lệnh điều phối" = type + Enter; the reply streams (partial, then the assistant line); a message
// sent while the turn runs shows "đã gửi vào lượt đang chạy" (engine echo with inTurn, §3.3-5).
import { expect, ORCH, recordBudget, S, test, useEngine } from '../fixtures.ts';

const eng = useEngine({
  scenarios: {
    [ORCH]: { steps: [...S.turn('Sẵn sàng'), S.wait, S.partial('Đang chia việc'), S.sleep(1500), S.assistant('Đã nhận: chia B2 thành hai lane'), S.result(), ...S.idle()] },
  },
});

test('F3 send to the orchestrator, the reply streams; a second message joins the running turn', async ({ page }) => {
  await eng.addProject('shop');
  await page.goto(eng.url());
  const input = page.getByLabel('Ô lệnh');
  await expect(input).toBeVisible();
  await input.click(); // focus only; T3 counts keys (Enter + type + Enter)
  await input.fill('chia B2 giúp anh');
  await input.press('Enter');
  const con = page.locator('#inspector');
  await expect(con.locator('.m-po').filter({ hasText: 'chia B2 giúp anh' })).toBeVisible();
  await expect(con).toContainText('Đang chia việc'); // M16 partial while the turn runs
  await input.fill('nhớ chạy test');
  await input.press('Enter');
  // v2.4 §6.3 DK7: the note sits on the who line ("Bạn · 14:27 · đã gửi vào lượt đang chạy")
  await expect(con.locator('.m-po').filter({ hasText: 'nhớ chạy test' }).locator('.m-who')).toHaveText(/^Bạn · \d\d:\d\d · đã gửi vào lượt đang chạy$/);
  await expect(con.locator('.m-po').filter({ hasText: 'chia B2 giúp anh' }).locator('.m-who')).not.toContainText('lượt đang chạy');
  await expect(con).toContainText('Đã nhận: chia B2 thành hai lane');
  expect(eng.read(`stdin-${ORCH}.log`)).toContain('[PO] chia B2 giúp anh');
  recordBudget('T3 ra lệnh điều phối (click)', 0, 0);
});
