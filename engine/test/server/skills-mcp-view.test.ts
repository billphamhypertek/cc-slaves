import { describe, expect, test } from 'bun:test';
import type { McpRowView, SkillIssueView } from '../../../shared/protocol.ts';
import { DEFAULT_CONFIG, type Config } from '../../src/config.ts';
import { buildCatalog, type CatalogEntry } from '../../src/mcp/catalog.ts';
import { buildCatalog as buildSkills, type SkillScan } from '../../src/skills/catalog.ts';
import { countIssues, skillsMcpView, type ViewInput } from '../../src/server/skills-mcp-view.ts';

type Row = Pick<McpRowView, 'name' | 'config' | 'forLanes' | 'pending' | 'status' | 'tools'>;
const row = (r: Partial<Row>): Row => ({ name: 'x', config: {}, forLanes: true, pending: false, status: 'connected', tools: 3, ...r });
const issue = (level: SkillIssueView['level'], acked = false) => ({ level, acked });

describe('§6 C25 issue-count table', () => {
  test('§6 C25 mockup default: MCP red 2 · Skills yellow 4 · shared yellow 1 → K0 red 2, yellow 5', () => {
    const c = countIssues({
      mcp: [row({ status: 'needs_login' }), row({ status: 'needs_login' }), row({}), row({ status: 'unchecked', tools: null })],
      skills: [issue('error'), issue('error'), issue('warn'), issue('warn'), issue('info')],
      sharedBad: 1,
    });
    expect(c).toEqual({ mcp: { red: 2, yellow: 0 }, skills: { red: 0, yellow: 4 }, shared: { red: 0, yellow: 1 }, total: { red: 2, yellow: 5 } });
  });

  test('§6 C25 red only when on for lanes: needs_login / needs_relogin / error; off-for-lanes never counts', () => {
    const c = countIssues({
      mcp: [row({ status: 'needs_relogin' }), row({ status: 'error' }), row({ status: 'error', forLanes: false }), row({ status: 'needs_login', forLanes: false })],
      skills: [], sharedBad: 0,
    });
    expect(c.mcp).toEqual({ red: 2, yellow: 0 });
  });

  test('§6 C25 yellow: connected with 0 tools (on for lanes) and K7 pending project entries', () => {
    const c = countIssues({ mcp: [row({ tools: 0 }), row({ tools: 0, forLanes: false }), row({ pending: true, forLanes: false, status: 'unchecked', tools: null })], skills: [], sharedBad: 0 });
    expect(c.mcp).toEqual({ red: 0, yellow: 2 });
  });

  test('§6 C25 C23 "Đã biết" and info (duplicate) issues are not counted', () => {
    const c = countIssues({ mcp: [], skills: [issue('warn', true), issue('info'), issue('warn')], sharedBad: 0 });
    expect(c.skills.yellow).toBe(1);
    expect(c.total).toEqual({ red: 0, yellow: 1 });
  });

  test('v2.5 §5.3 the graph module in `error` (graph on for ≥ 1 project) is one red in K0; no module → no graph line', () => {
    const c = countIssues({ mcp: [row({ status: 'error' })], skills: [], sharedBad: 0, graphRed: true });
    expect(c.graph).toEqual({ red: 1, yellow: 0 });
    expect(c.total).toEqual({ red: 2, yellow: 0 });
    expect(countIssues({ mcp: [], skills: [], sharedBad: 0, graphRed: false })).toMatchObject({ graph: { red: 0, yellow: 0 }, total: { red: 0, yellow: 0 } });
    expect(countIssues({ mcp: [], skills: [], sharedBad: 0 }).graph).toBeUndefined();
  });

  test('v2.5 §5.7 K1-graph: while the module is `ready` the user\'s codebase-memory-mcp row is cc-slaves\' own and never counts', () => {
    const graphRows = [row({ name: 'codebase-memory-mcp', status: 'error' }), row({ name: 'cbm', config: { command: '/u/.local/bin/codebase-memory-mcp' }, tools: 0 })];
    const other = row({ status: 'needs_login' });
    expect(countIssues({ mcp: [...graphRows, other], skills: [], sharedBad: 0, graphRed: false, graphReady: true }).mcp).toEqual({ red: 1, yellow: 0 });
    expect(countIssues({ mcp: [...graphRows, other], skills: [], sharedBad: 0, graphRed: true, graphReady: false }).mcp).toEqual({ red: 2, yellow: 1 });
    expect(countIssues({ mcp: [...graphRows, other], skills: [], sharedBad: 0 }).mcp).toEqual({ red: 2, yellow: 1 });
  });
});

const roots = [{ id: 'p1', path: '/w/hagenta' }];
const cfg = (patch: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...patch });
const claudeJson = {
  mcpServers: { vercel: { type: 'http', url: 'https://v.example/mcp' }, ctx: { command: 'npx' } },
  projects: { '/w/hagenta': { mcpServers: { miro: { type: 'http', url: 'https://m.example' } } }, '/Users/me': { mcpServers: { hcm: { command: 'hcm' } } } },
};
const scan: SkillScan = { home: '/h', userSkillsReal: '/h/.claude/skills', projects: [], entries: [
  { scope: 'user', owner: null, dir: 'h-ops', path: '/h/.claude/skills/h-ops', link: { target: '/w/h-ops-skill', broken: false }, real: '/w/h-ops-skill', skillMd: '---\nname: h-ops\ndescription: ops\n---\n' },
  { scope: 'plugin', owner: 'vercel@mkt', dir: 'deploy', path: '/plug/skills/deploy', link: null, real: '/plug/skills/deploy', skillMd: '---\nname: deploy\ndescription: d\n---\n' },
] };

type Probe = NonNullable<ReturnType<ViewInput['probes']['result']>>;
function input(o: { config?: Config; catalog?: CatalogEntry[]; init?: ViewInput['init']; probes?: Record<string, Probe>; running?: string[]; oauth?: ViewInput['oauth']; log?: ViewInput['log'] } = {}): ViewInput {
  const config = o.config ?? cfg();
  const src = { claudeJson, projectMcp: { p1: { mcpServers: { pg: { command: 'pg' } } } }, plugins: [] };
  const catalog = o.catalog ?? buildCatalog(src, roots, { offForLanes: config.mcp.offForLanes, projectOn: config.mcp.projectOn, pluginsOff: config.plugins.offForLanes });
  return {
    catalog, roots, config, init: o.init ?? [], claudeJson: { ok: true, json: claudeJson }, claudeJsonPath: '/h/.claude.json', rev: 'r1', plugins: ['vercel@mkt'],
    skills: { catalog: buildSkills(scan, config.skills.acked), scan }, sharedBad: 0, claudeFound: true, install: 'curl …', lost: [], ccTools: 2,
    probes: { result: (id) => o.probes?.[id], running: (id) => o.running?.includes(id) ?? false, queued: () => false },
    oauth: o.oauth ?? (() => null),
    log: o.log ?? (() => []),
  };
}

describe('§6 Skills & MCP view', () => {
  test('§5.1 rows: user / local / project (K7 pending) + K1-local unused row; summary counts used rows', () => {
    const v = skillsMcpView(input({ init: [{ projectId: 'p1', name: 'vercel', state: 'connected', tools: 18, toolNames: ['deploy'], lane: 'D2', at: 5 }] }));
    const byId = Object.fromEntries(v.mcp.rows.map((r) => [r.id, r]));
    expect(byId['user:vercel']).toMatchObject({ status: 'connected', tools: 18, editable: true, lastInit: { lane: 'D2', tools: 18, toolNames: ['deploy'] } });
    expect(byId['user:ctx']).toMatchObject({ status: 'unchecked', tools: null });
    expect(byId['local:p1:miro']).toMatchObject({ editable: false, forLanes: true });
    expect(byId['project:p1:pg']).toMatchObject({ pending: true, forLanes: false });
    expect(byId['local:~/Users/me:hcm']).toMatchObject({ unused: { path: '/Users/me' }, forLanes: false });
    expect(v.mcp).toMatchObject({ servers: 6, forLanes: 4, tools: 20 });
    expect(v.counts.mcp).toEqual({ red: 0, yellow: 1 });
  });

  test('§6 C25 F-I1 cc_slaves is the first row (own server, locked, its lane tool count); servers / forLanes / tools count every row shown', () => {
    const v = skillsMcpView(input({ init: [{ projectId: 'p1', name: 'vercel', state: 'connected', tools: 18, toolNames: [], lane: 'D2', at: 5 }] }));
    expect(v.mcp.rows[0]).toMatchObject({ id: 'cc_slaves', name: 'cc_slaves', builtin: true, forLanes: true, status: 'connected', tools: 2, editable: false, canCheck: false, config: {} });
    expect(v.mcp.servers).toBe(v.mcp.rows.length);
    expect(v.mcp.forLanes).toBe(v.mcp.rows.filter((r) => r.forLanes).length);
    expect(v.mcp.tools).toBe(v.mcp.rows.reduce((n, r) => n + (r.forLanes ? r.tools ?? 0 : 0), 0));
    const empty = skillsMcpView({ ...input({ catalog: [] }), claudeJson: { ok: false, line: 1 } });
    expect(empty.mcp).toMatchObject({ servers: 1, forLanes: 1, tools: 2 });
    expect(empty.counts.mcp).toEqual({ red: 0, yellow: 0 });
  });

  test('§5.3 K13 the OAuth state rides on the row and wins over the last init: no token → needs_login, dead / short → needs_relogin (red)', () => {
    const base = { loggedIn: false, expiresAt: null, refreshedAt: null, keychainFailed: false, login: null, error: null };
    const init: ViewInput['init'] = [{ projectId: 'p1', name: 'vercel', state: 'connected', tools: 18, toolNames: [], lane: 'D2', at: 5 }];
    for (const [reason, status] of [['no_token', 'needs_login'], ['invalid_grant', 'needs_relogin'], ['insufficient_scope', 'needs_relogin']] as const) {
      const oauth = { ...base, needsLogin: { reason, scope: null } };
      const v = skillsMcpView(input({ init, oauth: (id) => (id === 'user:vercel' ? oauth : null) }));
      const row = v.mcp.rows.find((r) => r.id === 'user:vercel')!;
      expect(row).toMatchObject({ status, oauth });
      expect(v.counts.mcp.red).toBe(1);
    }
    const ok = skillsMcpView(input({ init, oauth: (id) => (id === 'user:vercel' ? { ...base, loggedIn: true, needsLogin: null } : null) }));
    expect(ok.mcp.rows.find((r) => r.id === 'user:vercel')).toMatchObject({ status: 'connected', oauth: { loggedIn: true } });
    expect(ok.mcp.rows.find((r) => r.id === 'user:ctx')!.oauth).toBeUndefined();
  });

  test('§5.1 a user row ignores the init of a project where a local entry of the same name wins', () => {
    const local = { mcpServers: {}, projects: { '/w/hagenta': { mcpServers: { ctx: { command: 'local-ctx' } } } } };
    const catalog = buildCatalog({ claudeJson: { ...local, mcpServers: { ctx: { command: 'npx' } } }, projectMcp: {}, plugins: [] }, roots, { offForLanes: [], projectOn: [], pluginsOff: [] });
    const v = skillsMcpView(input({ catalog, init: [{ projectId: 'p1', name: 'ctx', state: 'failed', tools: 0, toolNames: [], lane: 'D2', at: 9 }] }));
    expect(v.mcp.rows.find((r) => r.id === 'user:ctx')!.status).toBe('unchecked');
    expect(v.mcp.rows.find((r) => r.id === 'local:p1:ctx')!.status).toBe('error');
  });

  test('§5.4 "Để tắt" (offForLanes) clears K7 pending; projectOn turns it on', () => {
    expect(skillsMcpView(input({ config: cfg({ mcp: { offForLanes: ['project:p1:pg'], projectOn: [], noLogin: [] } }) })).counts.mcp.yellow).toBe(0);
    const on = skillsMcpView(input({ config: cfg({ mcp: { offForLanes: [], projectOn: ['project:p1:pg'], noLogin: [] } }) }));
    expect(on.mcp.rows.find((r) => r.id === 'project:p1:pg')).toMatchObject({ pending: false, forLanes: true });
  });

  test('§5.5 skill rows: id, link label, lane switch from skills / plugins offForLanes; plugin row counts', () => {
    const v = skillsMcpView(input({ config: cfg({ skills: { offForLanes: ['user:h-ops'], acked: {} }, plugins: { offForLanes: ['vercel@mkt'] } }) }));
    expect(v.skills.rows.map((r) => [r.id, r.link, r.forLanes])).toEqual([['user:h-ops', '/w/h-ops-skill', false], ['plugin:vercel@mkt:deploy', null, false]]);
    expect(v.skills.plugins).toEqual([{ key: 'vercel@mkt', skills: 1, servers: 0, forLanes: false }]);
  });

  test('§6 K14 unreadable ~/.claude.json: ok false + line; no K1-local rows from a broken read', () => {
    const v = skillsMcpView({ ...input(), claudeJson: { ok: false, line: 120 } });
    expect(v.claudeJson).toEqual({ ok: false, line: 120, rev: 'r1', path: '/h/.claude.json' }); // path: K14 "Mở file" (G6a, additive)
    expect(v.mcp.rows.some((r) => r.unused)).toBe(false);
  });
});

const probe = (p: Partial<Probe>): Probe => ({ state: 'connected', tools: ['a', 'b'], error: null, at: 10, ...p });
const rowOf = (v: ReturnType<typeof skillsMcpView>, id: string) => v.mcp.rows.find((r) => r.id === id)!;

describe('§5.4b check results in the view', () => {
  test('§5.4b K1 / K2 probe result + latest lane system/init feed state and tool count: the latest wins by time', () => {
    const init = [{ projectId: 'p1', name: 'vercel', state: 'connected', tools: 18, toolNames: [], lane: 'D2', at: 5 }];
    const newer = skillsMcpView(input({ init, probes: { 'user:vercel': probe({ at: 10 }) } }));
    expect(rowOf(newer, 'user:vercel')).toMatchObject({ status: 'connected', tools: 2, probe: { tools: ['a', 'b'], at: 10 } });
    const older = skillsMcpView(input({ init, probes: { 'user:vercel': probe({ state: 'error', tools: [], error: { code: 'timeout', detail: null }, at: 1 }) } }));
    expect(rowOf(older, 'user:vercel')).toMatchObject({ status: 'connected', tools: 18 });
    const failed = skillsMcpView(input({ probes: { 'user:ctx': probe({ state: 'error', tools: [], error: { code: 'spawn', detail: 'ENOENT' }, at: 3 }) } }));
    expect(rowOf(failed, 'user:ctx')).toMatchObject({ status: 'error', tools: null, probe: { error: { code: 'spawn', key: 'skillsMcp.mcpErr.spawn', detail: 'ENOENT' } } });
    expect(failed.counts.mcp.red).toBe(1);
  });

  test('§5.4b C22 canCheck: K7 unapproved project and K1-local stdio have no button; checking while queued / running', () => {
    const v = skillsMcpView(input({ running: ['user:ctx'] }));
    expect(rowOf(v, 'project:p1:pg').canCheck).toBe(false);
    expect(rowOf(v, 'local:~/Users/me:hcm').canCheck).toBe(false);
    expect(rowOf(v, 'user:ctx')).toMatchObject({ canCheck: true, checking: true });
    expect(rowOf(v, 'user:vercel')).toMatchObject({ canCheck: true, checking: false, probe: null });
  });

  test('§5.3 / K13 the OAuth mark is the one "needs login" source: it wins over a later connected check (same as the K13 card), C25 counts it', () => {
    const oauth = { loggedIn: true, expiresAt: null, refreshedAt: null, keychainFailed: false, login: null, error: null, needsLogin: { reason: 'insufficient_scope' as const, scope: 'repo:write' } };
    const v = skillsMcpView(input({ oauth: (id) => (id === 'user:vercel' ? oauth : null), probes: { 'user:vercel': probe({ at: 10 }) } }));
    expect(rowOf(v, 'user:vercel')).toMatchObject({ status: 'needs_relogin', tools: null, oauth: { needsLogin: { scope: 'repo:write' } } });
    expect(v.counts.mcp.red).toBe(1);
    expect(rowOf(v, 'user:vercel')).not.toHaveProperty('needsLogin');
    const cleared = skillsMcpView(input({ oauth: (id) => (id === 'user:vercel' ? { ...oauth, needsLogin: null } : null), probes: { 'user:vercel': probe({ at: 10 }) } }));
    expect(rowOf(cleared, 'user:vercel')).toMatchObject({ status: 'connected', tools: 2 });
  });

  test('§6 K4 "Đăng nhập: Không" (config mcp.noLogin): a 401 is an error, never "Cần đăng nhập"; no OAuth state; the row says noLogin', () => {
    const needs = probe({ state: 'needs_login', tools: [], error: { code: 'needs_login', detail: 'HTTP 401' } });
    const v = skillsMcpView(input({ config: cfg({ mcp: { offForLanes: [], projectOn: [], noLogin: ['user:vercel'] } }), probes: { 'user:vercel': needs } }));
    expect(rowOf(v, 'user:vercel')).toMatchObject({ status: 'error', noLogin: true, probe: { error: { code: 'needs_login', key: 'skillsMcp.mcpErr.unauthorized', detail: 'HTTP 401' } } });
    expect(rowOf(v, 'user:vercel')).not.toHaveProperty('oauth');
    const auto = skillsMcpView(input({ probes: { 'user:vercel': needs } }));
    expect(rowOf(auto, 'user:vercel')).toMatchObject({ status: 'needs_login', probe: { error: { key: 'skillsMcp.mcpErr.needs_login' } } });
    expect(rowOf(auto, 'user:vercel')).not.toHaveProperty('noLogin');
  });

  test('§5.2 K2 log: the last 50 proxy lines, each error code with its skillsMcp.mcpErr key', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ at: i, method: 'POST', path: '/', status: i === 59 ? 504 : 200, ms: 1, ...(i === 59 ? { error: 'timeout' as const } : {}) }));
    const v = skillsMcpView(input({ log: (id) => (id === 'user:vercel' ? lines : []) }));
    const log = rowOf(v, 'user:vercel').log;
    expect(log.length).toBe(50);
    expect(log[0]!.at).toBe(10);
    expect(log.at(-1)).toEqual({ at: 59, method: 'POST', path: '/', status: 504, ms: 1, error: { code: 'timeout', key: 'skillsMcp.mcpErr.timeout', fix: 'skillsMcp.mcpFix.timeout', detail: null } });
    expect(log[0]!.error).toBeNull();
  });

  test('§6 K2-err F-I4 a check error carries its cause key and its fix key', () => {
    const v = skillsMcpView(input({ probes: { 'user:ctx': probe({ state: 'error', tools: [], error: { code: 'spawn', detail: 'npx ENOENT' }, at: 9 }) } }));
    expect(rowOf(v, 'user:ctx').probe?.error).toEqual({ code: 'spawn', key: 'skillsMcp.mcpErr.spawn', fix: 'skillsMcp.mcpFix.spawn', detail: 'npx ENOENT' });
  });

  test('§6 K1-src F-I3 plugin rows carry the file their server comes from', () => {
    const catalog: CatalogEntry[] = [{ id: 'plugin:vercel@m:vercel', name: 'plugin_vercel_vercel', source: 'plugin', kind: 'http', plugin: 'vercel@m', config: { type: 'http', url: 'u' }, forLanes: true, sourceFile: '/p/vercel/.mcp.json' }];
    expect(rowOf(skillsMcpView(input({ catalog })), 'plugin:vercel@m:vercel').sourceFile).toBe('/p/vercel/.mcp.json');
  });
});
