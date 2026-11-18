/**
 * The scrollbar half of `check:structure` (spec v2.4 §6.8 D54, R36 I1). Two rules over `web/src`:
 *  - `scrollbar-rule@<file>`: `scrollbar-width` / `scrollbar-color` (CSS or a `style` key) anywhere — either one turns every
 *    `::-webkit-scrollbar` rule off — and `::-webkit-scrollbar` outside `web/src/styles.css` (the D54 block is its one home).
 *  - `scroll-anim@web/src`: a scroll box (`overflow: auto | scroll | overlay`) whose class / id is the subject of an `animation`
 *    rule, matched across every rule of every CSS file: `[data-sb=off]:not(:hover)` would replace that animation and a re-hover
 *    would replay it (the `.amenu` drop-in, measured).
 * Test files are not scanned.
 */
import { isTypeScaleFile, LITERAL_RULES, type Hit } from './type-scale';

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const STD = /scrollbar-(?:width|color)\s*:|scrollbar(?:Width|Color)\s*:/g;
const WEBKIT = /::-webkit-scrollbar/g;

/** The forbidden scrollbar declarations / selectors of one file. Pure. */
export function scanScrollbarRules(file: string, text: string): Hit[] {
  if (!isTypeScaleFile(file)) return [];
  const hits: Hit[] = [];
  const res = file === 'web/src/styles.css' ? [STD] : [STD, WEBKIT];
  for (const re of res) for (const m of text.matchAll(re)) hits.push({ file, line: lineAt(text, m.index), text: m[0] });
  return hits.sort((a, b) => a.line - b.line);
}

/** innermost `selector{declarations}` (an @media wrapper is skipped, its rules are still read) */
const RULE = /([^{}]+)\{([^{}]*)\}/g;
const OVERFLOW = /(?:^|;)\s*overflow(?:-[xy])?\s*:\s*(?:auto|scroll|overlay)\b/;
const ANIMATED = /(?:^|;)\s*animation(?:-name)?\s*:\s*(?!none\b)/;

/** split at top-level commas (not inside `:is(…)`) */
function splitTop(sel: string, sep: (c: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const c of sel) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (depth === 0 && sep(c)) { out.push(cur); cur = ''; } else cur += c;
  }
  return [...out, cur].map((s) => s.trim()).filter(Boolean);
}

/** the class / id tokens of the subject (last compound) of each selector; a pseudo-element subject is not the box */
function subjects(selectorList: string): string[][] {
  return splitTop(selectorList, (c) => c === ',').flatMap((sel) => {
    const last = splitTop(sel.replace(/\s*[>+~]\s*/g, ' '), (c) => /\s/.test(c)).pop() ?? '';
    if (last.includes('::')) return [];
    const tokens = last.replace(/:not\([^)]*\)/g, '').match(/[.#][\w-]+/g) ?? [];
    return tokens.length ? [tokens] : [];
  });
}

interface Rule { file: string; line: number; sel: string; tokens: string[][] }

function rules(files: ReadonlyMap<string, string>, decl: RegExp): Rule[] {
  const out: Rule[] = [];
  for (const [file, raw] of files) {
    if (!file.endsWith('.css') || !isTypeScaleFile(file)) continue;
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of text.matchAll(RULE)) {
      if (!decl.test(m[2]!)) continue;
      const sel = m[1]!.trim();
      out.push({ file, line: lineAt(text, m.index + m[1]!.length - m[1]!.trimStart().length), sel, tokens: subjects(sel) });
    }
  }
  return out;
}

/** Each (scroll box rule, animated rule) pair sharing a subject class / id, across files. Pure. */
export function scanScrollAnim(files: ReadonlyMap<string, string>): Hit[] {
  const anim = rules(files, ANIMATED);
  const animated = new Set(anim.flatMap((r) => r.tokens.flat()));
  const hits: Hit[] = [];
  for (const box of rules(files, OVERFLOW)) {
    for (const token of new Set(box.tokens.flat())) {
      if (!animated.has(token)) continue;
      for (const a of anim.filter((r) => r.tokens.flat().includes(token))) {
        hits.push({ file: box.file, line: box.line, text: `${box.sel} ↔ ${a.file}:${a.line} ${a.sel}` });
      }
    }
  }
  return hits;
}

/** The per-file scan rules by pattern name: the D53 literal rules + `scrollbar-rule` (measure.ts counts them, the CLI lists hits). */
export const FILE_RULES: Readonly<Record<string, (file: string, text: string) => Hit[]>> = { ...LITERAL_RULES, 'scrollbar-rule': scanScrollbarRules };
/** the one cross-file key */
export const SCROLL_ANIM_KEY = 'scroll-anim@web/src';
