// v2.7 §10.1 / R-B12 WS commands of the Tasks tab (accept + refuse each), the coalesced issue_changed / spec_changed push,
// the §5.2-7 scan wiring (imports, moves, IS16 once) and the snapshot view. A fake engine over a real state.db + temp
// dirs (CLAUDE_HOME temp: superpowers settings, prior sessions); no claude process, no network beyond localhost.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PriorSession, SpecOutput } from '../../../shared/issues.ts';
import type { AccountView, EngineEvent } from '../../../shared/protocol.ts';
import type { Caps } from '../../src/config.ts';
import type { QuotaRow } from '../../src/db.ts';
import { accountView } from '../../src/server/views.ts';
import { CardStore } from '../../src/cards/store.ts';
import { insertLane, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import type { Engine } from '../../src/engine.ts';
import { IssuesArea } from '../../src/engine/issues.ts';
import { IssueEvents } from '../../src/issues/events.ts';
import { addDep, addFile, createIssue, getIssue, getSpec, getSpecByPath, insertSpec, moveSpec, takeIssue, updateSpec } from '../../src/issues/store.ts';
import { encodeCwd } from '../../src/orchestrator/resume.ts';
import type { KindInput } from '../../src/orchestrator/session/types.ts';
import { issueHandlers } from '../../src/server/issue-commands.ts';
import { kickoffText } from '../../src/workflow/compile.ts';
import { stepOf, workflowOf } from '../../src/workflow/runtime.ts';
import { kickoff } from '../_fixtures/po-pack.ts';
import { execIn } from '../../src/setup/setup.ts';

const BIG = `${'x'.repeat(220)}\n`;
let tmp: string, root: string, claude: string;
let db: Db;
let saved: string | undefined;
let events: EngineEvent[];
let opened: KindInput[];
let sent: { sid: string; text: string }[];
let live: Set<string>;
let macCount: number;
let ps: string[];
let auto: string | null; // v2.7.1 §7.4 what "Tự chọn" finds (`Orchestrators.autoAccount`)
let views: AccountView[];
let e: Engine;
let h: ReturnType<typeof issueHandlers>;

const spec = (path: string, body: string) => { mkdirSync(join(root, 'docs/specs/done'), { recursive: true }); writeFileSync(join(root, path), body + BIG); };
const tick = () => Bun.sleep(5);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-icmd-')));
  root = join(tmp, 'repo');
  claude = join(tmp, 'claude');
  mkdirSync(root, { recursive: true });
  mkdirSync(claude, { recursive: true });
  saved = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = claude;
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@sp': true } }));
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'Shop', path: root });
  events = []; opened = []; sent = []; live = new Set(); macCount = 1; ps = []; auto = 'o@x'; views = [];
  const fake = {
    db, stopped: false, accounts: [], gitExec: execIn(process.env), cards: new CardStore({ db, sessions: { writeControl: () => true, askOpen: () => {}, askClose: () => {}, deliver: () => {} } }), o: { ps: async () => ps.map((command, pid) => ({ pid, command })) },
    config: { skills: { offForLanes: [] }, plugins: { offForLanes: [] } },
    projectRow: (id: string) => db.query<{ id: string; name: string; path: string }, [string]>('SELECT id, name, path FROM project WHERE id = ?').get(id) ?? null,
    projectView: (id: string) => ({ id, specsImported: e.issues.importedNotice(id) }),
    hub: { get macCount() { return macCount; } },
    broadcast: (ev: EngineEvent) => { events.push(ev); },
    lanes: { get: (_p: string, name: string) => (name === 'D2' ? { state: 'waiting_po', phase: 'code' } : null) },
    code: { deps: () => ({ worktreeRoots: async () => [root] }) },
    held: { wake: async () => {} },
    orchestrators: {
      openKind: async (_p: string, i: KindInput) => {
        opened.push(i);
        const sid = i.resume?.sessionId ?? `s${opened.length}`;
        insertSession(db, { id: sid, projectId: 'p1', kind: 'orchestrator', account: null });
        live.add(sid);
        if (i.specId !== undefined && i.kind === 'build') updateSpec(db, i.specId, { buildSession: sid });
        return { currentSessionId: sid };
      },
      bySession: (sid: string) => (live.has(sid) ? {} : null),
      autoAccount: () => auto,
    },
    accountViews: () => views,
    issueEvents: new IssueEvents({ db, send: (sid, text) => sent.push({ sid, text }), running: () => true, hasRoom: () => true, timers: { set: () => 0, clear: () => {} } }),
  };
  e = fake as unknown as Engine;
  (fake as unknown as { issues: IssuesArea }).issues = new IssuesArea(e, async (_h, port) => port === 1);
  h = issueHandlers(e);
});
afterEach(() => {
  (e as { stopped: boolean }).stopped = true;
  db.close();
  if (saved === undefined) delete process.env.CLAUDE_HOME; else process.env.CLAUDE_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const MAC = { channel: 'mac' as const };
async function err(f: () => unknown): Promise<{ code: string; key?: string; message: string }> {
  try { await f(); } catch (x) { return x as { code: string; key?: string; message: string }; }
  throw new Error('expected a refusal');
}
const approved = (path = 'docs/specs/a.md', o: { origin?: 'app' | 'imported'; outsideBuild?: boolean } = {}) => {
  const s = insertSpec(db, { projectId: 'p1', path, title: 'A', origin: o.origin ?? 'app', ...(o.outsideBuild ? { state: 'approved', outsideBuild: true } : {}) });
  return o.outsideBuild ? s : moveSpec(db, s.id, 'approved');
};
const changed = (type: 'issue_changed' | 'spec_changed') => events.filter((x) => x.type === type);

describe('§5.6 issue_ok / issue_seen', () => {
  test('§5.6 issue_ok → po_ok + po_seen, the orchestrator is told, one issue_changed; unknown key → not_found', async () => {
    insertSession(db, { id: 'gen', projectId: 'p1', kind: 'orchestrator', account: null });
    const b = createIssue(db, { projectId: 'p1', kind: 'bug', specId: null, source: 'lane', title: 'log lỗi', createdBySession: 'gen' });
    expect(b.poSeen).toBe(false);
    await h.issue_ok({ cmd: 'issue_ok', projectId: 'p1', key: b.key }, MAC);
    expect(getIssue(db, b.id)).toMatchObject({ poOk: true, poSeen: true });
    expect(sent).toEqual([{ sid: 'gen', text: `[cc-slaves] PO cho làm ${b.key}: log lỗi (ghi nhận)` }]);
    await tick();
    expect(changed('issue_changed').map((x) => x.type === 'issue_changed' && x.issue.poOk)).toEqual([true]);
    expect(await err(() => h.issue_ok({ cmd: 'issue_ok', projectId: 'p1', key: 'B-99' }, MAC))).toMatchObject({ code: 'not_found', key: 'errors.noIssueKey' });
  });

  test('§5.6 issue_seen → po_seen only (not ok); unknown project → no_project', async () => {
    const b = createIssue(db, { projectId: 'p1', kind: 'bug', specId: null, source: 'orchestrator', title: 'x' });
    await h.issue_seen({ cmd: 'issue_seen', projectId: 'p1', key: b.key }, MAC);
    expect(getIssue(db, b.id)).toMatchObject({ poSeen: true, poOk: false });
    expect(await err(() => h.issue_seen({ cmd: 'issue_seen', projectId: 'nope', key: b.key }, MAC))).toMatchObject({ code: 'no_project' });
  });
});

describe('§4.3 review MINOR-2 issue_file (Mac only): an attachment as a data URL', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const kept = (key: string, name: string, bytes: Uint8Array | string) => {
    const dir = join(tmp, 'home', 'issues', 'p1', key);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `1-${name}`);
    writeFileSync(path, bytes);
    return path;
  };
  let savedHome: string | undefined;
  beforeEach(() => { savedHome = process.env.CC_SLAVES_HOME; process.env.CC_SLAVES_HOME = join(tmp, 'home'); });
  afterEach(() => { if (savedHome === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = savedHome; });

  test('§4.3 a kept image → { name, size, dataUrl }; a file of another issue / unknown id → not_found', async () => {
    const b = createIssue(db, { projectId: 'p1', kind: 'bug', specId: null, source: 'po', title: 'nút lỗi' });
    const other = createIssue(db, { projectId: 'p1', kind: 'bug', specId: null, source: 'po', title: 'khác' });
    const f = addFile(db, b.id, { name: 'loi.png', path: kept(b.key, 'loi.png', PNG), size: PNG.length });
    const r = await h.issue_file({ cmd: 'issue_file', projectId: 'p1', key: b.key, id: f.id }, MAC);
    expect(r).toEqual({ name: 'loi.png', size: PNG.length, dataUrl: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` });
    expect(await err(() => h.issue_file({ cmd: 'issue_file', projectId: 'p1', key: other.key, id: f.id }, MAC))).toMatchObject({ code: 'not_found', key: 'errors.issueFileGone' });
    expect(await err(() => h.issue_file({ cmd: 'issue_file', projectId: 'p1', key: b.key, id: 'x' as never }, MAC))).toMatchObject({ code: 'bad_input' });
  });

  test('§10.3 a row path outside <home>/issues/<project>/<key>/ (or a symlink out) → forbidden; a non-image or > 5 MB → refused', async () => {
    const b = createIssue(db, { projectId: 'p1', kind: 'bug', specId: null, source: 'po', title: 'x' });
    const secret = join(tmp, 'secret.png');
    writeFileSync(secret, PNG);
    const out = addFile(db, b.id, { name: 'secret.png', path: secret, size: PNG.length });
    expect(await err(() => h.issue_file({ cmd: 'issue_file', projectId: 'p1', key: b.key, id: out.id }, MAC))).toMatchObject({ code: 'forbidden' });
    const link = kept(b.key, 'link.png', '');
    rmSync(link);
    symlinkSync(secret, link);
    const sym = addFile(db, b.id, { name: 'link.png', path: link, size: PNG.length });
    expect(await err(() => h.issue_file({ cmd: 'issue_file', projectId: 'p1', key: b.key, id: sym.id }, MAC))).toMatchObject({ code: 'forbidden' });
    const txt = addFile(db, b.id, { name: 'a.txt', path: kept(b.key, 'a.txt', 'chữ'), size: 4 });
    expect(await err(() => h.issue_file({ cmd: 'issue_file', projectId: 'p1', key: b.key, id: txt.id }, MAC))).toMatchObject({ code: 'refused', key: 'errors.issueFileNotImage' });
    const big = addFile(db, b.id, { name: 'big.png', path: kept(b.key, 'big.png', new Uint8Array(5 * 1024 * 1024 + 1)), size: 5 * 1024 * 1024 + 1 });
    expect(await err(() => h.issue_file({ cmd: 'issue_file', projectId: 'p1', key: b.key, id: big.id }, MAC))).toMatchObject({ code: 'refused', key: 'errors.issueFileNotImage' });
    rmSync(kept(b.key, 'gone.png', PNG));
    const gone = addFile(db, b.id, { name: 'gone.png', path: join(tmp, 'home', 'issues', 'p1', b.key, '1-gone.png'), size: 1 });
    expect(await err(() => h.issue_file({ cmd: 'issue_file', projectId: 'p1', key: b.key, id: gone.id }, MAC))).toMatchObject({ code: 'not_found', key: 'errors.issueFileGone' });
  });
});

describe('§4.7 / §4.8 spec_new / spec_edit', () => {
  test('§7.3 spec_new with superpowers off → superpowers_off, no session; on → a Thiết kế session, ack = its id', async () => {
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@sp': false } }));
    expect(await err(() => h.spec_new({ cmd: 'spec_new', projectId: 'p1' }, MAC))).toMatchObject({ code: 'superpowers_off', key: 'errors.superpowersOff' });
    expect(opened).toEqual([]);
    const spOff = () => e.cards.list({ status: 'open' }).filter((c) => c.kind === 'superpowers_off' && c.projectId === 'p1');
    expect(spOff()).toHaveLength(1); // §7.3 IS11 the red card opens at the refusal point
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@sp': true } }));
    expect(await h.spec_new({ cmd: 'spec_new', projectId: 'p1' }, MAC)).toEqual({ sessionId: 's1' });
    expect(spOff()).toEqual([]); // the next passing check closes it
    expect(opened).toEqual([{ kind: 'design', firstMessage: kickoff('design', 'new', { project: 'Shop' }) }]);
  });

  test('§4.8 spec_edit: approved → a Thiết kế session bound to it; its edit session running → that one ("Tới phiên"); done → refused', async () => {
    const s = approved();
    expect(await h.spec_edit({ cmd: 'spec_edit', projectId: 'p1', path: s.path }, MAC)).toEqual({ sessionId: 's1' });
    expect(opened).toEqual([{ kind: 'design', specId: s.id, firstMessage: `Sửa spec ${s.path}: đọc spec, hỏi anh cần sửa gì.` }]);
    updateSpec(db, s.id, { editSession: 's1' });
    expect(await h.spec_edit({ cmd: 'spec_edit', projectId: 'p1', path: s.path }, MAC)).toEqual({ sessionId: 's1' });
    expect(opened.length).toBe(1);
    moveSpec(db, s.id, 'active'); moveSpec(db, s.id, 'done');
    expect((await err(() => h.spec_edit({ cmd: 'spec_edit', projectId: 'p1', path: s.path }, MAC))).message).toContain('đã xong');
    expect(await err(() => h.spec_edit({ cmd: 'spec_edit', projectId: 'p1', path: 'docs/specs/none.md' }, MAC))).toMatchObject({ key: 'errors.noSpecPath' });
  });
});

describe('v2.9 §5.3 lifecycle by the spec\'s pinned workflow (Spec + Plan)', () => {
  const SP = workflowOf('builtin:spec-plan');
  const plan = SP.steps.find((x) => x.id === 'plan')!;
  const spSpec = (step: string) => moveSpec(db, insertSpec(db, { projectId: 'p1', path: 'docs/specs/a.md', title: 'A', origin: 'app', workflowRev: SP.rev, step }).id, 'approved');

  test('v2.9 §5.3 Bắt đầu on a spec approved at Thiết kế opens a Plan session; the spec goes back to draft at plan', async () => {
    const s = spSpec('design');
    expect(await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path }, MAC)).toEqual({ sessionId: 's1' });
    expect(opened[0]).toEqual({ kind: 'design', specId: s.id, step: 'plan', firstMessage: kickoffText(plan, 'new', { project: 'Shop', path: s.path }) });
    expect(getSpec(db, s.id)).toMatchObject({ state: 'draft', step: 'plan' });
  });

  test('v2.9 §5.3 Bắt đầu on a spec approved at Plan opens Build; the spec is active at build', async () => {
    const s = spSpec('plan');
    await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path }, MAC);
    expect(opened[0]).toEqual({ kind: 'build', specId: s.id, firstMessage: kickoffText(stepOf(SP, 'build')!, 'new', { path: s.path }) });
    expect(getSpec(db, s.id)).toMatchObject({ state: 'active', step: 'build' });
  });

  test('v2.9 §5.3 Sửa opens the spec\'s own doc step (edit kickoff); Bổ sung on a built spec opens the first doc step (amend)', async () => {
    const s = spSpec('plan');
    await h.spec_edit({ cmd: 'spec_edit', projectId: 'p1', path: s.path }, MAC);
    expect(opened[0]!.firstMessage).toBe(kickoffText(plan, 'edit', { project: 'Shop', path: s.path }));
    moveSpec(db, s.id, 'active');
    live.clear();
    await h.spec_edit({ cmd: 'spec_edit', projectId: 'p1', path: s.path }, MAC);
    expect(opened[1]!.firstMessage).toBe(kickoffText(stepOf(SP, 'design')!, 'amend', { project: 'Shop', path: s.path }));
  });
});

describe('§5.2-3 / §5.2-10 spec_build', () => {
  test('§5.2-3 spec_build: draft → refused; approved → Build session with the §5.2-3 first message, spec active; after not done → refused', async () => {
    const d = insertSpec(db, { projectId: 'p1', path: 'docs/specs/d.md', title: 'D', origin: 'app' });
    expect((await err(() => h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: d.path }, MAC))).message).toContain('chưa duyệt');
    const s = approved();
    const later = updateSpec(db, approved('docs/specs/b.md').id, { afterId: s.id });
    expect((await err(() => h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: later.path }, MAC))).message).toContain(`chờ spec ${s.path}`);
    expect(await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path }, MAC)).toEqual({ sessionId: 's1' });
    expect(opened[0]).toEqual({ kind: 'build', specId: s.id, firstMessage: kickoff('build', 'new', { path: s.path }) });
    expect(opened[0]!.firstMessage).toStartWith(`Build spec ${s.path}. Tạo nhánh tích hợp + worktree, gọi spec_set_branch`);
    expect(getSpec(db, s.id)).toMatchObject({ state: 'active', buildSession: 's1', resumed: false });
  });

  test('§5.2-3 review-B IMPORTANT-1 a double "Bắt đầu build" / "Sửa spec" (two Mac windows) while the session boots: one session, the second refused in Vietnamese', async () => {
    const o = e.orchestrators as { openKind: (p: string, i: KindInput) => Promise<{ currentSessionId: string }> };
    const boot = o.openKind;
    o.openKind = async (p, i) => { await Bun.sleep(20); return boot(p, i); };
    const s = approved();
    const h2 = issueHandlers(e); // a second connection builds its own handler table
    const [a, b] = await Promise.allSettled([
      h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path }, MAC), h2.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path }, MAC),
    ]);
    expect(a).toEqual({ status: 'fulfilled', value: { sessionId: 's1' } });
    expect(b.status === 'rejected' && b.reason).toMatchObject({ code: 'refused', key: 'errors.specRefused' });
    expect((b as PromiseRejectedResult).reason.message).toContain(`đang mở phiên cho spec ${s.path}`);
    expect(opened).toHaveLength(1);
    expect(getSpec(db, s.id)).toMatchObject({ state: 'active', buildSession: 's1' });
    const t = approved('docs/specs/t.md');
    const [c, d] = await Promise.allSettled([
      h.spec_edit({ cmd: 'spec_edit', projectId: 'p1', path: t.path }, MAC), h2.spec_edit({ cmd: 'spec_edit', projectId: 'p1', path: t.path }, MAC),
    ]);
    expect(c.status).toBe('fulfilled');
    expect(d.status === 'rejected' && d.reason).toMatchObject({ code: 'refused', key: 'errors.specRefused' });
    expect(opened).toHaveLength(2);
    o.openKind = async () => { throw new Error('boot failed'); }; // a failed open frees the spec again
    const u = approved('docs/specs/u.md');
    expect((await err(() => h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: u.path }, MAC))).message).toBe('boot failed');
    o.openKind = boot;
    expect(await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: u.path }, MAC)).toEqual({ sessionId: 's3' });
  });

  test('§5.2-10 "Build mới" on an outside-build spec: the rebuild note, resumed=true; resume on a never-outside spec refused', async () => {
    const plain = approved();
    expect((await err(() => h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: plain.path, resume: 'x' }, MAC))).message).toContain('chưa build ngoài cc-slaves');
    const s = approved('docs/specs/o.md', { origin: 'imported', outsideBuild: true });
    await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path }, MAC);
    expect(opened[0]!.firstMessage).toContain('issue_create {state: done, source: prior}');
    expect(getSpec(db, s.id)).toMatchObject({ state: 'active', resumed: true });
  });

  const transcript = (id: string, o: { cwd: string; text: string; ageMs?: number; model?: string; effort?: string }) => {
    const dir = join(claude, 'projects', encodeCwd(root));
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${id}.jsonl`);
    const reply = o.model ? `${JSON.stringify({ type: 'assistant', cwd: o.cwd, effort: o.effort, message: { model: o.model, content: [{ type: 'text', text: 'ok' }] } })}\n` : '';
    writeFileSync(f, `${JSON.stringify({ type: 'user', cwd: o.cwd, message: { content: o.text } })}\n${reply}`);
    const t = (Date.now() - (o.ageMs ?? 600_000)) / 1000;
    utimesSync(f, t, t);
  };

  test('R-B6 spec_build {resume}: a listed candidate → claude --resume in its cwd; running elsewhere / owned id / cwd outside → refused', async () => {
    const s = approved('docs/specs/o.md', { origin: 'imported', outsideBuild: true });
    transcript('old-1', { cwd: root, text: 'build docs/specs/o.md đi' });
    transcript('busy-2', { cwd: root, text: 'o.md', ageMs: 10_000 });
    transcript('out-3', { cwd: tmp, text: 'o.md' });
    transcript('own-4', { cwd: root, text: 'o.md' });
    insertSession(db, { id: 'own-4', projectId: 'p1', kind: 'orchestrator', account: null });
    const list = await h.spec_prior_sessions({ cmd: 'spec_prior_sessions', projectId: 'p1', path: s.path }, MAC) as PriorSession[];
    expect(list.map((x) => [x.id, x.runningElsewhere]).sort()).toEqual([['busy-2', true], ['old-1', false], ['out-3', false]]);
    expect(await err(() => h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path, resume: 'busy-2' }, MAC))).toMatchObject({ code: 'session_live' });
    expect(await err(() => h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path, resume: 'own-4' }, MAC))).toMatchObject({ key: 'errors.priorGone' });
    expect(await err(() => h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path, resume: 'out-3' }, MAC))).toMatchObject({ key: 'errors.priorCwd' });
    expect(opened).toEqual([]);
    expect(await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path, resume: 'old-1' }, MAC)).toEqual({ sessionId: 'old-1' });
    expect(opened[0]).toEqual({ kind: 'build', specId: s.id, firstMessage: kickoff('build', 'resume', { path: s.path }), resume: { sessionId: 'old-1', cwd: root } });
    expect(getSpec(db, s.id)).toMatchObject({ state: 'active', resumed: true });
  });

  test('v2.7.1 SA6b spec_prior_sessions carries the old session\'s model / effort (null when the transcript has none)', async () => {
    const s = approved('docs/specs/o.md', { origin: 'imported', outsideBuild: true });
    transcript('old-1', { cwd: root, text: 'build docs/specs/o.md đi', model: 'claude-opus-5-5', effort: 'high' });
    transcript('old-2', { cwd: root, text: 'o.md', ageMs: 900_000 });
    const list = await h.spec_prior_sessions({ cmd: 'spec_prior_sessions', projectId: 'p1', path: s.path }, MAC) as PriorSession[];
    expect(list.map((x) => [x.id, x.model, x.effort])).toEqual([['old-1', 'claude-opus-5-5', 'high'], ['old-2', null, null]]);
  });

  test('R-B6 a claude process carrying the id = running elsewhere', async () => {
    const s = approved('docs/specs/o.md', { origin: 'imported', outsideBuild: true });
    transcript('old-1', { cwd: root, text: 'o.md' });
    ps = ['/usr/bin/claude --resume old-1'];
    expect((await h.spec_prior_sessions({ cmd: 'spec_prior_sessions', projectId: 'p1', path: s.path }, MAC) as PriorSession[])[0]).toMatchObject({ id: 'old-1', runningElsewhere: true });
  });
});

describe('§5.2-7 spec_mark / spec_scan / IS16', () => {
  test('§5.2-7 spec_mark: imported draft → approved (ack = the spec view); an app spec → refused', async () => {
    const imp = insertSpec(db, { projectId: 'p1', path: 'docs/specs/i.md', title: 'I', origin: 'imported' });
    spec(imp.path, '# I');
    expect(await h.spec_mark({ cmd: 'spec_mark', projectId: 'p1', path: imp.path, state: 'approved' }, MAC)).toMatchObject({ id: imp.id, state: 'approved', origin: 'imported', missing: false });
    const app = insertSpec(db, { projectId: 'p1', path: 'docs/specs/a.md', title: 'A', origin: 'app' });
    expect((await err(() => h.spec_mark({ cmd: 'spec_mark', projectId: 'p1', path: app.path, state: 'approved' }, MAC))).message).toContain('chỉ đổi tay spec nhập vào');
  });

  test('ruling 22:36 spec_mark on a spec pinned to a rev the engine does not hold still marks it (only a spawn fails closed)', async () => {
    const imp = insertSpec(db, { projectId: 'p1', path: 'docs/specs/i.md', title: 'I', origin: 'imported', workflowRev: 'b'.repeat(64) });
    spec(imp.path, '# I');
    expect(await h.spec_mark({ cmd: 'spec_mark', projectId: 'p1', path: imp.path, state: 'approved' }, MAC)).toMatchObject({ id: imp.id, state: 'approved' });
  });

  test('§5.2-7 / §4.9 IS16 spec_scan imports, follows a move to done/, shows "Đã nhập n" once; Ẩn hides it for good', async () => {
    spec('docs/specs/one.md', '# One\nTrạng thái: approved');
    spec('docs/specs/two.md', '# Two\nStatus: đang build');
    spec('docs/specs/old.md', '# Old\nTrạng thái: xong');
    expect(await h.spec_scan({ cmd: 'spec_scan', projectId: 'p1' }, MAC)).toEqual({ imported: 2, moved: 0 });
    expect(getSpecByPath(db, 'p1', 'docs/specs/two.md')).toMatchObject({ state: 'approved', outsideBuild: true, origin: 'imported', workflowRev: workflowOf('builtin:po').rev, step: 'design' });
    expect(e.issues.importedNotice('p1')).toBe(2);
    expect(events.filter((x) => x.type === 'project')).toEqual([{ type: 'project', project: { id: 'p1', specsImported: 2 } as never }]);
    rmSync(join(root, 'docs/specs/one.md'));
    spec('docs/specs/done/one.md', '# One');
    spec('docs/specs/three.md', '# Three');
    expect(await h.spec_scan({ cmd: 'spec_scan', projectId: 'p1' }, MAC)).toEqual({ imported: 1, moved: 1 });
    expect(getSpecByPath(db, 'p1', 'docs/specs/done/one.md')).not.toBeNull();
    expect(e.issues.importedNotice('p1')).toBe(2); // first import only
    await h.spec_import_hide({ cmd: 'spec_import_hide', projectId: 'p1' }, MAC);
    expect(e.issues.importedNotice('p1')).toBeNull();
    spec('docs/specs/four.md', '# Four');
    await h.spec_scan({ cmd: 'spec_scan', projectId: 'p1' }, MAC);
    expect(e.issues.importedNotice('p1')).toBeNull();
    await tick();
    expect(changed('spec_changed').length).toBeGreaterThan(0);
  });
});

describe('§4.10 spec_outputs', () => {
  test('§4.10 spec_outputs: the spec row first; a localhost link the probe finds closed → "off", open → "ok"', async () => {
    const s = approved();
    spec(s.path, '# A');
    db.query("INSERT INTO spec_output (spec_id, kind, ref, label, added_by, at) VALUES (?, 'link', 'http://localhost:1/x', null, 'session', 1), (?, 'link', 'http://localhost:2/y', null, 'session', 2)").run(s.id, s.id);
    const rows = await h.spec_outputs({ cmd: 'spec_outputs', projectId: 'p1', path: s.path }, MAC) as SpecOutput[];
    expect(rows.map((r) => [r.role, r.ref, r.state])).toEqual([['spec', s.path, 'ok'], ['link', 'http://localhost:1/x', 'ok'], ['link', 'http://localhost:2/y', 'off']]);
  });
  test('ruling 22:36 spec_outputs of a spec pinned to a rev the engine does not hold: the list, never workflow_missing', async () => {
    const s = approved();
    spec(s.path, '# A');
    db.query('UPDATE spec SET workflow_rev = ? WHERE id = ?').run('c'.repeat(64), s.id);
    const rows = await h.spec_outputs({ cmd: 'spec_outputs', projectId: 'p1', path: s.path }, MAC) as SpecOutput[];
    expect(rows.map((r) => [r.role, r.ref, r.display])).toEqual([['spec', s.path, 'a.md']]);
  });
});

describe('G3a snapshot view + coalesced push', () => {
  test('§4.3 the issue view: blockedBy / waitingOn / blocks, lane with its live state, commits; spec progress, missing file, groups', async () => {
    const s = moveSpec(db, approved().id, 'active');
    spec(s.path, '# A\n## Nhóm việc\n- **G0** đo\n- **G1** làm');
    const a = createIssue(db, { projectId: 'p1', kind: 'task', specId: s.id, source: 'spec', title: 'a' });
    const b = createIssue(db, { projectId: 'p1', kind: 'task', specId: s.id, source: 'spec', title: 'b' });
    const c = createIssue(db, { projectId: 'p1', kind: 'bug', specId: s.id, source: 'lane', title: 'c' });
    addDep(db, c.id, a.id); addDep(db, c.id, b.id);
    insertSession(db, { id: 'sl', projectId: 'p1', kind: 'lane', account: null });
    const lane = insertLane(db, { projectId: 'p1', name: 'D2', cwd: root, sessionId: 'sl' });
    takeIssue(db, a.id, lane.id, null);
    const v = e.issues.view('p1')!;
    const ia = v.issues.find((i) => i.key === a.key)!, ic = v.issues.find((i) => i.key === c.key)!;
    expect(ia).toMatchObject({ state: 'doing', lane: { name: 'D2', state: 'waiting_po', phase: 'code' }, blocks: [c.key], commits: [] });
    expect(ic).toMatchObject({ blockedBy: [a.key, b.key], waitingOn: [a.key, b.key], priority: true, poSeen: false });
    expect(ia.events.map((x) => x.type)).toEqual(['created', 'taken']);
    expect(v.specs[0]).toMatchObject({ state: 'active', missing: false, groups: null, progress: { done: 0, total: 3, scope: 1 } });
    const d = insertSpec(db, { projectId: 'p1', path: 'docs/specs/g.md', title: 'G', origin: 'app' });
    spec(d.path, '# G\n## Nhóm việc\n- **G0** đo\n- **G1** làm');
    expect(e.issues.view('p1')!.specs.find((x) => x.id === d.id)).toMatchObject({ groups: '2 nhóm · G0–G1' });
    rmSync(join(root, d.path));
    expect(e.issues.view('p1')!.specs.find((x) => x.id === d.id)).toMatchObject({ missing: true, groups: null });
  });

  test('G3a two changes in one tick → one push per changed item; an unchanged item is not pushed again', async () => {
    const a = createIssue(db, { projectId: 'p1', kind: 'task', specId: null, source: 'po', title: 'a' });
    createIssue(db, { projectId: 'p1', kind: 'task', specId: null, source: 'po', title: 'b' });
    e.issues.changed('p1'); e.issues.changed('p1');
    await tick();
    expect(changed('issue_changed').length).toBe(2);
    events = [];
    db.query("UPDATE issue SET title = 'a2' WHERE id = ?").run(a.id);
    e.issues.changed('p1'); e.issues.changed('p1');
    await tick();
    expect(changed('issue_changed').map((x) => x.type === 'issue_changed' && x.issue.title)).toEqual(['a2']);
  });

  test('G3a no Mac client → nothing pushed and nothing remembered: a change back after a new snapshot is still pushed', async () => {
    const a = createIssue(db, { projectId: 'p1', kind: 'task', specId: null, source: 'po', title: 'a' });
    e.issues.changed('p1'); await tick();
    events = []; macCount = 0;
    db.query("UPDATE issue SET title = 'b' WHERE id = ?").run(a.id);
    e.issues.changed('p1'); await tick();
    expect(events).toEqual([]);
    macCount = 1; // the new client got title b in its snapshot
    db.query("UPDATE issue SET title = 'a' WHERE id = ?").run(a.id);
    e.issues.changed('p1'); await tick();
    expect(changed('issue_changed').map((x) => x.type === 'issue_changed' && x.issue.title)).toEqual(['a']);
  });
});

describe('§5.7 / R-B12 issue_cancel_preview / issue_cancel', () => {
  test('R-B12 preview of a todo → IS4a; issue_cancel → cancelled, one issue_changed; R31 prior → refused with the reason', async () => {
    const t = createIssue(db, { projectId: 'p1', kind: 'task', specId: null, source: 'po', title: 'xuất PDF' });
    expect(await h.issue_cancel_preview({ cmd: 'issue_cancel_preview', projectId: 'p1', key: t.key }, MAC))
      .toEqual({ key: t.key, mode: 'cancel', lane: null, revert: null, dependants: { open: [], done: [] } });
    expect(await h.issue_cancel({ cmd: 'issue_cancel', projectId: 'p1', key: t.key, reason: '  bỏ  ' }, MAC)).toEqual({ key: t.key, mode: 'cancel', revertKey: null });
    expect(getIssue(db, t.id)).toMatchObject({ state: 'cancelled', cancelReason: 'bỏ' });
    await tick();
    expect(changed('issue_changed').filter((x) => x.type === 'issue_changed' && x.issue.key === t.key)).toHaveLength(1);
    const prior = createIssue(db, { projectId: 'p1', kind: 'task', specId: null, source: 'prior', title: 'cũ', state: 'done' });
    const r = await err(() => h.issue_cancel({ cmd: 'issue_cancel', projectId: 'p1', key: prior.key }, MAC));
    expect(r).toMatchObject({ code: 'refused', key: 'errors.cancelRefused' });
    expect(r.message).toContain('phần làm trước khi nhập');
    expect(await err(() => h.issue_cancel({ cmd: 'issue_cancel', projectId: 'p1', key: t.key, reason: 5 as never }, MAC))).toMatchObject({ code: 'bad_input' });
  });

  test('§5.6 the issues_new card follows the push: a lane issue opens it, issue_seen closes it', async () => {
    const b = createIssue(db, { projectId: 'p1', kind: 'bug', specId: null, source: 'lane', title: 'nút lỗi' });
    e.issues.changed('p1');
    await tick();
    const unseen = () => e.cards.list({ status: 'open' }).filter((c) => c.kind === 'issues_new');
    expect(unseen()).toHaveLength(1);
    await h.issue_seen({ cmd: 'issue_seen', projectId: 'p1', key: b.key }, MAC);
    await tick();
    expect(unseen()).toEqual([]);
  });
});

// v2.7.1 §7.4 the ▾ picks: validated, a hand-picked account checked, "Tự chọn" must find one; `session_pick` (read only).
describe('v2.7.1 §7.4 spec_* picks + session_pick', () => {
  const NOW = Math.floor(Date.now() / 1000);
  const CAPS = { default: { week: 90, five: 95 }, 'h@x': { week: 70, hard: true } } as Caps;
  const v = (email: string, o: Partial<QuotaRow> = {}, out = false): AccountView => accountView({
    account: { email, id: null, configDir: '/c', keychainService: 'k', planTier: 'default_claude_max_5x', terminal: false }, caps: CAPS, now: NOW, lanes: 0, loggedOut: out,
    quota: { account: email, fivePct: 8, weekPct: 40, fiveResetsAt: NOW + 3600, weekResetsAt: NOW + 86_400, source: 'api', fetchedAt: NOW - 60, status: 'ok', ...o },
  });

  test('picks go to openKind as given (account lower-cased); omitted → nothing added (today exactly)', async () => {
    views = [v('a@x')];
    await h.spec_new({ cmd: 'spec_new', projectId: 'p1', account: 'A@x', model: 'sonnet', effort: 'high' }, MAC);
    const s = approved();
    await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path, model: null }, MAC);
    expect(opened[0]).toEqual({ kind: 'design', firstMessage: kickoff('design', 'new', { project: 'Shop' }), account: 'a@x', model: 'sonnet', effort: 'high' });
    expect(opened[1]).toEqual({ kind: 'build', specId: s.id, firstMessage: kickoff('build', 'new', { path: s.path }), model: null });
  });

  test('bad picks → bad_input, no session; a full / signed-out / admit-band (L13) account → account_unusable with the §4.5 reason', async () => {
    views = [v('f@x', { weekPct: 95 }), v('out@x', {}, true), v('h@x', { weekPct: 68 })];
    expect(await err(() => h.spec_new({ cmd: 'spec_new', projectId: 'p1', account: '' }, MAC))).toMatchObject({ code: 'bad_input', key: 'errors.badAccount' });
    expect(await err(() => h.spec_new({ cmd: 'spec_new', projectId: 'p1', effort: '' }, MAC))).toMatchObject({ code: 'bad_input', key: 'errors.badModel' });
    expect(await err(() => h.spec_new({ cmd: 'spec_new', projectId: 'p1', account: 'f@x' }, MAC))).toMatchObject({ code: 'account_unusable', key: 'errors.startFullWeekSoft' });
    expect(await err(() => h.spec_new({ cmd: 'spec_new', projectId: 'p1', account: 'out@x' }, MAC))).toMatchObject({ code: 'account_unusable', key: 'errors.startAccountOut' });
    const s = approved();
    expect(await err(() => h.spec_edit({ cmd: 'spec_edit', projectId: 'p1', path: s.path, account: 'h@x' }, MAC))).toMatchObject({ code: 'account_unusable', key: 'errors.startAdmit' });
    expect(await err(() => h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path, account: 'zz@x' }, MAC))).toMatchObject({ code: 'account_unusable', key: 'errors.noAccount' });
    expect(opened).toEqual([]);
    expect(getSpec(db, s.id)!.state).toBe('approved'); // nothing moved
  });

  test('no account given and "Tự chọn" finds none → no_account + the earliest reopen; a hand-picked usable one still opens', async () => {
    auto = null;
    views = [v('f@x', { weekPct: 95, weekResetsAt: NOW + 7200 }), v('g@x', { fivePct: 99, fiveResetsAt: NOW + 600 })];
    expect(await err(() => h.spec_new({ cmd: 'spec_new', projectId: 'p1' }, MAC))).toMatchObject({ code: 'no_account', key: 'errors.noAccountEarliest' });
    const s = approved();
    expect(await err(() => h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path }, MAC))).toMatchObject({ code: 'no_account' });
    expect(opened).toEqual([]);
    views.push(v('ok@x'));
    expect(await h.spec_build({ cmd: 'spec_build', projectId: 'p1', path: s.path, account: 'ok@x' }, MAC)).toEqual({ sessionId: 's1' });
  });

  test('session_pick → the auto account + its headroom; none → earliest; bad kind / project refused', async () => {
    views = [v('o@x', { weekPct: 30 })];
    expect(await h.session_pick({ cmd: 'session_pick', projectId: 'p1', kind: 'design' }, MAC)).toEqual({ account: 'o@x', headroomPct: 60, earliest: null });
    auto = null;
    views = [v('o@x', { weekPct: 95, weekResetsAt: NOW + 7200 })];
    expect(await h.session_pick({ cmd: 'session_pick', projectId: 'p1', kind: 'build' }, MAC)).toEqual({ account: null, headroomPct: null, earliest: { email: 'o@x', at: (NOW + 7200) * 1000 } });
    expect(await err(() => h.session_pick({ cmd: 'session_pick', projectId: 'p1', kind: 'x' as 'build' }, MAC))).toMatchObject({ code: 'bad_input' });
    expect(await err(() => h.session_pick({ cmd: 'session_pick', projectId: 'nope', kind: 'build' }, MAC))).toMatchObject({ code: 'no_project' });
    expect(opened).toEqual([]);
  });
});
