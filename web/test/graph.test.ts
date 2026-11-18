// v2.5 §6 GR1 / GR-upd / GR-clean the Graph code tab, pure logic (web/src/lib/graph.ts): sizes, the tab's mode, the GR1
// summary (equal to the sum of every project row and lane line), a project row's status + action, the last line of the tab,
// the GR-upd impact lines (numbers of `graph_impact`, zero lines dropped, `old` vs `ready` wording).
import { describe, expect, test } from 'bun:test';
import type { GraphImpact, GraphProjectView, GraphToolView } from '../../shared/graph.ts';
import { makeT } from '../../shared/i18n/index.ts';
import { chip, code, codeParts, fmtSize, graphMode, impactLines, lastLine, rowStatus, summary, tabCount } from '../src/lib/graph.ts';

const VI = makeT('vi');
const EN = makeT('en');
const MB = 1024 ** 2, GB = 1024 ** 3;
const p = (name: string, over: Partial<GraphProjectView> = {}): GraphProjectView => ({
  projectId: name, name, on: true, git: true, state: 'ready', nodes: 15_899, bytes: 101 * MB, indexedAt: new Date(2026, 10, 16, 14, 2).getTime(), lanes: { n: 0, bytes: 0 }, ...over,
});
const tool = (over: Partial<GraphToolView> = {}): GraphToolView => ({ state: 'ready', version: '0.12.1', ...over });

describe('fmtSize', () => {
  test('GB with one decimal, MB whole (one decimal under 10), the language decimal mark', () => {
    expect(fmtSize(VI, 10 * GB)).toBe('10,0 GB');
    expect(fmtSize(EN, 10 * GB)).toBe('10.0 GB');
    expect(fmtSize(VI, 101 * MB)).toBe('101 MB');
    expect(fmtSize(VI, 7.5 * MB)).toBe('7,5 MB');
    expect(fmtSize(VI, 0)).toBe('0 MB');
  });
});

describe('graphMode / tabCount', () => {
  test('a run wins; missing → GR0, old → GR0-old, else the list', () => {
    expect(graphMode(tool({ state: 'missing' }))).toBe('missing');
    expect(graphMode(tool({ state: 'old', version: '0.8.1' }))).toBe('old');
    expect(graphMode(tool({ state: 'updating', run: { kind: 'update', from: '0.8.1', to: '0.12.1', step: 2, log: [] } }))).toBe('run');
    expect(graphMode(tool({ state: 'error' }))).toBe('list');
    expect(graphMode(tool())).toBe('list');
  });
  test('the tab shows the project count only with a list (GR0 / GR0-old / GR-run from old: none)', () => {
    expect(tabCount({ tool: tool(), projects: [p('a'), p('b')] })).toBe(2);
    expect(tabCount({ tool: tool(), projects: [] })).toBe(0);
    expect(tabCount({ tool: tool({ state: 'old' }), projects: [] })).toBeNull();
    expect(tabCount({ tool: tool({ state: 'updating', run: { kind: 'update', step: 1, log: [] } }), projects: [] })).toBeNull();
    expect(tabCount(undefined)).toBeNull();
  });
});

describe('summary (GR1: equal to every row and lane line below)', () => {
  test('stale and running-with-numbers count as indexed; failed and none do not; lane dirs in the bytes', () => {
    const s = summary([p('a', { lanes: { n: 3, bytes: 310 * MB } }), p('b', { state: 'stale' }), p('c', { state: 'failed', error: 'x' }), p('d', { state: 'none', nodes: undefined, bytes: undefined }),
      p('e', { state: 'running', startedAt: 1 })]);
    expect(s).toEqual({ n: 5, indexed: 3, bytes: (101 * 3 + 310) * MB });
  });
});

describe('rowStatus', () => {
  const now = new Date(2026, 10, 16, 15, 0).getTime();
  test('ready: "Đã index" + metrics + Index lại', () => {
    const s = rowStatus(VI, p('cc-slaves'), [], now);
    expect(s).toMatchObject({ cls: 'ok', act: 'reindex', text: 'Đã index' });
    expect(s.metrics).toBe('15.899 node · 101 MB · 14:02 16/11');
  });
  test('none → Index; failed → its error line + Thử lại; stale keeps the metrics + Index lại', () => {
    expect(rowStatus(VI, p('a', { state: 'none', nodes: undefined }), [], now)).toMatchObject({ text: 'Chưa index', act: 'index', metrics: null });
    expect(rowStatus(VI, p('a', { state: 'failed', error: 'index failed: worker exited with status 1' }), [], now))
      .toMatchObject({ cls: 'bad', text: 'Lỗi: index failed: worker exited with status 1', act: 'retry', metrics: null });
    expect(rowStatus(VI, p('a', { state: 'stale' }), [], now)).toMatchObject({ cls: 'old', text: 'Index bản cũ · vẫn dùng được', act: 'reindex' });
  });
  test('running: the clock from startedAt, old numbers muted, Dừng; by the tool (R4) no Dừng; stopping / overdue', () => {
    const run = rowStatus(VI, p('hagenta', { state: 'running', startedAt: now - 12_000 }), [], now);
    expect(run).toMatchObject({ cls: 'run', text: 'Đang index · 0:12 · lane vẫn dùng index cũ', act: 'stop', metrics: null });
    expect(run.old).toBe('15.899 node · 101 MB · 14:02 16/11');
    expect(rowStatus(VI, p('a', { state: 'running', startedAt: now, byTool: true }), [], now).act).toBeNull();
    expect(rowStatus(VI, p('a', { state: 'running', stopping: true }), [], now)).toMatchObject({ text: 'Đang dừng…', act: null });
    expect(rowStatus(VI, p('a', { state: 'running', overdue: true }), [], now).text).toBe('Quá hạn — công cụ vẫn đang index');
  });
  test('queued names the project being indexed; off for lanes: no action, old numbers muted', () => {
    const all = [p('hagenta', { state: 'running', startedAt: now }), p('h-cowork', { state: 'queued', ahead: 1 })];
    expect(rowStatus(VI, all[1]!, all, now)).toMatchObject({ text: 'Chờ tới lượt (đang index \u0002hagenta\u0002)', act: 'stop' });
    expect(rowStatus(VI, p('x', { state: 'queued' }), [], now).text).toBe('Chờ tới lượt');
    const off = rowStatus(VI, p('h-cowork', { on: false }), [], now);
    expect(off).toMatchObject({ text: 'Tắt cho lane · lane vẫn tìm bằng grep / đọc file', act: null, metrics: null });
    expect(off.old).toBe('15.899 node · 101 MB · 14:02 16/11');
  });
});

describe('lastLine (GR1 last line / GR-clean-run / -done / -fail)', () => {
  test('orphans → total + orphans + Dọn…; none → total only; no numbers → nothing', () => {
    const t = tool({ indexes: { n: 140, bytes: 10 * GB }, orphans: { n: 92, bytes: 7.7 * GB, skipped: 2 } });
    expect(lastLine(VI, t)).toEqual({ k: 'orph', text: 'Index trên máy: 140 · 10,0 GB — 92 của thư mục đã xoá (7,7 GB)' });
    expect(lastLine(VI, tool({ indexes: { n: 48, bytes: 2.3 * GB }, orphans: { n: 0, bytes: 0, skipped: 2 } }))).toEqual({ k: 'none', text: 'Index trên máy: 48 · 2,3 GB' });
    expect(lastLine(VI, tool())).toBeNull();
  });
  test('running, done, failed with the tool line', () => {
    const base = { indexes: { n: 48, bytes: 2.3 * GB } };
    expect(lastLine(VI, tool({ ...base, clean: { state: 'running', done: 31, total: 92, freedBytes: 0, failed: 0, failedRoots: [] } }))?.text).toBe('Đang dọn… 31 / 92');
    expect(lastLine(VI, tool({ ...base, clean: { state: 'done', done: 92, total: 92, freedBytes: 7.7 * GB, failed: 0, failedRoots: [] } })))
      .toEqual({ k: 'done', text: 'Đã dọn 92 index · thu lại 7,7 GB · Index trên máy: 48 · 2,3 GB' });
    expect(lastLine(VI, tool({ ...base, clean: { state: 'done', done: 92, total: 92, freedBytes: 7.5 * GB, failed: 2, failedRoots: ['/a', '/b'], error: 'database is locked' } })))
      .toEqual({ k: 'fail', text: 'Đã dọn 90 · thu lại 7,5 GB · 2 không xoá được (database is locked)' });
    expect(lastLine(VI, tool({ ...base, clean: { state: 'done', done: 0, total: 5, freedBytes: 0, failed: 0, failedRoots: [], error: 'boom' } })))
      .toEqual({ k: 'err', text: 'Dọn hỏng: boom' });
  });
});

describe('impactLines (GR-upd)', () => {
  const imp: GraphImpact = { indexes: { n: 140, bytes: 10 * GB }, lanesRunning: 4, processes: { lanes: 4, sessions: 8, other: 3 } };
  test('from old: lanes keep the old version until their next run (no restart), other sessions keep it too', () => {
    expect(impactLines(VI, imp, 'old', '0.8.1').map(l => l.text)).toEqual([
      '140 index (10,0 GB) vẫn dùng được; mỗi index dựng lại khi được index lần tới',
      '4 lane đang chạy vẫn dùng bản 0.8.1 tới lần chạy kế của lane; không lượt nào bị cắt',
      '8 phiên Claude Code khác đang mở (terminal, VS Code) vẫn dùng bản 0.8.1 cho tới khi mở lại phiên',
      '3 tiến trình codebase-memory-mcp khác (không phải Claude Code) vẫn dùng bản cũ cho tới khi chạy lại',
      'Giữ nguyên: cấu hình trong \u0001~/.claude\u0001',
    ]);
  });
  test('from ready: the graph pauses, other sessions lose it, the switches are kept; zero lines dropped', () => {
    const z: GraphImpact = { indexes: { n: 0, bytes: 0 }, lanesRunning: 4, processes: { lanes: 4, sessions: 8, other: 0 } };
    expect(impactLines(VI, z, 'ready', '0.12.1').map(l => l.text)).toEqual([
      '4 lane đang chạy: graph tạm ngưng khoảng 1 phút, lane dùng grep trong lúc đó',
      '8 phiên Claude Code khác đang mở (terminal, VS Code) mất graph cho tới khi mở lại phiên',
      'Giữ nguyên: cấu hình trong \u0001~/.claude\u0001, công tắc Lane dùng',
    ]);
  });
  test('English: from old, lanes keep {v} until their next run', () => {
    expect(impactLines(EN, imp, 'old', '0.8.1')[1]?.text).toBe('4 running lanes keep version 0.8.1 until their next run; no turn is cut off');
    expect(impactLines(EN, { ...imp, lanesRunning: 1 }, 'old', '0.8.1')[1]?.text).toBe('1 running lane keeps version 0.8.1 until its next run; no turn is cut off');
  });
  test('English plurals', () => {
    expect(impactLines(EN, { indexes: { n: 1, bytes: GB }, lanesRunning: 1, processes: { lanes: 1, sessions: 1, other: 1 } }, 'ready', '0.12.1').map(l => l.text).slice(0, 2))
      .toEqual(['1 index (1.0 GB) stays usable; it is rebuilt the next time it is indexed', '1 running lane: the graph pauses for about a minute; the lane uses grep meanwhile']);
  });
});

describe('codeParts', () => {
  test('odd parts are code (the \\u0001 marks a param shown mono)', () => {
    expect(codeParts('a \u0001b\u0001 c')).toEqual([{ k: 'txt', s: 'a ' }, { k: 'code', s: 'b' }, { k: 'txt', s: ' c' }]);
    expect(codeParts('plain')).toEqual([{ k: 'txt', s: 'plain' }]);
    expect(codeParts(`run ${chip('sudo x')} then ${code('1.0')}`)).toEqual([{ k: 'txt', s: 'run ' }, { k: 'chip', s: 'sudo x' }, { k: 'txt', s: ' then ' }, { k: 'code', s: '1.0' }]);
  });
});
