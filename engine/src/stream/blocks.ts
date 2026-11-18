// Block ledger (spec v2.2 §14.4, §3-15): every `stream_event` of a session lands here, watched or not. It numbers the
// content blocks of each API message (`key = <api_message_id>:<index>`), stamps the full `assistant` line of a block
// with that key, and holds a text block's deltas so a mid-stream `watch` can get the text so far (`full`).
// It never broadcasts: `event()` returns what watchers of that target should get; the engine decides who watches.
import type { EngineEvent } from '../../../shared/protocol.ts';
import type { PartialEvent, StreamEvent } from './parser.ts';
import { isObj } from '../../../shared/json.ts';

type Gated = Extract<EngineEvent, { type: 'partial' | 'partial_end' | 'thinking' }>;
type NoTarget<T> = T extends unknown ? Omit<T, 'target'> : never;
/** A `partial` / `partial_end` / `thinking` event without its target. */
export type BlockOut = NoTarget<Gated>;

/** §14.4 the most text held per block (UTF-8 bytes); over it the held part is dropped and the web waits for the full line. */
export const HELD_MAX = 256 * 1024;

type BlockType = 'text' | 'thinking' | 'tool_use' | 'other';
interface Block { index: number; type: BlockType; stamped: boolean; stopped: boolean; held: string | null; bytes: number }
interface Msg<M> { id: string; parent: string | null; meta: M; blocks: Block[]; stopped: boolean }

const typeOf = (t: unknown): BlockType => (t === 'text' || t === 'thinking' || t === 'tool_use' ? t : t === 'redacted_thinking' ? 'thinking' : 'other');
const utf8 = new TextEncoder();

export class BlockLedger<M> {
  /** session id → api message id → message */
  private readonly sessions = new Map<string, Map<string, Msg<M>>>();

  /** Messages tracked across every session (tests: the ledger stays bounded). */
  get size(): number { let n = 0; for (const s of this.sessions.values()) n += s.size; return n; }

  /** One `stream_event` of `sessionId` (target `meta`) → what its watchers get. */
  event(sessionId: string, meta: M, e: PartialEvent): BlockOut[] {
    const id = e.apiMessageId;
    const ev = isObj(e.event) ? e.event : {};
    if (id === null) return [];
    let msgs = this.sessions.get(sessionId);
    if (ev.type === 'message_start') {
      if (!msgs) { msgs = new Map<string, Msg<M>>(); this.sessions.set(sessionId, msgs); }
      // a new message of the same chain means the older one is over: keeps the ledger bounded if a stamp never came
      for (const [k, m] of msgs) if (m.parent === e.parentToolUseId) msgs.delete(k);
      msgs.set(id, { id, parent: e.parentToolUseId, meta, blocks: [], stopped: false });
      return [];
    }
    const msg = msgs?.get(id);
    if (!msg) return [];
    const parent = msg.parent;
    if (ev.type === 'message_stop') { msg.stopped = true; this.dropIfDone(sessionId, msg); return []; }
    const index = typeof ev.index === 'number' ? ev.index : -1;
    if (ev.type === 'content_block_start') {
      const type = typeOf(isObj(ev.content_block) ? ev.content_block.type : null);
      msg.blocks.push({ index, type, stamped: false, stopped: false, held: type === 'text' ? '' : null, bytes: 0 });
      return type === 'thinking' ? [{ type: 'thinking', parent, on: true }] : [];
    }
    const b = msg.blocks.find((x) => x.index === index);
    if (!b) return [];
    const key = `${id}:${index}`;
    if (ev.type === 'content_block_stop') {
      b.stopped = true;
      if (b.type === 'thinking') return [{ type: 'thinking', parent, on: false }];
      return b.type === 'text' ? [{ type: 'partial_end', key }] : [];
    }
    const d = isObj(ev.delta) ? ev.delta : {};
    if (ev.type !== 'content_block_delta' || d.type !== 'text_delta' || typeof d.text !== 'string' || b.type !== 'text') return [];
    if (b.held === null) return []; // dropped (over HELD_MAX) or already saved: the web waits for / has the full line
    b.bytes += utf8.encode(d.text).length;
    if (b.bytes > HELD_MAX) { b.held = null; return []; }
    b.held += d.text;
    return [{ type: 'partial', key, parent, delta: d.text }];
  }

  /** §14.4 a full `assistant` line: each of its content blocks takes the first unstamped block of the same type in
   *  `blocks[message.id]` → its key (undefined when none is found). The held text of a stamped block is released. */
  stamp(sessionId: string, e: StreamEvent): (string | undefined)[] {
    if (e.kind !== 'assistant') return [];
    const message = isObj(e.message) ? e.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const msg = typeof message.id === 'string' ? this.sessions.get(sessionId)?.get(message.id) : undefined;
    const keys = content.map((c) => {
      const type = typeOf(isObj(c) ? c.type : null);
      const b = msg?.blocks.find((x) => !x.stamped && x.type === type);
      if (!msg || !b) return undefined;
      b.stamped = true;
      b.held = null;
      return `${msg.id}:${b.index}`;
    });
    if (msg) this.dropIfDone(sessionId, msg);
    return keys;
  }

  /** §14.4 mid-stream `watch`: for every target `match` accepts, the held text of each unsaved text block (`full`,
   *  then `partial_end` if it already stopped) and `thinking on` for each open thinking block. */
  open(match: (meta: M) => boolean): { meta: M; out: BlockOut }[] {
    const res: { meta: M; out: BlockOut }[] = [];
    for (const msgs of this.sessions.values()) {
      for (const m of msgs.values()) {
        if (!match(m.meta)) continue;
        for (const b of m.blocks) {
          const key = `${m.id}:${b.index}`;
          if (b.held !== null && !b.stamped) {
            res.push({ meta: m.meta, out: { type: 'partial', key, parent: m.parent, full: b.held } });
            if (b.stopped) res.push({ meta: m.meta, out: { type: 'partial_end', key } });
          } else if (b.type === 'thinking' && !b.stopped) res.push({ meta: m.meta, out: { type: 'thinking', parent: m.parent, on: true } });
        }
      }
    }
    return res;
  }

  /** The session's turn ended (`result`) or its process died: every message is over. Open text blocks →
   *  `partial_end` (the web stops waiting), open thinking blocks → `thinking off`; the session is forgotten, so a
   *  later `watch` gets no stale text. */
  end(sessionId: string): { meta: M; out: BlockOut }[] {
    const res: { meta: M; out: BlockOut }[] = [];
    for (const m of this.sessions.get(sessionId)?.values() ?? []) {
      for (const b of m.blocks) {
        if (b.stopped) continue;
        if (b.type === 'text' && !b.stamped) res.push({ meta: m.meta, out: { type: 'partial_end', key: `${m.id}:${b.index}` } });
        else if (b.type === 'thinking') res.push({ meta: m.meta, out: { type: 'thinking', parent: m.parent, on: false } });
      }
    }
    this.sessions.delete(sessionId);
    return res;
  }

  /** §14.4 a message is forgotten once `message_stop` came and every block is stamped. */
  private dropIfDone(sessionId: string, msg: Msg<M>): void {
    if (!msg.stopped || msg.blocks.some((b) => !b.stamped)) return;
    const msgs = this.sessions.get(sessionId);
    msgs?.delete(msg.id);
    if (msgs?.size === 0) this.sessions.delete(sessionId);
  }
}
