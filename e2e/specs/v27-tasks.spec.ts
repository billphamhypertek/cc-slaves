// v2.7 §4.1 the Tasks mode on the real engine (D76, D88, D91): the app opens in Tasks, key T, tab order Tasks · Deck · Code ·
// Git, no left column in Tasks while the Deck keeps it; R-B12 opening the tab sends `spec_scan` (a spec file written after the
// first open shows up when the tab opens again). G4a §4.3: Ngoài spec → issue → detail, §5.6 Cho làm + seen on leave, §6 IS10
// narrow (rail → menu, detail → overlay, Esc closes). G4b §4.4 the Huỷ popover in its three states (todo / doing / done, numbers
// from `issue_cancel_preview`) and §4.7 Bắt đầu build → Deck on the new Build session, inside the Mac app (stubbed `window.__TAURI__`).
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, msUntil, ORCH, S, test, useEngine, type E2eEngine } from '../fixtures.ts';

test.use({ tasksStart: true });
const laneWith = (e: E2eEngine, name: string, key: string) => [
  { waitUser: `mở ${name}` }, S.mcp('lane_start', { name, cwd: e.wt(name), brief_path: `/briefs/${name}.md`, issue: key }), S.result(`đã mở ${name}`),
];
// "tạo việc" → the Chung session files one bug from the PO's words (seen) and two items of its own (unseen); "mở D2" / "mở D3"
// then hand T-2 to lane D2 (doing) and T-3 to lane D3, which reports it done (the G4b project only)
const eng = useEngine({
  scenarios: (e) => ({
    [ORCH]: { steps: [
      { waitUser: 'tạo việc' },
      S.mcp('issue_create', { title: 'Âm báo kêu hai lần khi lane xong', kind: 'bug', spec: null, source: 'po', body: 'Kêu **hai lần**.', done_when: ['Chỉ kêu một lần'] }),
      S.mcp('issue_create', { title: 'Đo lại thời gian khởi động', spec: null }),
      S.mcp('issue_create', { title: 'Viết lại README', spec: null }),
      S.result('đã tạo'), ...laneWith(e, 'D2', 'T-2'), ...laneWith(e, 'D3', 'T-3'), ...S.idle()] },
    'lane-D3': { steps: [S.wait, S.mcp('issue_done', { key: 'T-3', summary: 'xong' }), S.result(), ...S.idle()] },
  }),
});

test('§4.1 opens in Tasks; T / D switch; tab order; the left column only on the Deck; R-B12 spec_scan on open', async ({ page }) => {
  await eng.addProject('shop');
  await page.goto(eng.url());
  const tabs = page.locator('.dhead [role=tab]');
  const tasks = page.locator('#tasks');
  await expect(tasks).toBeVisible();
  await expect(tabs).toHaveText([/Tasks/, /Deck/, /Code/, /Git/]);
  await expect(tabs.filter({ hasText: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#left')).toBeHidden();
  await expect(tasks).toContainText('Chưa có việc.');
  await expect(tasks.locator('.tstart dl')).toContainText('Quy trình'); // IS8 concept B: the pack chip under its label

  // a spec lands in the repo while Tasks is open: nothing changes until the tab opens again
  mkdirSync(join(eng.repo('shop'), 'docs/specs'), { recursive: true });
  writeFileSync(join(eng.repo('shop'), 'docs/specs/v1-shop.md'), `# v1 shop\n\n**Status:** approved\n\n${'Nội dung spec để engine nhận vào. '.repeat(12)}\n`);

  await page.keyboard.press('d');
  await expect(tabs.filter({ hasText: 'Deck' })).toHaveAttribute('aria-selected', 'true');
  await expect(tasks).toBeHidden();
  await expect(page.locator('#left')).toBeVisible();
  await expect(page.getByLabel('Ô lệnh')).toBeVisible();

  await page.keyboard.press('t');
  await expect(tasks).toBeVisible();
  await expect(page.locator('#left')).toBeHidden();
  await expect(tasks.getByRole('complementary', { name: 'Spec theo vòng đời' })).toBeVisible();
  await expect(tasks).not.toContainText('Chưa có việc.');
});

test('§4.3 Ngoài spec → issue → detail; §5.6 Cho làm, seen on leave; §6 IS10 narrow: menu + overlay', async ({ page }) => {
  if (!(await eng.snapshot()).projects.some(p => p.name === 'shop')) await eng.addProject('shop');
  await page.goto(eng.url());
  const tasks = page.locator('#tasks');
  await expect(tasks).toBeVisible();
  await page.keyboard.press('d');
  const input = page.getByLabel('Ô lệnh');
  await input.click();
  await input.fill('tạo việc');
  await input.press('Enter');
  await page.keyboard.press('Escape');
  await page.locator('.dhead [role=tab]', { hasText: 'Tasks' }).click();

  const rail = tasks.getByRole('complementary', { name: 'Spec theo vòng đời' });
  await rail.getByRole('button', { name: 'Bug & việc lẻ' }).click();
  const list = tasks.getByRole('region', { name: 'Danh sách việc' });
  await expect(list.locator('.lrow')).toHaveCount(3);
  await expect(list).toContainText('Ngoài spec');
  await expect(list.locator('.lrow .up')).toHaveCount(0); // §4.3 no ↑ in Ngoài spec
  await expect(page.locator('.dhead .od')).toBeVisible(); // unseen issues

  // §5.6 R19 seen when the PO leaves an issue he opened, not when it opens
  const measure = list.locator('.lrow', { hasText: 'Đo lại thời gian' });
  await measure.click();
  const detail = tasks.getByRole('complementary', { name: 'Chi tiết' });
  await expect(detail.locator('h3')).toHaveText('Đo lại thời gian khởi động');
  await expect(detail.getByRole('button', { name: 'Cho làm' })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(measure.locator('.tsi.new')).toHaveCount(1); // still unseen while open
  await list.locator('.lrow', { hasText: 'Âm báo kêu hai lần' }).click();
  await expect(measure.locator('.tsi.new')).toHaveCount(0); // left → seen
  await expect(detail.locator('h3')).toHaveText('Âm báo kêu hai lần khi lane xong');
  await expect(detail).toContainText('Anh báo lúc');
  await expect(detail.locator('.dmd strong')).toHaveText('hai lần'); // Nội dung through the Markdown renderer
  await expect(detail.getByRole('button', { name: 'Cho làm' })).toHaveCount(0); // the PO's own bug

  // §5.6 Cho làm → seen at once (the last unseen: the dot goes)
  await list.locator('.lrow', { hasText: 'Viết lại README' }).click();
  await detail.getByRole('button', { name: 'Cho làm' }).click();
  await expect(detail.getByRole('button', { name: 'Cho làm' })).toHaveCount(0);
  await expect(page.locator('.dhead .od')).toHaveCount(0);
  await expect(detail).toContainText('PO cho làm');

  // §6 IS10 narrow: no rail, the spec menu in the list head, the detail an overlay that Esc closes
  await page.setViewportSize({ width: 1024, height: 700 });
  await expect(rail).toHaveCount(0);
  await expect(detail).toHaveClass(/ov/);
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await list.locator('.lspec').click();
  await expect(list.getByRole('menu')).toContainText('Bug & việc lẻ');
});

test.describe('G4b §4.4 Huỷ popover · §4.7 Bắt đầu build → Deck (Mac app)', () => {
  const invoked: string[] = [];
  /** the Mac app: `window.__TAURI__.core.invoke` answers nothing and records the command names */
  const stubTauri = async (page: Page) => {
    await page.exposeFunction('__ccInvoked', (cmd: string) => { invoked.push(cmd); });
    await page.addInitScript(() => {
      const w = window as unknown as { __TAURI__: unknown; __ccInvoked: (c: string) => void };
      w.__TAURI__ = { core: { invoke: (cmd: string) => { w.__ccInvoked(cmd); return Promise.resolve(null); } } };
    });
  };
  /** the Tasks commands the page sends, as `cmd` or `cmd:key` */
  const recordSent = (page: Page) => {
    const sent: string[] = [];
    page.on('websocket', ws => ws.on('framesent', f => {
      const c = (JSON.parse(String(f.payload)) as { command?: { cmd: string; key?: string } }).command;
      if (c) sent.push(c.key ? `${c.cmd}:${c.key}` : c.cmd);
    }));
    return sent;
  };
  const issuesOf = async (pid: string) => (await eng.snapshot()).issues?.find(x => x.projectId === pid);
  /** open `key` in Tasks of `pid` straight from the saved Tasks choice */
  const openIssue = async (page: Page, pid: string, key: string) => {
    await page.evaluate(a => localStorage.setItem('ccs.tasks', JSON.stringify({ [a.pid]: { sel: 'outside', issue: a.key } })), { pid, key });
    await page.reload();
    await page.locator('nav.tabs .tab', { hasText: 'app' }).click(); // several projects are open
  };

  test('three states (B-1 todo · T-2 doing · T-3 done): todo "Chưa có code." · doing stops the lane · done makes a revert issue; Thôi is focused, Esc closes; NEW-1 a confirm sends no second preview and no toast', async ({ page }) => {
    await stubTauri(page);
    const sent = recordSent(page);
    const pid = await eng.addProject('app');
    for (const n of ['D2', 'D3']) mkdirSync(eng.wt(n), { recursive: true });
    await eng.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: pid }, text: 'tạo việc' });
    await expect.poll(async () => (await issuesOf(pid))?.issues.length, { timeout: 20_000 }).toBe(3);
    for (const n of ['D2', 'D3']) await eng.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: pid }, text: `mở ${n}` });
    await expect.poll(async () => (await issuesOf(pid))?.issues.map(i => `${i.key}:${i.state}`).sort(), { timeout: 20_000 })
      .toEqual(['B-1:todo', 'T-2:doing', 'T-3:done']);
    await page.goto(eng.url());
    const pop = page.getByRole('dialog', { name: 'Huỷ mục' });

    await openIssue(page, pid, 'B-1');
    await page.locator('.dtop .dcx').click();
    await expect(pop).toContainText('Huỷ B-1?');
    await expect(pop).toContainText('Chưa có code.');
    await expect(pop.getByRole('button', { name: 'Thôi' })).toBeFocused();
    await expect(pop.getByRole('button', { name: 'Huỷ mục' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await expect(page.locator('#tasks')).toBeVisible(); // Esc stayed in Tasks

    await openIssue(page, pid, 'T-2');
    await page.locator('.dtop .dcx').click();
    await expect(pop).toContainText('Huỷ T-2 đang làm?');
    await expect(pop).toContainText('Dừng lane D2 ngay');
    await expect(pop).toContainText('Chưa có commit — không cần hoàn tác');
    await pop.getByRole('button', { name: 'Thôi' }).click();
    await expect(pop).toBeHidden();

    await openIssue(page, pid, 'T-3');
    await page.locator('.dtop .dcx').click();
    await expect(pop).toContainText('Huỷ T-3 đã xong?');
    await expect(pop).toContainText('"Hoàn tác T-3"');
    await pop.getByLabel('Lý do (không bắt buộc)').fill('không cần nữa');
    await pop.getByRole('button', { name: 'Huỷ và hoàn tác' }).click();
    await expect(pop).toBeHidden();
    await expect.poll(async () => (await issuesOf(pid))?.issues.find(i => i.key === 'T-3')?.revert, { timeout: 20_000 }).not.toBe('none');
    await expect(page.locator('.dtop .dcx')).toBeHidden(); // the cancel's own issue_changed reached the page (revert open → no Huỷ)
    expect(sent.filter(x => x === 'issue_cancel_preview:T-3')).toHaveLength(1);
    await expect(page.locator('#toasts .toast')).toHaveCount(0);

    await openIssue(page, pid, 'B-1'); // NEW-1 the todo case: "Huỷ mục" → the issue is cancelled, its preview is not asked again
    await page.locator('.dtop .dcx').click();
    await pop.getByRole('button', { name: 'Huỷ mục' }).click();
    await expect(pop).toBeHidden();
    await expect.poll(async () => (await issuesOf(pid))?.issues.find(i => i.key === 'B-1')?.state, { timeout: 20_000 }).toBe('cancelled');
    await expect(page.locator('.dtop .dcx')).toBeHidden();
    expect(sent.filter(x => x === 'issue_cancel_preview:B-1')).toHaveLength(2); // the Esc'd open + this one
    await expect(page.locator('#toasts .toast')).toHaveCount(0);
  });

  test('Bắt đầu build → Deck on the new Build session; R-B19 a double-click sends one spec_build and no refusal toast', async ({ page }) => {
    await stubTauri(page);
    const sent = recordSent(page);
    const pid = await eng.addProject('web');
    mkdirSync(join(eng.repo('web'), 'docs/specs'), { recursive: true });
    writeFileSync(join(eng.repo('web'), 'docs/specs/v1-web.md'), `# v1 web\n\n**Status:** approved\n\n${'Nội dung spec để engine nhận vào. '.repeat(12)}\n`);
    await eng.cmd({ cmd: 'spec_scan', projectId: pid });
    const spec = (await issuesOf(pid))?.specs.find(s => s.path === 'docs/specs/v1-web.md');
    expect(spec?.state).toBe('approved');
    await page.addInitScript(([pid, id]) => localStorage.setItem('ccs.tasks', JSON.stringify({ [pid]: { sel: { spec: id }, issue: null } })), [pid, spec!.id] as const);
    await page.goto(eng.url());
    await page.locator('nav.tabs .tab', { hasText: 'web' }).click();
    const before = (await eng.snapshot()).orchestrators.filter(o => o.projectId === pid).map(o => o.sessionId);
    await page.getByRole('article', { name: 'v1 web' }).getByRole('button', { name: 'Bắt đầu build', exact: true }).dblclick(); // the card's main part (the rail has one too)
    await expect(page.locator('.dhead [role=tab]', { hasText: 'Deck' })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await eng.snapshot()).orchestrators.filter(o => o.projectId === pid && !before.includes(o.sessionId)).length).toBe(1);
    await expect(page.locator('#inspector')).toContainText('Build spec docs/specs/v1-web.md');
    expect(sent.filter(c => c === 'spec_build')).toHaveLength(1);
    expect(await page.locator('#toasts .toast').count()).toBe(0); // counted once: a toast fades
    expect(invoked).not.toContain('open_doc'); // no doc was opened on the way
  });

  test('§13 / review-spec MINOR-1 "+ Spec mới" → Deck on the new "Thiết kế · HH:MM" session, selected, composer focused', async ({ page }) => {
    const sent = recordSent(page);
    const pid = await eng.addProject('idea');
    await page.goto(eng.url());
    await page.locator('nav.tabs .tab', { hasText: 'idea' }).click();
    const before = (await eng.snapshot()).orchestrators.filter(o => o.projectId === pid).map(o => o.sessionId);
    await page.locator('#tasks').getByRole('button', { name: 'Spec mới', exact: true }).click(); // a project with no spec: the empty state's main part
    await expect(page.locator('.dhead [role=tab]', { hasText: 'Deck' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#tasks')).toBeHidden();
    await expect(page.locator('.react-flow')).toBeVisible(); // the Deck scene
    await expect.poll(async () => (await eng.snapshot()).orchestrators.filter(o => o.projectId === pid && !before.includes(o.sessionId)).length).toBe(1);
    const fresh = (await eng.snapshot()).orchestrators.find(o => o.projectId === pid && !before.includes(o.sessionId))!;
    expect(fresh.orchKind).toBe('design');
    expect(fresh.title).toMatch(/^Thiết kế · \d\d:\d\d$/);
    await expect(page.locator('.react-flow__node .nd.orch.sel')).toContainText(fresh.title!); // the new node is the selected one
    await expect(page.locator('#inspector')).toContainText(fresh.title!);
    await expect(page.locator('#inspector textarea')).toBeFocused();
    expect(sent.filter(c => c === 'spec_new')).toHaveLength(1);
  });

  // hf1117-perf (PO 17/11 "click Thêm Spec thấy loading khá lâu rồi mới chuyển sang Deck") as v2.7.1 §4.1 SA3 has it: with a
  // 3 s claude boot every Tasks start (the split button's main part) shows the step list within 100 ms, naming what runs; the
  // Deck takes over on the new, selected session once it booted (step 4). Every ack is held ACK_HOLD ms in the page
  // (review MINOR-1). "Mở phiên song song" (Deck, v2.4) shows the same step list (L14).
  test('hf1117-perf + v2.7.1 SA3 slow boot: + Spec mới / Bắt đầu build / Bổ sung yêu cầu / Nhận phiên này / Mở phiên song song → the step list ≤ 100 ms, Deck on the booted session', async ({ page }) => {
    test.setTimeout(120_000);
    const ACK_HOLD = 200;
    const pid = await eng.addProject('slow');
    await eng.addProject('par');
    const outPid = await eng.addProject('out'); // its own project: the R34 cap counts the ones in slow
    mkdirSync(join(eng.repo('slow'), 'docs/specs'), { recursive: true });
    writeFileSync(join(eng.repo('slow'), 'docs/specs/v1-slow.md'), `# v1 slow\n\n**Status:** approved\n\n${'Nội dung spec để engine nhận vào. '.repeat(12)}\n`);
    await eng.cmd({ cmd: 'spec_scan', projectId: pid });
    // §5.2-10 a spec built outside cc-slaves + one prior Claude session that named it → "Tiếp tục build" → "Nhận phiên này"
    mkdirSync(join(eng.repo('out'), 'docs/specs'), { recursive: true });
    writeFileSync(join(eng.repo('out'), 'docs/specs/v1-out.md'), `# v1 out\n\n**Status:** đang build\n\n${'Nội dung spec để engine nhận vào. '.repeat(12)}\n`);
    const outRoot = (await eng.snapshot()).projects.find(p => p.id === outPid)!.path;
    const tdir = join(eng.file('claude'), 'projects', outRoot.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(tdir, { recursive: true });
    const tfile = join(tdir, 'prior-1.jsonl');
    writeFileSync(tfile, `${JSON.stringify({ type: 'user', cwd: outRoot, sessionId: 'prior-1', message: { role: 'user', content: 'build docs/specs/v1-out.md giúp anh' } })}\n`);
    const old = (Date.now() - 600_000) / 1000;
    utimesSync(tfile, old, old);
    await eng.cmd({ cmd: 'spec_scan', projectId: outPid });
    await page.routeWebSocket(/\/ws\?/, ws => {
      const server = ws.connectToServer();
      ws.onMessage(m => server.send(m));
      server.onMessage(m => {
        if ((JSON.parse(String(m)) as { type: string }).type === 'ack') setTimeout(() => ws.send(m), ACK_HOLD);
        else ws.send(m);
      });
    });
    eng.slowBoot(3000);
    try {
      await page.goto(eng.url());
      await page.locator('nav.tabs .tab', { hasText: 'slow' }).click();
      const tasksTab = page.locator('.dhead [role=tab]', { hasText: 'Tasks' });
      const steps = `!!document.querySelector('[role=dialog] .ssteps')`; // SA3 the step list
      const check = async (what: string, act: () => Promise<unknown>, inProject = pid) => {
        const before = (await eng.snapshot()).orchestrators.map(o => o.sessionId);
        const t = await msUntil(page, act, { steps });
        expect(t.steps, `${what} step list ms`).toBeLessThan(100);
        await expect.poll(async () => (await eng.snapshot()).orchestrators.find(o => o.projectId === inProject && !before.includes(o.sessionId))?.state).toBe('starting');
        await expect(page.getByRole('dialog').locator('.sst').nth(1)).toContainText('Khởi động Claude'); // step 2 names the boot
        const fresh = (await eng.snapshot()).orchestrators.find(o => o.projectId === inProject && !before.includes(o.sessionId))!;
        await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 }); // step 4: booted → the Deck takes over
        await expect(page.locator('.dhead [role=tab]', { hasText: 'Deck' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#inspector .ohead')).toContainText(fresh.title!.slice(0, 10)); // the new session is the selected one (title clipped)
        await expect(page.locator('#inspector .ohead')).not.toContainText('Đang khởi động');
        await expect(page.locator('#inspector textarea')).toBeFocused();
      };
      await check('+ Spec mới', () => page.locator('#tasks .snew').click());
      await tasksTab.click();
      await check('Bắt đầu build', () => page.getByRole('article', { name: 'v1 slow' }).getByRole('button', { name: 'Bắt đầu build', exact: true }).click());
      await tasksTab.click();
      await page.getByRole('complementary', { name: 'Spec theo vòng đời' }).getByText('v1 slow').first().click();
      await check('Bổ sung yêu cầu', () => page.locator('#tasks').getByRole('button', { name: 'Bổ sung yêu cầu', exact: true }).first().click());
      await page.locator('nav.tabs .tab', { hasText: 'out' }).click();
      await tasksTab.click();
      await page.getByRole('complementary', { name: 'Spec theo vòng đời' }).getByText('v1 out').first().click();
      await page.getByRole('article', { name: 'v1 out' }).getByRole('button', { name: 'Tiếp tục build' }).click();
      const take = page.getByRole('dialog', { name: 'Tiếp tục build' }).getByRole('button', { name: 'Nhận phiên này', exact: true });
      await expect(take).toBeEnabled(); // the prior session is listed and preselected
      await check('Nhận phiên này', () => take.click(), outPid); // the popover's main part
      await page.locator('nav.tabs .tab', { hasText: 'par' }).click(); // its own project: the R34 cap counts the ones above
      await page.locator('.dhead [role=tab]', { hasText: 'Deck' }).click();
      await page.locator('.react-flow__node .nd.orch').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Mở phiên song song…' }).click();
      const go = page.getByRole('dialog').locator('.btn.pri');
      const before = (await eng.snapshot()).orchestrators.length;
      const t = await msUntil(page, () => go.click(), { steps });
      expect(t.steps, 'Mở phiên song song step list ms').toBeLessThan(100);
      await expect.poll(async () => (await eng.snapshot()).orchestrators.length).toBe(before + 1);
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 }); // booted → closes on its own
    } finally { eng.slowBoot(0); }
  });
});
