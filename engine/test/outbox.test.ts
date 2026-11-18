import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listUndelivered, openDb, type Db } from '../src/db.ts';
import { Outbox, PREFIX, cardAnswer, contentOf, type Outgoing } from '../src/outbox.ts';

let tmp: string;
let db: Db;
let ob: Outbox;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-outbox-'));
  db = openDb(join(tmp, 'state.db'));
  ob = new Outbox(db);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** The text of a plain row's stdin line (rows with attachments render async). */
const content = (o: Outgoing): unknown => (JSON.parse(o.line as string) as { message: { content: unknown } }).message.content;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('prefixes (§7.6)', () => {
  test('§7.6 prefix formatters', () => {
    expect(PREFIX.po).toBe('[PO]');
    expect(PREFIX.orchestrator).toBe('[Điều phối]');
    expect(PREFIX.engine).toBe('[cc-slaves]');
  });
  test('§7.6 card answer with and without a note', () => {
    expect(contentOf(cardAnswer(12, 'Phương án B', 'làm nhanh'))).toBe('[cc-slaves] PO trả lời #12: Phương án B — làm nhanh');
    expect(contentOf(cardAnswer(3, 'Có'))).toBe('[cc-slaves] PO trả lời #3: Có');
    expect(contentOf(cardAnswer(3, 'Có', '  '))).toBe('[cc-slaves] PO trả lời #3: Có');
  });
  test('§7.6 content without a prefix is the bare text', () => {
    expect(contentOf({ prefix: null, text: 'hi' })).toBe('hi');
  });
});

describe('Outbox (§7.6)', () => {
  test('§7.6 enqueue persists first with a uuid v4', () => {
    const m = ob.enqueue('s1', 'xin chào', PREFIX.po);
    expect(m.uuid).toMatch(UUID_V4);
    expect(listUndelivered(db, 's1').map((x) => x.uuid)).toEqual([m.uuid]);
    // a fresh Outbox over the same db (engine restart) still sees it
    expect(new Outbox(db).nextToSend('s1').map((x) => x.uuid)).toEqual([m.uuid]);
  });

  test('§7.6 nextToSend is ordered, per session, and composes the prefix', () => {
    const a = ob.enqueue('s1', 'one', PREFIX.po);
    ob.enqueue('s2', 'other', null);
    const b = ob.enqueue('s1', 'two', PREFIX.orchestrator);
    const out = ob.nextToSend('s1');
    expect(out.map((x) => x.uuid)).toEqual([a.uuid, b.uuid]);
    expect(out.map(content)).toEqual(['[PO] one', '[Điều phối] two']);
    expect(JSON.parse(out[0]!.line as string)).toMatchObject({ type: 'user', uuid: a.uuid, message: { content: '[PO] one' } });
  });

  test('§7.6 no duplicate: a message written once is not returned again before replay', () => {
    ob.enqueue('s1', 'one', null);
    expect(ob.nextToSend('s1').length).toBe(1);
    expect(ob.nextToSend('s1')).toEqual([]);
  });

  test('§7.6 enqueue → replay → delivered', () => {
    const m = ob.enqueue('s1', 'one', null);
    ob.nextToSend('s1');
    expect(ob.onReplay(m.uuid)).toBe(true);
    expect(listUndelivered(db, 's1')).toEqual([]);
    expect(ob.onReplay(m.uuid)).toBe(true); // idempotent
    expect(ob.onReplay('not-ours')).toBe(false);
  });

  test('§3.3-17 §7.6 mid-turn message is delivered only on its replay, not on write', () => {
    const first = ob.enqueue('s1', 'brief', null);
    ob.nextToSend('s1');
    ob.onReplay(first.uuid);
    const mid = ob.enqueue('s1', 'thêm yêu cầu', PREFIX.po);
    ob.nextToSend('s1'); // written mid-turn
    expect(listUndelivered(db, 's1').map((x) => x.uuid)).toEqual([mid.uuid]);
    ob.onReplay(mid.uuid);
    expect(listUndelivered(db, 's1')).toEqual([]);
  });

  test('§3.3-14 §7.6 still_queued after interrupt stays undelivered and is sent again', () => {
    const a = ob.enqueue('s1', 'a', null);
    const b = ob.enqueue('s1', 'b', null);
    ob.nextToSend('s1');
    ob.onReplay(a.uuid);
    ob.onStillQueued([b.uuid]);
    expect(listUndelivered(db, 's1').map((x) => x.uuid)).toEqual([b.uuid]);
    expect(ob.nextToSend('s1').map((x) => x.uuid)).toEqual([b.uuid]);
  });

  test('§7.6 after resume: resume message first, then undelivered in order, delivered ones excluded', () => {
    const a = ob.enqueue('s1', 'a', null);
    const b = ob.enqueue('s1', 'b', PREFIX.po);
    const c = ob.enqueue('s1', 'c', PREFIX.orchestrator);
    ob.nextToSend('s1');
    ob.onReplay(a.uuid);
    // process killed here; b and c were written but never replayed
    const batch = ob.undeliveredAfterResume('s1', 'You were interrupted…');
    expect(batch.map(content)).toEqual(['[cc-slaves] You were interrupted…', '[PO] b', '[Điều phối] c']);
    expect(batch[0]!.uuid).toMatch(UUID_V4);
    expect(batch.slice(1).map((x) => x.uuid)).toEqual([b.uuid, c.uuid]);
    expect(ob.nextToSend('s1')).toEqual([]); // the batch counts as written: no dup
  });

  test('§7.6 resume twice before any replay: one resume message per batch, no duplicated outbox rows', () => {
    const b = ob.enqueue('s1', 'b', null);
    const first = ob.undeliveredAfterResume('s1', 'resume');
    const second = ob.undeliveredAfterResume('s1', 'resume');
    expect(second.length).toBe(2);
    expect(second[1]!.uuid).toBe(b.uuid);
    expect(second[0]!.uuid).not.toBe(first[0]!.uuid);
    expect(listUndelivered(db, 's1').map((x) => x.uuid)).toEqual([b.uuid]);
    expect(ob.onReplay(second[0]!.uuid)).toBe(true); // the resume message is ours too
  });
});

describe('fresh re-run helpers (g2-review IMPORTANT-2/3)', () => {
  test('IMPORTANT-3 resetWritten: rows written to a dead process go out again on the next fresh start', () => {
    const a = ob.enqueue('s1', 'brief', null);
    expect(ob.nextToSend('s1').map((x) => x.uuid)).toEqual([a.uuid]); // written, never replayed
    expect(ob.nextToSend('s1')).toEqual([]);
    ob.resetWritten('s1');
    expect(ob.nextToSend('s1').map((x) => x.uuid)).toEqual([a.uuid]);
  });

  test('IMPORTANT-2 ensureFirst: the brief is re-queued before a pending message', () => {
    const brief = ob.enqueue('s1', 'brief', null);
    ob.onReplay(brief.uuid); // delivered to a conversation that is gone
    const po = ob.enqueue('s1', 'tin PO', PREFIX.po);
    ob.ensureFirst('s1', 'brief');
    const rows = listUndelivered(db, 's1');
    expect(rows.map((x) => contentOf(x))).toEqual(['brief', '[PO] tin PO']);
    expect(rows[1]!.uuid).toBe(po.uuid);
  });

  test('IMPORTANT-2 ensureFirst: an undelivered copy is moved to the front, never duplicated; already first → untouched', () => {
    const po = ob.enqueue('s1', 'tin PO', PREFIX.po);
    const brief = ob.enqueue('s1', 'brief', null);
    ob.ensureFirst('s1', 'brief');
    expect(listUndelivered(db, 's1').map((x) => x.uuid)).toEqual([brief.uuid, po.uuid]);
    const before = listUndelivered(db, 's1').map((x) => x.seq);
    ob.ensureFirst('s1', 'brief');
    expect(listUndelivered(db, 's1').map((x) => x.seq)).toEqual(before);
  });
});


describe('v2.6 §4.8 / §10.3 held PO lines: the label goes when the row is written', () => {
  const T = { kind: 'orchestrator', projectId: 'p' } as const;
  const L = { kind: 'lane', projectId: 'p', name: 'api' } as const;
  const listen = () => {
    const calls: [unknown, number[]][] = [];
    ob.onPoWritten((t, seqs) => calls.push([t, seqs]));
    return calls;
  };

  test('written once → one call with its target and seq; written again (new process) → no second call', () => {
    const calls = listen();
    const m = ob.enqueue('s1', 'giữ tin', PREFIX.po, { echoed: true });
    ob.heldLine(m.uuid, T, 41);
    ob.enqueue('s1', 'không giữ', PREFIX.po);
    expect(ob.nextToSend('s1').length).toBe(2);
    expect(calls).toEqual([[T, [41]]]);
    ob.resetWritten('s1');
    ob.nextToSend('s1');
    expect(calls.length).toBe(1);
  });

  test('a row never marked held → no call', () => {
    const calls = listen();
    ob.enqueue('s1', 'x', PREFIX.po);
    ob.nextToSend('s1');
    expect(calls).toEqual([]);
  });

  test('the first batch after a resume carries the held rows too; one call per target', () => {
    const calls = listen();
    const a = ob.enqueue('s1', 'a', PREFIX.po, { echoed: true });
    const b = ob.enqueue('s1', 'b', PREFIX.po, { echoed: true });
    const c = ob.enqueue('s1', 'c', PREFIX.po, { echoed: true });
    ob.heldLine(a.uuid, T, 1);
    ob.heldLine(b.uuid, L, 2);
    ob.heldLine(c.uuid, T, 3);
    expect(ob.undeliveredAfterResume('s1', 'nối lại').length).toBe(4);
    expect(calls).toEqual([[T, [1, 3]], [L, [2]]]);
  });

  test('a held row of another session stays held', () => {
    const calls = listen();
    const m = ob.enqueue('s2', 'x', PREFIX.po, { echoed: true });
    ob.heldLine(m.uuid, T, 5);
    ob.enqueue('s1', 'y', PREFIX.po);
    ob.nextToSend('s1');
    expect(calls).toEqual([]);
    ob.nextToSend('s2');
    expect(calls).toEqual([[T, [5]]]);
  });
});
