// spec v2.2 §14.5 a Markdown code block: language label, "Chép" (dim with "đang stream" until the fence closes, C32),
// plain mono until the lazy highlighter arrives; highlighted when it closes, at most every 250 ms while it grows.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { hlDelay, loadHighlighter, type HlNode } from '../lib/highlight.ts';
import { useT } from '../lib/i18n.tsx';
import { copyText } from '../lib/links.ts';
import { Icon } from './icons.tsx';

const nodes = (ns: HlNode[]): ReactNode[] => ns.map((n, i) => (typeof n === 'string' ? n : <span key={i} className={n.c || undefined}>{nodes(n.k)}</span>));

export function CodeBlock({ code, lang, closed }: { code: string; lang: string; closed: boolean }): ReactElement {
  const tr = useT();
  const [hl, setHl] = useState<{ code: string; ns: HlNode[] } | null>(null);
  const lastAt = useRef(0);
  useEffect(() => {
    if (!lang) return;
    let live = true;
    const id = setTimeout(() => {
      void loadHighlighter().then(h => {
        if (!live) return;
        lastAt.current = performance.now();
        const ns = h(code, lang);
        setHl(ns ? { code, ns } : null);
      });
    }, hlDelay(lastAt.current, performance.now(), closed));
    return () => { live = false; clearTimeout(id); };
  }, [code, lang, closed]);
  // a growing block keeps its last colours and shows the newer text plain behind them
  const body = hl && code.startsWith(hl.code) ? [...nodes(hl.ns), code.slice(hl.code.length)] : code;
  return <div className="md-cb-wrap" role="group" aria-label={tr('stream.codeLabel', { lang: lang || 'text' })}>
    <div className="md-cb-hd">
      <span>{lang}</span>
      <button type="button" className="md-copy" disabled={!closed} onClick={() => copyText(code)}>
        <Icon n="copy" s={13} />{closed ? tr('stream.copy') : tr('stream.copyStreaming')}
      </button>
    </div>
    <pre><code>{body}</code></pre>
  </div>;
}
