// F5 (§6.5, §3.4): a lane on pm@ (soft week cap 99) reads rate_limit_event 99.5 % → at the end of its turn it moves to
// the backup account and resumes the same session; toast "… D2 chuyển sang b2@…"; the lane node and the account panel follow.
import { B2, expect, ORCH, PM, S, test, useEngine } from '../fixtures.ts';

const eng = useEngine({
  scenarios: (e) => ({
    [ORCH]: { steps: [...S.turn('Sẵn sàng'), ...S.startLane(e, 'D2'), ...S.idle()] },
    [PM]: { steps: [S.wait, S.assistant('Đang làm B2'), S.rateLimit('seven_day', 0.995), S.sleep(300), S.result(), ...S.idle()] },
    [B2]: { steps: S.idle() },
  }),
});

test('F5 switch account on rate-limit (toast + account)', async ({ page }) => {
  const pid = await eng.addProject('shop');
  await page.goto(eng.url());
  await eng.openLane(pid, 'D2', 'idle').catch(() => {}); // may already be switching
  await expect(page.locator('#toasts')).toContainText('D2 chuyển sang b2@x.test', { timeout: 15_000 });
  await expect.poll(async () => (await eng.snapshot()).lanes.find((l) => l.name === 'D2')?.account, { timeout: 15_000 }).toBe(B2);
  const snap = await eng.snapshot();
  expect(snap.accounts.find((a) => a.email === PM)?.weekPct).toBeGreaterThanOrEqual(99);
  expect(snap.lanes.find((l) => l.name === 'D2')?.switches).toBeGreaterThanOrEqual(1);
  expect(eng.read(`stdin-${B2}.log`)).not.toBe(''); // the session resumed on b2
  // v2.1 §6: the account is read from the lane node (D2 line 1 shows its account) and the account panel row (b2@ now carries D2)
  await expect(page.locator('.react-flow__node[data-id="lane:D2"] .acct')).toContainText('b2');
  await page.keyboard.press('a');
  await expect(page.locator('.accp.open .acrow[data-email="b2@x.test"]')).toContainText('D2');
});
