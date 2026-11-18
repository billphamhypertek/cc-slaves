// v2.2 §5.1 MCP catalog (pure part) + the per-session MCP set.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, McpCatalog, readCatalogSources, sessionMcp, type CatalogPrefs, type CatalogSources, type PluginSource, type WatchDir } from '../../src/mcp/catalog.ts';

const http = (url: string, extra: Record<string, unknown> = {}) => ({ type: 'http', url, ...extra });
const stdio = (command: string, extra: Record<string, unknown> = {}) => ({ command, ...extra });
const PROJECTS = [{ id: 'hagenta', path: '/w/hagenta' }, { id: 'shop', path: '/w/shop' }];
const NO_PREFS: CatalogPrefs = { offForLanes: [], projectOn: [], pluginsOff: [] };
const plugin = (o: Partial<PluginSource> & { key: string; servers: Record<string, unknown> }): PluginSource =>
  ({ installPath: `/plug/${o.key}`, scope: 'user', enabled: true, ...o });
const src = (o: Partial<CatalogSources> = {}): CatalogSources => ({ claudeJson: {}, projectMcp: {}, plugins: [], ...o });
const byId = (c: ReturnType<typeof buildCatalog>) => Object.fromEntries(c.map((e) => [e.id, e]));

describe('§5.1 catalog sources and scoped ids', () => {
  test('§5.1 user / local / project / plugin entries get scoped ids; entry names keep Claude Code names (plugin_<p>_<s>)', () => {
    const c = byId(buildCatalog(src({
      claudeJson: { mcpServers: { linear: http('u-linear') }, projects: { '/w/hagenta': { mcpServers: { miro: http('l-miro') } } } },
      projectMcp: { shop: { mcpServers: { db: stdio('db-server') } } },
      plugins: [plugin({ key: 'vercel@claude-plugins-official', servers: { vercel: http('https://mcp.vercel.com') } })],
    }), PROJECTS, NO_PREFS));
    expect(Object.keys(c).sort()).toEqual(['local:hagenta:miro', 'plugin:vercel@claude-plugins-official:vercel', 'project:shop:db', 'user:linear']);
    expect(c['user:linear']).toMatchObject({ name: 'linear', source: 'user', kind: 'http', forLanes: true });
    expect(c['local:hagenta:miro']).toMatchObject({ name: 'miro', source: 'local', projectId: 'hagenta', forLanes: true });
    expect(c['project:shop:db']).toMatchObject({ name: 'db', source: 'project', projectId: 'shop', kind: 'stdio' });
    expect(c['plugin:vercel@claude-plugins-official:vercel']).toMatchObject({ name: 'plugin_vercel_vercel', source: 'plugin', plugin: 'vercel@claude-plugins-official' });
  });

  test('§5.1 C8 two projects with the same local server name do not collide; a local entry of a non-root path is in no lane', () => {
    const c = buildCatalog(src({ claudeJson: { projects: {
      '/w/hagenta': { mcpServers: { miro: http('a') } }, '/w/shop': { mcpServers: { miro: http('b') } },
      '/w/hagenta/worktree': { mcpServers: { stray: http('c') } },
    } } }), PROJECTS, NO_PREFS);
    expect(c.map((e) => e.id).sort()).toEqual(['local:hagenta:miro', 'local:shop:miro']);
    expect((sessionMcp(c, 'hagenta', 1, 't').servers.miro as { url: string }).url).toEndWith('/mcp-proxy/local%3Ahagenta%3Amiro');
    expect((sessionMcp(c, 'shop', 1, 't').servers.miro as { url: string }).url).toEndWith('/mcp-proxy/local%3Ashop%3Amiro');
  });

  test('§5.1 project (.mcp.json) entries are off by default; projectOn turns one on; offForLanes turns any entry off', () => {
    const s = src({ claudeJson: { mcpServers: { linear: http('u') } }, projectMcp: { shop: { mcpServers: { db: stdio('x') } } } });
    expect(byId(buildCatalog(s, PROJECTS, NO_PREFS))['project:shop:db']!.forLanes).toBe(false);
    const on = byId(buildCatalog(s, PROJECTS, { ...NO_PREFS, projectOn: ['project:shop:db'] }));
    expect(on['project:shop:db']!.forLanes).toBe(true);
    const off = byId(buildCatalog(s, PROJECTS, { ...NO_PREFS, projectOn: ['project:shop:db'], offForLanes: ['project:shop:db', 'user:linear'] }));
    expect([off['project:shop:db']!.forLanes, off['user:linear']!.forLanes]).toEqual([false, false]);
  });

  test('§5.1 plugins: user-enabled → every project; scope project → only the project at projectPath; disabled / off for lanes → not in lanes', () => {
    const s = src({ plugins: [
      plugin({ key: 'vercel@m', servers: { vercel: http('v') } }),
      plugin({ key: 'tg@m', scope: 'project', projectPath: '/w/shop', enabled: false, servers: { tg: stdio('t') } }),
      plugin({ key: 'off@m', enabled: false, servers: { off: http('o') } }),
      plugin({ key: 'far@m', scope: 'project', projectPath: '/elsewhere', servers: { far: http('f') } }),
    ] });
    const c = buildCatalog(s, PROJECTS, NO_PREFS);
    expect(c.map((e) => e.id).sort()).toEqual(['plugin:tg@m:tg', 'plugin:vercel@m:vercel']);
    expect(byId(c)['plugin:tg@m:tg']!.projectId).toBe('shop');
    expect(Object.keys(sessionMcp(c, 'hagenta', 1, 't').servers).sort()).toEqual(['cc_slaves', 'plugin_vercel_vercel']);
    expect(Object.keys(sessionMcp(c, 'shop', 1, 't').servers).sort()).toEqual(['cc_slaves', 'plugin_tg_tg', 'plugin_vercel_vercel']);
    const off = buildCatalog(s, PROJECTS, { ...NO_PREFS, pluginsOff: ['vercel@m'] });
    expect(byId(off)['plugin:vercel@m:vercel']!.forLanes).toBe(false);
  });
});

describe('§5.1 C20 plugin variables', () => {
  test('§5.1 ${CLAUDE_PLUGIN_ROOT} expands to installPath in command / args / env / cwd; plain ${VAR} stays', () => {
    const c = buildCatalog(src({ plugins: [plugin({ key: 'tg@m', installPath: '/cache/tg/1.0', servers: { tg: stdio('${CLAUDE_PLUGIN_ROOT}/bin', {
      args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs', '${HOME}/x'], env: { ROOT: '${CLAUDE_PLUGIN_ROOT}', TOKEN: '${TG_TOKEN}' }, cwd: '${CLAUDE_PLUGIN_ROOT}',
    }) } })] }), PROJECTS, NO_PREFS);
    expect(c[0]!.config).toEqual({ command: '/cache/tg/1.0/bin', args: ['/cache/tg/1.0/server.mjs', '${HOME}/x'], env: { ROOT: '/cache/tg/1.0', TOKEN: '${TG_TOKEN}' }, cwd: '/cache/tg/1.0' });
    expect(c[0]!.error).toBeUndefined();
    expect(c[0]!.forLanes).toBe(true);
  });

  test('§5.1 C20 an unknown ${CLAUDE_PLUGIN_*} → error naming the variable, never in a lane', () => {
    const c = buildCatalog(src({ plugins: [plugin({ key: 'x@m', servers: { x: stdio('node', { args: ['${CLAUDE_PLUGIN_DATA}/db'] }) } })] }), PROJECTS, NO_PREFS);
    expect(c[0]!.error).toEqual({ code: 'plugin_var', name: 'CLAUDE_PLUGIN_DATA' });
    expect(c[0]!.forLanes).toBe(false);
    expect(Object.keys(sessionMcp(c, 'shop', 1, 't').servers)).toEqual(['cc_slaves']);
  });
});

describe('§5.1 session MCP set', () => {
  const remote = src({ claudeJson: { mcpServers: {
    pub: http('https://pub.example/mcp'),
    old: { type: 'sse', url: 'https://sse.example/sse' },
    keyed: http('https://k.example', { headers: { authorization: 'Bearer ${K}' } }),
    helper: http('https://h.example', { headersHelper: '/bin/h' }),
    sock: { type: 'ws', url: 'wss://w.example' },
    local: stdio('node', { args: ['s.js'], env: { A: '1' }, cwd: '/tmp' }),
  }, projects: { '/w/hagenta': { mcpServers: { miro: http('https://miro.example') } } } } });

  test('§5.1 C9 remote http / sse → proxy entry with the session token (type kept); Authorization / headersHelper / ws / stdio copied as is', () => {
    const s = sessionMcp(buildCatalog(remote, PROJECTS, NO_PREFS), 'hagenta', 47800, 'tok');
    const proxy = (id: string, type = 'http') => ({ type, url: `http://127.0.0.1:47800/mcp-proxy/${encodeURIComponent(id)}`, headers: { Authorization: 'Bearer tok' } });
    expect(s.servers.pub).toEqual(proxy('user:pub'));
    expect(s.servers.old).toEqual(proxy('user:old', 'sse'));
    expect(s.servers.miro).toEqual(proxy('local:hagenta:miro'));
    expect((s.servers.miro as { url: string }).url).toEndWith('/mcp-proxy/local%3Ahagenta%3Amiro');
    expect(s.servers.keyed).toEqual(http('https://k.example', { headers: { authorization: 'Bearer ${K}' } }));
    expect(s.servers.helper).toEqual(http('https://h.example', { headersHelper: '/bin/h' }));
    expect(s.servers.sock).toEqual({ type: 'ws', url: 'wss://w.example' });
    expect(s.servers.local).toEqual(stdio('node', { args: ['s.js'], env: { A: '1' }, cwd: '/tmp' }));
  });

  test('§5.1 mcpIds = exactly the proxied remote ids written into the file', () => {
    const s = sessionMcp(buildCatalog(remote, PROJECTS, { ...NO_PREFS, offForLanes: ['user:old'] }), 'hagenta', 1, 't');
    expect([...s.mcpIds].sort()).toEqual(['local:hagenta:miro', 'user:pub']);
    expect(Object.keys(s.servers)).not.toContain('old');
  });

  test('§5.1 a proxied user entry shadowed by a local stdio entry of the same name leaves mcpIds (proxy allow-list) empty', () => {
    const c = buildCatalog(src({ claudeJson: { mcpServers: { x: http('https://x') }, projects: { '/w/shop': { mcpServers: { x: stdio('local-x') } } } } }), PROJECTS, NO_PREFS);
    const s = sessionMcp(c, 'shop', 1, 't');
    expect(s.servers.x).toEqual(stdio('local-x'));
    expect([...s.mcpIds]).toEqual([]);
  });

  test('§5.1 name clash: local > project > user > plugin; cc_slaves of the engine wins everything', () => {
    const c = buildCatalog(src({
      claudeJson: { mcpServers: { a: stdio('user-a'), b: stdio('user-b'), cc_slaves: stdio('evil') }, projects: { '/w/shop': { mcpServers: { a: stdio('local-a') } } } },
      projectMcp: { shop: { mcpServers: { a: stdio('proj-a'), b: stdio('proj-b'), plugin_p_s: stdio('proj-ps') } } },
      plugins: [plugin({ key: 'p@m', servers: { s: stdio('plugin-s') } })],
    }), PROJECTS, { ...NO_PREFS, projectOn: ['project:shop:a', 'project:shop:b', 'project:shop:plugin_p_s'] });
    const s = sessionMcp(c, 'shop', 9, 'tok').servers;
    expect([s.a, s.b, s.plugin_p_s]).toEqual([stdio('local-a'), stdio('proj-b'), stdio('proj-ps')]);
    expect(s.cc_slaves).toEqual({ type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer tok' } });
  });

  test('§5.1 build for one session stays ≤ 20 ms (200 entries)', () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`s${i}`, http(`https://e${i}.example`)]));
    const local = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`l${i}`, stdio(`c${i}`)]));
    const s = src({ claudeJson: { mcpServers: many, projects: { '/w/shop': { mcpServers: local } } } });
    const t0 = performance.now();
    const out = sessionMcp(buildCatalog(s, PROJECTS, NO_PREFS), 'shop', 1, 't');
    const ms = performance.now() - t0;
    expect(Object.keys(out.servers)).toHaveLength(201);
    expect(ms).toBeLessThan(20);
  });
});

describe('v2.5 §5.7 graph in the session MCP set', () => {
  const CBM = 'codebase-memory-mcp';
  const ours = (port: number, tok: string) => ({ type: 'http', url: `http://127.0.0.1:${port}/mcp-graph`, headers: { Authorization: `Bearer ${tok}` } });
  // the PO's own graph entries: one by name (remote → would be proxied), one under another name whose command is the tool's file
  const mine = src({
    claudeJson: { mcpServers: { [CBM]: http('https://cbm.example'), graph: stdio('/Users/x/.local/bin/codebase-memory-mcp'), linear: http('https://l') } },
    plugins: [plugin({ key: 'g@m', servers: { s: stdio('${CLAUDE_PLUGIN_ROOT}/codebase-memory-mcp', { args: ['--x'] }) } })],
  });
  const names = (s: { servers: Record<string, unknown> }) => Object.keys(s.servers).sort();

  test('§5.7 module not managing (null) → the v2.2 catalog as is: user entries kept, engine adds nothing', () => {
    const s = sessionMcp(buildCatalog(mine, PROJECTS, NO_PREFS), 'shop', 7, 'tok', null);
    expect(names(s)).toEqual(['cc_slaves', CBM, 'graph', 'linear', 'plugin_g_s']);
    expect(s.servers[CBM]).toEqual({ type: 'http', url: 'http://127.0.0.1:7/mcp-proxy/user%3Acodebase-memory-mcp', headers: { Authorization: 'Bearer tok' } });
    expect([...s.mcpIds].sort()).toEqual(['user:codebase-memory-mcp', 'user:linear']);
  });

  test('§5.7 ready + switch on → the cc-slaves entry; every user graph entry (by name or by command file) is replaced', () => {
    const s = sessionMcp(buildCatalog(mine, PROJECTS, NO_PREFS), 'shop', 7, 'tok', { on: true });
    expect(names(s)).toEqual(['cc_slaves', CBM, 'linear']);
    expect(s.servers[CBM]).toEqual(ours(7, 'tok'));
    expect([...s.mcpIds]).toEqual(['user:linear']); // the replaced remote entry is not in the proxy allow-list
  });

  test('§5.7 ready + switch on: offForLanes is not read for the graph id; a local entry of the same name loses too', () => {
    const c = buildCatalog(src({ claudeJson: { mcpServers: { [CBM]: stdio('cbm') }, projects: { '/w/shop': { mcpServers: { [CBM]: stdio('local-cbm') } } } } }),
      PROJECTS, { ...NO_PREFS, offForLanes: ['user:codebase-memory-mcp'] });
    expect(sessionMcp(c, 'shop', 3, 't', { on: true }).servers[CBM]).toEqual(ours(3, 't'));
  });

  test('§5.7 ready + switch off → no graph entry at all, the user ones dropped too (one switch)', () => {
    const s = sessionMcp(buildCatalog(mine, PROJECTS, NO_PREFS), 'shop', 7, 'tok', { on: false });
    expect(names(s)).toEqual(['cc_slaves', 'linear']);
    expect([...s.mcpIds]).toEqual(['user:linear']);
  });

  test('§5.7 a command that only contains the name (not the file name) is not the tool', () => {
    const c = buildCatalog(src({ claudeJson: { mcpServers: { wrap: stdio('/bin/codebase-memory-mcp-wrapper'), sh: stdio('sh', { args: ['codebase-memory-mcp'] }) } } }), PROJECTS, NO_PREFS);
    expect(names(sessionMcp(c, 'shop', 1, 't', { on: false }))).toEqual(['cc_slaves', 'sh', 'wrap']);
  });

  test('§5.7 cc_slaves still wins; the graph entry never takes the cc_slaves name', () => {
    const s = sessionMcp(buildCatalog(src({ claudeJson: { mcpServers: { cc_slaves: stdio('codebase-memory-mcp') } } }), PROJECTS, NO_PREFS), 'shop', 2, 'k', { on: true });
    expect(s.servers.cc_slaves).toEqual({ type: 'http', url: 'http://127.0.0.1:2/mcp', headers: { Authorization: 'Bearer k' } });
    expect(s.servers[CBM]).toEqual(ours(2, 'k'));
  });
});

describe('§5.1 sources on disk + cache', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ccs-catalog-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  /** No FSEvents in unit tests: creating / closing a real `fs.watch` blocks for seconds under load (lane v22-flakes). */
  const fakeWatch = () => {
    const dirs = new Map<string, (name: string | null) => void>();
    const watch: WatchDir = (dir, onEvent) => { dirs.set(dir, onEvent); return { close: () => { dirs.delete(dir); } }; };
    return { dirs, watch };
  };

  function seed(): { claudeJson: string; claudeHome: string; projects: { id: string; path: string }[] } {
    const claudeHome = join(tmp, 'claude');
    const vercel = join(claudeHome, 'plugins', 'cache', 'm', 'vercel', '1.0');
    const tg = join(claudeHome, 'plugins', 'cache', 'm', 'tg', '2.0');
    const proj = join(tmp, 'shop');
    for (const d of [vercel, join(tg, '.claude-plugin'), proj]) mkdirSync(d, { recursive: true });
    writeFileSync(join(vercel, '.mcp.json'), JSON.stringify({ mcpServers: { vercel: http('https://mcp.vercel.com') } }));
    writeFileSync(join(tg, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tg', mcpServers: { tg: stdio('${CLAUDE_PLUGIN_ROOT}/s') } }));
    writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'vercel@m': [{ scope: 'user', installPath: vercel }],
      'tg@m': [{ scope: 'project', installPath: tg, projectPath: proj }],
    } }));
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'vercel@m': true } }));
    writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { db: stdio('db') } }));
    const claudeJson = join(tmp, 'claude.json');
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { linear: http('u') } }));
    return { claudeJson, claudeHome, projects: [{ id: 'shop', path: proj }] };
  }

  test('§5.1 / §3-8 readCatalogSources: plugin dir from installPath (.mcp.json or plugin.json mcpServers), user enabledPlugins, project .mcp.json', () => {
    const { claudeJson, claudeHome, projects } = seed();
    const c = byId(buildCatalog(readCatalogSources({ claudeJson, claudeHome }, projects), projects, NO_PREFS));
    expect(Object.keys(c).sort()).toEqual(['plugin:tg@m:tg', 'plugin:vercel@m:vercel', 'project:shop:db', 'user:linear']);
    expect(c['plugin:tg@m:tg']!.config).toEqual(stdio(`${join(claudeHome, 'plugins', 'cache', 'm', 'tg', '2.0')}/s`));
  });

  test('§6 K1-src / K3e plugin entries carry the file their servers come from (.mcp.json, else plugin.json) for "Mở file nguồn"', () => {
    const { claudeJson, claudeHome, projects } = seed();
    const c = byId(buildCatalog(readCatalogSources({ claudeJson, claudeHome }, projects), projects, NO_PREFS));
    expect(c['plugin:vercel@m:vercel']!.sourceFile).toBe(join(claudeHome, 'plugins', 'cache', 'm', 'vercel', '1.0', '.mcp.json'));
    expect(c['plugin:tg@m:tg']!.sourceFile).toBe(join(claudeHome, 'plugins', 'cache', 'm', 'tg', '2.0', '.claude-plugin', 'plugin.json'));
    expect(c['user:linear']!.sourceFile).toBeUndefined();
  });

  test('§5.1 missing / broken source files → empty, never throws', () => {
    const s = readCatalogSources({ claudeJson: join(tmp, 'none.json'), claudeHome: join(tmp, 'none') }, [{ id: 'x', path: join(tmp, 'x') }]);
    expect(buildCatalog(s, [], NO_PREFS)).toEqual([]);
  });

  test('§5.1 McpCatalog caches while nothing changed; a source edit is seen by the next get (stat check, watch may drop events)', () => {
    const { claudeJson, claudeHome, projects } = seed();
    const cat = new McpCatalog({ claudeJson: () => claudeJson, claudeHome: () => claudeHome, watch: fakeWatch().watch });
    try {
      const first = cat.get(projects, NO_PREFS);
      expect(cat.get(projects, NO_PREFS)).toBe(first);
      writeFileSync(claudeJson, JSON.stringify({ mcpServers: { linear: http('u'), gh: http('g') } }));
      expect(cat.get(projects, NO_PREFS).some((e) => e.id === 'user:gh')).toBe(true);
      expect(cat.get(projects, { ...NO_PREFS, offForLanes: ['user:gh'] }).find((e) => e.id === 'user:gh')!.forLanes).toBe(false);
    } finally { cat.close(); }
  });

  test('§5.1 McpCatalog: a watched source event drops the cached sources after the debounce', async () => {
    const { claudeJson, claudeHome, projects } = seed();
    const cat = new McpCatalog({ claudeJson: () => claudeJson, claudeHome: () => claudeHome, debounceMs: 20, watch: fakeWatch().watch });
    try {
      const first = cat.get(projects, NO_PREFS);
      cat.sourceChanged();
      expect(cat.get(projects, NO_PREFS)).toBe(first);
      await Bun.sleep(60);
      expect(cat.get(projects, NO_PREFS)).not.toBe(first);
    } finally { cat.close(); }
  });

  test('§5.1 McpCatalog watches each source dir once; only an event for a source file name (or an unnamed one) drops the cache', async () => {
    const { claudeJson, claudeHome, projects } = seed();
    const w = fakeWatch();
    let changed = 0;
    const cat = new McpCatalog({ claudeJson: () => claudeJson, claudeHome: () => claudeHome, debounceMs: 20, onChange: () => { changed++; }, watch: w.watch });
    try {
      cat.get(projects, NO_PREFS);
      expect(w.dirs.has(tmp)).toBe(true);
      w.dirs.get(tmp)!('notes.txt');
      await Bun.sleep(60);
      expect(changed).toBe(0);
      w.dirs.get(tmp)!('claude.json');
      await Bun.sleep(60);
      expect(changed).toBe(1);
      w.dirs.get(tmp)!(null);
      await Bun.sleep(60);
      expect(changed).toBe(2);
    } finally { cat.close(); }
    expect(w.dirs.size).toBe(0);
  });

  test('§6 K14 a ~/.claude.json that stops parsing → lanes keep the last good read; onChange fires after the debounce', async () => {
    const { claudeJson, claudeHome, projects } = seed();
    let changed = 0;
    const cat = new McpCatalog({ claudeJson: () => claudeJson, claudeHome: () => claudeHome, debounceMs: 20, onChange: () => { changed++; }, watch: fakeWatch().watch });
    try {
      expect(cat.get(projects, NO_PREFS).some((e) => e.id === 'user:linear')).toBe(true);
      writeFileSync(claudeJson, '{ "mcpServers": { "linear": ,, }');
      expect(cat.get(projects, NO_PREFS).some((e) => e.id === 'user:linear')).toBe(true);
      expect(cat.plugins.map((p) => p.key).sort()).toEqual(['tg@m', 'vercel@m']);
      cat.sourceChanged();
      await Bun.sleep(60);
      expect(changed).toBe(1);
    } finally { cat.close(); }
  });
});
