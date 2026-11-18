// v2.5 §5.3 the graph tool: one path (login PATH, else ~/.local/bin), `--version` re-read only when the file changed,
// state against MIN_GRAPH_VERSION; A1 the env every spawn of it gets (no CLAUDE_CONFIG_DIR, no CBM_CACHE_DIR).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_GRAPH_VERSION } from '../../../shared/graph.ts';
import { GraphTool, graphEnv } from '../../src/graph/tool.ts';

let tmp: string;
const exe = (p: string, body = '#!/bin/sh\necho 0.12.1\n') => { writeFileSync(p, body); chmodSync(p, 0o755); };

beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'ccs-graph-tool-')); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function tool(env: Record<string, string>, versions: string[] | (() => string)) {
  const calls: string[] = [];
  const t = new GraphTool({
    env,
    versionOf: async (path) => { calls.push(path); return typeof versions === 'function' ? versions() : versions.shift() ?? ''; },
  });
  return { t, calls };
}

describe('§5.3 finding the tool', () => {
  test('on the login PATH first; ~/.local/bin only when PATH has none; neither → missing', async () => {
    const onPath = join(tmp, 'p1'); const home = join(tmp, 'h1');
    mkdirSync(onPath, { recursive: true }); mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    exe(join(home, '.local', 'bin', 'codebase-memory-mcp'));
    const a = tool({ PATH: onPath, HOME: home }, ['0.12.1']);
    expect(await a.t.read()).toEqual({ state: 'ready', path: join(home, '.local', 'bin', 'codebase-memory-mcp'), version: '0.12.1' });
    exe(join(onPath, 'codebase-memory-mcp'));
    const b = tool({ PATH: onPath, HOME: home }, ['0.12.1']);
    expect(await b.t.read()).toMatchObject({ path: join(onPath, 'codebase-memory-mcp') });
    const c = tool({ PATH: join(tmp, 'none'), HOME: join(tmp, 'nohome') }, []);
    expect(await c.t.read()).toEqual({ state: 'missing' });
    expect(c.calls).toEqual([]);
  });
});

describe('§5.3 version against MIN_GRAPH_VERSION', () => {
  const dir = () => { const d = mkdtempSync(join(tmp, 'v-')); exe(join(d, 'codebase-memory-mcp')); return d; };
  test.each([
    ['0.8.1', 'old'], ['0.12.0', 'old'], ['0.9.9', 'old'], [MIN_GRAPH_VERSION, 'ready'], ['0.12.2', 'ready'], ['0.13.0', 'ready'],
    ['1.0.0', 'ready'], ['codebase-memory-mcp 0.12.10\n', 'ready'],
  ])('`--version` %p → %p', async (out, state) => {
    const { t } = tool({ PATH: dir() }, [out]);
    expect((await t.read()).state).toBe(state as 'old' | 'ready');
  });
  test('no version in the output, or `--version` fails → error with the line', async () => {
    const d = dir();
    expect(await tool({ PATH: d }, ['boom']).t.read()).toMatchObject({ state: 'error', line: 'boom' });
    const t = new GraphTool({ env: { PATH: d }, versionOf: () => Promise.reject(new Error('exit 69')) });
    expect(await t.read()).toMatchObject({ state: 'error', line: 'exit 69' });
  });
  test('`--version` runs again only when the file changed (the user updated it in a terminal)', async () => {
    const d = dir();
    const file = join(d, 'codebase-memory-mcp');
    const { t, calls } = tool({ PATH: d }, ['0.8.1', '0.12.1']);
    expect((await t.read()).state).toBe('old');
    expect((await t.read()).state).toBe('old');
    expect(calls).toHaveLength(1);
    exe(file, '#!/bin/sh\n# a new build, a different size\necho 0.12.1\n');
    expect(await t.read()).toMatchObject({ state: 'ready', version: '0.12.1' });
    expect(calls).toHaveLength(2);
  });
  test('the real `--version` runner reads the file output (default runner)', async () => {
    const d = dir();
    exe(join(d, 'codebase-memory-mcp'), '#!/bin/sh\necho "0.12.3"\n');
    expect(await new GraphTool({ env: { PATH: d } }).read()).toMatchObject({ state: 'ready', version: '0.12.3' });
  });
});

describe('A1 the graph env', () => {
  test('login env without CLAUDE_CONFIG_DIR, CBM_CACHE_DIR or ANTHROPIC_*; PATH / HOME / DEVELOPER_DIR kept', () => {
    const e = graphEnv({ PATH: '/b', HOME: '/h', DEVELOPER_DIR: '/d', CLAUDE_CONFIG_DIR: '/c', CBM_CACHE_DIR: '/x', ANTHROPIC_API_KEY: 'k' });
    expect(e).toEqual({ PATH: '/b', HOME: '/h', DEVELOPER_DIR: '/d' });
  });
  test('the `--version` spawn gets that env too (one env for every spawn)', async () => {
    const d = mkdtempSync(join(tmp, 'env-'));
    exe(join(d, 'codebase-memory-mcp'), '#!/bin/sh\nif [ -n "$CBM_CACHE_DIR$CLAUDE_CONFIG_DIR" ]; then echo leaked; else echo 0.12.1; fi\n');
    const t = new GraphTool({ env: { PATH: `${d}:/usr/bin:/bin`, CBM_CACHE_DIR: '/x', CLAUDE_CONFIG_DIR: '/c' } });
    expect(await t.read()).toMatchObject({ state: 'ready' });
  });
});
