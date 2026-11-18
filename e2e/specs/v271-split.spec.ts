// v2.7.1 G2b §4.1 / §4.2 the split button "Bắt đầu ▾" of the Tasks tab on the real engine, inside the Mac app (stubbed
// `window.__TAURI__`): the main part opens the step list at once and `spec_build` carries no account / model / effort, the
// Deck then shows the new Build session; ▾ opens the start dialog and the pick rides on the command; the ▾ is neutral (no
// coloured border, hover = --sel); IS17 "Nhận phiên này ▾" opens SA6b with "Như phiên cũ". G2c §5: "Kết thúc phiên" on a
// session still `starting` says "Đang chờ phiên khởi động…" at once. Shots (1440×900, 1024×640) go to .e2e-results/v271-split/.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, msUntil, PM, test, useEngine } from '../fixtures.ts';
import { fakeTauri } from '../v21-seed.ts';

test.use({ tasksStart: true });
const eng = useEngine();
const SPEC = `${'Nội dung spec để engine nhận vào. '.repeat(12)}\n`;
const dialog = (page: Page) => page.getByRole('dialog');
const shot = (page: Page, name: string) => page.screenshot({ path: `.e2e-results/v271-split/${name}.png`, animations: 'disabled' });
const sentCmds = (page: Page) => {
  const sent: Record<string, unknown>[] = [];
  page.on('websocket', ws => ws.on('framesent', f => { const c = (JSON.parse(String(f.payload)) as { command?: Record<string, unknown> }).command; if (c) sent.push(c); }));
  return sent;
};
/** a project with one approved spec `docs/specs/<name>.md`, opened in Tasks on that spec */
async function specProject(page: Page, name: string): Promise<{ pid: string; path: string }> {
  const pid = await eng.addProject(name);
  mkdirSync(join(eng.repo(name), 'docs/specs'), { recursive: true });
  const path = `docs/specs/v1-${name}.md`;
  writeFileSync(join(eng.repo(name), path), `# v1 ${name}\n\n**Status:** approved\n\n${SPEC}`);
  await eng.cmd({ cmd: 'spec_scan', projectId: pid });
  const spec = (await eng.snapshot()).issues?.find(x => x.projectId === pid)?.specs.find(s => s.path === path);
  await page.addInitScript(([p, sel]) => localStorage.setItem('ccs.tasks', JSON.stringify({ [p]: { sel, issue: null } })), [pid, { spec: spec!.id }] as const);
  await page.goto(eng.url());
  await page.locator('nav.tabs .tab', { hasText: name }).click();
  return { pid, path };
}
const card = (page: Page, name: string) => page.getByRole('article', { name: `v1 ${name}` });
const newOf = async (pid: string, before: (string | null | undefined)[]) => (await eng.snapshot()).orchestrators.find(o => o.projectId === pid && !before.includes(o.sessionId));

test.beforeEach(async ({ page }) => { await fakeTauri(page); });

test('§4.1 SA0 → SA3: "Bắt đầu build" (main) → the step list at once, spec_build with no picks, then the Deck on the new Build session', async ({ page }) => {
  const sent = sentCmds(page);
  const { pid, path } = await specProject(page, 'web');
  const split = card(page, 'web').locator('.split').first();
  const dd = split.locator('.sdd');
  await expect(dd).toHaveAttribute('aria-label', 'Bắt đầu build — chọn account, model, effort');
  await dd.hover();
  // BANNED look: the ▾ next to the accent main part stays neutral; hover = the --sel step only
  const look = await dd.evaluate(e => { const s = getComputedStyle(e); const v = getComputedStyle(document.documentElement);
    return { top: s.borderTopColor, bg: s.backgroundColor, accent: v.getPropertyValue('--accent').trim() }; });
  expect(look.bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(look.top).not.toMatch(/90, 209, 255/); // --accent #5ad1ff
  await shot(page, 'SA0-1440');
  const before = (await eng.snapshot()).orchestrators.map(o => o.sessionId);
  eng.slowBoot(2500);
  try {
    const t = await msUntil(page, () => split.locator('.tbtn').click(), { steps: `!!document.querySelector('[role=dialog] .ssteps')` });
    expect(t.steps, 'step list ms').toBeLessThan(100);
    await expect(dialog(page).locator('h2')).toHaveText('Đang mở phiên Build · v1 web');
    await expect(dialog(page).locator('.sst').nth(1)).toHaveClass(/st-run/, { timeout: 5000 });
    // UX MINOR-1 the 1-click path says the defaults: the account's % and the model · effort Claude will run
    await expect(dialog(page).locator('.sst').first().locator('small')).toHaveText(/^tự chọn — còn \d+ %$/);
    await expect(dialog(page).locator('.sst').nth(1).locator('b')).toHaveText(/^Khởi động Claude · .+/);
    await shot(page, 'SA3-1440');
  } finally { eng.slowBoot(0); }
  await expect(dialog(page)).toHaveCount(0, { timeout: 20_000 }); // step 4: the Deck selects the session, the box closes
  await expect(page.locator('.dhead [role=tab]', { hasText: 'Deck' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#inspector')).toContainText(`Build spec ${path}`);
  expect((await newOf(pid, before))?.orchKind).toBe('build');
  expect(sent.filter(c => c.cmd === 'spec_build')).toEqual([{ cmd: 'spec_build', projectId: pid, path }]);
});

test('§4.1 SA1 / SA2: ▾ → the start dialog → pick an account → Enter → spec_build carries it; R-B19 a double-click on the main part sends one', async ({ page }) => {
  const sent = sentCmds(page);
  const { pid, path } = await specProject(page, 'app');
  await card(page, 'app').locator('.split').first().locator('.sdd').click();
  await expect(dialog(page).locator('h2')).toHaveText('Bắt đầu build · v1 app');
  await expect(dialog(page).locator('.apick')).toHaveText(/^Tự chọn · sẽ dùng .+ — còn \d+ %$/);
  await shot(page, 'SA1-1440');
  await dialog(page).locator('.apick').click();
  await expect(page.getByRole('listbox', { name: 'Account' })).toBeVisible();
  await shot(page, 'SA2-1440');
  await page.getByRole('listbox', { name: 'Account' }).getByRole('option', { name: /^pm@x\.test — còn/ }).click();
  await dialog(page).locator('.btn.pri').focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0, { timeout: 20_000 });
  expect(sent.filter(c => c.cmd === 'spec_build')).toEqual([{ cmd: 'spec_build', projectId: pid, path, account: PM }]);
  // a double-click on a main part: the 2nd click lands on the step list's backdrop and is ignored (one command, the list stays)
  const dbl = await specProject(page, 'dbl');
  eng.slowBoot(3000);
  try {
    await card(page, 'dbl').locator('.split').first().locator('.tbtn').dblclick();
    await page.mouse.click(4, 4); // a stray click on the backdrop while it boots
    await page.waitForTimeout(300);
    await expect(dialog(page).locator('.ssteps')).toBeVisible();
  } finally { eng.slowBoot(0); }
  await expect(dialog(page)).toHaveCount(0, { timeout: 20_000 });
  expect(sent.filter(c => c.cmd === 'spec_build' && c.projectId === dbl.pid)).toHaveLength(1);
  await expect(page.locator('.dhead [role=tab]', { hasText: 'Deck' })).toHaveAttribute('aria-selected', 'true');
});

test('§4.2 SA6 / SA6b IS17: "Nhận phiên này ▾" closes the choice and opens the dialog with "Như phiên cũ (<giá trị>)"; the main part resumes with no picks', async ({ page }) => {
  const sent = sentCmds(page);
  const pid = await eng.addProject('out');
  mkdirSync(join(eng.repo('out'), 'docs/specs'), { recursive: true });
  writeFileSync(join(eng.repo('out'), 'docs/specs/v1-out.md'), `# v1 out\n\n**Status:** đang build\n\n${SPEC}`);
  const root = (await eng.snapshot()).projects.find(p => p.id === pid)!.path;
  const tdir = join(eng.file('claude'), 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const tfile = join(tdir, 'prior-1.jsonl');
  writeFileSync(tfile, `${JSON.stringify({ type: 'user', cwd: root, sessionId: 'prior-1', message: { role: 'user', content: 'build docs/specs/v1-out.md giúp anh' } })}\n`
    + `${JSON.stringify({ type: 'assistant', cwd: root, sessionId: 'prior-1', effort: 'high', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }] } })}\n`);
  const old = (Date.now() - 600_000) / 1000;
  utimesSync(tfile, old, old);
  await eng.cmd({ cmd: 'spec_scan', projectId: pid });
  const spec = (await eng.snapshot()).issues?.find(x => x.projectId === pid)?.specs.find(s => s.path === 'docs/specs/v1-out.md');
  await page.addInitScript(([p, id]) => localStorage.setItem('ccs.tasks', JSON.stringify({ [p]: { sel: { spec: id }, issue: null } })), [pid, spec!.id] as const);
  await page.goto(eng.url());
  await page.locator('nav.tabs .tab', { hasText: 'out' }).click();
  await card(page, 'out').getByRole('button', { name: 'Tiếp tục build' }).click();
  const pop = page.getByRole('dialog', { name: 'Tiếp tục build' });
  await expect(pop.locator('.pdef')).toHaveText('Mặc định: account tự chọn · model / effort như cũ');
  const take = pop.locator('.pold .split');
  await expect(take.locator('.tbtn')).toBeEnabled();
  await take.locator('.sdd').hover();
  await shot(page, 'SA6-1440');
  await take.locator('.sdd').click();
  await expect(pop).toHaveCount(0);
  await expect(dialog(page).locator('h2')).toHaveText('Nhận phiên cũ · v1 out');
  await expect(dialog(page).locator('.lead')).toHaveText(/^Nhận phiên “build docs\/specs\/v1-out\.md giúp anh” \(\d\d:\d\d \d\d\/\d\d · 1 lượt\), rồi chuyển sang Deck\.$/);
  // g2bc ⑥ the old session's values from its transcript (engine `PriorSession.model / effort`), named by the model list
  await expect(dialog(page).locator('.mpick')).toHaveText('Như phiên cũ (Opus 5.5)');
  await expect(dialog(page).locator('.mpicks select option').first()).toHaveText('Như phiên cũ (high)');
  await shot(page, 'SA6b-1440');
  await dialog(page).getByRole('button', { name: 'Huỷ' }).click();
  await card(page, 'out').getByRole('button', { name: 'Tiếp tục build' }).click();
  await page.getByRole('dialog', { name: 'Tiếp tục build' }).locator('.pold .split .tbtn').click();
  await expect(dialog(page).locator('.ssteps')).toBeVisible();
  await expect(dialog(page)).toHaveCount(0, { timeout: 20_000 });
  expect(sent.filter(c => c.cmd === 'spec_build')).toEqual([{ cmd: 'spec_build', projectId: pid, path: 'docs/specs/v1-out.md', resume: 'prior-1' }]);
});

test('§4.1 SA8 at 1024×640: the rail is a spec menu, "Bắt đầu build" + the indented "… chọn account, model, effort…" opens the 500 px dialog unscrolled', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  const { pid, path } = await specProject(page, 'nar');
  // v1 building (its list head carries the narrow spec menu), v2 ready (its rail row has "Bắt đầu build")
  await eng.cmd({ cmd: 'spec_build', projectId: pid, path });
  writeFileSync(join(eng.repo('nar'), 'docs/specs/v2-nar.md'), `# v2 nar\n\n**Status:** approved\n\n${SPEC}`);
  await eng.cmd({ cmd: 'spec_scan', projectId: pid });
  await page.reload();
  await page.locator('nav.tabs .tab', { hasText: 'nar' }).click();
  await page.locator('#tasks .lspec').click(); // the narrow list head's spec menu (IS10b)
  const menu = page.locator('#tasks .lpop[role=menu]');
  await expect(menu.locator('.splitm').first()).toBeVisible();
  await menu.getByRole('button', { name: 'Bắt đầu build — chọn account, model, effort' }).click();
  await expect(dialog(page).locator('h2')).toHaveText('Bắt đầu build · v2 nar');
  await expect(menu).toHaveCount(0); // UX MINOR-7 the spec menu closes when its item opens the dialog
  const box = (await dialog(page).boundingBox())!;
  expect([box.width, box.y >= 0, box.y + box.height <= 640]).toEqual([500, true, true]);
  await shot(page, 'SA8-1024');
});

test('§5 G2c "Kết thúc phiên" on a session still `starting`: the menu item and the click say "Đang chờ phiên khởi động…" at once', async ({ page }) => {
  const { pid } = await specProject(page, 'end');
  const before = (await eng.snapshot()).orchestrators.map(o => o.sessionId);
  eng.slowBoot(6000);
  try {
    await card(page, 'end').locator('.split').first().locator('.tbtn').click();
    await expect.poll(async () => (await newOf(pid, before))?.state).toBe('starting');
    await dialog(page).getByRole('button', { name: 'Đóng' }).click(); // the session goes on booting
    await page.locator('.dhead [role=tab]', { hasText: 'Deck' }).click();
    const fresh = (await newOf(pid, before))!;
    await page.locator(`.react-flow__node[data-id="orch:${fresh.sessionId}"] button.more`).click();
    const item = page.getByRole('menu').getByRole('menuitem', { name: /Kết thúc phiên/ });
    await expect(item.locator('small')).toHaveText('Đang chờ phiên khởi động…');
    await item.click();
    const t = await msUntil(page, () => dialog(page).locator('.btn.pri').click(), { busy: `/Đang chờ phiên khởi động…/.test(document.querySelector('[role=dialog]')?.textContent ?? '')` });
    expect(t.busy, 'busy text ms').toBeLessThan(100);
    await expect(dialog(page)).toHaveCount(0, { timeout: 20_000 }); // the end lands once the boot is over
  } finally { eng.slowBoot(0); }
});
