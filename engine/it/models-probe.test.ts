// v2.4 §5.4 the probe process against fake-claude: argv / cwd / env, no user line, one in-flight probe per (account,
// project), > cap or an error reply → killed + `unavailable`, the 60 s cache. Never real claude, never real quota.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModelCache, ModelSource, UNAVAILABLE, type ProbeDeps } from '../src/models.ts';

const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
let tmp: string;
let proj: string;
let n = 0;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-probe-'));
  proj = join(tmp, 'proj');
  mkdirSync(proj);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function setup(control: object, o: Partial<ProbeDeps> = {}) {
  const scenario = join(tmp, `s${++n}.json`);
  writeFileSync(scenario, JSON.stringify({ steps: [], control }));
  const stdin = join(tmp, 'stdin.log'), trace = join(tmp, 'trace.json');
  const marker = `--ccs-probe-marker-${process.pid}-${n}`;
  const pre: string[] = [];
  const d: ProbeDeps = {
    cache: new ModelCache(), configDir: (a) => `/accts/${a}`, flagged: () => false,
    preSpawn: (dir) => { pre.push(dir); return true; },
    command: ['bun', FAKE, marker],
    env: (a) => ({ PATH: process.env.PATH ?? '', HOME: tmp, CLAUDE_CONFIG_DIR: `/accts/${a}`, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_STDIN_LOG: stdin, FAKE_CLAUDE_TRACE: trace }),
    timeoutMs: 3_000, ...o,
  };
  const lines = () => (existsSync(stdin) ? readFileSync(stdin, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; request?: { subtype: string } }) : []);
  const alive = () => Bun.spawnSync(['pgrep', '-f', '--', marker]).exitCode === 0;
  return { d, src: new ModelSource(d), lines, trace, pre, alive };
}

describe('§5.4 probe process (fake-claude)', () => {
  test('§5.4 probe: cwd = project, account env, setting sources, no persistence, empty strict MCP; two control lines, no user line', async () => {
    const f = setup({});
    const r = await f.src.list('a@x', proj);
    expect(r.unavailable).toBeUndefined();
    expect(r.models.map((m) => m.value)).toContain('sonnet');
    expect(r).toMatchObject({ defaultModel: 'fable' }); // fake's userSettings layer has model "fable"
    expect(f.pre).toEqual(['/accts/a@x']);
    const t = JSON.parse(readFileSync(f.trace, 'utf8')) as { argv: string[]; cwd: string; envKeys: string[] };
    expect(t.cwd.endsWith('/proj')).toBe(true);
    expect(t.envKeys).toContain('CLAUDE_CONFIG_DIR');
    const a = t.argv.join(' ');
    for (const x of ['--setting-sources user,project,local', '--no-session-persistence', '--strict-mcp-config', '--mcp-config {"mcpServers":{}}']) expect(a).toContain(x);
    expect(a).not.toContain('--session-id');
    expect(f.lines().map((l) => `${l.type}:${l.request?.subtype}`).sort()).toEqual(['control_request:get_settings', 'control_request:list_models']);
  });

  test('§5.4 one in-flight probe per (account, project): the second caller shares it; a fresh cache spawns nothing', async () => {
    const f = setup({ delayMs: 300 });
    const [a, b] = await Promise.all([f.src.list('a@x', proj), f.src.list('a@x', proj)]);
    expect(a).toEqual(b);
    expect(a.unavailable).toBeUndefined();
    expect(f.lines()).toHaveLength(2);
    expect(f.pre).toHaveLength(1);
    await f.src.list('a@x', proj); // < 60 s: from the cache
    expect(f.lines()).toHaveLength(2);
  });

  test('§5.4 no reply within the cap → killed, unavailable', async () => {
    const f = setup({ fail: { list_models: 'silent' } }, { timeoutMs: 400 });
    const t0 = Date.now();
    const r = f.src.list('a@x', proj);
    await Bun.sleep(250);
    expect(f.alive()).toBe(true); // the probe is running (the check below is not vacuous)
    expect(await r).toEqual(UNAVAILABLE);
    expect(Date.now() - t0).toBeLessThan(2_000);
    await Bun.sleep(150);
    expect(f.alive()).toBe(false);
  });

  test('§5.4 an error reply → killed, unavailable; nothing cached (the next call probes again)', async () => {
    const f = setup({ fail: { get_settings: 'unsupported_request' } });
    expect(await f.src.list('a@x', proj)).toEqual(UNAVAILABLE);
    await Bun.sleep(150);
    expect(f.alive()).toBe(false);
    expect(f.d.cache.models('a@x')).toBeNull();
    await f.src.list('a@x', proj);
    expect(f.lines()).toHaveLength(4);
  });
});
