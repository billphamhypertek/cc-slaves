// Chat/console lines (spec §6.3 U3, §8.4): stream events → one StreamLine per content block, persisted in the
// `event` table (type 'line', seq = row id) so the UI pages history from state.db instead of the engine keeping it.
import type { StreamLine, Target } from '../../../shared/protocol.ts';
import type { Engine } from '../engine.ts';
import type { Db } from '../db.ts';
import type { StreamEvent } from '../stream/parser.ts';
import { exitCodeOf, resultDetail, toolDiff, trimInput } from './tool-detail.ts';
import { isObj } from '../../../shared/json.ts';
import { PREFIX, poText } from '../outbox.ts';

export type NewLine = Omit<StreamLine, 'seq' | 'ts'>;

/** §8.4: the UI keeps ≤ 500 lines per stream; one page never exceeds that. */
const MAX_PAGE = 500;
const TOOL_RESULT_MAX = 300;
const MAIN_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt'];

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function toolSummary(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const k = MAIN_KEYS.find((x) => typeof i[x] === 'string' && (i[x]).trim() !== '');
  return k ? `${name}: ${clip(oneLine(i[k] as string), 200)}` : name;
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.flatMap((b) => (isObj(b) && typeof b.text === 'string' ? [b.text] : [])).join('\n');
  return '';
}

const id = (v: unknown): { toolUseId?: string } => (typeof v === 'string' ? { toolUseId: v } : {});

/** §14.4 tool_result: the one-line summary in `text`, the result itself (≤ 8 KB, newlines kept) in `result`;
 *  §14.5 S5 a failed one's "Exit code k" line moves to `exitCode`. */
function resultLine(b: Record<string, unknown>, parent: string | null): NewLine {
  const full = resultText(b.content);
  const isError = b.is_error === true;
  const exit = isError ? exitCodeOf(full) : null;
  return { kind: 'tool_result', text: clip(oneLine(full), TOOL_RESULT_MAX), parentToolUseId: parent, ...id(b.tool_use_id), isError,
    ...resultDetail(exit ? exit.rest : full), ...(exit ? { exitCode: exit.exitCode } : {}) };
}

/** v2.4 §4.3 / NC §8-2 Claude Code's own replay after `set_model` (a foreign uuid). */
const SET_MODEL = /^<local-command-stdout>Set model to /;
/** v2.4 §6.6 a built-in command's output, replayed under a foreign uuid. */
const LOCAL_OUT = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;

/** v2.4 §6.6 / §10.2 one replayed text: ours → po (R3 without "[PO] ") or engine; foreign → a `<local-command-stdout>`
 *  system line (not "Set model to", §4.3), else nothing (skill body, `<command-message>`, `/compact`'s synthetic line, R7). */
function replayed(text: string, ours: boolean, parent: string | null): NewLine | null {
  if (ours) return text.startsWith(PREFIX.engine) ? { kind: 'engine', text, parentToolUseId: parent } : { kind: 'po', text: poText(text), parentToolUseId: parent };
  const m = SET_MODEL.test(text) ? null : LOCAL_OUT.exec(text);
  const inner = m?.[1]?.trim();
  return inner ? { kind: 'system', text: inner, parentToolUseId: parent } : null;
}

/** One stream event → zero or more lines (assistant / user only; everything else has no chat line). `keys[i]` = the
 *  §14.4 block key of `message.content[i]` (BlockLedger.stamp), put on that block's line. */
export function toLines(e: StreamEvent, keys: readonly (string | undefined)[] = []): NewLine[] {
  if (e.kind !== 'assistant' && e.kind !== 'user') return [];
  const parent = e.parentToolUseId;
  const msg = isObj(e.message) ? e.message : {};
  const content = msg.content;
  const out: NewLine[] = [];
  if (e.kind === 'user') {
    const ours = e.ours === true;
    if (typeof content === 'string') {
      const l = e.isReplay ? replayed(content, ours, parent) : null;
      return l ? [l] : [];
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_result') out.push(resultLine(b, parent));
      else if (b.type === 'text' && e.isReplay && typeof b.text === 'string') {
        const l = replayed(b.text, ours, parent);
        if (l) out.push(l);
      }
    }
    return out;
  }
  (Array.isArray(content) ? content : []).forEach((b: unknown, i) => {
    if (!isObj(b)) return;
    const key = keys[i] === undefined ? {} : { key: keys[i] };
    if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') {
      out.push({ kind: parent ? 'subagent' : 'assistant', text: b.text, parentToolUseId: parent, ...key });
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      const diff = toolDiff(b.name, b.input);
      out.push({ kind: 'tool_use', text: toolSummary(b.name, b.input), tool: b.name, parentToolUseId: parent, ...key, ...id(b.id),
        input: trimInput(b.input), ...(diff ? { diff } : {}) });
    }
  });
  return out;
}

/** v2.4 §10.2 a `po` line written by the engine (at `send`, or when an echoed row moves): stored, then to watchers. */
export function writePoLine(eng: Pick<Engine, 'lines' | 'hub'>, t: Target, sessionId: string, line: NewLine): StreamLine {
  const lines = eng.lines.append(sessionId, [line]);
  eng.hub.broadcast({ type: 'stream', target: t, lines });
  return lines[0]!;
}

/** v2.6 §4.8 / §10.3 held PO lines were written to Claude Code: the stored lines lose `held`, then watchers are told. */
export function poWritten(eng: { lines: Pick<LineStore, 'unhold'>; hub: Pick<Engine['hub'], 'broadcast'> }, t: Target, seqs: number[]): void {
  eng.lines.unhold(seqs);
  eng.hub.broadcast({ type: 'po_written', target: t, seqs });
}

interface Row { id: number; ts: number; json: string }

export class LineStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {} // §5.3 epoch ms, like insertEvent

  append(sessionId: string, lines: NewLine[]): StreamLine[] {
    const ts = this.now();
    const q = this.db.query<{ id: number }, [string, number, string]>(
      "INSERT INTO event (session_id, ts, type, json) VALUES (?, ?, 'line', ?) RETURNING id",
    );
    return lines.map((l) => ({ ...l, seq: q.get(sessionId, ts, JSON.stringify(l))!.id, ts }));
  }

  /** v2.6 §4.8 drop the "giữ lại" label of lines `seqs`; none given = every line (boot: the hold lives in memory only). */
  unhold(seqs?: readonly number[]): void {
    const only = seqs ? ` AND id IN (${seqs.map(() => '?').join(',')})` : '';
    this.db.query<unknown, number[]>(
      `UPDATE event SET json = json_remove(json, '$.held') WHERE type = 'line' AND json_extract(json, '$.held') = 1${only}`,
    ).run(...(seqs ?? []));
  }

  /** F25: a subagent's lines (parentToolUseId = its Task tool use id), newest `limit` before `beforeSeq`, oldest first. */
  pageByParent(sessionIds: string[], parent: string, beforeSeq?: number, limit = 200): StreamLine[] {
    if (sessionIds.length === 0) return [];
    const n = Math.max(1, Math.min(MAX_PAGE, Math.floor(limit)));
    const marks = sessionIds.map(() => '?').join(',');
    const rows = this.db.query<Row, (string | number)[]>(
      `SELECT id, ts, json FROM event WHERE type = 'line' AND session_id IN (${marks}) AND id < ?
       AND json_extract(json, '$.parentToolUseId') = ? ORDER BY id DESC LIMIT ?`,
    ).all(...sessionIds, beforeSeq ?? Number.MAX_SAFE_INTEGER, parent, n);
    return rows.reverse().map((r) => ({ ...(JSON.parse(r.json) as NewLine), seq: r.id, ts: r.ts }));
  }

  /** The `limit` newest lines with seq < beforeSeq across `sessionIds`, oldest first. */
  page(sessionIds: string[], beforeSeq?: number, limit = 200): StreamLine[] {
    if (sessionIds.length === 0) return [];
    const n = Math.max(1, Math.min(MAX_PAGE, Math.floor(limit)));
    const marks = sessionIds.map(() => '?').join(',');
    const rows = this.db.query<Row, (string | number)[]>(
      `SELECT id, ts, json FROM event WHERE type = 'line' AND session_id IN (${marks}) AND id < ? ORDER BY id DESC LIMIT ?`,
    ).all(...sessionIds, beforeSeq ?? Number.MAX_SAFE_INTEGER, n);
    return rows.reverse().map((r) => ({ ...(JSON.parse(r.json) as NewLine), seq: r.id, ts: r.ts }));
  }
}
