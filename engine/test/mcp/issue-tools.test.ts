import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../src/cards/store.ts';
import { insertLane, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import {
  cancelIssue, createIssue, getIssue, getIssueByKey, insertSpec, listEvents, moveSpec, releaseIssue, takeIssue, updateSpec, type NewIssue,
} from '../../src/issues/store.ts';
import type { LaneView } from '../../src/lane/manager.ts';
import type { McpLanes, Role } from '../../src/mcp/tool-kit.ts';
import { callTool, findTool } from '../../src/mcp/tools.ts';
import { issuePorts } from '../_fixtures/issue-ports.ts';

let db: Db;
let tmp: string;
let ports: ReturnType<typeof issuePorts>;
let superpowers: boolean;
let messages: { name: string; text: string }[];
let started: string[];
let laneN: number;

const view = (name: string, laneId: number, cwd: string): LaneView => ({
  projectId: 'p1', name, laneId, sessionId: `s${name}`, cwd, state: 'starting', account: 'a@x', phase: null, failCount: 0, lastError: null,
  openCards: [], switchPending: false, sawAssistant: false, costUsd: null, alive: true, turnStartedAt: null, contextPct: null, waitReason: null,
  tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
});
const lanes: McpLanes = {
  list: () => [], interrupt: async () => {}, stop: async () => {}, resume: async () => {}, finish: async () => {}, setPhase: async () => {},
  result: () => null, tail: () => [], bySession: () => null,
  message: async (_p, name, text) => { messages.push({ name, text }); },
  start: async (o) => {
    started.push(o.name);
    insertSession(db, { id: `s${o.name}`, projectId: 'p1', kind: 'lane', account: null });
    const id = insertLane(db, { projectId: 'p1', name: o.name, cwd: o.cwd, sessionId: `s${o.name}`, ownerSession: o.ownerSession ?? null }).id;
    return view(o.name, id, o.cwd);
  },
};

const orch = (id: string, kind: 'design' | 'build' | 'general') => {
  insertSession(db, { id, projectId: 'p1', kind: 'orchestrator', account: null });
  db.query('UPDATE session SET orch_kind = ? WHERE id = ?').run(kind, id);
};
/** A lane row (its own cwd) holding nothing yet. */
const lane = (name: string, cwd = join(tmp, `wt-${++laneN}`)) => {
  mkdirSync(cwd, { recursive: true });
  insertSession(db, { id: `s${name}`, projectId: 'p1', kind: 'lane', account: null });
  return insertLane(db, { projectId: 'p1', name, cwd, sessionId: `s${name}`, ownerSession: 'bld' });
};
const call = async (sid: string, role: Role, tool: string, args: Record<string, unknown>) => {
  const deps = { lanes, cards: new CardStore({ db, sessions: { writeControl: () => true, askOpen: () => {}, askClose: () => {}, deliver: () => {} } }), usage: () => [], notify: () => {}, issues: ports };
  const r = await callTool(deps, { sessionId: sid, role, projectId: 'p1', cwd: '/w', graph: false }, findTool(tool)!, args);
  return { err: r.isError === true, text: r.content[0]!.text, json: () => JSON.parse(r.content[0]!.text) as Record<string, unknown> };
};
const issue = (o: Partial<NewIssue> = {}) => createIssue(db, { projectId: 'p1', kind: 'task', specId: null, source: 'spec', title: 'x', ...o });
const activeSpec = (path = 'docs/specs/v25.md') => {
  const s = insertSpec(db, { projectId: 'p1', path, title: 'v2.5', origin: 'app' });
  moveSpec(db, s.id, 'approved');
  moveSpec(db, s.id, 'active');
  return updateSpec(db, s.id, { buildSession: 'bld' });
};
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const repo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
};
const commit = (dir: string, msg: string) => git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-it-')));
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'one', path: join(tmp, 'root') });
  mkdirSync(join(tmp, 'root'));
  orch('des', 'design'); orch('bld', 'build'); orch('gen', 'general');
  superpowers = true; messages = []; started = []; laneN = 0;
  ports = issuePorts(db, { superpowers: () => superpowers });
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('§5.5-8 by session kind (gate before any tool)', () => {
  test('§5.5-8 Thiết kế: lanes_list / lane_start / issue_assign refused; issues_list + issue_create {spec: null} accepted', async () => {
    expect((await call('des', 'orchestrator', 'lanes_list', {})).text).toContain('phiên Thiết kế không gọi lanes_list');
    expect((await call('des', 'orchestrator', 'lane_start', { name: 'D1', cwd: tmp, brief_path: '/b.md' })).err).toBe(true);
    expect(started).toEqual([]);
    expect((await call('des', 'orchestrator', 'issues_list', {})).err).toBe(false);
    const r = await call('des', 'orchestrator', 'issue_create', { title: 'ý tưởng', spec: null });
    expect(r.json()).toMatchObject({ spec: null });
  });

  test('§5.5-8 Build: lane_* on a lane holding an outside-spec issue refused; Chung: on a spec issue refused', async () => {
    const s = activeSpec();
    const out = issue({ title: 'bug' });
    const inSpec = issue({ specId: s.id, title: 'spec' });
    takeIssue(db, out.id, lane('D1').id, null);
    takeIssue(db, inSpec.id, lane('D2').id, null);
    expect((await call('bld', 'orchestrator', 'lane_message', { name: 'D1', text: 'hi' })).text).toContain('mục ngoài spec là việc của phiên Chung');
    expect((await call('gen', 'orchestrator', 'lane_message', { name: 'D2', text: 'hi' })).text).toContain('phiên Chung chỉ làm mục ngoài spec');
    expect((await call('gen', 'orchestrator', 'lane_message', { name: 'D1', text: 'hi' })).err).toBe(false);
  });
});

describe('§5.3 lane_start {issue} (R-B2 base_sha) and §7.3 superpowers', () => {
  test('§7.3 superpowers off → lane_start refused with the reason, no lane started', async () => {
    superpowers = false;
    const r = await call('gen', 'orchestrator', 'lane_start', { name: 'D1', cwd: tmp, brief_path: '/b.md' });
    expect(r.text).toContain('superpowers chưa có hiệu lực');
    expect(started).toEqual([]);
  });

  test('§5.7 review-B MINOR-1 PO cancels the issue while lane_start spawns: the lane is named, no issue, Vietnamese next step', async () => {
    const wt = join(tmp, 'wt-z');
    repo(wt);
    const b = issue({ title: 'huỷ giữa chừng' });
    const start = lanes.start;
    lanes.start = async (o) => { const v = await start(o); cancelIssue(db, b.id, { reason: null, by: 'po' }); return v; };
    try {
      const r = await call('gen', 'orchestrator', 'lane_start', { name: 'Z1', cwd: wt, brief_path: '/b.md', issue: b.key });
      expect(r.err).toBe(false);
      expect(r.json()).toMatchObject({ name: 'Z1', issue: null, text: `lane Z1 đã mở nhưng ${b.key} vừa bị PO huỷ — lane_finish Z1` });
    } finally { lanes.start = start; }
    expect(started).toEqual(['Z1']);
    expect(messages).toEqual([]);
    expect(getIssue(db, b.id)!.state).toBe('cancelled');
  });

  test('§5.3 lane_start {issue} takes it with base_sha = HEAD and tells the lane; §5.5-3 then lane_start same issue refused', async () => {
    const wt = join(tmp, 'wt-a');
    repo(wt);
    const b = issue({ kind: 'bug', title: 'sửa log' });
    const r = await call('gen', 'orchestrator', 'lane_start', { name: 'D1', cwd: wt, brief_path: '/b.md', issue: b.key });
    expect(r.json()).toMatchObject({ name: 'D1', issue: b.key });
    expect(getIssue(db, b.id)).toMatchObject({ state: 'doing', baseSha: git(wt, 'rev-parse', 'HEAD') });
    expect(messages).toEqual([{ name: 'D1', text: `Nhận ${b.key}: sửa log. Đọc: issue_get ${b.key}` }]);
    const again = await call('gen', 'orchestrator', 'lane_start', { name: 'D2', cwd: wt, brief_path: '/b.md', issue: b.key });
    expect(again.text).toContain(`${b.key} đang làm`);
    expect(started).toEqual(['D1']);
  });

  test('§5.5-1 a blocked issue → refused naming the blockers; not a git dir → base_sha null', async () => {
    const s = activeSpec();
    const a = issue({ specId: s.id, title: 'a' });
    const t = issue({ specId: s.id, title: 't', blockedBy: [a.id] });
    expect((await call('bld', 'orchestrator', 'lane_start', { name: 'D1', cwd: tmp, brief_path: '/b.md', issue: t.key })).text).toContain(`chờ ${a.key}`);
    const r = await call('bld', 'orchestrator', 'lane_start', { name: 'D1', cwd: join(tmp, 'root'), brief_path: '/b.md', issue: a.key });
    expect(r.err).toBe(false);
    expect(getIssue(db, a.id)).toMatchObject({ state: 'doing', baseSha: null });
  });
});

describe('R-B13 (c) one issue, two concurrent lane_start', () => {
  test('R-B13 (c) two concurrent lane_start {issue} on one issue → the second is refused before any spawn; the first takes it', async () => {
    const b = issue({ kind: 'bug', title: 'đua' });
    const [x, y] = await Promise.all([
      call('gen', 'orchestrator', 'lane_start', { name: 'D1', cwd: join(tmp, 'root'), brief_path: '/b.md', issue: b.key }),
      call('gen', 'orchestrator', 'lane_start', { name: 'D2', cwd: join(tmp, 'root'), brief_path: '/b.md', issue: b.key }),
    ]);
    expect(x.err).toBe(false);
    expect(y.text).toContain(`${b.key} đang được giao cho một lane khác`);
    expect(started).toEqual(['D1']);
    expect(getIssue(db, b.id)).toMatchObject({ state: 'doing' });
  });

  test('R-B13 (c) the lane spawn fails → the issue is free again (todo), the next lane_start takes it', async () => {
    const b = issue({ kind: 'bug', title: 'hỏng spawn' });
    const start = lanes.start;
    lanes.start = () => Promise.reject(new Error('spawn failed'));
    try { expect((await call('gen', 'orchestrator', 'lane_start', { name: 'D1', cwd: join(tmp, 'root'), brief_path: '/b.md', issue: b.key })).err).toBe(true); }
    finally { lanes.start = start; }
    expect(getIssue(db, b.id)).toMatchObject({ state: 'todo', laneId: null });
    expect((await call('gen', 'orchestrator', 'lane_start', { name: 'D2', cwd: join(tmp, 'root'), brief_path: '/b.md', issue: b.key })).err).toBe(false);
  });

  test('G3a a successful issue / spec / lane_start tool tells the engine its project changed; a refused one does not', async () => {
    const b = issue({ kind: 'bug', title: 'đẩy' });
    await call('gen', 'orchestrator', 'issue_get', { key: 'T-999' });
    expect(ports.log.changed).toEqual([]);
    await call('gen', 'orchestrator', 'lane_start', { name: 'D1', cwd: join(tmp, 'root'), brief_path: '/b.md', issue: b.key });
    expect(ports.log.changed).toEqual(['p1']);
  });
});

describe('§5.3 issue_assign', () => {
  test('§5.5-3 outside-spec issue via issue_assign refused; §5.5-2 non-priority while a priority is ready refused; priority accepted', async () => {
    const s = activeSpec();
    lane('D1');
    const out = issue({ title: 'out' });
    expect((await call('gen', 'orchestrator', 'issue_assign', { key: out.key, lane: 'D1' })).text).toContain('chỉ giao bằng lane_start');
    const plain = issue({ specId: s.id, title: 'plain' });
    const prio = issue({ specId: s.id, title: 'prio', source: 'po' });
    expect((await call('bld', 'orchestrator', 'issue_assign', { key: plain.key, lane: 'D1' })).text).toContain(`giao ${prio.key}↑ trước`);
    expect((await call('bld', 'orchestrator', 'issue_assign', { key: prio.key, lane: 'D1' })).json()).toMatchObject({ ok: true, lane: 'D1' });
    expect(messages.at(-1)).toEqual({ name: 'D1', text: `Nhận ${prio.key}: prio. Đọc: issue_get ${prio.key}` });
    // §5.5-4 one doing issue per lane
    expect((await call('bld', 'orchestrator', 'issue_assign', { key: plain.key, lane: 'D1' })).text).toContain('một lane giữ tối đa một mục');
  });
});

describe('§5.5-7 / §5.6 issue_create', () => {
  test('§5.5-7 lane: source always lane, spec = held issue spec, unseen; dup of a PO-cancelled title refused with the reason', async () => {
    const s = activeSpec();
    const held = issue({ specId: s.id });
    takeIssue(db, held.id, lane('D1').id, null);
    const r = (await call('sD1', 'lane', 'issue_create', { title: 'Thêm log', kind: 'bug' })).json();
    const row = getIssueByKey(db, 'p1', r.key as string)!;
    expect(row).toMatchObject({ source: 'lane', specId: s.id, poSeen: false, sourceIssue: held.id, kind: 'bug' });
    const gone = issue({ title: 'Xuất CSV!' });
    cancelIssue(db, gone.id, { reason: 'không cần CSV', by: 'po' });
    expect((await call('sD1', 'lane', 'issue_create', { title: 'xuất csv' })).text).toContain('lý do: không cần CSV');
    expect((await call('sD1', 'lane', 'issue_create', { title: 'thêm LOG' })).json()).toMatchObject({ key: r.key, existing: true });
  });

  test('§5.2-10 state done only from the resumed Build session with source prior; Chung with a spec refused', async () => {
    const s = activeSpec();
    expect((await call('bld', 'orchestrator', 'issue_create', { title: 'cũ', state: 'done', source: 'prior' })).text).toContain('Tiếp tục build');
    updateSpec(db, s.id, { resumed: true });
    const r = (await call('bld', 'orchestrator', 'issue_create', { title: 'cũ', state: 'done', source: 'prior', commits: ['abcdef1'] })).json();
    expect(getIssueByKey(db, 'p1', r.key as string)).toMatchObject({ state: 'done', source: 'prior', specId: s.id });
    expect((await call('gen', 'orchestrator', 'issue_create', { title: 'n', spec: s.path })).text).toContain('chỉ tạo mục ngoài spec');
    const po = (await call('gen', 'orchestrator', 'issue_create', { title: 'po nói', source: 'po' })).json();
    expect(getIssueByKey(db, 'p1', po.key as string)).toMatchObject({ source: 'po', poSeen: true, specId: null });
  });
});

describe('issue_get / issues_list compact output (§5.7-7)', () => {
  test('issue_get: key, deps, done_when, recent events; unknown key refused', async () => {
    const a = issue({ title: 'a' });
    const t = issue({ title: 't', blockedBy: [a.id], doneWhen: ['test xanh'], body: 'làm X' });
    const g = (await call('gen', 'orchestrator', 'issue_get', { key: t.key })).json();
    expect(g).toEqual({
      key: t.key, kind: 'task', title: 't', state: 'todo', spec: null, lane: null, blocked_by: [{ key: a.key, state: 'todo' }],
      done_when: ['test xanh'], body: 'làm X', events: [{ type: 'created', source: 'spec', state: 'todo' }],
    });
    expect((await call('gen', 'orchestrator', 'issue_get', { key: 'T-99' })).text).toContain('Không có mục T-99');
  });

  test('review IMPORTANT-2 issue_get events name each lane: taken D2 → returned D2 → taken D5 (never the raw lane id)', async () => {
    const d2 = lane('D2'), d5 = lane('D5');
    const t = issue({ title: 't' });
    takeIssue(db, t.id, d2.id, null);
    releaseIssue(db, t.id, 'lane D2 kết thúc');
    takeIssue(db, t.id, d5.id, null);
    const g = (await call('gen', 'orchestrator', 'issue_get', { key: t.key })).json() as { lane: string; events: { type: string; lane?: unknown }[] };
    expect(g.lane).toBe('D5');
    expect(g.events.filter((e) => e.type !== 'created').map((e) => [e.type, e.lane])).toEqual([['taken', 'D2'], ['returned', 'D2'], ['taken', 'D5']]);
  });

  test('§5.7-7 issues_list {state: cancelled} lists the whole project with reasons; default Chung = outside spec only', async () => {
    const s = activeSpec();
    issue({ specId: s.id, title: 'spec' });
    const o = issue({ title: 'out', source: 'po' });
    const c = issue({ specId: s.id, title: 'huỷ' });
    cancelIssue(db, c.id, { reason: 'trùng', by: 'po' });
    const l = (await call('gen', 'orchestrator', 'issues_list', {})).json();
    expect(l).toEqual({ spec: null, issues: [{ key: o.key, title: 'out', state: 'todo', priority: true, ready: true }] });
    const x = (await call('gen', 'orchestrator', 'issues_list', { state: 'cancelled' })).json();
    expect(x).toEqual({ spec: 'all', issues: [{ key: c.key, title: 'huỷ', state: 'cancelled', cancel_reason: 'trùng' }] });
  });
});

describe('§5.5-5 issue_link / issue_update / issue_drop', () => {
  test('§5.5-5 a link closing a cycle refused; remove → "hết bị chặn" event', async () => {
    const a = issue({ title: 'a' });
    const b = issue({ title: 'b', blockedBy: [a.id] });
    expect((await call('gen', 'orchestrator', 'issue_link', { key: a.key, blocked_by: b.key })).text).toContain('tạo vòng');
    expect((await call('gen', 'orchestrator', 'issue_link', { key: b.key, blocked_by: a.key, remove: true })).err).toBe(false);
    expect(ports.log.sent.map((s) => s.text)).toContain(`[cc-slaves] ${b.key} hết bị chặn`);
    expect((await call('gen', 'orchestrator', 'issue_link', { key: a.key, blocked_by: b.key })).err).toBe(false);
  });

  test('§5.3 / R-B16 review-B IMPORTANT-2 a lane links only its held / own-created issues (add and remove)', async () => {
    const s = activeSpec();
    const other = moveSpec(db, insertSpec(db, { projectId: 'p1', path: 'docs/specs/v26.md', title: 'v2.6', origin: 'app' }).id, 'approved');
    const t1 = issue({ specId: s.id, title: 'giữ' });
    const t2 = issue({ specId: other.id, title: 'v26 a' });
    const t3 = issue({ specId: other.id, title: 'v26 b', blockedBy: [t2.id] });
    const t4 = issue({ title: 'ngoài' });
    const l = lane('D1');
    takeIssue(db, t1.id, l.id, null);
    const unlink = await call('sD1', 'lane', 'issue_link', { key: t3.key, blocked_by: t2.key, remove: true });
    expect(unlink).toMatchObject({ err: true });
    expect(unlink.text).toContain('lane chỉ liên kết mục nó giữ / nó tạo');
    expect(getIssue(db, t3.id)!.state).toBe('todo');
    expect((await call('sD1', 'lane', 'issue_link', { key: t2.key, blocked_by: t4.key })).text).toContain('lane chỉ liên kết mục nó giữ / nó tạo');
    expect((await call('sD1', 'lane', 'issue_link', { key: t1.key, blocked_by: t2.key })).text).toContain('lane chỉ liên kết mục nó giữ / nó tạo');
    const mine = (await call('sD1', 'lane', 'issue_create', { title: 'phát sinh' })).json().key as string;
    expect((await call('sD1', 'lane', 'issue_link', { key: mine, blocked_by: t1.key })).json()).toEqual({ ok: true, key: mine, blocked_by: t1.key });
    expect((await call('sD1', 'lane', 'issue_link', { key: mine, blocked_by: t1.key, remove: true })).err).toBe(false);
    expect(ports.log.sent.map((x) => x.text).join('\n')).not.toContain(`${t3.key} hết bị chặn`);
  });

  test('R-B16 review-B MINOR-3 issue_link: blocked_by outside the session scope refused (Build: its spec; Chung: outside spec)', async () => {
    const s = activeSpec();
    const other = moveSpec(db, insertSpec(db, { projectId: 'p1', path: 'docs/specs/v26.md', title: 'v2.6', origin: 'app' }).id, 'approved');
    const t1 = issue({ specId: s.id, title: 'v25' });
    const t1b = issue({ specId: s.id, title: 'v25 b' });
    const t2 = issue({ specId: other.id, title: 'v26' });
    const o1 = issue({ title: 'ngoài 1' });
    const o2 = issue({ title: 'ngoài 2' });
    const cross = await call('bld', 'orchestrator', 'issue_link', { key: t1.key, blocked_by: t2.key });
    expect(cross.err).toBe(true);
    expect(cross.text).toContain('phụ thuộc chỉ trong cùng spec; việc của spec khác → báo PO');
    expect((await call('bld', 'orchestrator', 'issue_link', { key: t1.key, blocked_by: o1.key })).text).toContain('phụ thuộc chỉ trong cùng spec');
    expect((await call('gen', 'orchestrator', 'issue_link', { key: o1.key, blocked_by: t1.key })).text).toContain('phụ thuộc chỉ trong cùng spec');
    expect((await call('bld', 'orchestrator', 'issue_link', { key: t1.key, blocked_by: t1b.key })).err).toBe(false);
    expect((await call('gen', 'orchestrator', 'issue_link', { key: o1.key, blocked_by: o2.key })).err).toBe(false);
  });

  test('issue_update: done issue refused, open one updated', async () => {
    const a = issue({ title: 'a' });
    expect((await call('gen', 'orchestrator', 'issue_update', { key: a.key, done_when: ['một'] })).err).toBe(false);
    expect(getIssue(db, a.id)!.doneWhen).toEqual(['một']);
    cancelIssue(db, a.id, { reason: null, by: 'po' });
    expect((await call('gen', 'orchestrator', 'issue_update', { key: a.key, title: 'b' })).text).toContain('đã huỷ');
  });

  test('§5.5-8 issue_drop: Chung refused; Build drops its todo with the reason; last one → "xong hết mục"', async () => {
    const s = activeSpec();
    const t = issue({ specId: s.id, title: 't' });
    expect((await call('gen', 'orchestrator', 'issue_drop', { key: t.key, reason: 'thừa' })).err).toBe(true);
    expect((await call('bld', 'orchestrator', 'issue_drop', { key: t.key, reason: 'thừa' })).json()).toMatchObject({ state: 'cancelled' });
    expect(getIssue(db, t.id)!.cancelReason).toBe('thừa');
    expect(ports.log.sent.filter((x) => x.sid === 'bld').map((x) => x.text).join('\n')).toContain('xong hết mục');
  });
});

describe('§5.5-6 issue_done (R-B7 trailer)', () => {
  test('§5.5-6 commit without trailer → refused with the fix command; with trailer → done + commits saved', async () => {
    const s = activeSpec();
    const wt = join(tmp, 'wt-g');
    repo(wt);
    const l = lane('D1', wt);
    const t = issue({ specId: s.id });
    takeIssue(db, t.id, l.id, git(wt, 'rev-parse', 'HEAD'));
    commit(wt, 'feat: x');
    const r = await call('sD1', 'lane', 'issue_done', { key: t.key, summary: 'xong' });
    expect(r.text).toContain(`git commit --amend --no-edit --trailer "Issue: ${t.key}"`);
    expect(getIssue(db, t.id)!.state).toBe('doing');
    git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '--amend', '--no-edit', '--trailer', `Issue: ${t.key}`);
    const ok = await call('sD1', 'lane', 'issue_done', { key: t.key, summary: 'xong' });
    expect(ok.text).toBe(JSON.stringify({ ok: true, key: t.key, commits: 1 }));
    expect(getIssue(db, t.id)!.state).toBe('done');
    expect(listEvents(db, t.id).at(-1)).toMatchObject({ type: 'done', data: { summary: 'xong' } });
  });

  test('§5.5-6 not the held issue → refused; orchestrator calling issue_done → lane-only text', async () => {
    const t = issue();
    lane('D1');
    expect((await call('sD1', 'lane', 'issue_done', { key: t.key, summary: 's' })).text).toContain('không phải mục lane D1 đang giữ');
    expect((await call('gen', 'orchestrator', 'issue_done', { key: t.key, summary: 's' })).text).toBe('issue_done chỉ dành cho lane đang giữ mục');
  });
});

describe('§5.7-5 / §5.7-6 the revert issue (G3b)', () => {
  /** T-1 done, T-2 "Hoàn tác T-1" held by lane R6 (as §5.7-4 leaves them). */
  const reverting = () => {
    const o = issue();
    const l = lane('R6');
    takeIssue(db, o.id, l.id, null);
    db.query("UPDATE issue SET state = 'done', revert = 'pending' WHERE id = ?").run(o.id);
    const r = issue({ source: 'po', reverts: o.id, title: `Hoàn tác ${o.key}` });
    db.query('UPDATE issue SET lane_id = NULL WHERE id = ?').run(o.id); // a lane holds one doing issue; history kept elsewhere
    takeIssue(db, r.id, l.id, null);
    return { o, r };
  };

  test('§5.7-5 issue_revert_conflict from the lane holding the revert issue → revert cancelled, original done + conflict, the conflict port told', async () => {
    const { o, r } = reverting();
    const res = await call('sR6', 'lane', 'issue_revert_conflict', { key: r.key, detail: 'xung đột ở a.ts với T-53' });
    expect(res.json()).toMatchObject({ ok: true, key: r.key, state: 'cancelled', original: o.key, revert: 'conflict' });
    expect(getIssue(db, r.id)!).toMatchObject({ state: 'cancelled', cancelReason: 'xung đột ở a.ts với T-53' });
    expect(getIssue(db, o.id)!).toMatchObject({ state: 'done', revert: 'conflict' });
    expect(ports.log.conflicts).toEqual([[o.key, r.key, 'xung đột ở a.ts với T-53']]);
  });

  test('§5.7-5 only the lane holding the revert issue; a normal issue / empty detail → refused, nothing written', async () => {
    const { o, r } = reverting();
    lane('X1');
    expect((await call('sX1', 'lane', 'issue_revert_conflict', { key: r.key, detail: 'd' })).text).toContain('chỉ lane đang giữ');
    expect((await call('gen', 'orchestrator', 'issue_revert_conflict', { key: r.key, detail: 'd' })).err).toBe(true);
    expect((await call('sR6', 'lane', 'issue_revert_conflict', { key: r.key, detail: '  ' })).text).toContain('cần detail');
    expect(getIssue(db, o.id)!.revert).toBe('running') // the lane took the revert issue (§5.7-4);
    expect(ports.log.conflicts).toEqual([]);
  });

  test('§5.7-6 the revert issue done → original cancelled, revert done; the issue it blocked → the orchestrator is told to unlink', async () => {
    const { o, r } = reverting();
    const w = issue();
    db.query('INSERT INTO issue_dep (issue_id, blocked_by_id) VALUES (?, ?)').run(w.id, o.id);
    expect((await call('sR6', 'lane', 'issue_done', { key: r.key, summary: 'đã revert' })).err).toBe(false);
    expect(getIssue(db, o.id)!).toMatchObject({ state: 'cancelled', revert: 'done' });
    const note = ports.log.sent.map((s) => s.text).find((t) => t.includes(`${o.key} đã hoàn tác`));
    expect(note).toContain(`${w.key} bị chặn tới khi Điều phối gỡ`);
  });
});

describe('§5.1 issue_file: issue_create {files} (orchestrator)', () => {
  test('§5.1 a PO attachment copy → kept under <home>/issues/<project>/<key>/ + one issue_file row; a path outside the attach dir → refused, no issue', async () => {
    const attach = join(tmp, 'attach');
    const home = join(tmp, 'home');
    mkdirSync(join(attach, 'up1'), { recursive: true });
    const saved = { a: process.env.CC_SLAVES_ATTACH, h: process.env.CC_SLAVES_HOME };
    process.env.CC_SLAVES_ATTACH = attach; process.env.CC_SLAVES_HOME = home;
    try {
      const img = join(attach, 'up1', 'loi.png');
      await Bun.write(img, 'png-bytes');
      const outside = join(tmp, 'secret.txt'); // a real file, just not a PO attachment
      await Bun.write(outside, 'x');
      const bad = await call('gen', 'orchestrator', 'issue_create', { title: 'nút lỗi', kind: 'bug', spec: null, source: 'po', files: [outside] });
      expect(bad.text).toContain('không phải ảnh / file PO đính kèm');
      expect(db.query('SELECT COUNT(*) AS n FROM issue').get()).toEqual({ n: 0 });
      const ok = (await call('gen', 'orchestrator', 'issue_create', { title: 'nút lỗi', kind: 'bug', spec: null, source: 'po', files: [img] })).json();
      expect(ok).toMatchObject({ key: 'B-1', files: 1 });
      const row = db.query<{ name: string; path: string; size: number }, []>('SELECT name, path, size FROM issue_file').get()!;
      expect(row).toEqual({ name: 'loi.png', path: join(home, 'issues', 'p1', 'B-1', '1-loi.png'), size: 9 });
      expect(await Bun.file(row.path).text()).toBe('png-bytes');
      // review IMPORTANT-1 the lane reads the kept copy: issue_get lists name + engine path
      expect((await call('gen', 'orchestrator', 'issue_get', { key: 'B-1' })).json().files).toEqual([{ name: 'loi.png', path: row.path }]);
    } finally {
      if (saved.a === undefined) delete process.env.CC_SLAVES_ATTACH; else process.env.CC_SLAVES_ATTACH = saved.a;
      if (saved.h === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = saved.h;
    }
  });
});
