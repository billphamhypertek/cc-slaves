// v2.9 §5.9 / §12 the author session over the real Engine with fake-claude (temp homes, no network, no real quota): the whitelist
// argv reaches `claude` (R20), a valid draft → `workflow_draft` with no error, writes outside `pack/` are never read, a broken
// draft → exactly one Kiểm gói per turn and a stop after 3, `draft_save` refused after an engine line and taken after the user's,
// Hoàn tác, a stale base rev → conflict, Bỏ nháp deletes the folder, an engine line + the user line merged into one turn in
// both replay orders.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EngineEvent } from '../../shared/protocol.ts';
import type { DraftView, WorkflowDetail, WorkflowRow, WorkflowSaveResult } from '../../shared/workflows.ts';
import { openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { route, type CommandCtx } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { builtinFiles } from '../src/workflow/builtin/index.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(60_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const MAC: CommandCtx = { channel: 'mac' };
const RESULT = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } };
const say = (text: string) => ({ emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } } });
const SAVE = (name?: string) => ({ mcp: { server: 'cc_draft', tool: 'draft_save', args: name ? { name } : {} } });

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let h: ReturnType<typeof buildHandlers>;
let scenario: unknown = { steps: [] };
const runs: { trace: string; stdin: string; mcp: string }[] = [];
const events: EngineEvent[] = [];

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(20);
  }
}
const draft = (id: string): DraftView | undefined => engine.authors.list().find((d) => d.id === id);
const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
const sentTexts = (f: string): string[] => lines(f).map((l) => (JSON.parse(l) as { message?: { content?: unknown } }).message?.content).map((c) => (typeof c === 'string' ? c : JSON.stringify(c)));
const mcpBodies = (f: string): string[] => lines(f).map((l) => (JSON.parse(l) as { body: string }).body);
const pkg = (name: string) => {
  const f = builtinFiles('po');
  return Object.entries({ ...f, 'WORKFLOW.md': f['WORKFLOW.md']!.replace(/^name: .*$/m, `name: ${name}`) }).map(([path, text]) => ({ write: { path, text } }));
};

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-author-it-')));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  mkdirSync(join(tmp, 'user', '.Trash'), { recursive: true });
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  db.close();
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: join(tmp, 'user') }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => {
      const n = runs.length + 1;
      const f = join(tmp, `scn-${n}.json`);
      writeFileSync(f, JSON.stringify(scenario));
      const r = { trace: join(tmp, `trace-${n}.json`), stdin: join(tmp, `stdin-${n}.log`), mcp: join(tmp, `mcp-${n}.log`) };
      runs.push(r);
      return { FAKE_CLAUDE_SCENARIO: f, FAKE_CLAUDE_TRACE: r.trace, FAKE_CLAUDE_STDIN_LOG: r.stdin, FAKE_CLAUDE_MCP_LOG: r.mcp };
    },
    quotaSource: { fetchUsage: () => Promise.reject(new Error('no network in tests')) },
    caffeinateSpawner: () => ({ kill() {} }), ps: async () => [], kill: () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 10_000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0, workflowPollMs: 0,
    log: () => {}, hasLogin: () => true,
  });
  const hub = engine.hub as unknown as { broadcast: (e: EngineEvent) => void };
  const orig = hub.broadcast.bind(hub);
  hub.broadcast = (e) => { events.push(e); orig(e); };
  h = buildHandlers(engine, {} as Conn);
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(engine.db, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
});

afterAll(async () => {
  await engine?.stop();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('v2.9 G6 author by prompt (fake-claude)', () => {
  test('new pack: whitelist argv; a valid draft with no error; writes outside pack/ never read; draft_save after the user line saves; Hoàn tác trashes it', async () => {
    const outside = join(tmp, 'outside.md');
    scenario = { steps: [
      { waitUser: true }, ...pkg('PO + Plan'),
      { write: { path: '../stray.md', text: 'x' } }, { write: { path: outside, text: 'x' } }, { write: { path: '../examples/po/WORKFLOW.md', text: 'hỏng' } },
      say('Đã tạo "PO + Plan".'), RESULT,
      { waitUser: 'lưu đi' }, SAVE(), say('Đã lưu.'), RESULT,
    ] };
    const v = await h.workflow_draft_start({ cmd: 'workflow_draft_start', fromId: null, text: 'Giống PO nhưng tên khác' }, MAC) as DraftView;
    const run = runs.at(-1)!;
    await until(() => draft(v.id)?.state === 'idle' && Object.keys(draft(v.id)!.files).length === 5, 'draft written');
    const argv = (JSON.parse(readFileSync(run.trace, 'utf8')) as { argv: string[]; cwd: string }).argv;
    const dir = join(tmp, 'home', 'workflow-drafts', v.id);
    expect(argv.slice(argv.indexOf('--restricted'), argv.indexOf('--restricted') + 3)).toEqual(['--restricted', '--tools', 'Read,Write,Edit,Glob,Grep']);
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(join(dir, 'examples'));
    expect((JSON.parse(readFileSync(run.trace, 'utf8')) as { cwd: string }).cwd).toBe(join(dir, 'pack'));
    const d = draft(v.id)!;
    expect(d.errors).toEqual([]);
    expect(Object.keys(d.files).sort()).toEqual(Object.keys(builtinFiles('po')).sort());
    expect(d.changed.added).toContain('WORKFLOW.md');
    expect(d.lines.map((l) => l.kind)).toEqual(['user', 'claude']); // the activity lines went with the turn
    expect(events.some((e) => e.type === 'workflow_draft' && e.draft.lines.some((l) => l.kind === 'activity'))).toBe(true);

    await h.workflow_draft_say({ cmd: 'workflow_draft_say', draftId: v.id, text: 'lưu đi' }, MAC);
    await until(() => draft(v.id)?.state === 'saved', 'saved by voice');
    await until(() => mcpBodies(run.mcp).join('\n').includes('Đã lưu'), 'mcp log'); // the fake logs after it reads the reply
    const row = engine.workflows.list().find((r) => r.name === 'PO + Plan')!;
    expect(row).toBeDefined();
    expect(draft(v.id)!.saved).toMatchObject({ id: row.id, name: 'PO + Plan', applied: null });
    expect(existsSync(join(tmp, 'home', 'workflows', row.id, 'stray.md'))).toBe(false);

    h.workflow_draft_undo({ cmd: 'workflow_draft_undo', draftId: v.id }, MAC);
    expect(engine.workflows.list().some((r) => r.id === row.id)).toBe(false);
    expect(draft(v.id)!.state).toBe('idle');
    await h.workflow_draft_discard({ cmd: 'workflow_draft_discard', draftId: v.id }, MAC);
    expect(existsSync(dir)).toBe(false);
    expect(events.some((e) => e.type === 'workflow_draft_gone' && e.draftId === v.id)).toBe(true);
  });

  test('broken draft: one Kiểm gói per turn, stop after 3; draft_save refused after the engine line; a stray file in pack/ is V11', async () => {
    scenario = { steps: [
      { waitUser: true }, { write: { path: 'WORKFLOW.md', text: '---\nname: Hỏng\nfoo: 1\n---\n' } }, { write: { path: 'notes.txt', text: 'x' } }, RESULT,
      { waitUser: 'Kiểm gói' }, SAVE('Hỏng'), RESULT,
      { waitUser: 'Kiểm gói' }, RESULT,
      { waitUser: 'Kiểm gói' }, RESULT,
      { sleep: 600 }, say('xong'),
    ] };
    const v = await h.workflow_draft_start({ cmd: 'workflow_draft_start', fromId: null, text: 'tạo gói' }, MAC) as DraftView;
    const run = runs.at(-1)!;
    await until(() => draft(v.id)?.lines.some((l) => l.key === 'workflow.author.fixStopped') ?? false, 'auto-fix stopped');
    expect(sentTexts(run.stdin).filter((t) => t.startsWith('[cc-slaves] Kiểm gói:'))).toHaveLength(3);
    expect(draft(v.id)!.errors.some((e) => e.code === 'V11' && e.file === 'notes.txt')).toBe(true);
    expect(mcpBodies(run.mcp).join('\n')).toContain('Chưa lưu: chỉ lưu khi tin gần nhất của người dùng');
    expect(engine.workflows.list().some((r) => r.name === 'Hỏng')).toBe(false);
    const r = h.workflow_draft_save({ cmd: 'workflow_draft_save', draftId: v.id }, MAC) as WorkflowSaveResult;
    expect(r.saved).toBe(false);
    await h.workflow_draft_discard({ cmd: 'workflow_draft_discard', draftId: v.id }, MAC);
  });

  test('a library pack: hand edit rides with the next message; Lưu over a stale base rev → workflow_conflict; Hoàn tác restores the files', async () => {
    const row = h.workflow_create({ cmd: 'workflow_create', from: 'builtin:po', name: 'Đội B' }, MAC) as WorkflowRow;
    scenario = { steps: [{ waitUser: true }, say('Chưa đổi gì.'), RESULT, { waitUser: 'thêm' }, say('ok'), RESULT] };
    const v = await h.workflow_draft_start({ cmd: 'workflow_draft_start', fromId: row.id, text: 'xem thử' }, MAC) as DraftView;
    const run = runs.at(-1)!;
    await until(() => draft(v.id)?.state === 'idle', 'first turn');
    expect(() => h.workflow_draft_start({ cmd: 'workflow_draft_start', fromId: 'builtin:po', text: 'x' }, MAC)).toThrow();
    h.workflow_draft_patch({ cmd: 'workflow_draft_patch', draftId: v.id, edits: [{ path: 'WORKFLOW.md', key: 'description', value: 'Mô tả mới' }] }, MAC);
    expect(draft(v.id)!.changed.changed).toEqual(['WORKFLOW.md']);
    await h.workflow_draft_say({ cmd: 'workflow_draft_say', draftId: v.id, text: 'thêm bước' }, MAC);
    await until(() => sentTexts(run.stdin).some((t) => t.includes('Người dùng đã sửa tay: WORKFLOW.md:description')), 'hand edit note');
    await until(() => draft(v.id)?.state === 'idle', 'second turn');

    const det = h.workflow_get({ cmd: 'workflow_get', id: row.id }, MAC) as WorkflowDetail;
    const before = det.files;
    // the pack changes on disk meanwhile (VS Code) → the draft's base rev is stale
    const other = h.workflow_save({ cmd: 'workflow_save', id: row.id, files: { ...before, 'steps/design.md': `${before['steps/design.md']}\nngoài.\n` }, baseRev: det.rev }, MAC) as WorkflowSaveResult;
    expect(other.saved).toBe(true);
    expect(() => h.workflow_draft_save({ cmd: 'workflow_draft_save', draftId: v.id }, MAC)).toThrow('vừa đổi ngoài app');
    const r = await route(h, MAC, { type: 'command', id: 'c', command: { cmd: 'workflow_draft_save', draftId: v.id } });
    expect(r).toMatchObject({ type: 'error', code: 'workflow_conflict' });
    await h.workflow_draft_discard({ cmd: 'workflow_draft_discard', draftId: v.id }, MAC);

    // a fresh draft of the new disk files: Lưu, then Hoàn tác writes the previous files back
    scenario = { steps: [{ waitUser: true }, RESULT] };
    const v2 = await h.workflow_draft_start({ cmd: 'workflow_draft_start', fromId: row.id, text: 'đổi mô tả' }, MAC) as DraftView;
    await until(() => draft(v2.id)?.state === 'idle', 'turn');
    h.workflow_draft_patch({ cmd: 'workflow_draft_patch', draftId: v2.id, edits: [{ path: 'WORKFLOW.md', key: 'description', value: 'Bản mới' }] }, MAC);
    const prev = (h.workflow_get({ cmd: 'workflow_get', id: row.id }, MAC) as WorkflowDetail).files;
    expect((h.workflow_draft_save({ cmd: 'workflow_draft_save', draftId: v2.id }, MAC) as WorkflowSaveResult).saved).toBe(true);
    expect((h.workflow_get({ cmd: 'workflow_get', id: row.id }, MAC) as WorkflowDetail).files['WORKFLOW.md']).toContain('Bản mới');
    h.workflow_draft_undo({ cmd: 'workflow_draft_undo', draftId: v2.id }, MAC);
    expect((h.workflow_get({ cmd: 'workflow_get', id: row.id }, MAC) as WorkflowDetail).files).toEqual(prev);
    await h.workflow_draft_discard({ cmd: 'workflow_draft_discard', draftId: v2.id }, MAC);
  });

  for (const [text, saves] of [['chưa lưu nhé, thêm bước Plan', false], ['đừng lưu', false], ['ok lưu lại đi', true]] as const) {
    test(`§5.9 draft_save right after the user's line "${text}" → ${saves ? 'saved' : 'refused'} (the line must ask to save)`, async () => {
      const name = `Ý lưu ${text}`;
      scenario = { steps: [{ waitUser: true }, ...pkg(name), RESULT, { waitUser: true }, SAVE(name), RESULT] };
      const v = await h.workflow_draft_start({ cmd: 'workflow_draft_start', fromId: null, text: 'tạo gói' }, MAC) as DraftView;
      const run = runs.at(-1)!;
      await until(() => draft(v.id)?.state === 'idle' && Object.keys(draft(v.id)!.files).length === 5, 'draft written');
      await h.workflow_draft_say({ cmd: 'workflow_draft_say', draftId: v.id, text }, MAC);
      await until(() => mcpBodies(run.mcp).length === 1, 'draft_save answered');
      expect(mcpBodies(run.mcp)[0]).toContain(saves ? 'Đã lưu' : 'Chưa lưu: chỉ lưu khi tin gần nhất của người dùng');
      expect(engine.workflows.list().some((r) => r.name === name)).toBe(saves);
      if (saves) await until(() => draft(v.id)?.state === 'saved', 'saved by voice');
      else await h.workflow_draft_discard({ cmd: 'workflow_draft_discard', draftId: v.id }, MAC);
    });
  }

  for (const order of ['in order', 'reverse'] as const) {
    test(`§12 an engine line + the user line merged into one turn, replayed ${order}: draft_save only when the user's is replayed last`, async () => {
      const name = `Gộp ${order}`;
      scenario = { replay: 'manual', steps: [
        { waitUser: true }, { flushReplay: true }, ...pkg(name), RESULT,
        { waitUser: true }, { waitUser: true }, { flushReplay: order === 'reverse' ? 'reverse' : true }, SAVE(name), RESULT,
      ] };
      const v = await h.workflow_draft_start({ cmd: 'workflow_draft_start', fromId: null, text: 'tạo gói' }, MAC) as DraftView;
      const run = runs.at(-1)!;
      await until(() => draft(v.id)?.state === 'idle' && Object.keys(draft(v.id)!.files).length === 5, 'draft written');
      h.workflow_draft_patch({ cmd: 'workflow_draft_patch', draftId: v.id, edits: [{ path: 'WORKFLOW.md', key: 'description', value: 'Sửa tay' }] }, MAC);
      await h.workflow_draft_say({ cmd: 'workflow_draft_say', draftId: v.id, text: 'lưu nhé' }, MAC);
      await until(() => mcpBodies(run.mcp).length === 1, 'draft_save answered');
      const sent = sentTexts(run.stdin);
      expect(sent.slice(-2).map((t) => t.startsWith('[cc-slaves] Người dùng đã sửa tay') || t === 'lưu nhé')).toEqual([true, true]);
      if (order === 'reverse') {
        expect(mcpBodies(run.mcp)[0]).toContain('Chưa lưu: chỉ lưu khi tin gần nhất của người dùng');
        expect(engine.workflows.list().some((r) => r.name === name)).toBe(false);
      } else {
        await until(() => draft(v.id)?.state === 'saved', 'saved by voice');
        expect(engine.workflows.list().some((r) => r.name === name)).toBe(true);
      }
      await h.workflow_draft_discard({ cmd: 'workflow_draft_discard', draftId: v.id }, MAC);
    });
  }

  test('v2.6 §5.4 (orchestrator ruling 1) an author session is gated like a lane: spawn deferred while held (not busy), busy mid-turn, writes held until the release', async () => {
    const app = { send: () => {} } as unknown as Conn;
    scenario = { steps: [{ waitUser: true }, ...pkg('Gate'), say('a'), { sleep: 800 }, RESULT, { waitUser: true }, say('b'), RESULT, { waitUser: true }] };
    const before = runs.length;
    engine.update.on(app);
    const v = await h.workflow_draft_start({ cmd: 'workflow_draft_start', fromId: null, text: 'gói mới khi đang giữ' }, MAC) as DraftView;
    await Bun.sleep(300);
    expect(runs.length).toBe(before); // §5.4-3 no spawn while held
    expect(engine.update.view()).toMatchObject({ busy: [], held: 1 }); // R11 a deferred spawn is not busy
    engine.update.off(app);
    await until(() => runs.length === before + 1 && existsSync(runs.at(-1)!.stdin) && readFileSync(runs.at(-1)!.stdin, 'utf8').includes('gói mới khi đang giữ'), 'spawned + written after the release');
    engine.update.on(app);
    await until(() => engine.update.view().busy.length === 1, 'author turn busy');
    expect(engine.update.view().busy).toEqual([{ projectId: '_workflow', kind: 'workflow', name: v.id, turnStartedAt: expect.any(Number) as number }]);
    await until(() => draft(v.id)?.state === 'idle', 'turn over');
    expect(engine.update.view().busy).toEqual([]);
    await h.workflow_draft_say({ cmd: 'workflow_draft_say', draftId: v.id, text: 'tin thứ hai' }, MAC);
    await Bun.sleep(300);
    expect(sentTexts(runs.at(-1)!.stdin).join('\n')).not.toContain('tin thứ hai'); // §5.4-1 held off stdin
    engine.update.off(app);
    await until(() => sentTexts(runs.at(-1)!.stdin).join('\n').includes('tin thứ hai'), 'written once released');
    expect(runs.length).toBe(before + 1);
    await until(() => draft(v.id)?.state === 'idle', 'second turn over');
    await h.workflow_draft_discard({ cmd: 'workflow_draft_discard', draftId: v.id }, MAC);
  });

  test('IMPORTANT-1 a draft discarded during the hold spawns nothing at the release', async () => {
    const app = { send: () => {} } as unknown as Conn;
    scenario = { steps: [{ waitUser: true }, RESULT, { waitUser: true }] };
    const before = runs.length;
    engine.update.on(app);
    const v = await h.workflow_draft_start({ cmd: 'workflow_draft_start', fromId: null, text: 'bỏ khi đang giữ' }, MAC) as DraftView;
    await h.workflow_draft_discard({ cmd: 'workflow_draft_discard', draftId: v.id }, MAC);
    engine.update.off(app);
    await Bun.sleep(500);
    expect(runs.length).toBe(before);
    expect(draft(v.id)).toBeUndefined();
  });

  test('every workflow_draft_* command is refused on the remote channel', async () => {
    const r = await route(h, { channel: 'remote' }, { type: 'command', id: 'x', command: { cmd: 'workflow_draft_start', fromId: null, text: 'x' } });
    expect(r).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  });
});
