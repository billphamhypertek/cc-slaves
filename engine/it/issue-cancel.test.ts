// v2.7 §13 L671–672 Huỷ / hoàn tác over the real Engine with fake-claude (temp homes, a temp git repo, no network, no real
// quota): cancel `doing` → the lane process is gone before the issue changes (A4); cancel `done` → the "Hoàn tác …" issue →
// its lane's issue_done → original cancelled (§5.7-6); a conflict → the revert_conflict card (§5.7-5), "Giữ" answers it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { IssueCancelPreview, IssueCancelResult } from '../../shared/issues.ts';
import { getLane, insertProject, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import type { SystemPayload } from '../src/cards/store.ts';
import { getIssueByKey } from '../src/issues/store.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import type { CommandCtx } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { commit, git } from '../test/git/_repo.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(60_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test', A = 'a@x.test';
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const MAC: CommandCtx = { channel: 'mac' };
const REMOTE: CommandCtx = { channel: 'remote' };
const RESULT = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } };
const LOOP = { steps: Array.from({ length: 12 }, () => [{ waitUser: true }, RESULT]).flat() };
const SPEC = 'docs/specs/plan.md';

let tmp: string, repo: string, build: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let h: ReturnType<typeof buildHandlers>;

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
const issue = (key: string) => getIssueByKey(engine.db, 'p1', key)!;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const laneSid = (name: string) => getLane(engine.db, 'p1', name)!.sessionId!;
const brief = () => { const b = join(tmp, 'brief.md'); writeFileSync(b, 'brief'); return b; };

async function create(title: string): Promise<string> {
  const r = await tool(build, 'issue_create', { title, done_when: ['xong'] });
  expect(r.isError).toBe(false);
  return (JSON.parse(r.text) as { key: string }).key;
}
/** A lane in its own worktree (branch `<name>`) holding `key`, idle. */
async function laneOn(name: string, key: string): Promise<string> {
  const wt = join(tmp, `wt-${name}`);
  git(repo, 'worktree', 'add', '-q', '-b', name.toLowerCase(), wt);
  expect(await tool(build, 'lane_start', { name, cwd: wt, brief_path: brief(), issue: key })).toMatchObject({ isError: false });
  await until(() => engine.lanes.get('p1', name)?.state === 'idle', `${name} idle`);
  return wt;
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-cancel-')));
  repo = join(tmp, 'repo');
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-marketplace': true } }));
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  mkdirSync(join(repo, 'docs/specs'), { recursive: true });
  commit(repo, SPEC, `# Kế hoạch\nTrạng thái: đã duyệt\n${'mô tả '.repeat(60)}\n`); // §5.2-7 imported at boot, approved
  const db = openDb(paths().stateDb);
  seedAccounts([O, A], { db });
  const now = Math.floor(Date.now() / 1000);
  for (const a of [O, A]) upsertQuota(db, { account: a, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  insertProject(db, { id: 'p1', name: 'Shop', path: repo, orchestratorAccount: O });
  db.close();
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => {
      const f = join(tmp, `scn-${++rpc}.json`);
      writeFileSync(f, JSON.stringify(LOOP));
      return { FAKE_CLAUDE_SCENARIO: f };
    },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 8000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0,
    log: () => {}, hasLogin: () => true,
  });
  h = buildHandlers(engine, {} as Conn);
  ({ sessionId: build } = await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: SPEC }, MAC) as { sessionId: string });
  await until(() => engine.orchestrators.bySession(build)?.view().state === 'idle', 'build idle');
});

afterAll(async () => {
  await engine?.stop();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('v2.7 §13 L671–672 Huỷ / hoàn tác (Engine + fake-claude)', () => {
  test('§5.7-3 A4 cancel doing → the lane process is gone before the issue changes; issue cancelled, lane done, no revert', async () => {
    const key = await create('xuất PDF');
    const wt = await laneOn('D1', key);
    commit(wt, 'pdf.ts', 'x\n', `pdf\n\nIssue: ${key}`);
    const pid = engine.db.query<{ pid: number }, [string]>('SELECT pid FROM session WHERE id = ?').get(laneSid('D1'))!.pid;
    expect(alive(pid)).toBe(true);
    const pre = await h.issue_cancel_preview({ cmd: 'issue_cancel_preview', projectId: 'p1', key }, MAC) as IssueCancelPreview;
    expect(pre).toMatchObject({ mode: 'stop', lane: { name: 'D1', branch: 'd1', commits: 1 } });
    let violated = false;
    let polling = true;
    const poll = (async () => { while (polling) { if (issue(key).state !== 'doing' && alive(pid)) violated = true; await Bun.sleep(1); } })();
    const r = await h.issue_cancel({ cmd: 'issue_cancel', projectId: 'p1', key, reason: 'không cần' }, MAC) as IssueCancelResult;
    polling = false;
    await poll;
    expect(r).toEqual({ key, mode: 'stop', revertKey: null });
    expect(violated).toBe(false);
    expect(alive(pid)).toBe(false);
    expect(issue(key)).toMatchObject({ state: 'cancelled', revert: 'none', cancelReason: 'không cần' });
    await until(() => engine.lanes.get('p1', 'D1')?.state === 'done' || getLane(engine.db, 'p1', 'D1')!.state === 'done', 'D1 done');
  });

  test('§5.7-4 / §5.7-6 cancel done → "Hoàn tác …" issue (priority, same spec) → its lane issue_done → original cancelled, revert done', async () => {
    const key = await create('xuất CSV');
    const wt = await laneOn('D2', key);
    commit(wt, 'csv.ts', 'x\n', `csv\n\nIssue: ${key}`);
    expect(await tool(laneSid('D2'), 'issue_done', { key, summary: 'xong CSV' })).toMatchObject({ isError: false });
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge d2', 'd2');
    const pre = await h.issue_cancel_preview({ cmd: 'issue_cancel_preview', projectId: 'p1', key }, MAC) as IssueCancelPreview;
    expect(pre).toMatchObject({ mode: 'revert', revert: { branch: 'main', shas: [git(wt, 'rev-parse', 'HEAD')] } });
    const r = await h.issue_cancel({ cmd: 'issue_cancel', projectId: 'p1', key, reason: 'đổi ý' }, MAC) as IssueCancelResult;
    expect(r.mode).toBe('revert');
    expect(issue(key)).toMatchObject({ state: 'done', revert: 'pending' });
    const rv = issue(r.revertKey!);
    expect(rv).toMatchObject({ title: `Hoàn tác ${key}`, source: 'po', reverts: issue(key).id, specId: issue(key).specId });
    const view = engine.snapshot('mac').issues![0]!.issues.find((i) => i.key === rv.key)!;
    expect(view).toMatchObject({ priority: true, reverts: key, doneWhen: ['một commit Revert, test xanh, đã merge'] });
    await laneOn('R1', rv.key);
    expect(issue(key).revert).toBe('running');
    expect(await tool(laneSid('R1'), 'issue_done', { key: rv.key, summary: 'đã revert' })).toMatchObject({ isError: false });
    expect(issue(key)).toMatchObject({ state: 'cancelled', revert: 'done' });
  });

  test('§5.7-5 conflict → revert issue cancelled, original done + conflict, red revert_conflict card (remote: no buttons); "Giữ" → closed, revert none', async () => {
    const key = await create('xuất Excel');
    const wt = await laneOn('D3', key);
    commit(wt, 'xls.ts', 'x\n', `xls\n\nIssue: ${key}`);
    expect(await tool(laneSid('D3'), 'issue_done', { key, summary: 'xong' })).toMatchObject({ isError: false });
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge d3', 'd3');
    const { revertKey } = await h.issue_cancel({ cmd: 'issue_cancel', projectId: 'p1', key }, MAC) as IssueCancelResult;
    await laneOn('R2', revertKey!);
    expect(await tool(laneSid('R2'), 'issue_revert_conflict', { key: revertKey, detail: 'xung đột ở xls.ts' })).toMatchObject({ isError: false });
    expect(issue(revertKey!).state).toBe('cancelled');
    expect(issue(key)).toMatchObject({ state: 'done', revert: 'conflict' });
    const card = engine.cards.list({ status: 'open' }).find((c) => c.kind === 'revert_conflict')!;
    expect((card.payload as SystemPayload).actions.map((a) => a.action)).toEqual(['revert_keep', 'revert_cancel_both']);
    expect(engine.snapshot('remote').cards.find((c) => c.id === card.id)!.actions).toEqual([]); // §8
    expect(await Promise.resolve(h.card_action({ cmd: 'card_action', id: card.id, action: 'revert_keep' }, REMOTE)).catch((e: unknown) => (e as { code: string }).code)).toBe('forbidden_remote');
    expect(await h.card_action({ cmd: 'card_action', id: card.id, action: 'revert_cancel_both' }, MAC)).toMatchObject({ status: 'open' }); // UI-only
    expect(await h.card_action({ cmd: 'card_action', id: card.id, action: 'revert_keep' }, MAC)).toMatchObject({ status: 'answered' });
    expect(issue(key)).toMatchObject({ state: 'done', revert: 'none' });
  });
});
