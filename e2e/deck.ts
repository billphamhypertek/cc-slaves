// v2.1 deck e2e helpers (spec §6): a dev-frame server (web/dev/mock-engine.ts + Vite dev, random ports) for scenes the
// engine harness cannot seed cheaply (30 / 300 accounts, 24 lanes, sessions, §4.10 screens), and real-DOM measurements
// of the React Flow deck (node boxes vs the HUD and deck-frame obstacles).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test } from './fixtures.ts';

const WEB = resolve(import.meta.dirname, '..', 'web');
const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

/** Set by web/src/deck/DeckView.tsx: pause state + running animations. */
declare global { interface Window { __ccDeck?: { paused: boolean; why: string[]; running(): number } } }

export interface DevServer { url(frame: string, q?: string): string }

/** Mock engine + Vite dev for the whole spec file; `url('DK300')` opens a dev frame (web/dev/scenarios.ts); `q` = extra
 *  query (`remote=1` → the remote channel). */
export function useDev(): DevServer {
  const procs: ChildProcess[] = [];
  let base = '';
  test.beforeAll(async () => {
    test.setTimeout(60_000);
    const mock = await freePort(), vite = await freePort();
    procs.push(spawn('bun', [resolve(WEB, 'dev/mock-engine.ts')], { cwd: WEB, env: { ...process.env, MOCK_PORT: String(mock) }, stdio: 'ignore' }));
    procs.push(spawn('bunx', ['vite', '--port', String(vite), '--strictPort', '--host', '127.0.0.1'],
      { cwd: WEB, env: { ...process.env, CC_ENGINE_URL: `ws://127.0.0.1:${mock}` }, stdio: 'ignore' }));
    base = `http://127.0.0.1:${vite}/`;
    const end = Date.now() + 30_000;
    while (!(await fetch(base).then(r => r.ok).catch(() => false))) {
      if (Date.now() > end) throw new Error('vite dev did not come up');
      await new Promise(r => setTimeout(r, 200));
    }
  });
  test.afterAll(() => { for (const p of procs) p.kill(); });
  return { url: (f: string, q = '') => `${base}?f=${encodeURIComponent(f)}${q ? `&${q}` : ''}` };
}

/** Open a frame and wait until the deck has drawn, its fonts are in and the open auto-fit (§4.9, 300 ms) has settled. */
export async function openDeck(page: Page, url: string, ready = '.react-flow__node'): Promise<void> {
  await page.goto(url);
  await page.locator(ready).first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
}

/** Hide the dev toasts so a screenshot shows only the frame (v21-shots). */
export const hideDevToasts = (page: Page) => page.addStyleTag({ content: '#toasts{display:none!important}' });

/** Move the focus off any text field so one-letter keys reach the app (v1 M8). */
export const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** The deck viewport transform (`translate(x, y) scale(z)`) — moves on pan / zoom / fit. */
export const viewport = (page: Page) => page.locator('.react-flow__viewport').evaluate(e => getComputedStyle(e).transform);

/** The `.react-flow` canvas rect: the deck area that must never resize when something is selected or opened. */
export const deckRect = (page: Page) => page.locator('.react-flow').evaluate(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); });

/** The lane / root / sub the left column shows (`#inspector` crumb). */
export const crumb = (page: Page) => page.locator('#inspector .crumb').innerText().then(t => t.replace(/\s+/g, ' ').trim());

/** §6 HUD + deck-frame obstacles (top bar, left column, header bar, account card, zoom buttons, minimap, edge markers,
 *  offline strip, narrow "Chờ PO" button); a hidden or 0 × 0 box is not an obstacle. */
const OBSTACLES = ['#top', '#left', '.dhead', '.accp', '.dzoom', '.dmini', '.dmark', '.cband', '#inboxBtn'] as const;

export interface DeckMeasure {
  /** nodes wholly inside the window (the ones measured) / all nodes */
  shown: number; nodes: number;
  /** "lane:D2×.dhead" (node under an obstacle), "lane:D2×lane:D3" (node over node); empty = pass */
  bad: string[];
}

/** §6 "vừa màn hình": every node wholly on screen vs every obstacle, and node vs node. Tolerance 0.5 px. */
export function measureDeck(page: Page): Promise<DeckMeasure> {
  return page.evaluate((sels) => {
    type R = { x: number; y: number; w: number; h: number; id: string };
    const E = 0.5;
    const ov = (a: R, b: R) => a.x + E < b.x + b.w && b.x + E < a.x + a.w && a.y + E < b.y + b.h && b.y + E < a.y + a.h;
    const box = (e: Element, id: string): R => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, id }; };
    const all = [...document.querySelectorAll('.react-flow__node')].map(e => box(e, (e as HTMLElement).dataset.id!));
    const shown = all.filter(n => n.x >= -E && n.y >= -E && n.x + n.w <= innerWidth + E && n.y + n.h <= innerHeight + E);
    const obs = sels.flatMap(s => [...document.querySelectorAll(s)].filter(e => {
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    }).map(e => box(e, s)));
    const bad: string[] = [];
    for (const n of shown) for (const o of obs) if (ov(n, o)) bad.push(`${n.id}×${o.id}`);
    shown.forEach((a, i) => shown.forEach((b, j) => { if (j > i && ov(a, b)) bad.push(`${a.id}×${b.id}`); }));
    return { shown: shown.length, nodes: all.length, bad };
  }, OBSTACLES as unknown as string[]);
}

/** Labels of the open "⋯" menu (and of every submenu it opens on hover). */
export async function menuLabels(page: Page): Promise<string[]> {
  const menu = page.locator('.amenu[role=menu]').first();
  await menu.waitFor();
  const out: string[] = [];
  for (const it of await menu.locator('[role=menuitem]').all()) {
    out.push((await it.locator('.lb').innerText()).split('\n')[0]!.trim());
    if (await it.getAttribute('aria-haspopup')) {
      await it.hover();
      const sub = page.locator('.amenu.amsub');
      await sub.waitFor();
      for (const s of await sub.locator('[role=menuitem] .lb').allInnerTexts()) out.push(s.split('\n')[0]!.trim());
    }
  }
  return out;
}
