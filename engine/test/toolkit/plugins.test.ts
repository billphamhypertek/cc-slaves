// v2.5 §5.1 / §5.2 the toolkit catalog, the plugin row states, the §3-5 "có bản mới" rule, and the `claude plugin` queue
// (check / install / update) against a scripted exec. Temp claude home only; never the real ~/.claude.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitSetup } from '../../../shared/protocol.ts';
import type { GraphToolView } from '../../../shared/graph.ts';
import type { ToolkitKey } from '../../../shared/toolkit.ts';
import type { ExecResult } from '../../src/setup/setup.ts';
import { TOOLKIT } from '../../src/toolkit/catalog.ts';
import { classify, PluginQueue, Toolkit } from '../../src/toolkit/plugins.ts';

const SP = 'superpowers@claude-plugins-official';
const UX = 'ui-ux-pro-max@ui-ux-pro-max-skill';
const C7 = 'context7@claude-plugins-official';
const VC = 'vercel@claude-plugins-official';
const OFFICIAL = 'claude-plugins-official';

let tmp: string;
let ch: string;
let calls: string[][];
let replies: Record<string, ExecResult[]>;
let git: Pick<GitSetup, 'state' | 'detail'>;
let gitFresh: boolean[];
let login: Set<string>;
let off: string[];
let written: number;
let changes: number;
let now: number;
let tk: Toolkit;
let gtool: GraphToolView;
let order: string[];

const j = (p: string, v: unknown) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v)); };
const ok = (v: Record<string, unknown> = {}): ExecResult => ({ code: 0, stdout: `${JSON.stringify({ outcome: 'ok', ...v })}\n`, stderr: '' });
const failed = (v: Record<string, unknown>, stderr = ''): ExecResult => ({ code: 1, stdout: `${JSON.stringify({ outcome: 'failed', ...v })}\n`, stderr });
const OFFLINE_MSG = "Failed: fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com\nssh: nope";
/** The sub-command an argv runs: `marketplace-add <repo>`, `install <id>`… */
const sub = (argv: string[]) => (argv[2] === 'marketplace' ? `marketplace-${argv[3]} ${argv[4]}` : `${argv[2]} ${argv[3]}`);
const subs = () => calls.map(sub);

function installedFile(entries: Record<string, Record<string, unknown>[]>) { j(join(ch, 'plugins', 'installed_plugins.json'), { version: 2, plugins: entries }); }
function enabled(ids: string[]) { j(join(ch, 'settings.json'), { enabledPlugins: Object.fromEntries(ids.map((i) => [i, true])) }); }
function knownFile(names: string[]) {
  j(join(ch, 'plugins', 'known_marketplaces.json'), Object.fromEntries(names.map((n) => [n, { source: { source: 'github', repo: `r/${n}` }, installLocation: join(ch, 'plugins', 'marketplaces', n) }])));
}
function catalogFile(name: string, plugins: Record<string, unknown>[]) { j(join(ch, 'plugins', 'marketplaces', name, '.claude-plugin', 'marketplace.json'), { name, plugins }); }
const userRow = (installPath: string, version: string, sha?: string) => ({ scope: 'user', installPath, version, ...(sha ? { gitCommitSha: sha } : {}) });
const row = (key: ToolkitKey) => tk.view().rows.find((r) => r.key === key)!;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-toolkit-'));
  ch = join(tmp, '.claude');
  gtool = { state: 'missing' }; order = [];
  calls = []; replies = {}; git = { state: 'ok', detail: null }; gitFresh = []; login = new Set(); off = []; written = 0; changes = 0; now = 1_000_000;
  tk = new Toolkit({
    claudeHome: () => ch, claudePath: () => '/bin/claude',
    exec: async (argv) => { calls.push(argv); order.push(argv.slice(2, 4).join(' ')); return replies[sub(argv)]?.shift() ?? ok(); },
    git: async (fresh) => { gitFresh.push(fresh); return git; },
    needsLogin: (id) => login.has(id), offForLanes: () => off, afterWrite: () => { written++; }, onChange: () => { changes++; }, now: () => now,
    graph: { tool: () => gtool, install: async () => { order.push('graph'); } },
  });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('§5.1 catalog', () => {
  test('§5.1 five items in order; plugin ids are name@marketplace with their repo; context7 / vercel declare their login MCP', () => {
    expect(TOOLKIT.map((i) => i.key)).toEqual(['superpowers', 'ui-ux-pro-max', 'context7', 'vercel', 'graph']);
    const p = TOOLKIT.filter((i) => i.kind === 'plugin');
    expect(p.map((i) => [i.id, i.marketplace.name, i.marketplace.repo, i.mcpLogin])).toEqual([
      [SP, OFFICIAL, 'anthropics/claude-plugins-official', []],
      [UX, 'ui-ux-pro-max-skill', 'nextlevelbuilder/ui-ux-pro-max-skill', []],
      [C7, OFFICIAL, 'anthropics/claude-plugins-official', ['context7']],
      [VC, OFFICIAL, 'anthropics/claude-plugins-official', ['vercel']],
    ]);
  });
});

describe('§5.2 row state (reads files, never calls claude)', () => {
  test('§5.2 no files → four plugin rows missing, kind plugin, no MCP ids, then the graph row (TK2: 5 rows); the view never ran a command', () => {
    expect(tk.view().rows.map((r) => [r.key, r.kind, r.id, r.state, r.mcpLoginIds])).toEqual([
      ['superpowers', 'plugin', SP, 'missing', []], ['ui-ux-pro-max', 'plugin', UX, 'missing', []],
      ['context7', 'plugin', C7, 'missing', []], ['vercel', 'plugin', VC, 'missing', []], ['graph', 'graph', undefined, 'missing', []],
    ]);
    expect(calls).toEqual([]);
  });

  test('§5.2 a project-scoped entry only is missing for the user scope', () => {
    installedFile({ [SP]: [{ scope: 'project', installPath: '/x', version: '7.0.2', projectPath: '/p' }] });
    enabled([SP]);
    expect(row('superpowers').state).toBe('missing');
  });

  test('§5.2 installed + enabled → installed with its version; enabledPlugins !== true → disabled', () => {
    installedFile({ [SP]: [userRow('/a', '7.0.2')], [UX]: [userRow('/b', '2.15.0')] });
    j(join(ch, 'settings.json'), { enabledPlugins: { [SP]: true, [UX]: false } });
    expect([row('superpowers').state, row('superpowers').version]).toEqual(['installed', '7.0.2']);
    expect(row('ui-ux-pro-max').state).toBe('disabled');
  });

  test('§5.2 a plugin MCP with the needs-login mark → needs_login + its ids; no mark → installed', () => {
    installedFile({ [C7]: [userRow('/c', 'b5b01ac4f889')], [VC]: [userRow('/v', '0.50.0')] });
    enabled([C7, VC]);
    login.add(`plugin:${C7}:context7`);
    expect([row('context7').state, row('context7').mcpLoginIds]).toEqual(['needs_login', [`plugin:${C7}:context7`]]);
    expect([row('vercel').state, row('vercel').mcpLoginIds]).toEqual(['installed', []]);
    login.add(`plugin:${VC}:vercel`);
    expect(row('vercel').mcpLoginIds).toEqual([`plugin:${VC}:vercel`]);
  });

  test('§5.2 plugins.offForLanes → still installed, the row carries offForLanes', () => {
    installedFile({ [SP]: [userRow('/a', '7.0.2')] });
    enabled([SP]);
    off = [SP];
    expect(row('superpowers')).toMatchObject({ state: 'installed', offForLanes: true });
    expect(row('context7').offForLanes).toBeUndefined();
  });
});

describe('§3-5 / §5.2 toolkit_check: marketplace update, then the catalog compare', () => {
  function setupOfficial(c7Files: Record<string, string>, catalogFiles: Record<string, string>) {
    const c7 = join(tmp, 'cache', 'c7');
    for (const [f, t] of Object.entries(c7Files)) { mkdirSync(join(c7, f, '..'), { recursive: true }); writeFileSync(join(c7, f), t); }
    const cat = join(ch, 'plugins', 'marketplaces', OFFICIAL, 'external_plugins', 'context7');
    for (const [f, t] of Object.entries(catalogFiles)) { mkdirSync(join(cat, f, '..'), { recursive: true }); writeFileSync(join(cat, f), t); }
    installedFile({ [SP]: [userRow('/sp', '7.0.0', 'aaa')], [C7]: [userRow(c7, 'cc2b48e77590')], [UX]: [userRow('/ux', '2.14.0')] });
    enabled([SP, C7, UX]);
    knownFile([OFFICIAL, 'ui-ux-pro-max-skill']);
    catalogFile(OFFICIAL, [{ name: 'superpowers', source: { source: 'url', url: 'u', sha: 'bbb' } }, { name: 'context7', source: './external_plugins/context7' }]);
    catalogFile('ui-ux-pro-max-skill', [{ name: 'ui-ux-pro-max', source: './', version: '2.15.0' }]);
  }

  test('§3-5 sha ≠ gitCommitSha → outdated, no latest; path + version differs → outdated + latest; path, same content (bar .in_use) → installed', async () => {
    setupOfficial({ 'a.md': 'x', '.in_use': '123' }, { 'a.md': 'x' });
    expect(row('superpowers').state).toBe('installed'); // before a check nothing is outdated
    const v = await tk.check(false);
    expect(subs()).toEqual([`marketplace-update ${OFFICIAL}`, 'marketplace-update ui-ux-pro-max-skill']);
    expect(calls.every((a) => a[0] === '/bin/claude' && a[1] === 'plugin' && a.includes('--json'))).toBe(true);
    expect(v.rows.map((r) => [r.key, r.state, r.latest])).toEqual([
      ['superpowers', 'outdated', undefined], ['ui-ux-pro-max', 'outdated', '2.15.0'], ['context7', 'installed', undefined], ['vercel', 'missing', undefined],
      ['graph', 'missing', undefined],
    ]);
    expect(v.checkedAt).toBe(now);
    expect(gitFresh).toEqual([true]); // toolkit_check also refreshes SetupStatus.git (R3)
  });

  test('§3-5 path source without version: a changed file → outdated; same sha → installed', async () => {
    setupOfficial({ 'a.md': 'old' }, { 'a.md': 'new' });
    catalogFile(OFFICIAL, [{ name: 'superpowers', source: { source: 'url', url: 'u', sha: 'aaa' } }, { name: 'context7', source: './external_plugins/context7' }]);
    await tk.check(false);
    expect([row('context7').state, row('superpowers').state]).toEqual(['outdated', 'installed']);
  });

  test('hf-fx url + sha source, installed entry without gitCommitSha → unknown, stays installed (no "Cập nhật" that never clears)', async () => {
    setupOfficial({ 'a.md': 'x' }, { 'a.md': 'x' });
    installedFile({ [SP]: [userRow('/sp', '7.0.0')] });
    await tk.check(false);
    expect(row('superpowers').state).toBe('installed');
  });

  test('§5.2 a second check < 60 s reuses the result; force ("Kiểm tra") runs again; ≥ 60 s runs again', async () => {
    setupOfficial({}, {});
    await tk.check(false);
    now += 59_000;
    await tk.check(false);
    expect(calls.length).toBe(2);
    await tk.check(true);
    expect(calls.length).toBe(4);
    now += 60_000;
    await tk.check(false);
    expect(calls.length).toBe(6);
  });

  test('§5.2 only marketplaces already known are refreshed (none → no command, checkedAt set)', async () => {
    const v = await tk.check(false);
    expect(calls).toEqual([]);
    expect(v.checkedAt).toBe(now);
  });

  test('§5.2 a git network failure → checkError offline (first line); rows keep their earlier state', async () => {
    setupOfficial({}, {});
    await tk.check(false);
    replies[`marketplace-update ${OFFICIAL}`] = [failed({ failureCode: 'error_unknown', message: OFFLINE_MSG }, 'fatal: unable to access')];
    catalogFile(OFFICIAL, [{ name: 'superpowers', source: { source: 'url', url: 'u', sha: 'aaa' } }]);
    const v = await tk.check(true);
    expect(v.checkError).toEqual({ code: 'offline', line: OFFLINE_MSG.split('\n')[0]! });
    expect(row('superpowers').state).toBe('outdated');
  });

  test('§5.2 another failure → checkError unknown + the first line of message', async () => {
    setupOfficial({}, {});
    replies['marketplace-update ui-ux-pro-max-skill'] = [failed({ failureCode: 'error_unknown', message: 'boom\nmore' })];
    expect((await tk.check(false)).checkError).toEqual({ code: 'unknown', line: 'boom' });
  });
});

describe('§5.2 classify a `claude plugin --json` reply', () => {
  test('§5.2 ok · not_found · offline (message or stderr) · unknown first line · no JSON → stderr line', () => {
    expect(classify(ok({ updateOutcome: 'updated' }))).toEqual({ ok: true, json: { outcome: 'ok', updateOutcome: 'updated' } });
    expect(classify(failed({ failureCode: 'not_found', message: 'Plugin "x" not found\n…' }))).toEqual({ ok: false, code: 'not_found', line: 'Plugin "x" not found' });
    expect(classify(failed({ failureCode: 'error_unknown', message: OFFLINE_MSG }))).toMatchObject({ ok: false, code: 'offline' });
    expect(classify({ code: 1, stdout: '', stderr: 'fatal: Could not read from remote repository.\n' })).toEqual({ ok: false, code: 'offline', line: 'fatal: Could not read from remote repository.' });
    expect(classify(failed({ failureCode: 'error_unknown', message: 'weird\nx' }))).toEqual({ ok: false, code: 'unknown', line: 'weird' });
    expect(classify({ code: 0, stdout: 'not json', stderr: '' })).toEqual({ ok: false, code: 'unknown', line: 'not json' });
  });
});

describe('§5.2 toolkit_install', () => {
  test('§5.2 catalog order; marketplace add only when unknown (once per marketplace); install name@marketplace; afterWrite per plugin', async () => {
    knownFile(['ui-ux-pro-max-skill']); // the scripted "add" below makes the official marketplace known for the next plugins
    tk = new Toolkit({
      claudeHome: () => ch, claudePath: () => '/bin/claude',
      exec: async (argv) => { calls.push(argv); if (sub(argv).startsWith('marketplace-add')) knownFile([OFFICIAL, 'ui-ux-pro-max-skill']); return ok(); },
      git: async () => git, needsLogin: (id) => login.has(id), offForLanes: () => off, afterWrite: () => { written++; }, onChange: () => { changes++; }, now: () => now,
    });
    await tk.install(['vercel', 'superpowers', 'ui-ux-pro-max']);
    expect(subs()).toEqual(['marketplace-add anthropics/claude-plugins-official', `install ${SP}`, `install ${UX}`, `install ${VC}`]);
    expect(written).toBe(3);
  });

  test('§5.2 rows are running at once (ack), busy = the row whose step runs; failed rows carry the cause', async () => {
    knownFile([OFFICIAL]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let seen: ReturnType<Toolkit['view']> | null = null;
    tk = new Toolkit({
      claudeHome: () => ch, claudePath: () => '/bin/claude',
      exec: async (argv) => { calls.push(argv); seen ??= tk.view(); await gate; return sub(argv) === `install ${SP}` ? failed({ failureCode: 'not_found', message: 'not found' }) : ok(); },
      git: async () => git, needsLogin: (id) => login.has(id), offForLanes: () => off, afterWrite: () => {}, onChange: () => { changes++; }, now: () => now,
    });
    const p = tk.install(['superpowers', 'context7']);
    expect(tk.view().rows.filter((r) => r.state === 'running').map((r) => r.key)).toEqual(['superpowers', 'context7']);
    await Bun.sleep(5);
    expect(seen!.busy).toBe('superpowers');
    release();
    await p;
    expect(row('superpowers')).toMatchObject({ state: 'failed', error: { code: 'not_found', line: 'not found' } });
    expect(subs()).toEqual([`install ${SP}`, `install ${C7}`]); // a failed row does not stop the next
    expect(tk.view().busy).toBeUndefined();
    expect(changes).toBe(5); // a push when the rows start running, then when each row starts and ends
  });

  test('§5.2 TK1-git: git missing / license / error → plugin rows fail with the git cause, no `claude plugin` call', async () => {
    for (const [state, code, detail] of [['missing', 'git_missing', null], ['license', 'git_license', null], ['error', 'git_error', 'xcrun: error']] as const) {
      calls = [];
      git = { state, detail };
      await tk.install(['superpowers']);
      expect(calls).toEqual([]);
      expect(row('superpowers')).toMatchObject({ state: 'failed', error: { code, line: detail ?? '' } });
    }
  });

  test('§5.2 no claude on the login PATH → no_claude, nothing run', async () => {
    tk = new Toolkit({ claudeHome: () => ch, claudePath: () => null, exec: async (a) => { calls.push(a); return ok(); }, git: async () => git, needsLogin: (id) => login.has(id), offForLanes: () => off, afterWrite: () => {}, onChange: () => {} });
    await tk.install(['context7']);
    expect(calls).toEqual([]);
    expect(row('context7').error?.code).toBe('no_claude');
  });

  test('§5.2 pressing again only runs rows not installed yet; a later install clears the old failure', async () => {
    knownFile([OFFICIAL]);
    installedFile({ [SP]: [userRow('/a', '7.0.2')] });
    enabled([SP]);
    replies[`install ${C7}`] = [failed({ failureCode: 'error_unknown', message: 'x' })];
    await tk.install(['superpowers', 'context7']);
    expect(subs()).toEqual([`install ${C7}`]);
    expect(row('context7').state).toBe('failed');
    installedFile({ [SP]: [userRow('/a', '7.0.2')], [C7]: [userRow('/c', 'b5')] });
    enabled([SP, C7]);
    expect(row('context7').state).toBe('installed'); // installed from a terminal meanwhile: the old install failure is gone
  });

  test('ruling 00:55 a missing row carries the commands an install runs (marketplace add only while unknown); an installed row none', () => {
    knownFile(['ui-ux-pro-max-skill']);
    installedFile({ [VC]: [userRow('/v', '0.40.0')] });
    enabled([VC]);
    expect(row('superpowers').commands).toEqual(['claude plugin marketplace add anthropics/claude-plugins-official', `claude plugin install ${SP}`]);
    expect(row('ui-ux-pro-max').commands).toEqual([`claude plugin install ${UX}`]);
    expect(row('vercel').commands).toBeUndefined();
  });

  test('ruling 00:27 a row keeps the last 4 lines of its own `claude plugin` output (streamed lines, else the reply), pushed as they come', async () => {
    knownFile([OFFICIAL]);
    const seen: (string[] | undefined)[] = [];
    tk = new Toolkit({
      claudeHome: () => ch, claudePath: () => '/bin/claude',
      exec: async (argv, o) => {
        calls.push(argv);
        if (sub(argv) === `install ${SP}`) { for (const l of ['l1', 'l2', 'l3', 'l4', 'l5']) o?.onLine?.(l); return ok(); }
        return { code: 1, stdout: 'x1\nx2\n', stderr: 'boom\n' };
      },
      git: async () => git, needsLogin: () => false, offForLanes: () => off, afterWrite: () => {}, onChange: () => { seen.push(tk.view().rows.find((r) => r.key === 'superpowers')!.log); }, now: () => now,
    });
    await tk.install(['superpowers', 'context7']);
    expect(row('superpowers').log).toEqual(['l2', 'l3', 'l4', 'l5']);
    expect(seen.some((l) => l?.length === 1 && l[0] === 'l1')).toBe(true); // pushed line by line, not only at the end
    expect(row('context7')).toMatchObject({ state: 'failed', log: ['x1', 'x2', 'boom'] });
    await tk.install(['context7']);
    expect(row('context7').log).toEqual(['x1', 'x2', 'boom']); // a new run starts a fresh log (same reply again)
  });

  test('§5.2 the graph key is not a plugin: no `claude plugin` command for it; the graph install runs once, after every plugin', async () => {
    await tk.install(['graph', 'vercel']);
    expect(order).toEqual(['marketplace add', 'install vercel@claude-plugins-official', 'graph']);
    order = []; gtool = { state: 'ready', version: '0.12.1' };
    await tk.install(['graph']);
    expect(order).toEqual([]); // installed already: nothing to run
  });
});

describe('§5.2 toolkit_update', () => {
  beforeEach(() => {
    installedFile({ [SP]: [userRow('/a', '7.0.0', 'aaa')] });
    enabled([SP]);
    knownFile([OFFICIAL]);
    catalogFile(OFFICIAL, [{ name: 'superpowers', source: { source: 'url', url: 'u', sha: 'bbb' } }]);
  });

  test('§5.2 marketplace update → update <id> -s user → afterWrite; updated → the row says updated with the new version', async () => {
    await tk.check(false);
    expect(row('superpowers').state).toBe('outdated');
    calls = [];
    tk = new Toolkit({
      claudeHome: () => ch, claudePath: () => '/bin/claude',
      exec: async (argv) => {
        calls.push(argv);
        if (argv[2] === 'update') { installedFile({ [SP]: [userRow('/b', '7.0.2', 'bbb')] }); return ok({ updateOutcome: 'updated', oldVersion: '7.0.0', newVersion: '7.0.2' }); }
        return ok();
      },
      git: async () => git, needsLogin: (id) => login.has(id), offForLanes: () => off, afterWrite: () => { written++; }, onChange: () => {}, now: () => now,
    });
    await tk.update('superpowers');
    expect(calls.map((a) => a.slice(2))).toEqual([['marketplace', 'update', OFFICIAL, '--json'], ['update', SP, '--json', '-s', 'user']]);
    expect(row('superpowers')).toMatchObject({ state: 'installed', version: '7.0.2', updated: true });
    expect(written).toBe(1);
  });

  test('§5.2 up_to_date → back to installed, no updated mark', async () => {
    replies[`update ${SP}`] = [ok({ updateOutcome: 'up_to_date', oldVersion: '7.0.0', newVersion: '7.0.0' })];
    await tk.update('superpowers');
    expect(row('superpowers').state).toBe('installed');
    expect(row('superpowers').updated).toBeUndefined();
  });

  test('§5.2 a failed update → failed with the cause; the git rule applies too', async () => {
    replies[`update ${SP}`] = [failed({ failureCode: 'error_unknown', message: OFFLINE_MSG })];
    await tk.update('superpowers');
    expect(row('superpowers')).toMatchObject({ state: 'failed', error: { code: 'offline' } });
    calls = [];
    git = { state: 'license', detail: null };
    await tk.update('superpowers');
    expect(calls).toEqual([]);
    expect(row('superpowers').error?.code).toBe('git_license');
  });
});

describe('§5.2 one `claude plugin` queue', () => {
  test('§5.2 runs strictly one after another, in order, and a throw does not block the next', async () => {
    const q = new PluginQueue();
    const log: string[] = [];
    const job = (n: string, ms: number, boom = false) => q.run(async () => { log.push(`+${n}`); await Bun.sleep(ms); log.push(`-${n}`); if (boom) throw new Error(n); return n; });
    const r = await Promise.allSettled([job('a', 20, true), job('b', 1), job('c', 5)]);
    expect(log).toEqual(['+a', '-a', '+b', '-b', '+c', '-c']);
    expect(r.map((x) => x.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  });

  test('§5.2 install and check share the queue: a check during an install waits for it', async () => {
    knownFile([OFFICIAL]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    tk = new Toolkit({
      claudeHome: () => ch, claudePath: () => '/bin/claude',
      exec: async (argv) => { calls.push(argv); if (argv[2] === 'install') await gate; return ok(); },
      git: async () => git, needsLogin: (id) => login.has(id), offForLanes: () => off, afterWrite: () => {}, onChange: () => {}, now: () => now,
    });
    const a = tk.install(['superpowers']);
    const b = tk.check(true);
    await Bun.sleep(10);
    expect(subs()).toEqual([`install ${SP}`]);
    release();
    await Promise.all([a, b]);
    expect(subs()).toEqual([`install ${SP}`, `marketplace-update ${OFFICIAL}`]);
  });
});

describe('§5.3 the graph tool row (from the module view)', () => {
  const g = () => row('graph');
  test('missing → "Sẽ chạy" = the §5.6 install line; ready → installed; latest > version → outdated; old → outdated', () => {
    gtool = { state: 'missing', command: 'curl … | bash' };
    expect(g()).toEqual({ key: 'graph', kind: 'graph', state: 'missing', mcpLoginIds: [], commands: ['curl … | bash'] });
    gtool = { state: 'ready', version: '0.12.1', latest: '0.12.1' };
    expect(g()).toEqual({ key: 'graph', kind: 'graph', state: 'installed', version: '0.12.1', mcpLoginIds: [] });
    gtool = { state: 'ready', version: '0.12.1', latest: '0.13.0' };
    expect(g()).toMatchObject({ state: 'outdated', version: '0.12.1', latest: '0.13.0' });
    gtool = { state: 'old', version: '0.8.1' };
    expect(g()).toMatchObject({ state: 'outdated', version: '0.8.1' });
  });

  test('installing / updating → running with the run log; a failed run or `error` → failed with its line', () => {
    gtool = { state: 'installing', run: { kind: 'install', step: 2, log: ['a', 'b'] } };
    expect(g()).toMatchObject({ state: 'running', log: ['a', 'b'] });
    gtool = { state: 'missing', failed: { kind: 'install', line: 'curl: (6)' }, log: ['1', '2', '3', '4', 'curl: (6)'] };
    expect(g()).toMatchObject({ state: 'failed', error: { code: 'unknown', line: 'curl: (6)' }, log: ['2', '3', '4', 'curl: (6)'] });
    gtool = { state: 'error', version: '0.12.1', error: 'conflicting CBM process is active' };
    expect(g()).toMatchObject({ state: 'failed', error: { code: 'unknown', line: 'conflicting CBM process is active' } });
  });
});
