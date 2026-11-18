// v2.2 §6 Skills & MCP pure logic (web/src/lib/skills-mcp.ts): C25 number → tab, K1 groups, K2 masking, K4 paste parse,
// K4 / K5 "Sẽ chạy:" preview, K6 lanes in use, K0 hover line.
import { describe, expect, test } from 'bun:test';
import { makeT } from '../../shared/i18n/index.ts';
import type { McpRowView, SkillsMcpCounts } from '../../shared/protocol.ts';
import { isGraphEntry } from '../../shared/graph.ts';
import { addJsonCmd, checkParts, draftOf, editPlan, formConfig, graphLocked, lanesUsing, maskConfig, mcpGroups, parsePaste, rowActs, rowIssue, type FormDraft } from '../src/lib/skills-mcp-sheet.ts';
import { firstIssueTab, k0LevelTitle, k0Title } from '../src/lib/skills-mcp.ts';
import { lane } from './fixtures.ts';

const VI = makeT('vi');
const c = (mcp: [number, number], skills: [number, number], shared: [number, number]): SkillsMcpCounts => ({
  mcp: { red: mcp[0], yellow: mcp[1] }, skills: { red: skills[0], yellow: skills[1] }, shared: { red: shared[0], yellow: shared[1] },
  total: { red: mcp[0] + skills[0] + shared[0], yellow: mcp[1] + skills[1] + shared[1] },
});
const row = (name: string, over: Partial<McpRowView> = {}): McpRowView => ({
  id: `user:${name}`, name, source: 'user', kind: 'stdio', projectId: null, plugin: null, config: { command: 'npx' }, forLanes: true,
  pending: false, unused: null, editable: true, status: 'connected', tools: 3, error: null, lastInit: null,
  canCheck: true, checking: false, probe: null, log: [], ...over,
});

describe('§6 C25 a red / yellow number opens the tab of the first issue of that level', () => {
  test('§6 C25 yellow: MCP has none → Skills; Skills has none → Thư mục chung', () => {
    expect(firstIssueTab(c([2, 0], [0, 4], [0, 1]), 'yellow')).toBe('skills');
    expect(firstIssueTab(c([2, 0], [0, 0], [0, 1]), 'yellow')).toBe('shared');
    expect(firstIssueTab(c([0, 1], [0, 4], [0, 1]), 'yellow')).toBe('mcp');
  });
  test('§6 C25 red: MCP first; no issue of that level → MCP (C17)', () => {
    expect(firstIssueTab(c([2, 0], [0, 4], [0, 0]), 'red')).toBe('mcp');
    expect(firstIssueTab(c([0, 0], [1, 0], [0, 0]), 'red')).toBe('skills');
    expect(firstIssueTab(c([0, 0], [0, 0], [0, 0]), 'red')).toBe('mcp');
  });
});

describe('§6 K1 groups: Cần xem → Dùng cho lane → Tắt cho lane → Không dùng trong lane', () => {
  const rows = [
    row('onedev'), row('context7', { status: 'needs_login', tools: null, source: 'plugin', editable: false }),
    row('postgres', { source: 'project', projectId: 'p1', pending: true, forLanes: false, status: 'unchecked', tools: null }),
    row('zero', { tools: 0 }), row('cbm', { forLanes: false }), row('hcm', { source: 'local', forLanes: false, unused: { path: '/Users/x' } }),
    row('offbroken', { forLanes: false, status: 'error' }),
  ];
  test('§6 K1 review = the C25 rows (pending first), off-for-lanes / unused never in Cần xem', () => {
    const g = mcpGroups(rows);
    expect(g.review.map(r => r.name)).toEqual(['postgres', 'context7', 'zero']);
    expect(g.used.map(r => r.name)).toEqual(['onedev']);
    expect(g.off.map(r => r.name)).toEqual(['cbm', 'offbroken']);
    expect(g.unused.map(r => r.name)).toEqual(['hcm']);
  });
  test('§6 C25 row level: needs login red, 0 tools yellow, off for lanes none', () => {
    expect(rowIssue(rows[1]!)).toBe('red');
    expect(rowIssue(rows[3]!)).toBe('yellow');
    expect(rowIssue(rows[2]!)).toBe('yellow');
    expect(rowIssue(rows[6]!)).toBeNull();
    expect(rowIssue(rows[0]!)).toBeNull();
  });
});

describe('§6 K0 hover line', () => {
  test('§6 K0 "2 MCP cần đăng nhập / lỗi · 4 skill lỗi · 1 account …"; nothing → plain title', () => {
    expect(k0Title(VI, c([2, 0], [0, 4], [0, 1]))).toBe('Skills & MCP · 2 MCP cần đăng nhập / lỗi · 4 skill lỗi · 1 account có link chung lỗi');
    expect(k0Title(VI, c([0, 1], [0, 0], [0, 0]))).toBe('Skills & MCP · 1 MCP cần xem');
    expect(k0Title(VI, c([0, 0], [0, 0], [0, 0]))).toBe('Skills & MCP');
  });
});

const g = (counts: SkillsMcpCounts, red: number): SkillsMcpCounts => ({ ...counts, graph: { red, yellow: 0 }, total: { ...counts.total, red: counts.total.red + red } });

describe('v2.5 §6.1 GR-k0 the graph line of the top-bar numbers', () => {
  test('GR-k0 only the graph is red → its number opens Graph code; MCP / Skills red come first, Thư mục chung after', () => {
    expect(firstIssueTab(g(c([0, 1], [0, 4], [0, 1]), 1), 'red')).toBe('graph');
    expect(firstIssueTab(g(c([2, 0], [0, 4], [0, 1]), 1), 'red')).toBe('mcp');
    expect(firstIssueTab(g(c([0, 0], [1, 0], [0, 0]), 1), 'red')).toBe('skills');
    expect(firstIssueTab(g(c([0, 0], [0, 0], [1, 0]), 1), 'red')).toBe('graph');
    expect(firstIssueTab(g(c([0, 0], [0, 0], [0, 0]), 0), 'red')).toBe('mcp');
  });
  test('GR-k0 hover: "Graph code: codebase-memory-mcp không chạy được", ⓘ2 → ⓘ3 (the C25 total is the engine\'s)', () => {
    const k = g(c([2, 0], [0, 4], [0, 1]), 1);
    expect(k0LevelTitle(VI, k, 'red')).toBe('2 MCP cần đăng nhập / lỗi\nGraph code: codebase-memory-mcp không chạy được\nBấm: mở tab MCP');
    expect(k0LevelTitle(VI, g(c([0, 0], [0, 4], [0, 1]), 1), 'red')).toBe('Graph code: codebase-memory-mcp không chạy được\nBấm: mở tab Graph code');
    expect(k0LevelTitle(VI, g(c([0, 0], [0, 4], [0, 1]), 1), 'yellow')).not.toContain('Graph code');
    expect(k0Title(VI, k)).toBe('Skills & MCP · 2 MCP cần đăng nhập / lỗi · 4 skill lỗi · Graph code: codebase-memory-mcp không chạy được · 1 account có link chung lỗi');
    expect(k0Title(VI, g(c([0, 0], [0, 0], [0, 0]), 0))).toBe('Skills & MCP');
    expect(k0LevelTitle(makeT('en'), g(c([0, 0], [0, 0], [0, 0]), 1), 'red')).toBe('Graph code: codebase-memory-mcp is not running\nClick: opens the Graph code tab');
  });
});

describe('v2.5 §5.7 / §6.1 K1-graph the user\'s codebase-memory-mcp row while the module is ready', () => {
  test('§5.7 the user\'s entry = named codebase-memory-mcp, or its command is the tool\'s file (by file name)', () => {
    expect(isGraphEntry('codebase-memory-mcp', {})).toBe(true);
    expect(isGraphEntry('cbm', { command: '/Users/me/.local/bin/codebase-memory-mcp' })).toBe(true);
    expect(isGraphEntry('cbm', { command: 'codebase-memory-mcp' })).toBe(true);
    expect(isGraphEntry('cbm', { command: '/x/codebase-memory-mcp-old' })).toBe(false);
    expect(isGraphEntry('cbm', { command: 'npx', args: ['codebase-memory-mcp'] })).toBe(false);
  });
  test('K1-graph locked only while the module is `ready`; any other state → an ordinary user row (v2.2)', () => {
    const r = row('codebase-memory-mcp', { forLanes: false });
    expect(graphLocked(r, 'ready')).toBe(true);
    for (const st of ['missing', 'old', 'error', 'installing', 'updating', undefined] as const) expect(graphLocked(r, st)).toBe(false);
    expect(graphLocked(row('onedev'), 'ready')).toBe(false);
  });
  test('K1-graph the locked row sits in Dùng cho lane (mcp.offForLanes is not read for it) and never in Cần xem', () => {
    const rows = [row('onedev'), row('codebase-memory-mcp', { forLanes: false }), row('cbm2', { config: { command: '/b/codebase-memory-mcp' }, status: 'error' })];
    const ready = mcpGroups(rows, 'ready');
    expect(ready.used.map(r => r.name)).toEqual(['codebase-memory-mcp', 'cbm2', 'onedev']); // cc-slaves' own first
    expect(ready.review).toEqual([]);
    const old = mcpGroups(rows, 'old');
    expect(old.off.map(r => r.name)).toEqual(['codebase-memory-mcp']);
    expect(old.review.map(r => r.name)).toEqual(['cbm2']);
  });
});

describe('§6 K2 / K4 secrets are masked', () => {
  test('§6 K2 env and header values → ••••, command / url kept', () => {
    expect(maskConfig({ command: 'npx', env: { TOKEN: 'abc' }, headers: { Authorization: 'Bearer x' }, url: 'https://a' }))
      .toEqual({ command: 'npx', env: { TOKEN: '••••' }, headers: { Authorization: '••••' }, url: 'https://a' });
  });
  test('§6 K7 a password inside a URL (args or url) → ••••', () => {
    expect(maskConfig({ command: 'npx', args: ['-y', 'postgresql://app:pw@db:5432/x'], url: 'https://u:p@h/mcp' }))
      .toEqual({ command: 'npx', args: ['-y', 'postgresql://app:••••@db:5432/x'], url: 'https://u:••••@h/mcp' });
  });
  test('§6 K4 "Sẽ chạy:" add-json line with secrets masked, single quotes escaped', () => {
    expect(addJsonCmd('pw', { command: 'npx', args: ["it's"], env: { K: 'secret' } }))
      .toBe(`claude mcp add-json -s user pw '{"command":"npx","args":["it'\\''s"],"env":{"K":"••••"}}'`);
  });
});

describe('§6 K4 Dán JSON accepts {"mcpServers":{…}}, {"name":{…}} or one entry + name', () => {
  const taken = ['onedev'];
  test('§6 K4 mcpServers wrapper', () => {
    expect(parsePaste('{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}', '', taken))
      .toEqual({ ok: true, servers: [{ name: 'playwright', config: { command: 'npx', args: ['@playwright/mcp@latest'] } }] });
  });
  test('§6 K4 name map and single entry (name from the field)', () => {
    expect(parsePaste('{"linear":{"type":"http","url":"https://mcp.linear.app/mcp"}}', '', taken)).toMatchObject({ ok: true, servers: [{ name: 'linear' }] });
    expect(parsePaste('{"url":"https://x.test/mcp"}', 'xt', taken)).toEqual({ ok: true, servers: [{ name: 'xt', config: { url: 'https://x.test/mcp' } }] });
  });
  test('§4.4 blocked before writing: bad JSON, taken name, no command / url, non-http url, missing name, bad name', () => {
    expect(parsePaste('{"a":', '', taken)).toEqual({ ok: false, err: 'badJson', line: 1, col: 6 });
    expect(parsePaste('{"onedev":{"command":"x"}}', '', taken)).toEqual({ ok: false, err: 'nameTaken', name: 'onedev' });
    expect(parsePaste('{"x":{"foo":1}}', '', taken)).toEqual({ ok: false, err: 'badEntry', name: 'x' });
    expect(parsePaste('{"x":{"url":"ftp://a"}}', '', taken)).toEqual({ ok: false, err: 'badUrl', name: 'x' });
    expect(parsePaste('{"command":"npx"}', '', taken)).toEqual({ ok: false, err: 'needName' });
    expect(parsePaste('{"-x":{"command":"npx"}}', '', taken)).toEqual({ ok: false, err: 'badName', name: '-x' });
    expect(parsePaste('', '', taken)).toEqual({ ok: false, err: 'empty' });
  });
});

describe('§6 K4-bad JSON error names line and column', () => {
  test('§6 K4-bad a missing comma → "dòng 4, cột 3" (where the parser stopped); text after the value → its position', () => {
    expect(parsePaste('{\n "pw": {\n  "command": "npx"\n  "args": []\n }\n}', '', [])).toEqual({ ok: false, err: 'badJson', line: 4, col: 3 });
    expect(parsePaste('{"a":{"command":"x"}} x', '', [])).toEqual({ ok: false, err: 'badJson', line: 1, col: 23 });
    expect(VI('skillsMcp.k4.err.badJson', { line: 4, col: 3 })).toBe('JSON sai ở dòng 4, cột 3 — kiểm dấu ngoặc / dấu phẩy');
  });
});

const D: FormDraft = { kind: 'local', command: '', args: '', env: '', url: '', headers: '', login: 'auto', clientId: '', clientSecret: '', oauthKeep: {} };
describe('§6 K4 Điền form → entry', () => {
  test('§6 K4 local: command + args split on spaces + KEY=value env lines', () => {
    expect(formConfig({ ...D, command: 'npx', args: '-y  @x/mcp', env: 'A=1\nB = two\n' }))
      .toEqual({ command: 'npx', args: ['-y', '@x/mcp'], env: { A: '1', B: 'two' } });
  });
  test('§6 K4 remote: http url + "Name: value" headers; empty parts left out', () => {
    expect(formConfig({ ...D, kind: 'remote', url: 'https://a.test/mcp', headers: 'X-Key: k1' }))
      .toEqual({ type: 'http', url: 'https://a.test/mcp', headers: { 'X-Key': 'k1' } });
    expect(formConfig({ ...D, kind: 'remote', url: 'https://a.test/mcp' })).toEqual({ type: 'http', url: 'https://a.test/mcp' });
  });
  test('§6 K4 "Đăng nhập": Client ID → entry oauth.clientId (secret never in the entry); Tự động / Không → no oauth key', () => {
    const r = { ...D, kind: 'remote' as const, url: 'https://a.test/mcp', clientId: ' cid ', clientSecret: 's' };
    expect(formConfig({ ...r, login: 'client' })).toEqual({ type: 'http', url: 'https://a.test/mcp', oauth: { clientId: 'cid' } });
    expect(formConfig({ ...r, login: 'none' })).toEqual({ type: 'http', url: 'https://a.test/mcp' });
    expect(formConfig({ ...r, login: 'auto' })).toEqual({ type: 'http', url: 'https://a.test/mcp' });
    expect(formConfig({ ...r, login: 'client', clientId: '' })).toEqual({ type: 'http', url: 'https://a.test/mcp' });
  });
  test('§6 K5 the form filled back: oauth.clientId → Client ID; a noLogin row → Không; else Tự động (an entry oauth key is kept on save)', () => {
    expect(draftOf({ type: 'http', url: 'https://a', oauth: { clientId: 'c1', callbackPort: 8080 } }, false)).toMatchObject({ login: 'client', clientId: 'c1' });
    expect(formConfig(draftOf({ type: 'http', url: 'https://a', oauth: { clientId: 'c1', callbackPort: 8080 } }, false))).toEqual({ type: 'http', url: 'https://a', oauth: { clientId: 'c1', callbackPort: 8080 } });
    expect(draftOf({ type: 'http', url: 'https://a' }, true)).toMatchObject({ login: 'none', clientId: '' });
    expect(draftOf({ type: 'http', url: 'https://a' }, false)).toMatchObject({ login: 'auto' });
  });
});

describe('§6 K4 check line', () => {
  const pw = { name: 'playwright', config: { command: 'npx', args: ['@playwright/mcp@latest'] } };
  const line = (p: ReturnType<typeof checkParts>) => p.parts.map(x => VI(x.key, x.params)).join(' · ');
  test('§6 K4 paste: "1 server: playwright · cục bộ · npx có trên PATH (/opt/homebrew/bin/npx) · tên chưa có"', () => {
    const p = checkParts([pw], false, { npx: '/opt/homebrew/bin/npx' }, null);
    expect(line(p)).toBe('1 server: playwright · cục bộ · npx có trên PATH (/opt/homebrew/bin/npx) · tên chưa có');
    expect(p.missing).toEqual([]);
  });
  test('§6 K4 a command not on PATH → its own warning (not in the ok line); not looked up yet → nothing said', () => {
    expect(checkParts([pw], false, { npx: null }, null)).toMatchObject({ missing: ['npx'] });
    expect(line(checkParts([pw], false, { npx: null }, null))).toBe('1 server: playwright · cục bộ · tên chưa có');
    expect(line(checkParts([pw], false, {}, null))).toBe('1 server: playwright · cục bộ · tên chưa có');
  });
  test('§6 K5 R-M3 edit keeping its name: "giữ tên", never "tên chưa có"; a rename still says "tên chưa có"', () => {
    const vt = { name: 'vercel-team', config: { type: 'http', url: 'https://mcp.vercel.com/x' } };
    expect(line(checkParts([vt], true, {}, 'vercel-team'))).toBe('URL https hợp lệ · giữ tên');
    expect(line(checkParts([vt], true, {}, 'vercel'))).toBe('URL https hợp lệ · tên chưa có');
  });
  test('§6 K4-form remote: "URL https hợp lệ · tên chưa có"', () => {
    expect(line(checkParts([{ name: 'vt', config: { type: 'http', url: 'https://mcp.vercel.com/x' } }], true, {}, null))).toBe('URL https hợp lệ · tên chưa có');
  });
});

describe('§6 K5 edit preview', () => {
  test('§6 K5 two commands; a remote server warns the terminal re-login; a changed URL warns the login is dropped', () => {
    const p = editPlan('vt', 'vt', { type: 'http', url: 'https://a' }, { type: 'http', url: 'https://b' });
    expect(p.cmds).toEqual([`claude mcp remove -s user vt`, `claude mcp add-json -s user vt '{"type":"http","url":"https://b"}'`]);
    expect(p.remote).toBe(true);
    expect(p.urlChanged).toBe(true);
    const q = editPlan('pw', 'pw2', { command: 'npx' }, { command: 'npx' });
    expect(q.cmds[1]).toContain('add-json -s user pw2 ');
    expect([q.remote, q.urlChanged]).toEqual([false, false]);
  });
});

describe('§6 K6 lanes that use a server', () => {
  test('§6 K6 live lanes; a project server only its project; off for lanes → none', () => {
    const lanes = [lane('D2'), lane('B3', { projectId: 'p2' }), lane('X', { state: 'stopped' }), lane('Y', { state: 'done' })];
    expect(lanesUsing(row('linear'), lanes)).toEqual(['D2', 'B3']);
    expect(lanesUsing(row('pg', { projectId: 'p1', source: 'local' }), lanes)).toEqual(['D2']);
    expect(lanesUsing(row('off', { forLanes: false }), lanes)).toEqual([]);
  });
});

describe('§7 Account shows no MCP text (A6–A9 dialogs included)', () => {
  test('§7 A7 no accounts.* catalog string mentions MCP, in vi and en', async () => {
    for (const lang of ['vi', 'en']) {
      const cat = (await import(`../../shared/i18n/${lang}/accounts.json`)) as { default: Record<string, string> };
      expect(Object.entries(cat.default).filter(([, v]) => /MCP/.test(v))).toEqual([]);
    }
  });
});


describe('§5.3 / §5.4b row actions read the engine fields (oauth, canCheck)', () => {
  const oauth = (loggedIn: boolean): NonNullable<McpRowView['oauth']> =>
    ({ loggedIn, expiresAt: null, refreshedAt: null, needsLogin: null, keychainFailed: false, login: null, error: null });
  test('§5.3 login / logout only on a row with an OAuth state; logout only while logged in', () => {
    expect(rowActs(row('ws', { kind: 'ws' }))).toMatchObject({ login: false, logout: false });
    expect(rowActs(row('a', { kind: 'http', oauth: oauth(false) }))).toMatchObject({ login: true, logout: false });
    expect(rowActs(row('a', { kind: 'http', oauth: oauth(true) }))).toMatchObject({ login: true, logout: true });
  });
  test('§5.4b C22 "Kiểm tra" only when canCheck: primary falls back to none, the menu item hides', () => {
    expect(rowActs(row('a', { status: 'error' }))).toMatchObject({ inline: 'check', check: true });
    expect(rowActs(row('a', { status: 'error', canCheck: false }))).toMatchObject({ inline: null, check: false });
    expect(rowActs(row('a', { kind: 'http', status: 'needs_relogin', canCheck: false, oauth: oauth(true) })).inline).toBe('login');
    expect(rowActs(row('a', { status: 'unchecked', unused: { path: '/x' } })).inline).toBeNull();
  });
});
