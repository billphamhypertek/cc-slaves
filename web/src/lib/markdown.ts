// spec v2.2 §14.5 "Markdown" (C14) + "Hiệu năng": streaming-safe block splitting for the React renderer
// (web/src/ui/Markdown.tsx). `marked` lexes, `remend` closes the dangling `**` / `` ` `` / link of the last block,
// a `|` line waits for its delimiter row, and only the last top-level block is lexed again while text streams.
import { Lexer, type Token, type TokensList } from 'marked';
import remend from 'remend';

/** spec v2.2 §14.5 the chat style; v2.3 §10.1 `'doc'` = "Đọc" of a project file. */
export type MdMode = 'chat' | 'doc';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A GFM delimiter row: `| --- | :-: |`. */
const DELIM_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isPipeLine = (l: string) => l.trimStart().startsWith('|');
/** cells of a `| a | b |` row (escaped `\|` stays inside a cell) */
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).length;

/** Is the end of `src` inside an open ``` / ~~~ fence? */
function inOpenFence(lines: string[]): boolean {
  let open: string | null = null;
  for (const l of lines) {
    const m = FENCE.exec(l);
    if (!m) continue;
    const mark = m[1]!;
    if (open === null) open = mark;
    else if (mark[0] === open[0] && mark.length >= open.length && l.trim() === mark) open = null;
  }
  return open !== null;
}

/** §14.5 a streaming table never flashes raw `|`: the trailing `|` lines wait for their delimiter row, and a body row
 *  that has not ended (no closing `|`) waits for the rest of its cells. */
export function holdTableTail(src: string): string {
  const lines = src.split('\n');
  const lastLine = lines[lines.length - 1]!;
  if (!isPipeLine(lastLine) || inOpenFence(lines)) return src;
  let start = lines.length - 1;
  while (start > 0 && isPipeLine(lines[start - 1]!)) start--;
  // the delimiter must be a complete line (not the last one, which is still arriving)
  const hasDelim = lines.slice(start + 1, -1).some(l => DELIM_ROW.test(l));
  if (!hasDelim) return lines.slice(0, start).join('\n');
  const rowDone = lastLine.trimEnd().endsWith('|') && cells(lastLine) >= cells(lines[start]!);
  return rowDone ? src : lines.slice(0, -1).join('\n');
}

/** Single backticks outside the fences of a block: an odd count means an open `inline code`. */
function openInlineCode(src: string): boolean {
  if (inOpenFence(src.split('\n'))) return false;
  const bare = src.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm, '').replace(/``+/g, '');
  return (bare.match(/`/g)?.length ?? 0) % 2 === 1;
}

/** §14.5 close what the last streaming block left open. remend alone closes `**đậm và \`code` as
 *  `**đậm và \`code**\`` (the `**` lands inside the code span); closing the code span first gives the right nesting. */
export function closeStreaming(src: string): string {
  const held = holdTableTail(src);
  return remend(openInlineCode(held) ? held + '`' : held, { linkMode: 'text-only' });
}

/** A fenced code token is closed once its closing fence arrived; the last streaming indented block is still growing. */
export function codeClosed(tok: Token, streamingLast: boolean): boolean {
  if (tok.type !== 'code' || !streamingLast) return true;
  const m = FENCE.exec(tok.raw);
  if (!m) return false;
  const lines = tok.raw.trimEnd().split('\n');
  const end = lines[lines.length - 1]!.trim();
  return lines.length > 1 && end[0] === m[1]![0] && end.length >= m[1]!.length && /^(`+|~+)$/.test(end);
}

const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"' };
/** `&amp;` `&lt;` `&gt;` `&quot;` and numeric `&#39;` / `&#x27;` → their character, one pass (never decodes twice). */
export const decodeEntities = (s: string): string => s.replace(/&(amp|lt|gt|quot|#\d{1,7}|#[xX][\da-fA-F]{1,6});/g, (m, e: string) => {
  if (e[0] !== '#') return NAMED[e]!;
  const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
});

const lastSolid = (toks: Token[]) => { let i = toks.length - 1; while (i >= 0 && toks[i]!.type === 'space') i--; return i; };
const rawLen = (toks: Token[]) => toks.reduce((n, t) => n + t.raw.length, 0);

export type Lex = (src: string) => TokensList | Token[];
export interface MdSplitter {
  /** top-level tokens of `text`; blocks before the last keep their token objects between calls (memo by identity) */
  split(text: string, streaming: boolean): Token[];
}

/** The finished blocks of `toks` (cut = the last solid one): all before it, minus a trailing list — a list can still
 *  take the next item after a blank line (loose, lazily numbered), so it is finished only once another block follows.
 *  A quote needs no such rule: `>` after a blank line is a new quote in CommonMark (fuzzed, no shape differs). */
function finished(toks: Token[], cut: number): Token[] {
  if (cut <= 0) return [];
  const prev = lastSolid(toks.slice(0, cut));
  return prev >= 0 && toks[prev]!.type === 'list' ? toks.slice(0, prev) : toks.slice(0, cut);
}

/** §14.5 "Hiệu năng": finished blocks are lexed once; each call lexes only from the last finished block on. A done
 *  text is lexed once whole (the streamed split can never leave its shape behind) and kept until the text changes. */
export function createSplitter(lex: Lex = src => Lexer.lex(src)): MdSplitter {
  let stable: Token[] = [], prefix = '';
  let whole: { text: string; toks: Token[] } | null = null;
  return {
    split(input, streaming) {
      const text = input.includes('\r') ? input.replace(/\r\n?/g, '\n') : input;
      if (!streaming) {
        if (whole?.text !== text) whole = { text, toks: [...lex(text)] };
        stable = []; prefix = ''; // streaming again (a new `full`) starts from the whole text
        return whole.toks;
      }
      whole = null;
      if (!text.startsWith(prefix)) { stable = []; prefix = ''; }
      const tail = text.slice(prefix.length);
      let toks = [...lex(tail)];
      if (rawLen(toks) !== tail.length) { stable = []; prefix = ''; toks = [...lex(text)]; }
      const cut = lastSolid(toks);
      // every block before the last solid one is finished: it moves into the stable prefix
      const done = finished(toks, cut);
      stable = stable.concat(done); prefix += done.map(t => t.raw).join('');
      const rest = toks.slice(done.length);
      if (cut < 0) return stable.concat(rest);
      const lastSrc = rest.map(t => t.raw).join('');
      return stable.concat(lex(closeStreaming(lastSrc)));
    },
  };
}
