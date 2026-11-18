// v2.8 §4.10 (LT15) the v2.7.1 split button and start / step dialogs in light and dark: the ▾ focus is the §4.2 inset `--fg-2`
// ring (not an offset outline), the dialog's primary button carries the L10 outer ring. Shots (1440×900) go to
// .e2e-results/v28-lt15/<scheme>-<frame>.png for the side-by-side check with the LT15 mockup.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, useEngine } from '../fixtures.ts';
import { fakeTauri } from '../v21-seed.ts';

test.use({ tasksStart: true });
const eng = useEngine();
const INSET = /^rgb\([^)]+\) 0px 0px 0px 1px inset$/;
const SPEC = `${'Nội dung spec để engine nhận vào. '.repeat(12)}\n`;

async function specProject(page: Page, name: string): Promise<void> {
  const pid = await eng.addProject(name);
  mkdirSync(join(eng.repo(name), 'docs/specs'), { recursive: true });
  const path = `docs/specs/v1-${name}.md`;
  writeFileSync(join(eng.repo(name), path), `# v1 ${name}\n\n**Status:** approved\n\n${SPEC}`);
  await eng.cmd({ cmd: 'spec_scan', projectId: pid });
  const spec = (await eng.snapshot()).issues?.find(x => x.projectId === pid)?.specs.find(s => s.path === path);
  await page.addInitScript(([p, sel]) => localStorage.setItem('ccs.tasks', JSON.stringify({ [p]: { sel, issue: null } })), [pid, { spec: spec!.id }] as const);
  await page.goto(eng.url());
  await page.locator('nav.tabs .tab', { hasText: name }).click();
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`LT15 ${scheme}`, () => {
    test.use({ theme: scheme });
    test.beforeEach(async ({ page }) => { await fakeTauri(page); });
    test(`split ▾ keyboard focus = inset --fg-2 ring; start dialog primary = L10 outer ring (${scheme})`, async ({ page }) => {
      const shot = (n: string) => page.screenshot({ path: `.e2e-results/v28-lt15/${scheme}-${n}.png`, animations: 'disabled' });
      await specProject(page, `p${scheme}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      const dd = page.getByRole('article', { name: `v1 p${scheme}` }).locator('.split').first().locator('.sdd');
      await dd.focus(); // the last input was a mouse click: re-enter by keyboard so :focus-visible holds
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(dd).toBeFocused();
      const ring = await dd.evaluate(e => { const s = getComputedStyle(e);
        return { shadow: s.boxShadow, outline: s.outlineStyle }; });
      expect(ring.shadow).toMatch(INSET);
      expect(ring.outline).toBe('none');
      await shot('split-focus');
      await dd.hover();
      await shot('split-hover');
      await dd.click();
      const pri = page.getByRole('dialog').locator('.btn.pri');
      await pri.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(pri).toBeFocused();
      expect(await pri.evaluate(e => getComputedStyle(e).boxShadow)).toMatch(/^rgb.* 0px 0px 0px 1px, rgb.* 0px 0px 0px 2px$/);
      // the start dialog's fields sit on --fld-bg: white in light, the old --panel-2 in dark
      const bg = await page.getByRole('dialog').locator('.apick').evaluate(e => getComputedStyle(e).backgroundColor);
      expect(bg).toBe(scheme === 'light' ? 'rgb(255, 255, 255)' : 'rgba(19, 30, 51, 0.92)');
      await shot('SA1');
      await page.keyboard.press('Escape');
      eng.slowBoot(3000);
      try {
        await page.getByRole('article', { name: `v1 p${scheme}` }).locator('.split').first().locator('.tbtn').click();
        await expect(page.getByRole('dialog').locator('.sst').nth(1)).toHaveClass(/st-run/, { timeout: 5000 });
        await shot('SA3');
      } finally { eng.slowBoot(0); }
    });
  });
}
