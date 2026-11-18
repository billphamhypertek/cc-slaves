// v2.4 G3c §10.2 the `send` handler end to end (engine + fake-claude): checks (§6.2 limits, A9 blocked roots, one use per
// `up`, §8 remote), `raw` (§6.6), the `po` line written at send for rows with attachments / held / raw and the replay of
// an `echoed` row dropped, the lane path carrying attachments, the §6.3 `engine` line for a missing file, lane Done → the
// file copies delivered to it go (§6.5, R13). Temp homes only; never the real ~, Keychain or any API.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, StreamLine } from '../../shared/protocol.ts';
import { openDb, upsertQuota } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { paths } from '../src/paths.ts';
import { buildHandlers } from '../src/server/commands.ts';
import type { CommandCtx } from '../src/server/router.ts';
import type { Conn } from '../src/server/ws.ts';
import { seedAccounts } from './seed-accounts.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CC_SLAVES_ATTACH', 'CLAUDE_HOME', 'CLAUDE_JSON'] as const;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 300 }, (_, i) => (i * 5 + 1) % 256)]);

type Step = Record<string, unknown>;
const assistant: Step = { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: 'ok' }] } } };
const result: Step = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } };
const turn = (ms = 0): Step[] => [{ waitUser: true }, assistant, ...(ms ? [{ sleep: ms }] : []), result];
const turns = (n: number): Step[] => Array.from({ length: n }, () => turn()).flat();

let tmp: string;
let saved: Record<string, string | undefined>;
let engine: Engine;
let projectId: string;
let wt: string;
const spawns: string[] = [];
/** Scenario of the next spawns, in order; then the default. */
const queue: object[] = [];
const MAC: CommandCtx = { channel: 'mac' };
let h: ReturnType<typeof buildHandlers>;
const send = (c: Omit<Extract<Command, { cmd: 'send' }>, 'cmd'>, ctx: CommandCtx = MAC) => h.send({ cmd: 'send', ...c }, ctx);

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}
async function err(p: unknown): Promise<{ code: string; params?: Record<string, unknown> }> {
  try { await p; } catch (e) { return e as { code: string; params?: Record<string, unknown> }; }
  throw new Error('expected a rejection');
}
type Block = { type: string; text?: string };
/** User lines one process got on stdin: content as blocks. */
function users(n: number): Block[][] {
  const f = spawns[n - 1];
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: unknown } })
    .filter((l) => l.type === 'user').map((l) => (typeof l.message?.content === 'string' ? [{ type: 'text', text: l.message.content }] : l.message?.content as Block[]));
}
const hist = (sid: string): StreamLine[] => engine.lines.page([sid], undefined, 500);
const orchSid = () => engine.orchestrators.get(projectId)!.currentSessionId;
const laneSid = (name: string) => engine.lanes.get(projectId, name)!.sessionId;
const file = (name: string, body = 'x'): string => { const p = join(tmp, 'files', name); writeFileSync(p, body); return p; };

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-send-')));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ACCOUNTS = join(tmp, 'accts');
  process.env.CC_SLAVES_ATTACH = join(tmp, 'attach');
  process.env.CLAUDE_HOME = join(tmp, 'claude');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  mkdirSync(join(tmp, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'files'), { recursive: true });
  const projectDir = join(tmp, 'shop');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  wt = join(tmp, 'wt');
  mkdirSync(wt, { recursive: true });
  const db = openDb(paths().stateDb);
  seedAccounts([O], { db });
  const now = Math.floor(Date.now() / 1000);
  upsertQuota(db, { account: O, fivePct: 10, weekPct: 10, fiveResetsAt: now + 3600, weekResetsAt: now + 86_400, source: 'api', fetchedAt: now, status: 'ok' });
  db.close();
  engine = await Engine.start({
    gh: null, version: 'test', port: 0, token: 't', staticDir: join(tmp, 'web'), command: ['bun', FAKE],
    loginEnv: { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, claudePath: null, shellFailed: false, reason: null },
    extraEnv: () => {
      const n = spawns.length + 1;
      const f = join(tmp, `scn-${n}.json`);
      writeFileSync(f, JSON.stringify(queue.shift() ?? { steps: turns(20) }));
      const log = join(tmp, `stdin-${n}.log`);
      spawns.push(log);
      return { FAKE_CLAUDE_SCENARIO: f, FAKE_CLAUDE_STDIN_LOG: log };
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
  projectId = ((await h.project_add({ cmd: 'project_add', name: 'Shop', path: projectDir }, MAC)) as { id: string }).id;
  await h.project_resume({ cmd: 'project_resume', id: projectId }, MAC); // hf1116 H2
  await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'orchestrator idle');
});

afterAll(async () => {
  await engine?.stop();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('v2.4 §10.2 send checks', () => {
  const target = () => ({ kind: 'orchestrator' as const, projectId });
  test('§8 a remote send with `attachments` → forbidden_remote (even empty); remote text still goes', async () => {
    expect((await err(send({ target: target(), text: 'x', attachments: [] }, { channel: 'remote' }))).code).toBe('forbidden_remote');
    await send({ target: target(), text: 'từ xa' }, { channel: 'remote' });
  });
  test('§10.2 A9 a `path` in a blocked root, a relative path, a dir → bad_input naming the index; nothing taken', async () => {
    const ok = file('ok.txt');
    writeFileSync(join(paths().home, 'secret.txt'), 's');
    const up = engine.attach.put('a.png', PNG);
    for (const [bad, i] of [[join(paths().home, 'secret.txt'), 1], ['files/ok.txt', 1], [join(tmp, 'files'), 1], [join(tmp, 'nope.txt'), 1]] as const) {
      const e = await err(send({ target: target(), text: 'x', attachments: [{ up: up.id }, { path: bad }] }));
      expect([e.code, e.params?.index]).toEqual(['bad_input', i]);
    }
    expect(engine.attach.remove(up.id)).toBe('ok'); // all or nothing: the copy was never taken
    void ok;
  });
  test('§10.2 an `up` used twice → bad_input; > 20 items → bad_input; empty text with no attachment → bad_input', async () => {
    const up = engine.attach.put('b.png', PNG);
    expect((await err(send({ target: target(), text: '', attachments: [{ up: up.id }, { up: up.id }] }))).params?.index).toBe(1);
    const many = Array.from({ length: 21 }, () => ({ path: file('m.txt') }));
    expect((await err(send({ target: target(), text: 'x', attachments: many }))).code).toBe('bad_input');
    expect((await err(send({ target: target(), text: ' ' }))).code).toBe('bad_input');
    expect((await err(send({ target: target(), text: 'x', attachments: 'no' as never }))).code).toBe('bad_input');
  });
  test('§10.2 a send with an `up` to a lane or session that does not exist → no_lane / no_session; the copy is not taken', async () => {
    const up = engine.attach.put('c.png', PNG);
    expect((await err(send({ target: { kind: 'lane', projectId, name: 'KHÔNG' }, text: 'x', attachments: [{ up: up.id }] }))).code).toBe('no_lane');
    expect((await err(send({ target: { kind: 'orchestrator', projectId, sessionId: 'nope' }, text: 'x', attachments: [{ up: up.id }] }))).code).toBe('no_session');
    expect(engine.attach.remove(up.id)).toBe('ok');
  });
  test('§6.6 raw: /model, /effort, /clear, /logout, not a `/` text, or with attachments → bad_input, from Mac, to a lane and remote', async () => {
    const lane = { kind: 'lane' as const, projectId, name: 'ZZ' };
    for (const text of ['/model sonnet', '/effort high', '/CLEAR', '/logout', 'xin chào']) {
      for (const [t, ctx] of [[target(), MAC], [lane, MAC], [target(), { channel: 'remote' }]] as const) {
        expect((await err(send({ target: t, text, raw: true }, ctx))).code).toBe('bad_input');
      }
    }
    expect((await err(send({ target: target(), text: '/compact', raw: true, attachments: [{ path: file('r.txt') }] }))).code).toBe('bad_input');
    expect((await err(send({ target: target(), text: '/compact', raw: 1 as never }))).code).toBe('bad_input');
  });
});

describe('v2.4 §10.2 po line at send, echoed replay dropped', () => {
  test('§6.3 orchestrator: image + file → one po line at send (no "[PO] ", att labels); stdin has the §6.4 message; the replay adds no line', async () => {
    const before = users(1).length;
    const img = engine.attach.put('chụp.png', PNG);
    const doc = file('doanh thu.xlsx');
    await send({ target: { kind: 'orchestrator', projectId }, text: 'xem giúp', attachments: [{ up: img.id }, { path: doc }] });
    const po = () => hist(orchSid()).filter((l) => l.kind === 'po' && l.text === 'xem giúp');
    expect(po().map((l) => l.att)).toEqual([[{ kind: 'image', name: 'chụp.png', copy: true }, { kind: 'file', name: 'doanh thu.xlsx' }]]);
    await until(() => users(1).length > before && engine.orchestrators.get(projectId)?.view().state === 'idle', 'turn done');
    const got = users(1).at(-1)!;
    expect(got[0]!.text).toBe(`[PO] xem giúp\n\nFile PO đính kèm (đường dẫn trên máy này):\n- ${join(paths().attachRoot, img.id, 'chụp.png')} (ảnh, bản sao tạm)\n- ${doc}`);
    expect(got.map((b) => b.type)).toEqual(['text', 'image']);
    expect(po()).toHaveLength(1);
    expect(existsSync(join(paths().attachRoot, img.id))).toBe(true); // v2.7 §5.1 kept until the session ends (issue_create files)
  });
  test('§6.6 raw /compact → stdin is exactly "/compact"; one po line "/compact" at send; its <command-name> replay adds none', async () => {
    await send({ target: { kind: 'orchestrator', projectId }, text: '/compact', raw: true });
    expect(hist(orchSid()).filter((l) => l.kind === 'po').at(-1)?.text).toBe('/compact');
    await until(() => users(1).some((b) => b[0]?.text === '/compact'), 'raw on stdin');
    await Bun.sleep(300);
    expect(hist(orchSid()).filter((l) => l.kind === 'po' && /compact/.test(l.text))).toHaveLength(1);
    expect(hist(orchSid()).some((l) => l.kind === 'po' && l.text.includes('<command-name>'))).toBe(false);
  });
  test('§6.3 R3 a plain text send is still shown at replay, without "[PO] "', async () => {
    await send({ target: { kind: 'orchestrator', projectId }, text: 'chữ thường' });
    await until(() => hist(orchSid()).some((l) => l.kind === 'po' && l.text === 'chữ thường'), 'plain echo');
    expect(hist(orchSid()).some((l) => l.text === '[PO] chữ thường')).toBe(false);
  });
});

describe('v2.4 §10.2 lane path', () => {
  test('§10.2 lane: attachments reach the lane stdin; po line at send with inTurn mid-turn; raw mid-turn goes bare, no inTurn; Done drops the file copies (R13)', async () => {
    queue.push({ steps: [...turn(), ...turn(1200), ...turns(6)] });
    await engine.lanes.start({ projectId, name: 'D1', cwd: wt, briefPath: '/b/D1.md' });
    const n = spawns.length;
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'idle', 'D1 idle');
    const target = { kind: 'lane' as const, projectId, name: 'D1' };
    await send({ target, text: 'việc một' });
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'running', 'D1 running');
    const copy = engine.attach.put('ghi chú.md', new TextEncoder().encode('# x'));
    await send({ target, text: 'kèm file', attachments: [{ up: copy.id }] });
    const po = (t: string) => hist(laneSid('D1')).filter((l) => l.kind === 'po' && l.text === t);
    expect(po('kèm file').map((l) => [l.inTurn, l.att])).toEqual([[true, [{ kind: 'file', name: 'ghi chú.md', copy: true }]]]);
    await until(() => users(n).some((b) => b[0]?.text?.startsWith('[PO] kèm file\n\nFile PO đính kèm')), 'lane got the file line');
    expect(users(n).find((b) => b[0]?.text?.startsWith('[PO] kèm file'))![0]!.text).toContain(`${copy.file} (bản sao tạm, không phải file gốc)`);
    expect(engine.lanes.get(projectId, 'D1')?.state).toBe('running');
    await send({ target, text: '/compact', raw: true }); // §6.6 a `/` message sent mid-turn is not marked as sent into the running turn
    expect(po('/compact').map((l) => l.inTurn)).toEqual([undefined]);
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'idle', 'D1 idle again');
    await until(() => users(n).some((b) => b[0]?.text === '/compact'), 'lane raw on stdin');
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'idle', 'D1 idle after raw');
    expect(po('kèm file')).toHaveLength(1);
    expect(po('/compact')).toHaveLength(1);
    expect(existsSync(copy.file)).toBe(true); // a file copy stays while the lane lives
    await h.lane_finish({ cmd: 'lane_finish', projectId, name: 'D1' }, MAC);
    await until(() => engine.lanes.get(projectId, 'D1')?.state === 'done', 'D1 done');
    expect(existsSync(copy.file)).toBe(false);
  });
  test('§6.3 A4 a file gone before the stopped lane runs again → the message goes without it + one engine line', async () => {
    queue.push({ steps: turns(6) }, { steps: turns(6) });
    mkdirSync(join(tmp, 'wt2'), { recursive: true });
    await engine.lanes.start({ projectId, name: 'D2', cwd: join(tmp, 'wt2'), briefPath: '/b/D2.md' });
    await until(() => engine.lanes.get(projectId, 'D2')?.state === 'idle', 'D2 idle');
    await h.lane_stop({ cmd: 'lane_stop', projectId, name: 'D2', mode: 'now' }, MAC);
    await until(() => engine.lanes.get(projectId, 'D2')?.state === 'stopped', 'D2 stopped');
    const gone = file('mất.txt');
    const keep = file('còn.txt');
    await send({ target: { kind: 'lane', projectId, name: 'D2' }, text: 'hai file', attachments: [{ path: gone }, { path: keep }] });
    rmSync(gone);
    const n = spawns.length + 1;
    await h.lane_resume({ cmd: 'lane_resume', projectId, name: 'D2' }, MAC);
    await until(() => users(n).some((b) => b[0]?.text?.startsWith('[PO] hai file')), 'resumed lane got the message');
    expect(users(n).find((b) => b[0]?.text?.startsWith('[PO] hai file'))![0]!.text).toBe(`[PO] hai file\n\nFile PO đính kèm (đường dẫn trên máy này):\n- ${keep}`);
    const eng = () => hist(laneSid('D2')).filter((l) => l.kind === 'engine' && l.text.includes('mất.txt'));
    await until(() => eng().length > 0, 'engine line');
    expect(eng().map((l) => l.text)).toEqual(['Không gửi được mất.txt: file không còn trên máy.']);
  });
});

describe('v2.4 §10.2 send reads its destination after the R4 take wait', () => {
  /** A fresh orchestrator session: its startup turn, then `steps`; idle, with its first line shown. */
  async function open(steps: Step[]): Promise<string> {
    await until(() => engine.orchestrators.get(projectId)?.view().state === 'idle', 'idle');
    queue.push({ steps: [...turn(), ...steps] });
    const sid = (await h.session_open({ cmd: 'session_open', projectId }, MAC) as { sessionId: string }).sessionId;
    await until(() => hist(sid).length > 0 && st(sid) === 'idle', 'session up');
    return sid;
  }
  /** `take` that waits `ms` first (the PO answering a TCC prompt), for the length of `run`. */
  async function slowTake<T>(ms: number, run: () => Promise<T>): Promise<T> {
    const real = engine.attach.take.bind(engine.attach);
    engine.attach.take = async (i) => { await Bun.sleep(ms); return real(i); };
    try { return await run(); } finally { engine.attach.take = real; }
  }
  const st = (sid: string) => engine.orchestrators.bySession(sid)?.view().state;
  const poCount = (sid: string, text: string) => hist(sid).filter((l) => l.kind === 'po' && l.text === text).length;

  test('§5.3 / §10.2 a send held by a pending model change → one po line at send with afterModelChange; replay adds none', async () => {
    const sid = await open([...turn(2500), ...turns(6)]);
    const target = { kind: 'orchestrator' as const, projectId, sessionId: sid };
    await send({ target, text: 'chạy lâu' });
    await until(() => st(sid) === 'running', 'running');
    expect(await h.session_set_model({ cmd: 'session_set_model', sessionId: sid, model: 'sonnet' }, MAC)).toEqual({ applied: 'pending' });
    await send({ target, text: 'sau đổi model' });
    const po = () => hist(sid).filter((l) => l.kind === 'po' && l.text === 'sau đổi model');
    expect(po().map((l) => ({ a: l.afterModelChange, i: l.inTurn }))).toEqual([{ a: true, i: undefined }]);
    const n = spawns.length;
    expect(users(n).some((b) => b[0]?.text === '[PO] sau đổi model')).toBe(false); // held off stdin
    await until(() => users(n).some((b) => b[0]?.text === '[PO] sau đổi model'), 'released');
    await until(() => st(sid) === 'idle', 'idle');
    await Bun.sleep(300);
    expect(po()).toHaveLength(1);
  });
  test('§10.2 R4 a send whose take waits (TCC prompt) while its session ends → exactly one po line across both sessions', async () => {
    const s1 = orchSid();
    const s3 = await open(turns(6));
    const img = engine.attach.put('tcc.png', PNG);
    await slowTake(1500, async () => {
      const sending = send({ target: { kind: 'orchestrator', projectId, sessionId: s3 }, text: 'chờ tcc', attachments: [{ up: img.id }] });
      await Bun.sleep(100);
      await h.session_end({ cmd: 'session_end', sessionId: s3 }, MAC);
      await sending;
    });
    await Bun.sleep(1500);
    expect([poCount(s1, 'chờ tcc'), poCount(s3, 'chờ tcc')]).toEqual([1, 0]);
  });
  test('§6.3 R4 a send whose take waits past the end of the running turn is not marked inTurn', async () => {
    const sid = await open([...turn(1500), ...turns(6)]);
    const target = { kind: 'orchestrator' as const, projectId, sessionId: sid };
    await send({ target, text: 'lượt dài' });
    await until(() => st(sid) === 'running', 'running');
    const img = engine.attach.put('sau.png', PNG);
    await slowTake(2500, async () => { await send({ target, text: 'sau lượt', attachments: [{ up: img.id }] }); });
    expect(hist(sid).filter((l) => l.kind === 'po' && l.text === 'sau lượt').map((l) => l.inTurn)).toEqual([undefined]);
  });
});
