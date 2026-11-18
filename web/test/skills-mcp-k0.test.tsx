// v2.2 §6 K0 the top-bar "Skills & MCP" button: label + two separate C25 numbers (own icons, own click areas), Mac only.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SkillsMcpView, Snapshot } from '../../shared/protocol.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { TopBar } from '../src/ui/TopBar.tsx';
import { snapshot } from './fixtures.ts';

const view = (red: number, yellow: number): SkillsMcpView => ({
  mcp: { rows: [], servers: 0, forLanes: 0, tools: 0 }, skills: { rows: [], issues: [], plugins: [], descTokens: 0 },
  counts: { mcp: { red, yellow: 0 }, skills: { red: 0, yellow }, shared: { red: 0, yellow: 0 }, total: { red, yellow } },
  claudeJson: { ok: true, line: null, rev: 'r1', path: '/h/.claude.json' }, claude: { found: true, install: '' }, lost: [],
});
const bar = (snap: Snapshot) => renderToStaticMarkup(<LangProvider lang="vi"><TopBar snap={snap} offline={false} projectId="p1" pendingByProject={{}} unread={new Set()} muted={false}
  listOn={false} onProject={() => {}} onAddProject={() => {}} onList={() => {}} onRemote={() => {}} onMute={() => {}} onSettings={() => {}} onSkillsMcp={() => {}} onTabMenu={() => {}} /></LangProvider>);

describe('§6 K0 top-bar button', () => {
  test('§6 K0-b two separate numbers, each its own button with its own icon; hover line from C25', () => {
    const h = bar(snapshot({ skillsMcp: view(2, 4) }));
    expect(h).toMatch(/<button class="smk-l"[^>]*title="Skills &amp; MCP · 2 MCP cần đăng nhập \/ lỗi · 4 skill lỗi"/);
    expect(h).toMatch(/<button[^>]*class="smk-n red"[^>]*aria-label="2 lỗi[^"]*">.*?<svg.*?<\/svg>2<\/button>/);
    expect(h).toMatch(/<button[^>]*class="smk-n yellow"[^>]*aria-label="4 cảnh báo[^"]*">.*?<svg.*?<\/svg>4<\/button>/);
    expect(h).toContain('<span class="smk-t">Skills &amp; MCP</span>');
  });
  test('§6 K0-a no issue (or only "Đã biết") → no number', () => {
    const h = bar(snapshot({ skillsMcp: view(0, 0) }));
    expect(h).toContain('smk-l');
    expect(h).not.toContain('smk-n');
  });
  test('§6 K0 only one level → only that number', () => {
    const h = bar(snapshot({ skillsMcp: view(0, 3) }));
    expect(h).not.toContain('smk-n red');
    expect(h).toContain('smk-n yellow');
  });
  test('§6 D32 no view (remote channel) → no button', () => {
    expect(bar(snapshot({ channel: 'remote' }))).not.toContain('smk');
  });
  test('§6 K0-c F-M1 one native title per number: its level\'s lines + the tab a click opens; none on the group', () => {
    const h = bar(snapshot({ skillsMcp: { ...view(2, 4), counts: { mcp: { red: 2, yellow: 1 }, skills: { red: 0, yellow: 4 }, shared: { red: 0, yellow: 1 }, total: { red: 2, yellow: 6 } } } }));
    expect(h).toMatch(/<button[^>]*class="smk-n red"[^>]*title="2 MCP cần đăng nhập \/ lỗi\nBấm: mở tab MCP"/);
    expect(h).toMatch(/<button[^>]*class="smk-n yellow"[^>]*title="1 MCP cần xem\n4 skill lỗi\n1 account có link chung lỗi\nBấm: mở tab MCP"/);
    expect(h).not.toMatch(/class="smk"[^>]*title=/);
    const y = bar(snapshot({ skillsMcp: view(0, 3) }));
    expect(y).toMatch(/class="smk-n yellow"[^>]*title="3 skill lỗi\nBấm: mở tab Skills"/);
  });
});
