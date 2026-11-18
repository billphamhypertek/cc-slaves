// F10 (§6.10, §7.1; v1.1 §4.6; v2.1 N4-d): the engine dies → only the deck strip "Mất kết nối · số liệu lúc …", HUD dims; after
// 30 s the banner "Khởi động lại engine" → the app restarts it (Tauri `engine_restart`, stubbed here: the fixture respawns the
// engine) → the bridge re-reads the new per-start token (`engine_token`) → reconnects; the orchestrator is recovered held (hf1116) and "Tiếp tục" resumes it.
import { expect, test, useEngine } from '../fixtures.ts';

const eng = useEngine();

test('F10 kill engine → banner → restart → reconnect with the new token', async ({ page }) => {
  await eng.addProject('shop');
  const calls: string[] = [];
  await page.exposeFunction('__e2eInvoke', async (cmd: string) => {
    calls.push(cmd);
    if (cmd === 'engine_restart') { await eng.start(); return null; }
    if (cmd === 'engine_token') return eng.proc ? eng.token : null;
    return null;
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __e2eInvoke(c: string): Promise<unknown>; __TAURI__: unknown };
    w.__TAURI__ = { core: { invoke: (c: string) => w.__e2eInvoke(c) }, event: { listen: async () => () => {} } };
  });
  await page.clock.install();
  await page.goto(eng.url());
  await expect(page.locator('#inspector')).toBeVisible();
  const oldToken = eng.token;

  await eng.kill();
  const banner = page.locator('#banner');
  await expect(page.locator('.deck .cband')).toContainText('Mất kết nối · số liệu lúc');
  await expect(banner).toBeHidden(); // v2.1 N4-d: the deck strip is the only reconnect message
  await page.clock.fastForward(31_000);
  await expect(banner.getByRole('button', { name: 'Khởi động lại engine' })).toBeVisible();
  await banner.getByRole('button', { name: 'Khởi động lại engine' }).click();
  await expect(banner).toBeHidden({ timeout: 20_000 });
  expect(eng.token).not.toBe(oldToken);
  expect(calls).toContain('engine_restart');
  expect(calls).toContain('engine_token');
  // hf1116: the restart holds the project (no token) until "Tiếp tục"
  await expect.poll(async () => (await eng.snapshot()).orchestrators[0]?.state, { timeout: 20_000 }).toBe('paused');
  await page.locator('#inspector .m-sys.held').getByRole('button', { name: 'Tiếp tục' }).click();
  await expect.poll(async () => (await eng.snapshot()).orchestrators[0]?.state, { timeout: 20_000 }).toBe('idle');
  await expect(page.locator('#inspector')).toBeVisible();
});
