// v2.7 §4.2-3 IS1 on the real engine: the orchestrator writes an issue outside every spec and opens a lane on it
// (`issue_create` + `lane_start {issue}`); the lane node carries the grey "T-1" chip and the issue title as line 2; a click on
// the chip switches to Tasks with that issue open (its group Ngoài spec chosen, the T-1 detail drawn).
import { expect, ORCH, S, test, useEngine } from '../fixtures.ts';

test.use({ tasksStart: true });
const TITLE = 'Daemon CBM không tắt khi đóng app';
const eng = useEngine({
  scenarios: e => ({
    [ORCH]: { steps: [
      { waitUser: 'mở D2' }, S.mcp('issue_create', { title: TITLE, spec: null }),
      { mcp: { tool: 'lane_start', args: { name: 'D2', cwd: e.wt('D2'), brief_path: '/briefs/D2.md', issue: 'T-1' } } },
      S.result('đã mở D2'), ...S.idle(),
    ] },
    'lane-D2': { steps: [S.wait, ...S.idle()] },
  }),
});

test('§4.2-3 IS1 the lane chip T-1 + the issue title as line 2; a click opens Tasks on that issue', async ({ page }) => {
  const pid = await eng.addProject('shop');
  await page.goto(eng.url());
  await page.locator('.dhead [role=tab]', { hasText: 'Deck' }).click();
  await eng.openLane(pid, 'D2');
  await expect.poll(async () => (await eng.snapshot()).issues?.[0]?.issues.find(i => i.key === 'T-1')?.state, { timeout: 20_000 }).toBe('doing');
  const lane = page.locator('.react-flow__node[data-id="lane:D2"]');
  const chip = lane.getByRole('button', { name: 'Mở T-1 ở Tasks' });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('T-1');
  await expect(lane).toContainText(TITLE);
  await chip.click();
  await expect(page.locator('.dhead [role=tab]').filter({ hasText: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tasks')).toBeVisible();
  // the tab shows the issue's group (Ngoài spec) with the T-1 row picked and its detail open
  const tasks = page.locator('#tasks');
  const detail = tasks.getByRole('complementary', { name: 'Chi tiết' });
  await expect(detail.locator('.dmeta .k')).toHaveText('T-1');
  await expect(detail.locator('h3')).toHaveText(TITLE);
  await expect(tasks.locator('.lhead')).toContainText('Ngoài spec');
  await expect(tasks.locator('.lrow[data-key="T-1"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#left')).toBeHidden();
});
