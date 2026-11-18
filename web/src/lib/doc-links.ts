// spec v2.3 §10.1 Markdown bullet + §5.2 "Đọc": what a link / image of a project Markdown file may become. A relative
// href resolves against the md file's dir and is normalised here; the engine then checks it against the root (§10.2)
// before it turns into a Code link or an image. Outside the root, absolute, odd schemes → plain text.
import { Lexer, type Token, type Tokens } from 'marked';
import { safeHref } from './links.ts';

export type HrefKind =
  | { k: 'file'; path: string } // root-relative, normalised, still to be checked by the engine
  | { k: 'ext'; url: string }   // http / https / mailto: the system browser (C30)
  | { k: 'anchor'; id: string } // `#x` inside the doc
  | { k: 'text' };              // shown as its text only

const TEXT: HrefKind = { k: 'text' };
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** §10.1 classify `href` written in the md file at root-relative `mdPath`. */
export function classifyHref(href: string, mdPath: string): HrefKind {
  const h = href.trim();
  if (h.startsWith('#')) return h.length > 1 ? { k: 'anchor', id: safeDecode(h.slice(1)) ?? '' } : TEXT;
  if (SCHEME.test(h)) { const url = safeHref(h); return url ? { k: 'ext', url } : TEXT; }
  // absolute, protocol-relative, Windows-style or control characters: never a path the web may send
  if (!h || h.startsWith('/') || odd(h)) return TEXT;
  const rel = safeDecode(h.replace(/[?#].*$/s, ''));
  if (!rel || odd(rel)) return TEXT;
  const out = mdPath.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return TEXT; out.pop(); } else out.push(seg);
  }
  return out.length ? { k: 'file', path: out.join('/') } : TEXT;
}

/** a backslash or a control character: never part of a path the web sends */
const odd = (s: string) => s.includes('\\') || [...s].some(c => c.charCodeAt(0) < 0x20);

function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
/** §10.1 the only images drawn: a data URL of one of the §5.2 types, as returned by the engine. */
const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z\d+/=]*$/;
export const isImagePath = (p: string) => IMAGE_EXT.test(p);
const safeImageUrl = (u: string | null | undefined): string | null => (u && IMAGE_URL.test(u) ? u : null);

/** Every token of a tree (lists, tables, nested inline tokens). */
function walk(toks: readonly Token[], fn: (t: Token) => void): void {
  for (const t of toks) {
    fn(t);
    if ('tokens' in t && t.tokens) walk(t.tokens, fn);
    if (t.type === 'list') walk((t as Tokens.List).items, fn);
    if (t.type === 'table') {
      const tb = t as Tokens.Table;
      for (const c of [...tb.header, ...tb.rows.flat()]) walk(c.tokens, fn);
    }
  }
}

/** The plain text of inline tokens (a heading's TOC label). */
function plainText(toks: readonly Token[] | undefined): string {
  return (toks ?? []).map(t => ('tokens' in t && t.tokens ? plainText(t.tokens) : 'text' in t ? String(t.text) : '')).join('');
}

/** GitHub-style slug: lower case, letters / digits / `-` / `_` kept, spaces → `-`. */
export const headingSlug = (s: string): string => s.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

export interface DocHeading { depth: number; text: string; id: string }

/** §10.1 the anchors of the top-level headings of `toks`, unique like GitHub (`x`, `x-1`, …), keyed by token. */
export function headingIds(toks: readonly Token[]): Map<Token, DocHeading> {
  const seen = new Map<string, number>();
  const out = new Map<Token, DocHeading>();
  for (const t of toks) {
    if (t.type !== 'heading') continue;
    const h = t as Tokens.Heading;
    const text = plainText(h.tokens);
    const base = headingSlug(text) || 'h';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(t, { depth: h.depth, text, id: n ? `${base}-${n}` : base });
  }
  return out;
}

export const docHeadings = (text: string): DocHeading[] => [...headingIds(Lexer.lex(text)).values()];

/** §5.2 the TOC lists headings up to h3; a single h1 is the doc's title and stays out. */
export function tocEntries(hs: readonly DocHeading[]): DocHeading[] {
  const h1 = hs.filter(h => h.depth === 1).length;
  return hs.filter(h => h.depth <= 3 && !(h1 === 1 && h.depth === 1));
}

/** §5.2 the TOC shows with ≥ 3 headings and a pane ≥ 720 px. */
export const showToc = (headings: number, width: number) => headings >= 3 && width >= 720;

export interface DocChecked {
  /** root-relative path → the engine's path, or null (refused) */
  links: ReadonlyMap<string, string | null>;
  /** root-relative image path → a safe data URL, or null */
  images: ReadonlyMap<string, string | null>;
}
export type ResolveLink = (rel: string) => Promise<{ ok: true; path: string } | { ok: false }>;
export type LoadImage = (rel: string) => Promise<string | null>;

/** §10.1 ask the engine once per relative link / image of the doc. A failing call counts as refused. */
export async function checkDoc(text: string, mdPath: string, resolveLink: ResolveLink, loadImage: LoadImage): Promise<DocChecked> {
  const links = new Set<string>(), images = new Set<string>();
  walk(Lexer.lex(text), t => {
    if (t.type !== 'link' && t.type !== 'image') return;
    const k = classifyHref((t as Tokens.Link).href, mdPath);
    if (k.k !== 'file') return;
    if (t.type === 'link') links.add(k.path);
    else if (isImagePath(k.path)) images.add(k.path);
  });
  const [l, i] = await Promise.all([
    Promise.all([...links].map(async p => [p, await resolveLink(p).then(r => (r.ok ? r.path : null), () => null)] as const)),
    Promise.all([...images].map(async p => [p, safeImageUrl(await loadImage(p).catch(() => null))] as const)),
  ]);
  return { links: new Map(l), images: new Map(i) };
}
