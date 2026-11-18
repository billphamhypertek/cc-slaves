/**
 * The density half of `check:structure` (coding standard §1, §4 rows "Font size", "Spacing", "Bar offset"; spec v2.4 §6.7 D53).
 * Three literal rules over `web/src`, each ratcheted per file as pattern `<rule>@<file>` (new files: 0):
 *  - `font-literal`: every font size is a step of the one scale in `web/src/styles.css` `:root` (`TYPE_SCALE`, PO-owned);
 *    a literal size (`font-size: 12px`, `font: 600 11px/…`, `fontSize: 12`) is a hit. Allowed on purpose: sizes under 10 px
 *    (a glyph inside a small box), `em` / `%`, an SVG `fontSize={n}` attribute (viewBox units, not CSS pixels).
 *  - `space-literal`: a bare px in `padding` / `margin` / `gap` (CSS, and a `.tsx` `style` object: `padding: 8`,
 *    `margin: '0 6px'`) is a hit — spacing is `var(--s1…--s6)` (`SPACE`). `0`, a ratio (`padding: 0.2`) and `%` are not.
 *  - `bar-literal`: a px number in a CSS value that also reads `var(--bn` is a hit — an offset under the bars is a `calc()` of
 *    `--bn` + `--h-bar` + `--h-head` + a space token, never the bar height written out (`+ 102px`).
 * Test files are not scanned.
 */

/** The steps, in px (`var(--xxs)` … `var(--xxl)`); a test keeps `:root`, `lib/mono-font.ts` and the standard §4 row equal to this. */
export const TYPE_SCALE = { xxs: 11, xs: 12, sm: 13, md: 14, lg: 16, xl: 19, xxl: 25 } as const;
/** D53 spacing tokens `var(--s1)` … `var(--s6)`, in px. */
export const SPACE = { s1: 2, s2: 4, s3: 7, s4: 10, s5: 14, s6: 18 } as const;
/** D53 control heights `var(--h-…)`, in px: top bar, head bar, control / input, small control, Chờ PO row. */
export const HEIGHTS = { 'h-bar': 44, 'h-head': 28, 'h-ctl': 30, 'h-ctl-sm': 24, 'h-row': 32 } as const;

export interface Hit { file: string; line: number; text: string }

const SIZE = String.raw`([0-9]*\.?[0-9]+)(px|rem)`;
const FONT_RULES: readonly { re: RegExp; ext: RegExp }[] = [
  { re: new RegExp(String.raw`fontSize:\s*['"\`]?${SIZE.replace('(px|rem)', '(px|rem)?')}`, 'g'), ext: /\.(ts|tsx)$/ },
  { re: new RegExp(String.raw`font-size:\s*${SIZE}`, 'g'), ext: /\.css$/ },
  { re: new RegExp(String.raw`font:\s*(?:[a-z0-9-]+\s+)*?${SIZE}`, 'g'), ext: /\.css$/ },
];

const toPx = (n: string, unit: string | undefined): number => Number(n) * (unit === 'rem' ? 16 : 1);

export const isTypeScaleFile = (path: string): boolean =>
  path.startsWith('web/src/') && /\.(ts|tsx|css)$/.test(path) && !/\.test\.tsx?$/.test(path);

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The literal font sizes of one file (path relative to the repo root). Pure. */
export function scanFontLiterals(file: string, text: string): Hit[] {
  if (!isTypeScaleFile(file)) return [];
  const hits: Hit[] = [];
  for (const { re, ext } of FONT_RULES) {
    if (!ext.test(file)) continue;
    for (const m of text.matchAll(re)) {
      if (toPx(m[1]!, m[2]) < 10) continue;
      hits.push({ file, line: lineAt(text, m.index), text: m[0] });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** every non-zero `<n>px` of a value (so a `var(--bn,0px)` fallback is not one) */
const PX = /(?<![\w.#-])-?([0-9]*\.?[0-9]+)px\b/g;
const pxCount = (value: string): number => [...value.matchAll(PX)].filter((m) => Number(m[1]) > 0).length;

/** `padding*` / `margin*` / `gap` / `row-gap` / `column-gap` (not `scroll-margin`, not a custom property) */
const CSS_SPACE = /(?<![\w-])(?:padding|margin)(?:-[a-z-]+)?\s*:\s*([^;}]*)|(?<![\w-])(?:row-|column-)?gap\s*:\s*([^;}]*)/g;
/** a `style` key: `padding`, `paddingTop`, `marginInline`, `gap`, `rowGap` … with a number or a string value */
const TSX_SPACE = /\b(?:padding|margin)(?:[A-Z][a-zA-Z]*)?\s*:\s*(?:([0-9]+(?:\.[0-9]+)?)\b(?!\s*[%'"`])|(['"`])([^'"`]*)\2)|\b(?:gap|rowGap|columnGap)\s*:\s*(?:([0-9]+(?:\.[0-9]+)?)\b(?!\s*[%'"`])|(['"`])([^'"`]*)\5)/g;

/** The bare px in padding / margin / gap of one file. Pure. */
export function scanSpaceLiterals(file: string, text: string): Hit[] {
  if (!isTypeScaleFile(file)) return [];
  const hits: Hit[] = [];
  const put = (index: number, raw: string, n: number) => { for (let i = 0; i < n; i += 1) hits.push({ file, line: lineAt(text, index), text: raw }); };
  if (file.endsWith('.css')) {
    for (const m of text.matchAll(CSS_SPACE)) put(m.index, m[0].trim(), pxCount(m[1] ?? m[2] ?? ''));
  } else if (file.endsWith('.tsx')) {
    for (const m of text.matchAll(TSX_SPACE)) {
      const num = m[1] ?? m[4], str = m[3] ?? m[6];
      put(m.index, m[0], num !== undefined ? (Number(num) >= 1 ? 1 : 0) : pxCount(str ?? ''));
    }
  }
  return hits;
}

/** Every px number in a CSS value that reads `var(--bn` (the banner offset): a bar height written out. Pure. */
export function scanBarLiterals(file: string, text: string): Hit[] {
  if (!isTypeScaleFile(file) || !file.endsWith('.css')) return [];
  const hits: Hit[] = [];
  for (const m of text.matchAll(/[\w-]+\s*:\s*[^;{}]*var\(--bn\b[^;{}]*/g)) {
    for (let i = pxCount(m[0]); i > 0; i -= 1) hits.push({ file, line: lineAt(text, m.index), text: m[0] });
  }
  return hits;
}

/** The three literal rules by pattern name (measure.ts counts them per file; the CLI lists the hits of a red key). */
export const LITERAL_RULES: Readonly<Record<string, (file: string, text: string) => Hit[]>> = {
  'font-literal': scanFontLiterals,
  'space-literal': scanSpaceLiterals,
  'bar-literal': scanBarLiterals,
};
