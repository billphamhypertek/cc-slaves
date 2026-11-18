// v2.3 §11 E2E: T1, T2, T5, T7 at the §3.3 step counts (one real click / key = 1, typing free), the file-tab rules of
// §5.4 (two files from the tree share one preview tab, "Sửa" pins, ⌘W on a ● tab asks first) — on a real engine with a
// real git repo in its temp dir (e2e/v23-repo.ts: lane/d15 conflicts with main, lane/d2 merges clean) and fake-claude.
// §8: no Code / Git command passes the remote channel (dev mock `remote=1`, the remote path the v2.x specs use — the
// engine itself has no remote listener until v3).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, WebSocket as PwSocket } from '@playwright/test';
import { ORCH, PM, S, expect, recordBudget, test, useEngine } from '../fixtures.ts';
import { useDev } from '../deck.ts';
import { node } from '../v21-seed.ts';
import { hagentaRepo } from '../v23-repo.ts';

/** Counts the §3.3 steps: every click and every key press is one step; typing is free. */
class Steps {
  n = 0;
  constructor(private readonly page: Page) {}
  async click(l: ReturnType<Page['locator']>): Promise<void> { this.n++; await l.click(); }
  async key(k: string): Promise<void> { this.n++; await this.page.keyboard.press(k); }
}
/** Every command the page sends over its engine socket. */
type Sent = { cmd: string; target?: { kind: string; name?: string } };
function sentCommands(page: Page): Sent[] {
  const out: Sent[] = [];
  page.on('websocket', (ws: PwSocket) => ws.on('framesent', (f) => {
    try { const m = JSON.parse(String(f.payload)) as { type?: string; command?: Sent }; if (m.type === 'command' && m.command) out.push(m.command); } catch { /* not JSON */ }
  }));
  return out;
}
const lit = (page: Page, id: string) => node(page, id).locator('button.hit');
const tabs = (page: Page) => page.locator('#codeview .ctabs [role=tab]');
const inEditor = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('#codeview .cm-editor'));
const treeRow = (page: Page, path: string) => page.locator(`#codeview .ctree [data-path="${path}"]`);

test.describe('§11 E2E Code + Git on a real repo', () => {
  const eng = useEngine({ scenarios: (e) => ({ [ORCH]: { steps: [...S.startLane(e, 'D15'), ...S.startLane(e, 'D2'), ...S.idle()] } }) });
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    hagentaRepo(eng);
    const pid = await eng.addProject('hagenta');
    await eng.openLane(pid, 'D15');
    await eng.openLane(pid, 'D2');
  });

  test('§3.3 T1 ⌘P: node D15 → ⌘P → Enter = 3, the lane spec opens in "Đọc" in the preview tab', async ({ page }) => {
    await page.goto(eng.url());
    const st = new Steps(page);
    await st.click(lit(page, 'lane:D15'));
    await st.key('Meta+p');
    const find = page.getByRole('dialog', { name: 'Tìm file' });
    await expect(find).toContainText('Đang tìm trong worktree D15');
    await find.getByRole('textbox').fill('auth-design');
    await expect(find.getByRole('option').first()).toContainText('2026-11-16-auth-design.md');
    await st.key('Enter');
    await expect(page.locator('#codeview .cvh .pth')).toHaveText('docs/specs/2026-11-16-auth-design.md');
    await expect(page.getByRole('button', { name: 'Đọc', pressed: true })).toBeVisible();
    await expect(page.locator('#codeview h1')).toHaveText('Auth: token rỗng và khoá xoay vòng');
    await expect(tabs(page)).toHaveCount(1);
    await expect(tabs(page).first()).toHaveClass(/\bpv\b/);
    expect(st.n).toBe(3);
    recordBudget('v2.3 T1 ⌘P (bấm + phím)', st.n, 3);
  });

  test('§3.3 T1 tree, first time: node → C → docs → specs → file = 5 (V21 accepted over 3)', async ({ page }) => {
    await page.goto(eng.url());
    const st = new Steps(page);
    await st.click(lit(page, 'lane:D15'));
    await st.key('c');
    await expect(page.locator('#codeview .csrcw')).toContainText('D15 · worktree');
    await st.click(treeRow(page, 'docs'));
    await st.click(treeRow(page, 'docs/specs'));
    await st.click(treeRow(page, 'docs/specs/2026-11-16-auth-design.md'));
    await expect(page.locator('#codeview h1')).toHaveText('Auth: token rỗng và khoá xoay vòng');
    expect(st.n).toBe(5);
    recordBudget('v2.3 T1 cây lần đầu (bấm + phím)', st.n, 5);
  });

  test('§5.4 two files from the tree share the preview tab; "Sửa" pins; §3.3 T7 Sửa → ⌘S = 2; ⌘W on a ● tab asks', async ({ page }) => {
    await page.goto(eng.url());
    await page.locator('.react-flow__node[data-id^="orch:"] button.hit').first().click();
    await page.keyboard.press('c');
    await expect(page.locator('#codeview .csrcw')).toContainText('thư mục project');
    await treeRow(page, 'engine').click();
    await treeRow(page, 'engine/src').click();
    await treeRow(page, 'engine/src/auth.ts').click();
    await expect(tabs(page)).toHaveCount(1);
    await expect(tabs(page).first()).toHaveClass(/\bpv\b/);
    await expect(tabs(page).first()).toContainText('auth.ts');
    // v2.4 §6.7 D53: Code sits under the two bars (calc of --h-bar + --h-head), tabs --h-ctl (30 since hf1116 W4, was 28), the tab "×" 24 × 24 (M2)
    expect(Math.round((await page.locator('#codeview').boundingBox())!.y)).toBe(44 + 28);
    expect(Math.round((await page.locator('#codeview .ctabs').boundingBox())!.height)).toBe(30);
    const x = (await tabs(page).first().locator('.x').boundingBox())!;
    expect([Math.round(x.width), Math.round(x.height)]).toEqual([24, 24]);
    await treeRow(page, 'engine/src/config.ts').click();
    await expect(tabs(page)).toHaveCount(1); // the preview tab was replaced, not added to
    await expect(tabs(page).first()).toContainText('config.ts');
    await expect(page.locator('#codeview .cvh .pth')).toHaveText('engine/src/config.ts');

    // T7 (file open, folder editable — the orchestrator is idle): the cursor is placed in read mode first (V13: +1 if not)
    await page.locator('#codeview .cm-line').first().click();
    await page.keyboard.press('End');
    const st = new Steps(page);
    await st.click(page.getByRole('button', { name: 'Sửa', exact: true }));
    await expect(tabs(page).first()).not.toHaveClass(/\bpv\b/); // "Sửa" pins
    await expect(page.locator('#codeview .cvh .edp')).toHaveText('Đang sửa');
    await expect.poll(() => inEditor(page)).toBe(true); // "Sửa" put the focus in the text (T7: no extra click)
    await page.keyboard.type(' // e2e');
    await st.key('Meta+s');
    await expect(page.locator('#codeview .vf')).toContainText('Đã lưu');
    expect(readFileSync(join(eng.repo('hagenta'), 'engine/src/config.ts'), 'utf8')).toBe('export const PORT = 4318 // e2e\n');
    expect(st.n).toBe(2);
    recordBudget('v2.3 T7 Sửa → ⌘S (bấm + phím, con trỏ đã đặt)', st.n, 2);

    // ⌘W on a tab with unsaved text (●) → the C27 dialog, the tab stays
    await page.getByRole('button', { name: 'Sửa', exact: true }).click();
    await expect(page.locator('#codeview .cvh .edp')).toBeVisible();
    await expect.poll(() => inEditor(page)).toBe(true);
    await page.keyboard.type('abc');
    await expect(tabs(page).first().locator('button.x.dt')).toBeVisible();
    await page.keyboard.press('Meta+w');
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('Bỏ thay đổi chưa lưu?');
    await expect(dlg).toContainText('Đóng tab sẽ bỏ thay đổi này.');
    await expect(tabs(page)).toHaveCount(1);
    await dlg.getByRole('button', { name: 'Bỏ', exact: true }).click();
    await expect(tabs(page)).toHaveCount(0);
    expect(readFileSync(join(eng.repo('hagenta'), 'engine/src/config.ts'), 'utf8')).toBe('export const PORT = 4318 // e2e\n');
  });

  test('§3.3 T2 node D15 → G = 2, the conflict file is picked; another file + 1 = 3', async ({ page }) => {
    await page.goto(eng.url());
    const st = new Steps(page);
    await st.click(lit(page, 'lane:D15'));
    await st.key('g');
    await expect(page.locator('#gitview .gbrow.sel')).toContainText('lane/d15');
    await expect(page.locator('#gitview .gbrow.sel')).toContainText('1 xung đột');
    await expect(page.locator('#gitview .gfr.sel')).toContainText('lanes.ts');
    await expect(page.locator('#gitview .gvh .gpth')).toHaveText('engine/src/lanes.ts');
    await expect(page.locator('#gitview .gvh')).toContainText('Xung đột khi merge');
    expect(st.n).toBe(2);
    recordBudget('v2.3 T2 xem lane đổi gì (bấm + phím)', st.n, 2);
    await st.click(page.locator('#gitview .gfr', { hasText: 'auth.ts' }));
    await expect(page.locator('#gitview .gvh .gpth')).toHaveText('engine/src/auth.ts');
    expect(st.n).toBe(3);
    recordBudget('v2.3 T2 file khác (bấm + phím)', st.n, 3);
  });

  test('§3.3 T5 "Nhờ D15 rebase…" → Enter = 2, the lane gets the prefilled sentence', async ({ page }) => {
    const sent = sentCommands(page);
    await page.goto(eng.url());
    await lit(page, 'lane:D15').click();
    await page.keyboard.press('g');
    await expect(page.locator('#gitview .gfr.sel')).toContainText('lanes.ts');
    const st = new Steps(page);
    await st.click(page.getByRole('button', { name: 'Nhờ D15 rebase…' }));
    const input = page.getByLabel('Ô lệnh');
    await expect(input).toHaveValue('Rebase lane/d15 lên main rồi giải xung đột ở engine/src/lanes.ts; chạy lại test liên quan.');
    await expect(input).toBeFocused();
    await st.key('Enter');
    await expect.poll(() => sent.filter((c) => c.cmd === 'send').length).toBe(1);
    expect(sent.find((c) => c.cmd === 'send')).toMatchObject({ target: { kind: 'lane', name: 'D15' } });
    await expect.poll(() => eng.read(`stdin-${PM}.log`)).toContain('Rebase lane/d15 lên main');
    expect(st.n).toBe(2);
    recordBudget('v2.3 T5 nhờ lane rebase (bấm + phím)', st.n, 2);
  });

  test('§3.3 T5 / G13 "Nhờ Điều phối merge…" while D2 is picked → Enter = 2; send targets the orchestrator, Git stays on lane/d2', async ({ page }) => {
    const sent = sentCommands(page);
    await page.goto(eng.url());
    await lit(page, 'lane:D2').click();
    await page.keyboard.press('g');
    await expect(page.locator('#gitview .gbrow.sel')).toContainText('lane/d2');
    await expect(page.locator('#gitview .gbrow.sel')).toContainText('merge sạch');
    const st = new Steps(page);
    await st.click(page.getByRole('button', { name: 'Nhờ Điều phối merge…' }));
    const input = page.getByLabel('Ô lệnh');
    await expect(input).toHaveValue(/^Merge lane\/d2 \(2 commit, 4 file\) vào main sau khi chạy lại gate\./);
    await st.key('Enter');
    await expect.poll(() => sent.filter((c) => c.cmd === 'send').length).toBe(1);
    expect(sent.find((c) => c.cmd === 'send')?.target?.kind).toBe('orchestrator');
    await expect(page.locator('#gitview .gbrow.sel')).toContainText('lane/d2');
    await expect(page.locator('#inspector .crumb')).toContainText('D2');
    await expect.poll(() => eng.read(`stdin-${ORCH}.log`)).toContain('Merge lane/d2 (2 commit, 4 file) vào main');
    expect(st.n).toBe(2);
    recordBudget('v2.3 T5 nhờ Điều phối merge (bấm + phím)', st.n, 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('§8 remote channel: no Code / Git command passes', () => {
  const dev = useDev();
  test('remote: the Code tree and the Git column are refused (forbidden_remote); every v2.3 command sent by hand too', async ({ page }) => {
    const errs: { id: string; code: string }[] = [];
    let wsUrl = '';
    page.on('websocket', (ws) => {
      if (/\/ws\?/.test(ws.url())) wsUrl ||= ws.url();
      ws.on('framereceived', (f) => { try { const m = JSON.parse(String(f.payload)) as { type: string; id: string; code: string }; if (m.type === 'error') errs.push(m); } catch { /* */ } });
    });
    await page.goto(dev.url('F3', 'remote=1'));
    await expect(page.locator('#top .rmt')).toBeVisible();
    await page.keyboard.press('c');
    await expect(page.locator('#codeview .ctree')).toContainText('Không đọc được thư mục');
    await page.keyboard.press('g');
    await expect.poll(() => errs.length).toBeGreaterThan(1);
    expect(errs.every((e) => e.code === 'forbidden_remote')).toBe(true);
    await expect(page.locator('#gitview .gbrow')).toHaveCount(0);

    const src = { kind: 'base' };
    const cmds = [
      { cmd: 'fs_list', projectId: 'hagenta', src, dir: '', showIgnored: false }, { cmd: 'fs_find', projectId: 'hagenta', src, query: 'auth', showIgnored: false },
      { cmd: 'fs_read', projectId: 'hagenta', src, path: 'README.md' },
      { cmd: 'fs_write', projectId: 'hagenta', src, path: 'README.md', text: 'x', eol: 'lf', bom: false, baseHash: 'h' },
      { cmd: 'git_branches', projectId: 'hagenta' }, { cmd: 'git_changes', projectId: 'hagenta', of: { branch: 'lane/d15' } },
      { cmd: 'git_diff', projectId: 'hagenta', path: 'README.md', of: { branch: 'lane/d15' } }, { cmd: 'git_log', projectId: 'hagenta', refs: ['main'], limit: 10 },
      { cmd: 'git_watch', projectId: 'hagenta', on: true }, { cmd: 'open_in_vscode', projectId: 'hagenta', src, path: 'README.md' },
    ];
    const codes = await page.evaluate(async ({ url, cmds }) => new Promise<Record<string, string>>((res) => {
      const ws = new WebSocket(url), out: Record<string, string> = {};
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { type: string; id?: string; code?: string };
        if (msg.type === 'snapshot') cmds.forEach((c, i) => ws.send(JSON.stringify({ type: 'command', id: `r${i}`, command: c })));
        else if (msg.id?.startsWith('r')) { out[cmds[Number(msg.id.slice(1))]!.cmd] = msg.type === 'error' ? msg.code! : msg.type; if (Object.keys(out).length === cmds.length) { ws.close(); res(out); } }
      };
    }), { url: wsUrl, cmds });
    expect(codes).toEqual(Object.fromEntries(cmds.map((c) => [c.cmd, 'forbidden_remote'])));
  });
});
