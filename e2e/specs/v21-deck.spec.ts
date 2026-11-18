// v2.1 §6 deck e2e (replaces the v1.1 deck-actions / deck-overlap / deck-budget specs): the React Flow deck on dev frames
// (web/dev/scenarios.ts, mock engine) — obstacles after "vừa màn hình", the account panel, hover both ways, Tab / 1–9 / F / A,
// UX-I4 at 1024×640, the remote channel menus, the Esc ladder, the §4.12 click budgets; "Để yên" on a real engine.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { ServerMsg, Snapshot } from '../../shared/protocol.ts';
import { deckTab, expect, ORCH, recordBudget, S, settle, test, useEngine } from '../fixtures.ts';
import { blur, crumb, measureDeck, menuLabels, openDeck, useDev, viewport } from '../deck.ts';

const dev = useDev();
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const laneName = (page: Page) => page.locator('#inspector.k-lane .lhead h2');
/** Esc closes the submenu first, then the menu (§4.11 ladder); waits out the 140 ms close so no Esc reaches the next rung. */
const closeMenus = async (page: Page) => {
  for (let i = 0; i < 3 && await page.locator('.amenu').count(); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  await expect(page.locator('.amenu')).toHaveCount(0);
};
const SIZES = [[1280, 800], [1024, 640]] as const;
/** DK5 lanes in tree order (one root, §4.1 creation order); E4 is in the "Xong" group. */
const DK5_KEYS = ['S7', 'X9', 'B2', 'C1', 'D2', 'D15', 'R5', 'K3', 'I2'];

test.describe('dev frames', () => {
  for (const f of ['DK5', 'DK30', 'DK300', 'DK5L', 'DKN', 'DKS', 'DK0', 'DKF']) for (const [w, h] of SIZES) {
    test(`§6 vật cản ${f} × ${w}×${h}: after "vừa màn hình" 0 node under the top bar / left column / header / account card / zoom / minimap / edge markers, 0 node over node`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await openDeck(page, dev.url(f));
      await blur(page);
      await page.keyboard.press('f');
      await page.waitForTimeout(500);
      const m = await measureDeck(page);
      expect(m.shown).toBeGreaterThan(0);
      // a graph that fits (no minimap, §4.9) has every node on screen; one that does not fit at the zoom floor is cut by the
      // window edges, where its edge markers sit — there only the nodes wholly on screen are checked
      if (!(await page.locator('.dmini').count())) expect(m.shown).toBe(m.nodes);
      expect(m.bad).toEqual([]);
    });
  }

  test('§4.7 account panel: collapsed on open, click → 400 px (380 px under 1280, v2.7.1 §4.3), Esc → collapsed (1280 and 1024)', async ({ page }) => {
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await openDeck(page, dev.url('DK5'));
      await expect(page.locator('.accp.mini')).toBeVisible();
      await expect(page.locator('.accp.open')).toHaveCount(0);
      await page.locator('.accp.mini').click();
      await expect(page.locator('.accp.open')).toBeVisible();
      expect(Math.round((await page.locator('.accp.open').boundingBox())!.width)).toBe(w >= 1280 ? 400 : 380);
      const head = (await page.locator('.dhead').boundingBox())!, acc = (await page.locator('.accp.open').boundingBox())!;
      expect(acc.y).toBe(head.y + head.height); // v2.4 §6.7 D53 the open panel starts right under the head bar (--h-head)
      await page.keyboard.press('Escape');
      await expect(page.locator('.accp.open')).toHaveCount(0);
      await expect(page.locator('.accp.mini')).toBeVisible();
    }
  });

  test('hf1117-p2 a `lane` event keeps every wire and travelling dot mounted (perf audit C2: dots snapped back)', async ({ page }) => {
    // the page ↔ mock socket goes through the test so it can push `lane` events the mock never sends on its own
    let push: (m: ServerMsg) => void = () => {};
    let snap: Snapshot | null = null;
    await page.routeWebSocket(/\/ws\?/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => { const msg = JSON.parse(String(m)) as ServerMsg; if (msg.type === 'snapshot') snap = msg.snapshot; ws.send(m); });
      push = (m) => ws.send(JSON.stringify(m));
    });
    await openDeck(page, dev.url('DK5'));
    const mark = () => page.evaluate(() => {
      const w = window as unknown as { __hfEdges: Element[]; __hfDots: Element[] };
      w.__hfEdges = [...document.querySelectorAll('.react-flow__edge')];
      w.__hfDots = [...document.querySelectorAll('.pk')];
      return { edges: w.__hfEdges.length, dots: w.__hfDots.length };
    });
    const gone = () => page.evaluate(() => {
      const w = window as unknown as { __hfEdges: Element[]; __hfDots: Element[] };
      return { edges: w.__hfEdges.filter(e => !e.isConnected).length, dots: w.__hfDots.filter(e => !e.isConnected).length };
    });
    const n = await mark();
    expect(n.edges).toBeGreaterThan(5);
    expect(n.dots).toBeGreaterThan(0);
    // what process.ts:128 sends per assistant line: same state, new cost / context / updatedAt — every lane node's data changes
    for (const l of snap!.lanes) push({ type: 'event', event: { type: 'lane', lane: { ...l, costUsd: l.costUsd + 0.01, contextPct: ((l.contextPct ?? 0) + 1) % 100, updatedAt: Date.now() } } });
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(await gone()).toEqual({ edges: 0, dots: 0 });
  });

  test('§4.7 hover both ways: node D2 → its account row lit; account row → its lanes lit, the others dim', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    await blur(page);
    await page.keyboard.press('a');
    const acc = 'acc003@x-dev.test'; // D2's account in the DK5 scene
    await expect(node(page, 'lane:D2')).toContainText('acc003@');
    await node(page, 'lane:D2').hover();
    await expect(page.locator('.accp.open .acrow.alit')).toHaveCount(1);
    await expect(page.locator('.accp.open .acrow.alit')).toHaveAttribute('data-email', acc);
    await page.locator(`.accp.open .acrow[data-email="${acc}"]`).hover();
    // v2.8 §4.3 the lanes of the hovered account stay as they are (no glow), every other lane dims
    const lit = await page.locator('.react-flow__node-lane:not(.acc-dim)').evaluateAll(es => es.map(e => (e as HTMLElement).dataset.id).sort());
    const mine = await page.locator('.react-flow__node-lane').filter({ hasText: 'acc003@' }).evaluateAll(es => es.map(e => (e as HTMLElement).dataset.id).sort());
    expect(lit).toEqual(mine);
    expect(lit).toContain('lane:D2');
    expect(await page.locator('.react-flow__node-lane.acc-dim').count()).toBeGreaterThan(0);
  });

  test('v2.8 §7.1 / §4.3 React Flow takes the computed theme at once; the shared trunk stays grey, only the leg is coloured', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    const rf = page.locator('.deck .react-flow');
    await expect(rf).toHaveClass(/\bdark\b/);
    const strokes = () => page.locator('.react-flow__edge').filter({ has: page.locator('path.wire.hot') }).first()
      .evaluate(e => [...e.querySelectorAll('path.wire')].map(p => getComputedStyle(p).stroke));
    const [trunk, leg] = await strokes();
    expect(trunk).not.toBe(leg);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await expect(rf).toHaveClass(/\blight\b/);
    expect(await strokes()).toEqual(['rgb(107, 122, 143)', 'rgb(7, 99, 143)']);
    expect(await page.locator('.wire-glow').first().evaluate(e => getComputedStyle(e).display)).toBe('none');
  });

  test('§4.11 Tab reaches every node; Enter on a focused node = click', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    const want = await page.locator('.react-flow__node:has(.hit)').evaluateAll(es => es.map(e => (e as HTMLElement).dataset.id!));
    expect(want.length).toBeGreaterThan(12);
    await blur(page);
    const seen = new Set<string>();
    for (let i = 0; i < 160 && want.some(x => !seen.has(x)); i++) {
      await page.keyboard.press('Tab');
      seen.add(await page.evaluate(() => (document.activeElement?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id ?? ''));
    }
    expect(want.filter(x => !seen.has(x))).toEqual([]);
  });

  test('§4.11 Enter on a focused node = click (v1.1)', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    await node(page, 'lane:D15').locator('.hit').focus();
    await page.keyboard.press('Enter');
    await expect(laneName(page)).toHaveText('D15');
  });

  test('§4.11 keys 1–9 = visible lanes in tree order (the "Xong" group skipped), same order as the ⌘K hints', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    const ys = await page.locator('.react-flow__node-lane').evaluateAll(es => es.map(e => [(e as HTMLElement).dataset.id!.slice(5), e.getBoundingClientRect().y] as const));
    expect(ys.sort((a, b) => a[1] - b[1]).map(x => x[0])).toEqual(DK5_KEYS);
    for (const [i, name] of DK5_KEYS.entries()) {
      await blur(page);
      await page.keyboard.press(String(i + 1));
      await expect(laneName(page)).toHaveText(name);
    }
    await page.keyboard.press('Meta+k');
    const pal = page.getByRole('dialog', { name: 'Bảng lệnh' });
    for (const [i, name] of DK5_KEYS.entries()) await expect(pal.locator('button', { has: page.locator('kbd', { hasText: new RegExp(`^${i + 1}$`) }) }).first()).toContainText(`${name} ·`);
  });

  test('§4.11 F fits after a zoom; F / A are dead while typing (v1 M8)', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    const fitted = await viewport(page);
    await page.locator('.dzoom button').first().click(); // +
    await page.waitForTimeout(400); // the 200 ms zoom transition ends
    expect(await viewport(page)).not.toBe(fitted);
    await blur(page);
    await page.keyboard.press('f');
    await expect.poll(() => viewport(page)).toBe(fitted);
    await page.locator('.dzoom button').first().click();
    await page.waitForTimeout(400);
    const zoomed = await viewport(page);
    const input = page.getByLabel('Ô lệnh');
    await input.click();
    await page.keyboard.type('fa');
    await expect(input).toHaveValue('fa');
    await page.waitForTimeout(500);
    expect(await viewport(page)).toBe(zoomed);
    await expect(page.locator('.accp.open')).toHaveCount(0);
    await input.fill('');
    await blur(page);
    await page.keyboard.press('a');
    await expect(page.locator('.accp.open')).toBeVisible();
  });

  test('UX-I4 1024×640: node text ≥ 10 px on screen, lane / root hit areas ≥ 24 px (10 and 24 lanes)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    for (const f of ['DK5', 'DK30L']) {
      await openDeck(page, dev.url(f));
      const m = await page.evaluate(() => {
        const t = getComputedStyle(document.querySelector('.react-flow__viewport')!).transform;
        const zoom = t === 'none' ? 1 : new DOMMatrix(t).a;
        const px = [...document.querySelectorAll('.react-flow__node *')].filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim()))
          .filter(e => (e as HTMLElement).offsetParent).map(e => parseFloat(getComputedStyle(e).fontSize) * zoom);
        const hits = [...document.querySelectorAll('.react-flow__node-lane .hit, .react-flow__node-orchestrator .hit')].map(e => e.getBoundingClientRect().height);
        return { zoom, minPx: Math.min(...px), minHit: Math.min(...hits) };
      });
      expect(m.minPx, `${f} zoom ${m.zoom}`).toBeGreaterThanOrEqual(10);
      expect(m.minHit, f).toBeGreaterThanOrEqual(24);
    }
  });

  test('§4.11 Kênh: remote channel — no "⋯" item outside REMOTE_ALLOWED on any node / account row; the Mac shows them', async ({ page }) => {
    // the Mac-only commands' items (actions.ts actCmd ∉ REMOTE_ALLOWED): VS Code / Terminal, restart, sessions open / new /
    // rename / end, stop_all, lane_continue, lane_reassign, account login / logout / delete / config_update
    const MAC_ONLY = /^(Mở VS Code|Mở Terminal|Khởi động lại|Mở phiên song song|Phiên mới|Đổi tên|Kết thúc phiên|Dừng an toàn|Chạy tiếp lane|Chuyển sang phiên|Đăng nhập lại|Đăng xuất|Xoá account|Không giao lane mới|Giao lane mới lại|Sửa ngưỡng)/;
    const collect = async (q: string) => {
      await openDeck(page, dev.url('DKS', q));
      const out: string[] = [];
      for (const id of ['orch:s3', 'lane:D2', 'lane:R5', 'sub:D2:d2a']) {
        // a sub node has no "⋯" button: right-click opens its menu (§4.11)
        if (id.startsWith('sub:')) await node(page, id).locator('.hit').click({ button: 'right' });
        else await node(page, id).locator('button.more').click();
        out.push(...await menuLabels(page));
        await closeMenus(page);
      }
      await blur(page);
      await page.keyboard.press('a');
      await page.locator('.accp.open .acrow').first().locator('.amore').click();
      out.push(...await menuLabels(page));
      await closeMenus(page);
      return out;
    };
    const mac = await collect('');
    expect(mac.filter(l => MAC_ONLY.test(l)).length).toBeGreaterThan(5);
    const remote = await collect('remote=1');
    expect(remote.length).toBeGreaterThan(5);
    expect(remote.filter(l => MAC_ONLY.test(l))).toEqual([]);
  });

  test('§4.11 Esc ladder: menu → account panel → Đang xem up one level (sub → lane → Điều phối)', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    await node(page, 'sub:D2:d2a').locator('.hit').click();
    await expect.poll(() => crumb(page)).toMatch(/D2 › tests$/);
    await blur(page);
    await page.keyboard.press('a');
    // v2.8 D98 a press outside closes the panel, so the menu is a panel row's "⋯" (a press inside)
    const r = page.locator('.accp.open .acrow').first();
    await r.hover();
    await r.locator('.amore').click();
    await expect(page.locator('.amenu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.amenu')).toHaveCount(0);
    await expect(page.locator('.accp.open')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.accp.open')).toHaveCount(0);
    await expect.poll(() => crumb(page)).toMatch(/D2 › tests$/);
    await page.keyboard.press('Escape');
    await expect(laneName(page)).toHaveText('D2');
    await page.keyboard.press('Escape');
    await expect(page.locator('#inspector.k-orch')).toBeVisible();
    // a dialog sits above everything: ⌘K then Esc closes the palette, the selection stays
    await page.keyboard.press('2');
    await page.keyboard.press('Meta+k');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Bảng lệnh' })).toHaveCount(0);
    await expect(laneName(page)).toHaveText('X9');
  });

  test('§4.12 click budgets: nhắn lane 1 · chạy lại lane hỏng 2 · dừng an toàn 3 · dừng ngay 4', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    let n = 0;
    await node(page, 'lane:D2').locator('.hit').click(); n++;
    await expect(page.locator('#inspector button.target')).toContainText('D2');
    await expect(page.getByLabel('Ô lệnh')).toBeEditable();
    recordBudget('§4.12 nhắn lane (bấm node rồi gõ)', n, 1);
    expect(n).toBeLessThanOrEqual(1);
    await settle(page); // the select re-laid the graph out: §4.12 move guard (1 s)

    n = 0;
    await node(page, 'lane:R5').locator('button.more').click(); n++;
    await page.getByRole('menuitem', { name: /^Chạy lại/ }).click(); n++;
    await expect(node(page, 'lane:R5').locator('.nd')).toHaveClass(/st-running/);
    recordBudget('§4.12 chạy lại lane hỏng (⋯ → Chạy lại)', n, 2);
    expect(n).toBeLessThanOrEqual(2);

    for (const [lane, label, target, st] of [['B2', 'Dừng an toàn', 3, /st-draining/], ['I2', 'Dừng ngay', 4, /st-stopped/]] as const) {
      await settle(page);
      n = 0;
      await node(page, `lane:${lane}`).locator('button.more').click(); n++;
      await page.getByRole('menuitem', { name: /^Dừng…/ }).click(); n++;
      const dlg = page.getByRole('dialog', { name: 'Dừng lane' });
      await dlg.locator('button.choice', { hasText: label }).click(); n++;
      if (target === 4) { // §4.12 T10 Dừng ngay = choose, then confirm (N2-e)
        await expect(dlg).toBeVisible();
        await expect(node(page, `lane:${lane}`).locator('.nd')).not.toHaveClass(st);
        await dlg.locator('.mf').getByRole('button', { name: label }).click(); n++;
      }
      await expect(node(page, `lane:${lane}`).locator('.nd')).toHaveClass(st);
      recordBudget(`§4.12 ${label.toLowerCase()} (⋯ → Dừng… → ${label}${target === 4 ? ' → xác nhận' : ''})`, n, target);
      expect(n).toBeLessThanOrEqual(target);
    }
  });

  test('§4.12 T10 composer "/stop I2" opens the same stop dialog: subtitle, Dừng ngay = choose then confirm (budget 4)', async ({ page }) => {
    await openDeck(page, dev.url('DK5'));
    let n = 0;
    await page.getByLabel('Ô lệnh').fill('/stop I2');
    await page.getByLabel('Ô lệnh').press('Enter'); n++;
    const dlg = page.getByRole('dialog', { name: 'Dừng lane' });
    await expect(dlg.locator('h2')).toContainText('I2');
    await expect(dlg.locator('p')).not.toBeEmpty(); // N2-e subtitle "task · n subagent"
    await dlg.locator('button.choice', { hasText: 'Dừng ngay' }).click(); n++;
    await expect(dlg).toBeVisible();
    await expect(node(page, 'lane:I2').locator('.nd')).not.toHaveClass(/st-stopped/);
    await dlg.locator('.mf').getByRole('button', { name: 'Dừng ngay' }).click(); n++;
    await expect(node(page, 'lane:I2').locator('.nd')).toHaveClass(/st-stopped/);
    recordBudget('§4.12 dừng ngay từ ô lệnh (/stop → Enter → Dừng ngay → xác nhận)', n, 4);
    expect(n).toBeLessThanOrEqual(4);
  });

  // §6 "Bảng kế thừa": one walk over the §4.13 rows (each step names its row). Rows a dedicated test already measures are
  // pointed to by name: F26 / U6 + v1.1 §4.5 edge markers ("vật cản"), F14 / U7 drawer + F5 toast + v1.1 §4.4 tips
  // (v21-leftcol), F10 / U11 / U12 / v1.1 §6 ("Để yên"), §7.2 N2 ("Kênh"), §8.5 keys ("keys 1–9", "Esc ladder"), UX-I4.
  test('§4.13 Bảng kế thừa: every v1 / v1.1 / v2 deck feature still reachable in v2.1', async ({ page }) => {
    test.setTimeout(180_000);
    const step = test.step;
    const menuOf = async (id: string) => { await settle(page); await node(page, id).locator('button.more').click(); const l = await menuLabels(page); await closeMenus(page); return l; };
    await openDeck(page, dev.url('DK5'));
    await step('v1 T1 / v1.1 T1 / v2 T1: glance with 0 clicks — nodes, Chờ PO count, header stats, collapsed account card', async () => {
      expect(await page.locator('.react-flow__node-lane').count()).toBe(9);
      await expect(page.locator('#inbox')).toContainText('Chờ PO');
      await expect(page.locator('.dhead')).toBeVisible();
      await expect(page.locator('.accp.mini .n')).toHaveText('5');
    });
    await step('v1 T2 / F4 / U1 / M6 / v2.4 §6.7: from the node "Trả lời" the row is selected and its box opens with ⌥1–⌥4 (2 clicks)', async () => {
      await expect(page.locator('#inbox .card', { hasText: 'giữ API cũ?' }).getByRole('button', { name: 'Xem chi tiết' })).toBeVisible();
      await node(page, 'lane:D15').getByRole('button', { name: 'Trả lời' }).click();
      await expect(page.locator('#inbox .card.focus')).toContainText('giữ API cũ?');
      await expect(page.locator('#cardbox')).toContainText('⌥1');
      await expect(page.locator('#inspector .lhead h2')).toHaveText('D15');
      await page.keyboard.press('Escape'); // the box closes first (Esc order: accDlg → box → as before)
      await expect(page.locator('#cardbox')).toHaveCount(0);
      await expect(page.locator('#inspector .lhead h2')).toHaveText('D15');
    });
    await step('v1.1 §4.2: every lane state has its own object', async () => {
      const st = await page.locator('.react-flow__node-lane .nd').evaluateAll(es => [...new Set(es.flatMap(e => [...e.classList].filter(c => c.startsWith('st-'))))].sort());
      expect(st).toEqual(['st-broken', 'st-draining', 'st-idle', 'st-running', 'st-starting', 'st-stopped', 'st-waiting_po', 'st-waiting_quota']);
    });
    await step('v1 U10: money always "≈"', async () => {
      await expect(node(page, 'lane:D2')).toContainText('≈ $');
    });
    await step('v1 T3 / U3: Đang xem defaults to Điều phối, the composer at its bottom with the target chip ▾', async () => {
      await blur(page);
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
      await expect(page.locator('#inspector')).toHaveClass(/k-orch/);
      // v2.4 §6.2 D51: the composer is one frame (text over the fixed 28 px recipient · send row) — the frame sits at the bottom
      const [ins, fr] = [(await page.locator('#inspector').boundingBox())!, (await page.locator('#inspector .inrow').boundingBox())!];
      expect(ins.y + ins.height - (fr.y + fr.height)).toBeLessThan(40);
      expect(await page.getByLabel('Ô lệnh').evaluate(e => e.closest('.inrow') !== null)).toBe(true);
      await expect(page.locator('#inspector button.target')).toBeVisible();
    });
    await step('v1 T4 / F8: a node click → Đang xem of the lane with Worktree, failures n / 3, account, Subagent section', async () => {
      await settle(page);
      await node(page, 'lane:D2').locator('.hit').click();
      const ins = page.locator('#inspector.k-lane');
      for (const t of ['Worktree', '/ 3', 'acc003@', 'tests']) await expect(ins).toContainText(t);
    });
    await step('v1 T5: message one lane = click + type; ⌘. interrupts the target', async () => {
      await expect(page.locator('#inspector button.target')).toHaveText('D2'); // v2.4 §6.2 D51: "↳" is CSS ::before
      await page.getByLabel('Ô lệnh').fill('chạy lại lot-2');
      await page.getByLabel('Ô lệnh').press('Enter');
      await page.keyboard.press('Meta+.');
      await expect(page.locator('#toasts')).toContainText('interrupt');
    });
    await step('v1 T8 / F8: Dừng / Chuyển account / VS Code in the lane "⋯" and in Đang xem', async () => {
      const l = await menuOf('lane:D2');
      for (const t of ['Nhắn', 'Ngắt lượt', 'Dừng…', 'Chuyển account', 'Mở VS Code']) expect(l).toContain(t);
      await expect(page.locator('#inspector'), await page.locator('#inspector').getAttribute('class') ?? '').toHaveClass(/k-lane/);
      await expect(page.locator('#inspector .lhead button.more')).toBeVisible();
    });
    await step('v1 F7: broken lane → "Chạy lại" in "⋯"', async () => {
      expect(await menuOf('lane:R5')).toContain('Chạy lại');
    });
    await step('v1 G1 / F21 / F11: Điều phối "⋯" has parallel session, history, new session (replacing #n), stop all', async () => {
      const l = await menuOf('orch:p1');
      for (const re of [/^Mở phiên song song/, /^Lịch sử phiên/, /^Phiên mới/, /^Dừng an toàn tất cả lane/]) expect(l.some(x => re.test(x)), String(re)).toBe(true);
    });
    await step('v1 F25: a sub node → Đang xem "… › sub", read-only note; the composer goes to the parent', async () => {
      await settle(page);
      await node(page, 'sub:D2:d2b').locator('.hit').click();
      await expect(page.locator('#inspector.k-sub')).toContainText('Chỉ xem');
      await expect(page.locator('#inspector button.target')).toHaveText('D2'); // v2.4 §6.2 D51: "↳" is CSS ::before
    });
    await step('v1 F24 / v2 T3 / A2 / U4 / v1 §6 roles: account panel rows ("còn N %", role tags), "+", row "⋯", row → Account', async () => {
      await blur(page);
      await page.keyboard.press('a');
      const pnl = page.locator('.accp.open');
      await expect(pnl).toContainText(/còn \d+ %/);
      await expect(pnl).toContainText('ĐIỀU PHỐI');
      await expect(pnl).toContainText('DỰ PHÒNG');
      await expect(pnl.getByRole('button', { name: 'Thêm account' })).toBeVisible();
      await pnl.locator('.acrow[data-email="acc003@x-dev.test"] .amore').click();
      const l = await menuLabels(page);
      await closeMenus(page);
      for (const t of ['Xem account', 'Không giao lane mới', 'Chuyển hết lane đi…', 'Sửa ngưỡng', 'Đăng xuất…', 'Xoá account…']) expect(l).toContain(t);
      await pnl.locator('.acrow[data-email="acc003@x-dev.test"] .hit').click();
      const ins = page.locator('#inspector.k-account');
      for (const t of ['Không giao lane mới', 'Chuyển hết lane đi', 'Sửa ngưỡng']) await expect(ins.getByRole('button', { name: new RegExp(t) })).toBeVisible();
      await page.keyboard.press('Escape');
    });
    await step('v1 F17 / F22 (N2-k): ⌘K lists the same lane actions as "⋯"', async () => {
      await page.keyboard.press('Meta+k');
      const pal = page.getByRole('dialog', { name: 'Bảng lệnh' });
      await pal.getByLabel('Tìm hành động, lane, project').fill('D2');
      await expect(pal).toContainText('Dừng…');
      await page.keyboard.press('Escape');
    });
    await step('v1 F9 / X14: L = list mode in the deck area, the left column stays, rows have "⋯"', async () => {
      await blur(page);
      await page.keyboard.press('l');
      await expect(page.locator('#listview')).toBeVisible();
      await expect(page.locator('#left')).toBeVisible();
      expect(await page.locator('#listview button.more, #listview [aria-haspopup=menu]').count()).toBeGreaterThan(0);
      await page.keyboard.press('l');
      await expect(page.locator('#listview')).toHaveCount(0);
    });
    await step('v1 F15 / U2: a permission ask reads "Xin chạy:" on its node', async () => {
      await openDeck(page, dev.url('F15'));
      await expect(node(page, 'lane:D2')).toContainText('Xin chạy:');
    });
    await step('v1 F7: the broken card keeps Xem log / Chạy lại / Giao điều phối (node → card: the T2 step)', async () => {
      await openDeck(page, dev.url('F7'));
      const card = page.locator('#inbox .card', { hasText: 'D2' }).first();
      for (const b of ['Xem log', 'Chạy lại']) await expect(card.getByRole('button', { name: b })).toBeVisible(); // v2.4 §6.7 the row
      await settle(page);
      await card.click();
      for (const b of ['Chạy lại', 'Xem log', 'Giao điều phối xử lý']) await expect(page.locator('#cardbox').getByRole('button', { name: b })).toBeVisible();
      await page.keyboard.press('Escape');
    });
    await step('v1 F11: Điều phối stopped → node "Khởi động lại" + the card; the composer still takes a message (outbox)', async () => {
      await openDeck(page, dev.url('F11'));
      await expect(node(page, 'orch:hagenta').getByRole('button', { name: 'Khởi động lại' })).toBeVisible();
      await expect(page.locator('#inbox .card').getByRole('button', { name: 'Khởi động lại' })).toBeVisible(); // v2.4 §6.7 ↻ on the row
      await expect(page.getByLabel('Ô lệnh')).toBeEditable();
    });
    await step('v1 F6: every account full → lanes and Điều phối wait for quota', async () => {
      await openDeck(page, dev.url('DKF'));
      await expect(page.locator('.react-flow__node-orchestrator')).toContainText('Chờ quota');
    });
    await step('v1 F13: starting → the deck with Điều phối "Đang khởi động…"', async () => {
      await openDeck(page, dev.url('F13'));
      await expect(page.locator('.react-flow__node-orchestrator').first()).toContainText('Đang khởi động');
    });
    await step('v1 F16 → v2 A6 / T2: logged-out card + red row; the row opens Đăng nhập lại', async () => {
      await openDeck(page, dev.url('F16'));
      await expect(page.locator('#inbox')).toContainText('đã đăng xuất');
      await blur(page);
      await page.keyboard.press('a');
      await page.locator('.accp.open .acrow[data-email="dev2609@example.com"] .hit').click();
      await expect(page.getByRole('dialog')).toContainText(/Đăng nhập lại|dev2609/);
      await page.keyboard.press('Escape');
    });
    await step('v1 F14 < 1280 px: one drawer, "Chờ PO n" button on the header bar', async () => {
      await page.setViewportSize({ width: 1024, height: 640 });
      await openDeck(page, dev.url('DK5'));
      await expect(page.locator('#inboxBtn')).toContainText('Chờ PO');
      await page.setViewportSize({ width: 1280, height: 800 });
    });
    await step('v2 §6A: both languages (the deck in English)', async () => {
      await openDeck(page, dev.url('DK5', 'lang=en'));
      await expect(page.locator('#inspector .crumb')).toHaveText('Orchestrator');
      await expect(page.locator('#inbox')).toContainText('PO inbox');
    });
  });

  test('§6 Để yên: offline → 0 animations (F10: the mock drops the socket)', async ({ page }) => {
    await openDeck(page, dev.url('F10'));
    await expect.poll(() => page.evaluate(() => window.__ccDeck?.running() ?? -1), { timeout: 5_000 }).toBeGreaterThan(0);
    await expect(page.locator('.deck .cband')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => window.__ccDeck?.running() ?? -1), { timeout: 3_000 }).toBe(0);
    expect(await page.evaluate(() => window.__ccDeck?.why)).toContain('offline');
    // §6 v1.1 "dải mất kết nối không đè": the strip covers no node and no part of the left column
    const m = await measureDeck(page);
    expect(m.bad.filter(b => b.includes('.cband'))).toEqual([]);
    const [band, left] = [await page.locator('.deck .cband').boundingBox(), await page.locator('#left').boundingBox()];
    expect(band!.x).toBeGreaterThanOrEqual(left!.x + left!.width);
  });
});

test('§5.6 / v1.1 §5.1 web/dist has no three.js and the page no <canvas> deck', () => {
  const dist = resolve(import.meta.dirname, '../../web/dist');
  const files = readdirSync(dist, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(js|css|html)$/.test(f));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    expect(f).not.toMatch(/three/i);
    expect(readFileSync(join(dist, f), 'utf8')).not.toMatch(/WebGLRenderer|from\s*["']three["']|THREE\.REVISION|three\.module/);
  }
  const pkg = JSON.parse(readFileSync(resolve(dist, '../package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  expect(Object.keys(pkg.dependencies ?? {})).not.toContain('three');
});

// v1.1 §6 "Để yên" (kept): `window.__ccDeck.running()` = document.getAnimations() running. Real engine + fake-claude.
test.describe('Để yên (engine)', () => {
  test.describe.configure({ mode: 'serial' });
  const long = { steps: [S.wait, S.assistant('Đang chạy test'), S.sleep(300_000), S.result()] };
  const eng = useEngine({
    scenarios: (e) => ({ [ORCH]: { steps: [...S.turn('Sẵn sàng'), ...S.startLane(e, 'D2'), ...S.startLane(e, 'D3'), ...S.idle()] }, 'lane-D2': long, 'lane-D3': long }),
  });
  const running = (page: Page) => page.evaluate(() => window.__ccDeck?.running() ?? -1);
  /** v2.7 §4.1 D91 the app opens in Tasks (deck paused); these cases only `evaluate`, so the Deck tab is clicked here. */
  const openDeckMode = async (page: Page) => { await page.goto(eng.url()); await deckTab(page).click(); };
  let pid = '';

  test('§6 no lane running → 0 animations after 1 s; no <canvas>', async ({ page }) => {
    pid = await eng.addProject('shop');
    await openDeckMode(page);
    await page.locator('.react-flow__node').first().waitFor();
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.__ccDeck?.why)).toContain('nothing');
    expect(await running(page)).toBe(0);
    expect(await page.locator('canvas').count()).toBe(0);
  });

  test('§6 2 running lanes, window blurred 10 s → 0 animations', async ({ page }) => {
    test.setTimeout(90_000);
    await eng.openLane(pid, 'D2', 'running');
    await eng.openLane(pid, 'D3', 'running');
    await openDeckMode(page);
    await expect.poll(() => running(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(10_000);
    expect((await eng.health()).lanes.filter((l) => l.state === 'running').length).toBe(2);
    expect(await page.evaluate(() => window.__ccDeck?.why)).toContain('blur');
    expect(await running(page)).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => running(page)).toBeGreaterThan(0);
  });

  test('§6 60 s without input → 0 animations (page.clock)', async ({ page }) => {
    await page.clock.install();
    await openDeckMode(page);
    await expect.poll(() => running(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.clock.fastForward(59_000);
    expect(await running(page)).toBeGreaterThan(0);
    await page.clock.fastForward(2_000);
    await expect.poll(() => running(page), { timeout: 3_000 }).toBe(0);
    expect(await page.evaluate(() => window.__ccDeck?.why)).toContain('idle');
    await page.mouse.move(200, 200);
    await expect.poll(() => running(page)).toBeGreaterThan(0);
  });

  test('§6 reduced motion → 0 animations after 1 s', async ({ page }) => {
    await openDeckMode(page);
    await expect.poll(() => running(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(1000);
    expect(await running(page)).toBe(0);
  });

  test('§6 engine killed → offline strip, 0 animations', async ({ page }) => {
    await openDeckMode(page);
    await expect.poll(() => running(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await settle(page);
    await eng.kill();
    await expect(page.locator('.deck .cband')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => running(page), { timeout: 3_000 }).toBe(0);
  });
});

// v2.4 §6.7 CP6: on the remote channel a Mac-only row button keeps its place as a disabled 🔒; the box hides it
test.describe('§6.7 CP6 Chờ PO on the remote channel (dev mock)', () => {
  test('§6.7 CP6 rows: 🔒 for restart / login / relogin / merge, answers and Chạy lại stay; the MCP box has no Mac-only button', async ({ page }) => {
    await openDeck(page, dev.url('DKC', 'remote=1'));
    const row = (t: string) => page.locator('#inbox .card', { hasText: t });
    for (const t of ['Ngừng ·', 'github', 'acc07@ đã đăng xuất', 'chưa nối']) await expect(row(t).locator('button.ia.lock')).toBeDisabled();
    await expect(row('rm -rf build/').getByRole('button', { name: 'Cho phép', exact: true })).toBeEnabled();
    await expect(row('Hỏng:').getByRole('button', { name: 'Chạy lại' })).toBeEnabled();
    await settle(page);
    await row('github').click();
    const box = page.locator('#cardbox');
    await expect(box).toContainText('Đăng nhập trên Mac');
    await expect(box.getByRole('button', { name: /Đăng nhập|Để sau/ })).toHaveCount(0);
  });
});
