// v2 §6A (D19) T9b: the web screens render English with `ui.lang = en` (RolesTable, caps preview, UnitPanel, chip lines,
// list, console, cards). The Vietnamese output is pinned by the older tests, unchanged.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts';
import { capsPreview, previewText } from '../src/lib/caps.ts';
import { chipLine, fmtCost, fmtLeft, fmtResetLeft } from '../src/lib/format.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import type { RoleRow } from '../src/lib/wizard.ts';
import { RolesTable } from '../src/ui/RolesTable.tsx';
import { createRef } from 'react';
import { Inspector, type InspectorProps } from '../src/ui/Inspector.tsx';
import { MoveAllDialog, StopDialog } from '../src/ui/LaneDialogs.tsx';
import { composerFor, type Selection } from '../src/lib/inspector.ts';
import { ListView } from '../src/ui/ListView.tsx';
import { Boot } from '../src/ui/Screens.tsx';
import { Settings } from '../src/ui/Settings.tsx';
import { account, lane, snapshot } from './fixtures.ts';

const en = makeT('en'), vi = makeT('vi');
const H = 3_600_000, M = 60_000, D = 24 * H;
const html = (el: ReactElement, lang: 'vi' | 'en' = 'en') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
/** visible text only (tags dropped, entities kept simple) */
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('§6A format.ts in en', () => {
  test('§6A durations', () => {
    expect(fmtLeft(4 * D + 16 * H + 5 * M, en)).toBe('4\u00a0d\u00a016\u00a0h');
    expect(fmtLeft(21 * H + 40 * M, en)).toBe('21\u00a0h\u00a040\u00a0min');
    expect(fmtLeft(13 * M, en)).toBe('13\u00a0min');
    expect(fmtLeft(13 * M, vi)).toBe('13\u00a0p');
  });
  test('§6A v2.7.1 reset tooltip = HH:MM dd/mm + time left, in both languages', () => {
    const now = new Date(2026, 10, 14, 21, 47).getTime();
    const at = new Date(2026, 10, 16, 23, 0).getTime();
    expect(fmtResetLeft(at, now, en)).toBe('23:00 16/11 (2\u00a0d left)');
    expect(fmtResetLeft(at, now, vi)).toBe('23:00 16/11 (còn 2\u00a0ngày)');
  });
  test('§6A D21 chip lines', () => {
    expect(chipLine(account('a', { headroomPct: 51 }), 0, en)).toEqual({ kind: 'ok', main: '51% left', rest: '' });
    expect(chipLine(account('a', { full: true, weekResetsAt: 3 * D + 15 * H }), 0, en)).toEqual({ kind: 'full', main: 'FULL', rest: '· resets in 3\u00a0d\u00a015\u00a0h' });
    expect(chipLine(account('a', { loggedOut: true }), 0, en).main).toBe('signed out');
    expect(chipLine(account('a', { headroomPct: null }), 0, en).main).toBe('unknown');
  });
  test('§6A U10 cost: decimal point in en, comma in vi, no grouping', () => {
    expect(fmtCost(41.2, en)).toBe('≈ $41.20');
    expect(fmtCost(1234.5, vi)).toBe('≈ $1234,50');
  });
});

const accounts = [account('a@x', { role: 'orchestrator', weekPct: 48 }), account('pm@x', { weekPct: 68, week: 99 }), account('b@example.com', { weekPct: 87, week: 99 })];
const rows = (patch: Record<string, Partial<RoleRow>> = {}): RoleRow[] => accounts.map(a => ({ email: a.email, role: a.role, week: a.week, five: '', hard: a.hard, maxLanes: 3, ...patch[a.email] }));

describe('§6A caps preview in en (§6.12)', () => {
  test('§6A cap move, running lane', () => {
    const p = capsPreview([lane('D2', { account: 'pm@x' })], accounts, rows({ 'pm@x': { week: 65 } }));
    expect(previewText(p[0]!, en)).toBe('Saving moves D2 off pm@ now — pm@ is at 68%, new cap 65%. D2 will resume on b@ (12% left).');
  });
  test('§6A orchestrator move, idle lane, no target', () => {
    const p = capsPreview([lane('D2', { account: 'pm@x', state: 'idle' })], [accounts[1]!, accounts[0]!], rows({ 'pm@x': { role: 'orchestrator', maxLanes: 0 }, 'a@x': { role: 'primary', week: 10 } }));
    expect(previewText(p[0]!, en)).toBe('Saving moves D2 off pm@ at its next message — pm@ becomes the orchestrator account. D2 will wait for quota (no account has room).');
  });
});

describe('§6A RolesTable in en', () => {
  test('§6A headers, role / cap controls, solo note', () => {
    const h = html(<RolesTable rows={[{ email: 'po@x', role: 'orchestrator', week: 99, five: '', hard: false, maxLanes: 3 }]} accounts={[account('po@x')]} onChange={() => {}} />);
    for (const s of ['Role', 'Weekly cap', 'Max lanes', 'Soft', 'Hard', 'Orchestrator', 'Only account: orchestrates and runs lanes.', 'aria-label="Max lanes po@x"']) expect(h).toContain(s);
    expect(h).not.toMatch(/Vai trò|Ngưỡng|Mềm|Cứng|Điều phối/);
  });
  test('§6A F12 current columns', () => {
    const r = [{ email: 'pm@x', role: 'primary' as const, week: 99, five: '', hard: false, maxLanes: 3 }];
    const h = text(html(<RolesTable rows={r} accounts={[account('pm@x', { fetchedAt: null })]} current={{ now: 0, base: r }} onChange={() => {}} />));
    expect(h).toContain('Current');
    expect(h).toContain('48% · 5h 31%');
    expect(h).toContain('none yet');
  });
});

const NOW = 10 * D;
// v2.1 §5.1: the F8 / F24 bodies moved into the Inspector (left column); same strings, same catalog keys
const ip = (sel: Selection, snapOver = {}): InspectorProps => {
  const snap = snapshot({ lanes: [lane('D2', { switches: 2, turnStartedAt: NOW - 5 * M })], accounts: [account('pm@x')], ...snapOver });
  return {
    sel, target: composerFor(sel, snap.projects[0]!.id, snap.orchestrators[0]?.sessionId ?? null, snap.lanes, null), snap, project: snap.projects[0]!, now: NOW, offline: false, dataAt: null,
    subs: { D2: [{ taskId: 't', toolUseId: 'u', subagentType: 'Explore', description: 'find', status: 'running', background: true, lastTool: null, toolUses: 3, totalTokens: 12000 }] },
    stream: undefined, live: undefined, subLines: [], subLoading: false, subLive: undefined, hideTools: false, onHideTools: () => {}, paused: false, draft: null, inputRef: createRef<HTMLTextAreaElement>(),
    onSel() {}, onClose() {}, onMenu() {}, onSend: () => Promise.resolve(), onInterrupt() {}, onLocal() {}, onStopAsk() {}, onOrchestrator() {}, onOlder() {}, onJumpEnd() {},
    onError() {}, onResume() {}, onProjectResume: () => Promise.resolve(), onPause() {}, onMoveAll() {}, onRelogin() {}, onEditCaps() {},
    sessions: snap.orchestrators, viewed: snap.orchestrators[0] ?? null, sessionsList: null,
    onHistory() {}, onView() {}, onSessionResume() {}, onOpenHandoff() {}, loadPreview: () => Promise.resolve(null),
    done: { total: null, cleanupDays: 30, load: () => Promise.resolve(null), onMerge() {}, onContinue() {}, onVscode() {}, onRetry() {} }, modelSend: () => Promise.resolve(null), modelReq: { n: 0 }, modal: false, token: () => null, onFocusInput() {},
  };
};

describe('§6A Inspector in en (F8, F24 bodies)', () => {
  test('§6A F8 lane body (a waiting lane: the facts are open, F-I8)', () => {
    const p = ip({ k: 'lane', name: 'D2' });
    p.snap.lanes[0]!.state = 'waiting_po';
    const h = text(html(<Inspector {...p} />));
    for (const s of ['Failures in a row', '≈ $1.00', 'turn running 5 min', 'switched 2×', '51% left', 'Stop',
      'Subagents · 1 running', '12k tok']) expect(h).toContain(s);
    expect(h).not.toContain('Switch account'); // v2.1 §4.11b: in the "⋯" menu now
    expect(h).not.toMatch(/Lỗi liên tiếp|hôm nay|Dừng|Chưa có log/);
  });
  test('§6A F24 account body', () => {
    const a = account('pm@x', { full: true, weekPct: 99, weekResetsAt: NOW + 2 * H, fetchedAt: NOW - 2 * M });
    const h = text(html(<Inspector {...ip({ k: 'account', email: 'pm@x' }, { accounts: [a], lanes: [] })} />));
    for (const s of ['full', 'soft cap 99% weekly', 'Week', 'FULL', '99% used', 'resets', '2 min old', 'Running on this account', 'No lanes on this account.', 'No new lanes', 'Edit caps'])
      expect(h).toContain(s);
    expect(h).not.toMatch(/Tuần|dùng|tuổi|Sửa ngưỡng|ĐẦY/);
  });
  test('§6A stop / move-all dialogs', () => {
    const raw = html(<StopDialog lane="D2" sub="group A lot-2 · 3 subagents running" onPick={() => {}} onClose={() => {}} />), s = text(raw);
    expect(s).toContain('Stop lane D2?');
    expect(s).toContain('group A lot-2 · 3 subagents running'); // §4.12 N2-e subtitle
    expect(s).toContain('Safe stop');
    // §4.12 T10 "Dừng ngay" = choose then confirm: the footer's primary button runs the chosen mode (safe stop preselected)
    expect(raw).toMatch(/<div class="mf"><button[^>]*>Cancel<\/button><button class="btn pri"[^>]*>Safe stop<\/button><\/div>/);
    expect(raw).toMatch(/<button class="choice bad"[^>]*aria-pressed="false"/);
    const m = text(html(<MoveAllDialog account="pm@x" lanes={[lane('D2')]} onYes={() => {}} onClose={() => {}} />));
    expect(m).toContain('Move all lanes off pm@?');
    expect(m).toContain('Move 1 lanes');
  });
  test('§6A vi unchanged: lane body still Vietnamese', () => {
    const h = text(html(<Inspector {...ip({ k: 'lane', name: 'D2' })} />, 'vi'));
    expect(h).toContain('lượt đang chạy 5 p');
    expect(h).toContain('≈ $1,00');
  });
});

describe('§6A list + boot in en', () => {
  test('§6A F9 lane table in en', () => {
    const raw = html(<ListView snap={snapshot()} projectId="p1" selected={null} onLane={() => {}} onMenu={() => {}} />), h = text(raw);
    for (const s of ['Lane', 'Task', 'State', 'Account', 'Cost']) expect(h).toContain(s);
    expect(raw).toContain('aria-label="Actions D2"');
    expect(h).not.toMatch(/Việc|Trạng thái|Chi phí|Thao tác/);
  });
  test('§6A F13 boot steps', () => {
    const h = text(html(<Boot snap={null} conn={{ status: 'connecting', attempt: 2, since: null } as never} />));
    expect(h).toContain('Checking dependencies');
    expect(h).toContain('connecting to the engine… try 2');
  });
});

describe('§6A T12a ⑥ F12 › Project foot line (D18)', () => {
  test('§6.12 D18 the Project tab says every session skips permission prompts; engine rules still apply (vi + en)', () => {
    const props = { snap: snapshot(), tab: 'proj', onTab: () => {}, onClose: () => {}, send: async () => undefined, onAddProject: () => {}, onSetup: () => {},
      accInfo: null, onAccDlg: () => {}, toast: () => {} } as unknown as Parameters<typeof Settings>[0];
    expect(html(<Settings {...props} />, 'vi')).toContain('<div class="foot">Mọi session chạy bỏ qua hỏi quyền (D18); luật chặn của engine vẫn áp dụng.</div>');
    expect(html(<Settings {...props} />, 'en')).toContain('<div class="foot">Every session runs without permission prompts (D18); the engine&#x27;s block rules still apply.</div>');
  });
});
