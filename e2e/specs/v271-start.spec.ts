// v2.7.1 G2a §4.1 the start dialog's account field + the step list, through the v2.4 "Mở phiên song song…" path (L11 / L14)
// inside the Mac app (stubbed `window.__TAURI__`): "Tự chọn · sẽ dùng <email> — còn N %" from `session_pick`, a full account
// listed greyed with its reason, account + model + effort → `session_open` carries them and the session spawns with them,
// the four steps tick; SA9 (no account left → main button off + earliest) on a second engine where every account is full.
// Shots (1440×900, 1024×640) go to .e2e-results/v271-start/ for the mockup comparison.
import { readdirSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { B2, expect, ORCH, PM, S, test } from '../fixtures.ts';
import { fakeTauri, node, openApp, PID, useSeeded } from '../v21-seed.ts';

const CONTROL = { startModel: 'claude-opus-5-5', startEffort: 'high', sources: [{ source: 'userSettings', settings: { model: 'opus', effortLevel: 'high' } }] };
const now = () => Math.floor(Date.now() / 1000);
const seedOf = (e: { repo: (n: string) => string }) => ({ project: { id: PID, name: 'shop', path: e.repo('shop'), account: ORCH }, sessions: [{ id: 's3', seq: 3, account: ORCH }], lanes: [] });
// B2 full by the week (99 % ≥ its 98 % cap), reopening in 2 h; ORCH (home, runs #3) and PM have room
const eng = useSeeded({ scenarios: { default: { control: CONTROL, steps: S.idle() } },
  seed: { [ORCH]: { fivePct: 10, weekPct: 10 }, [PM]: { fivePct: 10, weekPct: 30 }, [B2]: { fivePct: 10, weekPct: 99, weekResetsAt: now() + 7200 } } }, seedOf);
// SA9: every account full; PM reopens first
const full = useSeeded({ scenarios: { default: { control: CONTROL, steps: S.idle() } },
  seed: { [ORCH]: { fivePct: 10, weekPct: 99.5, weekResetsAt: now() + 9000 }, [PM]: { fivePct: 10, weekPct: 99.5, weekResetsAt: now() + 3600 }, [B2]: { fivePct: 10, weekPct: 99, weekResetsAt: now() + 7200 } } }, seedOf);

const dialog = (page: Page) => page.getByRole('dialog');
const accField = (page: Page) => dialog(page).locator('.apick');
const shot = (page: Page, name: string) => page.screenshot({ path: `.e2e-results/v271-start/${name}.png`, animations: 'disabled' });
const argvs = (): string[][] => readdirSync(eng.dir).filter(f => /^trace-.+\.json$/.test(f))
  .map(f => (JSON.parse(readFileSync(eng.file(f), 'utf8')) as { argv: string[] }).argv);
const flagOf = (argv: string[], name: string) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const openParallel = async (page: Page) => {
  await node(page, 'orch:s3').locator('button.more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Mở phiên song song…' }).click();
};
/** the page's engine socket through a switch: `drop` closes it and refuses reconnects until `restore` (SA9b). */
async function wire(page: Page) {
  let live: { close(): Promise<void> } | null = null, down = false;
  await page.routeWebSocket(/\/ws\?/, ws => {
    if (down) { void ws.close(); return; }
    live = ws;
    const server = ws.connectToServer();
    ws.onMessage(m => server.send(m));
    server.onMessage(m => ws.send(m));
  });
  return { drop: () => { down = true; void live?.close(); }, restore: () => { down = false; } };
}
const sentCmds = (page: Page) => {
  const sent: Record<string, unknown>[] = [];
  page.on('websocket', ws => ws.on('framesent', f => { const c = (JSON.parse(String(f.payload)) as { command?: Record<string, unknown> }).command; if (c) sent.push(c); }));
  return sent;
};

test.beforeEach(async ({ page }) => { await fakeTauri(page); });

test('§4.1 account + model + effort → session_open carries them, the steps tick, the Deck shows the new session', async ({ page }) => {
  const sent = sentCmds(page);
  await openApp(page, eng.url());
  eng.slowBoot(4000); // step 2 is seen running (the title + the shot land inside it)
  await openParallel(page);
  await expect(accField(page)).toHaveText(/^Tự chọn · sẽ dùng pm@x\.test — còn \d+ %$/); // ORCH runs #3: ranked after (session_pick)
  await expect(dialog(page).locator('.sfield.acc .hint')).toHaveText('Tự chọn = theo luật Điều phối');
  expect(sent.filter(c => c.cmd === 'session_pick')).toEqual([{ cmd: 'session_pick', projectId: PID, kind: 'design' }]);
  await shot(page, 'SA1-1440');
  await accField(page).click();
  const list = page.getByRole('listbox', { name: 'Account' });
  const b2 = list.getByRole('option', { name: /^b2@x\.test — Đầy/ });
  await expect(b2).toHaveAttribute('aria-disabled', 'true');
  await expect(b2.locator('small')).toHaveText(/^tuần đã dùng 99 % \(ngưỡng 98 %\) · mở lại \d\d:\d\d \d\d\/\d\d$/);
  await shot(page, 'SA2-1440');
  await expect(list.getByRole('option', { name: /^orch@x\.test — còn/ }).locator('em')).toHaveText('đang chạy Điều phối #3');
  await b2.click({ force: true }); // greyed (aria-disabled): the click picks nothing
  await expect(list).toBeVisible();
  await list.getByRole('option', { name: /^pm@x\.test — còn/ }).click();
  await expect(accField(page)).toHaveText(/^pm@x\.test — còn \d+ %$/);
  await dialog(page).locator('.mpick').click();
  await page.getByRole('listbox').getByRole('option', { name: /^Sonnet 5\.5/ }).click();
  await dialog(page).locator('.mpicks select').selectOption('low');
  await dialog(page).locator('.btn.pri').click();
  // the choice turns into the step list at once (≤ 100 ms: same click)
  const steps = dialog(page).locator('.sst');
  await expect(steps).toHaveCount(4, { timeout: 1000 });
  await expect(steps.first()).toContainText('Chọn account: pm@x.test');
  await expect(steps.nth(1)).toHaveClass(/st-run/);
  await expect(steps.nth(1)).toContainText('Khởi động Claude · Sonnet 5.5 · low');
  await expect(dialog(page).locator('h2')).toHaveText('Đang mở phiên #4'); // frozen at the click: #4 is in the snapshot by now
  await shot(page, 'SA3-1440');
  await expect(dialog(page)).toHaveCount(0, { timeout: 20_000 }); // step 4 → the Deck selects it, the box closes
  await expect(page.locator('#inspector .ohead h2')).toHaveText('Điều phối #4');
  eng.slowBoot(0);
  const open = sent.find(c => c.cmd === 'session_open')!;
  expect([open.account, open.model, open.effort]).toEqual([PM, 'sonnet', 'low']);
  const o4 = (await eng.snapshot()).orchestrators.find(o => o.seq === 4)!;
  expect([o4.account, o4.modelPick, o4.effortPick]).toEqual([PM, 'sonnet', 'low']);
  expect(argvs().some(a => flagOf(a, '--model') === 'sonnet' && flagOf(a, '--effort') === 'low')).toBe(true);
});

test('§4.1 SA1 / SA9b at 1024×640: the dialog fits; offline keeps the choices and turns the main button off', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  const sock = await wire(page);
  await openApp(page, eng.url());
  await openParallel(page);
  await expect(accField(page)).toHaveText(/^Tự chọn · sẽ dùng/);
  const box = await dialog(page).boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  await shot(page, 'SA8-1024');
  await dialog(page).locator('.mpicks select').selectOption('low');
  sock.drop(); // the engine socket drops and stays down
  await expect(dialog(page).locator('.note.alert')).toHaveText('Mất kết nối với engine — đang nối lại. Lựa chọn của anh vẫn giữ; nối lại xong là bắt đầu được.', { timeout: 15_000 });
  await expect(dialog(page).locator('.btn.pri')).toBeDisabled();
  await expect(dialog(page).locator('.mpicks select')).toHaveValue('low');
  await shot(page, 'SA9b-1024');
  sock.restore();
  await expect(dialog(page).locator('.btn.pri')).toBeEnabled({ timeout: 20_000 });
  await expect(dialog(page).locator('.mpicks select')).toHaveValue('low');
});

test('§4.1 SA9 every account full: "không account nào còn dùng được", the earliest named, the main button off; the list only explains', async ({ page }) => {
  await openApp(page, full.url());
  await openParallel(page);
  await expect(accField(page)).toHaveText('Tự chọn · không account nào còn dùng được');
  await expect(dialog(page).locator('.note.alert')).toHaveText(/^Mọi account đã đăng nhập đều đầy, không nhận việc mới hoặc đăng xuất\. Sớm nhất: pm@x\.test mở lại \d\d:\d\d \d\d\/\d\d\. Mở danh sách/);
  await expect(dialog(page).locator('.btn.pri')).toBeDisabled();
  await shot(page, 'SA9-1440');
  await accField(page).click();
  const opts = page.getByRole('listbox', { name: 'Account' }).getByRole('option');
  await expect(opts).toHaveCount(4);
  for (const i of [1, 2, 3]) await expect(opts.nth(i)).toHaveAttribute('aria-disabled', 'true');
});
