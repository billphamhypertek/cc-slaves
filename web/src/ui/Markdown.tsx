// spec v2.2 §14.5 "Markdown" (C14): GFM from `marked` tokens to React elements — never an HTML string, never
// `dangerouslySetInnerHTML`. Raw HTML shows as text; only http / https / mailto become links, opened in the system
// browser (C30). Finished blocks keep their element (same object → React skips them); only the last block re-renders.
// spec v2.3 §10.1 `mode: 'doc'` ("Đọc" of a project file): headings carry anchors, links and images go through the
// hooks of `MdDocContext` (code/DocView.tsx); chat never sets the context, so chat stays exactly v2.2.
// spec v2.7 §4.5 (IS7) under `MdIssueContext` (the Deck's left column) the project's issue keys become chips that open Tasks.
import { createContext, createElement, useContext, useMemo, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import type { Token, Tokens } from 'marked';
import { linkDomain, openExternal, safeHref } from '../lib/links.ts';
import { headingIds, type DocHeading } from '../lib/doc-links.ts';
import { codeClosed, createSplitter, decodeEntities, type MdMode } from '../lib/markdown.ts';
import { useT } from '../lib/i18n.tsx';
import { splitKeys } from '../lib/traces.ts';
import { CodeBlock } from './CodeBlock.tsx';
import './markdown.css';

export interface MarkdownProps {
  /** the Markdown source (the shown part while it streams) */
  text: string;
  /** the text is still arriving: the last block is closed by `remend`, a code block's "Chép" waits */
  streaming?: boolean;
  /** spec v2.2 §14.5 the chat style; v2.3 §10.1 `'doc'` adds heading anchors */
  mode?: MdMode;
}

/** §10.1 how a doc draws its links and images; null (chat) → the v2.2 rule. */
export interface MdDocHooks {
  link(href: string, children: ReactNode): ReactNode;
  image(href: string, alt: string): ReactNode;
}
export const MdDocContext = createContext<MdDocHooks | null>(null);

/** v2.7 §4.5 the project's issue keys: `has` = a key of this project, `unseen` = orange, `open` = Tasks on it. */
export interface MdIssueHooks { has(key: string): boolean; unseen(key: string): boolean; open(key: string): void }
export const MdIssueContext = createContext<MdIssueHooks | null>(null);

function IssueKey({ k, iss }: { k: string; iss: MdIssueHooks }): ReactElement {
  const tr = useT();
  return <button type="button" className={`ich${iss.unseen(k) ? ' am' : ''}`} title={tr('deck.node.issueOpen', { key: k })} onClick={() => iss.open(k)}>{k}</button>;
}
/** Prose with the project's keys as chips (no context / no key → the text unchanged). */
function IssueText({ text }: { text: string }): ReactNode {
  const iss = useContext(MdIssueContext);
  if (!iss) return text;
  return <>{splitKeys(text, k => iss.has(k)).map((x, i) => (typeof x === 'string' ? x : <IssueKey key={i} k={x.key} iss={iss} />))}</>;
}
/** `T-47` in backticks: a chip when it is one of the project's keys, else code. */
function CodeOrKey({ text }: { text: string }): ReactNode {
  const iss = useContext(MdIssueContext);
  return iss?.has(text.trim()) ? <IssueKey k={text.trim()} iss={iss} /> : <code>{text}</code>;
}
const MAYBE_KEY = /\b[TB]-[1-9]/;
const prose = (text: string, key: number): ReactNode => (MAYBE_KEY.test(text) ? <IssueText key={key} text={text} /> : text);

/** §14.5 C30 the props of a link: always the system browser, never a navigation of the app window. */
export function linkProps(href: string): { href: string; title: string; target: '_blank'; rel: string; onClick: (e: Pick<MouseEvent, 'preventDefault'>) => void } {
  return { href, title: linkDomain(href), target: '_blank', rel: 'noopener noreferrer', onClick: e => { e.preventDefault(); openExternal(href); } };
}

function Link({ href, children }: { href: string; children: ReactNode }): ReactNode {
  const doc = useContext(MdDocContext);
  if (doc) return doc.link(href, children);
  const url = safeHref(href);
  return url ? <a className="md-a" {...linkProps(url)}>{children}</a> : <>{children}</>;
}

function Image({ href, alt }: { href: string; alt: string }): ReactNode {
  const doc = useContext(MdDocContext);
  return doc ? doc.image(href, alt) : <Link href={href}>{alt}</Link>;
}

function inline(toks: Token[] | undefined): ReactNode[] {
  return (toks ?? []).map((t, i) => inlineToken(t, i));
}
function inlineToken(t: Token, key: number): ReactNode {
  switch (t.type) {
    // marked leaves entity references of prose in `text`: shown as their character (React escapes them again)
    case 'text': return 'tokens' in t && t.tokens ? <span key={key}>{inline(t.tokens)}</span> : prose(decodeEntities((t as Tokens.Text).text), key);
    case 'strong': return <strong key={key}>{inline((t as Tokens.Strong).tokens)}</strong>;
    case 'em': return <em key={key}>{inline((t as Tokens.Em).tokens)}</em>;
    case 'del': return <del key={key}>{inline((t as Tokens.Del).tokens)}</del>;
    case 'codespan': return MAYBE_KEY.test((t as Tokens.Codespan).text) ? <CodeOrKey key={key} text={(t as Tokens.Codespan).text} /> : <code key={key}>{(t as Tokens.Codespan).text}</code>;
    case 'br': return <br key={key} />;
    case 'link': return <Link key={key} href={(t as Tokens.Link).href}>{inline((t as Tokens.Link).tokens)}</Link>;
    // §14.2 no images in chat Markdown: an image is a link carrying its alt text (a doc may draw it, §10.1)
    case 'image': return <Image key={key} href={(t as Tokens.Image).href} alt={(t as Tokens.Image).text} />;
    case 'escape': return (t as Tokens.Escape).text;
    case 'checkbox': return <input key={key} type="checkbox" className="md-cb" checked={(t as Tokens.Checkbox).checked} readOnly disabled />;
    default: return t.raw; // raw HTML and anything unknown: plain text
  }
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

type Ids = ReadonlyMap<Token, DocHeading> | undefined;

function block(t: Token, key: number, growing: boolean, ids?: Ids): ReactNode {
  switch (t.type) {
    case 'space': case 'def': return null;
    case 'paragraph': return <p key={key}>{inline((t as Tokens.Paragraph).tokens)}</p>;
    case 'text': return <p key={key}>{'tokens' in t && t.tokens ? inline(t.tokens) : decodeEntities((t as Tokens.Text).text)}</p>;
    case 'heading': {
      const h = t as Tokens.Heading;
      return createElement(HEADING_TAGS[h.depth - 1] ?? 'h6', { key, id: ids?.get(t)?.id, className: h.depth <= 2 ? 'md-h md-h1' : 'md-h' }, inline(h.tokens));
    }
    case 'blockquote': return <blockquote key={key}>{blocks((t as Tokens.Blockquote).tokens, false)}</blockquote>;
    case 'list': return listBlock(t as Tokens.List, key);
    case 'code': {
      const c = t as Tokens.Code;
      return <CodeBlock key={key} code={c.text} lang={c.lang ?? ''} closed={codeClosed(c, growing)} />;
    }
    case 'table': return tableBlock(t as Tokens.Table, key);
    case 'hr': return <hr key={key} />;
    case 'checkbox': return inlineToken(t, key);
    default: return <p key={key} className="md-raw">{t.raw}</p>; // block HTML: shown, never run
  }
}
const blocks = (toks: Token[], growing: boolean) => toks.map((t, i) => block(t, i, growing && i === toks.length - 1));

function listBlock(l: Tokens.List, key: number): ReactElement {
  const items = l.items.map((it, i) => (
    // a tight item's text is inline: no paragraph margin inside the list
    <li key={i} className={it.task ? 'md-task' : undefined}>{it.tokens.map((t, j) => (t.type === 'text' ? inlineToken(t, j) : block(t, j, false)))}</li>));
  return l.ordered ? <ol key={key} start={typeof l.start === 'number' ? l.start : undefined}>{items}</ol> : <ul key={key}>{items}</ul>;
}

function tableBlock(tb: Tokens.Table, key: number): ReactElement {
  const align = (i: number) => (tb.align[i] ? { textAlign: tb.align[i] } : undefined);
  // §14.5 a wide table scrolls sideways inside its block, it never pushes the column
  return <div key={key} className="md-tw"><table>
    <thead><tr>{tb.header.map((c, i) => <th key={i} style={align(i)}>{inline(c.tokens)}</th>)}</tr></thead>
    <tbody>{tb.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={align(j)}>{inline(c.tokens)}</td>)}</tr>)}</tbody>
  </table></div>;
}

/** §14.5 the streaming-safe renderer. */
export function Markdown({ text, streaming = false, mode = 'chat' }: MarkdownProps): ReactElement {
  const splitter = useMemo(() => createSplitter(), []);
  const finished = useMemo(() => new WeakMap<Token, ReactNode>(), []);
  const toks = useMemo(() => splitter.split(text, streaming), [splitter, text, streaming]); // a re-render with the same text lexes nothing
  const ids = useMemo(() => (mode === 'doc' ? headingIds(toks) : undefined), [mode, toks]);
  let last = toks.length - 1;
  while (last >= 0 && toks[last]!.type === 'space') last--;
  return <div className={mode === 'doc' ? 'md md-doc' : 'md md-chat'}>{toks.map((t, i) => {
    if (streaming && i >= last) return block(t, i, i === last, ids);
    let el = finished.get(t);
    if (el === undefined) { el = block(t, i, false, ids); finished.set(t, el); }
    return el;
  })}</div>;
}
