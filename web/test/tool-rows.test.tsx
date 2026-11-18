// spec v2.2 §14.5 "Dòng công cụ" + §14.7: the one-line row, grouping of ≥ 3 read-only rows (Edit / Bash / MCP / Task
// never grouped, an error opens the group), the "Ẩn công cụ" filter, and frames S4 / S4-narrow / S5 / S10 / S11.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../shared/i18n/index.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { groupTools, hideTools, mcpParts, paramLine, resultView, shortArg, toolKind, type Row, type ToolCall } from '../src/lib/tool-rows.ts';
import { toolCall } from '../src/lib/convo.ts';
import { Store } from '../src/lib/store.ts';
import { ConvList } from '../src/ui/Conversation.tsx';
import { ToolCount, ToolGroup, ToolRow } from '../src/ui/ToolRow.tsx';

type Item = { text: string } | { call: ToolCall };
let n = 0;
const tool = (name: string, over: Partial<ToolCall> = {}): Item => ({ call: { id: `t${++n}`, name, arg: 'web/src/lib/store.ts', state: 'ok', ms: 300, ...over } });
const text = (t: string): Item => ({ text: t });
const toolOf = (i: Item) => ('call' in i ? i.call : null);
const html = (el: ReactElement, lang: 'vi' | 'en' = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const kinds = (rows: Row<Item>[]) => rows.map(r => (r.k === 'group' ? `G${r.items.length}` : 'call' in r.item ? r.item.call.name : 'text'));

describe('§14.5 grouping of read-only rows', () => {
  test('§14.5 ≥ 3 read-only rows in a row fold into "Đã xem 5 · Read ×3, Grep ×2"', () => {
    const rows = groupTools([text('a'), tool('Read'), tool('Grep'), tool('Read'), tool('Read'), tool('Grep'), text('b')], toolOf);
    expect(kinds(rows)).toEqual(['text', 'G5', 'text']);
    const g = rows[1] as Extract<Row<Item>, { k: 'group' }>;
    expect(g.summary).toEqual([['Read', 3], ['Grep', 2]]);
    expect(g.open).toBe(false);
    expect(plain(html(<ToolGroup group={g} />))).toBe('Đã xem 5 · Read ×3, Grep ×2');
  });
  test('§14.5 two read-only rows stay single rows', () => {
    expect(kinds(groupTools([tool('Read'), tool('Glob'), text('x')], toolOf))).toEqual(['Read', 'Glob', 'text']);
  });
  test('§14.5 Edit / Bash / MCP / Task are never grouped and break a run', () => {
    for (const name of ['Edit', 'Bash', 'mcp__cc_slaves__lane_status', 'Task', 'Write', 'MultiEdit']) {
      expect(kinds(groupTools([tool(name), tool(name), tool(name)], toolOf))).toEqual([name, name, name]);
      expect(kinds(groupTools([tool('Read'), tool('Read'), tool(name), tool('Read')], toolOf))).toEqual(['Read', 'Read', name, 'Read']);
    }
  });
  test('§14.5 text between read rows splits the run', () => {
    expect(kinds(groupTools([tool('Read'), tool('Read'), text('x'), tool('Read'), tool('LS'), tool('WebFetch')], toolOf))).toEqual(['Read', 'Read', 'text', 'G3']);
  });
  test('§14.5 an error inside the group opens it, and the failed row is open', () => {
    const rows = groupTools([tool('Read'), tool('Grep', { state: 'error', result: 'regex parse error' }), tool('Read')], toolOf);
    const g = rows[0] as Extract<Row<Item>, { k: 'group' }>;
    expect({ open: g.open, state: g.state }).toEqual({ open: true, state: 'error' });
    const h = html(<ToolGroup group={g} />);
    expect(h).toContain('regex parse error');
    expect(h).toContain('aria-expanded="true"');
  });
  test('§14.5 a running row makes the group running; time sums once every row knows it', () => {
    const run = groupTools([tool('Read', { ms: 900 }), tool('Read', { ms: 1200, state: 'running' }), tool('Read', { ms: 300 })], toolOf)[0] as Extract<Row<Item>, { k: 'group' }>;
    expect({ state: run.state, ms: run.ms }).toEqual({ state: 'running', ms: 2400 });
    const unknown = groupTools([tool('Read', { ms: null }), tool('Read'), tool('Read')], toolOf)[0] as Extract<Row<Item>, { k: 'group' }>;
    expect(unknown.ms).toBeNull();
  });
});

describe('§14.5 "Ẩn công cụ" (S11)', () => {
  test('§14.5 S11 each stretch of tools becomes one "n công cụ" line; a failed tool stays', () => {
    const items = [text('a'), tool('Read'), tool('Grep'), tool('Edit'), tool('Read'), tool('Bash'), text('b'), tool('Read'), tool('Bash', { state: 'error' }), text('c')];
    const out = hideTools(items, toolOf);
    expect(out.map(o => (o.k === 'count' ? `n${o.n}` : 'call' in o.item ? `${o.item.call.name}!` : o.item.text))).toEqual(['a', 'n5', 'b', 'n1', 'Bash!', 'c']);
    expect(plain(html(<ToolCount n={5} />))).toBe('5 công cụ');
    expect(plain(html(<ToolCount n={5} />, 'en'))).toBe('5 tools');
  });
  test('§14.5 a stretch of only failed tools shows no count line', () => {
    expect(hideTools([tool('Bash', { state: 'error' })], toolOf).map(o => o.k)).toEqual(['item']);
  });
});

describe('§14.5 one tool row', () => {
  test('§14.5 icon by kind', () => {
    expect(['Read', 'Edit', 'Bash', 'Grep', 'WebSearch', 'mcp__x__y', 'Task', 'TodoWrite'].map(toolKind)).toEqual(['read', 'edit', 'bash', 'search', 'web', 'mcp', 'task', 'other']);
  });
  test('§14.5 short main parameter: …/src/lib/store.ts, a command cut at 80 chars, Read always names its file', () => {
    expect(shortArg({ name: 'Read', arg: '/Users/po/Works/cc-slaves/web/src/lib/store.ts' })).toBe('…/src/lib/store.ts');
    expect(shortArg({ name: 'Edit', arg: '/a/b.ts' })).toBe('/a/b.ts');
    const cmd = shortArg({ name: 'Bash', arg: 'bun test ' + 'x'.repeat(200) });
    expect(cmd.length).toBe(80);
    expect(cmd.endsWith('…')).toBe(true);
    expect(shortArg({ name: 'Bash', arg: 'git status\n  --short' })).toBe('git status --short');
  });
  test('§14.5 S4 Edit shows +12 −3 and ✓; the time only past 2 s', () => {
    const h = html(<ToolRow call={(tool('Edit', { arg: '/r/web/src/lib/store.ts', diff: { add: 12, del: 3 }, ms: 1500 }) as { call: ToolCall }).call} />);
    expect(plain(h)).toBe('Edit …/src/lib/store.ts +12 −3');
    expect(h).toContain('aria-label="xong"');
    const slow = html(<ToolRow call={(tool('Bash', { arg: 'bun test web/test', ms: 6200, state: 'error' }) as { call: ToolCall }).call} />);
    expect(plain(slow)).toBe('Bash bun test web/test lỗi 6,2 s');
    expect(plain(html(<ToolRow call={(tool('Bash', { arg: 'x', ms: 6200, state: 'error' }) as { call: ToolCall }).call} />, 'en'))).toBe('Bash x error 6.2 s');
  });
  test('§14.5 a running row: static dot + "…", no time yet', () => {
    const h = html(<ToolRow call={(tool('Bash', { arg: 'bun test', state: 'running', ms: null }) as { call: ToolCall }).call} />);
    expect(h).toContain('aria-label="đang chạy"');
    expect(plain(h)).toBe('Bash bun test …');
  });
  test('§14.5 S4-narrow the parameter is the only part that shrinks (cut from the left)', () => {
    const h = html(<ToolRow call={(tool('Read') as { call: ToolCall }).call} />);
    expect(h).toContain('<span class="tr-arg" title="web/src/lib/store.ts"><bdi>');
  });
  test('§14.5 S5 an opened row: the full command, the first 12 result lines, footer "Xem hết" + "48 dòng · exit 1"', () => {
    const result = Array.from({ length: 48 }, (_, i) => `dòng ${i + 1}`).join('\n');
    const call = (tool('Bash', { state: 'error', input: '$ bun test web/test', result, exitCode: 1 }) as { call: ToolCall }).call;
    const h = html(<ToolRow call={call} initialOpen />);
    expect(h).toContain('$ bun test web/test');
    expect(h).toContain('dòng 12');
    expect(h).not.toContain('dòng 13');
    expect(plain(h)).toContain('Xem hết 48 dòng · exit 1');
    expect(plain(html(<ToolRow call={call} initialOpen />, 'en'))).toContain('Show all 48 lines · exit 1');
    expect(resultView(result, true).lines.length).toBe(48);
  });
  test('§14.5 S5 no exit code → the footer shows the line count only; a short result with an exit code still says it', () => {
    const result = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const h = plain(html(<ToolRow call={(tool('Bash', { result }) as { call: ToolCall }).call} initialOpen />));
    expect(h).toContain('Xem hết 20 dòng');
    expect(h).not.toContain('exit');
    expect(plain(html(<ToolRow call={(tool('Bash', { state: 'error', result: 'a\nb', exitCode: 2 }) as { call: ToolCall }).call} initialOpen />))).toContain('2 dòng · exit 2');
    expect(plain(html(<ToolRow call={(tool('Bash', { result: 'a\nb' }) as { call: ToolCall }).call} initialOpen />))).not.toContain('dòng');
  });
  test('§14.5 a result cut at 8 KB says so (no run-log button: orchestrator ruling, §9)', () => {
    const call = (tool('Bash', { result: 'a\nb', truncated: { lines: 1240 } }) as { call: ToolCall }).call;
    expect(plain(html(<ToolRow call={call} initialOpen />))).toContain('đã cắt ở 8 KB · 1.240 dòng');
    expect(plain(html(<ToolRow call={call} initialOpen />, 'en'))).toContain('cut at 8 KB · 1,240 lines');
  });
  test('§14.5 a short result has no "Xem hết"', () => {
    expect(resultView('a\nb\n', false)).toEqual({ lines: ['a', 'b'], total: 2, more: false });
  });
});

describe('§14.5 S5 the opened row shows the parameter line, never the raw JSON input', () => {
  test('§14.5 S5 Bash → `$ <command>`; Read / Edit → the path; Grep / Glob → the pattern', () => {
    expect(paramLine('Bash', '{"command":"bun test web/test","description":"chạy"}')).toBe('$ bun test web/test');
    expect(paramLine('Read', '{"file_path":"/r/web/src/lib/store.ts","limit":40}')).toBe('/r/web/src/lib/store.ts');
    expect(paramLine('Edit', '{"file_path":"/r/a.ts","old_string":"a","new_string":"b"}')).toBe('/r/a.ts');
    expect(paramLine('NotebookEdit', '{"notebook_path":"/r/n.ipynb","new_source":"x"}')).toBe('/r/n.ipynb');
    expect(paramLine('Grep', '{"pattern":"partial_end","path":"web/src"}')).toBe('partial_end');
    expect(paramLine('Glob', '{"pattern":"**/*.ts"}')).toBe('**/*.ts');
  });
  test('§14.5 other tools → `key: value` lines; a non-object / cut JSON stays as it came', () => {
    expect(paramLine('mcp__gh__issue', '{"repo":"a/b","n":3,"labels":["x"]}')).toBe('repo: a/b\nn: 3\nlabels: ["x"]');
    expect(paramLine('Bash', '{"description":"no command"}')).toBe('description: no command');
    expect(paramLine('Bash', '{"command":"bun te')).toBe('{"command":"bun te');
    expect(paramLine('X', '"str"')).toBe('"str"');
  });
  test('§14.5 S5 a failed Bash row opened: `$ bun test …`, no `{"command"`', () => {
    const call = (tool('Bash', { state: 'error', input: '{"command":"bun test web/test"}', result: 'x' }) as { call: ToolCall }).call;
    const h = html(<ToolRow call={call} initialOpen />);
    expect(h).toContain('$ bun test web/test');
    expect(h).not.toContain('{&quot;command');
  });
});

describe('v2.2 UX review fixes: tool rows and the stream tail (F-M8, F-M9, F-M10)', () => {
  test('F-M8 S1 an MCP name splits into server + tool; other names are not MCP', () => {
    expect(mcpParts('mcp__cc_slaves__lane_tail')).toEqual({ server: 'cc_slaves', tool: 'lane_tail' });
    expect(mcpParts('mcp__claude_ai_Miro__board_show')).toEqual({ server: 'claude_ai_Miro', tool: 'board_show' });
    expect(mcpParts('Bash')).toBeNull();
    expect(mcpParts('mcp__broken')).toBeNull();
  });
  test('F-M8 S1 an MCP row with no engine summary shows the first plain input value as its main arg', () => {
    expect(shortArg({ name: 'mcp__cc_slaves__lane_status', arg: '', input: '{"lane":"D2","lines":40}' })).toBe('D2');
    expect(shortArg({ name: 'mcp__cc_slaves__lane_tail', arg: '', input: '{"n":40}' })).toBe('40');
    expect(shortArg({ name: 'mcp__x__y', arg: '', input: '{"o":{"a":1}}' })).toBe('');
    expect(shortArg({ name: 'mcp__x__y', arg: 'kept', input: '{"lane":"D2"}' })).toBe('kept');
  });
  test('F-M8 S1 the MCP row reads "lane_status D2" with the server as a small label, never the raw mcp__ name', () => {
    const h = html(<ToolRow call={{ id: 'm1', name: 'mcp__cc_slaves__lane_status', arg: '', input: '{"lane":"D2"}', state: 'ok', ms: 300 }} />);
    expect(h).toContain('<span class="tr-name">lane_status</span>');
    expect(h).toContain('<span class="tr-srv">cc_slaves</span>');
    expect(h).toContain('<bdi>D2</bdi>');
    expect(plain(h)).not.toContain('mcp__');
  });
  test('F-M9 S4 a running tool knows when it started; past 2 s it shows the elapsed seconds', () => {
    const use = { seq: 1, ts: 5_000, kind: 'tool_use', text: 'Bash: bun test', tool: 'Bash', toolUseId: 'u1' } as const;
    expect(toolCall(use, null).startedAt).toBe(5_000);
    expect(toolCall(use, { seq: 2, ts: 6_000, kind: 'tool_result', text: 'ok', toolUseId: 'u1' }).startedAt).toBeUndefined();
    const run = (ago: number) => plain(html(<ToolRow call={{ id: 'b1', name: 'Bash', arg: 'bun test', state: 'running', ms: null, startedAt: Date.now() - ago }} />));
    expect(run(8_400)).toContain('8 s');
    expect(run(1_000)).not.toMatch(/\d s/);
  });
  test('F-M9 S4 a finished row past 2 s shows its duration; a fast one does not', () => {
    expect(plain(html(<ToolRow call={{ id: 'b2', name: 'Bash', arg: 'x', state: 'ok', ms: 2_500 }} />))).toContain('2,5 s');
    expect(plain(html(<ToolRow call={{ id: 'b3', name: 'Bash', arg: 'x', state: 'ok', ms: 1_900 }} />))).not.toContain(' s');
  });
  const tail = (live: { thinking: number | null }, offline = false) => {
    const store = new Store(() => live.thinking ?? 0, null, { clock: null }), target = { kind: 'orchestrator', projectId: 'p1' } as const;
    if (live.thinking !== null) store.apply({ type: 'event', event: { type: 'thinking', target, parent: null, on: true } });
    return html(<ConvList lines={[]} live={{ store, tk: 'o:p1', parent: null }} hideTools={false} offline={offline} color="#fff" />);
  };
  test('F-M9 S7 "Đang nghĩ…" counts the seconds since thinking began', () => {
    const h = tail({ thinking: Date.now() - 4_200 });
    expect(h).toMatch(/<div class="m-think"><span>Đang nghĩ…<\/span><span class="m-sec">4 s<\/span><\/div>/);
    expect(tail({ thinking: null })).not.toContain('m-think');
  });
  test('F-M10 S9 connection lost mid-stream: a red-bordered band with the wifi icon, announced as status', () => {
    const h = tail({ thinking: Date.now() }, true);
    expect(h).toMatch(/<div class="m-lost" role="status"><svg[^>]*>[\s\S]*?<\/svg><span>Mất kết nối · chữ sẽ tiếp tục khi nối lại<\/span><\/div>/);
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.m-lost\{[^}]*border:1px solid[^}]*var\(--bad\)/);
  });
});
