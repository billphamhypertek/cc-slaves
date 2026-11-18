// spec v2.2 §14.5 "Nối" + "Đổi sang dòng đầy đủ tại chỗ": the streaming text blocks of one target, by block key
// (`<api_message_id>:<index>`, §14.4). Pure; lib/store.ts owns the state and the reveal loop (lib/stream-reveal.ts).
import type { StreamLine } from '../../../shared/protocol.ts';

export interface PartialBlock {
  /** what arrived so far */
  text: string;
  /** parent_tool_use_id: a subagent's block (shown only in that sub's Đang xem), null = the target's own */
  parent: string | null;
  /** chars of `text` on screen (the pacing loop moves it) */
  shown: number;
  /** `partial_end` or the full line came: the caret goes, the drain speeds up */
  ended: boolean;
  /** a (re)watch was sent and no `full` came back for it yet: dropped by the next newest page (closed meanwhile) */
  stale: boolean;
  /** the full line of this key, waiting for the reveal to reach the end (§14.5 swap in one `set`) */
  line: StreamLine | null;
  /** later lines of the same surface, held so they never show above the text still being revealed */
  after: StreamLine[];
  /** seq of the target's last line when the block began: an orphan (ended, no line ever) sorts there, by arrival */
  at: number;
}
/** key → block, in arrival order */
export type Blocks = Readonly<Record<string, PartialBlock>>;

export const newBlock = (parent: string | null, at: number): PartialBlock => ({ text: '', parent, shown: 0, ended: false, stale: false, line: null, after: [], at });

/** §14.5 ended without its full line (interrupt, the process died): what it showed stays put until the next answer. */
export const isOrphan = (b: PartialBlock): boolean => b.ended && b.line === null;
const msgOf = (key: string) => key.slice(0, key.lastIndexOf(':'));

/** The blocks of one surface: the target's own (`parent` null) or one subagent's. */
export const blocksOf = (b: Blocks | undefined, parent: string | null): [string, PartialBlock][] =>
  Object.entries(b ?? {}).filter(([, x]) => x.parent === parent);

const surfaceOf = (l: StreamLine): string | null => l.parentToolUseId ?? null;
const isText = (l: StreamLine) => l.kind === 'assistant' || l.kind === 'subagent';

/**
 * Lines of a `stream` event against the open blocks (mutates the `blocks` copy it is given):
 * - a line with the key of a block: `revealed(key)` → the block goes and the line shows now; else it waits in the block;
 * - a text line without key (the engine lost its ledger): every open block of its surface goes, like v2.1;
 * - a keyed text line drops the orphans of its surface from other messages (their line never comes);
 * - any other line waits behind the first held line of its surface, else shows now.
 * Returns the lines to show now and the keys whose block went.
 */
export function takeLines(blocks: Record<string, PartialBlock>, lines: readonly StreamLine[], revealed: (key: string) => boolean): { show: StreamLine[]; gone: string[]; held: string[] } {
  const show: StreamLine[] = [], gone: string[] = [], held: string[] = [];
  const drop = (k: string) => { const b = blocks[k]!; delete blocks[k]; gone.push(k); if (b.line) show.push(b.line, ...b.after); };
  for (const l of [...lines].sort((a, b) => a.seq - b.seq)) {
    if (isText(l) && l.key !== undefined) {
      const m = msgOf(l.key);
      for (const [k, b] of Object.entries(blocks)) if (b.parent === surfaceOf(l) && isOrphan(b) && msgOf(k) !== m) drop(k);
    }
    const own = l.key !== undefined ? blocks[l.key] : undefined;
    if (own && l.key !== undefined) {
      if (revealed(l.key)) { drop(l.key); show.push(l); } else { blocks[l.key] = { ...own, line: l, ended: true }; held.push(l.key); }
      continue;
    }
    const surface = surfaceOf(l);
    if (isText(l) && l.key === undefined) for (const [k, b] of Object.entries(blocks)) if (b.parent === surface) drop(k);
    const holder = Object.entries(blocks).find(([, b]) => b.parent === surface && b.line !== null);
    if (holder) blocks[holder[0]] = { ...holder[1], after: [...holder[1].after, l] };
    else show.push(l);
  }
  return { show, gone, held };
}
