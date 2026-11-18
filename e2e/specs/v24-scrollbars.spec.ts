// v2.4 §6.8 D54 / §13 auto-hide scrollbars, on the real web over the dev mock, in both engines (projects chromium + webkit, R36 M5).
// The bar is measured in pixels: the gutter right of `clientWidth` is cut from a screenshot and decoded in the page; a column
// counts as lit when its brightest pixel is over 60 (the thumb is ~90, the glass panel up to 41 in WebKit). Shots SB1–SB3
// (chromium) go next to the other v2.4 frames for the mockup check.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.ts';
import { hideDevToasts, openDeck, useDev } from '../deck.ts';
import { shotV24 } from '../v24-shots-seed.ts';

const dev = useDev();
const AWAY: [number, number] = [1300, 860]; // empty deck, far from every scroll box
const HIST = '#inspector .hist';

interface Bar { gutter: number; lit: number; max: number }
/** The vertical gutter of `sel`: its width, the lit columns, the brightest pixel. */
async function bar(page: Page, sel: string): Promise<Bar> {
  const r = await page.locator(sel).first().evaluate(el => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, cw: el.clientWidth, ch: el.clientHeight, cl: el.clientLeft, ct: el.clientTop };
  });
  const clip = { x: r.x + r.cl + r.cw, y: r.y + r.ct, width: r.w - r.cw - 2 * r.cl, height: r.ch };
  if (clip.width < 1 || clip.height < 1) return { gutter: 0, lit: 0, max: 0 };
  const png = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async ([d, g]) => {
    const im = new Image();
    im.src = `data:image/png;base64,${d}`;
    await im.decode();
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const x = c.getContext('2d')!;
    x.drawImage(im, 0, 0);
    const px = x.getImageData(0, 0, c.width, c.height).data;
    let max = 0, lit = 0;
    for (let i = 0; i < c.width; i += 1) {
      let m = 0;
      for (let j = 0; j < c.height; j += 1) { const k = (j * c.width + i) * 4; m = Math.max(m, (px[k]! + px[k + 1]! + px[k + 2]!) / 3); }
      if (m > 60) lit += 1;
      max = Math.max(max, m);
    }
    return { gutter: g, lit: Math.round(lit * g / im.width), max: Math.round(max) }; // device → CSS px (Desktop Safari is 2×)
  }, [png, Math.round(clip.width)] as const);
}
const sb = (page: Page, sel: string) => page.locator(sel).first().getAttribute('data-sb');

/** The mock's Điều phối history is short: its `history` answer gets 60 earlier lines (the SB frames read a long conversation). */
async function longHistory(page: Page): Promise<void> {
  const asked = new Set<string>();
  await page.routeWebSocket(/\/ws\?/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(m => {
      const c = JSON.parse(String(m)) as { id?: string; command?: { cmd?: string; target?: { kind?: string } } };
      if (c.command?.cmd === 'history' && c.command.target?.kind === 'orchestrator' && c.id !== undefined) asked.add(c.id);
      server.send(m);
    });
    server.onMessage(m => {
      const msg = JSON.parse(String(m)) as { type: string; id?: string; result?: { seq: number; ts: number }[] };
      if (msg.type === 'ack' && msg.id !== undefined && asked.delete(msg.id) && Array.isArray(msg.result) && msg.result.length) {
        const first = msg.result[0]!;
        const more = Array.from({ length: 60 }, (_, i) => ({ seq: 0, ts: first.ts - (60 - i) * 60_000, kind: i % 2 ? 'assistant' : 'tool_use',
          ...(i % 2 ? { text: `Đã giao D2 port parser lot-2; B3 đang chạy gate e2e (${i}).` } : { tool: 'lane_message', text: `D2 · "chạy integration lot-2 trước khi commit"` }) }));
        msg.result = [...more, ...msg.result].map((l, i) => ({ ...l, seq: i + 1 }));
      }
      ws.send(JSON.stringify(msg));
    });
  });
}

async function open(page: Page): Promise<void> {
  await longHistory(page);
  await openDeck(page, dev.url('DK5', 'cards=9'));
  await hideDevToasts(page);
  await page.addStyleTag({ content: '#reloadBand{display:none!important}' });
  await page.mouse.move(...AWAY);
  const h = page.locator(HIST);
  await expect(h).toBeVisible();
  await expect.poll(() => h.evaluate(el => el.scrollHeight > el.clientHeight + 100)).toBe(true);
}
async function shot(page: Page, frame: string, project: string): Promise<void> {
  if (project === 'chromium') await shotV24(page, frame, 0);
}
/** a wheel over the conversation, then the pointer leaves (the hover alone would light it too) */
async function userScroll(page: Page, dy = -300): Promise<void> {
  const b = (await page.locator(HIST).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, dy);
  await page.mouse.move(...AWAY);
}

test.describe('§6.8 D54 auto-hide scrollbars', () => {
  test('§6.8 SB1 at rest the 10 px gutter is dark; R36 I2 a programmatic scroll stays dark', async ({ page }, info) => {
    await open(page);
    expect(await bar(page, HIST)).toMatchObject({ gutter: 10, lit: 0 });
    await shot(page, 'SB1', info.project.name);
    await page.locator(HIST).evaluate(el => { el.scrollTop = 0; }); // VirtualHist / tray / lane switch: no user input
    await page.waitForTimeout(200);
    expect(await sb(page, HIST)).toBeNull();
    expect((await bar(page, HIST)).lit).toBe(0);
  });

  test('§6.8 SB2 a user scroll lights a 4 px bar; 800 ms quiet + the 450 ms fade → dark again', async ({ page }, info) => {
    await open(page);
    await userScroll(page);
    await page.waitForTimeout(200);
    expect(await sb(page, HIST)).toBe('on');
    const on = await bar(page, HIST);
    expect(on.lit).toBe(4);
    await page.mouse.move(...AWAY);
    await shot(page, 'SB2', info.project.name);
    await page.waitForTimeout(1400);
    expect(await sb(page, HIST)).toBe('off');
    expect((await bar(page, HIST)).lit).toBe(0);
  });

  test('§6.8 SB3 the pointer on the bar → 8 px and brighter, the gutter stays 10 (no text shift)', async ({ page }, info) => {
    await open(page);
    const h = page.locator(HIST);
    const cw = await h.evaluate(el => el.clientWidth);
    const b = (await h.boundingBox())!;
    const ty = await h.evaluate(el => el.getBoundingClientRect().y + el.clientTop + (el.scrollTop / el.scrollHeight) * el.clientHeight + 12);
    await page.mouse.move(b.x + cw + 5, ty);
    await page.waitForTimeout(200);
    const hi = await bar(page, HIST);
    expect(hi.gutter).toBe(10);
    expect(hi.lit).toBe(8);
    expect(await h.evaluate(el => el.clientWidth)).toBe(cw);
    await shot(page, 'SB3', info.project.name);
  });

  test('§6.8 a press on the dark bar drags at once (the gutter is a real track)', async ({ page }) => {
    await open(page);
    const h = page.locator(HIST);
    expect((await bar(page, HIST)).lit).toBe(0);
    const [x, ty, top] = await h.evaluate(el => {
      const r = el.getBoundingClientRect();
      return [r.x + el.clientLeft + el.clientWidth + 5, r.y + el.clientTop + (el.scrollTop / el.scrollHeight) * el.clientHeight + 12, el.scrollTop];
    });
    await page.mouse.move(x, ty);
    await page.mouse.down();
    await page.mouse.move(x, ty - 30, { steps: 4 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r))); // WebKit: one frame before up, else 0 px (measured)
    await page.mouse.up();
    expect(top - await h.evaluate(el => el.scrollTop)).toBeGreaterThan(60);
  });

  test('§6.8 prefers-reduced-motion: the bar shows at once (no fade in)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await userScroll(page);
    await page.waitForTimeout(30);
    expect((await bar(page, HIST)).lit).toBe(4);
  });

  test('§6.8 R36 I1 a scrolled ⋯ menu re-hovered keeps opacity 1 (its drop-in does not replay)', async ({ page }) => {
    await open(page);
    await page.addStyleTag({ content: '.amenu{max-height:90px!important}' }); // make the list scroll
    await page.locator('.react-flow__node[data-id^="orch:"]').first().locator('button.more').click();
    const menu = page.locator('.amenu').first();
    await expect(menu).toBeVisible();
    // the box that scrolls (`.ams` today); the check holds whichever element it is
    const both = page.locator('.amenu, .amenu .ams');
    await expect.poll(() => both.evaluateAll(els => els.some(el => el.scrollHeight > el.clientHeight + 1))).toBe(true);
    const box = both.nth(await both.evaluateAll(els => els.findIndex(el => el.scrollHeight > el.clientHeight + 1)));
    const b = (await menu.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(0, 60);
    await expect.poll(() => box.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await page.mouse.move(b.x + b.width + 40, b.y + b.height / 2); // off the menu, the menu stays open
    await page.waitForTimeout(1300); // 800 ms idle → data-sb=off (+ its fade)
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(20);
    const op = await both.evaluateAll(els => els.map(el => getComputedStyle(el).opacity));
    expect(op.every(o => o === '1')).toBe(true);
  });
});
