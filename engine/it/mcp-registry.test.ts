// v2.2 §5.4 / §8 "`claude mcp` giả": McpRegistry against fake-claude's `mcp add-json | remove` (a real process, a temp
// HOME). Never the real ~/.claude.json.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpRegistry, readClaudeJson, type LostEntry, type RegistryCode } from '../src/mcp/registry.ts';

const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
let tmp: string;
let file: string;
let plan: string;
let log: string;
let claude: string | null;
let reg: McpRegistry;
let written = 0;

const servers = () => (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers;
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
const setPlan = (p: Record<string, string[]>) => writeFileSync(plan, JSON.stringify(p));
const codeOf = async (f: () => Promise<unknown>): Promise<RegistryCode | 'ok'> => {
  try { await f(); return 'ok'; } catch (e) { return (e as { code: RegistryCode }).code; }
};
const A = { command: 'npx', args: ['-y', 'a'] };
const B = { type: 'http', url: 'https://b.example/mcp' };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-mcp-reg-'));
  file = join(tmp, '.claude.json');
  plan = join(tmp, 'plan.json');
  log = join(tmp, 'mcp.log');
  writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { a: A, b: B } }, null, 2));
  claude = join(tmp, 'claude');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(claude, 0o755);
  written = 0;
  reg = new McpRegistry({
    claudePath: () => claude, claudeJson: () => file, retryMs: 50, onWritten: () => { written++; },
    env: () => ({ PATH: process.env.PATH ?? '', HOME: tmp, FAKE_CLAUDE_MCP_PLAN: plan, FAKE_CLAUDE_MCP_LOG: log }),
  });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('§5.4 add / remove through `claude mcp`', () => {
  test('§5.4 add-json writes the entry, every other server and key intact, catalog told', async () => {
    await reg.add('c', { command: 'c-bin' });
    expect(servers()).toEqual({ a: A, b: B, c: { command: 'c-bin' } });
    expect(JSON.parse(readFileSync(file, 'utf8')).numStartups).toBe(3);
    expect(calls()).toEqual(['add-json c']);
    expect(written).toBe(1);
  });

  test('§5.4 / K4 "Client ID": add-json gets --client-secret, the secret only in env MCP_CLIENT_SECRET (never argv)', async () => {
    const seen: { argv: string[]; secret: string | undefined }[] = [];
    const spy = new McpRegistry({
      claudePath: () => claude, claudeJson: () => file, retryMs: 10, env: () => ({ PATH: '', HOME: tmp }),
      run: async (argv, env) => { seen.push({ argv, secret: env.MCP_CLIENT_SECRET }); return { code: 1, stdout: '', stderr: 'stop' }; },
    });
    const e = { type: 'http', url: 'https://c.example/mcp', oauth: { clientId: 'cid-1' } };
    await codeOf(() => spy.add('c', e, 'sek-ret'));
    expect(seen).toEqual([{ argv: [claude!, 'mcp', 'add-json', '-s', 'user', 'c', JSON.stringify(e), '--client-secret'], secret: 'sek-ret' }]);
    await codeOf(() => spy.add('c', e));
    expect(seen[1]).toEqual({ argv: [claude!, 'mcp', 'add-json', '-s', 'user', 'c', JSON.stringify(e)], secret: undefined });
    await reg.add('c', e, 'sek-ret'); // the fake CLI reads the flag + env like the real one
    expect(calls()).toEqual(['add-json c --client-secret=sek-ret']);
    expect(servers().c).toEqual(e);
  });

  test('§8 add-json of a taken name is never called (name checked first)', async () => {
    expect(await codeOf(() => reg.add('a', { command: 'x' }))).toBe('name_taken');
    expect(calls()).toEqual([]);
    expect(servers().a).toEqual(A);
  });

  test('§8 lost write (race) → retried re-read → K4e busy, file untouched by the engine', async () => {
    setPlan({ 'add-json': ['lost'] });
    expect(await codeOf(() => reg.add('c', { command: 'c-bin' }))).toBe('busy');
    expect(servers()).toEqual({ a: A, b: B });
  });

  test('§5.4 another server dropped by the write → busy (other-servers-intact check)', async () => {
    setPlan({ 'add-json': ['clobber'] });
    expect(await codeOf(() => reg.add('c', { command: 'c-bin' }))).toBe('busy');
  });

  test('§5.4 remove -s user; unknown name refused before the CLI', async () => {
    await reg.delete('a');
    expect(servers()).toEqual({ b: B });
    expect(await codeOf(() => reg.delete('zzz'))).toBe('not_found');
    expect(calls()).toEqual(['remove a']);
  });

  test('§5.4 claude missing → no_claude with the install command; bad name / entry refused', async () => {
    claude = null;
    const err = await reg.add('c', { command: 'x' }).catch((e: unknown) => e as { code: string; params: Record<string, string> });
    expect(err).toMatchObject({ code: 'no_claude', params: { cmd: expect.stringContaining('install.sh') } });
    claude = join(tmp, 'claude');
    expect(await codeOf(() => reg.add('-rf', { command: 'x' }))).toBe('bad_name');
    expect(await codeOf(() => reg.add('ok', { args: [] }))).toBe('bad_entry');
    expect(calls()).toEqual([]);
  });

  test('§6 K14 unreadable ~/.claude.json → refused with the line; nothing run', async () => {
    writeFileSync(file, '{\n  "mcpServers": {\n    "a": { "command": "x" },,\n  }\n}\n');
    expect(readClaudeJson(file)).toEqual({ ok: false, line: 3 });
    const err = await reg.add('c', { command: 'x' }).catch((e: unknown) => e as { code: string; params: Record<string, unknown> });
    expect(err).toMatchObject({ code: 'unreadable', params: { line: 3 } });
    expect(calls()).toEqual([]);
  });
});

describe('§5.4 C21 edit = snapshot → remove → add-json, with restore', () => {
  const lost: LostEntry[] = [];
  beforeEach(() => { lost.length = 0; });

  test('§5.4 edit in place: new entry, others intact', async () => {
    await reg.edit('a', 'a', { command: 'npx', args: ['-y', 'a@2'] }, (l) => lost.push(l));
    expect(servers()).toEqual({ a: { command: 'npx', args: ['-y', 'a@2'] }, b: B });
    expect(calls()).toEqual(['remove a', 'add-json a']);
  });

  test('§5.4 rename: new name taken → refused before any CLI call', async () => {
    expect(await codeOf(() => reg.edit('a', 'b', { command: 'x' }, (l) => lost.push(l)))).toBe('name_taken');
    expect(calls()).toEqual([]);
  });

  test('§8 K4e-restore: second add-json exit 1 → snapshot re-added, re-read == snapshot', async () => {
    setPlan({ 'add-json': ['fail'] });
    let params: unknown;
    try { await reg.edit('a', 'a', { command: 'new' }, (l) => lost.push(l)); } catch (e) { params = (e as { params?: unknown }).params; }
    expect(params).toEqual({ name: 'a', exit: 1, detail: 'fake-claude mcp: add-json failed (plan)' }); // K4e-restore shows the exit text
    expect(servers()).toEqual({ a: A, b: B });
    expect(calls()).toEqual(['remove a', 'add-json a', 'add-json a']);
    expect(lost).toEqual([]);
  });

  test('§8 restore fails too → lost + "Chép JSON cũ" payload; the engine never writes the file', async () => {
    setPlan({ 'add-json': ['fail', 'fail'] });
    const before = readFileSync(file, 'utf8');
    expect(await codeOf(() => reg.edit('a', 'a', { command: 'new' }, (l) => lost.push(l)))).toBe('lost');
    expect(servers()).toEqual({ b: B });
    expect(lost).toHaveLength(1);
    expect(JSON.parse(lost[0]!.json)).toEqual(A);
    expect(lost[0]!.command).toBe(`claude mcp add-json -s user 'a' '${JSON.stringify(A)}'`);
    expect(readFileSync(file, 'utf8')).not.toBe(before);
  });

  test('§5.4 step 2 re-read: entry gone AND another server dropped → snapshot re-added, still wrong → lost (b never rewritten)', async () => {
    setPlan({ remove: ['clobber'] });
    expect(await codeOf(() => reg.edit('a', 'a', { command: 'new' }, (l) => lost.push(l)))).toBe('lost');
    expect(servers()).toEqual({ a: A });
    expect(calls()).toEqual(['remove a', 'add-json a']);
    expect(lost.map((l) => l.name)).toEqual(['a']);
  });
});
