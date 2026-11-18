// F15 (§6.15): "D2 xin chạy: Bash `rm -rf build/`" · Cho phép / Cho phép luôn (suggestions sent) / Từ chối · undo 5 s ·
// allow reaches the session's stdin; a request left unanswered expires → "Đã hết hạn — session đã nhận Từ chối"
// (TTL shortened to 10 s through E2E_PERMISSION_TTL_MS), and the session got a deny with the reason.
import { expect, ORCH, PM, recordBudget, S, settle, test, useEngine } from '../fixtures.ts';

const permission = {
  permission: {
    tool_name: 'Bash', input: { command: 'rm -rf build/', description: 'Xoá thư mục build' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build/' }], behavior: 'allow', destination: 'session' }],
  },
  allow: [S.assistant('Đã xoá build/'), S.result()],
  deny: [S.assistant('Bị từ chối, bỏ qua'), S.result()],
};

const eng = useEngine({
  env: { E2E_PERMISSION_TTL_MS: '10000' },
  scenarios: (e) => ({
    [ORCH]: { steps: [...S.turn('Sẵn sàng'), ...S.startLane(e, 'D2'), ...S.startLane(e, 'D3'), ...S.idle()] },
    [PM]: { steps: [S.wait, permission, ...S.idle()] },
  }),
});

test('F15 permission allow (1 click + undo window) and expiry text', async ({ page }) => {
  const pid = await eng.addProject('shop');
  await page.goto(eng.url());
  await eng.openLane(pid, 'D2', 'running'); // a pending permission keeps the turn running
  const inbox = page.locator('#inbox');
  // v2.4 §6.7 D52: the row "D2 Bash rm -rf build/" with ✓ / ✕; "Cho phép luôn" + the reason live in the box
  const perm = inbox.locator('.card', { hasText: 'rm -rf build/' });
  await expect(perm.locator('.src')).toHaveText('D2');
  const d2 = inbox.locator(`.card[data-id="${await perm.getAttribute('data-id')}"]`); // the undo row swaps the command text
  const box = page.locator('#cardbox');
  await settle(page);
  await d2.getByRole('button', { name: 'Cho phép', exact: true }).click(); // allow from the row: 1 click
  await expect(d2).toContainText('Hoàn tác (');
  await d2.getByRole('button', { name: /Hoàn tác/ }).click(); // undo → the row is back
  await expect(d2.getByRole('button', { name: 'Từ chối', exact: true })).toBeVisible();
  await settle(page);
  await d2.click(); // answer again from the box
  await expect(box).toContainText('D2 xin chạy: Bash');
  await expect(box.getByRole('button', { name: /Cho phép luôn trong phiên này/ })).toBeVisible();
  await expect(box.getByRole('textbox', { name: 'Lý do từ chối' })).toBeVisible();
  await box.getByRole('button', { name: /^Cho phép\s*⌥1/ }).click();
  await expect(box).toHaveCount(0);
  await expect(d2).toContainText('Hoàn tác (');
  await expect.poll(() => eng.read(`stdin-${PM}.log`), { timeout: 12_000 }).toContain('"behavior":"allow"');
  await expect.poll(async () => (await eng.health()).lanes.find((l) => l.name === 'D2')?.state, { timeout: 10_000 }).toBe('idle');
  recordBudget('F15 cho phép (click)', 1, 1);

  await eng.openLane(pid, 'D3', 'running');
  const d3 = inbox.locator('.card', { hasText: 'D3' });
  await expect(d3).toBeVisible();
  // §4.11b nothing pending after the expiry → one line; "Đã xử lý 2 ▸" reopens the expired card
  await page.locator('#inbox.line').getByRole('button', { name: /Đã xử lý 2/ }).click({ timeout: 20_000 });
  await expect(d3).toContainText('Đã hết hạn');
  await d3.click();
  await expect(page.locator('#cardbox')).toContainText('session đã nhận Từ chối');
  await expect.poll(() => eng.read(`stdin-${PM}.log`)).toContain('PO chưa trả lời trong 30 phút');
});
