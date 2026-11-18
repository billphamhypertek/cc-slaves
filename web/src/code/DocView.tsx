// spec v2.3 §5.2 "Đọc" (C3, C17): a project .md / .mdx rendered by the v2.2 Markdown renderer in `mode: 'doc'`, with
// the table of contents on the right when it has ≥ 3 headings and the pane is ≥ 720 px. §10.1: relative links open in
// Code once the engine accepted them, http / https / mailto in the system browser, relative images come back from the
// engine as data URLs; anything else is plain text. The caller (Code pane) passes the engine-backed hooks.
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { checkDoc, classifyHref, docHeadings, isImagePath, showToc, tocEntries, type DocChecked, type LoadImage, type ResolveLink } from '../lib/doc-links.ts';
import { useT } from '../lib/i18n.tsx';
import { linkDomain } from '../lib/links.ts';
import { Markdown, MdDocContext, type MdDocHooks } from '../ui/Markdown.tsx';

export interface DocProps {
  /** the file's text */
  text: string;
  /** root-relative path of the md file (links resolve against its dir) */
  path: string;
  /** §10.1 the engine's root check of a normalised root-relative path */
  resolveLink: ResolveLink;
  /** §10.1 the engine's `fs_read` of an image → its data URL, or null */
  loadImage: LoadImage;
  /** open an accepted path in Code (preview tab, §5.4) */
  openInCode(path: string): void;
  /** the system browser (C30) */
  openExternal(url: string): void;
  /** §7 window < 1280 px (C17): the outline is hidden */
  narrow: boolean;
}

/** §5.2 / §7 the outline: ≥ 3 headings in a pane ≥ 720 px, never in a window < 1280 px (C17). */
export const tocShown = (headings: number, width: number, narrow: boolean): boolean => !narrow && showToc(headings, width);

const NONE: DocChecked = { links: new Map(), images: new Map() };

/** The "Đọc" view: checks the doc's links / images with the engine and measures the pane for the TOC. */
export function DocView(props: DocProps): ReactElement {
  const { text, path, resolveLink, loadImage } = props;
  const [checked, setChecked] = useState<DocChecked>(NONE);
  const [width, setWidth] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void checkDoc(text, path, resolveLink, loadImage).then(c => { if (live) setChecked(c); });
    return () => { live = false; };
  }, [text, path, resolveLink, loadImage]);
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div className="doc-pane" ref={pane}><DocBody {...props} checked={checked} width={width} /></div>;
}

/** The rendered doc once `checked` is known (pure render, unit-tested). */
export function DocBody({ text, path, checked, width, openInCode, openExternal, narrow }: Omit<DocProps, 'resolveLink' | 'loadImage'> & { checked: DocChecked; width: number }): ReactElement {
  const tr = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const toc = useMemo(() => tocEntries(docHeadings(text)), [text]);
  const [on, setOn] = useState(0);
  const jump = (id: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'start' });
  };
  const hooks = useMemo<MdDocHooks>(() => {
    const ext = (url: string, children: ReactNode) => <a className="md-a" href={url} title={linkDomain(url)} target="_blank" rel="noopener noreferrer"
      onClick={(e: MouseEvent) => { e.preventDefault(); openExternal(url); }}>{children}</a>;
    return {
      link(href, children) {
        const k = classifyHref(href, path);
        if (k.k === 'ext') return ext(k.url, children);
        if (k.k === 'anchor') return <a className="md-a" href={`#${k.id}`} onClick={(e: MouseEvent) => { e.preventDefault(); jump(k.id); }}>{children}</a>;
        const to = k.k === 'file' ? checked.links.get(k.path) : null;
        return to ? <a className="md-a" href="#" title={to} data-path={to} onClick={(e: MouseEvent) => { e.preventDefault(); openInCode(to); }}>{children}</a> : children;
      },
      image(href, alt) {
        const k = classifyHref(href, path);
        if (k.k === 'ext') return ext(k.url, alt);
        const src = k.k === 'file' && isImagePath(k.path) ? checked.images.get(k.path) : null;
        return src ? <img className="md-img" src={src} alt={alt} /> : alt;
      },
    };
  }, [path, checked, openInCode, openExternal]);
  const withToc = tocShown(toc.length, width, narrow);
  const spy = () => {
    const s = scroller.current;
    if (!s || !withToc) return;
    let i = 0;
    toc.forEach((h, j) => { const el = s.querySelector<HTMLElement>(`[id="${CSS.escape(h.id)}"]`); if (el && el.offsetTop <= s.scrollTop + 24) i = j; });
    setOn(i);
  };
  return <div className="mdw">
    <div className="mdw-scroll" ref={scroller} onScroll={spy}>
      <MdDocContext.Provider value={hooks}><Markdown text={text} mode="doc" /></MdDocContext.Provider>
    </div>
    {withToc && <nav className="md-toc" aria-label={tr('stream.toc')}>
      <div className="md-toc-h">{tr('stream.toc')}</div>
      {toc.map((h, i) => <a key={h.id} href={`#${h.id}`} className={`${i === on ? 'on' : ''}${h.depth === 3 ? ' d3' : ''}` || undefined}
        onClick={e => { e.preventDefault(); setOn(i); jump(h.id); }}>{h.text}</a>)}
    </nav>}
  </div>;
}
