// v2.2 §14.7 E2E (frames S1–S11): fake-claude streams real-shape deltas on a scripted rhythm; the Đang xem block paces
// them (monotonic, ends equal to the source), never shrinks, never remounts at the swap to the full line, holds a
// scrolled-up view (S6), keeps an opened tool row's top still, gates the code-block copy (C32), keeps two lanes and a sub
// apart (S8), fits the 1024 × 640 drawer (S4-narrow), speaks English (S10).
import type { Page } from '@playwright/test';
import { expect, ORCH, PM, B2, S, test, useEngine } from '../fixtures.ts';

const PLAIN = 'Mình đã xem lại chỗ nối chữ trong store của lane D2. Mỗi khối giờ có khoá riêng theo tin và thứ tự khối, '
  + 'nên hai khối chạy song song không còn đè nhau nữa. Chữ của subagent chỉ hiện trong khối Đang xem của chính nó, '
  + 'không bao giờ lẫn vào lane cha. Khi dòng đầy đủ tới, khối đang chạy được thay tại chỗ trong cùng một lần cập nhật, '
  + 'giữ nguyên nút trên màn hình và chiều cao đã đo. Tiếp theo mình sẽ chạy lại bộ kiểm thử web rồi báo kết quả cho anh.';
const CODE = 'Đây là đoạn sửa:\n\n```ts\n' + Array.from({ length: 10 }, (_, i) => `const v${i} = partials[key].text.length + ${i};`).join('\n') + '\n```\n\nXong phần sửa.';
const LONG = Array.from({ length: 30 }, (_, i) => `Đoạn ${i + 1}: chữ tiếp tục tới trong lúc anh đang đọc phần trên của cuộc trò chuyện này.`).join('\n\n');
const D2 = 'D2 nói: đang sửa chỗ nối delta theo khoá trong store, ' + 'thêm kiểm thử cho hai khoá song song. '.repeat(8);
const D3 = 'D3 nói: đang chạy cổng e2e cho nhánh này, ' + 'chưa thấy lỗi nào mới. '.repeat(10);
const SUB = 'SUBTEXT chữ của subagent không được lẫn vào lane';
const CUT = 'Câu này bị ngắt giữa chừng và không bao giờ có dòng đầy đủ';
const NEXT = 'Câu trả lời của lượt sau, tới sau phần bị ngắt. '.repeat(3);

const bash = (i: number, lines = 20) => [
  { emit: { type: 'assistant', parent_tool_use_id: null, message: { id: `msg_b${i}`, role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id: `toolu_b${i}`, name: 'Bash', input: { command: `bun test web/test/case-${i}.test.ts` } }] } } },
  { emit: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_b${i}`, content: Array.from({ length: lines }, (_, k) => `dòng ${k + 1}`).join('\n') }] } } },
];
const edit = { emit: { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_e1', role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id: 'toolu_e1',
  name: 'Edit', input: { file_path: '/Users/po/Works/Projects/very/long/path/to/the/project/web/src/lib/store.ts', old_string: 'a\nb\nc', new_string: 'a\nx\ny\nz' } }] } } };
const editRes = { emit: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e1', content: 'ok' }] } } };
/** S8 the sub of D2: its Task call + `task_started`, so the deck has a `sub:D2:sa_d2` node with its own Đang xem */
const task = [
  { emit: { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_task', role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id: 'toolu_task1',
    name: 'Task', input: { description: 'đọc store', subagent_type: 'Explore', prompt: 'đọc' } }] } } },
  { emit: { type: 'system', subtype: 'task_started', task_id: 'sa_d2', tool_use_id: 'toolu_task1', description: 'đọc store', subagent_type: 'Explore', prompt: 'đọc', is_backgrounded: false } },
];
const stream = (id: string, text: string, chunk: number, everyMs: number, extra: Record<string, unknown> = {}) => ({ stream: { id, chunk, everyMs, blocks: [{ text }], ...extra } });

const eng = useEngine({
  scenarios: (e) => ({
    [ORCH]: { steps: [
      ...S.turn('Sẵn sàng'),
      { waitUser: 'kể' }, stream('msg_plain', PLAIN, 5, 25), S.result(),
      { waitUser: 'code' }, stream('msg_code', CODE, 4, 45), S.result(),
      { waitUser: 'công cụ' }, ...Array.from({ length: 10 }, (_, i) => bash(i)).flat(), stream('msg_tail', 'Đang tổng hợp kết quả của mười lệnh vừa chạy. '.repeat(6), 2, 60), S.result(),
      { waitUser: 'dài' }, stream('msg_long', LONG, 6, 30), S.result(),
      ...S.startLane(e, 'D2'), ...S.startLane(e, 'D3'),
      { waitUser: 'hẹp' }, edit, editRes, stream('msg_narrow', 'Đã sửa store. '.repeat(20), 3, 40), S.result(),
      { waitUser: 'think' }, { stream: { id: 'msg_think', chunk: 2, everyMs: 60, blocks: [{ thinking: 'nghĩ chậm một chút '.repeat(4) }, { text: 'Done thinking, here is the answer.' }] } },
      ...bash(20, 3), ...bash(21, 3), S.result(),
      { waitUser: 'cắt' }, stream('msg_cut', CUT, 4, 20, { open: true }), S.result(),
      { waitUser: 'tiếp' }, stream('msg_next', NEXT, 2, 50), S.result(),
      { waitUser: 'nghĩ' }, { stream: { id: 'msg_cth', chunk: 2, everyMs: 40, open: true, blocks: [{ thinking: 'đang nghĩ dở '.repeat(6) }] } }, S.result(),
      ...S.idle(),
    ] },
    'lane-D2': { steps: [S.wait, ...task, stream('msg_d2sub', SUB, 4, 20, { parent: 'toolu_task1', open: true }), stream('msg_d2', D2, 3, 40), S.result(), ...S.idle()] },
    'lane-D3': { steps: [S.wait, stream('msg_d3', D3, 3, 40), S.result(), ...S.idle()] },
  }),
  accounts: [ORCH, PM, B2],
});

let pid = '';
const send = (text: string) => eng.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: pid }, text });
const block = (page: Page, key: string) => page.locator(`#inspector [data-vk="${key}"]`);

/** Per frame: the streaming block's text + height; tags its DOM nodes with `data-probe` the first time it shows. */
async function sample(page: Page, key: string): Promise<void> {
  await page.evaluate((k) => {
    const w = window as unknown as { __s: [string, number][]; __stop: boolean };
    w.__s = []; w.__stop = false;
    const tick = () => {
      const n = document.querySelector<HTMLElement>(`#inspector [data-vk="${k}"]`);
      const t = n?.querySelector<HTMLElement>('.m-text');
      if (n && t) {
        if (!n.dataset.probe) { n.dataset.probe = '1'; t.dataset.probe = '1'; }
        w.__s.push([t.querySelector('.md')?.textContent ?? '', n.getBoundingClientRect().height]);
      }
      if (!w.__stop) requestAnimationFrame(tick);
    };
    tick();
  }, key);
}
const samples = (page: Page) => page.evaluate(() => { const w = window as unknown as { __s: [string, number][]; __stop: boolean }; w.__stop = true; return w.__s; });
const dist = (page: Page) => page.locator('#inspector .hist').evaluate(h => h.scrollHeight - h.scrollTop - h.clientHeight);

test.describe.configure({ mode: 'serial' });

test('§14.7 text grows monotonically to exactly the source; the block never shrinks and is never remounted at the swap', async ({ page }) => {
  pid = await eng.addProject('shop');
  await page.goto(eng.url());
  await expect(page.locator('#inspector .ohead')).toBeVisible();
  await sample(page, 'msg_plain:0');
  await send('kể đi');
  await expect(block(page, 'msg_plain:0').locator('.m-copy')).toBeAttached({ timeout: 20_000 }); // the full line took over
  await page.waitForTimeout(300);
  const s = await samples(page);
  expect(s.length).toBeGreaterThan(20);
  expect(s[0]![0].length).toBeLessThan(PLAIN.length); // it really streamed
  for (let i = 1; i < s.length; i++) {
    expect(s[i]![0].startsWith(s[i - 1]![0].trimEnd()), `frame ${i} text`).toBe(true);
    expect(s[i]![1], `frame ${i} height`).toBeGreaterThanOrEqual(s[i - 1]![1] - 0.5);
  }
  expect(s.at(-1)![0]).toBe(PLAIN);
  for (const t of s) expect(PLAIN.startsWith(t[0].trimEnd())).toBe(true);
  // §14.5 no remount: the nodes tagged while streaming are the ones showing the full line
  await expect(block(page, 'msg_plain:0')).toHaveAttribute('data-probe', '1');
  await expect(block(page, 'msg_plain:0').locator('.m-text')).toHaveAttribute('data-probe', '1');
});

test('§14.5 C32 a code block still streaming has a dim "Chép · đang stream"; once closed, "Chép"', async ({ page }) => {
  await page.goto(eng.url());
  await expect(page.locator('#inspector .ohead')).toBeVisible();
  await send('code đi');
  const copy = block(page, 'msg_code:0').locator('.md-copy');
  await expect(copy).toBeDisabled({ timeout: 15_000 });
  await expect(copy).toHaveText('Chép · đang stream');
  await expect(copy).toBeEnabled({ timeout: 15_000 });
  await expect(copy).toHaveText('Chép');
  await expect(block(page, 'msg_code:0').locator('.m-copy')).toBeAttached(); // the whole message copies too
});

test('§14.5 opening a tool row while stuck to the bottom keeps that row\'s top still', async ({ page }) => {
  await page.goto(eng.url());
  await expect(page.locator('#inspector .ohead')).toBeVisible();
  await send('công cụ');
  await expect(block(page, 'msg_tail:0')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => dist(page)).toBeLessThan(2); // stuck
  const row = page.locator('#inspector .tr-row', { hasText: 'case-9' });
  const before = (await row.boundingBox())!.y;
  await row.click();
  await expect(page.locator('#inspector .tr-box')).toBeVisible();
  await page.waitForTimeout(400); // text keeps arriving under it
  expect(Math.abs((await row.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
});

test('§14.5 S6 scrolled up mid-stream: the view stays still, "↓ mới" brings it back to the bottom', async ({ page }) => {
  await page.goto(eng.url());
  await expect(page.locator('#inspector .ohead')).toBeVisible();
  await send('dài');
  const live = block(page, 'msg_long:0');
  await expect(live).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.locator('#inspector .hist').evaluate(h => h.scrollHeight > h.clientHeight + 200), { timeout: 15_000 }).toBe(true);
  await page.locator('#inspector .hist').hover();
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(200);
  const hist = page.locator('#inspector .hist');
  const top = await hist.evaluate(h => h.scrollTop), len = (await live.innerText()).length;
  await page.waitForTimeout(800);
  expect((await live.innerText()).length).toBeGreaterThan(len); // text did arrive meanwhile
  expect(await hist.evaluate(h => h.scrollTop)).toBe(top);
  await expect(page.locator('#inspector .hist-new')).toHaveText(/^↓ (\d+ dòng )?mới$/); // F-M9: the count when rows arrived
  // F-I7 S1: the Điều phối title is never clipped (the head row no longer carries "Ẩn công cụ")
  expect(await page.locator('#inspector .ohead .oname').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await page.locator('#inspector .hist-new').click();
  await expect.poll(() => dist(page)).toBeLessThan(2);
});

test('§14.5 S8 two lanes stream at once and a sub streams under D2: each surface shows only its own text', async ({ page }) => {
  await page.goto(eng.url());
  await eng.openLane(pid, 'D2', 'running');
  await eng.openLane(pid, 'D3', 'running');
  await page.locator('.react-flow__node[data-id="lane:D2"] .hit').click();
  const insp = page.locator('#inspector');
  await expect(block(page, 'msg_d2:0')).toContainText('D2 nói', { timeout: 15_000 });
  await expect(insp).not.toContainText('D3 nói');
  await expect(insp).not.toContainText('SUBTEXT');
  await page.locator('.react-flow__node[data-id="lane:D3"] .hit').click();
  await expect(block(page, 'msg_d3:0')).toContainText('D3 nói', { timeout: 15_000 });
  await expect(insp).not.toContainText('D2 nói');
  await expect(insp).not.toContainText('SUBTEXT');
  await page.locator('.react-flow__node[data-id="sub:D2:sa_d2"] .hit').click(); // the sub's own Đang xem shows its text
  await expect(insp).toHaveClass(/k-sub/);
  await expect(insp).toContainText('SUBTEXT', { timeout: 15_000 });
  await expect(insp).not.toContainText('D2 nói');
});

test('§14.6 S4-narrow 1024 × 640 drawer: the stream fits, `+n −m` and the state are never cut', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto(eng.url());
  await page.locator('#inboxBtn').click();
  await expect(page.locator('#left')).toHaveCSS('transform', 'none'); // the 180 ms drawer slide is over before any box is read
  await send('hẹp');
  await expect(block(page, 'msg_narrow:0')).toBeVisible({ timeout: 15_000 });
  const insp = (await page.locator('#inspector').boundingBox())!;
  const row = page.locator('#inspector .tr-row', { hasText: 'Edit' });
  for (const part of ['.tr-df', '.tr-st']) {
    const b = (await row.locator(part).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(insp.x + insp.width);
    expect(await row.locator(part).evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  }
  await expect(row.locator('.tr-df')).toHaveText('+3 −2');
  const live = (await block(page, 'msg_narrow:0').boundingBox())!;
  expect(live.x + live.width).toBeLessThanOrEqual(insp.x + insp.width);
});

test('F-I8 S4-narrow: in the 424 px drawer the lane facts fold to one line, the stream keeps the room; a click opens them', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto(eng.url());
  await page.locator('.react-flow__node[data-id="lane:D2"] .hit').click();
  const insp = page.locator('#inspector');
  await expect(insp).toHaveClass(/k-lane/);
  const sum = insp.locator('.kvsum');
  await expect(sum).toHaveAttribute('aria-expanded', 'false');
  await expect(sum).toContainText('Worktree');
  await expect(insp.locator('dl.kv')).toHaveCount(0);
  const folded = (await insp.locator('.hist').boundingBox())!.height;
  await sum.click();
  await expect(insp.locator('dl.kv')).toContainText('Lỗi liên tiếp');
  await expect(sum).toHaveAttribute('aria-expanded', 'true');
  const open = (await insp.locator('.hist').boundingBox())!.height;
  expect(folded - open).toBeGreaterThan(80); // the four fact rows (≈ 3 stream rows) go back to the stream when folded
});

test('§14.6 S7 / S10 / S11 `E2E_LANG=en`: "Thinking…", English tool rows, "Hide tools" leaves "n tools"', async ({ page }) => {
  await eng.cmd({ cmd: 'config_update', patch: { ui: { lang: 'en' } } });
  await page.goto(eng.url());
  await expect(page.locator('#inspector .ohead .hidetools')).toContainText('Hide tools');
  await send('think');
  await expect(page.locator('#inspector .m-think')).toContainText('Thinking…', { timeout: 15_000 });
  await expect(block(page, 'msg_think:1')).toContainText('Done thinking', { timeout: 15_000 });
  await expect(page.locator('#inspector .tr-row', { hasText: 'case-21' })).toBeVisible();
  await page.locator('#inspector .ohead .hidetools input').check();
  await expect(page.locator('#inspector .tr-count').last()).toHaveText('2 tools');
  await page.locator('#inspector .ohead .hidetools input').uncheck();
  await eng.cmd({ cmd: 'config_update', patch: { ui: { lang: 'vi' } } });
});

test('§14.5 / §14.4 a turn cut mid-block: the cut text stays in arrival order, the next answer replaces it, "Đang nghĩ…" goes', async ({ page }) => {
  await page.goto(eng.url());
  await expect(page.locator('#inspector .ohead')).toBeVisible();
  await send('cắt đi');
  const cut = block(page, 'msg_cut:0');
  await expect(cut.locator('.m-copy')).toBeAttached({ timeout: 15_000 }); // ended: no longer streaming
  await send('tiếp đi');
  await expect(block(page, 'msg_next:0')).toBeVisible({ timeout: 15_000 });
  const order = () => page.locator('#inspector [data-vk]').evaluateAll(ns => ns.map(n => (n as HTMLElement).dataset.vk));
  const vks = await order();
  expect(vks.indexOf('msg_cut:0')).toBeGreaterThanOrEqual(0); // still there while the next answer streams…
  expect(vks.indexOf('msg_cut:0')).toBeLessThan(vks.indexOf('msg_next:0')); // …above it, never under it
  await expect(block(page, 'msg_next:0').locator('.m-copy')).toBeAttached({ timeout: 15_000 });
  await expect(cut).toHaveCount(0);
  await send('nghĩ đi');
  await expect(page.locator('#inspector .m-think')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#inspector .m-think')).toHaveCount(0, { timeout: 5_000 }); // the result closes the open thinking block
});
