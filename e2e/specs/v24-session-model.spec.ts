// v2.4 §13 E2E "mở phiên song song với model khác mặc định" (§4.4): the "Mở phiên song song" dialog's Model · Effort row →
// the new session is spawned with `--model` / `--effort` (fake-claude argv trace, e2e/engine-entry.ts) and its chip shows
// what it runs; "Chạy tiếp" of an ended session prefills that session's picks (MD11) and runs them. Real engine + fake-claude,
// state.db seeded before boot (e2e/v21-seed-db.ts): #3 running, #1 ended with picks opus · xhigh and its transcript on disk.
import { readdirSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, ORCH, PM, S, test } from '../fixtures.ts';
import { node, openApp, PID, useSeeded } from '../v21-seed.ts';

/** Every spawn without picks runs Opus 5.5 · high; the settings file names `opus` ("Theo mặc định (Opus 5.5)"). */
const CONTROL = { startModel: 'claude-opus-5-5', startEffort: 'high', sources: [{ source: 'userSettings', settings: { model: 'opus', effortLevel: 'high' } }] };
/** PM's own list (its probe spawn reads scn/<PM>.json): fake-claude's default rows + one row no other account has. */
const row = (value: string, resolvedModel: string, displayName: string, levels = ['low', 'medium', 'high', 'xhigh', 'max']) =>
  ({ value, resolvedModel, displayName, description: '', supportsEffort: levels.length > 0, supportedEffortLevels: levels });
const PM_MODELS = [row('default', 'claude-opus-5-5', 'Default (recommended)'), row('opus', 'claude-opus-5-5', 'Opus 5.5'),
  row('sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5'), row('haiku', 'claude-haiku-5-5', 'Haiku 5.5'), row('mythos', 'claude-mythos-9', 'Mythos 9')];
const eng = useSeeded({ scenarios: { default: { control: CONTROL, steps: S.idle() }, [PM]: { control: { ...CONTROL, models: PM_MODELS }, steps: S.idle() } } }, (e) => ({
  project: { id: PID, name: 'shop', path: e.repo('shop'), account: ORCH },
  sessions: [
    { id: 's1', seq: 1, account: ORCH, ended: { ctx: 60_000, handoff: false, transcript: true },
      model: { modelPick: 'opus', effortPick: 'xhigh', lastModel: 'claude-opus-5-5', lastModelName: 'Opus 5.5', lastEffort: 'xhigh' } },
    { id: 's3', seq: 3, account: ORCH },
  ],
  lanes: [],
}));

const chip = (page: Page) => page.locator('#inspector .mchip');
const dialog = (page: Page) => page.getByRole('dialog');
const modelField = (page: Page) => dialog(page).locator('.mpick');
const effortField = (page: Page) => dialog(page).locator('.mpicks select');
/** argv of every fake-claude spawn so far (trace-<email>-<n>.json). */
const argvs = (): string[][] => readdirSync(eng.dir).filter(f => /^trace-.+\.json$/.test(f))
  .map(f => (JSON.parse(readFileSync(eng.file(f), 'utf8')) as { argv: string[] }).argv);
const flagOf = (argv: string[], name: string) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const spawnedWith = (model: string, effort: string) => argvs().some(a => flagOf(a, '--model') === model && flagOf(a, '--effort') === effort);

test.beforeEach(async ({ page }) => { await openApp(page, eng.url()); });

// first: it only opens the dialog and cancels (no session started)
test('§4.4 "Mở phiên song song": changing Account re-reads the list for that account (second session_models) and shows it', async ({ page }) => {
  const asked: (string | null)[] = [];
  page.on('websocket', ws => ws.on('framesent', f => {
    const c = (JSON.parse(String(f.payload)) as { command?: { cmd: string; accountId?: string; sessionId?: string } }).command;
    if (c?.cmd === 'session_models' && !c.sessionId) asked.push(c.accountId ?? null);
  }));
  await openApp(page, eng.url()); // again, so the listener sees the socket
  await node(page, 'orch:s3').locator('button.more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Mở phiên song song…' }).click();
  await expect(modelField(page)).toHaveText('Theo mặc định (Opus 5.5)');
  await expect.poll(() => asked).toEqual([null]);
  const list = page.getByRole('listbox');
  await modelField(page).click();
  await expect(list.getByRole('option', { name: /^Sonnet 5\.5/ })).toBeVisible();
  await expect(list.getByRole('option', { name: /^Mythos 9/ })).toHaveCount(0); // the orchestrator account's list
  await modelField(page).click();
  await dialog(page).locator('.apick').click(); // v2.7.1 §4.1 the account list (reasons per row), not a native select
  await page.getByRole('listbox', { name: 'Account' }).getByRole('option', { name: new RegExp(`^${PM.replace('.', '\\.')} — còn`) }).click();
  await expect.poll(() => asked).toEqual([null, PM]);
  await modelField(page).click();
  await expect(list.getByRole('option', { name: /^Mythos 9/ })).toBeVisible({ timeout: 10_000 });
  await modelField(page).click();
  await dialog(page).getByRole('button', { name: 'Huỷ' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('§4.4 MD10 "Mở phiên song song": defaults read "Theo mặc định"; Sonnet 5.5 · low → the new session spawns with them, chip shows it', async ({ page }) => {
  await expect(chip(page)).toHaveText('Opus 5.5 · high▾');
  expect(argvs().some(a => a.includes('--model'))).toBe(false); // no pick yet: no session got --model
  await node(page, 'orch:s3').locator('button.more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Mở phiên song song…' }).click();
  await expect(modelField(page)).toHaveText('Theo mặc định (Opus 5.5)');
  await expect(effortField(page).locator('option:checked')).toHaveText('Theo mặc định (high)'); // v2.7.1 SA1: the account's default effort
  await modelField(page).click();
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option')).not.toHaveCount(0);
  await expect(list).not.toContainText('Default (recommended)'); // A3: Claude Code's `default` row is not listed
  await list.getByRole('option', { name: /^Sonnet 5\.5/ }).click();
  await expect(modelField(page)).toHaveText('Sonnet 5.5');
  await effortField(page).selectOption('low');
  await dialog(page).locator('.btn.pri').click();
  await expect.poll(async () => (await eng.snapshot()).orchestrators.length, { timeout: 20_000 }).toBe(2);
  await expect(page.locator('#inspector .ohead h2')).toHaveText('Điều phối #4');
  await expect(chip(page)).toHaveText('Sonnet 5.5 · low▾', { timeout: 20_000 });
  expect(spawnedWith('sonnet', 'low')).toBe(true);
  const o4 = (await eng.snapshot()).orchestrators.find(o => o.seq === 4)!;
  expect([o4.modelPick, o4.effortPick, o4.effort]).toEqual(['sonnet', 'low', 'low']);
});

// after the parallel test: #1 resumes as the third running session
test('§4.4 MD11 "Chạy tiếp #1" prefills the old picks (Opus 5.5 · xhigh) and the resumed process runs them', async ({ page }) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('h');
  await page.getByRole('menu', { name: 'Lịch sử phiên' }).locator('button.srow', { hasText: '#1' }).click();
  await expect(page.locator('#inspector')).toContainText('Phiên #1');
  await expect(page.locator('#inspector .meta.mono span').first()).toHaveText('Opus 5.5 · xhigh'); // MD12 ended: plain text
  await expect(chip(page)).toHaveCount(0);
  await page.locator('#inspector').getByRole('button', { name: 'Chạy tiếp…' }).click();
  await expect(modelField(page)).toHaveText('Opus 5.5');
  await expect(effortField(page)).toHaveValue('xhigh');
  await dialog(page).locator('.btn.pri').click();
  await expect(page.locator('#inspector .ohead h2')).toHaveText('Điều phối #1', { timeout: 20_000 });
  await expect(chip(page)).toHaveText('Opus 5.5 · xhigh▾', { timeout: 20_000 });
  expect(argvs().some(a => a.includes('--resume') && flagOf(a, '--model') === 'opus' && flagOf(a, '--effort') === 'xhigh')).toBe(true);
});

// §4.5 LM3 / §13 D55: Cài đặt › Model reads the project's list; a pick = one config_update with the whole modelDefaults (R40 M6)
test('§4.5 LM3 Settings › Model: "Theo Claude Code (Opus 5.5 · high)", Lane → Sonnet 5.5 · low applies at once as one whole modelDefaults', async ({ page }) => {
  const patches: unknown[] = [];
  page.on('websocket', ws => ws.on('framesent', f => {
    const c = (JSON.parse(String(f.payload)) as { command?: { cmd: string; patch?: unknown } }).command;
    if (c?.cmd === 'config_update') patches.push(c.patch);
  }));
  await openApp(page, eng.url()); // again, so the listener sees the socket
  await page.keyboard.press('Meta+Comma');
  const set = page.getByRole('dialog', { name: 'Cài đặt' });
  await set.getByRole('tab', { name: 'Model' }).click();
  const tr = (name: string) => set.locator('table.mdt tbody tr', { has: page.locator('td.mdr b', { hasText: name }) });
  await expect(tr('Điều phối').locator('.mpick').first()).toHaveText('Theo Claude CodeOpus 5.5▾');
  await expect(tr('Điều phối').locator('.mpick').nth(1)).toHaveText('Theo Claude Codehigh▾'); // §5.6 tier-4 effort (R41)
  await expect(tr('Điều phối').locator('td.res')).toHaveText('Opus 5.5 · hightheo ~/.claude/settings.json');
  await expect(set).toContainText('Danh sách model của');
  await expect(set).toContainText('Thay đổi ở tab này có hiệu lực ngay.');
  await tr('Lane').getByRole('button', { name: 'Model · Lane' }).click();
  await page.getByRole('listbox').getByRole('option', { name: /^Sonnet 5\.5/ }).click();
  await tr('Lane').getByRole('button', { name: 'Effort · Lane' }).click();
  const levels = page.getByRole('listbox');
  await expect(levels.getByRole('option')).toHaveText(['Theo Claude Code', 'low', 'medium', 'high', 'xhigh', 'max']);
  await levels.getByRole('option', { name: 'low' }).click();
  await expect(tr('Lane').locator('td.res')).toContainText('Sonnet 5.5 · low');
  await expect.poll(async () => (await eng.snapshot()).config.modelDefaults).toEqual({ orchestrator: { model: null, effort: null }, lane: { model: 'sonnet', effort: 'low' } });
  expect(patches).toEqual([
    { modelDefaults: { orchestrator: { model: null, effort: null }, lane: { model: 'sonnet', effort: null } } },
    { modelDefaults: { orchestrator: { model: null, effort: null }, lane: { model: 'sonnet', effort: 'low' } } },
  ]);
});
