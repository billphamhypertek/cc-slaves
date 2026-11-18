// v2.2 §6 the Skills & MCP sheet (K1, K1-empty, K1-load, K1-local, K1-claudeai, K2, K7, K14, tab badges) and its dialogs
// (K4, K5, K6), rendered statically in vi and en.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../shared/i18n/index.ts'; // both catalogs (en for K15)
import type { McpRowView, SkillsMcpView } from '../../shared/protocol.ts';
import type { GraphToolState, GraphView } from '../../shared/graph.ts';
import type { ToolkitView } from '../../shared/toolkit.ts';
import { LangProvider, type Lang } from '../src/lib/i18n.tsx';
import { McpAddDialog, McpRemoveDialog, UrlChangedBand, WriteErrorBlock } from '../src/ui/SkillsMcpDialogs.tsx';
import { McpLog, McpTab } from '../src/ui/SkillsMcpList.tsx';
import { rowMenu, rowSourcePath } from '../src/lib/skills-mcp-sheet.ts';
import { SheetHead } from '../src/ui/SkillsMcp.tsx';
import { lane } from './fixtures.ts';

const row = (name: string, over: Partial<McpRowView> = {}): McpRowView => ({
  id: `user:${name}`, name, source: 'user', kind: 'stdio', projectId: null, plugin: null, config: { command: 'npx', env: { TOKEN: 's3cret' } },
  forLanes: true, pending: false, unused: null, editable: true, status: 'connected', tools: 38, error: null, lastInit: null,
  canCheck: true, checking: false, probe: null, log: [], ...over,
});
const CC = row('cc_slaves', { id: 'cc_slaves', builtin: true, editable: false, canCheck: false, kind: 'http', config: {}, tools: 2 });
const AT = (h: number, m: number) => new Date(2026, 10, 16, h, m).getTime();
const ROWS = [
  CC,
  row('onedevtool'),
  row('plugin_context7_context7', { id: 'plugin:context7@x:context7', source: 'plugin', plugin: 'context7@x', kind: 'http', status: 'needs_login', tools: null, editable: false, config: { type: 'http', url: 'https://mcp.context7.com/mcp' },
    oauth: { loggedIn: false, expiresAt: null, refreshedAt: null, needsLogin: { reason: 'no_token', scope: null }, keychainFailed: false, login: null, error: null } }),
  row('miro', { id: 'local:p1:miro', source: 'local', projectId: 'p1', kind: 'http', tools: 14, editable: false, config: { type: 'http', url: 'https://mcp.miro.com' },
    lastInit: { projectId: 'p1', lane: 'D2', state: 'connected', tools: 14, toolNames: [], at: new Date(2026, 10, 16, 13, 5).getTime() } }),
  row('codebase-memory-mcp', { forLanes: false, tools: 14 }),
  row('hcm', { id: 'local:~/Users/x:hcm', source: 'local', kind: 'http', forLanes: false, unused: { path: '/Users/x' }, editable: false, status: 'unchecked', tools: null }),
  row('postgres', { id: 'project:p1:postgres', source: 'project', projectId: 'p1', pending: true, forLanes: false, editable: false, status: 'unchecked', tools: null,
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://app:pw@localhost:5432/hagenta'] } }),
];
const view = (over: Partial<SkillsMcpView> = {}): SkillsMcpView => ({
  mcp: { rows: ROWS, servers: 7, forLanes: 4, tools: 54 }, skills: { rows: [], issues: [], plugins: [], descTokens: 0 },
  counts: { mcp: { red: 1, yellow: 1 }, skills: { red: 0, yellow: 4 }, shared: { red: 0, yellow: 1 }, total: { red: 1, yellow: 6 } },
  claudeJson: { ok: true, line: null, rev: 'r1', path: '/Users/me/.claude.json' }, claude: { found: true, install: 'npm i -g @anthropic-ai/claude-code' }, lost: [], ...over,
});
const one = (r: McpRowView) => view({ mcp: { rows: [r], servers: 1, forLanes: 1, tools: r.tools ?? 0 } });
const SNAP = { lanes: [lane('D2'), lane('B3')], projects: [{ id: 'p1', name: 'hagenta', path: '/w/hagenta', orchestratorAccount: null, gchatWebhookSet: false, gchatSendCommandText: false }] };
const html = (el: ReactElement, lang: Lang = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const tab = (v: SkillsMcpView | undefined, open: string | null = null, lang: Lang = 'vi', log: string | null = null, graph?: GraphToolState) =>
  html(<McpTab view={v} snap={SNAP} graph={graph} open={open} onOpen={() => {}} log={log} onLog={() => {}} act={() => {}} connected />, lang);

describe('§6 sheet head: tabs MCP · n / Skills · n / Bộ công cụ · n / Thư mục chung with C25 badges', () => {
  test('§6 C25 badge = that tab\'s red and yellow numbers, own icons; no badge when 0; v2.5 Bộ công cụ = its row count, no badge', () => {
    const tk: ToolkitView = { rows: [{ key: 'vercel', kind: 'plugin', state: 'missing', mcpLoginIds: [] }, { key: 'context7', kind: 'plugin', state: 'missing', mcpLoginIds: [] }] };
    const h = html(<SheetHead view={view()} toolkit={tk} graph={undefined} tab="mcp" onTab={() => {}} onClose={() => {}} />);
    const t = text(h);
    expect(t).toMatch(/MCP 7 .*1 .*1 .*Skills 0 .*4 Bộ công cụ 2 Graph code Thư mục chung .*1/);
    expect(h).toMatch(/aria-selected="true"[^>]*>MCP/);
    expect(h.match(/class="b red"/g)?.length).toBe(1);
    expect(h.match(/class="b yel"/g)?.length).toBe(3);
  });
  test('v2.5 Graph code = its project count (none on GR0 / GR0-old) + the red number of counts.graph (GR-err)', () => {
    const v = view();
    const gv = (state: 'ready' | 'old'): GraphView => ({ tool: { state, version: '0.12.1' }, projects: [{ projectId: 'a', name: 'a', on: true, git: true, state: 'none', lanes: { n: 0, bytes: 0 } }] });
    const err = { ...v, counts: { ...v.counts, graph: { red: 1, yellow: 0 } } };
    const g = (gr: GraphView, vv = v) => html(<SheetHead view={vv} toolkit={undefined} graph={gr} tab="graph" onTab={() => {}} onClose={() => {}} />);
    expect(text(g(gv('ready')))).toMatch(/Graph code 1 Thư mục chung/);
    expect(text(g(gv('old')))).toMatch(/Graph code Thư mục chung/);
    expect(g(gv('ready'), err)).toMatch(/Graph code<span class="n">1<\/span><span class="b red">.*?1<\/span><\/button>/);
    expect(g(gv('ready'))).toMatch(/aria-selected="true"[^>]*>Graph code/);
  });
});

describe('§6 K1 MCP list', () => {
  test('§6 K1 summary + groups in order Cần xem → Dùng cho lane → Tắt cho lane → Không dùng trong lane, cc_slaves locked', () => {
    const t = text(tab(view()));
    expect(t).toContain('7 server · 4 bật cho lane · 54 công cụ · áp dụng từ lần chạy sau của mỗi lane');
    expect(t).toMatch(/Cần xem 2 .*postgres.*context7.*Dùng cho lane 3 .*cc_slaves .*của cc-slaves · luôn bật.*onedevtool.*miro.*Tắt cho lane 1 .*codebase-memory-mcp.*Không dùng trong lane 1 .*hcm/);
  });
  test('§6 K1 row: status text + mono name + source label + run + tools + switch; plugin rows show the plugin name', () => {
    const t = text(tab(view()));
    expect(t).toMatch(/Cần đăng nhập context7 plugin context7 từ xa — Đăng nhập/);
    expect(t).toMatch(/Đã kết nối miro local hagenta từ xa 14 công cụ/);
    expect(t).toContain('Chưa đăng nhập · lane báo cần đăng nhập — đăng nhập một lần cho mọi account');
    expect(t).toContain('Tắt cho lane · lưu trong cc-slaves · terminal không bị ảnh hưởng');
  });
  test('§6 K1 "Lane" switch is a labelled switch carrying the state', () => {
    const h = tab(view());
    expect(h).toContain('role="switch" aria-checked="true" aria-label="Dùng cho lane: onedevtool"');
    expect(h).toContain('role="switch" aria-checked="false" aria-label="Dùng cho lane: codebase-memory-mcp"');
  });
  test('§6 K1-local the why-line, never in a lane, no switch', () => {
    const h = tab(view());
    expect(text(h)).toContain('local ~ · không dùng trong lane — Claude Code chỉ dùng MCP local khi chạy đúng thư mục ~ (/Users/x); lane chạy trong project');
    expect(h).not.toContain('aria-label="Dùng cho lane: hcm"');
  });
  test('§6 K7 pending project entry: where it is new, the command it will run (secret masked), Bật cho lane / Để tắt', () => {
    const t = text(tab(view()));
    expect(t).toMatch(/Chờ duyệt postgres project hagenta · mới trong hagenta\/\.mcp\.json/);
    expect(t).toContain('npx -y @modelcontextprotocol/server-postgres postgresql://app:••••@localhost:5432/hagenta');
    expect(t).toMatch(/Bật cho lane .*Để tắt/);
  });
  test('§5.3 a bad_name row explains the control char (escaped name) in its why-line and detail, never a switch-on reason', () => {
    const bad = row('evil\\nx', { id: 'project:p1:evil\nx', source: 'project', projectId: 'p1', forLanes: false, editable: false, status: 'unchecked', tools: null,
      error: { code: 'bad_name', name: 'evil\\nx' } });
    const t = text(tab(view({ mcp: { rows: [bad], servers: 1, forLanes: 0, tools: 0 } }), bad.id));
    expect(t.match(/Tên server evil\\nx có ký tự điều khiển — server không vào lane, không đăng nhập được/g)?.length).toBe(2);
    expect(t).not.toContain('Biến evil');
  });
  test('§6 K1-claudeai the last dim line', () => {
    expect(text(tab(view()))).toContain('Connector claude.ai: không dùng trong lane — mỗi account một bộ');
  });
  test('§6 C25 F-I1 cc_slaves is a counted row: its tool count in the tools cell, the group badge = rows shown', () => {
    const t = text(tab(view()));
    expect(t).toMatch(/Đã kết nối cc_slaves của cc-slaves cục bộ 2 công cụ/);
    const h = tab(view());
    expect(h).not.toContain('aria-label="Dùng cho lane: cc_slaves"');
    expect(h).not.toContain('aria-label="Thao tác với cc_slaves"');
  });
  test('§6 K1-empty F-I1 / F-M3 only cc_slaves left: counted row, no group header, centred block with hint + CTA', () => {
    const h = tab(view({ mcp: { rows: [CC], servers: 1, forLanes: 1, tools: 2 } }));
    const t = text(h);
    expect(t).toContain('1 server · 1 bật cho lane · 2 công cụ');
    expect(t).not.toContain('Dùng cho lane 0');
    expect(t).not.toMatch(/Dùng cho lane \d/);
    expect(t).toMatch(/cc_slaves .*Chưa có MCP nào ngoài cc-slaves\. Dán JSON từ README của server, hoặc điền form\. Thêm MCP/);
    expect(h.match(/Thêm MCP/g)?.length).toBe(2);
  });
  test('§6 K1-load F-M3 column header + reading line + skeleton of 4 rows while the catalog builds', () => {
    const h = tab(undefined);
    expect(h.match(/class="skel"/g)?.length).toBe(4);
    expect(text(h)).toMatch(/Trạng thái Tên Nguồn Chạy Công cụ .*Lane .*Đang đọc ~\/\.claude\.json, plugin và \.mcp\.json của 1 project…/);
  });
  test('§6 K2-zero F-M4 a 0-tool row on for lanes: ⚠ icon on status and tool cell, never the green check', () => {
    const zero = row('miro-zero', { tools: 0 });
    const h = tab(view({ mcp: { rows: [zero], servers: 1, forLanes: 1, tools: 0 } }));
    expect(h).toMatch(/<span class="st warn"><svg[^>]*>[^]*?<\/svg>Đã kết nối<\/span>/);
    expect(h).toMatch(/<span class="tools mono warn"><svg[^>]*>[^]*?<\/svg>0 công cụ<\/span>/);
    expect(h).not.toContain('class="st ok"');
  });
  test('§6 K2-err F-I4 no lane report: "Kiểm tra lúc {time}: {cause} — {fix}" on the row and in "Lỗi cuối", no "—" placeholders', () => {
    const pg = row('pg-local', { status: 'error', tools: null, probe: { state: 'error', tools: [], at: AT(14, 8),
      error: { code: 'spawn', key: 'skillsMcp.mcpErr.spawn', fix: 'skillsMcp.mcpFix.spawn', detail: 'npx ENOENT' } } });
    const t = text(tab(view({ mcp: { rows: [pg], servers: 1, forLanes: 1, tools: 0 } }), pg.id));
    const line = 'Kiểm tra lúc 14:08: Không chạy được lệnh: npx ENOENT — Không có file ở đường dẫn lệnh — cài lại chương trình, hoặc sửa lệnh';
    expect(t.split(line).length - 1).toBe(2);
    expect(t).not.toContain('Lane —');
    expect(t).not.toContain('lúc —');
  });
  test('§6 K14 unreadable ~/.claude.json → band with the line + "Mở file"', () => {
    const t = text(tab(view({ claudeJson: { ok: false, line: 120, rev: 'r2', path: '/Users/me/.claude.json' } })));
    expect(t).toContain('Không đọc được ~/.claude.json (dòng 120) — lane dùng bộ đọc được lần cuối');
    expect(t).toContain('Mở file');
  });
  test('§6 K14 engine lost → the sheet is dimmed with "Mất kết nối engine"', () => {
    const h = html(<McpTab view={view()} snap={SNAP} open={null} onOpen={() => {}} log={null} onLog={() => {}} act={() => {}} connected={false} />);
    expect(text(h)).toContain('Mất kết nối engine');
  });
  test('§5.4b `claude` missing → add locked, the install command shown', () => {
    const h = tab(view({ claude: { found: false, install: 'npm i -g x' } }));
    expect(text(h)).toContain('Không tìm thấy `claude` — thêm / sửa / xoá bị khoá. Cài: npm i -g x');
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>.*Thêm MCP/);
  });
  test('§5.4 a lost restore → band + "Chép JSON cũ"', () => {
    const t = text(tab(view({ lost: [{ name: 'linear', json: '{}', command: 'claude mcp add-json -s user linear \'{}\'' }] })));
    expect(t).toContain('Server linear đang không có trong ~/.claude.json');
    expect(t).toContain('Chép JSON cũ');
  });
});

describe('v2.5 §6.1 K1-graph + Z20 in the MCP tab', () => {
  test('K1-graph module ready: codebase-memory-mcp locked in Dùng cho lane, "của cc-slaves · quản lý ở Graph code", no switch, no menu', () => {
    const h = tab(view(), null, 'vi', null, 'ready');
    const t = text(h);
    expect(t).toMatch(/Dùng cho lane 4 Đã kết nối cc_slaves .*luôn bật Đã kết nối codebase-memory-mcp của cc-slaves cục bộ 14 công cụ của cc-slaves · quản lý ở Graph code Đã kết nối onedevtool .*Không dùng trong lane 1/);
    expect(t).not.toContain('Tắt cho lane');
    expect(t).not.toMatch(/Tắt cho lane 1 .*codebase-memory-mcp/);
    expect(h).not.toContain('aria-label="Dùng cho lane: codebase-memory-mcp"');
    expect(h).not.toContain('aria-label="Thao tác với codebase-memory-mcp"');
    expect(h).toMatch(/<button[^>]*class="lnk grlock"[^>]*>của cc-slaves · quản lý ở Graph code/);
  });
  test('K1-graph module not ready (missing / old / error / updating): the v2.2 user row, switch and menu back', () => {
    for (const st of [undefined, 'missing', 'old', 'error', 'updating'] as const) {
      const h = tab(view(), null, 'vi', null, st);
      expect(h).toContain('role="switch" aria-checked="false" aria-label="Dùng cho lane: codebase-memory-mcp"');
      expect(h).not.toContain('quản lý ở Graph code');
    }
  });
  test('K1-graph in English', () => {
    expect(text(tab(view(), null, 'en', null, 'ready'))).toContain("cc-slaves' own · managed in Graph code");
  });
  test('Z20 a row "Đăng nhập" is a plain button; the only primaries are "Thêm MCP" and K7 "Bật cho lane"', () => {
    const h = tab(view());
    expect(h.match(/class="btn pri"/g)?.length).toBe(2);
    expect(h).toMatch(/<button class="btn"><svg[^>]*>[^]*?<\/svg> Đăng nhập<\/button>/);
  });
});

describe('§6 K2 detail opens in place under its row', () => {
  test('§6 K2 config with secrets masked, source file, id, last lane report, lanes using it', () => {
    const t = text(tab(view(), 'user:onedevtool'));
    expect(t).toContain('npx');
    expect(t).toContain('TOKEN=••••');
    expect(t).not.toContain('s3cret');
    expect(t).toContain('~/.claude.json');
    expect(t).toContain('user:onedevtool');
    expect(t).toContain('Lane đang dùng: D2, B3');
  });
  test('§6 K2 last lane report "D2 lúc 13:05: đã kết nối, 14 công cụ"', () => {
    expect(text(tab(view(), 'local:p1:miro'))).toContain('D2 lúc 13:05: đã kết nối, 14 công cụ');
  });
  const names = Array.from({ length: 14 }, (_, i) => `tool_${String(i).padStart(2, '0')}`);
  const miro = row('miro', { id: 'local:p1:miro', source: 'local', projectId: 'p1', kind: 'http', tools: 14, editable: false, config: { type: 'http', url: 'https://mcp.miro.com' },
    probe: { state: 'connected', tools: names, error: null, at: AT(13, 4) },
    oauth: { loggedIn: true, expiresAt: AT(14, 5), refreshedAt: AT(13, 5), needsLogin: null, keychainFailed: false, login: null, error: null } });
  test('§6 K2 F-I2 login block from `oauth`: "Đã đăng nhập · làm mới lúc 13:05 · hết hạn 14:05"', () => {
    const t = text(tab(one(miro), miro.id));
    expect(t).toContain('Đăng nhập Đã đăng nhập · làm mới lúc 13:05 · hết hạn 14:05');
    const out = { ...miro, oauth: { ...miro.oauth!, loggedIn: false, expiresAt: null, refreshedAt: null, needsLogin: { reason: 'no_token' as const, scope: null } } };
    expect(text(tab(one(out), miro.id))).toContain('Đăng nhập Chưa đăng nhập');
    expect(text(tab(one({ ...miro, oauth: undefined }), miro.id))).not.toContain('Chưa đăng nhập');
  });
  test('§6 K2 F-I2 "Công cụ · n" from the last check, folded after 12 with "Hiện n công cụ nữa"', () => {
    const t = text(tab(one(miro), miro.id));
    expect(t).toContain('Công cụ · 14');
    expect(t).toContain('tool_11');
    expect(t).not.toContain('tool_12');
    expect(t).toContain('Hiện 2 công cụ nữa');
    const few = text(tab(one({ ...miro, probe: { ...miro.probe!, tools: names.slice(0, 12) } }), miro.id));
    expect(few).toContain('tool_11');
    expect(few).not.toContain('công cụ nữa');
  });
  test('§5.4b K2 R-I2 no check yet: "Công cụ · n" from the last lane init tool names; else the newer of check / lane report', () => {
    const li = { projectId: 'p1', lane: 'D2', state: 'connected', tools: 14, toolNames: names, at: AT(13, 5) };
    const t = text(tab(one({ ...miro, probe: null, lastInit: li }), miro.id));
    expect(t).toContain('Công cụ · 14');
    expect(t).toContain('tool_11');
    expect(t).toContain('Hiện 2 công cụ nữa');
    expect(text(tab(one({ ...miro, lastInit: { ...li, at: AT(13, 3), toolNames: ['zz_only'] } }), miro.id))).not.toContain('zz_only');
    expect(text(tab(one({ ...miro, lastInit: { ...li, toolNames: ['zz_only'] } }), miro.id))).toContain('zz_only');
    const failed = { ...miro, probe: { state: 'error' as const, tools: [], error: null, at: AT(13, 9) }, lastInit: li };
    expect(text(tab(one(failed), miro.id))).not.toContain('Công cụ ·');
    expect(text(tab(one({ ...miro, probe: null, lastInit: { ...li, tools: 0, toolNames: [] } }), miro.id))).not.toContain('Công cụ ·');
  });
  test('§6 K2 R-I2 a connected remote server that is not logged in and needs no login: no "Chưa đăng nhập" block', () => {
    const free = { ...miro, status: 'connected' as const, oauth: { ...miro.oauth!, loggedIn: false, expiresAt: null, refreshedAt: null, needsLogin: null } };
    const t = text(tab(one(free), miro.id));
    expect(t).not.toContain('Chưa đăng nhập');
    expect(t).not.toMatch(/ĐĂNG NHẬP|Đăng nhập Chưa/);
    const need = { ...free, status: 'needs_login' as const, oauth: { ...free.oauth, needsLogin: { reason: 'no_token' as const, scope: null } } };
    expect(text(tab(one(need), miro.id))).toContain('Đăng nhập Chưa đăng nhập');
    expect(text(tab(one({ ...free, status: 'error' as const }), miro.id))).toContain('Đăng nhập Chưa đăng nhập');
  });
  test('§6 K2 F-I2 buttons Kiểm tra · Xem log · Mở file nguồn; log open → the proxy lines (or the empty line)', () => {
    expect(text(tab(one(miro), miro.id))).toMatch(/Kiểm tra .*Xem log .*Mở file nguồn/);
    expect(text(tab(one(miro), miro.id, 'vi', miro.id))).toMatch(/Log Chưa có dòng log nào .*Ẩn log/);
    const lines = [{ at: AT(13, 6), method: 'POST', path: '/mcp', status: 504, ms: 30000, error: { code: 'timeout', key: 'skillsMcp.mcpErr.timeout', fix: 'skillsMcp.mcpFix.timeout', detail: null } }];
    const t = text(html(<McpLog lines={lines} />));
    expect(t).toContain('13:06 POST /mcp 504 30,0 s Hết giờ — server không trả lời');
  });
});

describe('§6 K1-menu / K1-src row menu', () => {
  const plug = ROWS[2]!;
  test('§6 K1-src F-I3 plugin row: Đăng nhập · Kiểm tra · Xem log · Mở file nguồn · "Sửa / xoá trong plugin" note; no Sửa / Xoá', () => {
    expect(rowMenu(plug, '/p/context7/.mcp.json')).toEqual(['login', 'check', 'log', 'open', 'pluginNote']);
  });
  test('§6 K1-menu F-I2 logged-in user row: Kiểm tra · Sửa · Đăng nhập lại · Đăng xuất · Xem log · Mở file nguồn · Xoá', () => {
    const r = row('vercel-team', { kind: 'http', oauth: { loggedIn: true, expiresAt: null, refreshedAt: null, needsLogin: null, keychainFailed: false, login: null, error: null } });
    expect(rowMenu(r, '/h/.claude.json')).toEqual(['check', 'edit', 'login', 'logout', 'log', 'open', 'remove']);
  });
  test('§6 K1-local / cc_slaves: no log; the local entry keeps "Mở file nguồn"', () => {
    expect(rowMenu({ ...ROWS[5]!, canCheck: false }, '/h/.claude.json')).toEqual(['open']);
    expect(rowMenu(CC, null)).toEqual([]);
    // orchestrator ruling: the log is the proxy's — a stdio row has none, so no "Xem log"
    expect(rowMenu({ ...plug, kind: 'stdio' }, '/p/context7/.mcp.json')).not.toContain('log');
  });
  test('§6 K1-src F-I3 rowSourcePath of a plugin row = its sourceFile', () => {
    expect(rowSourcePath({ ...plug, sourceFile: '/p/x/plugin.json' }, SNAP.projects, '/h/.claude.json')).toBe('/p/x/plugin.json');
    expect(rowSourcePath(plug, SNAP.projects, '/h/.claude.json')).toBeNull();
  });
  test('§6 K2 F-I3 plugin detail: "Mở file nguồn" + the "Sửa / xoá trong plugin context7" note', () => {
    const t = text(tab(one({ ...plug, sourceFile: '/p/context7/.mcp.json' }), plug.id));
    expect(t).toMatch(/Mở file nguồn .*Sửa \/ xoá trong plugin context7/);
    expect(t).toContain('/p/context7/.mcp.json');
  });
});

describe('§6 K4 / K5 / K6 dialogs', () => {
  const add = (o: { edit?: McpRowView } = {}) => html(<McpAddDialog view={view()} edit={o.edit ?? null} lanes={[]} send={() => Promise.resolve(null)} onClose={() => {}} />);
  test('§6 K4 two tabs, Dán JSON default, "Sẽ chạy:" shown', () => {
    const h = add();
    expect(text(h)).toMatch(/Thêm MCP .*Dán JSON .*Điền form/);
    expect(h).toMatch(/aria-selected="true"[^>]*>.*Dán JSON/);
    expect(text(h)).toContain('Lưu xong tự kiểm tra');
  });
  test('§6 K5 edit: form filled, two commands + restore note; remote → terminal re-login line', () => {
    const r = row('vercel-team', { kind: 'http', config: { type: 'http', url: 'https://mcp.vercel.com/team' } });
    const t = text(add({ edit: r }));
    expect(t).toContain('Sửa vercel-team');
    expect(t).toContain('claude mcp remove -s user vercel-team');
    expect(t).toContain(`claude mcp add-json -s user vercel-team '{"type":"http","url":"https://mcp.vercel.com/team"}'`);
    expect(t).toContain('Bước 2 hỏng → tự thêm lại entry cũ rồi đọc lại; server không bao giờ bị mất.');
    expect(t).toContain('Terminal / VS Code sẽ phải đăng nhập lại vercel-team một lần');
  });
  test('§6 K6 remove: terminal loses it too, lanes in use, the command, red Xoá', () => {
    const t = text(html(<McpRemoveDialog row={row('linear')} lanes={['D2', 'B3']} rev="r1" send={() => Promise.resolve(null)} onClose={() => {}} />));
    expect(t).toContain('Xoá linear?');
    expect(t).toContain('Xoá khỏi ~/.claude.json — terminal cũng mất server này.');
    expect(t).toContain('Lane D2, B3 đang dùng: mất từ lần chạy sau.');
    expect(t).toContain('claude mcp remove -s user linear');
  });
});

describe('§6 K4 / K5 ux-fix-b: Đăng nhập segment, check line, write errors, URL change lanes', () => {
  const edit = (r: McpRowView) => html(<McpAddDialog view={view()} edit={r} lanes={['D2']} send={() => Promise.resolve(null)} onClose={() => {}} />);
  const checked = (h: string) => [...h.matchAll(/role="radio" aria-checked="true"[^>]*>(?:<svg.*?<\/svg>)?\s*([^<]+)</g)].map(m => m[1]!.trim());
  test('§6 K4-form / K5 remote form: "Đăng nhập" Tự động (OAuth) / Không / Client ID, the current mode checked', () => {
    const auto = edit(row('vt', { kind: 'http', config: { type: 'http', url: 'https://v.test/mcp' } }));
    expect(text(auto)).toMatch(/Đăng nhập Tự động \(OAuth\) Không Client ID/);
    expect(checked(auto)).toEqual(['Từ xa (URL)', 'Tự động (OAuth)']);
    expect(checked(edit(row('vt', { kind: 'http', noLogin: true, config: { type: 'http', url: 'https://v.test/mcp' } })))).toContain('Không');
    const cid = edit(row('vt', { kind: 'http', config: { type: 'http', url: 'https://v.test/mcp', oauth: { clientId: 'c-9' } } }));
    expect(checked(cid)).toContain('Client ID');
    expect(cid).toMatch(/value="c-9"/);
    expect(text(cid)).toContain('Client secret (tuỳ chọn)');
    expect(text(edit(row('pw')))).not.toContain('Đăng nhập');
  });
  test('§6 K4 / R-M3 check line of a local edit before the PATH answer: "giữ tên" (not "tên chưa có"), no PATH claim', () => {
    expect(text(edit(row('pw')))).toContain('giữ tên');
    expect(text(edit(row('pw')))).not.toContain('tên chưa có');
    expect(text(edit(row('pw')))).not.toContain('PATH');
  });
  test('§6 K4e-race red block on top: the title + "Đã ghi rồi đọc lại 2 lần…"', () => {
    const h = html(<WriteErrorBlock err={{ key: 'skillsMcp.err.busy', params: {}, text: 'Claude Code đang ghi ~/.claude.json (một phiên terminal đang mở?) — thử lại' }} />);
    expect(h).toMatch(/class="band k4e bad" role="alert"/);
    expect(text(h)).toContain('Claude Code đang ghi ~/.claude.json (một phiên terminal đang mở?) — thử lại Đã ghi rồi đọc lại 2 lần: entry chưa khớp.');
  });
  test('§6 K4e-restore block with the exit text; a read-back mismatch (exit 0) says so', () => {
    const t = (p: Record<string, string | number>) => text(html(<WriteErrorBlock err={{ key: 'skillsMcp.err.restored', params: { name: 'vt', ...p }, text: 'Không ghi được bản mới — đã khôi phục entry cũ' }} />));
    expect(t({ exit: 1, detail: 'MCP server vt already exists' })).toContain('`claude mcp add-json` trả exit 1 (MCP server vt already exists). Đã thêm lại bản cũ và đọc lại: khớp. Terminal và lane vẫn có vt.');
    expect(t({ exit: 0, detail: '' })).toContain('chạy xong nhưng đọc lại chưa khớp');
  });
  test('§6 K5 URL change names the lanes that lose the server until the login', () => {
    expect(text(html(<UrlChangedBand lanes={['D2', 'B3']} />))).toContain('Đổi URL: đăng nhập hiện tại sẽ bị bỏ Lưu xong cần đăng nhập lại một lần. Lane D2, B3 mất công cụ của server này tới khi đăng nhập.');
    expect(text(html(<UrlChangedBand lanes={[]} />))).not.toContain('Lane');
  });
});

describe('§6 K15 / E2E_LANG=en K1 in English', () => {
  test('§6A K1 en: summary, groups, statuses', () => {
    const t = text(tab(view(), null, 'en'));
    expect(t).toContain('7 servers · 4 on for lanes · 54 tools · applies from each lane\'s next run');
    expect(t).toMatch(/Needs review 2 .*Used by lanes 3 .*Off for lanes 1 .*Not used in lanes 1/);
    expect(t).toContain('Needs login');
  });
});
