// Tool-row detail for chat lines (spec v2.2 §14.4 "Dòng công cụ"): the trimmed `tool_use` input, Edit / Write / MultiEdit
// `+n −m`, and the byte-capped `tool_result` text. Pure; server/lines.ts puts them on the StreamLine.
import { isObj } from '../../../shared/json.ts';
const utf8 = new TextEncoder();

/** §14.4 the trimmed input is at most this many UTF-8 bytes. */
const INPUT_MAX = 2 * 1024;
/** each string value is cut to the first of these that fits INPUT_MAX */
const VALUE_CUTS = [400, 160, 60, 20];
/** above this many line pairs the diff falls back to whole counts (an LCS table that size is not worth it) */
const DIFF_CELLS = 250_000;

/** The longest prefix of `s` within `max` UTF-8 bytes, never splitting a code point. */
function clipBytes(s: string, max: number): string {
  const b = utf8.encode(s);
  if (b.length <= max) return s;
  let n = max;
  while (n > 0 && (b[n]! & 0xc0) === 0x80) n--; // back off continuation bytes to the start of a code point
  return new TextDecoder().decode(b.subarray(0, n));
}

const cutValues = (v: unknown, n: number): unknown => {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n - 1)}…` : v;
  if (Array.isArray(v)) return v.map((x) => cutValues(x, n));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutValues(x, n)]));
  return v;
};

/** §14.4 the input as JSON ≤ 2 KB: string values cut harder until it fits (paths and commands survive the first cut). */
export function trimInput(input: unknown): string {
  for (const n of VALUE_CUTS) {
    const j = JSON.stringify(cutValues(input ?? {}, n));
    if (utf8.encode(j).length <= INPUT_MAX) return j;
  }
  return clipBytes(JSON.stringify(cutValues(input ?? {}, VALUE_CUTS.at(-1)!)), INPUT_MAX);
}

const linesOf = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/** Lines added / removed between two texts (LCS on lines). */
function lineDiff(before: string, after: string): { add: number; del: number } {
  const a = linesOf(before), b = linesOf(after);
  if (a.length * b.length > DIFF_CELLS) return { add: b.length, del: a.length };
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 0; j < b.length; j++) cur[j + 1] = x === b[j] ? prev[j]! + 1 : Math.max(prev[j + 1]!, cur[j]!);
    prev = cur;
  }
  const same = prev[b.length]!;
  return { add: b.length - same, del: a.length - same };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** §14.4 `+n −m` of Edit / Write / MultiEdit, from the input; undefined for every other tool. */
export function toolDiff(name: string, input: unknown): { add: number; del: number } | undefined {
  const i = isObj(input) ? input : {};
  if (name === 'Edit') return lineDiff(str(i.old_string), str(i.new_string));
  if (name === 'Write') return { add: linesOf(str(i.content)).length, del: 0 };
  if (name === 'MultiEdit') {
    const edits = Array.isArray(i.edits) ? i.edits.filter(isObj) : [];
    return edits.map((e) => lineDiff(str(e.old_string), str(e.new_string))).reduce((s, d) => ({ add: s.add + d.add, del: s.del + d.del }), { add: 0, del: 0 });
  }
  return undefined;
}

/** §14.4 the tool_result text ≤ 8 KB (newlines kept) + `truncated` and the total line count when cut. */
export const RESULT_MAX = 8 * 1024;
export function resultDetail(full: string): { result: string; truncated?: true; totalLines?: number } {
  const result = clipBytes(full, RESULT_MAX);
  return result.length === full.length ? { result } : { result, truncated: true, totalLines: linesOf(full).length };
}

const EXIT_LINE = /^Exit code (\d+)(?:\n|$)/;
/** §14.5 S5 Claude Code's failed Bash result opens with an "Exit code k" line: k + the text after that line; else null. */
export function exitCodeOf(full: string): { exitCode: number; rest: string } | null {
  const m = EXIT_LINE.exec(full);
  return m ? { exitCode: Number(m[1]), rest: full.slice(m[0].length) } : null;
}
