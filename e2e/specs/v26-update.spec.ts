// v2.6 §13 "Web": the update chip and its frames (UP1–UP6d) in the real web app inside a stubbed Mac app (`window.__TAURI__`):
// `update_state` answers the state the test sets, and the Tauri event `update_state` is pushed from the test. Each frame is
// shot light + dark at 1440 and 1024 into `.local/shots/v26-w1/` (looked at against the mockup by the lane, not committed).
// R17: with the engine gone (UP6d) the top bar dims, the chip does not, and it still opens its frame.
// W2: the "Cập nhật" row of Settings → Engine (UP7a–c, UP7r, §5.6), a real update hold on the engine (the app's WS stood in
// by the test) → the "giữ lại" label (UP8) until `po_written`, and the remote channel's line (UP9) → `.local/shots/v26-w2/`.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { ORCH, S, expect, test, useEngine } from '../fixtures.ts';

const DIR = join(import.meta.dirname, '../../.local/shots/v26-w1');
const DIR2 = join(import.meta.dirname, '../../.local/shots/v26-w2');
const DIR3 = join(import.meta.dirname, '../../.local/shots/v26-fw');
const NOW = Date.now();
const NOTES = '- Điều phối không còn mất tin khi đổi account giữa lượt.\n- Chip model hiện đúng effort sau khi app khởi động lại.\n- Kéo thả nhiều file một lần không còn rơi mất file cuối.\n- Bảng Git mở nhanh hơn ở repo có nhiều nhánh.\n- Thêm nút "Kiểm tra cập nhật" trong Cài đặt → Engine.';
const AVAIL = { state: 'available', version: '0.3.1', notes: NOTES, current: '0.3.0', dismissed: false };
const b = (projectId: string, kind: string, name: string, mins: number) => ({ projectId, kind, name, turnStartedAt: NOW - mins * 60_000 });
const W3 = (pid: string) => [b(pid, 'lane', 'B3', 12), b(pid, 'lane', 'D2', 7), b(pid, 'orchestrator', 's1', 2)];
const W = (busy: unknown[], held: number, installed = false) => ({ state: 'waiting', version: '0.3.1', busy, held, since: NOW - 3 * 60_000, installed });
const E = (stage: string, reason: string, badSignature = false) => ({ state: 'error', stage, reason, version: '0.3.1', badSignature });

async function stubTauri(page: Page) {
  await page.addInitScript(s => {
    type Cb = (e: { payload: unknown }) => void;
    const w = window as unknown as { __TAURI__: unknown; __ccUpd: unknown; __ccCalls: string[]; __ccEmit?: Cb };
    const cbs: Cb[] = []; // the chip and the Settings row each listen
    w.__ccUpd = s;
    w.__ccCalls = [];
    w.__ccEmit = e => { w.__ccUpd = e.payload; for (const cb of cbs) cb(e); };
    w.__TAURI__ = {
      core: { invoke: (cmd: string) => { w.__ccCalls.push(cmd); return Promise.resolve(cmd === 'update_state' ? w.__ccUpd : null); } },
      event: { listen: (name: string, cb: Cb) => { if (name === 'update_state') cbs.push(cb); return Promise.resolve(() => { cbs.splice(cbs.indexOf(cb), 1); }); } },
      window: { getCurrentWindow: () => ({ setFocus: () => Promise.resolve(), setTheme: () => Promise.resolve(), onThemeChanged: () => Promise.resolve(() => {}) }) },
    };
  }, { state: 'idle', checkedAt: null });
}
const set = (page: Page, s: unknown) => page.evaluate(v => (window as unknown as { __ccEmit: (e: { payload: unknown }) => void }).__ccEmit({ payload: v }), s);

for (const theme of ['dark', 'light'] as const) test.describe(`v2.6 update chip · ${theme}`, () => {
  test.use({ theme });
  const eng = useEngine({ scenarios: () => ({ [ORCH]: { steps: [...S.idle()] } }) });
  let pid = '';
  test.beforeAll(async () => { pid = await eng.addProject('hagent-os'); });

  test(`UP1–UP6d chip + frames (${theme})`, async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(DIR, { recursive: true });
    await stubTauri(page);
    await page.goto(eng.url());
    const chip = page.locator('#top .upc');
    const pop = page.locator('.upop');
    await expect(page.locator('#top')).toBeVisible();
    await expect(chip).toHaveCount(0); // idle: no chip
    const shot = async (frame: string, open: boolean) => {
      for (const [w, h] of [[1440, 900], [1024, 640]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(120);
        if (open) await expect(pop).toBeVisible();
        await page.screenshot({ path: join(DIR, `${frame}-${theme}-${w}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    };
    const frame = async (name: string, s: unknown, open = true) => {
      if (await pop.count()) await page.keyboard.press('Escape');
      await set(page, s);
      if (open) await chip.click();
      await shot(name, open);
    };

    await frame('UP1', AVAIL, false);
    await expect(chip.locator('.upc-t')).toHaveText('Bản mới 0.3.1');
    await expect(chip.locator('+ *')).toHaveAttribute('aria-label', 'Giao diện'); // R21 right before the theme button
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(chip).toHaveAttribute('title', 'Bản mới 0.3.1');
    await page.screenshot({ path: join(DIR, `UP1n-${theme}-1100.png`) });
    await page.setViewportSize({ width: 1440, height: 900 });
    await frame('UP2b', AVAIL);
    await expect(pop).toContainText('App sẽ khởi động lại ngay sau khi tải xong.');
    await frame('UP2', { ...AVAIL }, true);
    await frame('UP3', { state: 'downloading', version: '0.3.1', done: 38 * 1048576, total: 91 * 1048576 });
    await expect(pop).toContainText('Đang tải 42% · 38 / 91 MB');
    await frame('UP4', W(W3(pid), 0));
    await expect(pop).toContainText('Đang chờ để cập nhật · 3 phút');
    await frame('UP4b', W(W3(pid).slice(1), 3));
    await expect(pop).toContainText('Đang giữ 3 tin — gửi sau khi cập nhật');
    await frame('UP4c', W([b(pid, 'lane', 'D2', 1)], 3, true));
    await frame('UP4d', { state: 'installed', version: '0.3.1' });
    await frame('UP6a', E('download', 'mất kết nối giữa chừng'));
    await frame('UP6b', E('download', 'signature', true));
    await frame('UP6c', E('install', 'chưa nhập mật khẩu quản trị'));
    await frame('UP5', { state: 'installing', version: '0.3.1' }, false);
    await expect(page.locator('.upinst')).toContainText('Đang cài cc-slaves 0.3.1… app sẽ tự mở lại');

    // UP6d R17: the engine goes away; the bar dims, the chip stays lit and opens its frame; Thử lại waits for the engine
    await set(page, E('wait', 'closed'));
    await eng.kill();
    await expect(page.locator('body.offline')).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => page.locator('#top .ib').last().evaluate(e => getComputedStyle(e).opacity)).toBe('0.55'); // the bar dims (a transition)
    expect(await chip.evaluate(e => getComputedStyle(e).opacity)).toBe('1');
    await chip.click();
    await expect(pop.getByRole('button', { name: 'Thử lại' })).toBeDisabled();
    await shot('UP6d', true);
    await eng.start();
  });
});

// v26-fw M4: a Điều phối mid-turn (its reply never ends here) → UP2 / UP4d say "App sẽ đợi 1 lượt…" instead of "ngay"
for (const theme of ['dark', 'light'] as const) test.describe(`v2.6 update frames mid-turn · ${theme}`, () => {
  test.use({ theme });
  const eng = useEngine({ scenarios: () => ({ [ORCH]: { steps: [...S.turn('ok'), S.wait, S.partial('Đang xem B3…'), S.sleep(90_000)] } }) });
  test.beforeAll(async () => { await eng.addProject('hagent-os'); });

  test(`UP2 / UP4d busy copy (${theme})`, async ({ page }) => {
    test.setTimeout(60_000);
    mkdirSync(DIR3, { recursive: true });
    await stubTauri(page);
    await page.goto(eng.url());
    const input = page.getByLabel('Ô lệnh');
    await input.fill('Xem B3 giúp anh.');
    await input.press('Enter');
    await expect(page.locator('#inspector .m-text.live')).toHaveCount(1); // the turn is running
    const chip = page.locator('#top .upc'), pop = page.locator('.upop');
    const busy = 'App sẽ đợi 1 lượt đang chạy xong rồi khởi động lại; tin gửi trong lúc đợi được giữ lại và gửi sau.';
    for (const [name, st] of [['UP2', AVAIL], ['UP4d', { state: 'installed', version: '0.3.1' }]] as const) {
      if (await pop.count()) await page.keyboard.press('Escape');
      await set(page, st);
      await chip.click();
      await expect(pop.locator('.imp')).toHaveText(busy);
      for (const [w, h] of [[1440, 900], [1024, 640]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(120);
        await page.screenshot({ path: join(DIR3, `${name}-busy-${theme}-${w}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    // M6 the focused composer frame: a neutral --fg-2 ring, never accent (PO 16/11 BANNED look)
    await page.keyboard.press('Escape');
    await input.focus();
    await expect(page.locator('.inrow')).toHaveCSS('box-shadow', /inset/);
    await page.screenshot({ path: join(DIR3, `M6-composer-focus-${theme}-1440.png`) });
  });
});

/** Shots of a W2 frame: light / dark × 1440 / 1024. */
async function shot2(page: Page, frame: string, theme: string) {
  mkdirSync(DIR2, { recursive: true });
  for (const [w, h] of [[1440, 900], [1024, 640]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(DIR2, `${frame}-${theme}-${w}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
/** The app's long-lived WS (§5.4) stood in by the test: `update_hold {on: true}`; closing it releases the hold (§5.4-6). */
async function holdOn(eng: { port: number; token: string }): Promise<() => void> {
  const ws = new WebSocket(`ws://127.0.0.1:${eng.port}/ws?token=${encodeURIComponent(eng.token)}`, { headers: { origin: `http://127.0.0.1:${eng.port}` } } as never);
  await new Promise<void>((res, rej) => {
    ws.onerror = () => rej(new Error('ws error'));
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; id?: string; message?: string };
      if (msg.type === 'snapshot') ws.send(JSON.stringify({ type: 'command', id: 'hold', command: { cmd: 'update_hold', on: true } }));
      else if (msg.id === 'hold') { if (msg.type === 'ack') res(); else rej(new Error(msg.message)); }
    };
  });
  return () => ws.close();
}

for (const theme of ['dark', 'light'] as const) test.describe(`v2.6 W2 Settings row, held label, remote line · ${theme}`, () => {
  test.use({ theme });
  const eng = useEngine({ scenarios: () => ({ [ORCH]: { steps: [...S.idle()] } }) });
  test.beforeAll(async () => { await eng.addProject('hagent-os'); });

  test(`UP7a–c, UP7r, §5.6 the "Cập nhật" row (${theme})`, async ({ page }) => {
    test.setTimeout(120_000);
    await stubTauri(page);
    await page.goto(eng.url());
    await page.getByRole('button', { name: 'Cài đặt' }).click();
    await page.getByRole('tab', { name: 'Engine' }).click();
    const form = page.locator('.set .form');
    await expect(form.locator('> .foot').nth(2)).toHaveText('Cập nhật'); // right under "Phiên bản"
    await expect(form).toContainText(/cc-slaves \d+\.\d+\.\d+ · giao thức \d+ · claude/);
    const row = page.locator('.uprow'), text = row.locator('.upr-t');
    const at = new Date(2026, 10, 18, 14, 5).getTime();
    const frame = async (name: string, st: unknown, want: string | RegExp) => { await set(page, st); await expect(text).toHaveText(want); await shot2(page, name, theme); };
    await frame('UP7a', { state: 'idle', checkedAt: at }, 'Đã là bản mới nhất · kiểm tra lúc 14:05');
    await row.getByRole('button', { name: 'Kiểm tra cập nhật' }).click();
    expect(await page.evaluate(() => (window as unknown as { __ccCalls: string[] }).__ccCalls)).toContain('update_check');
    await frame('UP7b', { state: 'checking' }, 'Đang kiểm tra…');
    await expect(row.getByRole('button', { name: 'Kiểm tra cập nhật' })).toBeDisabled();
    await frame('UP7c', E('check', 'không có mạng'), 'Không kiểm tra được: không có mạng');
    await frame('UP7r-avail', { ...AVAIL, dismissed: true }, 'Có bản 0.3.1');
    await row.getByRole('button', { name: 'Cập nhật' }).click();
    expect(await page.evaluate(() => (window as unknown as { __ccCalls: string[] }).__ccCalls)).toContain('update_start');
    await frame('UP7r-dl', { state: 'downloading', version: '0.3.1', done: 42, total: 100 }, 'Đang tải 42%');
    await frame('UP7r-wait', W([b('p', 'lane', 'D2', 9), b('p', 'orchestrator', 's1', 4)], 0), 'Chờ 2 lượt xong');
    await frame('UP7r-err', E('download', 'mất kết nối giữa chừng'), 'Tải bản 0.3.1 lỗi: mất kết nối giữa chừng. Chưa\u00a0cài\u00a0gì.');
    await frame('UP7r-installed', { state: 'installed', version: '0.3.1' }, 'Đã cài 0.3.1');
    // §5.6 the first run after an update: this Mac last ran an older version
    await page.keyboard.press('Escape');
    await page.evaluate(() => localStorage.setItem('ccs.update.seen', JSON.stringify({ v: '0.0.1', at: 1, from: null })));
    await set(page, { state: 'idle', checkedAt: at });
    await page.getByRole('button', { name: 'Cài đặt' }).click();
    await page.getByRole('tab', { name: 'Engine' }).click();
    await expect(text).toHaveText(/^Đã cập nhật lên \d+\.\d+\.\d+ lúc \d\d:\d\d$/);
    await shot2(page, 'UP7r-after', theme);
  });

  test(`UP8 the "giữ lại" label until written, UP9 the remote line (${theme})`, async ({ page }) => {
    test.setTimeout(120_000);
    await stubTauri(page);
    await page.goto(eng.url());
    const input = page.getByLabel('Ô lệnh');
    await expect(input).toBeVisible();
    const release = await holdOn(eng);
    try {
      await set(page, W([], 0)); // the chip as in the mockup frame (its state comes from the app, stubbed here)
      for (const t of ['Sau khi B3 xong gate thì merge vào main giúp anh.', 'Nhớ ghi HANDOFF trước khi nghỉ.']) { await input.fill(t); await input.press('Enter'); }
      const held = page.locator('#inspector .m-po .m-hold');
      await expect(held).toHaveCount(2);
      await expect(held.first()).toHaveText('giữ lại — gửi sau khi cập nhật');
      await shot2(page, 'UP8', theme);

      // UP9 a remote browser (the dev engine only has the Mac listener: its snapshot is relabelled `remote` on the way in)
      const remote = await page.context().newPage();
      await remote.routeWebSocket(/\/ws\?/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((m) => server.send(m));
        server.onMessage((m) => {
          const msg = JSON.parse(String(m)) as { type: string; snapshot?: { channel: string } };
          if (msg.type === 'snapshot') msg.snapshot!.channel = 'remote';
          ws.send(JSON.stringify(msg));
        });
      });
      await remote.goto(eng.url());
      const line = remote.locator('#top .uphold');
      await expect(line).toHaveText('Mac đang chờ để cập nhật — tin gửi sẽ được giữ');
      await expect(line.locator('button')).toHaveCount(0);
      await expect(remote.locator('#top .upc')).toHaveCount(0);
      await shot2(remote, 'UP9', theme);
      // v26-fw I1: the line folds (ellipsis, then the hourglass + its title ≤ 900 px); the gear stays on screen
      await expect(line).toHaveAttribute('title', 'Mac đang chờ để cập nhật — tin gửi sẽ được giữ');
      const gear = remote.getByRole('button', { name: 'Cài đặt' });
      mkdirSync(DIR3, { recursive: true });
      for (const [w, h] of [[1024, 640], [768, 900], [390, 844]] as const) {
        await remote.setViewportSize({ width: w, height: h });
        await remote.waitForTimeout(150);
        await remote.screenshot({ path: join(DIR3, `UP9-${theme}-${w}.png`) });
        await expect(gear).toBeInViewport({ ratio: 1 });
        const r = await line.evaluate(e => e.getBoundingClientRect().right);
        expect(r).toBeLessThanOrEqual(w);
      }
      await remote.close();
    } finally { release(); }
    // §5.4-6 the holder is gone → the engine writes the held lines → `po_written` → the labels go
    await expect(page.locator('#inspector .m-po .m-hold')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => eng.read(`stdin-${ORCH}.log`)).toContain('[PO] Nhớ ghi HANDOFF trước khi nghỉ.');
  });
});
