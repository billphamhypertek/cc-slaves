// Outbox (spec §7.6, I6, M5): every message to a session is persisted before it is written to stdin, and only
// counts as delivered when `--replay-user-messages` echoes its `uuid` back (§3.3-17). v2.4 §10.2: a row may carry
// attachments (metadata only); its stdin line is built when it is written (§6.4) and its copies go when the session ends (§6.5;
// v2.7 §5.1 kept past delivery so `issue_create {files}` can take one).
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AttachStore, SendAttachment } from './attach/store.ts';
import { getOutbox, insertOutbox, listUndelivered, markDelivered, outboxAttachments, type Db, type OutboxMsg } from './db.ts';
import { userLine, type Block } from './stream/writer.ts';
import type { StreamLine, Target } from '../../shared/protocol.ts';

export const PREFIX = {
  po: '[PO]',
  orchestrator: '[Điều phối]',
  engine: '[cc-slaves]',
  /** v2.4 §6.6 a `/` command Claude Code must run itself: no prefix at all (a null prefix is a lane brief). */
  raw: '',
} as const;

export interface Draft { prefix: string | null; text: string }
/** §6.3 A4 a message written without these attachments (names, chip order). */
export type MissingListener = (sessionId: string, uuid: string, names: string[]) => void;
/** v2.6 §10.3 these `held` PO lines (seqs, one target) were just written to Claude Code. */
export type PoWrittenListener = (target: Target, seqs: number[]) => void;
/** v2.4 §10.2 what `send` passes besides text + prefix: its own `uuid`, the attachments' metadata, `echoed`. */
export interface SendExtra { uuid?: string; attachments?: readonly SendAttachment[]; echoed?: boolean }
/** v2.4 §10.2 an undelivered row moving to another session (new uuid): every copy / move path keeps these. */
export type Moved = Pick<OutboxMsg, 'text' | 'prefix' | 'attachments' | 'echoed'>;

/** Card answer: `[cc-slaves] PO trả lời #12: <phương án> — <ghi chú>` (note omitted when blank). */
export function cardAnswer(card: number, option: string, note?: string): Draft {
  const n = note?.trim();
  return { prefix: PREFIX.engine, text: `PO trả lời #${card}: ${option}${n ? ` — ${n}` : ''}` };
}

/** §6.4 a message with attachments and no text is the bare prefix. */
export const contentOf = (d: Draft): string => (d.prefix ? (d.text ? `${d.prefix} ${d.text}` : d.prefix) : d.text);

/** R3 a `po` line's text as the conversation shows it: without the "[PO] " Claude Code gets. */
export const poText = (content: string): string =>
  content === PREFIX.po ? '' : content.startsWith(`${PREFIX.po} `) ? content.slice(PREFIX.po.length + 1) : content;

/** v2.4 §10.2 the `po` conversation line of an `echoed` row: text as `markInTurn` compares it, `att` from the metadata. */
export type EchoLine = Pick<StreamLine, 'kind' | 'text' | 'att' | 'parentToolUseId'>;
export const echoLine = (m: Pick<OutboxMsg, 'text' | 'prefix' | 'attachments'>): EchoLine => ({
  kind: 'po', text: poText(contentOf(m)),
  ...(m.attachments?.length ? { att: m.attachments.map((a) => ({ kind: a.kind, name: a.name, ...(a.copy ? { copy: true } : {}) })) } : {}),
  parentToolUseId: null,
});

/** A stdin line built at write time (§6.4); `missing` = attachments gone from the Mac by then (§6.3 A4). */
interface Rendered { line: string; missing: string[] }
/** A message ready to write: `line` is the stdin JSON line, or its async build when the row has attachments. */
export interface Outgoing { uuid: string; raw: boolean; line: string | Promise<Rendered> }

/** §6.4 system temp dirs: an image copied from there gets no path line (a screenshot thumbnail lives there seconds). */
function inTempDir(p: string): boolean {
  const t = process.env.TMPDIR || tmpdir();
  const roots = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', t.replace(/\/+$/, '')];
  const low = p.toLowerCase();
  return roots.some((r) => low.startsWith(`${r.toLowerCase()}/`));
}

/** R4: the PO's paths are only touched async. */
const isFile = async (p: string): Promise<boolean> => { try { return (await stat(p)).isFile(); } catch { return false; } };

/** R11 a path line never breaks the list: a path with a control char (newline …) is written as a JSON string. */
// eslint-disable-next-line no-control-regex
const shown = (p: string): string => (/[\u0000-\u001f\u007f\u2028\u2029]/.test(p) ? JSON.stringify(p) : p);

/** §6.4 one user message: text block (prefix, text, path list) then one block per image, bytes read now from the copy. */
async function render(uuid: string, m: OutboxMsg, atts: readonly SendAttachment[]): Promise<Rendered> {
  const paths: string[] = [];
  const images: Block[] = [];
  const missing: string[] = [];
  for (const a of atts) {
    if (a.kind === 'image') {
      let data: string;
      try { data = (await readFile(a.path)).toString('base64'); } catch { missing.push(a.name); continue; }
      images.push({ type: 'image', source: { type: 'base64', media_type: a.mime ?? 'image/png', data } });
      if (a.origPath && !inTempDir(a.origPath) && (await isFile(a.origPath))) paths.push(`- ${shown(a.origPath)} (ảnh, đã kèm trong tin này)`);
      if (a.up) paths.push(`- ${shown(a.path)} (ảnh, bản sao tạm)`); // v2.7 §5.1 the copy issue_file takes
    } else if (!(await isFile(a.path))) missing.push(a.name);
    else paths.push(a.copy ? `- ${shown(a.path)} (bản sao tạm, không phải file gốc)` : `- ${shown(a.path)}`);
  }
  const head = contentOf(m);
  const text = paths.length ? `${head}\n\nFile PO đính kèm (đường dẫn trên máy này):\n${paths.join('\n')}` : head;
  return { line: userLine([{ type: 'text', text }, ...images], uuid), missing };
}

const outgoing = (uuid: string, m: OutboxMsg | Draft): Outgoing => {
  const atts = 'attachments' in m ? m.attachments : null;
  const raw = m.prefix === PREFIX.raw;
  return { uuid, raw, line: atts?.length ? render(uuid, m as OutboxMsg, atts) : userLine(contentOf(m), uuid) };
};

/**
 * v2.4 §6.6 / §10.2 the rows one process wrote, in order, until replayed: a raw row is never replayed when its command
 * has no replay (`/resume` headless), so it counts as delivered at the `result` of the turn it opened itself — the first
 * turn that starts once every row written before it was replayed, never the turn running when it was written.
 */
export class WriteLog {
  private readonly order: { uuid: string; raw: boolean; turn?: number }[] = [];
  /** Results seen = index of the turn now running or about to start. */
  private turns = 0;

  /** `busy` = a turn was in flight when this batch was written. */
  wrote(rows: readonly { uuid: string; raw: boolean }[], busy: boolean): void {
    for (const r of rows) this.order.push({ uuid: r.uuid, raw: r.raw });
    this.arm(busy ? this.turns + 1 : this.turns);
  }

  /** Its replay = a turn for it is running now, so a raw row next in line opens the turn after. */
  replayed(uuid: string): void {
    this.remove([uuid]);
    this.arm(this.turns + 1);
  }

  /** interrupt's still_queued: written again later. */
  unqueued(uuids: readonly string[]): void {
    this.remove(uuids);
    this.arm(this.turns);
  }

  /** A `result`: the raw rows whose own turn just ended. */
  result(): string[] {
    const ended = this.turns++;
    const out: string[] = [];
    for (let h = this.order[0]; h?.raw && h.turn !== undefined && h.turn <= ended; h = this.order[0]) {
      out.push(h.uuid);
      this.order.shift();
      this.arm(this.turns);
    }
    return out;
  }

  private remove(uuids: readonly string[]): void {
    for (const u of uuids) {
      const i = this.order.findIndex((r) => r.uuid === u);
      if (i >= 0) this.order.splice(i, 1);
    }
  }

  /** The first row, when raw and nothing before it waits for a replay, opens turn `at`. */
  private arm(at: number): void {
    const h = this.order[0];
    if (h?.raw && h.turn === undefined) h.turn = at;
  }
}

export class Outbox {
  /** uuids written to the current process's stdin and not yet replayed. In memory: a new process starts empty. */
  private readonly written = new Set<string>();
  /** resume messages: engine-made per resume, not persisted (a second resume makes a new one, never a duplicate). */
  private readonly transient = new Set<string>();

  /** §6.3 A4 messages whose missing attachments were reported (one `engine` line each, even when written again). */
  private readonly reported = new Set<string>();
  private missingTo: MissingListener | null = null;
  /** v2.6 §4.8 PO lines echoed with `held` (uuid → where they show), until written. In memory, like the hold (§5.4-8). */
  private readonly heldLines = new Map<string, { target: Target; seq: number }>();
  private writtenTo: PoWrittenListener | null = null;

  /** `copies`: the attachment store (§6.5 the copies delivered to a session go when it ends). */
  constructor(private readonly db: Db, private readonly copies?: Pick<AttachStore, 'discard'>) {}

  /** §6.3 A4 / R13 who writes the one `engine` line of a message that went without some of its attachments. */
  onAttachMissing(f: MissingListener): void { this.missingTo = f; }

  /** v2.6 §10.3 who clears the label of a held PO line once its row is written. */
  onPoWritten(f: PoWrittenListener): void { this.writtenTo = f; }

  /** v2.6 §4.8 row `uuid` was received during the update hold; its `po` line (`seq`, shown to `target`) carries `held`. */
  heldLine(uuid: string, target: Target, seq: number): void { this.heldLines.set(uuid, { target, seq }); }

  /** v2.1 §4.14 undo: delete a message never written to any process (true) — once written it counts as read. */
  dropUnsent(uuid: string): boolean {
    if (this.written.has(uuid)) return false;
    return this.db.query('DELETE FROM outbox WHERE uuid = ? AND delivered_at IS NULL').run(uuid).changes > 0;
  }

  /** v2.4 §10.2 `send` passes its own `uuid`, the attachments' metadata and `echoed` (its `po` line is already written). */
  enqueue(sessionId: string, text: string, prefix: string | null, extra: SendExtra = {}): OutboxMsg {
    return insertOutbox(this.db, { sessionId, text, prefix, uuid: extra.uuid ?? randomUUID(), attachments: extra.attachments, echoed: extra.echoed });
  }

  /** v2.4 §10.2 the row's `po` line was written at send (its replay adds none). */
  echoed(uuid: string): boolean { return getOutbox(this.db, uuid)?.echoed === true; }

  /** v2.4 §10.2 copy ids any outbox row names: the sweep and `DELETE /attach` leave them alone. */
  referencedCopies(): Set<string> {
    return new Set(outboxAttachments(this.db).flatMap((a) => (a.up ? [a.up] : [])));
  }

  /** Undelivered messages not yet written to this process, in order; they are marked written. */
  nextToSend(sessionId: string): Outgoing[] {
    const out: Outgoing[] = [];
    for (const m of listUndelivered(this.db, sessionId)) {
      if (this.written.has(m.uuid)) continue;
      this.written.add(m.uuid);
      out.push(this.watchMissing(sessionId, outgoing(m.uuid, m)));
    }
    this.unheld(out);
    return out;
  }

  /** v2.6 §10.3 the held rows among `out` are written now: one listener call per target, seqs in row order. */
  private unheld(out: readonly Outgoing[]): void {
    const by = new Map<string, { target: Target; seqs: number[] }>();
    for (const o of out) {
      const h = this.heldLines.get(o.uuid);
      if (!h) continue;
      this.heldLines.delete(o.uuid);
      const k = JSON.stringify(h.target);
      const g = by.get(k) ?? { target: h.target, seqs: [] };
      g.seqs.push(h.seq);
      by.set(k, g);
    }
    for (const g of by.values()) this.writtenTo?.(g.target, g.seqs);
  }

  private watchMissing(sessionId: string, o: Outgoing): Outgoing {
    if (typeof o.line === 'string') return o;
    return { ...o, line: o.line.then((r) => {
      if (r.missing.length && !this.reported.has(o.uuid)) { this.reported.add(o.uuid); this.missingTo?.(sessionId, o.uuid, r.missing); }
      return r;
    }) };
  }

  /** v2.4 §5.3 a row of this session was written to stdin and not replayed yet (the session is busy, not idle). */
  hasUnreplayed(sessionId: string): boolean {
    return listUndelivered(this.db, sessionId).some((m) => this.written.has(m.uuid));
  }

  /** A replayed user line: marks it delivered (its copies stay until the session ends, v2.7 §5.1). False = not one of ours. */
  onReplay(uuid: string): boolean {
    this.written.delete(uuid);
    if (this.transient.delete(uuid)) return true;
    const m = getOutbox(this.db, uuid);
    if (!m) return false;
    markDelivered(this.db, m.uuid);
    return true;
  }

  /** v2.4 §6.6 a raw row with no replay, delivered at the `result` of its own turn (`WriteLog`). */
  onRawDone(uuid: string): void {
    this.written.delete(uuid);
    const m = getOutbox(this.db, uuid);
    if (m) markDelivered(this.db, m.uuid);
  }

  /** v2.4 §6.5 a session ended for good: the copies of the messages delivered to it go (images and files alike, v2.7 §5.1).
   *  Undelivered rows keep theirs: they move to the receiving session. */
  discardDelivered(sessionId: string): void {
    const rows = this.db.query<{ attachments: string }, [string]>(
      'SELECT attachments FROM outbox WHERE session_id = ? AND delivered_at IS NOT NULL AND attachments IS NOT NULL').all(sessionId);
    const ids = rows.flatMap((r) => (JSON.parse(r.attachments) as SendAttachment[]).flatMap((a) => (a.up ? [a.up] : [])));
    if (ids.length) this.copies?.discard(ids);
  }

  /** interrupt's `still_queued`: those never entered the conversation, so they stay undelivered and go out again. */
  onStillQueued(uuids: readonly string[]): void {
    for (const u of uuids) {
      this.written.delete(u);
      this.transient.delete(u);
    }
  }

  /** A new process starts: undelivered rows written to an earlier (dead) process were never replayed → send them again. */
  resetWritten(sessionId: string): void {
    for (const m of listUndelivered(this.db, sessionId)) this.written.delete(m.uuid);
  }

  /**
   * Fresh re-run (no conversation to resume): `text` (prefix already in it) must be the first message of the new
   * conversation. An undelivered copy is moved to the front instead of duplicated; the other rows keep their uuids.
   */
  ensureFirst(sessionId: string, text: string): void {
    const rows = listUndelivered(this.db, sessionId);
    const isIt = (m: OutboxMsg) => m.text === text && m.prefix === null;
    if (rows[0] && isIt(rows[0])) return;
    this.db.transaction(() => {
      this.db.query('DELETE FROM outbox WHERE session_id = ? AND delivered_at IS NULL').run(sessionId);
      const copy = rows.find(isIt);
      insertOutbox(this.db, { sessionId, text, prefix: null, ...(copy ? { uuid: copy.uuid } : {}) });
      for (const m of rows) {
        if (m !== copy) insertOutbox(this.db, { sessionId, text: m.text, prefix: m.prefix, uuid: m.uuid, attachments: m.attachments, echoed: m.echoed });
      }
    })();
  }

  /** New process after resume: the resume message first, then every undelivered message in order (all marked written). */
  undeliveredAfterResume(sessionId: string, resumeText: string): Outgoing[] {
    this.resetWritten(sessionId);
    const uuid = randomUUID();
    this.transient.add(uuid);
    this.written.add(uuid);
    return [outgoing(uuid, { prefix: PREFIX.engine, text: resumeText }), ...this.nextToSend(sessionId)];
  }
}
