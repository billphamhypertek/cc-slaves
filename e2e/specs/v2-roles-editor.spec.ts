// T9b ⑥ (v2 §6 A2, §6.12 F12): Settings › Account with 5 accounts — the "Sửa vai trò & ngưỡng" editor shows every row.
// Its table box must not be squeezed by the flex column of the Settings body (it was 85 px with a scrollbar of its own):
// the body scrolls, every row can be scrolled into the visible body area, and the table box is as tall as its rows
// (up to the panel limit). Both window sizes the app supports.
import { expect, test, useEngine } from '../fixtures.ts';

const EMAILS = ['o@x.test', 'p1@x.test', 'p2@x.test', 'p3@x.test', 'b1@x.test'];
const eng = useEngine({
  accounts: EMAILS,
  caps: { default: { week: 98, five: 95 }, 'o@x.test': { role: 'orchestrator', week: 99 }, 'b1@x.test': { role: 'backup', week: 98 } },
});

for (const vp of [{ width: 1280, height: 800 }, { width: 1024, height: 640 }]) {
  test(`T9b ⑥ roles editor at ${vp.width}×${vp.height}: all ${EMAILS.length} rows visible or reachable, no squeezed table box`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto(eng.url());
    await expect(page.locator('#inspector, .deck, #top').first()).toBeVisible();
    await page.keyboard.press('Meta+Comma');
    const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
    await dlg.getByRole('tab', { name: /Account/ }).click();
    await dlg.getByRole('button', { name: 'Sửa vai trò & ngưỡng' }).click();
    const body = dlg.locator('.sbody');
    const wrap = dlg.locator('.tw-wrap').filter({ has: page.getByRole('columnheader', { name: 'Ngưỡng tuần' }) });
    const rows = wrap.locator('tbody tr');
    await expect(rows).toHaveCount(EMAILS.length);

    const m = await wrap.evaluate((w) => {
      const b = w.closest('.sbody')!;
      const trs = [...w.querySelectorAll('tbody tr')] as HTMLElement[];
      return {
        wrapH: w.clientHeight, wrapScrollH: w.scrollHeight, bodyH: b.clientHeight,
        need: (w.querySelector('thead') as HTMLElement).offsetHeight + trs.reduce((s, r) => s + r.offsetHeight, 0),
      };
    });
    expect(m.wrapScrollH, 'the table box has no vertical scroll of its own').toBeLessThanOrEqual(m.wrapH + 1);
    expect(m.wrapH, 'table box ≥ header + rows, up to the panel limit').toBeGreaterThanOrEqual(Math.min(m.need, m.bodyH) - 1);

    for (const email of EMAILS) {
      const r = rows.filter({ hasText: email });
      await r.scrollIntoViewIfNeeded();
      const [rb, bb] = [await r.boundingBox(), await body.boundingBox()];
      expect(rb && bb, email).toBeTruthy();
      expect(rb!.y, `${email} top inside the visible body`).toBeGreaterThanOrEqual(bb!.y - 1);
      expect(rb!.y + rb!.height, `${email} bottom inside the visible body`).toBeLessThanOrEqual(bb!.y + bb!.height + 1);
      await expect(dlg.getByLabel(`Ngưỡng tuần ${email}`)).toBeInViewport();
    }
  });
}
