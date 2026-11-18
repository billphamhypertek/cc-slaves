// spec v2.3 §6.2 / §5.2 (R15) syntax colours in the Git diff: the file's Lezer language (the Code view's lazy `cm-<lang>`
// chunks, `code/lang.ts`) parses each side and the §5.2 palette (`SYNTAX`, shared with the editor) colours the tokens. Loaded
// lazily by the diff pane the first time a diff shows: CodeMirror never reaches the first paint (§10.3).
import { Language, LanguageSupport } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { highlightTree, tagHighlighter } from '@lezer/highlight';
import type { CSSProperties } from 'react';
import { SYNTAX } from '../code/editor.ts';
import { langOf } from '../code/file-view.ts';
import { loadLang } from '../code/lang.ts';
import { lineSegs, type Seg } from './diff.ts';

const hl = tagHighlighter(SYNTAX.map((s, i) => ({ tag: s.tags, class: String(i) })));
const STYLES: CSSProperties[] = SYNTAX.map(s => ({ color: s.color, ...(s.bold ? { fontWeight: 700 } : {}), ...(s.italic ? { fontStyle: 'italic' } : {}) }));

const languageOf = (e: Extension): Language | null => (e instanceof LanguageSupport ? e.language : e instanceof Language ? e : null);

/** §10.3 a 1 MB side takes ~1 s to parse: work in slices of this many ms, yielding between them, so the diff stays scrollable. */
const SLICE_MS = 8;
const HL_CHUNK = 64 * 1024;
const pause = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function sideSegs(lang: Language, text: string, live: () => boolean): Promise<Seg[][] | null> {
  const parse = lang.parser.startParse(text);
  let t0 = performance.now();
  let tree = parse.advance();
  while (!tree) {
    if (performance.now() - t0 > SLICE_MS) { await pause(); if (!live()) return null; t0 = performance.now(); }
    tree = parse.advance();
  }
  const ranges: { from: number; to: number; c: number }[] = [];
  for (let from = 0; from < text.length; from += HL_CHUNK) {
    if (performance.now() - t0 > SLICE_MS) { await pause(); if (!live()) return null; t0 = performance.now(); }
    highlightTree(tree, hl, (f, to, cls) => ranges.push({ from: f, to, c: Number(cls.split(' ')[0]) }), from, Math.min(text.length, from + HL_CHUNK));
  }
  return lineSegs(text, ranges);
}

/** Per side, per line, the coloured runs; `styles[c]` = the palette entry. null = no language for this file, or `live()`
 *  turned false (another diff shows) before the work ended. */
export async function highlightSides(path: string, texts: readonly string[], live: () => boolean = () => true): Promise<{ sides: Seg[][][]; styles: CSSProperties[] } | null> {
  const id = langOf(path);
  const lang = id ? languageOf(await loadLang(id)) : null;
  if (!lang) return null;
  const sides: Seg[][][] = [];
  for (const t of texts) {
    const segs = await sideSegs(lang, t, live);
    if (!segs) return null;
    sides.push(segs);
  }
  return { sides, styles: STYLES };
}
