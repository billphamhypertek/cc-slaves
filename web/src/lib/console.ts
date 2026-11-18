// Console (bàn lệnh) stream buffer and input parsing — spec §6.3, §8.4 (≤ 500 lines per stream in memory).
import type { Tr } from '../../../shared/i18n/core.ts';
import type { Channel, StreamLine } from '../../../shared/protocol.ts';
import { matchSlash } from '../../../shared/slash.ts';
import { fmtDayHm, shortEmail } from './format.ts';
import { canRun } from './remote.ts';

export const MAX_LINES = 500;

export interface StreamBuffer {
  lines: StreamLine[];
  /** false after scrolling up past the cap: live lines are flagged (`newer`) instead of kept */
  atTail: boolean;
  /** false once a history page came back short */
  hasOlder: boolean;
  newer: boolean;
}

export const emptyBuffer = (): StreamBuffer => ({ lines: [], atTail: true, hasOlder: true, newer: false });

function merge(a: StreamLine[], b: StreamLine[]): StreamLine[] {
  const bySeq = new Map<number, StreamLine>();
  for (const l of a) bySeq.set(l.seq, l);
  for (const l of b) if (!bySeq.has(l.seq)) bySeq.set(l.seq, l);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

export function appendLive(b: StreamBuffer, lines: StreamLine[]): StreamBuffer {
  if (!lines.length) return b;
  if (!b.atTail) return { ...b, newer: true };
  const all = merge(b.lines, lines);
  return { ...b, lines: all.length > MAX_LINES ? all.slice(all.length - MAX_LINES) : all };
}

/** v2.6 §10.3 `po_written`: these PO lines reached Claude Code, their "giữ lại" label goes (same array when none match). */
export function unhold(lines: StreamLine[], seqs: ReadonlySet<number>): StreamLine[] {
  if (!lines.some(l => l.held && seqs.has(l.seq))) return lines;
  return lines.map(l => {
    if (!l.held || !seqs.has(l.seq)) return l;
    const { held: _gone, ...rest } = l;
    return rest;
  });
}

/** `full` = the page came back with `limit` lines (more may exist). */
export function prependHistory(b: StreamBuffer, older: StreamLine[], full: boolean): StreamBuffer {
  const all = merge(b.lines, older);
  const over = all.length > MAX_LINES;
  return { lines: over ? all.slice(0, MAX_LINES) : all, atTail: b.atTail && !over, hasOlder: full, newer: b.newer };
}

/**
 * I6: on every watch (re)send the newest page comes back (`limit` asked). Lines that arrived while the PO looked at
 * another target, or while offline, never reached this buffer. Page overlapping the buffer → merge; otherwise the gap
 * is unknown → the page replaces the old lines (keeping live lines newer than the page). Detached buffer: just flag.
 */
export function resyncTail(b: StreamBuffer, page: StreamLine[], limit: number): StreamBuffer {
  const full = page.length >= limit;
  if (!b.lines.length) return prependHistory(b, page, full);
  if (!b.atTail) return { ...b, newer: true };
  if (!page.length) return b;
  const first = page[0]!.seq, last = page[page.length - 1]!.seq;
  // a gap is possible unless the page is the whole history or shares a line with the buffer (live lines that came in
  // between the watch and this page are newer than `last` and are kept either way)
  const overlaps = !full || b.lines.some(l => l.seq >= first && l.seq <= last);
  const all = overlaps ? merge(b.lines, page) : merge(page, b.lines.filter(l => l.seq > last));
  const over = all.length > MAX_LINES;
  return { lines: over ? all.slice(all.length - MAX_LINES) : all, atTail: true, hasOlder: overlaps ? b.hasOlder || over : full || over, newer: false };
}

/** §8 a local `/` command the remote channel cannot run: the model picker (v2.4 §8), `/handoff` (stop_all), `/new`. */
export function macOnlyLocal(cmd: Extract<ParsedInput, { kind: 'local' }>['cmd'], channel: Channel | null): boolean {
  return cmd === 'model' ? channel !== 'mac' : cmd === 'handoff' ? !canRun(channel, 'stop_all') : cmd === 'new' ? !canRun(channel, 'orchestrator_new') : false;
}

export type ParsedInput =
  | { kind: 'none' }
  /** §6.6 `raw` = a `/` line sent without the `[PO]` prefix (skill, built-in, MCP prompt). */
  | { kind: 'send'; text: string; lane?: string; raw?: true }
  | { kind: 'local'; cmd: 'lanes' | 'quota' | 'handoff' | 'new' }
  /** v2.4 §6.6 Y45 `/model` / `/effort`: the picker of the target (`lane` = an `@lane` prefix; else the composer's target). */
  | { kind: 'local'; cmd: 'model'; lane?: string }
  | { kind: 'local'; cmd: 'stop'; lane: string }
  | { kind: 'error'; text: string };

const findLane = (name: string | undefined, lanes: string[]) =>
  name ? lanes.find(l => l.toLowerCase() === name.toLowerCase()) : undefined;

/** v1 M9 + v2.4 §6.6 (an `@lane …` prefix names the lane the line goes to). */
export function parseInput(tr: Tr, raw: string, lanes: string[]): ParsedInput {
  let text = raw.trim();
  if (!text) return { kind: 'none' };
  let lane: string | undefined;
  const at = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  if (at) {
    lane = findLane(at[1], lanes);
    if (lane) text = at[2]!.trim();
  }
  const slash = matchSlash(text);
  const sendIt = (extra: { raw?: true }): ParsedInput => ({ kind: 'send', ...(lane ? { lane } : {}), text, ...extra });
  if (!slash) return sendIt({});
  if (slash.kind === 'blocked') return { kind: 'error', text: tr(slash.cmd === 'clear' ? 'model.blockedClear' : 'model.blockedLogin') };
  if (slash.kind === 'pass') return sendIt({ raw: true });
  const c = slash.cmd;
  if (c === 'model' || c === 'effort') return { kind: 'local', cmd: 'model', ...(lane ? { lane } : {}) };
  if (lane) return sendIt({}); // v1: `@D2 /lanes` is a message to D2, as before
  if (c === 'lanes' || c === 'quota' || c === 'handoff' || c === 'new') return { kind: 'local', cmd: c };
  const stop = findLane(slash.args.split(/\s+/)[0], lanes);
  return stop ? { kind: 'local', cmd: 'stop', lane: stop } : { kind: 'error', text: tr('labels.stopUsage') };
}

/** v2.1 §4.14 a session boundary line as a divider: the catalog text in the UI language + when ("Phiên #2 kết thúc ·
 *  15/11 14:22"; a resume reads "Chạy tiếp 15/11 15:20 · acc33@ · song song", mockup N5-h); the engine's vi `text` when it
 *  carries no boundary. */
export function boundaryText(tr: Tr, l: StreamLine): string {
  const b = l.boundary;
  if (!b) return l.text;
  const n = b.seq ?? '?', account = b.account ? shortEmail(b.account) : '—', when = fmtDayHm(b.at, tr);
  if (b.type === 'resume') return b.mode === 'replace' ? tr('console.boundaryResumeReplace', { when, account, m: b.replaced ?? '?' }) : tr('console.boundaryResume', { when, account });
  const head = b.type === 'start' ? tr('console.boundaryStart', { n, account }) : tr(b.handoff ? 'console.boundaryEndHandoff' : 'console.boundaryEnd', { n });
  return `${head} · ${when}`;
}

/** §4.14 N5-h a resumed session still starting shows its resume divider and what came after (the engine's first
 *  "[cc-slaves] …" line), never its old rows as if they were new output; null = no resume line in the buffer. */
export function resumedTail(lines: readonly StreamLine[]): StreamLine[] | null {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.boundary?.type === 'resume') return lines.slice(i);
  return null;
}
