// v2.1 §4.15 Engine: branch tracker (triggers, keep-old-numbers, base poll), unmerged count, `done_lanes_list` paging.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLane, insertLane, insertProject, insertSession, openDb, updateLaneFields, updateLaneState, listDoneLanes, type Db, type Lane } from '../src/db.ts';
import { BranchTracker } from '../src/lane/branch.ts';
import { execIn, type Exec } from '../src/setup/setup.ts';

setDefaultTimeout(30_000); // real git spawns (~50 ms each on this Mac)
let root: string;
let repo: string;
let db: Db;
let changed: string[];
let calls: number;
let clock: number;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function commit(cwd: string, file: string, body: string): void {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
}
/** Lane `name` with its own worktree + branch `lane/<name>` and one commit; `done` = lane_finish already ran. */
function lane(name: string, o: { done?: boolean; reported?: boolean; task?: string; commit?: boolean } = {}): Lane {
  const wt = join(root, `wt-${name}`);
  git(repo, 'worktree', 'add', '-q', '-b', `lane/${name.toLowerCase()}`, wt, 'main');
  if (o.commit !== false) commit(wt, `${name}.txt`, `${name}\n`);
  const l = insertLane(db, { projectId: 'p', name, cwd: wt, task: o.task ?? null });
  if (o.reported || o.done) updateLaneFields(db, l.id, { phase: 'done' });
  if (o.done) updateLaneState(db, l.id, 'done');
  return getLane(db, 'p', name)!;
}

const counting: Exec = async (argv, opt) => { calls++; return execIn(process.env)(argv, opt); };
const tracker = (exec: Exec = counting) => new BranchTracker({
  db, exec, now: () => clock, repoOf: (id) => (id === 'p' ? repo : null), onChange: (p, n) => changed.push(`${p}/${n}`),
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-done-')));
  repo = join(root, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  commit(repo, 'README', 'base\n');
  db = openDb(join(root, 'state.db'));
  insertProject(db, { id: 'p', name: 'P', path: repo });
  changed = []; calls = 0; clock = 1_000_000;
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe('§4.15 Engine BranchTracker', () => {
  test('§4.15 "reported done" lane has branch but is not counted; counted after lane_finish', async () => {
    const t = tracker();
    const l = lane('D1', { reported: true });
    await t.measure(l);
    expect(t.info(l.id)).toMatchObject({ name: 'lane/d1', state: 'unmerged', ahead: 1 });
    expect(t.unmergedCount('p')).toBe(0);
    updateLaneState(db, l.id, 'done');
    expect(t.unmergedCount('p')).toBe(1);
    expect(changed).toContain('p/D1');
  });

  test('§4.15 §3 no own branch (lane in the repo itself) → none, not counted', async () => {
    const t = tracker();
    const l = insertLane(db, { projectId: 'p', name: 'R', cwd: repo });
    updateLaneState(db, l.id, 'done');
    await t.measure(getLane(db, 'p', 'R')!);
    expect(t.info(l.id)).toMatchObject({ state: 'none', name: null });
    expect(t.unmergedCount('p')).toBe(0);
  });

  test('§4.15 Trạng thái: timeout → unknown + reason, not counted', async () => {
    const l = lane('D2', { done: true });
    const t = new BranchTracker({ db, exec: () => new Promise(() => {}), now: () => clock, repoOf: () => repo, onChange: () => {}, timeoutMs: 30 });
    await t.measure(l);
    expect(t.info(l.id)).toMatchObject({ state: 'unknown', reason: 'timeout' });
    expect(t.unmergedCount('p')).toBe(0);
  });

  test('§4.15 Trạng thái: measuring keeps the old numbers + measuring flag', async () => {
    const t = tracker();
    const l = lane('D3', { done: true });
    await t.measure(l);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = new BranchTracker({ db, exec: async (a, o) => { await gate; return execIn(process.env)(a, o); }, now: () => clock, repoOf: () => repo, onChange: () => {} });
    const p = slow.measure(l);
    expect(slow.info(l.id)).toMatchObject({ state: 'unmerged', ahead: 1, measuring: true });
    release(); await p;
    expect(slow.info(l.id)?.measuring).toBeFalsy();
  });

  test('v2.3 §10.2 (c) a measure that sees a new lane commit → onCommit(lane); same tip / first measure → nothing; base moved → onCommit(null)', async () => {
    const commits: string[] = [];
    const t = new BranchTracker({ db, exec: counting, now: () => clock, repoOf: () => repo, onChange: () => {}, onCommit: (p, n) => commits.push(`${p}/${n}`) });
    const l = lane('D8', { done: true });
    await t.measure(l);
    await t.measure(l);
    expect(commits).toEqual([]);
    commit(join(root, 'wt-D8'), 'n.txt', 'n\n');
    await t.measure(l);
    expect(commits).toEqual(['p/D8']);
    await t.pollBases(); // records the base
    commit(repo, 'base2.txt', 'b\n');
    await t.pollBases();
    expect(commits).toEqual(['p/D8', 'p/null']);
  });

  test('v2.3 §10.2 a sha moved mid-measure: that result is discarded, measured once more; moving again keeps the old numbers', async () => {
    const t = tracker();
    const l = lane('D9', { done: true });
    await t.measure(l);
    expect(t.info(l.id)).toMatchObject({ state: 'unmerged', ahead: 1 });
    const wt = join(root, 'wt-D9');
    const sha1 = git(wt, 'rev-parse', 'HEAD');
    commit(wt, 'm.txt', 'm\n');
    const sha2 = git(wt, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/heads/lane/d9', sha1);
    let moves: string[] = [];
    const racing: Exec = async (a, o) => {
      const r = await execIn(process.env)(a, o);
      const to = a.includes('merge-tree') ? moves.shift() : undefined;
      if (to) git(repo, 'update-ref', 'refs/heads/lane/d9', to);
      return r;
    };
    moves = [sha2];
    await tracker(racing).measure(l); // moved once → re-measured with the new commit
    expect(t.info(l.id)).toMatchObject({ state: 'unmerged', ahead: 2 });
    moves = [sha1, sha2];
    await tracker(racing).measure(l); // moved on both tries → nothing stored, the old numbers stay
    expect(t.info(l.id)).toMatchObject({ state: 'unmerged', ahead: 2 });
  });

  test('§4.15 branch name recorded while the worktree lives; worktree + branch removed later → gone (name kept)', async () => {
    const t = tracker();
    const l = lane('D4', { done: true });
    await t.measure(l);
    git(repo, 'worktree', 'remove', '--force', l.cwd);
    git(repo, 'branch', '-D', 'lane/d4');
    await t.measure(l);
    expect(t.info(l.id)).toMatchObject({ name: 'lane/d4', state: 'gone' });
  });

  test('§4.15 done-lane view opened: measures only when older than 60 s', async () => {
    const t = tracker();
    const l = lane('D5', { done: true });
    await t.measure(l);
    calls = 0;
    clock += 59_000; await t.measureIfStale(l);
    expect(calls).toBe(0);
    clock += 2_000; await t.measureIfStale(l);
    expect(calls).toBeGreaterThan(0);
  });

  test('§4.15 base branch commit changed → tracked lanes re-measured (first poll only records)', async () => {
    const t = tracker();
    const l = lane('D6', { done: true });
    await t.measure(l);
    changed = [];
    await t.pollBases();
    expect(changed).toEqual([]);
    git(repo, 'merge', '-q', '--squash', 'lane/d6'); git(repo, 'commit', '-q', '-m', 'sq');
    await t.pollBases();
    expect([...new Set(changed)]).toEqual(['p/D6']); // measuring started + finished
    expect(t.info(l.id)?.state).toBe('merged');
    expect(t.unmergedCount('p')).toBe(0);
  });
  test('§4.15 base branch moved → every tracked lane of the project is re-measured, in lane order', async () => {
    const t = tracker();
    const a = lane('D7', { done: true });
    const b = lane('D8', { done: true });
    await t.measure(a); await t.measure(b);
    await t.pollBases();
    changed = [];
    commit(repo, 'other.txt', 'x\n');
    await t.pollBases();
    expect([...new Set(changed)]).toEqual(['p/D7', 'p/D8']);
  });
});

describe('§4.15 Engine done_lanes_list (db)', () => {
  test('§4.15 done_at set once when the lane enters done', () => {
    const l = insertLane(db, { projectId: 'p', name: 'X', cwd: '/w/x' });
    updateLaneState(db, l.id, 'done');
    const at = db.query<{ done_at: number }, [number]>('SELECT done_at FROM lane WHERE id = ?').get(l.id)!.done_at;
    expect(at).toBeGreaterThan(0);
  });

  test('§4.15 list: newest first, only done lanes, query on name / task / branch, unmerged filter, pagination', async () => {
    const t = tracker();
    const ls = [lane('A1', { done: true, task: 'login form' }), lane('B2', { done: true }), lane('C3', { done: true }),
      lane('D4', { reported: true }), lane('E5', { done: true, commit: false })];
    for (const [i, l] of ls.entries()) {
      db.query('UPDATE lane SET done_at = ? WHERE id = ? AND done_at IS NOT NULL').run(100 + i, l.id);
      await t.measure(l);
    }
    const all = listDoneLanes(db, { projectId: 'p', limit: 10 });
    expect(all.rows.map((l) => l.name)).toEqual(['E5', 'C3', 'B2', 'A1']); // D4 only reported done
    expect(all).toMatchObject({ total: 4, unmerged: 3, unknown: 0, next: null });
    expect(listDoneLanes(db, { projectId: 'p', query: 'LOGIN', limit: 10 }).rows.map((l) => l.name)).toEqual(['A1']);
    expect(listDoneLanes(db, { projectId: 'p', query: 'lane/b', limit: 10 }).rows.map((l) => l.name)).toEqual(['B2']);
    expect(listDoneLanes(db, { projectId: 'p', query: '%', limit: 10 }).rows).toEqual([]);
    expect(listDoneLanes(db, { projectId: 'p', unmerged: true, limit: 10 }).rows.map((l) => l.name)).toEqual(['C3', 'B2', 'A1']); // E5 merged (no commit)
    const p1 = listDoneLanes(db, { projectId: 'p', limit: 2 });
    expect(p1.rows.map((l) => l.name)).toEqual(['E5', 'C3']);
    expect(p1.next).not.toBeNull();
    const p2 = listDoneLanes(db, { projectId: 'p', limit: 2, before: p1.next! });
    expect(p2.rows.map((l) => l.name)).toEqual(['B2', 'A1']);
    expect(p2.next).toBeNull();
  });

  test('§4.15 list `session` filter: only lanes owned by that orchestrator session (§4.14 owner_session)', () => {
    for (const s of ['s1', 's2']) insertSession(db, { id: s, projectId: 'p', kind: 'orchestrator', account: null });
    for (const [name, owner] of [['A', 's1'], ['B', 's2'], ['C', 's1']] as const) {
      updateLaneState(db, insertLane(db, { projectId: 'p', name, cwd: `/w/${name}`, ownerSession: owner }).id, 'done');
    }
    expect(listDoneLanes(db, { projectId: 'p', session: 's1', limit: 10 }).rows.map((l) => l.name).sort()).toEqual(['A', 'C']);
    expect(listDoneLanes(db, { projectId: 'p', session: 's2', limit: 10 }).rows.map((l) => l.name)).toEqual(['B']);
    expect(listDoneLanes(db, { projectId: 'p', limit: 10 }).rows).toHaveLength(3);
  });

  test('§4.15 N6-k unmerged chip also lists "không đo được" (unknown) but never counts it', async () => {
    const l = lane('U1', { done: true });
    const t = new BranchTracker({ db, exec: () => new Promise(() => {}), now: () => clock, repoOf: () => repo, onChange: () => {}, timeoutMs: 20 });
    await t.measure(l);
    const r = listDoneLanes(db, { projectId: 'p', unmerged: true, limit: 10 });
    expect(r.rows.map((x) => x.name)).toEqual(['U1']);
    expect(r).toMatchObject({ unmerged: 0, unknown: 1 });
  });
});
