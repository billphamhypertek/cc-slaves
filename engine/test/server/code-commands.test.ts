// v2.3 §10.2 / §11 the Code + Git commands wired to engine state: §5.3 lock input from the live lanes / orchestrators,
// open_in_vscode's Code form, git_log while the Git tab is hidden, code_changed is Mac only.
import { rejects } from '../_fixtures/rejects.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, LaneState, OrchestratorState, ServerMsg } from '../../../shared/protocol.ts';
import { insertLane, insertProject, openDb, type Db } from '../../src/db.ts';
import type { Engine } from '../../src/engine.ts';
import { CodeArea } from '../../src/engine/code.ts';
import { codeHandlers } from '../../src/server/code-commands.ts';
import { route } from '../../src/server/router.ts';
import { WsHub, type Conn } from '../../src/server/ws.ts';
import type { Exec } from '../../src/setup/setup.ts';

let tmp: string, dir: string, db: Db;
let lanes: { name: string; state: LaneState; cwd: string }[];
let orch: (OrchestratorState | 'done')[];
let events: EngineEvent[];
let gitCalls: string[][];
let visible: boolean;

beforeEach(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'ccs-codecmd-')));
  dir = join(tmp, 'proj');
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  db = openDb(join(tmp, 'state.db'));
  insertProject(db, { id: 'p', name: 'P', path: dir });
  lanes = []; orch = []; events = []; gitCalls = []; visible = false;
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function engine(): Engine {
  const gitExec: Exec = async (a) => { gitCalls.push(a); return { code: 128, stdout: '', stderr: 'fatal: not a git repository' }; };
  const e = {
    db, gitExec, stopped: false,
    projectRow: (id: string) => (id === 'p' ? { id: 'p', name: 'P', path: dir } : null),
    lanes: { list: () => lanes.map((l) => ({ ...l, projectId: 'p' })) },
    orchestrators: { list: () => orch.map((state) => ({ view: () => ({ state }) })) },
    broadcast: (ev: EngineEvent) => { events.push(ev); },
    hub: { gitVisible: () => visible },
  } as unknown as Engine & { code: CodeArea };
  (e as { code: CodeArea }).code = new CodeArea(e);
  return e;
}
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const write = (e: Engine) => e.code.fs.write({ projectId: 'p', src: { kind: 'base' }, path: 'a.txt', text: 'b\n', eol: 'lf', bom: false, baseHash: sha1('a\n') });
const codeOf = async (p: Promise<unknown>) => { try { await p; return ''; } catch (err) { return (err as { code?: string }).code ?? String(err); } };

describe('§11 khoá sửa from engine state (§5.3)', () => {
  const LIVE: LaneState[] = ['starting', 'running', 'idle', 'waiting_po', 'switching', 'waiting_quota', 'draining'];
  test('§11 every live LaneState in the source dir → lane_running; done / stopped / broken → the write goes through', async () => {
    for (const state of LIVE) {
      lanes = [{ name: 'D1', state, cwd: dir }];
      expect(await codeOf(write(engine()))).toBe('lane_running');
    }
    for (const state of ['done', 'stopped', 'broken'] as const) {
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      lanes = [{ name: 'D1', state, cwd: dir }];
      expect(await write(engine())).toMatchObject({ ok: true });
    }
  });

  test('§11 every OrchestratorState on the project dir: busy → lane_running, idle / stopped / ended → free', async () => {
    for (const s of ['starting', 'running', 'switching', 'waiting_quota'] as const) {
      orch = ['idle', s];
      expect(await codeOf(write(engine()))).toBe('lane_running');
    }
    for (const s of [['idle'], ['stopped'], ['done'], []] as (OrchestratorState | 'done')[][]) {
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      orch = s;
      expect(await write(engine())).toMatchObject({ ok: true });
    }
  });

  test('§11 D7 done and D9 running share one cwd → locked (the live one), whichever lane is viewed', async () => {
    lanes = [{ name: 'D7', state: 'done', cwd: dir }, { name: 'D9', state: 'running', cwd: dir }];
    const e = engine();
    expect(e.code.lockState('p').lanes.map((l) => l.name)).toEqual(['D7', 'D9']);
    await rejects(write(e)).toMatchObject({ code: 'lane_running', params: { lane: 'D9' } });
  });

  test('§10.2 (b) fs_write done → code_changed for the base source with the path', async () => {
    const e = engine();
    const h = codeHandlers(e, { channel: 'mac', watch: null, present: true, send: () => {} }, async () => {});
    await h.fs_write({ cmd: 'fs_write', projectId: 'p', src: { kind: 'base' }, path: 'a.txt', text: 'b\n', eol: 'lf', bom: false, baseHash: sha1('a\n') }, { channel: 'mac' });
    expect(events).toEqual([{ type: 'code_changed', projectId: 'p', src: { kind: 'base' }, paths: ['a.txt'] }]);
  });
});

describe('§11 open_in_vscode { projectId, src, path }', () => {
  test('§11 outside the root / missing file / .git → error, VS Code never spawned; inside → the absolute real path', async () => {
    const opened: string[] = [];
    const e = engine();
    const h = codeHandlers(e, { channel: 'mac', watch: null, present: true, send: () => {} }, async (p) => { opened.push(p); });
    const run = (path: string) => route(h as never, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd: 'open_in_vscode', projectId: 'p', src: { kind: 'base' }, path } });
    writeFileSync(join(tmp, 'secret.txt'), 's');
    for (const [path, code] of [['../secret.txt', 'forbidden'], [join(tmp, 'secret.txt'), 'forbidden'], ['nope.txt', 'gone'], ['.git/config', 'forbidden']] as const) {
      expect(await run(path)).toMatchObject({ type: 'error', code });
    }
    expect(opened).toEqual([]);
    expect(await run('a.txt')).toMatchObject({ type: 'ack' });
    expect(opened).toEqual([join(dir, 'a.txt')]);
  });
});

describe('§10.2 git_log / git_watch', () => {
  test('§10.2 Git tab hidden → git_log runs no git at all', async () => {
    const e = engine();
    const h = codeHandlers(e, { channel: 'mac', watch: null, present: true, send: () => {} }, async () => {});
    const r = await route(h as never, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd: 'git_log', projectId: 'p', refs: [], limit: 200 } });
    expect(r).toMatchObject({ type: 'error', code: 'git_hidden', key: 'errors.gitHidden' });
    expect(gitCalls).toEqual([]);
  });

  test('§10.2 git_watch sets the connection flag; WsHub.gitVisible needs a present Mac connection on that project', () => {
    const hub = new WsHub({ snapshot: () => ({}) as never, handlers: () => ({}) as never });
    const mac: Conn = { channel: 'mac', watch: null, present: false, send: () => {} };
    const remote: Conn = { channel: 'remote', watch: null, present: true, send: () => {} };
    hub.open(mac); hub.open(remote);
    const h = codeHandlers(engine(), mac, async () => {});
    void h.git_watch({ cmd: 'git_watch', projectId: 'p', on: true }, { channel: 'mac' });
    expect(mac.gitWatch).toBe('p');
    expect(hub.gitVisible('p')).toBe(false); // window hidden
    hub.setPresent(mac, true);
    expect(hub.gitVisible('p')).toBe(true);
    expect(hub.gitVisible('q')).toBe(false);
    remote.gitWatch = 'q';
    expect(hub.gitVisible('q')).toBe(false); // remote never counts
    void h.git_watch({ cmd: 'git_watch', projectId: 'p', on: false }, { channel: 'mac' });
    expect(hub.gitVisible('p')).toBe(false);
  });
});

describe('§8 code_changed is Mac only', () => {
  test('§8 WsHub delivers code_changed to Mac connections, never to remote ones', () => {
    const hub = new WsHub({ snapshot: () => ({}) as never, handlers: () => ({}) as never });
    const got: Record<string, ServerMsg[]> = { mac: [], remote: [] };
    for (const ch of ['mac', 'remote'] as const) hub.open({ channel: ch, watch: null, present: true, send: (m) => { got[ch]!.push(m); } });
    hub.broadcast({ type: 'code_changed', projectId: 'p', src: { kind: 'base' }, paths: ['a.txt'] });
    expect(got.mac!.filter((m) => m.type === 'event')).toHaveLength(1);
    expect(got.remote!.filter((m) => m.type === 'event')).toHaveLength(0);
  });
});

describe('§10.2 code_changed routing', () => {
  test('§10.2 a lane file tool → its lane source (root-relative) and the base when the file is under the project dir', () => {
    const wt = join(tmp, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, 'x.ts'), '');
    lanes = [{ name: 'D1', state: 'running', cwd: wt }, { name: 'D2', state: 'running', cwd: dir }];
    insertLane(db, { projectId: 'p', name: 'D1', cwd: wt });
    const e = engine();
    e.code.changed('p', wt, [join(wt, 'x.ts')]);
    expect(events).toEqual([{ type: 'code_changed', projectId: 'p', src: { kind: 'lane', laneId: 'D1' }, paths: ['x.ts'] }]);
    events = [];
    e.code.changed('p', dir, null); // (d) Bash in the project dir: base + D2 (same dir), not D1's worktree
    expect(events).toEqual([{ type: 'code_changed', projectId: 'p', src: { kind: 'base' } }, { type: 'code_changed', projectId: 'p', src: { kind: 'lane', laneId: 'D2' } }]);
    events = [];
    e.code.changed('p', wt, [join(tmp, 'elsewhere.ts')]); // outside every source: nothing
    expect(events).toEqual([]);
  });
});
