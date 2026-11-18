// spec v2.2 §14.5 the highlighter chunk, loaded on the first code block (web/src/lib/highlight.ts): `highlight.js/lib/core`
// + 12 languages. hljs output is turned into nodes for React — never an HTML string in the DOM.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { HlNode } from './highlight.ts';
import { decodeEntities } from './markdown.ts';

for (const [name, lang] of Object.entries({ bash, css, diff, javascript, json, markdown, python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, lang);
hljs.registerAliases(['ts', 'tsx', 'mts', 'cts'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['patch'], { languageName: 'diff' });
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' });

/** hljs scope → the few colours of the "tài liệu gọn" style (Markdown.css); '' = no colour. */
const SCOPE: Record<string, string> = {
  keyword: 'hl-k', built_in: 'hl-k', literal: 'hl-k', type: 'hl-k', 'selector-tag': 'hl-k', meta: 'hl-k',
  string: 'hl-s', regexp: 'hl-s', symbol: 'hl-s', char: 'hl-s', 'template-string': 'hl-s',
  comment: 'hl-c', quote: 'hl-c', doctag: 'hl-c',
  title: 'hl-t', section: 'hl-t', name: 'hl-t', 'selector-id': 'hl-t', 'selector-class': 'hl-t', bullet: 'hl-t',
  number: 'hl-n', attr: 'hl-n', attribute: 'hl-n', variable: 'hl-n', property: 'hl-n',
  addition: 'hl-a', deletion: 'hl-d',
};
/** `hljs-title function_` → the class of `title`. */
const hlClass = (cls: string): string => SCOPE[cls.split(' ')[0]!.replace(/^hljs-/, '')] ?? '';


/** hljs' escaped `<span class="hljs-…">` output → nodes (only spans and text ever appear in it). */
function toNodes(html: string): HlNode[] {
  const root: HlNode[] = [], stack: HlNode[][] = [root];
  for (const m of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
    const top = stack[stack.length - 1]!;
    if (m[2] !== undefined) top.push(decodeEntities(m[2]));
    else if (m[1] !== undefined) { const k: HlNode[] = []; top.push({ c: hlClass(m[1]), k }); stack.push(k); }
    else if (stack.length > 1) stack.pop();
  }
  return root;
}

/** Highlighted nodes of `code`, or null for an unknown language (shown without colour). */
export function highlight(code: string, lang: string): HlNode[] | null {
  const l = lang.trim().toLowerCase();
  if (!l || !hljs.getLanguage(l)) return null;
  return toNodes(hljs.highlight(code, { language: l, ignoreIllegals: true }).value);
}
