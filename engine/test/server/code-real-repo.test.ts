// v2.3 §10.2 the Code + Git commands wired to engine state on a real temp repo (no PO config: see git/_repo.ts): a repo
// that configures a program still lists its lane sources with `.gitignore` honoured (`fs_*` uses no git that runs a
// program), and `git_watch on` re-measures only the stale lane branches.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LaneBranch } from '../../../shared/protocol.ts';
import { insertLane, insertProject, openDb, setLaneBranch, type Db, type Lane } from '../../src/db.ts';
import type { Engine } from '../../src/engine.ts';
import { CodeArea } from '../../src/engine/code.ts';
import { invalidateGitConfig } from '../../src/git/run.ts';
import { BranchTracker } from '../../src/lane/branch.ts';
import { codeHandlers } from '../../src/server/code-commands.ts';
import { route } from '../../src/server/router.ts';
import { execIn } from '../../src/setup/setup.ts';
import { commit, fixture, git, type Fixture } from '../git/_repo.ts';

setDefaultTimeout(30_000);
let f: Fixture, wt: string, db: Db, lane: Lane;
const NOW = 1_000_000_000;

beforeEach(() => {
  f = fixture();
  invalidateGitConfig();
  wt = join(f.root, 'wt-d1');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'lane/d1', wt, 'main');
  commit(wt, '.gitignore', 'build/\n*.log\n');
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  writeFileSync(join(wt, 'x.log'), 'log\n');
  db = openDb(join(f.root, 'state.db'));
  insertProject(db, { id: 'p', name: 'P', path: f.repo });
  lane = insertLane(db, { projectId: 'p', name: 'D1', cwd: wt });
});
afterEach(() => { db.close(); f.done(); });

function engine(): Engine & { code: CodeArea } {
  const branches = new BranchTracker({ db, exec: execIn(process.env), now: () => NOW, repoOf: () => f.repo, onChange: () => {} });
  const e = {
    db, gitExec: execIn(process.env), stopped: false, branches,
    projectRow: (id: string) => (id === 'p' ? { id: 'p', name: 'P', path: f.repo } : null),
    lanes: { list: () => [] }, orchestrators: { list: () => [] }, broadcast: () => {}, hub: { gitVisible: () => true },
  } as unknown as Engine & { code: CodeArea };
  e.code = new CodeArea(e);
  return e;
}
const mac = () => ({ channel: 'mac' as const, watch: null, present: true, send: () => {} });

describe('§10.2 fs_* on a repo that configures a program', () => {
  test('§10.2 local filter.x.clean → lane fs_list acks, .gitignore still hides x.log', async () => {
    git(f.repo, 'config', 'filter.x.clean', 'false');
    const h = codeHandlers(engine(), mac(), async () => {});
    const r = await route(h as never, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd: 'fs_list', projectId: 'p', src: { kind: 'lane', laneId: 'D1' }, dir: '', showIgnored: false } });
    expect(r).toMatchObject({ type: 'ack' });
    const names = (r as { result: { entries: { name: string }[] } }).result.entries.map((x) => x.name).sort();
    expect(names).toEqual(['.gitignore', 'README', 'a.txt']); // x.log hidden by .gitignore
  });
});

describe('§10.2 git_watch on: "đo thêm khi mở tab Git (cũ hơn 60 s)"', () => {
  const info = (measuredAt: number): LaneBranch => ({ state: 'unmerged', ahead: 1, behind: 0, files: 1, add: 1, del: 0, measuredAt } as LaneBranch);
  async function watch(): Promise<string[]> {
    const e = engine();
    const measured: string[] = [];
    e.branches.measure = (l: Lane) => { measured.push(l.name); return Promise.resolve(); };
    const orig = e.code.measureStale.bind(e.code);
    const done = new Promise<void>((res) => { e.code.measureStale = async (...a) => { await orig(...a); res(); }; });
    void codeHandlers(e, mac(), async () => {}).git_watch({ cmd: 'git_watch', projectId: 'p', on: true }, { channel: 'mac' });
    await Promise.race([done, new Promise((res) => setTimeout(res, 3_000))]);
    return measured;
  }

  test('§10.2 stored measure older than 60 s → one measure of that lane', async () => {
    setLaneBranch(db, lane.id, { name: 'lane/d1', info: info(NOW - 61_000) });
    expect(await watch()).toEqual(['D1']);
  });

  test('§10.2 stored measure fresh (< 60 s) → no measure', async () => {
    setLaneBranch(db, lane.id, { name: 'lane/d1', info: info(NOW - 1_000) });
    expect(await watch()).toEqual([]);
  });
});
