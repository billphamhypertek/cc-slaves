// v2.4 §10.3 budgets on the real engine with fake-claude, measured in the page with `performance.now()`: from the input (the
// paste event dispatched / the Enter keydown / the chip pointerdown, captured on `window`) to the first animation frame after
// the expected node is in the DOM. Each test prints its number ("§10.3 <what> <ms> ms"); the lane report takes the median of
// `--repeat-each=5`. Budgets: paste one 2 MB image → chip ≤ 100 ms; Enter with 5 × 2 MB images → the `po` line ≤ 300 ms;
// the picker opened a second time (list cached) → its rows ≤ 300 ms.
import type { Page } from '@playwright/test';
import { expect, ORCH, S, test, useEngine } from '../fixtures.ts';
import { paste } from '../v24-attach-io.ts';

/** Claude Code takes 1 s to list its models: only a cached list can meet the 300 ms budget. */
const eng = useEngine({ scenarios: { [ORCH]: { control: { delayMs: { list_models: 1000 } }, steps: [...S.turn('Sẵn sàng'), ...S.idle()] } } });
test.describe.configure({ mode: 'serial' });

const MB2 = 2 * 1024 * 1024;
const ins = (page: Page) => page.locator('#inspector');
const input = (page: Page) => page.getByLabel('Ô lệnh');
const tray = (page: Page) => ins(page).locator('.tray');

declare global { interface Window { __bt?: { t0: number | null; t1: number | null } } }

/** Arm a timer: t0 = the next pointerdown / Enter keydown on `window` (or set by hand), t1 = the first frame after
 *  `selector` matches more nodes than now (or at least `atLeast`). */
async function arm(page: Page, selector: string, atLeast?: number): Promise<void> {
  await page.evaluate(({ sel, atLeast }) => {
    const st = { t0: null as number | null, t1: null as number | null };
    window.__bt = st;
    const start = (e: Event) => { if (st.t0 === null && (e.type === 'pointerdown' || (e as KeyboardEvent).key === 'Enter')) st.t0 = performance.now(); };
    window.addEventListener('pointerdown', start, true);
    window.addEventListener('keydown', start, true);
    const need = atLeast ?? document.querySelectorAll(sel).length + 1;
    const mo = new MutationObserver(() => {
      if (st.t0 === null || document.querySelectorAll(sel).length < need) return;
      mo.disconnect();
      requestAnimationFrame(() => { st.t1 = performance.now(); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }, { sel: selector, atLeast });
}
async function took(page: Page, what: string): Promise<number> {
  await expect.poll(() => page.evaluate(() => window.__bt!.t1), { timeout: 10_000 }).not.toBeNull();
  const ms = await page.evaluate(() => window.__bt!.t1! - window.__bt!.t0!);
  console.log(`§10.3 ${what} ${ms.toFixed(1)} ms`);
  return ms;
}

let added = false;
async function open(page: Page): Promise<void> {
  if (!added) { await eng.addProject('budget'); added = true; }
  await page.goto(eng.url());
  await page.locator('#top .tab', { hasText: 'budget' }).click();
  await expect(input(page)).toBeEnabled();
  await input(page).focus();
}

test('§10.3 paste one 2 MB image → its chip shows ≤ 100 ms (blob: thumbnail, no wait for the engine)', async ({ page }) => {
  await open(page);
  await arm(page, '#inspector .tray .ich');
  // the paste helper builds the File first, then dispatches: t0 at the dispatch (a capture listener on window)
  await page.evaluate(() => window.addEventListener('paste', () => { window.__bt!.t0 ??= performance.now(); }, { capture: true, once: true }));
  await paste(page, [{ name: 'big.png', img: { hue: 30 }, size: MB2 }]);
  expect(await took(page, 'paste 2 MB → chip')).toBeLessThanOrEqual(100);
  await expect(tray(page).locator('.ich img.th')).toHaveAttribute('src', /^blob:/);
  await tray(page).locator('.ich').hover();
  await tray(page).locator('.ich .ax').click(); // × : nothing left for the next test
  await expect(tray(page)).toHaveCount(0);
});

test('§10.3 Y24 Enter with 5 × 2 MB images → the po line shows ≤ 300 ms', async ({ page }) => {
  await open(page);
  await paste(page, [0, 1, 2, 3, 4].map(i => ({ name: `a${i}.png`, img: { hue: 40 + i * 60 }, size: MB2 })));
  await expect(tray(page).locator('.ich')).toHaveCount(5);
  await expect(tray(page).locator('.sp')).toHaveCount(0, { timeout: 15_000 }); // uploaded
  await input(page).fill('năm ảnh lớn');
  await arm(page, '#inspector .m-po');
  await input(page).press('Enter');
  expect(await took(page, 'Enter 5 × 2 MB → po line')).toBeLessThanOrEqual(300);
  await expect(ins(page).locator('.m-po', { hasText: 'năm ảnh lớn' })).toHaveCount(1);
});

test('§10.3 the picker opened a second time (list cached) → its rows show ≤ 300 ms', async ({ page }) => {
  await open(page);
  const chip = ins(page).locator('.mchip'), menu = page.locator('.mdmenu');
  await chip.click();
  await expect(menu.locator('.mrow', { hasText: 'Sonnet 5.5' })).toBeVisible({ timeout: 10_000 }); // first open: asks Claude Code
  const rows = await menu.locator('.mrow').count(); // the full list (the MD8 fallback has 2 rows only)
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await arm(page, '.mdmenu .mrow', rows);
  await chip.click();
  expect(await took(page, 'picker 2nd open (cached) → list')).toBeLessThanOrEqual(300);
});
