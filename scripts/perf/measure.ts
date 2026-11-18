// Perf audit runner: drives the dev web app (Vite + mock engine + scripts/perf/storm-proxy.ts) in Playwright and prints one
// JSON line per scenario. Usage: bun scripts/perf/measure.ts [webkit|chromium] [storm lines/s] [width]x[height] [deck,tasks,vhist,cold]
// Needs: mock on 4871, proxy on 4872, `CC_ENGINE_URL=ws://127.0.0.1:4872 bunx vite --port 5771` (see scripts/perf/README.md).
import { chromium, webkit, type Page } from '@playwright/test';
import { installProbe, type Perf as ProbePerf } from './probe.ts';

const [eng = 'webkit', stormArg = '20', size = '1440x900', only = ''] = process.argv.slice(2);
const [W, H] = size.split('x').map(Number) as [number, number];
const BASE = process.env.PERF_URL ?? 'http://localhost:5771';
const browser = await (eng === 'chromium' ? chromium : webkit).launch();

type Perf = Omit<ProbePerf, 'reset'> & { heap?: number };
type Win = Window & { __perf: ProbePerf };

const q = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10; };
function sum(p: Perf, secs: number) {
  const gaps = p.frames.slice(1).map((t, i) => t - p.frames[i]!);
  const top = Object.entries(p.byName).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n}:${c}`).join(' ');
  return {
    secs, commits: p.commits, commitsPerS: Math.round(p.commits / secs), fibersPerCommit: p.commits ? Math.round(p.rendered / p.commits) : 0, mounted: p.mounted,
    reactMs: Math.round(p.renderMs), fps: Math.round(gaps.length / secs), frameP50: q(gaps, 0.5), frameP95: q(gaps, 0.95), frameMax: q(gaps, 1),
    frames33: gaps.filter(g => g > 33.4).length, frames50: gaps.filter(g => g > 50).length,
    inputs: p.inputs.map(i => `${i.type}:${i.what.slice(0, 18)}=${Math.round(i.ms)}`).slice(0, 12), inputP95: q(p.inputs.map(i => i.ms), 0.95), inputMax: q(p.inputs.map(i => i.ms), 1),
    wsN: p.ws.length, wsP50: q(p.ws.map(w => w.ms), 0.5), wsP95: q(p.ws.map(w => w.ms), 0.95), wsMax: q(p.ws.map(w => w.ms), 1),
    long: p.longtasks.length, longMax: q(p.longtasks.map(l => l.ms), 1), longSum: Math.round(p.longtasks.reduce((a, l) => a + l.ms, 0)),
    loaf: p.loaf.length, loafStyleMax: q(p.loaf.map(l => l.style), 1), loafTop: p.loaf.sort((a, b) => b.ms - a.ms).slice(0, 2).map(l => `${Math.round(l.ms)}ms[${l.scripts.join(',')}]`),
    cls: Math.round(p.shifts.reduce((a, s) => a + s.v, 0) * 1000) / 1000, shiftSrc: [...new Set(p.shifts.flatMap(s => s.src))].slice(0, 6),
    eventMax: q(p.events.map(e => e.ms), 1), top, mountTop: Object.entries(p.mountBy).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n}:${c}`).join(' '),
    heapMB: p.heap ? Math.round(p.heap / 1e6) : null,
  };
}

async function open(page: Page, frame: string, storm: number) {
  await page.addInitScript(installProbe, storm);
  await page.goto(`${BASE}/?f=${frame}`);
  await page.waitForFunction(() => document.querySelectorAll('#hud button').length > 3, null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
}
const reset = (page: Page, walk = true) => page.evaluate(w => { const P = (window as unknown as Win).__perf; P.reset(); P.walk = w; }, walk);
const read = (page: Page): Promise<Perf> => page.evaluate(() => ({ ...(JSON.parse(JSON.stringify((window as unknown as Win).__perf)) as Perf),
  heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize }));
async function run(name: string, page: Page, fn: () => Promise<void>, settle = 800, walk = true) {
  try {
    await reset(page, walk);
    const t0 = Date.now();
    await fn();
    await page.waitForTimeout(settle);
    const r = sum(await read(page), (Date.now() - t0) / 1000);
    console.log(JSON.stringify({ eng, size, storm: Number(stormArg), name, ...r }));
  } catch (e) { console.log(JSON.stringify({ eng, name, error: String(e).slice(0, 200) })); }
}
const mode = (page: Page, m: string) => page.locator('#hud button', { hasText: new RegExp(`^${m}`) }).first().click();
const want = (n: string) => !only || only.split(',').includes(n);
const storm = Number(stormArg);

// ---------- Deck (DK5L: 5 accounts × 24 lanes; PERF_DECK=DK300L for 300 accounts) ----------
if (want('deck')) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await open(page, process.env.PERF_DECK ?? 'DK5L', storm);
  await mode(page, 'Deck'); await page.waitForTimeout(1500);
  await run('deck-idle-5s', page, () => page.waitForTimeout(5000), 0);
  await run('deck-idle-5s-nowalk', page, () => page.waitForTimeout(5000), 0, false);
  await run('mode-cycle', page, async () => { for (const m of ['Tasks', 'Deck', 'Code', 'Git', 'Deck', 'Tasks', 'Deck']) { await mode(page, m); await page.waitForTimeout(700); } });
  const node = page.locator('.react-flow__node').nth(3);
  await run('select-lane', page, async () => { await node.click(); });
  await run('select-orch', page, async () => { await page.locator('.react-flow__node').first().click(); });
  await run('acc-panel', page, async () => {
    const t = page.locator('.accp.mini, .accp .acb[aria-label]').last();
    await t.click(); await page.waitForTimeout(700); await page.locator('.accp .acb').last().click().catch(() => {});
  });
  const pane = page.locator('.react-flow__pane').first();
  const bb = (await pane.boundingBox())!;
  await run('deck-drag', page, async () => {
    const x = bb.x + bb.width * 0.6, y = bb.y + bb.height * 0.5;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 0; i < 60; i++) await page.mouse.move(x - i * 5, y - i * 2);
    await page.mouse.up();
  }, 300);
  await run('deck-zoom', page, async () => {
    await page.mouse.move(bb.x + bb.width * 0.6, bb.y + bb.height * 0.5);
    for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, i < 15 ? -60 : 60); await page.waitForTimeout(16); }
  }, 300);
  const stream = page.locator('#left .stream, #left [class*=hist], #left .vh').first();
  await run('stream-scroll', page, async () => {
    const b = (await page.locator('#left').boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.5);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, i < 20 ? -120 : 120); await page.waitForTimeout(16); }
  }, 300);
  void stream;
  await run('compose-type', page, async () => { await page.locator('#cmd').click(); await page.keyboard.type('đang gõ thử trong lúc stream chạy nhé', { delay: 60 }); }, 300);
  await run('model-menu', page, async () => { await page.locator('.mchip').first().click(); await page.waitForTimeout(600); await page.keyboard.press('Escape'); });
  await run('deck-storm-10s', page, () => page.waitForTimeout(10_000), 0);
  await run('deck-storm-10s-nowalk', page, () => page.waitForTimeout(10_000), 0, false);
  await page.close();
}

// ---------- Tasks (IS2: v2.5 + the done specs; v2.1 = 52 issues) ----------
if (want('tasks')) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await open(page, 'IS2', storm);
  await run('tasks-idle-5s', page, () => page.waitForTimeout(5000), 0);
  await run('spec-pick', page, async () => { await page.getByText('v2.1 Node graph', { exact: false }).first().click(); });
  await run('xong-expand', page, async () => { const m = page.getByText(/Xem thêm/).nth(1); if (await m.count()) await m.click(); });
  await run('issue-scroll', page, async () => {
    const b = (await page.locator('.tsk .lbody').first().boundingBox()) ?? { x: 600, y: 300, width: 200, height: 200 };
    await page.mouse.move(b.x + b.width / 2, Math.min(b.y + 200, H - 100));
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, i < 20 ? 120 : -120); await page.waitForTimeout(16); }
  }, 300);
  await run('spec-pick-v25', page, async () => { await page.getByText('v2.5 Toolkit graph').first().click(); });
  await run('docs-menu', page, async () => { await page.getByRole('button', { name: /Tài liệu/ }).first().click(); await page.waitForTimeout(500); await page.keyboard.press('Escape'); });
  await run('issue-open', page, async () => { await page.locator('.tsk .lrow', { hasText: 'T-47' }).first().click(); });
  await run('cancel-dialog', page, async () => { const b = page.getByRole('button', { name: /^Huỷ/ }).first(); if (await b.count()) { await b.click(); await page.waitForTimeout(500); await page.keyboard.press('Escape'); } });
  await run('tasks-storm-5s', page, () => page.waitForTimeout(5000), 0);
  await page.close();
}

// ---------- Conversation stability (IS2 Deck, no storm): idle commits, scroll-up drift, position across Tasks ↔ Deck ----------
if (want('vhist')) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await open(page, 'IS2', 0);
  await mode(page, 'Deck'); await page.waitForTimeout(1500);
  await run('vhist-idle-10s', page, () => page.waitForTimeout(10_000), 0); // healthy: ≈ 1 commit/s (the clock)
  const drift = await page.evaluate(async () => { // a visible row must move exactly by the scroll delta
    const h = document.querySelector('#left .hist') as HTMLElement, out: number[] = [];
    for (let i = 0; i < 15; i++) {
      const row = ([...h.querySelectorAll(':scope > [data-vk]')] as HTMLElement[]).find(r => r.getBoundingClientRect().top > 300)!;
      const k = row.dataset.vk!, t0 = row.getBoundingClientRect().top, s0 = h.scrollTop;
      h.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); h.scrollTop = s0 - 100;
      for (let f = 0; f < 4; f++) await new Promise(r => requestAnimationFrame(r));
      const n = h.querySelector<HTMLElement>(`:scope > [data-vk="${CSS.escape(k)}"]`);
      if (n && h.scrollTop > 200) out.push(Math.round(n.getBoundingClientRect().top - t0 - (s0 - h.scrollTop)));
    }
    return out;
  });
  const rowAt = () => page.evaluate(() => { const h = document.querySelector('#left .hist') as HTMLElement; const r = ([...h.querySelectorAll(':scope > [data-vk]')] as HTMLElement[]).find(x => x.getBoundingClientRect().top > 300)!; return { k: r.dataset.vk!, top: Math.round(r.getBoundingClientRect().top) }; });
  const before = await rowAt();
  await mode(page, 'Tasks'); await page.waitForTimeout(800); await mode(page, 'Deck'); await page.waitForTimeout(800);
  const after = await page.evaluate(k => { const r = document.querySelector<HTMLElement>(`#left .hist > [data-vk="${CSS.escape(k)}"]`); return r ? Math.round(r.getBoundingClientRect().top) : null; }, before.k);
  console.log(JSON.stringify({ eng, name: 'vhist-stability', scrollDriftPx: drift, driftSteps: drift.filter(d => d).length, tasksRoundTripShiftPx: after === null ? 'row gone' : after - before.top }));
  await page.close();
}

// ---------- Cold start (bundle parse / first paint) ----------
if (want('cold')) {
  for (let i = 0; i < 3; i++) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const t0 = Date.now();
    await page.goto(`${BASE}/?f=DK300L`);
    await page.waitForFunction(() => document.querySelectorAll('#hud button').length > 3, null, { timeout: 20_000 });
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming; const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: fcp ? Math.round(fcp.startTime) : null, res: performance.getEntriesByType('resource').length }; });
    console.log(JSON.stringify({ eng, name: `cold-${i}`, uiReadyMs: Date.now() - t0, ...nav }));
    await page.close();
  }
}
await browser.close();
