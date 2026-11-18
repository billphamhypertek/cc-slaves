// spec v2.2 §14.5 the lazy highlighter: the hljs chunk (web/src/lib/hljs.ts) loads on the first code block; a growing
// block is highlighted at most every 250 ms, a closed one at once. Unknown language → plain mono.

/** Text, or a span with one of the classes below. */
export type HlNode = string | { c: string; k: HlNode[] };
export type Highlight = (code: string, lang: string) => HlNode[] | null;

/** §14.5 a growing code block is highlighted at most this often. */
const HL_EVERY_MS = 250;

let loading: Promise<Highlight> | null = null;
/** The highlighter chunk, fetched once. */
export const loadHighlighter = (): Promise<Highlight> => (loading ??= import('./hljs.ts').then(m => m.highlight));

/** ms to wait before the next highlight of a block last highlighted at `lastAt` (0 = now). */
export const hlDelay = (lastAt: number, now: number, closed: boolean): number => (closed ? 0 : Math.max(0, lastAt + HL_EVERY_MS - now));
