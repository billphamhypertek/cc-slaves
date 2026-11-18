// v2.9 §6.1 / §10.1 over the real Engine with fake-claude (temp homes, no network, no real quota): the library boots under
// the engine home; workflow_create → project_set_workflow → a new Thiết kế session runs that pack's appendix; a saved new
// rev reaches the next session while the first stays pinned; a hand-broken file leaves the project on the last valid rev.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WorkflowDetail, WorkflowEditResult, WorkflowRow, WorkflowSaveResult } from '../../shared/workflows.ts';
import { insertProject, openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { snapshot } from '../src/engine/views.ts';
import { buildHandlers } from '../src/server/commands.ts';
import { route, type CommandCtx } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { projectWorkflow, sessionStep, sessionWf, workflowOf } from '../src/workflow/runtime.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(60_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const MAC: CommandCtx = { channel: 'mac' };
const RESULT = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, permission_denials: [] } };
const LOOP = { steps: Array.from({ length: 4 }, () => [{ waitUser: true }, RESULT]).flat() };

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let h: ReturnType<typeof buildHandlers>;
const traces: string[] = [];
const appendixOf = (sid: string): string => {
  const a = traces.filter((f) => existsSync(f)).map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { argv: string[] }).argv).find((x) => x.includes(sid))!;
  return a[a.indexOf('--append-system-prompt') + 1]!;
};
async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(20);
  }
}
const openDesign = async (): Promise<string> => {
  const { sessionId } = await h.spec_new({ cmd: 'spec_new', projectId: 'p1' }, MAC) as { sessionId: string };
  await until(() => traces.some((f) => existsSync(f) && readFileSync(f, 'utf8').includes(sessionId)), 'design session spawned');
  return sessionId;
};

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-wf-it-')));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  writeFileSync(join(tmp, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-marketplace': true } }));
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  mkdirSync(join(tmp, 'p1', 'docs', 'specs'), { recursive: true });
  insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1'), orchestratorAccount: O });
  db.close();
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: join(tmp, 'user') }, claudePath: null, shellFailed: false, reason: null },
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
    exec: async () => ({ code: 1, stdout: '', stderr: 'fake exec' }),
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    notify: { osascript: () => {}, postGchat: async () => {} },
    session: { initTimeoutMs: 10_000, interruptTimeoutMs: 300 }, closeGraceMs: 300, accountsEveryMs: 0, quotaEveryMs: 0, workflowPollMs: 0,
    log: () => {}, hasLogin: () => true,
  });
  h = buildHandlers(engine, {} as Conn);
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(engine.db, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
});

afterAll(async () => {
  await engine?.stop();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('v2.9 G3 the workflow library in the engine (fake-claude)', () => {
  test('boot copies the built-ins under the engine home; the library commands are refused on the remote channel', async () => {
    expect(existsSync(join(tmp, 'home', 'workflow-revs', workflowOf('builtin:po').rev, 'WORKFLOW.md'))).toBe(true);
    expect(engine.workflows.list().map((r) => r.id)).toEqual(['builtin:po', 'builtin:spec-plan', 'builtin:direct']);
    const r = await route(h, { channel: 'remote' }, { type: 'command', id: 'x', command: { cmd: 'workflow_delete', id: 'builtin:po' } });
    expect(r).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  });

  test('create → apply → a new design session runs the pack; a saved rev reaches the next session, the first stays pinned; a broken file keeps the last valid rev', async () => {
    const row = h.workflow_create({ cmd: 'workflow_create', from: 'builtin:po', name: 'Đội A' }, MAC) as WorkflowRow;
    expect(existsSync(join(tmp, 'home', 'workflows', 'doi-a', 'WORKFLOW.md'))).toBe(true);
    h.project_set_workflow({ cmd: 'project_set_workflow', projectId: 'p1', id: row.id }, MAC);
    expect(projectWorkflow(engine.db, 'p1').rev).toBe(row.rev!);
    const d = h.workflow_get({ cmd: 'workflow_get', id: row.id }, MAC) as WorkflowDetail;
    const files = { ...d.files, 'steps/design.md': `${d.files['steps/design.md']!.trimEnd()}\nDấu-một.\n` };
    const s1 = h.workflow_save({ cmd: 'workflow_save', id: row.id, files, baseRev: d.rev }, MAC) as WorkflowSaveResult;
    expect(s1.saved).toBe(true);
    const sid1 = await openDesign();
    expect(appendixOf(sid1)).toContain('Dấu-một.');
    expect(sessionStep(engine.db, sid1).workflow.rev).toBe(s1.row!.rev!);

    const files2 = { ...files, 'steps/design.md': files['steps/design.md'].replace('Dấu-một.', 'Dấu-hai.') };
    const s2 = h.workflow_save({ cmd: 'workflow_save', id: row.id, files: files2, baseRev: s1.row!.diskRev }, MAC) as WorkflowSaveResult;
    const sid2 = await openDesign();
    expect(appendixOf(sid2)).toContain('Dấu-hai.');
    expect(sessionStep(engine.db, sid1).workflow.rev).toBe(s1.row!.rev!); // R6 / A2 pinned
    expect(existsSync(join(tmp, 'home', 'workflow-revs', s1.row!.rev!))).toBe(true);

    const lane = join(tmp, 'home', 'workflows', 'doi-a', 'steps', 'lane.md');
    writeFileSync(lane, '---\ntype: lane\nphases: [queue]\n---\nx\n');
    utimesSync(lane, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(engine.workflows.scan()).toBe(true);
    const broken = engine.workflows.list().find((r) => r.id === row.id)!;
    expect(broken.errors.length).toBeGreaterThan(0);
    expect([broken.rev, projectWorkflow(engine.db, 'p1').rev]).toEqual([s2.row!.rev!, s2.row!.rev!]);
    expect(() => h.workflow_delete({ cmd: 'workflow_delete', id: row.id }, MAC)).toThrow('đang dùng ở P1');

    // v2.9 G5 the wire the Tasks chip / effective config read: Mac snapshot rows, project workflow, session WfRef
    const mac = snapshot(engine, 'mac');
    expect(mac.workflows?.map((r) => r.id)).toEqual(['builtin:po', 'builtin:spec-plan', 'builtin:direct', row.id]);
    expect(mac.projects.find((p) => p.id === 'p1')?.workflow).toBe(row.id);
    const o1 = mac.orchestrators.find((o) => o.sessionId === sid1)!;
    expect(o1.wf).toEqual(sessionWf(engine.db, sid1)!);
    expect(o1.wf).toMatchObject({ rev: s1.row!.rev!, name: 'Đội A', step: 'design' });
    expect(snapshot(engine, 'remote').workflows).toBeUndefined();
  });
  test('§5.4 the production engine checks `require_plugins` against the installed plugins (a missing one warns)', () => {
    const d = h.workflow_get({ cmd: 'workflow_get', id: 'builtin:po' }, MAC) as WorkflowDetail;
    const files = { ...d.files, 'WORKFLOW.md': d.files['WORKFLOW.md']!.replace('require_plugins: [superpowers]', 'require_plugins: [superpowers, nope-plugin]') };
    const r = h.workflow_edit({ cmd: 'workflow_edit', files, edits: [] }, MAC) as WorkflowEditResult;
    expect(r.warnings.map((w) => w.msg)).toContain('Plugin `nope-plugin` chưa cài: lane sẽ bị chặn tới khi cài');
  });
  test('v2.9 G5 project_set_workflow pushes the project (the Tasks chip follows without a reload), no Chung restart', async () => {
    const sent: { type: string; workflow?: string }[] = [];
    const keep = engine.broadcast;
    engine.broadcast = (ev) => { sent.push({ type: ev.type, workflow: ev.type === 'project' ? ev.project.workflow : undefined }); keep.call(engine, ev); };
    try {
      h.project_set_workflow({ cmd: 'project_set_workflow', projectId: 'p1', id: 'builtin:direct' }, MAC);
    } finally { engine.broadcast = keep; }
    expect(sent).toContainEqual({ type: 'project', workflow: 'builtin:direct' });
  });

  test('v29-fz §6.1 Áp dụng re-pins the live Chung at once: its next lane_start runs the new rev, a running lane keeps its rev, the Deck labels Chung with the new pack', async () => {
    const chung = await engine.orchestrators.start('p1', undefined, true); // a paused Chung: the row, no process
    const sid = chung.view().sessionId;
    const rev = (q: string, a: string) => engine.db.query<{ r: string }, [string]>(`SELECT workflow_rev AS r FROM ${q} WHERE ${a} = ?`);
    const old = rev('session', 'id').get(sid)!.r;
    const to = old === workflowOf('builtin:spec-plan').rev ? 'builtin:direct' : 'builtin:spec-plan';
    const lane = async (name: string) => {
      const cwd = join(tmp, `wt-${name}`);
      mkdirSync(cwd, { recursive: true });
      await engine.lanes.start({ projectId: 'p1', name, cwd, briefPath: `/briefs/${name}.md`, ownerSession: sid });
      return engine.db.query<{ r: string }, [string]>("SELECT workflow_rev AS r FROM lane WHERE project_id = 'p1' AND name = ?").get(name)!.r;
    };
    expect(await lane('FZ1')).toBe(old);
    h.project_set_workflow({ cmd: 'project_set_workflow', projectId: 'p1', id: to }, MAC);
    const now = workflowOf(to).rev;
    expect(rev('session', 'id').get(sid)!.r).toBe(now);
    expect(await lane('FZ2')).toBe(now);
    expect(engine.db.query<{ r: string }, []>("SELECT workflow_rev AS r FROM lane WHERE project_id = 'p1' AND name = 'FZ1'").get()!.r).toBe(old);
    expect(snapshot(engine, 'mac').orchestrators.find((o) => o.sessionId === sid)!.wf).toMatchObject({ rev: now, name: workflowOf(to).name, step: 'general' });
  });
});
