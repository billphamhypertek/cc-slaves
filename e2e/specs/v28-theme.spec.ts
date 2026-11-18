// v2.8 §11 E2E for G4: the theme button + menu "Giao diện" (§4.1), persistence (§5.1), "Theo macOS" following the system
// scheme (§5.2), the boot script that sets data-theme before any app code runs (§5.3), a switch inside one page load that
// keeps the composer text and the Code editor's unsaved text + cursor (§5.4), and Tauri `setTheme` with the right values
// (§4.7, stubbed `window.__TAURI__`). The rest of the e2e tree runs dark (e2e/fixtures.ts seeds `ccs.theme`); this file starts
// from an empty store, so the app shows its default Sáng (PO 17/11 21:55), on a light system, the PO's macOS today (L1).
import type { Page } from '@playwright/test';
import { ORCH, S, expect, recordBudget, test, useEngine } from '../fixtures.ts';
import { hagentaRepo } from '../v23-repo.ts';

test.use({ colorScheme: 'light', theme: null });

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const button = (page: Page) => page.locator('#top').getByRole('button', { name: 'Giao diện', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Giao diện' });
const SYS = /^Theo macOS/; // its name carries the note ("đang Sáng"); "Sáng" alone must not match it
const item = (page: Page, name: string | RegExp) => menu(page).getByRole('menuitemradio', { name, exact: true });

/** The Mac app: `getCurrentWindow().setTheme` records its argument; `onThemeChanged` hands its callback to the test. */
async function stubTauri(page: Page): Promise<(string | null)[]> {
  const calls: (string | null)[] = [];
  await page.exposeFunction('__ccSetTheme', (t: string | null) => { calls.push(t); });
  await page.addInitScript(() => {
    const w = window as unknown as { __TAURI__: unknown; __ccSetTheme: (t: string | null) => void; __ccThemeEv?: (e: { payload: string }) => void };
    w.__TAURI__ = {
      core: { invoke: () => Promise.resolve(null) },
      window: { getCurrentWindow: () => ({
        setFocus: () => Promise.resolve(),
        setTheme: (t: string | null) => { w.__ccSetTheme(t); return Promise.resolve(); },
        onThemeChanged: (cb: (e: { payload: string }) => void) => { w.__ccThemeEv = cb; return Promise.resolve(() => {}); },
      }) },
    };
  });
  return calls;
}

test.describe('v2.8 G4 theme', () => {
  const eng = useEngine({ scenarios: () => ({ [ORCH]: { steps: [...S.idle()] } }) });
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    hagentaRepo(eng);
    await eng.addProject('hagenta');
  });

  test('§5.3 the boot script sets data-theme before any app code: empty → light even on a dark system, stored dark → dark, junk → light, system → the scheme', async ({ page }) => {
    await page.route(/\/assets\/index-[^/]+\.js$/, r => r.abort()); // no app code at all: only /theme-boot.js may set it
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(eng.url());
    expect(await theme(page)).toBe('light'); // PO 17/11 21:55: the default is Sáng, not Theo macOS
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light');
    await page.evaluate(() => localStorage.setItem('ccs.theme', 'dark'));
    await page.reload();
    expect(await theme(page)).toBe('dark');
    await page.evaluate(() => localStorage.setItem('ccs.theme', 'Dark!'));
    await page.reload();
    expect(await theme(page)).toBe('light'); // junk → the default
    await page.evaluate(() => localStorage.setItem('ccs.theme', 'system'));
    await page.reload();
    expect(await theme(page)).toBe('dark'); // a stored Theo macOS still follows the dark scheme
  });

  test('§4.1 U5 menu → Tối = 2 clicks: dark at once, same page load, composer text kept, stored, setTheme("dark")', async ({ page }) => {
    const calls = await stubTauri(page);
    await page.emulateMedia({ colorScheme: 'dark' }); // the default is Sáng whatever macOS shows
    await page.goto(eng.url());
    await expect(button(page)).toBeVisible();
    expect(await theme(page)).toBe('light');
    await expect.poll(() => calls).toEqual(['light']); // boot: the window is forced to the default
    await page.locator('.react-flow__node[data-id^="orch:"] button.hit').first().click();
    await page.locator('#cmd').fill('chưa gửi');
    const loads: string[] = [];
    page.on('load', () => loads.push(page.url()));

    await button(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator('h4')).toHaveText('Giao diện');
    await expect(menu(page).getByRole('menuitemradio')).toHaveText([/^Sáng$/, /^Tối$/, /^Theo macOS$/]);
    await expect(item(page, 'Sáng')).toHaveAttribute('aria-checked', 'true');
    await expect(item(page, SYS)).toHaveAttribute('aria-checked', 'false');
    await expect(item(page, 'Sáng')).toBeFocused(); // opens on the checked item
    await expect(button(page)).toHaveAttribute('aria-expanded', 'true');
    await item(page, 'Tối').click();

    expect(await theme(page)).toBe('dark');
    await expect(menu(page)).toHaveCount(0);
    await expect(page.locator('#cmd')).toHaveValue('chưa gửi');
    await expect(page.locator('.deck .react-flow')).toHaveClass(/\bdark\b/);
    await expect(button(page).locator('svg path')).toHaveAttribute('d', 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'); // the moon
    expect(await page.evaluate(() => localStorage.getItem('ccs.theme'))).toBe('dark');
    await expect.poll(() => calls).toEqual(['light', 'dark']);
    expect(loads).toEqual([]);
    recordBudget('v2.8 U5 nút giao diện → Tối', 2, 2);

    // ↑ ↓ Enter Esc: Esc closes and gives the focus back to the button; Enter on "Sáng" applies it
    await button(page).click();
    await expect(item(page, 'Tối')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(button(page)).toBeFocused();
    await button(page).click();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    expect(await theme(page)).toBe('light');
    await expect.poll(() => calls).toEqual(['light', 'dark', 'light']);
    // a forced mode survives a reload (and the boot script agrees with it)
    await page.reload();
    expect(await theme(page)).toBe('light');
  });

  test('§5.2 Theo macOS follows the system scheme live (matchMedia, Tauri onThemeChanged); a forced mode ignores it', async ({ page }) => {
    const calls = await stubTauri(page);
    await page.addInitScript(() => localStorage.setItem('ccs.theme', 'dark'));
    await page.goto(eng.url());
    expect(await theme(page)).toBe('dark');
    await button(page).click();
    await item(page, SYS).click();
    await expect.poll(() => calls).toEqual(['dark', null]); // §4.7 setTheme(null) …
    await expect.poll(() => theme(page)).toBe('light'); // … then the light system shows
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(page)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => theme(page)).toBe('light');
    // WKWebView may stay silent on a macOS change (§14): the window's own theme event is enough
    await page.evaluate(() => (window as unknown as { __ccThemeEv: (e: { payload: string }) => void }).__ccThemeEv({ payload: 'dark' }));
    expect(await theme(page)).toBe('dark');
    await button(page).click();
    await expect(item(page, SYS)).toContainText('đang Tối');
    await item(page, 'Sáng').click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => (window as unknown as { __ccThemeEv: (e: { payload: string }) => void }).__ccThemeEv({ payload: 'dark' }));
    expect(await theme(page)).toBe('light');
  });

  test('§5.4 Code tab while editing: a switch keeps the unsaved text and the cursor', async ({ page }) => {
    await page.goto(eng.url());
    await page.locator('.react-flow__node[data-id^="orch:"] button.hit').first().click();
    await page.keyboard.press('c');
    const row = (p: string) => page.locator(`#codeview .ctree [data-path="${p}"]`);
    await row('engine').click();
    await row('engine/src').click();
    await row('engine/src/config.ts').click();
    await page.locator('#codeview .cm-line').first().click();
    await page.keyboard.press('End');
    await page.getByRole('button', { name: 'Sửa', exact: true }).click();
    await expect(page.locator('#codeview .cvh .edp')).toHaveText('Đang sửa');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#codeview .cm-editor'))).toBe(true); // "Sửa" focuses the text
    await page.keyboard.type(' // a');
    await expect(page.locator('#codeview .cm-line').first()).toHaveText('export const PORT = 4318 // a');
    await button(page).click();
    await item(page, 'Tối').click();
    expect(await theme(page)).toBe('dark');
    // focus back without a click (a click would move the cursor): the next keys land right after the earlier ones
    await page.locator('#codeview .cm-content').focus();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#codeview .cm-editor'))).toBe(true);
    await page.keyboard.type('b');
    await expect(page.locator('#codeview .cm-line').first()).toHaveText('export const PORT = 4318 // ab');
    await expect(page.locator('#codeview .ctabs [role=tab]').first().locator('button.x.dt')).toBeVisible(); // still unsaved
  });
});
