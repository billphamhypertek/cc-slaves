// v2.4 §6.4 / §6.5 / §6.6 / §10.2 the outbox with attachments: multi-block lines, `echoed`, copies kept / dropped, raw rows.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listUndelivered, openDb, type Db } from '../src/db.ts';
import { AttachStore, type SendAttachment } from '../src/attach/store.ts';
import { echoLine, Outbox, PREFIX, WriteLog, type Outgoing } from '../src/outbox.ts';
import { attachEnv, PNG, type AttachEnv } from './attach/_env.ts';

let env: AttachEnv;
let db: Db;
let store: AttachStore;
let ob: Outbox;
/** Outside every system temp dir (§6.4: an image from a temp dir gets no path line). */
let local: string;
beforeEach(() => {
  env = attachEnv();
  db = openDb(join(env.home, 'state.db'));
  store = new AttachStore({ referenced: () => ob.referencedCopies() });
  ob = new Outbox(db, store);
  mkdirSync(join(import.meta.dir, '.tmp'), { recursive: true });
  local = mkdtempSync(join(import.meta.dir, '.tmp', 'ob-'));
});
afterEach(() => {
  db.close();
  env.restore();
  rmSync(join(import.meta.dir, '.tmp'), { recursive: true, force: true });
});

/** A real PNG-headed payload, big enough that its base64 is unmistakable. */
const image = (seed: number) => Uint8Array.from([...PNG, ...Array.from({ length: 3000 }, (_, i) => (i * seed + 7) % 256)]);
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

async function attach(items: Parameters<AttachStore['take']>[0]): Promise<SendAttachment[]> {
  const t = await store.take(items);
  if (!t.ok) throw new Error(`take failed at ${t.index}`);
  return t.list;
}

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
async function render(o: Outgoing): Promise<{ line: Record<string, unknown>; blocks: Block[]; missing: string[] }> {
  const r = typeof o.line === 'string' ? { line: o.line, missing: [] } : await o.line;
  const line = JSON.parse(r.line) as Record<string, unknown>;
  return { line, blocks: (line.message as { content: Block[] }).content, missing: r.missing };
}

describe('outbox rows with attachments (v2.4 §10.2)', () => {
  test('§10.2 enqueue keeps attachments + echoed in state.db; a plain row has neither', async () => {
    const pasted = store.put('a.png', image(3));
    const list = await attach([{ up: pasted.id }]);
    const m = ob.enqueue('s1', 'xem', PREFIX.po, { attachments: list, echoed: true });
    ob.enqueue('s1', 'chữ', PREFIX.po);
    const rows = new Outbox(db).nextToSend('s1').length && listUndelivered(db, 's1');
    expect(rows && rows.map((r) => [r.uuid === m.uuid, r.attachments?.map((a) => a.up) ?? null, r.echoed])).toEqual([
      [true, [pasted.id], true],
      [false, null, false],
    ]);
  });

  test('§10.2 send passes its own uuid through', () => {
    const m = ob.enqueue('s1', 'x', PREFIX.po, { uuid: '11111111-2222-4333-8444-555555555555' });
    expect(m.uuid).toBe('11111111-2222-4333-8444-555555555555');
  });

  test('§6.4 one user line: text block (prefix, text, path list) then image blocks in chip order, bytes read from the copy', async () => {
    const finderSrc = join(local, 'loi-dang-nhap.png');
    writeFileSync(finderSrc, image(5));
    const finder = await store.fromPath(finderSrc);
    const pasted = store.put('ảnh-142233.png', image(9));
    const xlsx = join(local, 'doanh thu.xlsx');
    writeFileSync(xlsx, 'x');
    const note = store.put('ghi chú.md', new TextEncoder().encode('# hi'));
    if (!('id' in finder)) throw new Error('finder image not stored');
    const list = await attach([{ path: xlsx }, { up: note.id }, { up: finder.id }, { up: pasted.id }]);
    const m = ob.enqueue('s1', 'xem lỗi này', PREFIX.po, { attachments: list });
    const [o] = ob.nextToSend('s1');
    expect(o!.uuid).toBe(m.uuid);
    const r = await render(o!);
    expect(r.line).toMatchObject({ type: 'user', uuid: m.uuid });
    expect(r.missing).toEqual([]);
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'image', 'image']);
    expect(r.blocks[0]!.text).toBe([
      '[PO] xem lỗi này', '', 'File PO đính kèm (đường dẫn trên máy này):',
      `- ${list[0]!.path}`,
      `- ${note.file} (bản sao tạm, không phải file gốc)`,
      `- ${list[2]!.origPath} (ảnh, đã kèm trong tin này)`,
      `- ${list[2]!.path} (ảnh, bản sao tạm)`,
      `- ${list[3]!.path} (ảnh, bản sao tạm)`,
    ].join('\n'));
    expect(r.blocks[1]!.source).toEqual({ type: 'base64', media_type: 'image/png', data: b64(image(5)) });
    expect(r.blocks[2]!.source).toEqual({ type: 'base64', media_type: 'image/png', data: b64(image(9)) });
  });

  test('§6.4 an image from a system temp dir has no original path line, only its copy line (review IMPORTANT-1)', async () => {
    const tmpSrc = join(env.tmp, 'shot.png'); // env.tmp is under $TMPDIR (/var/folders/…)
    writeFileSync(tmpSrc, image(2));
    const fromTmp = await store.fromPath(tmpSrc);
    if (!('id' in fromTmp)) throw new Error('not stored');
    const list = await attach([{ up: fromTmp.id }]);
    ob.enqueue('s1', '', PREFIX.po, { attachments: list });
    const r = await render(ob.nextToSend('s1')[0]!);
    expect(r.blocks[0]).toEqual({ type: 'text', text: `[PO]\n\nFile PO đính kèm (đường dẫn trên máy này):\n- ${list[0]!.path} (ảnh, bản sao tạm)` });
    expect(r.blocks.length).toBe(2);
  });

  test('§6.4 an image whose Finder original is gone keeps its block but loses its original path line', async () => {
    const src = join(local, 'gone.png');
    writeFileSync(src, image(4));
    const s = await store.fromPath(src);
    if (!('id' in s)) throw new Error('not stored');
    const list = await attach([{ up: s.id }]);
    ob.enqueue('s1', 'x', PREFIX.po, { attachments: list });
    rmSync(src);
    const r = await render(ob.nextToSend('s1')[0]!);
    expect(r.blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(r.blocks[0]!.text).not.toContain(src);
    expect(r.blocks[0]!.text).toContain(`- ${list[0]!.path} (ảnh, bản sao tạm)`);
  });

  test('§6.3 A4 a file or a copy gone at write time is left out and named once; the message still goes', async () => {
    const f = join(local, 'b.txt');
    writeFileSync(f, 'b');
    const img = store.put('c.png', image(6));
    const keep = join(local, 'd.txt');
    writeFileSync(keep, 'd');
    ob.enqueue('s1', 'x', PREFIX.po, { attachments: await attach([{ path: f }, { up: img.id }, { path: keep }]) });
    rmSync(f);
    rmSync(join(env.attach, img.id), { recursive: true });
    const r = await render(ob.nextToSend('s1')[0]!);
    expect(r.missing).toEqual(['b.txt', 'c.png']);
    expect(r.blocks).toEqual([{ type: 'text', text: `[PO] x\n\nFile PO đính kèm (đường dẫn trên máy này):\n- ${keep}` }]);
  });

  test('§6.3 R13 missing attachments are reported once per message (one engine line), even when the row is rendered again', async () => {
    const f = join(local, 'gone.txt');
    writeFileSync(f, 'g');
    const m = ob.enqueue('s1', 'x', PREFIX.po, { attachments: await attach([{ path: f }]) });
    const seen: [string, string, string[]][] = [];
    ob.onAttachMissing((sid, uuid, names) => seen.push([sid, uuid, names]));
    rmSync(f);
    await render(ob.nextToSend('s1')[0]!);
    ob.resetWritten('s1');
    await render(ob.nextToSend('s1')[0]!);
    expect(seen).toEqual([['s1', m.uuid, ['gone.txt']]]);
  });

  test('§6.4 R11 a path with a newline is written as a JSON string in the path list, never as a raw newline', async () => {
    const odd = join(local, 'a\nb.txt');
    writeFileSync(odd, 'x');
    ob.enqueue('s1', 'x', PREFIX.po, { attachments: await attach([{ path: odd }]) });
    const text = (await render(ob.nextToSend('s1')[0]!)).blocks[0]!.text!;
    expect(text.split('\n').at(-1)).toBe(`- ${JSON.stringify(odd)}`);
  });

  test('§10.2 R3 echoLine: the po text has no "[PO] " (attachments only → empty), att labels from the metadata', async () => {
    const img = store.put('a.png', image(3));
    const row = ob.enqueue('s1', '', PREFIX.po, { attachments: await attach([{ up: img.id }]), echoed: true });
    expect(echoLine(row)).toEqual({ kind: 'po', text: '', att: [{ kind: 'image', name: 'a.png', copy: true }], parentToolUseId: null });
    expect(echoLine({ text: 'chào', prefix: PREFIX.po, attachments: null }).text).toBe('chào');
    expect(echoLine({ text: '/compact', prefix: PREFIX.raw, attachments: null }).text).toBe('/compact');
  });

  test('§10.2 a row sent again to a new process is rendered again, bytes and all', async () => {
    const img = store.put('c.png', image(8));
    ob.enqueue('s1', 'x', PREFIX.po, { attachments: await attach([{ up: img.id }]) });
    await render(ob.nextToSend('s1')[0]!);
    const again = ob.undeliveredAfterResume('s1', 'Tiếp tục');
    expect((await render(again[1]!)).blocks[1]!.source!.data).toBe(b64(image(8)));
  });

  test('§6.6 a raw row (prefix "") goes verbatim as a string and is flagged raw', () => {
    ob.enqueue('s1', '/compact', '');
    ob.enqueue('s1', 'chữ', PREFIX.po);
    const out = ob.nextToSend('s1');
    expect(out.map((o) => [o.raw, (JSON.parse(o.line as string) as { message: { content: unknown } }).message.content]))
      .toEqual([[true, '/compact'], [false, '[PO] chữ']]);
  });
});

describe('copies kept and dropped (v2.4 §6.5, D48)', () => {
  test('§6.5 review IMPORTANT-1 replay keeps image + file copies (issue_create files reads them); the session end drops both', async () => {
    const img = store.put('a.png', image(1));
    const doc = store.put('b.md', new TextEncoder().encode('b'));
    const m = ob.enqueue('s1', 'x', PREFIX.po, { attachments: await attach([{ up: img.id }, { up: doc.id }]) });
    ob.nextToSend('s1');
    expect(ob.onReplay('not-ours')).toBe(false);
    expect(ob.onReplay(m.uuid)).toBe(true);
    expect([existsSync(join(env.attach, img.id)), existsSync(join(env.attach, doc.id))]).toEqual([true, true]);
    ob.discardDelivered('s1');
    expect([existsSync(join(env.attach, img.id)), existsSync(join(env.attach, doc.id))]).toEqual([false, false]);
  });

  test('§10.2 referenced = ids in outbox rows: the 24 h sweep never drops a queued copy, an unreferenced old one goes', async () => {
    const queued = store.put('q.png', image(1));
    const loose = store.put('l.png', image(2));
    ob.enqueue('s1', 'x', PREFIX.po, { attachments: await attach([{ up: queued.id }]) });
    const old = (Date.now() - 25 * 3600_000) / 1000;
    for (const id of [queued.id, loose.id]) utimesSync(join(env.attach, id), old, old);
    const fresh = new AttachStore({ referenced: () => ob.referencedCopies() }); // engine restart: `taken` is empty
    expect(fresh.sweep()).toBe(1);
    expect(existsSync(join(env.attach, queued.id))).toBe(true);
    expect(existsSync(join(env.attach, loose.id))).toBe(false);
    expect(fresh.remove(queued.id)).toBe('attached');
  });

  test('§10.2 discard(ids) deletes those copies only; a malformed id is ignored', () => {
    const a = store.put('a.png', image(1));
    const b = store.put('b.png', image(2));
    store.discard([a.id, '../x']);
    expect(existsSync(join(env.attach, a.id))).toBe(false);
    expect(existsSync(join(env.attach, b.id))).toBe(true);
  });

  test('§10.2 ensureFirst (delete + re-insert) keeps attachments and echoed', async () => {
    const img = store.put('a.png', image(1));
    const m = ob.enqueue('s1', 'x', PREFIX.po, { attachments: await attach([{ up: img.id }]), echoed: true });
    ob.ensureFirst('s1', 'brief');
    const rows = listUndelivered(db, 's1');
    expect(rows.map((r) => r.text)).toEqual(['brief', 'x']);
    expect(rows[1]).toMatchObject({ uuid: m.uuid, echoed: true, attachments: [{ up: img.id, kind: 'image' }] });
    expect(ob.referencedCopies().has(img.id)).toBe(true);
  });
});

describe('WriteLog: when a raw row counts as delivered (v2.4 §6.6, §10.2)', () => {
  test('§6.6 raw written while idle → delivered at the next result (its own turn)', () => {
    const w = new WriteLog();
    w.wrote([{ uuid: 'r', raw: true }], false);
    expect(w.result()).toEqual(['r']);
  });

  test('§6.6 raw written mid-turn → not delivered at that turn\'s result, delivered at the next one', () => {
    const w = new WriteLog();
    w.wrote([{ uuid: 'a', raw: false }], false);
    w.replayed('a');
    w.wrote([{ uuid: 'r', raw: true }], true);
    expect(w.result()).toEqual([]);
    expect(w.result()).toEqual(['r']);
  });

  test('§10.2 raw behind an unreplayed row waits for the turn after that row\'s', () => {
    const w = new WriteLog();
    w.wrote([{ uuid: 'a', raw: false }], false);
    w.wrote([{ uuid: 'b', raw: false }, { uuid: 'r', raw: true }], true);
    w.replayed('a');
    expect(w.result()).toEqual([]); // a's turn
    w.replayed('b');
    expect(w.result()).toEqual([]); // b's turn
    expect(w.result()).toEqual(['r']);
  });

  test('§6.6 two raw rows in a row each get their own turn', () => {
    const w = new WriteLog();
    w.wrote([{ uuid: 'r1', raw: true }, { uuid: 'r2', raw: true }], false);
    expect(w.result()).toEqual(['r1']);
    expect(w.result()).toEqual(['r2']);
  });

  test('§6.6 a raw row that is replayed (a skill) leaves the log; still_queued rows leave it too', () => {
    const w = new WriteLog();
    w.wrote([{ uuid: 'r', raw: true }, { uuid: 'q', raw: true }], false);
    w.replayed('r');
    w.unqueued(['q']);
    expect(w.result()).toEqual([]);
  });
});
