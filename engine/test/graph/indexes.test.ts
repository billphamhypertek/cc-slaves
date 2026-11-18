// v2.5 §5.5 when the engine indexes by itself, the index book, R4 and the automatic clean-up — over a fake control port and
// a temp state.db / temp dirs (never the real tool, Z5; deletes only through the port, never a file).
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/db.ts';
import { GraphIndexes, type IndexPort } from '../../src/graph/indexes.ts';
import { IndexQueue } from '../../src/graph/queue.ts';
import type { IndexRow } from '../../src/graph/orphans.ts';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-idx-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const P = join(tmp, 'proj'); const NG = join(tmp, 'nogit'); const WT = join(P, '.wt', 'd1');
mkdirSync(join(P, '.git'), { recursive: true }); mkdirSync(WT, { recursive: true }); mkdirSync(NG);

let rows: IndexRow[]; let runs: string[]; let removed: string[]; let auto: boolean; let db: Db; let idx: GraphIndexes; let live: string[]; let offRoots: string[];
function make(): GraphIndexes {
  const port: IndexPort = {
    call: async (name, args) => {
      if (name !== 'list_projects') throw new Error(name);
      const off = Number(args.offset ?? 0); const page = rows.slice(off, off + 2);
      return { projects: page, has_more: off + page.length < rows.length };
    },
    autoIndex: async () => auto,
    run: (root) => { runs.push(root); rows.push({ name: `n:${root}`, root_path: root, size_bytes: 1 }); return { done: Promise.resolve({ ok: true }), cancel: () => {} }; },
    status: async () => 'succeeded',
    remove: async (name) => { removed.push(name); rows = rows.filter((r) => r.name !== name); return { ok: true }; },
  };
  return new GraphIndexes({
    db, port, queue: new IndexQueue(port, { pollMs: 5, graceMs: 0 }), home: tmp,
    projects: () => [{ id: 'p1', path: P }, { id: 'p2', path: NG }], liveCwds: () => live,
    roots: () => [P, NG, ...offRoots],
  });
}
const book = () => db.query('SELECT root_path, project_id, origin FROM graph_index ORDER BY root_path').all();
const settle = () => Bun.sleep(40);
beforeEach(() => { rows = []; runs = []; removed = []; auto = false; live = []; offRoots = []; db = openDb(':memory:'); idx = make(); });

describe('§5.5 automatic indexing', () => {
  test('module ready: every project root with no index is queued (every list page read); one that has one is not', async () => {
    rows = [{ name: 'a', root_path: '/x/a' }, { name: 'b', root_path: '/x/b' }, { name: 'np', root_path: NG }];
    await idx.ready(); await settle();
    expect(runs).toEqual([P]);
    expect(book()).toEqual([{ root_path: P, project_id: 'p1', origin: 'project' }]);
  });
  test('project added → its root is indexed when it has none', async () => {
    await idx.ready(); await settle(); runs = [];
    const NEW = join(tmp, 'new'); mkdirSync(NEW, { recursive: true });
    await idx.projectAdded('p3', NEW); await settle();
    expect(runs).toEqual([NEW]);
  });
  test('a spawn with cwd ≠ root and no index → the cwd (book: lane); cwd = root of a git project → nothing; already indexed → nothing', async () => {
    await idx.ready(); await settle(); runs = [];
    await idx.spawned('p1', WT); await settle();
    await idx.spawned('p1', P); await settle();
    await idx.spawned('p1', WT); await settle();
    expect(runs).toEqual([WT]);
    expect(book()).toContainEqual({ root_path: WT, project_id: 'p1', origin: 'lane' });
  });
  test('a spawn in a non-git project → its root is indexed again, every spawn', async () => {
    await idx.ready(); await settle(); runs = [];
    await idx.spawned('p2', NG); await settle();
    await idx.spawned('p2', NG); await settle();
    expect(runs).toEqual([NG, NG]);
  });
  test('a spawn before the module is ready is remembered and done at ready', async () => {
    await idx.spawned('p1', WT);
    expect(runs).toEqual([]);
    await idx.ready(); await settle();
    expect(runs.sort()).toEqual([NG, P, WT].sort()); // NG: a project root with no index yet
  });
  test('R4 auto_index=true: the spawn queues nothing, the tool job is adopted (running, by the tool) and booked', async () => {
    auto = true;
    await idx.ready(); await settle(); runs = [];
    await idx.spawned('p1', WT);
    expect(idx.status(WT)).toMatchObject({ state: 'running' });
    await settle();
    expect(runs).toEqual([]);
    expect(book()).toContainEqual({ root_path: WT, project_id: 'p1', origin: 'lane' });
  });
  test('lane index through the gate: booked (lane, or project for the root) and queued; status() answers for it', async () => {
    await idx.ready(); await settle(); runs = [];
    expect(idx.laneIndex('p1', join(WT, 'pkg'), {})).toEqual({ ahead: 0 });
    expect(idx.status(join(WT, 'pkg'))).not.toBeNull();
    expect(idx.status('/never/seen')).toBeNull();
    await settle();
    expect(book()).toContainEqual({ root_path: join(WT, 'pkg'), project_id: 'p1', origin: 'lane' });
  });
});

describe('§5.5 automatic clean-up (lane rows only)', () => {
  test('review-e MINOR-3: the root of a project with the graph off is never an orphan, and a spawn there books it as a project root', async () => {
    const OFF = join(tmp, 'moved-away');
    offRoots = [OFF, WT];
    expect(idx.keep().has(OFF)).toBe(true);
    await idx.ready(); await settle();
    await idx.spawned('p1', WT); await settle();
    expect(book()).toContainEqual({ root_path: WT, project_id: 'p1', origin: 'project' });
  });
  test('a lane row whose dir is gone and is no live lane cwd → delete_project + the row goes; project rows / live cwds stay', async () => {
    const OLD = join(tmp, 'old-wt'); const LIVE = join(tmp, 'live-wt'); const GP = join(tmp, 'gone-proj');
    rows = [{ name: 'old', root_path: OLD }, { name: 'live', root_path: LIVE }, { name: 'gp', root_path: GP }, { name: 'user', root_path: join(tmp, 'user-gone') },
      { name: 'p', root_path: P }, { name: 'ng', root_path: NG }];
    db.run(`INSERT INTO graph_index VALUES ('${OLD}','p1','lane'), ('${LIVE}','p1','lane'), ('${GP}','p9','project'), ('${join(tmp, 'never')}','p1','lane')`);
    live = [LIVE];
    await idx.ready(); await settle();
    expect(removed).toEqual(['old']); // 'user' is not in the book: only the "Dọn" button deletes it
    expect(book()).toEqual([
      { root_path: GP, project_id: 'p9', origin: 'project' }, { root_path: LIVE, project_id: 'p1', origin: 'lane' },
    ]);
    await idx.laneDone(); await settle();
    expect(removed).toEqual(['old']);
  });
});
