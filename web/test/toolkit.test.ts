// v2.5 §6 TK2 the Bộ công cụ list, pure logic (web/src/lib/toolkit.ts): the shown state of a row (needs_login derived from
// the `skills_mcp` view, ruling 00:05), the TK2 summary numbers, the version text, the row's one action, the status line.
import { describe, expect, test } from 'bun:test';
import { makeT } from '../../shared/i18n/index.ts';
import type { McpRowView } from '../../shared/protocol.ts';
import type { ToolkitRow, ToolkitView } from '../../shared/toolkit.ts';
import { chip, code } from '../src/lib/graph.ts';
import { installCommands, logTail, pickedKeys, rowAction, shownRows, statusLook, statusText, stepFoot, stepNote, summaryText, versionText, type TkMcp } from '../src/lib/toolkit.ts';

const VI = makeT('vi');
const sp = (s: string) => s.replace(/\u00a0/g, ' '); // statLine keeps each part on one line (NBSP)
const EN = makeT('en');
const r = (key: ToolkitRow['key'], over: Partial<ToolkitRow> = {}): ToolkitRow => ({
  key, kind: 'plugin', id: `${key}@claude-plugins-official`, state: 'installed', version: '1.0.0', mcpLoginIds: [], ...over,
});
const C7 = 'context7@claude-plugins-official';
const mcp = (id: string, needs: boolean): TkMcp => ({
  id, oauth: { loggedIn: !needs, needsLogin: needs ? { reason: 'no_token', scope: null } : null } as McpRowView['oauth'],
});
/** The mockup set (§6 TK2): superpowers outdated, ui-ux-pro-max missing, context7 + vercel need a login. */
const TK2: ToolkitView = {
  rows: [
    r('superpowers', { state: 'outdated', version: '7.0.0' }),
    r('ui-ux-pro-max', { id: 'ui-ux-pro-max@ui-ux-pro-max-skill', state: 'missing', version: undefined }),
    r('context7', { state: 'needs_login', version: 'b5b01ac4f889', mcpLoginIds: [`plugin:${C7}:context7`] }),
    r('vercel', { state: 'needs_login', version: '0.50.0', mcpLoginIds: ['plugin:vercel@claude-plugins-official:vercel'] }),
  ],
  checkedAt: new Date(2026, 10, 17, 14, 2).getTime(),
};

describe('§6 TK2 shown state: needs_login comes from the skills_mcp view when the web has it (ruling 00:05)', () => {
  test('no skills_mcp view yet → the engine state and its mcpLoginIds', () => {
    const s = shownRows(TK2, null);
    expect(s.map(x => x.shown)).toEqual(['outdated', 'missing', 'needs_login', 'needs_login']);
    expect(s[2]!.loginIds).toEqual([`plugin:${C7}:context7`]);
  });
  test('the MCP was logged in since the toolkit push → installed; a login need the toolkit view missed → needs_login', () => {
    const view: ToolkitView = { rows: [r('context7', { state: 'needs_login', mcpLoginIds: [`plugin:${C7}:context7`] }), r('vercel')] };
    const s = shownRows(view, [mcp(`plugin:${C7}:context7`, false), mcp('plugin:vercel@claude-plugins-official:vercel', true), mcp('user:vercel', true)]);
    expect(s.map(x => x.shown)).toEqual(['installed', 'needs_login']);
    expect(s[1]!.loginIds).toEqual(['plugin:vercel@claude-plugins-official:vercel']);
  });
  test('an MCP without OAuth (noLogin / stdio) never asks for a login; outdated / missing / failed keep their own state', () => {
    const view: ToolkitView = { rows: [r('vercel'), r('superpowers', { state: 'outdated' }), r('context7', { state: 'failed', error: { code: 'offline', line: 'x' } })] };
    const s = shownRows(view, [{ id: 'plugin:vercel@claude-plugins-official:vercel' }, mcp(`plugin:${C7}:context7`, true), mcp('plugin:superpowers@claude-plugins-official:x', true)]);
    expect(s.map(x => x.shown)).toEqual(['installed', 'outdated', 'failed']);
  });
  test('running: the busy row runs, the other running rows wait (TK1-run "Chờ"); git causes show "Cần git"', () => {
    const view: ToolkitView = { busy: 'context7', rows: [r('superpowers', { state: 'running' }), r('context7', { state: 'running' }), r('vercel', { state: 'failed', error: { code: 'git_missing', line: '' } })] };
    expect(shownRows(view, null).map(x => x.shown)).toEqual(['waiting', 'running', 'git']);
  });
});

describe('§6 TK2 summary, version text, action, status', () => {
  test('TK2 summary: "5 mục · 4 đã cài · 1 chưa cài · 1 có bản mới · 2 cần đăng nhập · kiểm tra lúc 14:02" (4-row set: 4 mục)', () => {
    expect(sp(summaryText(VI, shownRows(TK2, null), TK2.checkedAt))).toBe('4 mục · 3 đã cài · 1 chưa cài · 1 có bản mới · 2 cần đăng nhập · kiểm tra lúc 14:02');
    expect(sp(summaryText(EN, shownRows(TK2, null), undefined))).toBe('4 items · 3 installed · 1 not installed · 1 update available · 2 need login');
  });
  test('TK2-upd: a zero part is dropped; nothing checked yet → no time', () => {
    const v: ToolkitView = { rows: [r('superpowers', { updated: true, version: '7.0.2' }), r('vercel')] };
    expect(sp(summaryText(VI, shownRows(v, null), undefined))).toBe('2 mục · 2 đã cài');
  });
  test('TK1-all: a commit id shows as its first 7 chars in brackets, a version as is', () => {
    expect(versionText('b5b01ac4f889aaaa')).toBe('(b5b01ac)');
    expect(versionText('7.0.2')).toBe('7.0.2');
    expect(versionText(undefined)).toBe('');
  });
  test('one action per row: missing → install, outdated → update, needs_login → login, failed → retry (install / update by version), else none', () => {
    const s = shownRows({ rows: [r('superpowers', { state: 'missing', version: undefined }), r('vercel', { state: 'outdated' }), r('context7', { state: 'needs_login', mcpLoginIds: ['x'] }),
      r('ui-ux-pro-max', { state: 'failed', version: undefined, error: { code: 'offline', line: '' } }), r('superpowers', { state: 'failed', error: { code: 'unknown', line: 'boom' } }),
      r('vercel', { state: 'disabled' }), r('vercel', { state: 'failed', error: { code: 'git_license', line: '' } })] }, null);
    expect(s.map(rowAction)).toEqual(['install', 'update', 'login', 'retryInstall', 'retryUpdate', null, null]);
  });
  test('§6 TK1-mix the graph tool row: below the min → "Bản 0.8.1 — cc-slaves cần 0.12.1" + "Cập nhật…" (GR-upd), never toolkit_update', () => {
    const g = (over: Partial<ToolkitRow>) => shownRows({ rows: [{ key: 'graph', kind: 'graph', state: 'outdated', mcpLoginIds: [], ...over }] }, null)[0]!;
    expect(statusText(VI, g({ version: '0.8.1', latest: '0.12.1' }))).toBe(`Bản ${code('0.8.1')} — cc-slaves cần ${code('0.12.1')}`);
    expect(statusText(EN, g({ version: '0.8.1', latest: '0.12.1' }))).toBe(`Version ${code('0.8.1')} — cc-slaves needs ${code('0.12.1')}`);
    expect(statusText(VI, g({ version: '0.12.1', latest: '0.13.0' }))).toBe(`Có bản mới ${code('0.12.1')} → ${code('0.13.0')}`);
    expect(rowAction(g({ version: '0.8.1', latest: '0.12.1' }))).toBe('graphUpdate');
    expect(rowAction(g({ version: '0.12.1', latest: '0.13.0' }))).toBe('graphUpdate');
    expect(statusLook(g({ version: '0.8.1', latest: '0.12.1' }))).toBe('graphOld'); // alert icon, one line (G6 mismatch 3)
    expect(statusLook(g({ version: '0.12.1', latest: '0.13.0' }))).toBe('outdated');
  });
  test('G6 mismatch 4: off for lanes looks like disabled (grey, no check); a plain install keeps its own look', () => {
    expect(statusLook(shownRows({ rows: [r('vercel', { offForLanes: true, version: '0.50.0' })] }, null)[0]!)).toBe('offLanes');
    expect(statusLook(shownRows({ rows: [r('vercel', { state: 'disabled' })] }, null)[0]!)).toBe('disabled');
    expect(statusLook(shownRows({ rows: [r('vercel')] }, null)[0]!)).toBe('installed');
  });
  test('status lines of §6 TK1-mix / TK2-upd / §5.2 causes', () => {
    const st = (row: ToolkitRow, busy?: ToolkitView['busy']) => statusText(VI, shownRows({ rows: [row], ...(busy ? { busy } : {}) }, null)[0]!);
    expect(st(r('ui-ux-pro-max', { state: 'outdated', version: '2.14.0', latest: '2.15.0' }))).toBe(`Có bản mới ${code('2.14.0')} → ${code('2.15.0')}`);
    expect(st(r('superpowers', { state: 'outdated', version: '7.0.0' }))).toBe(`Có bản mới (đang dùng ${code('7.0.0')})`);
    expect(st(r('superpowers', { updated: true, version: '7.0.2' }))).toBe(`Đã cập nhật ${code('7.0.2')} · áp dụng từ lần chạy sau của mỗi lane`);
    expect(st(r('vercel', { offForLanes: true, version: '0.50.0' }))).toBe(`Đã cài ${code('0.50.0')} · tắt cho lane`);
    expect(st(r('vercel', { state: 'disabled' }))).toBe(`Đã cài · đang tắt trong Claude Code (bật lại bằng ${chip('/plugin')})`);
    expect(st(r('context7', { version: 'b5b01ac4f889' }))).toBe(`Đã cài ${code('(b5b01ac)')}`);
    expect(st(r('vercel', { state: 'failed', error: { code: 'offline', line: 'fatal: unable to access' } }))).toBe('Không tải được — kiểm tra mạng / VPN');
    expect(st(r('vercel', { state: 'failed', error: { code: 'not_found', line: '' } }))).toBe('Không thấy vercel@claude-plugins-official trong marketplace — bấm Kiểm tra rồi Thử lại');
    expect(st(r('vercel', { state: 'failed', error: { code: 'unknown', line: 'Plugin cache corrupted' } }))).toBe('Plugin cache corrupted');
    expect(st(r('vercel', { state: 'running', version: undefined }), 'vercel')).toBe('Đang cài…');
    expect(st(r('vercel', { state: 'running' }), 'vercel')).toBe('Đang cập nhật…');
    expect(st(r('vercel', { state: 'running' }))).toBe('Chờ');
  });
});

/** §6 TK1 the mockup start: nothing installed. */
const TK1: ToolkitView = {
  rows: [r('superpowers', { state: 'missing', version: undefined }), r('ui-ux-pro-max', { id: 'ui-ux-pro-max@ui-ux-pro-max-skill', state: 'missing', version: undefined }),
    r('context7', { state: 'missing', version: undefined }), r('vercel', { state: 'missing', version: undefined })],
  checkedAt: 1,
};

describe('§6 TK1 wizard step 3: ticks, the command plan, the foot and the note', () => {
  test('D70 every missing row is ticked by default; an unticked key drops out; installed / git rows are never picked', () => {
    expect(pickedKeys(shownRows(TK1, null), new Set())).toEqual(['superpowers', 'ui-ux-pro-max', 'context7', 'vercel']);
    expect(pickedKeys(shownRows(TK1, null), new Set(['context7']))).toEqual(['superpowers', 'ui-ux-pro-max', 'vercel']);
    const git: ToolkitView = { rows: [r('superpowers', { state: 'failed', version: undefined, error: { code: 'git_missing', line: '' } }), r('vercel')] };
    expect(pickedKeys(shownRows(git, null), new Set())).toEqual([]);
  });
  test('ruling 00:55 TK1-cmd: the engine commands of each picked row, in the order they run, each line once', () => {
    const OFF = 'claude plugin marketplace add anthropics/claude-plugins-official';
    const ux = 'claude plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill';
    const inst = (id: string) => `claude plugin install ${id}`;
    const v: ToolkitView = { rows: [
      r('superpowers', { state: 'missing', version: undefined, commands: [OFF, inst('superpowers@claude-plugins-official')] }),
      r('ui-ux-pro-max', { state: 'missing', version: undefined, commands: [ux, inst('ui-ux-pro-max@ui-ux-pro-max-skill')] }),
      r('vercel', { state: 'missing', version: undefined, commands: [OFF, inst('vercel@claude-plugins-official')] }),
      r('graph', { kind: 'graph', id: undefined, state: 'missing', version: undefined, commands: ['curl -fsSL x | bash'] }),
    ] };
    expect(installCommands(shownRows(v, null), ['superpowers', 'ui-ux-pro-max', 'vercel', 'graph'])).toEqual([
      OFF, inst('superpowers@claude-plugins-official'), ux, inst('ui-ux-pro-max@ui-ux-pro-max-skill'), inst('vercel@claude-plugins-official'), 'curl -fsSL x | bash',
    ]);
    expect(installCommands(shownRows(v, null), ['vercel'])).toEqual([OFF, inst('vercel@claude-plugins-official')]);
    expect(installCommands(shownRows(TK1, null), ['vercel'])).toEqual([]); // no commands from the engine → none shown
    expect(installCommands(shownRows(v, null), [])).toEqual([]);
  });
  test('foot: something to tick → pick; a row running or waiting → run (TK1-run); else next (TK1-done / -all / -fail)', () => {
    expect(stepFoot(shownRows(TK1, null))).toBe('pick');
    const run: ToolkitView = { rows: [r('superpowers'), r('vercel', { state: 'running', version: undefined }), r('context7', { state: 'running', version: undefined })], busy: 'vercel' };
    expect(stepFoot(shownRows(run, null))).toBe('run');
    expect(stepFoot(shownRows({ rows: [r('context7', { state: 'running', version: undefined })] }, null))).toBe('run'); // waiting only
    expect(stepFoot(shownRows({ rows: [r('superpowers'), r('vercel', { state: 'failed', error: { code: 'offline', line: 'x' } })] }, null))).toBe('next');
  });
  test('note: run → "Bấm Tiếp…"; next with a login → "Đăng nhập sau…"; every row installed → "Máy này đã có đủ n mục."', () => {
    const rows = (v: ToolkitView) => shownRows(v, null);
    expect(stepNote(rows({ rows: [r('vercel', { state: 'running', version: undefined })], busy: 'vercel' }))).toEqual({ k: 'run' });
    expect(stepNote(rows({ rows: [r('superpowers'), r('context7', { state: 'needs_login', mcpLoginIds: ['x'] })] }))).toEqual({ k: 'login' });
    expect(stepNote(rows({ rows: [r('superpowers'), r('context7', { version: 'b5b01ac4f889' })] }))).toEqual({ k: 'all', n: 2 });
    expect(stepNote(rows(TK1))).toBeNull();
    expect(stepNote(rows({ rows: [r('superpowers', { state: 'outdated' })] }))).toBeNull();
  });
  test('ruling 00:27 per-row log: the last 4 lines, none without a log', () => {
    expect(logTail(r('vercel', { log: ['a', 'b', 'c', 'd', 'e'] }))).toEqual(['b', 'c', 'd', 'e']);
    expect(logTail(r('vercel', { log: ['a'] }))).toEqual(['a']);
    expect(logTail(r('vercel'))).toEqual([]);
  });
});
