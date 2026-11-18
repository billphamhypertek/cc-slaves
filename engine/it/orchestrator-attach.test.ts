// v2.4 G3d §10.2 / §6.5 the orchestrator's copy paths with fake-claude: a held image row + file row move to the receiving
// session (F21 "Phiên mới", "Kết thúc phiên" → the receiver, `forwardTo` after the end) with `attachments` + `echoed`;
// the receiving process gets the full §6.4 message; the `po` line is written into the receiving session once; a session
// end deletes the file copies of the messages delivered to it.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account } from '../src/accounts/registry.ts';
import { QuotaTracker } from '../src/accounts/quota.ts';
import { AttachStore, type SendAttachment } from '../src/attach/store.ts';
import type { Caps } from '../src/config.ts';
import { insertProject, openDb, type Db } from '../src/db.ts';
import { ModelCache } from '../src/models.ts';
import { Orchestrators, type OrchestratorDeps, type OrchestratorEvent, type OrchestratorState } from '../src/orchestrator/session.ts';
import type { Orchestrator } from '../src/orchestrator/session/orchestrator.ts';
import { Outbox, PREFIX } from '../src/outbox.ts';
import { CardStore } from '../src/cards/store.ts';
import { callTool, findTool } from '../src/mcp/tools.ts';
import { issuePorts } from '../test/_fixtures/issue-ports.ts';

setDefaultTimeout(30_000);
const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const O = 'o@x.test';
const CAPS: Caps = { default: { week: 98, five: 95 }, [O]: { role: 'orchestrator', week: 99, five: 97 } };
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ATTACH'] as const;
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

type Step = Record<string, unknown>;
const assistant: Step = { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text: '…' }] } } };
const result: Step = { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } };
const turn = (ms = 0): Step[] => [{ waitUser: true }, assistant, ...(ms ? [{ sleep: ms }] : []), result];
const turns = (n: number): Step[] => Array.from({ length: n }, () => turn()).flat();
/** first message, a slow turn (the model change waits on it), then the handoff turn and more. */
const SLOW_SECOND: Step[] = [...turn(), ...turn(900), ...turns(4)];
/** first message, a fast turn, a slow turn, then more. */
const SLOW_THIRD: Step[] = [...turn(), ...turn(), ...turn(900), ...turns(4)];

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 400 }, (_, i) => (i * 7 + 3) % 256)]);
const B64 = Buffer.from(PNG).toString('base64');

let tmp: string;
let db: Db;
let store: AttachStore;
let outbox: Outbox;
let spawns: { n: number; stdin: string }[];
let closers: (() => Promise<void>)[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-orch-att-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ATTACH = join(tmp, 'attach');
  db = openDb(join(tmp, 'state.db'));
  store = new AttachStore({ referenced: () => outbox.referencedCopies() });
  outbox = new Outbox(db, store);
  mkdirSync(join(tmp, 'p1'), { recursive: true });
  insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1'), orchestratorAccount: O });
  spawns = [];
  closers = [];
});
afterEach(async () => {
  for (const c of closers) await c();
  db.close();
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

function setup(steps: (n: number) => Step[]) {
  const account: Account = { email: O, id: null, configDir: join(tmp, 'cfg'), keychainService: 'k', planTier: 'max', terminal: false };
  const events: OrchestratorEvent[] = [];
  const tracker = new QuotaTracker({ db, source: { fetchUsage: () => Promise.reject(new Error('no network in tests')) }, onAccountChanged: () => {} });
  const env = () => {
    const n = spawns.length + 1;
    const file = join(tmp, `scn-${n}.json`);
    writeFileSync(file, JSON.stringify({ steps: steps(n) }));
    const stdin = join(tmp, `stdin-${n}.jsonl`);
    spawns.push({ n, stdin });
    return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_STDIN_LOG: stdin };
  };
  const od: OrchestratorDeps = {
    db, outbox, accounts: () => [account], quota: tracker, caps: () => CAPS, command: ['bun', FAKE], mcpPort: 1, env,
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 500 }, closeGraceMs: 300, handoffTimeoutMs: 5000, modelCache: new ModelCache(),
  };
  const orchs = new Orchestrators(od);
  orchs.on((e) => events.push(e));
  closers.push(() => orchs.shutdown());
  return { orchs, events };
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}
type Block = { type: string; text?: string; source?: { data: string } };
/** user lines one fake process read, content as blocks. */
const users = (n: number): Block[][] => {
  const f = spawns.find((s) => s.n === n)?.stdin;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: string | Block[] } })
    .flatMap((l) => (l.type !== 'user' ? [] : [typeof l.message!.content === 'string' ? [{ type: 'text', text: l.message!.content }] : l.message!.content]));
};
const reach = (o: Orchestrator, s: OrchestratorState) => until(() => o.view().state === s, `orchestrator ${s} (now ${o.view().state})`);
const poLines = (events: OrchestratorEvent[], sessionId: string) =>
  events.flatMap((e) => (e.type === 'po_line' && e.sessionId === sessionId ? [e.line] : []));
const copyExists = (id: string) => existsSync(join(tmp, 'attach', id));
const rowsOf = (sessionId: string) => db.query<{ attachments: string | null; echoed: number; delivered_at: number | null }, [string]>(
  'SELECT attachments, echoed, delivered_at FROM outbox WHERE session_id = ? AND attachments IS NOT NULL ORDER BY seq').all(sessionId);

async function attach(name: string, bytes: Uint8Array): Promise<{ list: SendAttachment[]; id: string }> {
  const s = store.put(name, bytes);
  const t = await store.take([{ up: s.id }]);
  if (!t.ok) throw new Error('take');
  return { list: t.list, id: s.id };
}

/** An image row + a file row, `echoed` (their `po` line was written at send time, §10.2). */
async function sendPair(o: Orchestrator, tag: string) {
  const img = await attach(`${tag}.png`, PNG);
  const file = await attach(`${tag}.txt`, new TextEncoder().encode('chữ'));
  await o.send(`ảnh ${tag}`, PREFIX.po, { attachments: img.list, echoed: true });
  await o.send(`file ${tag}`, PREFIX.po, { attachments: file.list, echoed: true });
  return { img, file };
}

/** The receiving process got both rows as the full §6.4 message: image block with the bytes, the file's path line. */
function expectFullMessages(n: number, tag: string, filePath: string): void {
  const got = users(n);
  const img = got.find((b) => b[0]?.text?.startsWith(`[PO] ảnh ${tag}\n\nFile PO đính kèm`));
  expect(img?.map((b) => b.type)).toEqual(['text', 'image']);
  expect(img![1]!.source!.data).toBe(B64);
  const file = got.find((b) => b[0]?.text?.startsWith(`[PO] file ${tag}\n\nFile PO đính kèm`));
  expect(file?.[0]?.text).toContain(`- ${filePath} (bản sao tạm, không phải file gốc)`);
}

describe('orchestrator copy paths carry attachments + echoed (v2.4 §10.2, G3d)', () => {
  test('§10.2 F21 while held → the image + file rows move with attachments + echoed; full §6.4 message; po line once in the new session', async () => {
    const { orchs, events } = setup((n) => (n === 1 ? SLOW_SECOND : turns(5)));
    const o = await orchs.start('p1');
    await reach(o, 'idle');
    await o.send('go');
    await reach(o, 'running');
    await o.setModel({ effort: 'low' }); // §5.3 pending: every row now held
    const old = o.currentSessionId;
    const { img, file } = await sendPair(o, 'f21');
    const r = await o.newSession(join(tmp, 'handoff.md'));
    expect(users(1).some((b) => b[0]?.text?.includes('f21'))).toBe(false); // held: never reached the old stdin
    expect(rowsOf(r.sessionId).map((x) => [JSON.parse(x.attachments!)[0].up, x.echoed])).toEqual([[img.id, 1], [file.id, 1]]);
    await reach(o, 'idle');
    await until(() => rowsOf(r.sessionId).every((x) => x.delivered_at !== null), 'moved rows delivered');
    expectFullMessages(2, 'f21', file.list[0]!.path);
    expect(poLines(events, r.sessionId)).toEqual([
      { kind: 'po', text: 'ảnh f21', att: [{ kind: 'image', name: 'f21.png', copy: true }], parentToolUseId: null },
      { kind: 'po', text: 'file f21', att: [{ kind: 'file', name: 'f21.txt', copy: true }], parentToolUseId: null },
    ]);
    expect(poLines(events, old)).toEqual([]);
    expect(copyExists(img.id)).toBe(true); // v2.7 §5.1 a delivered image copy lives until the session ends too
    expect(copyExists(file.id)).toBe(true); // the file copy lives until the receiving session ends
  });

  test('§10.2 / §6.5 "Kết thúc phiên" while held → rows go to the receiver with attachments + echoed; the ended one\'s delivered file copy goes', async () => {
    const { orchs, events } = setup((n) => (n === 1 ? SLOW_THIRD : turns(6)));
    const a = await orchs.start('p1');
    await reach(a, 'idle');
    const b = await orchs.open('p1', { first: 'hi' });
    await reach(b, 'idle');
    const done = await attach('xong.txt', new TextEncoder().encode('đã giao'));
    await a.send('file đã giao', PREFIX.po, { attachments: done.list, echoed: true });
    await until(() => rowsOf(a.currentSessionId).every((x) => x.delivered_at !== null), 'delivered to a');
    await a.send('go');
    await reach(a, 'running');
    await a.setModel({ effort: 'low' });
    const { img, file } = await sendPair(a, 'end');
    const aSid = a.currentSessionId;
    await orchs.end(aSid, b.currentSessionId);
    expect(copyExists(done.id)).toBe(false); // §6.5 a file copy delivered to the ended session goes with it
    expect(copyExists(file.id)).toBe(true); // undelivered: belongs to the moved row
    await until(() => rowsOf(b.currentSessionId).length === 2 && rowsOf(b.currentSessionId).every((x) => x.delivered_at !== null), 'moved rows delivered to b');
    expect(rowsOf(b.currentSessionId).map((x) => x.echoed)).toEqual([1, 1]);
    expectFullMessages(2, 'end', file.list[0]!.path);
    expect(poLines(events, b.currentSessionId).map((l) => l.text)).toEqual(['ảnh end', 'file end']);
    expect(poLines(events, aSid)).toEqual([]);
    expect(copyExists(img.id)).toBe(true); // delivered to b, which still runs
  });

  test('§10.2 forwardTo: a row sent to an ended session reaches the receiver with attachments + echoed and one po line there', async () => {
    const { orchs, events } = setup(() => turns(6));
    const a = await orchs.start('p1');
    await reach(a, 'idle');
    const b = await orchs.open('p1', { first: 'hi' });
    await reach(b, 'idle');
    const aSid = a.currentSessionId;
    await orchs.end(aSid, b.currentSessionId);
    const { img, file } = await sendPair(a, 'fw'); // a is ended: forwardTo
    await until(() => rowsOf(b.currentSessionId).length === 2 && rowsOf(b.currentSessionId).every((x) => x.delivered_at !== null), 'forwarded rows delivered');
    expect(rowsOf(aSid)).toEqual([]);
    expect(rowsOf(b.currentSessionId).map((x) => [JSON.parse(x.attachments!)[0].up, x.echoed])).toEqual([[img.id, 1], [file.id, 1]]);
    expectFullMessages(2, 'fw', file.list[0]!.path);
    expect(poLines(events, b.currentSessionId).map((l) => l.att)).toEqual([
      [{ kind: 'image', name: 'fw.png', copy: true }], [{ kind: 'file', name: 'fw.txt', copy: true }],
    ]);
    expect(poLines(events, aSid)).toEqual([]);
  });

  test('§10.2 a moved row that was not echoed (plain text) gets no engine po line: its replay shows it as before', async () => {
    const { orchs, events } = setup((n) => (n === 1 ? SLOW_SECOND : turns(5)));
    const o = await orchs.start('p1');
    await reach(o, 'idle');
    await o.send('go');
    await reach(o, 'running');
    await o.setModel({ effort: 'low' });
    await o.send('chữ thường', PREFIX.po);
    const r = await o.newSession(join(tmp, 'handoff.md'));
    await reach(o, 'idle');
    await until(() => users(2).some((b) => b[0]?.text === '[PO] chữ thường'), 'plain row on the new stdin');
    expect(events.some((e) => e.type === 'po_line')).toBe(false);
    expect(r.sessionId).toBe(o.currentSessionId);
  });

  test('v2.7 §5.1 review IMPORTANT-1 a PO image → its copy path on the user line → issue_create {files} → row + kept file → issue_get lists it', async () => {
    const { orchs } = setup(() => turns(4));
    const o = await orchs.start('p1');
    await reach(o, 'idle');
    const img = await attach('loi-nut.png', PNG);
    await o.send('nút Lưu lỗi, xem ảnh', PREFIX.po, { attachments: img.list, echoed: true });
    await until(() => rowsOf(o.currentSessionId).every((x) => x.delivered_at !== null), 'image row delivered (replayed)');
    const text = users(1).find((b) => b[0]?.text?.startsWith('[PO] nút Lưu lỗi'))![0]!.text!;
    const copy = /^- (.+) \(ảnh, bản sao tạm\)$/m.exec(text)?.[1];
    expect(copy).toBe(img.list[0]!.path);
    expect(copyExists(img.id)).toBe(true); // still there after delivery: the model can pass it
    const deps = {
      lanes: {} as never, usage: () => [], notify: () => {}, issues: issuePorts(db),
      cards: new CardStore({ db, sessions: { writeControl: () => true, askOpen: () => {}, askClose: () => {}, deliver: () => {} } }),
    };
    const who = { sessionId: o.currentSessionId, role: 'orchestrator' as const, projectId: 'p1', cwd: '/w', graph: false };
    const made = await callTool(deps, who, findTool('issue_create')!, { title: 'nút Lưu lỗi', kind: 'bug', spec: null, source: 'po', files: [copy] });
    expect(JSON.parse(made.content[0]!.text)).toMatchObject({ key: 'B-1', files: 1 });
    const row = db.query<{ name: string; path: string }, []>('SELECT name, path FROM issue_file').get()!;
    expect(row).toEqual({ name: 'loi-nut.png', path: join(tmp, 'home', 'issues', 'p1', 'B-1', '1-loi-nut.png') });
    expect(readFileSync(row.path)).toEqual(Buffer.from(PNG));
    const got = JSON.parse((await callTool(deps, who, findTool('issue_get')!, { key: 'B-1' })).content[0]!.text) as { files: unknown };
    expect(got.files).toEqual([{ name: 'loi-nut.png', path: row.path }]);
  });
});
