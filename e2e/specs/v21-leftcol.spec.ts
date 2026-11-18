// v2.1 §6 "Cột trái" (layout C, §4.11b) on dev frames (mock engine): Đang xem follows the selection (crumb, content, composer
// target), Esc goes up exactly one level, the deck area never resizes, Chờ PO folds to one line (0 cards, Q, after the 5 s
// undo), the narrow drawer (1024×640); tooltips and toasts never cover the left column (replaces v1.1 "không đè #inbox / #console").
import type { Page } from '@playwright/test';
import { expect, settle, test } from '../fixtures.ts';
import { blur, crumb, deckRect, openDeck, useDev } from '../deck.ts';

const dev = useDev();
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const insp = (page: Page) => page.locator('#inspector');
const target = (page: Page) => page.locator('#inspector button.target');
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('§4.11b select Điều phối / lane / sub / account → Đang xem content, crumb, composer target; Esc up one level', async ({ page }) => {
  await openDeck(page, dev.url('DK5'));
  await expect(insp(page)).toHaveClass(/k-orch/);
  expect(await crumb(page)).toBe('Điều phối');
  await expect(target(page)).toHaveText('Điều phối'); // v2.4 §6.2 D51: the recipient is the bare name, "↳" is CSS ::before
  expect(await target(page).evaluate(e => getComputedStyle(e, '::before').content)).toBe('"↳"');

  await node(page, 'lane:D2').locator('.hit').click();
  await expect(insp(page)).toHaveClass(/k-lane/);
  expect(await crumb(page)).toMatch(/^Điều phối › D2$/);
  await expect(insp(page).locator('.lhead h2')).toHaveText('D2');
  await expect(insp(page)).toContainText('Worktree');
  await expect(target(page)).toHaveText('D2');

  await settle(page);
  await node(page, 'sub:D2:d2a').locator('.hit').click();
  await expect(insp(page)).toHaveClass(/k-sub/);
  expect(await crumb(page)).toMatch(/^Điều phối › D2 › tests$/);
  await expect(insp(page)).toContainText('Chạy lại integration lot-2');
  await expect(target(page)).toHaveText('D2'); // a sub is read-only: the composer goes to its parent lane

  await blur(page);
  await page.keyboard.press('Escape');
  await expect(insp(page)).toHaveClass(/k-lane/);
  await page.keyboard.press('Escape');
  await expect(insp(page)).toHaveClass(/k-orch/);
  await page.keyboard.press('Escape'); // the top: stays on Điều phối
  await expect(insp(page)).toHaveClass(/k-orch/);

  await page.keyboard.press('a');
  await page.locator('.accp.open .acrow[data-email="acc003@x-dev.test"] .hit').click();
  await expect(insp(page)).toHaveClass(/k-account/);
  expect(await crumb(page)).toMatch(/^Account › acc003@$/);
  await expect(insp(page)).toContainText('acc003@x-dev.test');
  await expect(target(page)).toHaveText('Điều phối'); // account → the composer targets Điều phối
  await blur(page);
  await page.keyboard.press('Escape'); // the open account panel first (§4.11 ladder)
  await expect(page.locator('.accp.open')).toHaveCount(0);
  await expect(insp(page)).toHaveClass(/k-account/);
  await page.keyboard.press('Escape');
  await expect(insp(page)).toHaveClass(/k-orch/);
});

test('§4 layout C: the deck area never resizes — select lane / sub / account, open the panel, a menu, fold Chờ PO (1280, 1024)', async ({ page }) => {
  for (const [w, h] of [[1280, 800], [1024, 640]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openDeck(page, dev.url('DK5'));
    const r0 = await deckRect(page);
    const same = async (what: string) => expect(await deckRect(page), `${w}: ${what}`).toEqual(r0);
    await node(page, 'lane:D2').locator('.hit').click(); await same('lane');
    await settle(page);
    await node(page, 'sub:D2:d2a').locator('.hit').click(); await same('sub');
    await blur(page);
    await page.keyboard.press('a'); await same('account panel');
    await page.locator('.accp.open .acrow').first().locator('.hit').click(); await same('account');
    await page.keyboard.press('Escape');
    await settle(page);
    await node(page, 'lane:B2').locator('button.more').click(); await same('menu');
    await page.keyboard.press('Escape');
    await blur(page);
    await page.keyboard.press('q'); await same('Q');
    await page.keyboard.press('q');
  }
});

test('§4.11b 0 cards waiting → Chờ PO is one line "0 · Không có việc chờ PO", Đang xem grows', async ({ page }) => {
  await openDeck(page, dev.url('DK0'));
  const inbox = page.locator('#inbox');
  await expect(inbox).toHaveClass(/line/);
  await expect(inbox).toContainText('Không có việc chờ PO');
  await expect(inbox.locator('.card')).toHaveCount(0);
  const [ib, ins] = [(await inbox.boundingBox())!, (await insp(page).boundingBox())!];
  expect(ib.height).toBeLessThanOrEqual(48);
  expect(ins.y).toBeLessThan(ib.y + ib.height + 16);
});

test('§4.11b answering the last card: the card stays for the 5 s undo, then Chờ PO folds to one line (N1-k)', async ({ page }) => {
  await openDeck(page, dev.url('DKS')); // one open card (DK5 also carries R5's broken card)
  const inbox = page.locator('#inbox');
  await expect(inbox.locator('.card')).toHaveCount(1);
  await settle(page); // ClickGuard
  await inbox.locator('.card').click(); // v2.4 §6.7 the options live in the detail box
  await page.locator('#cardbox button.opt').first().click();
  const t0 = Date.now();
  await page.waitForTimeout(4000);
  await expect(inbox).not.toHaveClass(/line/);
  await expect(inbox.locator('.card')).toHaveCount(1);
  await expect(inbox).toHaveClass(/line/, { timeout: 4000 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(4900);
});

test('§4.11 Q folds Chờ PO to one line and opens it again (the count stays)', async ({ page }) => {
  await openDeck(page, dev.url('DK5'));
  const inbox = page.locator('#inbox');
  await expect(inbox.locator('.card')).toHaveCount(2); // D15 asks, R5 broken
  await blur(page);
  await page.keyboard.press('q');
  await expect(inbox).toHaveClass(/line/);
  await expect(inbox).toContainText('2');
  await expect(inbox.locator('.card')).toHaveCount(0);
  await page.keyboard.press('q');
  await expect(inbox.locator('.card')).toHaveCount(2);
});

test('§4.10 1024×640: the column is one drawer — a node click opens it, Esc closes it, a new card opens it (N4-j)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openDeck(page, dev.url('F4'));
  const left = page.locator('#left');
  if (await page.locator('body.drawer').count()) { await blur(page); await page.keyboard.press('Escape'); }
  await expect(page.locator('body.drawer')).toHaveCount(0);
  await expect(left).toHaveAttribute('aria-hidden', 'true');
  await node(page, 'lane:D15').locator('.hit').click();
  await expect(page.locator('body.drawer')).toHaveCount(1);
  await expect(left).toBeVisible();
  await expect(insp(page).locator('.lhead h2')).toHaveText('D15');
  await blur(page);
  await page.keyboard.press('Escape'); // Đang xem up one level first, then the drawer
  await page.keyboard.press('Escape');
  await expect(page.locator('body.drawer')).toHaveCount(0);
  // the F4 mock pushes a new card 6 s after connect
  await expect(page.locator('body.drawer')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('#inbox')).toContainText('giữ API cũ song song');
});

/** The account panel open and, below 1280 px, the drawer open too (⌘L = focus the composer, §4.10): both are obstacles. */
async function hudOpen(page: Page, w: number): Promise<void> {
  await blur(page);
  await page.keyboard.press('a');
  await expect(page.locator('.accp.open')).toBeVisible();
  if (w < 1280) {
    await page.keyboard.press('Meta+l');
    await expect(page.locator('body.drawer')).toHaveCount(1);
    await page.waitForTimeout(300); // the 180 ms drawer slide
    await blur(page);
  }
}

for (const [w, h] of [[1280, 800], [1024, 640]] as const) {
  test(`§6 v1.1 N1 ${w}×${h}: lane tooltips ≤ 320 px, inside the window, never on the left column or the open account panel`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openDeck(page, dev.url('DK5L'));
    await hudOpen(page, w);
    const hud: Box[] = [];
    for (const sel of ['#left', '.accp.open']) hud.push((await page.locator(sel).boundingBox())!);
    let tips = 0;
    for (const l of await page.locator('.react-flow__node-lane').all()) {
      const b = await l.boundingBox();
      if (!b || b.x < 0 || b.y < 0 || b.x + b.width > w || b.y + b.height > h) continue;
      const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2];
      // a node under the narrow drawer / the open panel cannot be hovered: skip it
      if (!(await l.evaluate((e, [x, y]) => e.contains(document.elementFromPoint(x!, y!)), [cx, cy]))) continue;
      await page.mouse.move(cx, cy);
      const tb = await page.locator('.dtip').boundingBox();
      if (!tb) continue;
      tips++;
      const id = await l.getAttribute('data-id');
      expect(tb.width, id!).toBeLessThanOrEqual(320.5);
      expect(tb.x >= 0 && tb.y >= 0 && tb.x + tb.width <= w && tb.y + tb.height <= h, `${id}: tip ${JSON.stringify(tb)} inside the window`).toBe(true);
      // v2.7.1 §4.3: the panel is 380 px at 1024, so the deck gap between the open column and the panel can be narrower than the
      // tip; then no spot is free and placeTip takes the least overlap (reported to the orchestrator, v271-g3a ⑥)
      const room = hud.length === 2 ? hud[1]!.x - (hud[0]!.x + hud[0]!.width) - 8 : Infinity;
      if (tb.width <= room) for (const r of hud) expect(overlaps(tb, r), `${id}: tip ${JSON.stringify(tb)} on the HUD ${JSON.stringify(r)}`).toBe(false);
    }
    expect(tips).toBeGreaterThan(3);
  });

  test(`§6 UX-M6 / N3-k ${w}×${h}: a toast sits on the graph part left visible — never on the left column, the account panel or the header bar`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openDeck(page, dev.url('DK5'));
    await hudOpen(page, w);
    await page.keyboard.press('m'); // "Đã tắt âm (M)"
    const t = page.locator('#toasts .toast').filter({ hasText: 'âm (M)' });
    await expect(t).toBeVisible();
    const tb = (await t.boundingBox())!;
    for (const sel of ['#left', '.accp.open', '.dhead']) expect(overlaps(tb, (await page.locator(sel).boundingBox())!), `toast on ${sel}`).toBe(false);
    expect(tb.x >= 0 && tb.x + tb.width <= w && tb.y >= 0, 'inside the window').toBe(true);
  });
}

// ---------------------------------------------------------------- v21-ux-review fixes (part B): layout at the root

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const inside = (a: Box, b: Box) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
const ended = async (page: Page, n: number) => {
  await blur(page);
  await page.keyboard.press('h');
  await page.getByRole('menu', { name: 'Lịch sử phiên' }).locator('button.srow', { hasText: `#${n}` }).click();
  await expect(insp(page)).toContainText(`Phiên #${n}`);
};
/** Clipped text in the left column, the nodes, the deck header and the account panel: [what, ok]. ok = ellipsis + the full
 *  text reachable (a `title` on it or an ancestor; inside a node / account row: its tooltip = aria-label carries it). */
const clipped = (page: Page) => page.evaluate(() => {
  const out: [string, boolean][] = [];
  for (const el of document.querySelectorAll<HTMLElement>('#left *, .react-flow__node *, .dhead *, .accp *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim())) continue;
    if (el.scrollWidth <= el.clientWidth + 1 || cs.overflowX === 'visible') continue;
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const tip = el.closest('.react-flow__node, .acrow')?.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
    const full = !!el.closest('[title]') || tip.replace(/\s+/g, ' ').includes(txt);
    const dots = cs.textOverflow === 'ellipsis' && !/flex|grid/.test(cs.display); // a flex / grid box never draws the "…"
    out.push([`${el.className} "${txt.slice(0, 50)}" to=${cs.textOverflow} ${cs.display} full=${full}`, dots && full]);
  }
  return out;
});

test('UX-I5 N1-g / N4-f: the Điều phối head never overlaps — title fixed, "làm với …" ellipsises with a title (vi, en)', async ({ page }) => {
  for (const q of ['', 'lang=en']) {
    await openDeck(page, dev.url('DK5L', q));
    const h2 = await box(page, '#inspector .ohead .row h2'), st = await box(page, '#inspector .ohead .row .st');
    expect(overlaps(h2, st), `${q}: h2 ${JSON.stringify(h2)} vs status ${JSON.stringify(st)}`).toBe(false);
    expect(st.x).toBeGreaterThanOrEqual(h2.x + h2.width);
    await expect(insp(page).locator('.ohead .row .st')).toHaveAttribute('title', /D2, B2, B7/);
    expect(await insp(page).locator('.ohead .row .st').evaluate(e => getComputedStyle(e).textOverflow)).toBe('ellipsis');
  }
});

for (const [w, h] of [[1440, 900], [1024, 640]] as const) {
  test(`UX-I6 N2-a / N4-j ${w}×${h}: lane info, subagents, conversation and composer never overlap; Subagent head on screen`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openDeck(page, dev.url('DK5'));
    await node(page, 'lane:D2').locator('.hit').click();
    await expect(insp(page)).toHaveClass(/k-lane/);
    await page.waitForTimeout(300);
    const [ins, info, hist, row] = [await box(page, '#inspector'), await box(page, '#inspector .iinfo'), await box(page, '#inspector .hist'), await box(page, '#inspector .inrow')];
    for (const [n, b] of [['info', info], ['hist', hist], ['composer', row]] as const) expect(inside(b, ins), `${n} inside Đang xem`).toBe(true);
    expect(info.y + info.height).toBeLessThanOrEqual(hist.y + 1);
    expect(hist.y + hist.height).toBeLessThanOrEqual(row.y + 1);
    // a hist too short to read draws nothing (no 1-row sliver over the info)
    if (hist.height < 48) expect(await insp(page).locator('.hist [data-vk]').evaluateAll(els => els.filter(e => getComputedStyle(e).visibility !== 'hidden').length)).toBe(0);
    expect(inside(await box(page, '#inspector .subsec .log-h'), info), 'SUBAGENT head visible in the info block').toBe(true);
    // UX-I6 (re-review) on the v2.2 F-I8 fold (D2 runs → the facts are one line): the info block keeps its height; the
    // folded facts line is on screen, not scrolled under the conversation nor under the sticky Subagent head
    const sum = insp(page).locator('.lhead .kvsum');
    await expect(sum).toHaveAttribute('aria-expanded', 'false');
    await expect(insp(page).locator('.lhead .kv')).toHaveCount(0);
    const sb = await box(page, '#inspector .lhead .kvsum');
    expect(inside(sb, info), `facts line inside the info block ${JSON.stringify(sb)} vs ${JSON.stringify(info)}`).toBe(true);
    expect(sb.y + sb.height, 'the sticky Subagent head does not cover the facts line').toBeLessThanOrEqual((await box(page, '#inspector .subsec .log-h')).y + 1);
    // expanded: the first kv row (Worktree) is on screen inside the info block, above the sticky Subagent head
    await sum.click();
    await expect(sum).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(300);
    const info2 = await box(page, '#inspector .iinfo'), hist2 = await box(page, '#inspector .hist'), row2 = await box(page, '#inspector .inrow');
    expect(info2.y + info2.height, 'expanded: info above the conversation').toBeLessThanOrEqual(hist2.y + 1);
    expect(hist2.y + hist2.height, 'expanded: conversation above the composer').toBeLessThanOrEqual(row2.y + 1);
    const kv = await box(page, '#inspector .lhead .kv dd');
    expect(inside(kv, info2), `Worktree row inside the info block ${JSON.stringify(kv)} vs ${JSON.stringify(info2)}`).toBe(true);
    expect(kv.y + kv.height, 'the sticky Subagent head does not cover the Worktree row').toBeLessThanOrEqual((await box(page, '#inspector .subsec .log-h')).y + 1);
    const all = await box(page, '#inspector .lhead .kv');
    expect(all.y + all.height, 'expanded: every fact (the last row too) is above the sticky Subagent head').toBeLessThanOrEqual((await box(page, '#inspector .subsec .log-h')).y + 1);
  });
}

// m-2 N2-a: a selected lane's info block gets the room first (conversation floor 0, as in the 1024 drawer)
for (const n of [0, 1, 2, 3]) {
  test(`m-2 N2-a 1440×900 ${n} card(s): lane info is whole before the conversation gets any room`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDeck(page, dev.url('DK5', `cards=${n}`));
    await expect(page.locator('#inbox .card')).toHaveCount(n);
    await node(page, 'lane:D2').locator('.hit').click();
    await expect(insp(page)).toHaveClass(/k-lane/);
    await page.waitForTimeout(300);
    const info = insp(page).locator('.iinfo');
    const whole = async (what: string) => {
      const [sh, ch] = await info.evaluate(e => [e.scrollHeight, e.clientHeight]);
      const hist = await box(page, '#inspector .hist');
      if (sh > ch + 1) expect(hist.height, `${what}: info scrolls (${sh} > ${ch}) while the conversation keeps ${hist.height} px`).toBeLessThanOrEqual(1);
    };
    // v2.2 F-I8: D2 runs → the facts are one line; that line is whole and on screen before the conversation gets room
    const sum = insp(page).locator('.lhead .kvsum');
    await expect(sum).toHaveAttribute('aria-expanded', 'false');
    await whole('folded');
    expect(inside(await box(page, '#inspector .lhead .kvsum'), await box(page, '#inspector .iinfo')), 'facts line inside the info block').toBe(true);
    // expanded: the facts are whole again, and the Account row (mockup "Account trước") is on screen
    await sum.click();
    await page.waitForTimeout(300);
    await whole('expanded');
    const acc = await box(page, '#inspector .lhead .kv dt:nth-of-type(3)'), ib = await box(page, '#inspector .iinfo');
    if (n <= 2) expect(inside(acc, ib), `Account row ${JSON.stringify(acc)} inside the info block ${JSON.stringify(ib)}`).toBe(true);
  });
}

// UX-N-a: Chờ PO sizes to its rows up to its cap (R32 30 %); the last row's last button is on screen (no fade while they fit) with 1 / 2 rows
for (const [w, h, f, n] of [[1440, 900, 'DKS', 1], [1440, 900, 'DK5', 2]] as const) {
  test(`UX-N-a ${w}×${h} ${f}: ${n} card(s) — the last card's last button is inside the Chờ PO block, no fade`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openDeck(page, dev.url(f));
    if (w < 1280 && !(await page.locator('body.drawer').count())) await page.locator('#inboxBtn').click();
    await expect(page.locator('#inbox .card')).toHaveCount(n);
    await page.waitForTimeout(300);
    const cards = await box(page, '#inbox .cards');
    const last = (await page.locator('#inbox .card').last().locator('button').last().boundingBox())!;
    // R43 I2 the rows fit: no fade and no 16 px band, 4 px (--s2) under the last row
    await expect(page.locator('#inbox .cards')).not.toHaveClass(/gscroll/);
    expect(last.y + last.height, `last button ${JSON.stringify(last)} inside ${JSON.stringify(cards)}, 4 px pad`).toBeLessThanOrEqual(cards.y + cards.height - 4 + 1);
    expect(last.y).toBeGreaterThanOrEqual(cards.y);
    const left = await box(page, '#left');
    expect((await box(page, '#inbox')).height, 'Chờ PO never takes more than its cap (R32 30 %)').toBeLessThanOrEqual(left.height * 0.3 + 1);
  });
}

test('UX-I7 N5-i: expired session — main "Phiên mới từ 50 dòng cuối" on its own row inside the column, "Chạy tiếp…" dimmed, reason box below', async ({ page }) => {
  await openDeck(page, dev.url('DKS'));
  await ended(page, 1);
  const info = await box(page, '#inspector .iinfo');
  const main = insp(page).locator('.ohead.ended .acts .btn.pri');
  await expect(main).toHaveText('Phiên mới từ 50 dòng cuối');
  expect(inside((await main.boundingBox())!, info), 'main button inside the column').toBe(true);
  await expect(insp(page).getByRole('button', { name: 'Chạy tiếp…' })).toBeDisabled();
  const why = insp(page).locator('.ohead.ended .preview.bad');
  await expect(why).toBeVisible();
  expect((await why.boundingBox())!.y).toBeGreaterThan((await main.boundingBox())!.y);
  expect(inside((await why.boundingBox())!, info)).toBe(true);
});

test('UX-I8 N5-m: merged done lane — "Chạy tiếp lane…" dimmed and the red reason box is on screen', async ({ page }) => {
  await openDeck(page, dev.url('DKX'));
  await node(page, 'done').locator('button.tgl').click();
  await node(page, 'done').locator('button.ft').click();
  await insp(page).locator('.drow', { hasText: 'M2' }).click();
  await expect(insp(page).locator('.dlane')).toBeVisible();
  await expect(insp(page).getByRole('button', { name: 'Chạy tiếp lane…' })).toBeDisabled();
  const why = insp(page).locator('.dlane .preview.bad');
  await expect(why).toContainText('Không chạy tiếp được: Nhánh đã merge');
  expect(inside((await why.boundingBox())!, await box(page, '#inspector .iinfo'))).toBe(true);
});

test('UX-I2 N5-k: the red confirm button of "Kết thúc phiên" has a readable label (text ≠ background)', async ({ page }) => {
  await openDeck(page, dev.url('DKS'));
  await node(page, 'orch:s4').locator('button.more').click();
  await page.getByRole('menuitem', { name: 'Kết thúc phiên…' }).click();
  const b = page.getByRole('dialog').locator('.btn.pri.bad');
  await expect(b).toBeVisible();
  const [fg, bg] = await b.evaluate(e => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
  expect(fg).not.toBe(bg);
});

test('UX-M6 N4-c: Điều phối starting — the skeleton only, no old transcript under it', async ({ page }) => {
  await openDeck(page, dev.url('F13'));
  await expect(insp(page).locator('.ohead .skel')).toBeVisible();
  await expect(insp(page).locator('.hist')).toHaveCount(0);
});

test('UX-M7 N1-k: picking an option keeps Đang xem where it was; the Chờ PO count drops during the 5 s undo', async ({ page }) => {
  await openDeck(page, dev.url('DK5'));
  await settle(page);
  const card = page.locator('#inbox .card', { hasText: 'D15' }); // DK5 also carries R5's broken card (no options)
  const cnt = page.locator('#inbox header .cnt');
  await expect(cnt).toHaveText('2'); // D15 asks, R5 broken
  await card.click(); // v2.4 §6.7 opening the box selects the card's lane (as the v2.1 card click did)
  await expect(insp(page)).toHaveClass(/k-lane/);
  await page.locator('#cardbox button.opt').first().click();
  await expect(card).toContainText('Hoàn tác');
  await expect(insp(page)).toHaveClass(/k-lane/);
  await expect(cnt).toHaveText('1');
});

test('UX-M8 N2-c / N2-g: menus show Enter / ⌘. hints; ⌘. in the menu runs Ngắt lượt', async ({ page }) => {
  await openDeck(page, dev.url('DK5'));
  await node(page, 'lane:D2').locator('button.more').click();
  const m = page.getByRole('menu').first();
  await expect(m.getByRole('menuitem', { name: /Nhắn/ }).locator('kbd')).toHaveText('Enter');
  await expect(m.getByRole('menuitem', { name: /Ngắt lượt/ }).locator('kbd')).toHaveText('⌘.');
  await page.keyboard.press('Meta+.');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('UX-M8 N2-i / N3-c: a focused lane node tip carries its subagents + the keys; an account row hover shows a tooltip', async ({ page }) => {
  await openDeck(page, dev.url('DK5'));
  // v2.7 §4.1 D91: the app opens in Tasks and the fixture clicks "Deck" (a pointer event), so a scripted focus would not be
  // :focus-visible; a key press first puts Chromium back in keyboard modality, as a keyboard user reaching the node has
  await page.keyboard.press('Shift');
  await node(page, 'lane:B2').locator('button.hit').focus();
  const tip = page.locator('.dtip');
  await expect(tip).toContainText('2 subagent');
  await expect(tip).toContainText('Enter = chọn');
  await blur(page);
  await page.keyboard.press('a');
  await page.locator('.accp.open .acrow').first().hover();
  const rt = page.locator('.accp-tip');
  await expect(rt).toBeVisible();
  await expect(rt).toContainText('tuần: dùng'); // v2.7.1 §4.5 the tooltip: windows used + reset (còn …), data time
  await expect(rt).toContainText('Số liệu lúc');
  expect(overlaps((await rt.boundingBox())!, await box(page, '.accp.open'))).toBe(false);
});

test('UX-M9 N5-p: a toast never covers a node of the fitted deck', async ({ page }) => {
  await openDeck(page, dev.url('DK5'));
  await blur(page);
  await page.keyboard.press('m');
  const t = page.locator('#toasts .toast').first();
  await expect(t).toBeVisible();
  const tb = (await t.boundingBox())!;
  for (const nb of await page.locator('.react-flow__node').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }))) {
    expect(overlaps(tb, nb), `toast ${JSON.stringify(tb)} on a node ${JSON.stringify(nb)}`).toBe(false);
  }
});

test('UX-M10 N3-l: the account view has the "Hôm nay" row', async ({ page }) => {
  await openDeck(page, dev.url('DK5'));
  await blur(page);
  await page.keyboard.press('a');
  await page.locator('.accp.open .acrow').nth(1).locator('.hit').click();
  await expect(insp(page).locator('.ahead dt', { hasText: 'Hôm nay' })).toHaveCount(1);
});

for (const [w, h] of [[1440, 900], [1024, 640]] as const) {
  test(`UX-M12 ${w}×${h}: every clipped text ellipsises and its full text is reachable (vi, en); the composer placeholder too`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const f of ['DK5L', 'DKS']) for (const q of ['', 'lang=en']) {
      await openDeck(page, dev.url(f, q));
      if (w < 1280) { await page.keyboard.press('Meta+l'); await page.waitForTimeout(300); }
      await blur(page);
      await page.keyboard.press('a');
      await node(page, 'lane:D2').locator('.hit').click();
      await page.waitForTimeout(300);
      const bad = (await clipped(page)).filter(([, ok]) => !ok).map(([s]) => s);
      expect(bad, `${f} ${q}`).toEqual([]);
      // the crumb's last part (the lane being viewed) is never the part that gets cut by the header's hint / toggle
      expect(await insp(page).locator('.ih .crumb b').evaluate(e => e.scrollWidth - e.clientWidth), `${f} ${q} crumb lane name whole`).toBeLessThanOrEqual(1);
      await expect(insp(page).locator('.ih .crumb'), 'the whole crumb path is its title').toHaveAttribute('title', /^\S.* › D2$/);
      // v2.2 F-I8 folded facts line: its full text is its title; expanded, every clipped fact still ellipsises with full text
      const sum = insp(page).locator('.lhead .kvsum');
      await expect(sum).toHaveAttribute('title', (await sum.locator('span').textContent())!);
      await sum.click();
      await expect(insp(page).locator('.lhead .kv')).toHaveCount(1);
      const bad2 = (await clipped(page)).filter(([, ok]) => !ok).map(([s]) => s);
      expect(bad2, `${f} ${q} expanded`).toEqual([]);
      const cmd = page.locator('#cmd');
      await expect(cmd).toHaveAttribute('title', (await cmd.getAttribute('placeholder'))!);
      expect(await cmd.evaluate(e => [getComputedStyle(e).whiteSpace, getComputedStyle(e).textOverflow])).toEqual(['nowrap', 'ellipsis']);
    }
  });
}

test('§4.7 N3-d: a filter that matches nothing says so and offers "Xoá lọc", which empties the box and brings the rows back', async ({ page }) => {
  await openDeck(page, dev.url('DK30'));
  await page.locator('button.accp.mini').click();
  const f = page.locator('.accp.open input.afilter');
  await f.fill('zzz');
  await expect(page.locator('.accp.open .anone')).toContainText('Không có account khớp');
  await page.locator('.accp.open .anone').getByRole('button', { name: 'Xoá lọc' }).click();
  await expect(f).toHaveValue('');
  await expect(page.locator('.accp.open .anone')).toHaveCount(0);
  await expect(f).toBeFocused();
});

test('UX-N-b N4-m: a pan drag that starts on the deck and runs into the left column selects no text', async ({ page }) => {
  await openDeck(page, dev.url('DK5L'));
  const d = (await page.locator('.dframe').boundingBox())!;
  await page.mouse.move(d.x + d.width - 60, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(60, d.y + 120, { steps: 10 });
  await page.mouse.up();
  expect(await page.evaluate(() => String(window.getSelection() ?? ''))).toBe('');
});

// v2.4 §6.7 D52 + R32 (PO 16/11, CP1 / CP5): 30 px rows; Chờ PO takes at most 30 % of the column at every window size and
// shrinks to its rows when fewer, past that its rows scroll with the bottom fade; Đang xem keeps ≥ 70 %. (R32 replaces the
// 56 % / 46 % caps and the §6.2 I1 `--inbox-fit` yield; it also supersedes "13 rows without scrolling" (R34): 13 × 30 px
// cannot fit in 30 % of a 900 px window — the mockup CP1 shows the first 7 rows and a scroll.)
const column = async (page: Page) => {
  const left = page.locator('#left');
  return left.evaluate(e => { const cs = getComputedStyle(e); return e.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom); });
};
test('§6.7 CP1 R32 1440×900, 13 rows: Chờ PO ≤ 30 % of the column, the first rows whole (mockup CP1: 7), the rest scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDeck(page, dev.url('DKC', 'cards=13'));
  const rows = page.locator('#inbox .card');
  await expect(rows).toHaveCount(13);
  const hs = await rows.evaluateAll(es => es.map(e => Math.round(e.getBoundingClientRect().height)));
  expect(new Set(hs)).toEqual(new Set([32])); // --h-row 32 (hot fix 2026-11-16)
  const col = await column(page), ib = await box(page, '#inbox'), cards = await box(page, '#inbox .cards');
  expect(ib.height, `Chờ PO ${ib.height} ≤ 30 % of ${col}`).toBeLessThanOrEqual(col * 0.3 + 1);
  expect(ib.height, 'the cap is reached (13 rows want more)').toBeGreaterThanOrEqual(col * 0.3 - 1);
  const whole = await rows.evaluateAll((es, bottom) => es.filter(e => e.getBoundingClientRect().bottom <= bottom + 0.5).length, cards.y + cards.height);
  expect(whole, `${whole} whole rows`).toBeGreaterThanOrEqual(6);
  const [sh, ch] = await page.locator('#inbox .cards').evaluate(e => [e.scrollHeight, e.clientHeight]);
  expect(sh).toBeGreaterThan(ch);
  expect((await box(page, '#inspector')).height, 'Đang xem keeps ≥ 70 % of the column (less the gap)').toBeGreaterThanOrEqual(col * 0.7 - 10 - 1);
});

test('§6.7 R32 few rows: Chờ PO shrinks to its 3 rows (no scroll, under 30 %), Đang xem takes the rest', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDeck(page, dev.url('DKC', 'cards=3'));
  await expect(page.locator('#inbox .card')).toHaveCount(3);
  const col = await column(page), ib = await box(page, '#inbox'), insp = await box(page, '#inspector');
  expect(ib.height).toBeLessThan(col * 0.3 - 30);
  const [sh, ch] = await page.locator('#inbox .cards').evaluate(e => [e.scrollHeight, e.clientHeight]);
  expect(sh).toBeLessThanOrEqual(ch + 1);
  expect(Math.round(ib.height + 10 + insp.height)).toBeGreaterThanOrEqual(Math.round(col) - 1); // the gap is --s4 (10, hot fix 2026-11-16)
});

for (const [w, h] of [[1440, 900], [1024, 640]] as const) {
  test(`§6.7 CP5 R32 ${w}×${h}: past 30 % of the column Chờ PO scrolls, bottom edge faded`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openDeck(page, dev.url('DKC', 'cards=30'));
    if (w < 1280 && !(await page.locator('body.drawer').count())) await page.locator('#inboxBtn').click();
    await expect(page.locator('#inbox .card')).toHaveCount(30);
    const ib = await box(page, '#inbox'), col = await column(page);
    expect(ib.height, `Chờ PO ${ib.height} ≤ 30 % × ${col}`).toBeLessThanOrEqual(col * 0.3 + 1);
    const cards = page.locator('#inbox .cards');
    const [sh, ch] = await cards.evaluate(e => [e.scrollHeight, e.clientHeight]);
    expect(sh).toBeGreaterThan(ch);
    expect(await cards.evaluate(e => getComputedStyle(e).maskImage || getComputedStyle(e).webkitMaskImage)).toContain('linear-gradient');
  });
}

// R43 I3 the short column (1024 × 640 drawer): a lane with 3 subagents shows 1 sub row + "+2 subagent", the facts folded, and
// the conversation keeps ≥ 160 px; Điều phối too
test('R43 I3 1024×640: lane D2 (3 subagents) and Điều phối keep ≥ 160 px of conversation', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openDeck(page, dev.url('DK5'));
  if (!(await page.locator('body.drawer').count())) await page.locator('#inboxBtn').click();
  await page.waitForTimeout(300);
  expect((await box(page, '#inspector .hist')).height, 'Điều phối conversation').toBeGreaterThanOrEqual(160);
  await node(page, 'lane:D2').locator('.hit').click();
  await expect(insp(page)).toHaveClass(/k-lane/);
  await page.waitForTimeout(300);
  await expect(insp(page).locator('.subs .sub')).toHaveCount(1);
  const more = insp(page).locator('.subsec .submore');
  await expect(more).toHaveText(/\+2 subagent/);
  await expect(insp(page).locator('.lhead .kvsum')).toHaveAttribute('aria-expanded', 'false');
  expect((await box(page, '#inspector .hist')).height, 'lane conversation').toBeGreaterThanOrEqual(160);
  await more.click();
  await expect(insp(page).locator('.subs .sub')).toHaveCount(3);
});
