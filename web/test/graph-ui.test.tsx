// v2.5 §6 the Graph code tab rendered statically (vi + en): GR1 / GR1-new head, rows by state with their one button, GR-err
// (muted list, no buttons), GR0 / GR0-old (one primary button), GR-err-upd (no "Cập nhật…" under the band), GR-run, GR-empty.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GraphProjectView, GraphToolView, GraphView } from '../../shared/graph.ts';
import '../../shared/i18n/index.ts';
import { LangProvider, type Lang } from '../src/lib/i18n.tsx';
import { GraphTab } from '../src/ui/GraphTab.tsx';

const html = (el: ReactElement, lang: Lang = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\u00a0/g, ' ').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const MB = 1024 ** 2, GB = 1024 ** 3;
const AT = new Date(2026, 10, 16, 14, 2).getTime();
const p = (name: string, over: Partial<GraphProjectView> = {}): GraphProjectView => ({ projectId: name, name, on: true, git: true, state: 'ready', nodes: 15_899, bytes: 101 * MB, indexedAt: AT, lanes: { n: 0, bytes: 0 }, ...over });
const READY: GraphToolView = { state: 'ready', version: '0.12.1', latest: '0.12.1', checkedAt: AT, path: '/Users/x/.local/bin/codebase-memory-mcp',
  indexes: { n: 140, bytes: 10 * GB }, orphans: { n: 92, bytes: 7.7 * GB, skipped: 2 }, command: 'curl -fsSL … --dir "$HOME/.local/bin"' };
const view = (tool: Partial<GraphToolView> = {}, projects: GraphProjectView[] = [p('cc-slaves', { lanes: { n: 3, bytes: 310 * MB } }), p('aether', { state: 'none', nodes: undefined, bytes: undefined })]): GraphView =>
  ({ tool: { ...READY, ...tool }, projects });
const tab = (v: GraphView | undefined, lang: Lang = 'vi', connected = true) =>
  html(<GraphTab view={v} connected={connected} send={() => Promise.resolve()} toast={() => {}} onUpdate={() => {}} onClean={() => {}} onProjects={() => {}} />, lang);
const row = (h: string, name: string) => text(h.split(`data-project="${name}">`)[1]!.split('<div class="grr')[0]!.split('<div class="grlast')[0]!);
/** Plain / primary / link buttons (the Lane dùng switches are checked on their own). */
const buttons = (h: string) => [...h.matchAll(/<button class="((?:btn|lnk)[^"]*)"[^>]*>(.*?)<\/button>/g)].map(m => `${m[1]}:${text(m[2]!)}`);

describe('§6 GR1 the Graph code tab', () => {
  test('GR1: head, summary, columns, rows with one button + switch, last line with Dọn…', () => {
    const h = tab(view());
    expect(text(h)).toContain('codebase-memory-mcp 0.12.1 mới nhất kiểm tra lúc 14:02 Lane dùng graph qua cc-slaves. Kiểm tra');
    expect(text(h)).toContain('2 project 1 đã index 411 MB (gồm thư mục lane) Project Index Lane dùng');
    expect(row(h, 'cc-slaves')).toContain('Đã index · 15.899 node · 101 MB · 14:02 16/11 Index lại');
    expect(row(h, 'cc-slaves')).toContain('3 thư mục lane · 310 MB');
    expect(row(h, 'aether')).toContain('Chưa index Index');
    expect(h.match(/role="switch" aria-checked="true"/g)?.length).toBe(2);
    expect(text(h)).toContain('Index trên máy: 140 · 10,0 GB — 92 của thư mục đã xoá (7,7 GB) Dọn…');
    expect(buttons(h)).not.toContain('btn pri:Cập nhật…');
  });
  test('GR1-new: "có bản 0.13.0" + a plain "Cập nhật…" beside "Kiểm tra"; offline check line', () => {
    const h = tab(view({ latest: '0.13.0' }));
    expect(text(h)).toContain('codebase-memory-mcp 0.12.1 có bản 0.13.0 kiểm tra lúc 14:02');
    expect(buttons(h).slice(0, 2)).toEqual(['btn:Cập nhật…', 'btn:Kiểm tra']);
    expect(text(tab(view({ latest: undefined, checkError: { code: 'offline', line: 'x' } })))).toContain('0.12.1 không kiểm được bản mới (mất mạng) kiểm tra lúc 14:02');
  });
  test('GR1-offp / GR1-nogit: switch off, no button, old numbers muted; the not-git note', () => {
    const h = tab(view({}, [p('h-cowork', { on: false }), p('h-ops', { git: false })]));
    expect(row(h, 'h-cowork')).toBe('h-cowork Tắt cho lane · lane vẫn tìm bằng grep / đọc file 15.899 node · 101 MB · 14:02 16/11');
    expect(h).toMatch(/aria-checked="false" aria-label="Lane dùng graph trong h-cowork"/);
    expect(row(h, 'h-ops')).toContain('không phải git · index lại mỗi khi lane bắt đầu chạy, không theo từng lần sửa file');
  });
  test('GR1-states: "Index bản cũ" has the history icon, "Chưa index" the dashed circle; the queued row names the project in a chip', () => {
    const h = tab(view({}, [p('h-cowork', { state: 'stale' }), p('aether', { state: 'none', nodes: undefined, bytes: undefined }),
      p('hagenta', { state: 'running', startedAt: AT }), p('h-ops', { state: 'queued' })]));
    const cell = (name: string) => h.split(`data-project="${name}">`)[1]!.split('class="gra"')[0]!;
    expect(cell('h-cowork')).toContain('<path d="M3 3v5h5"/>');
    expect(cell('h-cowork')).not.toContain('class="dash"');
    expect(cell('aether')).toContain('class="dash"');
    expect(cell('h-ops')).toContain('(đang index <code class="chip">hagenta</code>)');
  });
  test('GR1-noorph: the total only, no Dọn…', () => {
    const h = tab(view({ indexes: { n: 48, bytes: 2.3 * GB }, orphans: { n: 0, bytes: 0, skipped: 0 } }));
    expect(text(h)).toContain('Index trên máy: 48 · 2,3 GB');
    expect(buttons(h).some(b => b.includes('Dọn'))).toBe(false);
  });
  test('GR-err: red band (cause, Thử lại, Xem log), plain head, muted list without row buttons, no last line', () => {
    const h = tab(view({ state: 'error', error: 'conflicting CBM process is active', log: ['a', 'b'] }));
    expect(text(h)).toContain('codebase-memory-mcp không khởi động được: conflicting CBM process is active Thử lại Xem log');
    expect(h).toContain('class="grdim"');
    expect(buttons(h).map(b => b.split(':')[1])).toEqual(['Thử lại', 'Xem log']);
    expect(text(h)).not.toContain('Index trên máy');
  });
  test('GR-empty: "Cài đặt › Project" is a link; the last line stays', () => {
    const h = tab(view({}, []));
    expect(text(h)).toContain('0 project Chưa có project nào — thêm trong Cài đặt › Project Index trên máy: 140');
    expect(buttons(h)).toContain('lnk:Cài đặt › Project');
  });
  test('engine lost: the band, every button off', () => {
    const h = tab(view(), 'vi', false);
    expect(text(h)).toContain('Mất kết nối engine');
    expect(h).not.toMatch(/<button class="(btn|sw)[^"]*"(?![^>]*disabled)/);
  });
  test('no view yet: loading line', () => {
    expect(text(tab(undefined))).toBe('Đang đọc Graph code…');
  });
});

describe('§6 GR0 / GR0-old / GR-err-upd / GR-run', () => {
  test('GR0: what it does, source + version, the command, "Cài" primary; no list', () => {
    const h = tab(view({ state: 'missing', version: undefined, latest: undefined }, []));
    expect(text(h)).toContain('Chưa có codebase-memory-mcp Dựng bản đồ code để lane tra hàm, nơi gọi, kiến trúc mà không phải đọc cả file. github.com/DeusData/codebase-memory-mcp · bản 0.12.1 · 50 MB tải · 335 MB trên đĩa Sẽ chạy: $ curl');
    expect(buttons(h)).toEqual(['btn pri:Cài']);
  });
  test('GR0-old: two lines, the path on its own line (~/…), "Cập nhật…" primary, no list', () => {
    const h = tab(view({ state: 'old', version: '0.8.1' }, []));
    expect(text(h)).toBe('Bản 0.8.1 cũ hơn bản cc-slaves cần (0.12.1). Cập nhật để cc-slaves quản lý index của từng project ở đây. Trong lúc chưa cập nhật, lane vẫn dùng bản cũ như trước. ~/.local/bin/codebase-memory-mcp Cập nhật…');
    expect(buttons(h)).toEqual(['btn pri:Cập nhật…']);
  });
  test('GR-err-upd: band with the last line + "bản 0.8.1 còn nguyên"; Thử lại + Xem log only (one job, one button)', () => {
    const h = tab(view({ state: 'old', version: '0.8.1', failed: { kind: 'update', line: 'curl: (6) Could not resolve host' }, log: ['x'] }, []));
    expect(text(h)).toContain('Cập nhật hỏng: curl: (6) Could not resolve host · bản 0.8.1 còn nguyên Thử lại Xem log');
    expect(buttons(h).map(b => b.split(':')[1])).toEqual(['Thử lại', 'Xem log']);
  });
  test('GR-run from old: title with versions, four steps (1 done, 2 running), the last 4 log lines, no list', () => {
    const h = tab(view({ state: 'updating', version: '0.8.1', run: { kind: 'update', from: '0.8.1', to: '0.12.1', step: 2, log: ['l1', 'l2', 'l3', 'l4', 'l5'] } }, []));
    expect(text(h)).toBe('Đang cập nhật codebase-memory-mcp 0.8.1 → 0.12.1 Đóng kết nối graph Tải và cài Kiểm phiên bản Mở lại l2 l3 l4 l5');
    expect(h).toMatch(/st-ok.*st-cur.*st-todo.*st-todo/);
  });
  test('GR-run from ready: the project list below, muted, no buttons', () => {
    const h = tab(view({ state: 'updating', run: { kind: 'update', from: '0.12.1', to: '0.13.0', step: 1, log: [] } }));
    expect(h).toContain('class="grdim"');
    expect(buttons(h)).toEqual([]);
  });
  test('English GR1', () => {
    const h = tab(view(), 'en');
    expect(text(h)).toContain('codebase-memory-mcp 0.12.1 latest checked at 14:02 Lanes use the graph through cc-slaves. Check');
    expect(text(h)).toContain('2 projects 1 indexed 411 MB (lane folders included) Project Index Lanes use');
    expect(text(h)).toContain('Indexes on this Mac: 140 · 10.0 GB — 92 belong to deleted folders (7.7 GB) Clean up…');
  });
});
