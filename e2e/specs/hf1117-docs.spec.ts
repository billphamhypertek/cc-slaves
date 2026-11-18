// hf1117-docs (PO 17/11 "tài liệu của spec click vào thì xem được: link → web, md / ảnh → xem luôn"): every row kind of a spec's
// "Tài liệu" (v2.7 §4.10, §10.3) opens from BOTH places — the overview's "Tài liệu" block and the list head's "Tài liệu ▾" menu —
// inside the Mac app (stubbed `window.__TAURI__`, every `invoke` recorded with its args). `.md` → Code on that file in "Đọc",
// an image → Code's image viewer (← / → step), `.html` → `open_doc` with the absolute path, `http(s)` → `open_url`, and a failure
// says why in a toast (in words, hf1117-fb), a pending open keeps its row busy (spinner + aria-busy) and a conversation link that
// fails to open toasts too (ruling 10:50). The project root has a space and Vietnamese letters (the absolute path `open_doc` gets).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, ORCH, PM, S, test, useEngine } from '../fixtures.ts';

test.use({ tasksStart: true });
const SPEC = 'docs/specs/2026-11-17-v1-docs-design.md';
const ASSETS = 'docs/specs/assets/2026-11-17-v1-docs';
const URL = 'https://example.com/proto';
const NAME = 'tài liệu';
const REF = 'https://example.com/ref';
// the Build session of the spec (on the primary account) records a research note and a prototype link (§10.1 `spec_output_add`)
const eng = useEngine({
  scenarios: {
    [PM]: { steps: [
      { waitUser: SPEC },
      S.mcp('spec_output_add', { path: SPEC, ref: 'docs/notes/nghien-cuu.md', label: 'Nghiên cứu' }),
      S.mcp('spec_output_add', { path: SPEC, ref: URL, label: 'Prototype' }),
      S.result('đã ghi'), ...S.idle()] },
    // hf1117-fb the orchestrator answers with a Markdown link (the conversation's `openExternal`)
    [ORCH]: { steps: [...S.turn(`Xem [tài liệu tham khảo](${REF}).`), ...S.idle()] },
  },
});

type Call = { cmd: string; args: Record<string, unknown> | undefined };
/** the Mac app's bridge: every `invoke` recorded; `open_doc` / `open_url` refuse while `window.__ccFail` names a reason, and
 *  answer only after `window.__ccHang` ms when set (a hung engine) */
async function stubTauri(page: Page): Promise<Call[]> {
  const calls: Call[] = [];
  await page.exposeFunction('__ccInvoked', (cmd: string, args: Record<string, unknown> | undefined) => { calls.push({ cmd, args }); });
  await page.addInitScript(() => {
    const w = window as unknown as { __TAURI__: unknown; __ccFail?: string; __ccHang?: number; __ccInvoked: (c: string, a: unknown) => void };
    w.__TAURI__ = { core: { invoke: (cmd: string, args?: unknown) => {
      w.__ccInvoked(cmd, args);
      if (cmd !== 'open_doc' && cmd !== 'open_url') return Promise.resolve(null);
      const fail = w.__ccFail;
      return new Promise((ok, no) => setTimeout(() => (fail ? no(new Error(fail)) : ok(null)), w.__ccHang ?? 0));
    } } };
  });
  return calls;
}

let pid = '';
let root = '';
test.beforeAll(async () => {
  pid = await eng.addProject(NAME);
  root = eng.repo(NAME);
  for (const d of ['docs/specs/assets', `${ASSETS}-shots`, 'docs/notes']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, SPEC), `# v1 docs\n\n**Status:** approved\n\n## Mục tiêu\n\n${'Nội dung spec để engine nhận vào. '.repeat(12)}\n`);
  writeFileSync(join(root, `${ASSETS}-mockup.html`), '<!doctype html><title>m</title>');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(join(root, `${ASSETS}-shots/a.png`), png);
  writeFileSync(join(root, `${ASSETS}-shots/b.png`), png);
  writeFileSync(join(root, 'docs/notes/nghien-cuu.md'), '# Nghiên cứu tham khảo\n\nGhi chú.\n');
  await eng.cmd({ cmd: 'spec_scan', projectId: pid });
  await eng.cmd({ cmd: 'spec_build', projectId: pid, path: SPEC });
  await expect.poll(async () => {
    const rows = (await eng.cmd({ cmd: 'spec_outputs', projectId: pid, path: SPEC })) as { ref: string }[];
    return rows.map(r => r.ref).sort();
  }, { timeout: 20_000 }).toEqual([SPEC, `${ASSETS}-mockup.html`, `${ASSETS}-shots/a.png`, 'docs/notes/nghien-cuu.md', URL].sort());
});

/** Tasks on the spec (wide: the list + the overview); `place` = the overview block or the list head menu, opened */
async function docs(page: Page, place: 'block' | 'menu'): Promise<Locator> {
  const specId = (await eng.snapshot()).issues?.find(x => x.projectId === pid)?.specs.find(s => s.path === SPEC)?.id;
  await page.addInitScript(([p, id]) => localStorage.setItem('ccs.tasks', JSON.stringify({ [p]: { sel: { spec: id }, issue: null } })), [pid, specId] as const);
  await page.goto(eng.url());
  await page.locator('nav.tabs .tab', { hasText: NAME }).click();
  const tasks = page.locator('#tasks');
  if (place === 'block') return tasks.locator('section.sdocs').first();
  await tasks.locator('button.lbtn[aria-haspopup]', { hasText: 'Tài liệu' }).click();
  return page.getByRole('menu', { name: 'Tài liệu' });
}
const row = (box: Locator, label: string) => box.locator('.drow').filter({ has: box.page().locator('.dl').getByText(label, { exact: true }) });
/** the menu closes on a row click: open it again (the block stays) */
const again = async (page: Page, place: 'block' | 'menu') => {
  if (place === 'menu') await page.locator('#tasks button.lbtn[aria-haspopup]', { hasText: 'Tài liệu' }).click();
};
const fail = (page: Page, why: string) => page.evaluate(w => { (window as { __ccFail?: string }).__ccFail = w; }, why);
const hang = (page: Page, ms: number) => page.evaluate(m => { (window as { __ccHang?: number }).__ccHang = m; }, ms);
const codeTab = (page: Page) => page.locator('.dhead [role=tab]', { hasText: 'Code' });

for (const place of ['block', 'menu'] as const) {
  test.describe(`from the ${place === 'block' ? 'overview "Tài liệu" block' : 'list head "Tài liệu ▾" menu'}`, () => {
    test('.md (spec, research) → Code on THAT file in "Đọc"', async ({ page }) => {
      await stubTauri(page);
      for (const [label, path, heading] of [['Spec', SPEC, 'v1 docs'], ['Nghiên cứu', 'docs/notes/nghien-cuu.md', 'Nghiên cứu tham khảo']] as const) {
        const box = await docs(page, place);
        await row(box, label).click();
        await expect(codeTab(page)).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('group', { name: 'Chế độ xem Markdown' }).getByRole('button', { name: 'Đọc', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible(); // rendered (Nguồn shows `# …` text)
        await expect(page.locator('#root')).toContainText(path.split('/').pop()!);
      }
    });

    test('image → Code image viewer on the first image, ← / → step', async ({ page }) => {
      await stubTauri(page);
      const box = await docs(page, place);
      await row(box, 'Ảnh mockup · 2').click();
      await expect(codeTab(page)).toHaveAttribute('aria-selected', 'true');
      const img = page.locator('.cimg img');
      await expect(img).toHaveAttribute('alt', `${ASSETS}-shots/a.png`);
      await page.keyboard.press('ArrowRight');
      await expect(img).toHaveAttribute('alt', `${ASSETS}-shots/b.png`);
      await page.keyboard.press('ArrowLeft');
      await expect(img).toHaveAttribute('alt', `${ASSETS}-shots/a.png`);
    });

    test('.html → open_doc with the absolute path; a refusal → a toast saying why', async ({ page }) => {
      const calls = await stubTauri(page);
      const box = await docs(page, place);
      await row(box, 'Mockup').click();
      await expect.poll(() => calls.filter(c => c.cmd === 'open_doc')).toEqual([{ cmd: 'open_doc', args: { path: join(root, `${ASSETS}-mockup.html`) } }]);
      await expect(page.locator('#toasts .toast')).toHaveCount(0);

      await fail(page, 'outside_project');
      await again(page, place);
      await row(box, 'Mockup').click();
      await expect(page.locator('#toasts .toast')).toHaveText('Không mở được Mockup: file nằm ngoài các project đang mở');
    });

    test('hf1117-fb a hung open (1.5 s): the row is busy (spinner + aria-busy) within 100 ms, clicks ignored, cleared after', async ({ page }) => {
      const calls = await stubTauri(page);
      const box = await docs(page, place);
      await hang(page, 1500);
      const r = row(box, 'Mockup');
      await r.click();
      await expect(r).toHaveAttribute('aria-busy', 'true', { timeout: 100 });
      await expect(r.locator('.spin')).toBeVisible({ timeout: 100 });
      await r.click(); // ignored while busy
      await page.waitForTimeout(500);
      await expect(r, 'still busy (the menu stays open) while the open is pending').toHaveAttribute('aria-busy', 'true');
      // cleared once it settles; the menu closes only then
      if (place === 'menu') await expect(box).toBeHidden({ timeout: 3000 });
      else {
        await expect(r).not.toHaveAttribute('aria-busy', 'true', { timeout: 3000 });
        await expect(r.locator('.spin')).toHaveCount(0);
      }
      expect(calls.filter(c => c.cmd === 'open_doc')).toHaveLength(1);
      await expect(page.locator('#toasts .toast')).toHaveCount(0);
    });

    test('hf1117-fb a reason with no words of its own → "lỗi không rõ", never the raw code', async ({ page }) => {
      await stubTauri(page);
      const box = await docs(page, place);
      await fail(page, 'zap_unknown');
      await row(box, 'Mockup').click();
      await expect(page.locator('#toasts .toast')).toHaveText('Không mở được Mockup: lỗi không rõ');
    });

    test('http(s) link → open_url; an invoke error → a toast saying why', async ({ page }) => {
      const calls = await stubTauri(page);
      const box = await docs(page, place);
      await row(box, 'Prototype').click();
      await expect.poll(() => calls.filter(c => c.cmd === 'open_url')).toEqual([{ cmd: 'open_url', args: { url: URL } }]);
      await expect(page.locator('#toasts .toast')).toHaveCount(0);
      await fail(page, 'open thoát với mã 1');
      await again(page, place);
      await row(box, 'Prototype').click();
      await expect(page.locator('#toasts .toast')).toHaveText('Không mở được Prototype: open thoát với mã 1');
    });
  });
}

test.describe('hf1117-fb ruling 10:50 a conversation link', () => {
  test.use({ tasksStart: false });
  test('opens through open_url; a refusal → "Không mở được link: <why>" in a toast', async ({ page }) => {
    const calls = await stubTauri(page);
    await page.goto(eng.url());
    await page.locator('nav.tabs .tab', { hasText: NAME }).click();
    await eng.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: pid }, text: 'link' });
    const link = page.locator('#inspector').getByRole('link', { name: 'tài liệu tham khảo' });
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    await expect.poll(() => calls.filter(c => c.cmd === 'open_url')).toEqual([{ cmd: 'open_url', args: { url: REF } }]);
    await expect(page.locator('#toasts .toast')).toHaveCount(0);
    await fail(page, 'bad_url');
    await link.click();
    await expect(page.locator('#toasts .toast')).toHaveText('Không mở được link: link không hợp lệ (chỉ http, https, mailto)');
  });
});
