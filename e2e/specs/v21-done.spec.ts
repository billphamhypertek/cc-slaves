// v2.1 §6 "Quy mô / Xong / thông báo, e2e" (§4.9, §4.15): 3 running sessions (#2 A1–A20, #3 B1–B20, #4 H1–H20) and 41 done
// lanes (D01–D03 unmerged, the rest merged) seeded into state.db before boot (e2e/v21-seed.ts). Real engine + fake-claude;
// lanes H2 / B5 ask the PO on their next message, orchestrator #2 finishes A3 on "kết thúc A3". A fake Tauri shell
// records the app's macOS notifications and fires `open_latest_card` (S5 focus fallback). The remote channel only exists
// in the dev mock engine (the v2.1 engine has no remote listener yet): that one case runs on frame DKX with `remote=1`.
import type { Page } from '@playwright/test';
import { expect, ORCH, PM, S, settle, test } from '../fixtures.ts';
import { openDeck, useDev } from '../deck.ts';
import { fakeTauri, focusAfterNotification, node, nodeBoxes, notified, openApp, overlaps, PID, scale, useSeeded } from '../v21-seed.ts';

const ask = (q: string) => [S.wait, S.mcp('po_ask', { question: q, options: [{ label: 'Tách' }, { label: 'Gộp' }], recommended: 'Tách' }), S.assistant('đã hỏi PO'), S.result(), ...S.idle()];
const eng = useSeeded({
  scenarios: {
    [ORCH]: { steps: [{ waitUser: 'kết thúc A3' }, S.mcp('lane_finish', { name: 'A3', force: true }), S.result('đã kết thúc A3'), ...S.idle()] },
    [PM]: { steps: [{ waitUser: 'kết thúc B7' }, S.mcp('lane_finish', { name: 'B7', force: true }), S.result('đã kết thúc B7'), ...S.idle()] },
    'lane-H2': { steps: ask('rollback 2.3?') },
    'lane-B5': { steps: ask('tách route?') },
  },
}, (e) => scale(e, { sessions: 3, perSession: 20, done: 41, unmerged: 3, seq0: 2, titles: [undefined, undefined, 'hotfix'] }));

const laneSel = (page: Page, name: string) => node(page, `lane:${name}`).locator('.nd.lane');
const rootMenu = async (page: Page, sid: string) => { await node(page, `orch:${sid}`).locator('button.more').click(); return page.getByRole('menu'); };
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
/** Ask on a lane: its next message spawns it (resume) and its scenario calls po_ask. */
const laneAsks = async (name: string) => {
  await eng.cmd({ cmd: 'send', target: { kind: 'lane', projectId: PID, name }, text: 'tiếp tục' });
  await expect.poll(async () => (await eng.health()).lanes.find(l => l.name === name)?.state, { timeout: 20_000 }).toBe('waiting_po');
};

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => {
  await fakeTauri(page);
  await page.clock.install(); // real time flows; the "vừa đổi" case fast-forwards it
  await openApp(page, eng.url());
});

test('§4.15 3 sessions × 20 lanes: no node overlaps; the bottom edge marker counts H2 waiting on the PO', async ({ page }) => {
  await laneAsks('H2');
  await expect(laneSel(page, 'H2')).toHaveClass(/st-waiting_po/);
  // §4.14 I9 (N6-a): 3 sessions running → the Chờ PO card names the lane's session ("which session needs me" = 0 steps)
  await expect(page.locator('#inbox .card', { hasText: 'rollback 2.3?' }).locator('.src').first()).toHaveText(/^#4 · .*H2/);
  await page.keyboard.press('f'); // fit (stops at 0.9: the #4 tree stays below the frame)
  await page.waitForTimeout(600);
  const bs = await nodeBoxes(page);
  expect(bs.filter(b => b.id.startsWith('lane:')).length).toBe(60);
  expect(overlaps(bs)).toEqual([]);
  const frame = (await page.locator('#map').boundingBox())!;
  const h2 = bs.find(b => b.id === 'lane:H2')!;
  expect(h2.y).toBeGreaterThan(frame.y + frame.height); // off-screen below → counted by ↓
  await expect(page.locator('.dmark.dm-down')).toContainText('1 Chờ PO');
  await expect(page.locator('.dmark.dm-up')).toHaveCount(0);
});

test('§4.15 §2 collapsing #4 keeps H2 (Chờ PO), folds the rest into "19 lane khác"; the row reopens; the fold survives a reload', async ({ page }) => {
  const m = await rootMenu(page, 's3');
  await m.getByRole('menuitem', { name: 'Thu gọn cây #4' }).click();
  await expect(laneSel(page, 'H2')).toBeVisible();
  await expect(node(page, 'lane:H1')).toHaveCount(0);
  const row = node(page, 'row:s3');
  await expect(row).toContainText('19 lane khác');
  await page.reload();
  await page.locator('.react-flow__node').first().waitFor();
  await expect(node(page, 'row:s3')).toContainText('19 lane khác');
  await node(page, 'row:s3').locator('button.hit').click();
  await expect(node(page, 'lane:H1')).toBeVisible();
  await expect(node(page, 'row:s3')).toHaveCount(0);
});

test('§4.15 §2 ⌘K "h4" reaches a lane inside a collapsed tree and selects it', async ({ page }) => {
  await (await rootMenu(page, 's3')).getByRole('menuitem', { name: 'Thu gọn cây #4' }).click();
  await expect(node(page, 'lane:H4')).toHaveCount(0);
  await blur(page);
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('h4');
  await page.keyboard.press('Enter');
  await expect(laneSel(page, 'H4')).toHaveClass(/\bsel\b/);
  await expect(page.locator('#inspector')).toContainText('H4');
});

test('§4.15 §3 Rev 18/11 shelf "Xong 41": "Chưa merge · 3" rows listed closed; "Đã merge · 38" shows 3 + "35 lane xong cũ hơn…"; the list chip gives 3', async ({ page }) => {
  const shelf = node(page, 'done');
  await expect(shelf.locator('.hd')).toContainText('41');
  await expect(shelf.locator('.sec.warn')).toHaveText('Chưa merge · 3');
  await expect(shelf.locator('button.rw')).toHaveCount(3); // unmerged rows: 0 clicks
  const tgl = shelf.locator('button.tgl');
  await expect(tgl).toHaveAttribute('aria-expanded', 'false');
  await expect(tgl).toContainText('Đã merge · 38');
  await tgl.click();
  await expect(shelf.locator('button.rw.merged')).toHaveCount(3);
  const older = shelf.locator('button.ft');
  await expect(older).toContainText('35 lane xong cũ hơn…');
  await older.click();
  const list = page.locator('#inspector .dlist');
  await expect(list.getByRole('button', { name: 'Tất cả 41' })).toHaveAttribute('aria-pressed', 'true');
  await list.getByRole('button', { name: 'Chưa merge 3' }).click();
  await expect(list.locator('.drow')).toHaveCount(3);
  await expect(list.locator('.drow b')).toHaveText(['D01', 'D02', 'D03']);
});

test('§4.15 §3 shelf order: unmerged first (D01–D03), then the newest merged (D04–D06); the shelf sits in the root column under the root', async ({ page }) => {
  const shelf = node(page, 'done');
  await shelf.locator('button.tgl').click();
  await expect(shelf.locator('button.rw .nm')).toHaveText(['D01', 'D02', 'D03', 'D04', 'D05', 'D06']);
  const bs = await nodeBoxes(page), s = bs.find(b => b.id === 'done')!, root = bs.find(b => b.id === 'orch:s1')!;
  expect(Math.abs(s.x - root.x)).toBeLessThan(2);
  expect(s.y).toBeGreaterThan(root.y + root.h);
});

test('§4.15 §3 the done list groups lanes by done day: D01–D41 (done 30 min … 20 h ago) under "Hôm nay" / yesterday, open', async ({ page }) => {
  await node(page, 'done').locator('button.tgl').click();
  await node(page, 'done').locator('button.ft').click();
  // D01 is done 30 min ago (seed): "Hôm nay" unless the run is in the first 30 min after midnight, then a dated group
  const d01 = new Date(Date.now() - 30 * 60_000), now = new Date();
  const head = page.locator('#inspector .dlist .dgh').first();
  if (d01.toDateString() === now.toDateString()) await expect(head).toContainText('Hôm nay');
  else await expect(head).not.toContainText('Hôm nay');
  await expect(page.locator('#inspector .dlist .drow').first()).toContainText('D01');
});

test('§4.15 §3 "Nhờ Điều phối #2 merge…" fills the composer and sends nothing; a draft stays, the ask goes below, box ≤ 120 px, no scroll', async ({ page }) => {
  const before = eng.read(`stdin-${ORCH}.log`);
  await node(page, 'orch:s1').locator('button.hit').click();
  const cmd = page.locator('#cmd');
  await cmd.fill('nháp của anh');
  await page.locator('#map').click({ position: { x: 5, y: 300 } });
  await node(page, 'done').locator('button.tgl').click();
  await node(page, 'done').locator('button.ft').click();
  await page.locator('#inspector .dlist').getByRole('button', { name: 'Chưa merge 3' }).click();
  await page.locator('#inspector .drow', { hasText: 'D01' }).click();
  await page.locator('#inspector').getByRole('button', { name: 'Nhờ Điều phối #2 merge…' }).click();
  await expect(page.locator('#left .inrow button.target')).toContainText('Điều phối #2');
  await expect(cmd).toHaveValue(/^nháp của anh\nMerge D01 /);
  const box = await cmd.evaluate((t: HTMLTextAreaElement) => ({ h: t.getBoundingClientRect().height, sh: t.scrollHeight, ch: t.clientHeight }));
  expect(box.h).toBeLessThanOrEqual(120);
  expect(box.sh).toBeLessThanOrEqual(box.ch);
  await page.waitForTimeout(500);
  expect(eng.read(`stdin-${ORCH}.log`)).toBe(before); // not sent
});

test('§4.15 §3 the prefilled merge ask under a draft needs no scrolling at all (scrollHeight ≤ clientHeight)', async ({ page }) => {
  await node(page, 'orch:s1').locator('button.hit').click();
  await page.locator('#cmd').fill('nháp của anh');
  await page.locator('#map').click({ position: { x: 5, y: 300 } });
  await node(page, 'done').locator('button.tgl').click();
  await node(page, 'done').locator('button.ft').click();
  await page.locator('#inspector .dlist').getByRole('button', { name: 'Chưa merge 3' }).click();
  await page.locator('#inspector .drow', { hasText: 'D01' }).click();
  await page.locator('#inspector').getByRole('button', { name: 'Nhờ Điều phối #2 merge…' }).click();
  const box = await page.locator('#cmd').evaluate((t: HTMLTextAreaElement) => ({ sh: t.scrollHeight, ch: t.clientHeight }));
  expect(box.sh).toBeLessThanOrEqual(box.ch);
});

test('§4.15 §4 focus after a notification selects the lane of the latest notification (fake Tauri shell)', async ({ page }) => {
  await laneAsks('B5');
  await expect.poll(async () => (await notified(page)).at(-1)?.lane).toBe('B5');
  const n = (await notified(page)).at(-1)!;
  expect(n.cardId).not.toBeNull();
  expect(n.title).toContain('#3'); // §4.15 sessionSeq: project · #n · lane when > 1 session
  await node(page, 'orch:s1').locator('button.hit').click();
  await focusAfterNotification(page);
  await expect(laneSel(page, 'B5')).toHaveClass(/\bsel\b/);
  await expect(page.locator('#inbox .card', { hasText: 'tách route?' })).toHaveClass(/\bsel\b|focus|on/);
});

test('§4.15 §4 a lane restored at engine boot and finished before any other event still notifies "lane xong"', async ({ page }) => {
  await eng.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: PID, sessionId: 's2' }, text: 'kết thúc B7' });
  await expect.poll(async () => (await eng.health()).lanes.find(l => l.name === 'B7')?.state, { timeout: 20_000 }).toBe('done');
  await expect.poll(async () => (await notified(page)).some(x => x.lane === 'B7')).toBe(true);
});

test('§4.15 §4 a "lane xong" notification ({projectId, lane}, no cardId) opens the shelf and selects the lane\'s row', async ({ page }) => {
  await eng.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: PID, sessionId: 's1' }, text: 'kết thúc A3' });
  await expect.poll(async () => (await eng.health()).lanes.find(l => l.name === 'A3')?.state, { timeout: 20_000 }).toBe('done');
  await expect.poll(async () => { const n = (await notified(page)).find(x => x.lane === 'A3'); return n ? `${n.projectId}/${n.lane}/${n.cardId}` : 'none'; })
    .toBe(`${PID}/A3/null`);
  await expect(node(page, 'done')).toContainText('43'); // 41 seeded + B7 (the case above) + A3
  await expect(node(page, 'lane:A3')).toHaveCount(0); // a done lane is a shelf row, never a lane node
  await focusAfterNotification(page);
  await expect(node(page, 'done').locator('button.tgl')).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, 'done').locator('button.rw.sel .nm')).toHaveText('A3');
});

test('§4.15 §2 tree #4 collapsed, H2 answered: H2 stays with "vừa đổi", then folds into the row 60 s later (fake clock)', async ({ page }) => {
  await (await rootMenu(page, 's3')).getByRole('menuitem', { name: 'Thu gọn cây #4' }).click();
  await laneSel(page, 'H2').locator('button.hit').click();
  const card = page.locator('#inbox .card', { hasText: 'rollback 2.3?' });
  await settle(page);
  await card.click(); // v2.4 §6.7 the options live in the detail box
  await page.locator('#cardbox button.opt').first().click();
  await page.clock.fastForward(5_500); // the 5 s undo
  await expect.poll(async () => (await eng.health()).lanes.find(l => l.name === 'H2')?.state, { timeout: 20_000 }).toBe('idle');
  await page.keyboard.press('Escape'); // deselect: only the change clock keeps it
  await expect(laneSel(page, 'H2')).toBeVisible();
  await expect(node(page, 'lane:H2')).toContainText('vừa đổi');
  await page.clock.fastForward(61_000);
  await expect(node(page, 'lane:H2')).toHaveCount(0);
  await expect(node(page, 'row:s3')).toContainText('20 lane khác');
});

test.describe('dev mock (DKX remote channel, DKXN 0 live lanes)', () => {
  const dev = useDev();
  test('§4.15 remote: done_lanes_list works, "Chạy tiếp lane…" is absent', async ({ page }) => {
    await openDeck(page, `${dev.url('DKX')}&remote=1`, '.react-flow__node');
    await node(page, 'done').locator('button.tgl').click();
    await node(page, 'done').locator('button.ft').click();
    const list = page.locator('#inspector .dlist');
    await expect(list.locator('.drow').first()).toBeVisible();
    await list.locator('.drow', { hasText: 'M11' }).click();
    await expect(page.locator('#inspector .dlane')).toBeVisible();
    await expect(page.getByRole('button', { name: /Chạy tiếp lane/ })).toHaveCount(0);
    await page.locator('#inspector .dlane button.more').click();
    await expect(page.getByRole('menuitem', { name: /Chạy tiếp lane/ })).toHaveCount(0);
  });
  test('§4.15 §3 Rev 18/11 0 live lanes (DKXN): the shelf sits right under the root, no lane node, no wire; a row opens its lane', async ({ page }) => {
    await openDeck(page, dev.url('DKXN'), '.react-flow__node');
    const bs = await nodeBoxes(page), s = bs.find(b => b.id === 'done')!, root = bs.find(b => b.id.startsWith('orch:'))!;
    expect(bs.filter(b => b.id.startsWith('lane:'))).toEqual([]);
    expect(Math.abs(s.x - root.x)).toBeLessThan(2);
    expect(s.y).toBeGreaterThan(root.y + root.h);
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
    const shelf = node(page, 'done');
    await expect(shelf.locator('.sec.warn')).toHaveText('Chưa merge · 2');
    await shelf.locator('button.rw', { hasText: 'M11' }).click();
    await expect(shelf.locator('button.rw.sel .nm')).toHaveText('M11');
    await expect(page.locator('#inspector .dlane')).toBeVisible();
  });
});
