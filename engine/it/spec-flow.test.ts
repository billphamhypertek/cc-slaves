// v2.7 §13 L650–651 the whole spec flow over the real Engine with fake-claude (temp homes, no network, no real quota):
// spec_new → Thiết kế session (--settings lets brainstorming) → spec_draft / spec_approve over MCP → spec_build → Build
// session (--settings blocks it) → lane_start {issue} → issue_done (the lane) → spec_close. Plus the §5.2-7 boot scan.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getLane, insertOutbox, insertProject, insertSession, markDelivered, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { getIssueByKey, getSpecByPath } from '../src/issues/store.ts';
import { hashOf } from '../test/_fixtures/po-pack.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import type { CommandCtx } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(60_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test', A = 'a@x.test';
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const MAC: CommandCtx = { channel: 'mac' };
const RESULT = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } };
const LOOP = { steps: Array.from({ length: 12 }, () => [{ waitUser: true }, RESULT]).flat() };
const SPEC = 'docs/specs/2026-11-20-v29-design.md';
const PAD = `${'mô tả '.repeat(60)}\n`;

let tmp: string, repo: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let h: ReturnType<typeof buildHandlers>;
const traces: string[] = [];

async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(20);
  }
}
const token = (sid: string) => (JSON.parse(readFileSync(paths().mcpConfig(sid), 'utf8')) as { mcpServers: { cc_slaves: { headers: { Authorization: string } } } })
  .mcpServers.cc_slaves.headers.Authorization.replace('Bearer ', '');
let rpc = 0;
async function tool(sid: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(`http://127.0.0.1:${engine.port}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${token(sid)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const r = ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: r.isError === true, text: r.content[0]!.text };
}
/** The `--settings` file of the spawn that ran `sid`. */
function settingsOf(sid: string): { permissions: { deny: string[] } } {
  const argv = traces.filter((f) => existsSync(f)).map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { argv: string[] }).argv).find((a) => a.includes(sid))!;
  return JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1]!, 'utf8')) as { permissions: { deny: string[] } };
}
const state = (sid: string) => engine.orchestrators.bySession(sid)?.view().state;

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-specflow-')));
  repo = join(tmp, 'repo');
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-marketplace': true } }));
  mkdirSync(join(repo, 'docs/specs'), { recursive: true });
  writeFileSync(join(repo, 'docs/specs/old-plan.md'), `# Kế hoạch cũ\nTrạng thái: đã duyệt\n${PAD}`); // §5.2-7 imported at boot
  const db = openDb(paths().stateDb);
  seedAccounts([O, A], { db });
  const now = Math.floor(Date.now() / 1000);
  for (const a of [O, A]) upsertQuota(db, { account: a, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  insertProject(db, { id: 'p1', name: 'Shop', path: repo, orchestratorAccount: O });
  insertSession(db, { id: 'chung', projectId: 'p1', kind: 'orchestrator', account: O }); // R26 the project's Chung session
  db.query("UPDATE session SET state = 'idle', prompt_hash = ?, seq = 1, account_home = ? WHERE id = 'chung'").run(hashOf('general'), O);
  markDelivered(db, insertOutbox(db, { sessionId: 'chung', text: 'tin đầu', prefix: '[cc-slaves]' }).uuid);
  db.close();
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => {
      const n = traces.length + 1;
      const f = join(tmp, `scn-${n}.json`);
      writeFileSync(f, JSON.stringify(LOOP));
      const trace = join(tmp, `trace-${n}.json`);
      traces.push(trace);
      return { FAKE_CLAUDE_SCENARIO: f, FAKE_CLAUDE_TRACE: trace };
    },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }), // not a git repo: base_sha null, no trailer check (R-B2)
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
  });
  h = buildHandlers(engine, {} as Conn);
});

afterAll(async () => {
  await engine?.stop();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('v2.7 §13 spec flow (Engine + fake-claude)', () => {
  test('§5.2-7 / §4.9 project open = engine start: docs/specs scanned, the approved one imported, IS16 count on the project view', () => {
    expect(getSpecByPath(engine.db, 'p1', 'docs/specs/old-plan.md')).toMatchObject({ origin: 'imported', state: 'approved', title: 'Kế hoạch cũ' });
    const snap = engine.snapshot('mac');
    expect(snap.projects[0]!.specsImported).toBe(1);
    expect(snap.issues![0]!.specs.map((s) => s.path)).toEqual(['docs/specs/old-plan.md']);
    expect(engine.snapshot('remote').issues).toBeUndefined(); // §8 Mac only
  });

  test('§13 L650–651 spec_new → design (brainstorming allowed) → spec_draft / spec_approve → spec_build → build (blocked) → lane_start {issue} → issue_done → spec_close', async () => {
    // + Spec mới: a Thiết kế session, ack = its id; its --settings let brainstorming through
    const { sessionId: d } = await h.spec_new({ cmd: 'spec_new', projectId: 'p1' }, MAC) as { sessionId: string };
    await until(() => state(d) === 'idle', 'design idle');
    expect(settingsOf(d).permissions.deny).not.toContain('Skill(superpowers:brainstorming)');
    expect(engine.snapshot('mac').orchestrators.find((o) => o.sessionId === d)?.orchKind).toBe('design'); // R-B13 (e)

    writeFileSync(join(repo, SPEC), `# v2.9 xuất báo cáo\nTrạng thái: nháp\n${PAD}`);
    expect(await tool(d, 'spec_draft', { path: SPEC })).toMatchObject({ isError: false });
    expect(getSpecByPath(engine.db, 'p1', SPEC)).toMatchObject({ state: 'draft', designSession: d, origin: 'app' });
    expect(await tool(d, 'spec_approve', { path: SPEC })).toMatchObject({ isError: false });
    expect(getSpecByPath(engine.db, 'p1', SPEC)!.state).toBe('approved');

    // Bắt đầu build: a Build session bound to the spec; its --settings block brainstorming
    const { sessionId: b } = await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: SPEC }, MAC) as { sessionId: string };
    await until(() => state(b) === 'idle', 'build idle');
    expect(getSpecByPath(engine.db, 'p1', SPEC)).toMatchObject({ state: 'active', buildSession: b });
    expect(settingsOf(b).permissions.deny).toContain('Skill(superpowers:brainstorming)');

    const created = await tool(b, 'issue_create', { title: 'xuất CSV', done_when: ['có nút Xuất'] });
    expect(created.isError).toBe(false);
    const key = (JSON.parse(created.text) as { key: string }).key;
    mkdirSync(join(tmp, 'wt-d1'));
    writeFileSync(join(tmp, 'brief.md'), 'brief');
    expect(await tool(b, 'lane_start', { name: 'D1', cwd: join(tmp, 'wt-d1'), brief_path: join(tmp, 'brief.md'), issue: key })).toMatchObject({ isError: false });
    expect(getIssueByKey(engine.db, 'p1', key)).toMatchObject({ state: 'doing', baseSha: null });
    await until(() => engine.lanes.get('p1', 'D1')?.state === 'idle', 'lane idle');
    const laneSid = getLane(engine.db, 'p1', 'D1')!.sessionId!;
    expect(await tool(laneSid, 'issue_done', { key, summary: 'xong CSV' })).toMatchObject({ isError: false });
    expect(getIssueByKey(engine.db, 'p1', key)!.state).toBe('done');
    const view = engine.snapshot('mac').issues![0]!;
    expect(view.specs.find((s) => s.path === SPEC)!.progress).toMatchObject({ done: 1, total: 1 });
    expect(view.issues.find((i) => i.key === key)).toMatchObject({ state: 'done', lane: { name: 'D1' }, doneWhen: ['có nút Xuất'] });

    expect(await tool(b, 'spec_close', { path: SPEC })).toMatchObject({ isError: false });
    expect(getSpecByPath(engine.db, 'p1', SPEC)!.state).toBe('done');
    await until(() => engine.orchestrators.bySession(b) === null, 'build session ended after its handoff turn');
  });
});
