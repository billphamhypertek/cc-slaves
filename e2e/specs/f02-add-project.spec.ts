// F2 (§6.2, v1.1 §4.6; PO 2026-11-16 "làm như VS Code"): "＋ Thêm project" opens the macOS folder panel at once — no dialog
// to fill, nothing typed. The folder is added under its folder name, selected, and its orchestrator starts on "Bắt đầu"
// (hf1116 H2); a folder that already is a project is just selected. Run with `window.__TAURI__` stubbed like the Mac app
// (the 16/11 bug: the app took a Tauri-only branch no test ever ran). Hot fix 2026-11-17: the app opens the panel itself
// (`pick_folder`; stub: the test resolves it) and a progress dialog shows each step (spinner → tick) until the project is in.
// hf-sp: superpowers not on when the folder is added → the project runs Giao thẳng and Tasks says why in one line.
import { mkdirSync, writeFileSync } from 'node:fs';
import { Clicks, deckTab, expect, recordBudget, test, useEngine } from '../fixtures.ts';

const eng = useEngine({ repos: ['shop', 'plain'] });
// v2.7 §4.1 D91: the added project opens in Tasks. No Deck locator handler here: its click would wait for the modal and miss the
// all-ticked dialog (it closes itself after 450 ms); the test goes to the Deck itself once the dialog is gone.
test.use({ tasksStart: true });

test('F2 add project = pick a folder → added, selected, orchestrator starts on Bắt đầu', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __TAURI__: unknown; __pick?: (p: string | null) => void };
    const invoke = async (cmd: string) => (cmd === 'pick_folder' ? new Promise(res => { w.__pick = res; }) : undefined);
    w.__TAURI__ = { core: { invoke }, event: { listen: async () => () => {} } };
  });
  const pick = (p: string | null) => page.evaluate(v => (window as unknown as { __pick: (p: string | null) => void }).__pick(v), p);
  const dlg = page.getByRole('dialog', { name: 'Đang thêm project' });
  await page.goto(eng.url());
  await expect(page.locator('.deck .cstate').filter({ hasText: 'Chưa có project' }).first()).toBeVisible();
  const add = page.locator('.deck .cstate button');

  // cancel in the panel → nothing added, no dialog left behind
  await add.click();
  await expect(dlg.locator('.dep.st-run')).toContainText('Chọn thư mục'); // spinner row while the panel is open
  await pick(null);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Esc while a step runs keeps the dialog (the flow closes itself); a failure stays with its reason until Esc / Đóng
  await add.click();
  await expect(dlg.locator('.dep.st-run')).toContainText('Chọn thư mục');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeVisible();
  await pick(eng.repo('missing-dir'));
  await expect(dlg.locator('.dep.st-bad')).toContainText('missing-dir');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.deck')).toContainText('Chưa có project');
  await expect(page.locator('.deck')).toContainText('Chưa có project');

  // a folder (not a git repo is fine) → one click, added under its folder name
  const noGit = eng.repo('plain-nogit');
  writeFileSync(eng.file('claude/settings.json'), '{}'); // hf-sp superpowers not on
  mkdirSync(noGit, { recursive: true });
  const clicks = new Clicks(page);
  await clicks.on(add);
  await page.evaluate(() => { // hf1117-perf did the new project's Tasks ever show the IS8b skeleton?
    const w = window as unknown as { __skel: boolean };
    w.__skel = false;
    new MutationObserver(() => {
      if (document.querySelector('#tasks[aria-busy=true]') && /plain-nogit/.test(document.querySelector('#top')?.textContent ?? '')) w.__skel = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await pick(noGit);
  await expect(page.locator('#top')).toContainText('plain-nogit');
  await expect(dlg.locator('.dep.st-ok')).toHaveCount(3); // every step ticked, then the dialog closes itself
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#tasks')).toBeVisible(); // §4.1 D91 a project opens in Tasks
  await expect(page.locator('#tasks')).toContainText('Chưa có việc.'); // hf1117-perf IS8 at once: its empty entry came with the add
  expect(await page.evaluate(() => (window as unknown as { __skel: boolean }).__skel)).toBe(false);
  const why = 'Chưa cài superpowers nên dùng Giao thẳng. Cài superpowers (hoặc bật lại ở Skills & MCP) để dùng Quy trình PO.';
  await expect(page.locator('#tasks .tstart .wfwhy')).toHaveText(why); // hf-sp under the Quy trình row
  await expect(page.locator('#tasks .tstart .wfc')).toContainText('Giao thẳng');
  await page.locator('#tasks .tstart .wfc').click();
  await expect(page.locator('.wfmenu .why')).toHaveText(why); // and in the project's workflow menu
  await page.keyboard.press('Escape');
  await deckTab(page).click();
  await expect(page.locator('.deck')).not.toContainText('Chưa có project');
  recordBudget('F2 thêm project (chọn thư mục)', clicks.n, 1); // "＋ Thêm project" (+ the macOS panel)
  // hf1116 H2: nothing runs (no token) until "Bắt đầu" or a first message
  expect((await eng.snapshot()).orchestrators[0]?.state).toBe('paused');
  await page.locator('#inspector .m-sys.held').getByRole('button', { name: 'Bắt đầu', exact: true }).click();
  await expect.poll(async () => (await eng.snapshot()).orchestrators[0]?.state, { timeout: 20_000 }).toBe('idle');
  await expect(page.locator('#inspector')).toBeVisible();

  // the same folder again → selected, not added twice, no error
  await page.locator('#top .tab.add').click();
  await pick(noGit);
  await expect(dlg).toContainText('Project “plain-nogit” đã có sẵn');
  await expect.poll(async () => (await eng.snapshot()).projects.length).toBe(1);
  await page.waitForTimeout(500); // the engine's answer (a refusal would toast) has landed
  expect(await page.locator('#toasts .toast').count()).toBe(0); // counted once: a toast fades, a retrying assert would wait it out
});
