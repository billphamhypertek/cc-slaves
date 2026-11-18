// v2.1 §6 "So với mockup": each §11 frame N1-a…N6-l driven into its state on the dev mock engine (web/dev, frames DK* /
// DKS / DKX / F*) and saved as docs/specs/assets/screens/v21-<frame>.png at the mockup's window (1440 × 900; N4-g / N4-j
// 1024 × 640; N1-d 1440 × 880), plus 30 / 300 accounts and `en` (N1-a, N2-a, N5-a, N6-a). Looks are judged later by an
// independent UX review against docs/specs/assets/screens/v21-mockup/<frame>.png; here only "the state is reached".
// Skipped: N0-* (old layout), N6-h (the macOS notification banner itself needs the real Tauri shell).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.ts';
import { hideDevToasts, openDeck, useDev } from '../deck.ts';
import { node } from '../v21-seed.ts';

const DIR = join(import.meta.dirname, '../../docs/specs/assets/screens');
const dev = useDev();

type Act = (page: Page) => Promise<void>;
interface Shot { frame: string; dev: string; act?: Act; size?: [number, number]; q?: string; toasts?: boolean; motion?: 'reduce' }

const menuOf = (id: string): Act => async (p) => { await node(p, id).locator('button.more').click(); await expect(p.getByRole('menu').first()).toBeVisible(); };
const item = (name: string | RegExp): Act => async (p) => { await p.getByRole('menuitem', { name }).first().click(); };
const hover = (id: string): Act => async (p) => { await node(p, id).locator('button.hit').hover(); await p.waitForTimeout(300); };
const click = (id: string): Act => async (p) => { await node(p, id).locator('button.hit').click(); };
const key = (k: string): Act => async (p) => { await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await p.keyboard.press(k); };
const seq = (...a: Act[]): Act => async (p) => { for (const f of a) { await f(p); await p.waitForTimeout(250); } };
const subs = (lane: string): Act => async (p) => { await node(p, `lane:${lane}`).locator('button.tg.sb').click(); };
const accOpen: Act = async (p) => { await p.locator('button.accp.mini').click(); await expect(p.locator('.accp.open')).toBeVisible(); };
const accRow = (i: number) => (p: Page) => p.locator('.accp.open .hit[role=button]').nth(i);
const btn = (name: string | RegExp): Act => async (p) => { await p.getByRole('button', { name }).first().click(); };
/** I10 N1-g: the Xong shelf's merged rows shown (E4 drawn), the pointer parked off the nodes (no tooltip in the frame). */
const shelfTgl: Act = async (p) => { await node(p, 'done').locator('button.tgl').click(); };
const openDone: Act = seq(shelfTgl, async (p) => { await expect(node(p, 'done').locator('button.rw', { hasText: 'E4' })).toBeVisible(); await p.mouse.move(1430, 890); });
const doneList: Act = seq(shelfTgl, async (p) => { await node(p, 'done').locator('button.ft').click(); await expect(p.locator('#inspector .dlist')).toBeVisible(); });
const doneLane = (name: string): Act => seq(doneList, async (p) => { await p.locator('#inspector .drow', { hasText: name }).click(); await expect(p.locator('#inspector .dlane')).toBeVisible(); });
const ended = (n: number): Act => seq(key('h'), async (p) => { await p.getByRole('menu', { name: 'Lịch sử phiên' }).locator('button.srow', { hasText: `#${n}` }).click(); });
const openCard = (detail: Record<string, unknown>): Act => async (p) => { await p.evaluate((d: Record<string, unknown>) => window.dispatchEvent(new CustomEvent('ccs:open-card', { detail: d })), detail); };

const SHOTS: Shot[] = [
  { frame: 'N1-a', dev: 'DK5' },
  { frame: 'N1-b', dev: 'DK5', act: hover('lane:D2') },
  { frame: 'N1-c', dev: 'DK5' },
  { frame: 'N1-d', dev: 'DKF', size: [1440, 880] },
  { frame: 'N1-e', dev: 'F15' },
  { frame: 'N1-f', dev: 'DK5', act: seq(subs('D2'), subs('B2')) },
  { frame: 'N1-g', dev: 'DK5', act: openDone },
  { frame: 'N1-h', dev: 'DKF' },
  { frame: 'N1-i', dev: 'DK5', act: hover('orch:p1') },
  { frame: 'N1-j', dev: 'DK0' },
  { frame: 'N1-k', dev: 'DK5', act: async (p) => { await p.waitForTimeout(1100); await p.locator('#inbox .card', { hasText: 'giữ API cũ?' }).click(); await p.locator('#cardbox button.opt').first().click(); } },
  { frame: 'N2-a', dev: 'DK5', act: click('lane:D2') },
  { frame: 'N2-b', dev: 'DK5', act: async (p) => { await node(p, 'lane:D15').locator('button.nb').click(); } },
  { frame: 'N2-c', dev: 'DK5', act: menuOf('lane:D2') },
  { frame: 'N2-d', dev: 'DK5', act: seq(menuOf('lane:R5'), async (p) => { await p.getByRole('menuitem', { name: /Chuyển account/ }).hover(); }) },
  { frame: 'N2-e', dev: 'DK5', act: seq(menuOf('lane:D2'), item('Dừng…')) },
  { frame: 'N2-f', dev: 'DK5', act: menuOf('orch:p1') },
  { frame: 'N2-g', dev: 'DK5', act: seq(subs('D2'), async (p) => { await p.locator('.react-flow__node-subagent').first().locator('.sub').click({ button: 'right' }); }) },
  { frame: 'N2-h', dev: 'DK5', act: seq(subs('D2'), async (p) => { await p.locator('.react-flow__node-subagent').first().locator('button.hit').click(); }) },
  { frame: 'N2-i', dev: 'DK5', act: async (p) => { await node(p, 'lane:B2').locator('button.hit').focus(); await p.waitForTimeout(300); } },
  { frame: 'N2-j', dev: 'DK5', q: '&remote=1', act: menuOf('lane:D2') },
  { frame: 'N2-k', dev: 'DK5', act: seq(key('Meta+k'), async (p) => { await p.keyboard.type('d2'); }) },
  { frame: 'N2-l', dev: 'DK5', act: seq(subs('D2'), click('lane:D2')) },
  { frame: 'N3-a', dev: 'DK5', act: async (p) => { await p.locator('button.accp.mini').hover(); await p.waitForTimeout(300); } },
  { frame: 'N3-b', dev: 'DK5', act: seq(accOpen, hover('lane:D2')) },
  { frame: 'N3-c', dev: 'DK5', act: seq(accOpen, async (p) => { await accRow(0)(p).hover(); }) },
  { frame: 'N3-d', dev: 'DK30', act: seq(accOpen, async (p) => { await p.locator('.accp.open .gh.g-ready').click(); await p.locator('.accp.open input.afilter').fill('acc02'); }) },
  { frame: 'N3-e', dev: 'DK5', act: seq(accOpen, async (p) => { await p.locator('.accp.open button.amore').nth(1).click(); }) },
  { frame: 'N3-f', dev: 'F16', act: accOpen },
  { frame: 'N3-g', dev: 'DK5', act: accOpen },
  { frame: 'N3-h', dev: 'F1a' },
  { frame: 'N3-i', dev: 'DK5', act: accOpen },
  { frame: 'N3-j', dev: 'DK300', act: accOpen },
  { frame: 'N3-k', dev: 'DK5', act: accOpen, toasts: true },
  { frame: 'N3-l', dev: 'DK5', act: seq(accOpen, async (p) => { await accRow(1)(p).click(); }) },
  { frame: 'N3-m', dev: 'F1a' },
  { frame: 'N4-a', dev: 'F2' },
  { frame: 'N4-b', dev: 'DK0' },
  { frame: 'N4-c', dev: 'F13' },
  { frame: 'N4-d', dev: 'F10', act: async (p) => { await p.waitForTimeout(4500); } },
  { frame: 'N4-e', dev: 'DKF' },
  { frame: 'N4-f', dev: 'DK5L' },
  { frame: 'N4-g', dev: 'DK5', size: [1024, 640], act: accOpen },
  { frame: 'N4-h', dev: 'DK5', motion: 'reduce' },
  { frame: 'N4-i', dev: 'DK5', q: '&lang=en', act: accOpen },
  { frame: 'N4-j', dev: 'DK5', size: [1024, 640], act: click('lane:D2') },
  { frame: 'N4-k', dev: 'DK5', act: key('l') },
  { frame: 'N4-l', dev: 'F11' },
  // UX-N-b: the pan starts on the deck area (#map spans the window under the left column; x + 60 was a text drag in the column)
  { frame: 'N4-m', dev: 'DK5L', act: async (p) => { const b = (await p.locator('.dframe').boundingBox())!; await p.mouse.move(b.x + 60, b.y + b.height / 2); await p.mouse.down(); await p.mouse.move(b.x + 660, b.y + b.height / 2, { steps: 8 }); await p.mouse.up(); } }, // m-3 ~600 px: part of the tree stays on screen with the edge marker
  { frame: 'N5-a', dev: 'DKS', act: menuOf('orch:s3') },
  { frame: 'N5-b', dev: 'DKS', act: seq(menuOf('orch:s3'), item('Mở phiên song song…')) },
  { frame: 'N5-c', dev: 'DKS', act: click('orch:s4') },
  { frame: 'N5-d', dev: 'DKS', act: key('h') },
  { frame: 'N5-e', dev: 'DKS', act: ended(2) },
  { frame: 'N5-f', dev: 'DKS', act: seq(ended(2), btn('Chạy tiếp…')) },
  { frame: 'N5-g', dev: 'DKS', act: seq(ended(2), btn('Chạy tiếp…')) },
  { frame: 'N5-h', dev: 'DKS', act: seq(ended(2), btn('Chạy tiếp…'), async (p) => { await p.getByRole('dialog').locator('.btn.pri').click(); }) },
  { frame: 'N5-i', dev: 'DKS', act: ended(1) },
  { frame: 'N5-j', dev: 'DKS', act: seq(menuOf('lane:D2'), async (p) => { await p.getByRole('menuitem', { name: /Chuyển sang phiên/ }).hover(); }) },
  { frame: 'N5-k', dev: 'DKS', act: seq(menuOf('orch:s4'), item('Kết thúc phiên…')) },
  { frame: 'N5-l', dev: 'DKX', act: doneLane('M11') },
  { frame: 'N5-m', dev: 'DKX', act: doneLane('M2') },
  { frame: 'N5-n', dev: 'DKS', act: menuOf('orch:s4') },
  { frame: 'N5-o', dev: 'DKX', act: seq(doneLane('M11'), btn('Chạy tiếp lane…')) },
  { frame: 'N5-p', dev: 'DKS', toasts: true, act: seq(menuOf('lane:D2'), async (p) => { await p.getByRole('menuitem', { name: /Chuyển sang phiên/ }).hover(); }, item(/^#4/)) },
  { frame: 'N5-q', dev: 'DKX', act: menuOf('orch:s3') },
  { frame: 'N5-r', dev: 'DKX', act: seq(ended(1), btn('Phiên mới từ 50 dòng cuối')) },
  { frame: 'N6-a', dev: 'DKX' },
  { frame: 'N6-b', dev: 'DKX', act: menuOf('orch:s4') },
  { frame: 'N6-c', dev: 'DKX', act: seq(menuOf('orch:s3'), item('Thu gọn các cây khác')) },
  { frame: 'N6-d', dev: 'DKX', act: seq(menuOf('orch:s3'), item('Thu gọn các cây khác'), key('Meta+k'), async (p) => { await p.keyboard.type('h'); }) },
  { frame: 'N6-e', dev: 'DKX', act: doneList },
  { frame: 'N6-f', dev: 'DKX', act: doneLane('M11') },
  { frame: 'N6-g', dev: 'DKX', act: seq(doneLane('M11'), btn(/Nhờ Điều phối #\d merge…/)) },
  { frame: 'N6-i', dev: 'DKX', act: openCard({ cardId: null, projectId: 'p1', lane: 'D15' }) },
  { frame: 'N6-j', dev: 'DKX', act: seq(menuOf('orch:s3'), item('Thu gọn các cây khác'), async (p) => { await p.waitForTimeout(1100); await p.locator('#inbox .card').first().click(); await p.locator('#cardbox button.opt').first().click(); }) },
  { frame: 'N6-k', dev: 'DKX', act: seq(doneList, btn(/^Chưa merge/)) },
  { frame: 'N6-l', dev: 'DKX', act: openCard({ cardId: null, projectId: 'p1', lane: 'M11' }) },
  // 30 / 300 accounts (§6 Account), English (§6A)
  { frame: 'acc30', dev: 'DK30', act: accOpen },
  { frame: 'acc300', dev: 'DK300', act: accOpen },
  ...(['N1-a', 'N2-a', 'N5-a', 'N6-a'] as const).map(f => ({ frame: `${f}-en`, dev: f === 'N5-a' ? 'DKS' : f === 'N6-a' ? 'DKX' : 'DK5', q: '&lang=en',
    ...(f === 'N2-a' ? { act: click('lane:D2') } : f === 'N5-a' ? { act: menuOf('orch:s3') } : {}) })),
];

for (const s of SHOTS) {
  test(`§11 ${s.frame} (${s.dev}${s.q ?? ''})`, async ({ page }) => {
    const [w, h] = s.size ?? [1440, 900];
    await page.setViewportSize({ width: w, height: h });
    if (s.motion) await page.emulateMedia({ reducedMotion: s.motion });
    const ready = /^F(1a|2)$/.test(s.dev) ? 'body' : s.dev === 'F13' ? 'body' : '.react-flow__node';
    await openDeck(page, `${dev.url(s.dev)}${s.q ?? ''}`, ready);
    if (!s.toasts) await hideDevToasts(page);
    await s.act?.(page);
    await page.waitForTimeout(400);
    mkdirSync(DIR, { recursive: true });
    await page.screenshot({ path: join(DIR, `v21-${s.frame}.png`) });
  });
}
