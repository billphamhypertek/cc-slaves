// fake-claude `stream` step (spec v2.2 §3-15, §14.7 E2E): one API message as real-shape `stream_event`s, in the order
// measured on real runs: message_start → per block: content_block_start → deltas → `assistant` [that block] →
// content_block_stop → message_delta → message_stop. Every stream_event carries api_message_id + parent_tool_use_id.
//
// {"stream": {"id"?: msg id, "parent"?: tool_use id (a subagent), "chunk"?: chars per delta (8), "everyMs"?: sleep between
//   deltas (0), "open"?: true (stop after the last block's deltas: no assistant / stop — a reply still streaming),
//   "blocks": [{"thinking": text} | {"text": text} | {"tool_use": {"name", "input", "id"?}}]}}
import { randomUUID } from 'node:crypto';

type Obj = Record<string, unknown>;
interface Io { emit: (o: Obj) => void; sleep: (ms: number) => Promise<void>; model: string }

/** Splits by code point so a delta never ends inside a surrogate pair. */
const chunks = (s: string, n: number): string[] => {
  const cps = [...s], out: string[] = [];
  for (let i = 0; i < cps.length; i += n) out.push(cps.slice(i, i + n).join(''));
  return out;
};

export async function streamMessage(spec: Obj, io: Io): Promise<void> {
  const id = typeof spec.id === 'string' ? spec.id : `msg_fake_${randomUUID().slice(0, 8)}`;
  const parent = typeof spec.parent === 'string' ? spec.parent : null;
  const n = typeof spec.chunk === 'number' && spec.chunk > 0 ? spec.chunk : 8;
  const every = typeof spec.everyMs === 'number' ? spec.everyMs : 0;
  const blocks = Array.isArray(spec.blocks) ? (spec.blocks as Obj[]) : [];
  const se = (event: Obj) => io.emit({ type: 'stream_event', uuid: randomUUID(), api_message_id: id, parent_tool_use_id: parent, event });
  const deltas = async (index: number, parts: Obj[]) => {
    for (const delta of parts) {
      se({ type: 'content_block_delta', index, delta });
      if (every > 0) await io.sleep(every);
    }
  };
  se({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: io.model, content: [] } });
  for (const [index, b] of blocks.entries()) {
    let block: Obj;
    if (typeof b.thinking === 'string') {
      se({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      await deltas(index, [...chunks(b.thinking, n).map((thinking) => ({ type: 'thinking_delta', thinking })), { type: 'signature_delta', signature: 'sig' }]);
      block = { type: 'thinking', thinking: b.thinking, signature: 'sig' };
    } else if (typeof b.text === 'string') {
      se({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      await deltas(index, chunks(b.text, n).map((text) => ({ type: 'text_delta', text })));
      block = { type: 'text', text: b.text };
    } else {
      const t = (b.tool_use ?? {}) as Obj;
      const tid = typeof t.id === 'string' ? t.id : `toolu_${randomUUID().slice(0, 8)}`;
      se({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: tid, name: t.name, input: {} } });
      await deltas(index, [{ type: 'input_json_delta', partial_json: JSON.stringify(t.input ?? {}) }]);
      block = { type: 'tool_use', id: tid, name: t.name, input: t.input ?? {} };
    }
    if (spec.open === true && index === blocks.length - 1) return;
    io.emit({ type: 'assistant', parent_tool_use_id: parent, message: { id, type: 'message', role: 'assistant', model: io.model, content: [block] } });
    se({ type: 'content_block_stop', index });
  }
  se({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  se({ type: 'message_stop' });
}
