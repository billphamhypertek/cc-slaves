import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { paths } from '../../src/paths.ts';
import { buildCatalog } from '../../src/mcp/catalog.ts';
import { denyRules, nextRunN, removeSessionFiles, writeSessionFiles } from '../../src/session/files.ts';
import { skillDenyPath, skillSettings } from '../../src/session/skills.ts';
import { stepOf } from '../../src/workflow/runtime.ts';
import { PO } from '../_fixtures/po-pack.ts';
import { builtinFiles, BUILTIN_SLUGS } from '../../src/workflow/builtin/index.ts';
import { compile } from '../../src/workflow/compile.ts';
import { validatePack } from '../../src/workflow/validate.ts';

let tmp: string;
const saved = process.env.CC_SLAVES_HOME;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ccs-files-')); process.env.CC_SLAVES_HOME = join(tmp, 'home'); });
afterEach(() => {
  if (saved === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});
const mode = (p: string) => statSync(p).mode & 0o777;

describe('engine deny settings (§7.2 N7)', () => {
  test('§7.2 N7 deny Read/Edit/Write/Bash/Grep/Glob on ~/.cc-slaves/** and ~/.cloudflared/** (home-relative form)', () => {
    const h = homedir();
    const rules = denyRules(join(h, '.cc-slaves'), join(h, '.cloudflared'));
    for (const t of ['Read', 'Edit', 'Write', 'Grep', 'Glob']) {
      expect(rules).toContain(`${t}(~/.cc-slaves/**)`);
      expect(rules).toContain(`${t}(~/.cloudflared/**)`);
    }
    expect(rules).toContain('Bash(*.cc-slaves*)');
    expect(rules).toContain('Bash(*.cloudflared*)');
  });
  test('§7.2 N7 MINOR-4 a short non-dot home name is not a Bash basename rule; the full path text is', () => {
    const rules = denyRules('/tmp/q/h', join(homedir(), '.cloudflared'));
    expect(rules).not.toContain('Bash(*h*)');
    expect(rules).toContain('Bash(*/tmp/q/h*)');
    expect(rules).toContain(`Bash(*${join(homedir(), '.cloudflared')}*)`);
    expect(rules).toContain('Bash(*~/.cloudflared*)');
  });
  test('§7.2 I3 Bash deny covers reading the engine WS token from the Keychain', () => {
    const rules = denyRules(join(homedir(), '.cc-slaves'), join(homedir(), '.cloudflared'));
    expect(rules).toContain('Bash(*cc-slaves-engine-token*)');
    expect(rules).toContain('Bash(*find-generic-password*)');
    // Claude Code Bash rules glob the command text; `*` = any run of characters.
    const bash = rules.filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5, -1));
    const hit = (cmd: string) => bash.some((g) => new RegExp(`^${g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(cmd));
    expect(hit('/usr/bin/security find-generic-password -s cc-slaves-engine-token -w')).toBe(true);
    expect(hit('security find-generic-password -a cc-slaves -w')).toBe(true);
    expect(hit('security dump-keychain | grep cc-slaves-engine-token')).toBe(true);
    expect(hit('git status')).toBe(false);
  });
  test('§7 D24 the two app-signing deny rules are gone; every other engine deny rule stays', () => {
    const h = homedir();
    const rules = denyRules(join(h, '.cc-slaves'), join(h, '.cloudflared'), join(h, '.cc-slaves-accounts'));
    expect(rules.some((r) => r.includes('app-signing') || r.includes('app-pubkey'))).toBe(false);
    for (const t of ['Read', 'Edit', 'Write', 'Grep', 'Glob']) expect(rules).toContain(`${t}(~/.cc-slaves/**)`);
    for (const r of ['Bash(*cc-slaves-engine-token*)', 'Bash(*cc-slaves-mcp*)', 'Bash(*find-generic-password*)', 'Bash(*delete-generic-password*)', 'Bash(*.cc-slaves*)']) {
      expect(rules).toContain(r);
    }
  });
  test('§7 v2 deny: account .claude.json (Read/Edit/Write + Bash text), keychain delete and the Claude Code item', () => {
    const h = homedir();
    const root = join(h, '.cc-slaves-accounts');
    const rules = denyRules(join(h, '.cc-slaves'), join(h, '.cloudflared'), root);
    for (const t of ['Read', 'Edit', 'Write']) expect(rules).toContain(`${t}(~/.cc-slaves-accounts/*/.claude.json)`);
    for (const r of ['Bash(*.cc-slaves-accounts*/.claude.json*)', 'Bash(*delete-generic-password*)', 'Bash(*Claude Code-credentials*)']) {
      expect(rules).toContain(r);
    }
    const bash = rules.filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5, -1));
    const hit = (cmd: string) => bash.some((g) => new RegExp(`^${g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(cmd));
    expect(hit('cat ~/.cc-slaves-accounts/0123456789ab/.claude.json')).toBe(true);
    expect(hit(`jq . ${root}/0123456789ab/.claude.json`)).toBe(true);
    expect(hit('security delete-generic-password -s x')).toBe(true);
    expect(hit('security find-internet-password -s "Claude Code-credentials-1a2b3c4d"')).toBe(true);
  });
  test('§8 denyRules() never matches <accountsRoot>/<id>/projects/… or …/plans/… for path tools; matches …/.claude.json', () => {
    const h = homedir();
    for (const root of [join(h, '.cc-slaves-accounts'), '/tmp/q/accts']) {
      const rules = denyRules(join(h, '.cc-slaves'), join(h, '.cloudflared'), root);
      // Claude Code path rules: `~/` = home, `//` = absolute; `**` any depth, `*` one segment.
      const rx = (g: string) => new RegExp(`^${g.replace(/^~\//, `${h}/`).replace(/^\/\//, '/').split('**').map((part) => part.split('*')
        .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
      const denied = (tool: string, path: string) => rules.some((r) => r.startsWith(`${tool}(`) && rx(r.slice(tool.length + 1, -1)).test(path));
      for (const t of ['Read', 'Edit', 'Write', 'Grep', 'Glob']) {
        expect(denied(t, `${root}/0123456789ab/projects/-Users-x-repo/memory/m.md`)).toBe(false);
        expect(denied(t, `${root}/0123456789ab/plans/p.md`)).toBe(false);
      }
      for (const t of ['Read', 'Edit', 'Write']) expect(denied(t, `${root}/0123456789ab/.claude.json`)).toBe(true);
      expect(denied('Read', join(h, '.cc-slaves', 'engine.json'))).toBe(true); // the matcher itself works
    }
  });
  test('§7.2 N7 a root outside home uses the absolute // form', () => {
    expect(denyRules('/tmp/x/.cc-slaves', '/tmp/x/.cloudflared')).toContain('Read(//tmp/x/.cc-slaves/**)');
  });
  test('§7.2 M18 / v2.2 §5.5 per-session settings file is 0600 in a 0700 dir and holds permissions.deny', () => {
    const p = writeSessionFiles('s-1', { port: 1, projectId: 'p' }).settingsPath;
    expect(p).toBe(join(tmp, 'home', 'settings', 's-1.json'));
    expect(mode(p)).toBe(0o600);
    expect(mode(join(tmp, 'home', 'settings'))).toBe(0o700);
    const j = JSON.parse(readFileSync(p, 'utf8'));
    expect(Object.keys(j)).toEqual(['permissions']); // v2.9: the skill block comes with a pinned step
    expect(j.permissions.deny).toContain(`Read(//${join(tmp, 'home').slice(1)}/**)`);
    // tmp home (outside ~, not a dot-dir): 5 tools + full path; ~/.cloudflared: 5 tools + full path + ~ form + basename;
    // + 3 Keychain rules (I3 token, v2.2 §5.3 cc-slaves-mcp, find-generic-password) + v2 §7 (the 2 app signing rules went with D24): 3 account .claude.json path rules,
    // 1 Bash .claude.json rule, delete-generic-password, Claude Code-credentials; the skill deny forms come with a pinned step (v2.9 §10.1).
    expect(j.permissions.deny).toHaveLength(23);
    expect(j.permissions.deny).toContain(`Read(${paths().accountsRoot.startsWith(homedir()) ? '~' : '/'}${paths().accountsRoot.replace(homedir(), '')}/*/.claude.json)`);
  });
  test('§5.5 skills off → skillOverrides "off"; plugins off → enabledPlugins false; deny rules kept', () => {
    const p = writeSessionFiles('s-2', { port: 1, projectId: 'p', off: { skills: ['h-ops'], plugins: ['vercel@claude-plugins-official'] } }).settingsPath;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    expect(j.skillOverrides).toEqual({ 'h-ops': 'off' });
    expect(j.enabledPlugins).toEqual({ 'vercel@claude-plugins-official': false });
    expect(j.permissions.deny).toHaveLength(23);
  });
  test('v2.9 §10.1 settings per pinned step: engine deny rules kept + the step\'s Skill deny forms + the hook + its .tsv; no step = none', () => {
    const bare = JSON.parse(readFileSync(writeSessionFiles('s-0', { port: 1, projectId: 'p' }).settingsPath, 'utf8'));
    const engine = bare.permissions.deny;
    expect(engine).toHaveLength(23);
    expect(engine.some((r: string) => r.startsWith('Skill('))).toBe(false);
    expect(bare.hooks).toBeUndefined();
    for (const kind of ['design', 'build', 'general', 'lane'] as const) {
      const step = stepOf(PO, kind)!;
      const j = JSON.parse(readFileSync(writeSessionFiles(`s-${kind}`, { port: 1, projectId: 'p', step }).settingsPath, 'utf8'));
      expect(j.permissions.deny).toEqual([...engine, ...step.deny]);
      expect(j.hooks).toEqual(skillSettings(`s-${kind}`, step).hooks);
      expect(readFileSync(skillDenyPath(`s-${kind}`), 'utf8')).toBe(step.gate);
    }
    removeSessionFiles('s-build');
    expect(existsSync(skillDenyPath('s-build'))).toBe(false);
  });
});

describe('session MCP file (§7.3, v2.2 §5.1)', () => {
  const http = (url: string) => ({ type: 'http', url });
  test('§7.3 mcp/<session>.json: HTTP cc_slaves on 127.0.0.1 with a per-session bearer token, 0600', () => {
    const r = writeSessionFiles('s-1', { port: 4567, projectId: 'p' }, () => 'tok-abc');
    expect([r.mcpPath, r.token, [...r.mcpIds]]).toEqual([join(tmp, 'home', 'mcp', 's-1.json'), 'tok-abc', []]);
    expect(mode(r.mcpPath)).toBe(0o600);
    expect(mode(join(tmp, 'home', 'mcp'))).toBe(0o700);
    expect(JSON.parse(readFileSync(r.mcpPath, 'utf8'))).toEqual({
      mcpServers: { cc_slaves: { type: 'http', url: 'http://127.0.0.1:4567/mcp', headers: { Authorization: 'Bearer tok-abc' } } },
    });
  });
  test('§7.3 default token generator gives distinct, long tokens', () => {
    const a = writeSessionFiles('s-a', { port: 1, projectId: 'p' }).token, b = writeSessionFiles('s-b', { port: 1, projectId: 'p' }).token;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
  test('§5.1 the catalog set of the project goes into the file; mcpIds = the proxied ids; cc_slaves wins', () => {
    const catalog = buildCatalog({ claudeJson: { mcpServers: { linear: http('https://l'), cc_slaves: http('evil') } }, projectMcp: {}, plugins: [] }, [], { offForLanes: [], projectOn: [], pluginsOff: [] });
    const r = writeSessionFiles('s-m', { port: 4567, projectId: 'p', catalog }, () => 'tok');
    expect(JSON.parse(readFileSync(r.mcpPath, 'utf8')).mcpServers).toEqual({
      linear: { type: 'http', url: 'http://127.0.0.1:4567/mcp-proxy/user%3Alinear', headers: { Authorization: 'Bearer tok' } },
      cc_slaves: { type: 'http', url: 'http://127.0.0.1:4567/mcp', headers: { Authorization: 'Bearer tok' } },
    });
    expect([...r.mcpIds]).toEqual(['user:linear']);
  });
  test('§5.5 removeSessionFiles deletes both the MCP file and the settings file of the session (others stay)', () => {
    const a = writeSessionFiles('s-x', { port: 1, projectId: 'p' }), b = writeSessionFiles('s-y', { port: 1, projectId: 'p' });
    removeSessionFiles('s-x');
    expect([existsSync(a.mcpPath), existsSync(a.settingsPath), existsSync(b.mcpPath), existsSync(b.settingsPath)]).toEqual([false, false, true, true]);
    removeSessionFiles('s-x'); // twice: no throw
  });
});

describe('run log numbering (§8.4 logs/<project>/<lane>/run-N.jsonl, smoke g6 concern 5)', () => {
  test('nextRunN continues from the max N on disk, across boots (orchestrator has no run rows)', () => {
    expect(nextRunN('p1', '_orchestrator', 0)).toBe(1); // no dir yet
    const dir = dirname(paths().runLog('p1', '_orchestrator', 1));
    mkdirSync(dir, { recursive: true });
    for (const f of ['run-1.jsonl', 'run-3.jsonl', 'run-x.jsonl', 'run-7.jsonl.bak', 'notes.txt']) writeFileSync(join(dir, f), '');
    expect(nextRunN('p1', '_orchestrator', 0)).toBe(4);
    expect(nextRunN('p1', 'D1', 0)).toBe(1); // other lane dir
  });

  test('nextRunN: the in-memory / run-table max wins when it is higher', () => {
    const dir = dirname(paths().runLog('p1', 'D1', 1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run-2.jsonl'), '');
    expect(nextRunN('p1', 'D1', 5)).toBe(6);
    expect(nextRunN('p1', 'D1', 1)).toBe(3);
  });
});

describe('v2.5 §5.7 graph entry × workflow packs (R2)', () => {
  const steps = BUILTIN_SLUGS.flatMap((slug) => compile(validatePack(builtinFiles(slug)).workflow!).steps.map((step) => ({ slug, step })));
  const graphEntry = { type: 'http', url: 'http://127.0.0.1:4567/mcp-graph', headers: { Authorization: 'Bearer tok' } };
  const read = (f: string) => readFileSync(f, 'utf8');

  test('§5.7 SessionSetup.graph on → the cc-slaves graph entry in the MCP file; off / null → none', () => {
    const file = (sid: string, graph: { on: boolean } | null) =>
      JSON.parse(read(writeSessionFiles(sid, { port: 4567, projectId: 'p', graph }, () => 'tok').mcpPath)).mcpServers as Record<string, unknown>;
    expect(file('s-on', { on: true })['codebase-memory-mcp']).toEqual(graphEntry);
    expect(Object.keys(file('s-off', { on: false }))).toEqual(['cc_slaves']);
    expect(Object.keys(file('s-null', null))).toEqual(['cc_slaves']);
  });

  test('R2 every step of every built-in pack gets the same graph entry; only the MCP file changes, the settings file is byte-identical', () => {
    expect(steps.length).toBeGreaterThanOrEqual(BUILTIN_SLUGS.length * 2);
    for (const { slug, step } of steps) {
      const sid = `${slug}-${step.id}`;
      const off = writeSessionFiles(sid, { port: 4567, projectId: 'p', step }, () => 'tok');
      const before = { settings: read(off.settingsPath), gate: read(skillDenyPath(sid)) };
      const on = writeSessionFiles(sid, { port: 4567, projectId: 'p', step, graph: { on: true } }, () => 'tok');
      const mcp = JSON.parse(read(on.mcpPath)).mcpServers;
      expect([sid, mcp['codebase-memory-mcp']]).toEqual([sid, graphEntry]);
      expect([sid, Object.keys(mcp).sort()]).toEqual([sid, ['cc_slaves', 'codebase-memory-mcp']]);
      expect([sid, { settings: read(on.settingsPath), gate: read(skillDenyPath(sid)) }]).toEqual([sid, before]);
    }
  });
});
