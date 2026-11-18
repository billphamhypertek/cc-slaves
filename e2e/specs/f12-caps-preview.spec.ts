// F12 (§6.12, D11): Cài đặt → Account: lowering pm@'s week cap under its usage shows, before saving, which running lane
// would leave and where it resumes; Lưu applies it (idle lane: moves before its next message, §7.4). T9 budget ≤ 5 (⌘, → tab → Sửa vai trò & ngưỡng → edit → Lưu = 5).
import { B2, expect, ORCH, PM, recordBudget, S, test, useEngine } from '../fixtures.ts';

const eng = useEngine({
  seed: { [ORCH]: { fivePct: 10, weekPct: 10 }, [PM]: { fivePct: 20, weekPct: 40 }, [B2]: { fivePct: 5, weekPct: 10 } },
  scenarios: (e) => ({ [ORCH]: { steps: [...S.turn('Sẵn sàng'), ...S.startLane(e, 'D2'), ...S.idle()] } }),
});

test('F12 caps edit shows the preview line, Lưu moves the lane', async ({ page }) => {
  const pid = await eng.addProject('shop');
  await eng.openLane(pid, 'D2', 'idle');
  await page.goto(eng.url());
  await expect(page.locator('#inspector')).toBeVisible();
  let steps = 0;
  await page.keyboard.press('Meta+Comma'); steps++;
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('tab', { name: /Account/ }).click(); steps++;
  await dlg.getByRole('button', { name: 'Sửa vai trò & ngưỡng' }).click(); steps++; // v2 §6 A2: the editor opens on demand
  const week = dlg.getByLabel(`Ngưỡng tuần ${PM}`);
  await week.fill('30'); steps++;
  await expect(dlg.locator('.preview')).toContainText('Lưu sẽ khiến D2 rời pm@ ở lần nhắn kế — pm@ đang 40 %, ngưỡng mới 30 %. D2 sẽ resume trên b2@ (còn 88 %).');
  await dlg.getByRole('button', { name: 'Lưu' }).click(); steps++;
  await expect(dlg).toBeHidden();
  await expect.poll(async () => (await eng.snapshot()).accounts.find((a) => a.email === PM)?.week, { timeout: 10_000 }).toBe(30);
  // §7.4 Rảnh × cap hit = "chuyển trước lần nhắn kế": the next message resumes D2 on b2@
  await eng.cmd({ cmd: 'send', target: { kind: 'lane', projectId: pid, name: 'D2' }, text: 'tiếp tục' });
  await expect.poll(async () => (await eng.snapshot()).lanes.find((l) => l.name === 'D2')?.account, { timeout: 15_000 }).toBe(B2);
  await expect.poll(() => eng.read(`stdin-${B2}.log`)).toContain('[PO] tiếp tục');
  recordBudget('T9 sửa ngưỡng', steps, 5);
});

test('§7 D18 F12 › Project has no permission-mode selector (every session skips permissions)', async ({ page }) => {
  await eng.addProject('vault');
  await page.goto(eng.url());
  await expect(page.locator('#inspector')).toBeVisible();
  await page.keyboard.press('Meta+Comma');
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  await dlg.getByRole('tab', { name: 'Project' }).click();
  await expect(dlg.getByText('vault', { exact: true })).toBeVisible();
  await expect(dlg.getByLabel('Chế độ quyền vault')).toHaveCount(0);
  await expect(dlg.locator('select')).toHaveCount(0);
  await expect(dlg).not.toContainText('bypassPermissions');
});
