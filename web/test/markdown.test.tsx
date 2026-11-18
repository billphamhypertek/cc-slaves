// spec v2.2 §14.5 "Markdown" (C14, C30, C32) + §14.7: streaming-safe parsing, the React renderer (no HTML strings),
// link rule, code-block copy state, lazy highlighter, and "only the last block is lexed again".
import { afterEach, describe, expect, test } from 'bun:test';
import { Lexer, type Tokens } from 'marked';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import '../../shared/i18n/index.ts';
import { hlDelay, loadHighlighter } from '../src/lib/highlight.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { safeHref } from '../src/lib/links.ts';
import { closeStreaming, codeClosed, createSplitter, decodeEntities, holdTableTail } from '../src/lib/markdown.ts';
import { linkProps, Markdown } from '../src/ui/Markdown.tsx';

const html = (el: ReactElement, lang: 'vi' | 'en' = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const md = (text: string, streaming = false) => html(<Markdown text={text} streaming={streaming} />);

describe('§14.5 streaming rules', () => {
  test('§14.5 an unclosed ``` fence is already code (measured with marked) and its copy waits', () => {
    const toks = createSplitter().split('Sửa:\n\n```ts\nconst a = 1;\nconst', true);
    const code = toks.find(t => t.type === 'code') as Tokens.Code;
    expect(code.text).toBe('const a = 1;\nconst');
    expect(codeClosed(code, true)).toBe(false);
    const closed = createSplitter().split('```ts\nconst a = 1;\n```', true)[0]!;
    expect(codeClosed(closed, true)).toBe(true);
  });
  test('§14.5 a trailing `|` line waits for its delimiter row (no raw `|` flash)', () => {
    expect(holdTableTail('Bảng:\n\n| a | b |')).toBe('Bảng:\n');
    expect(holdTableTail('Bảng:\n| a | b |\n|---|')).toBe('Bảng:');
    expect(md('Kết quả:\n| tên | số |', true)).not.toContain('|');
  });
  test('§14.5 S3 a body row shows only once all its cells arrived', () => {
    const src = '| tên | số |\n|---|---|\n| a | 1 |\n| b';
    expect(holdTableTail(src)).toBe('| tên | số |\n|---|---|\n| a | 1 |');
    expect(holdTableTail('| tên | số |\n|---|---|\n| b |')).toBe('| tên | số |\n|---|---|');
    expect(holdTableTail('| tên | số |\n|---|---|\n| b | 2 |')).toBe('| tên | số |\n|---|---|\n| b | 2 |');
    const h = md(src, true);
    expect(h).toContain('<td>a</td>');
    expect(h).not.toContain('>b');
  });
  test('§14.5 a `|` line inside an open fence is code, never held', () => {
    expect(holdTableTail('```\n| a |')).toBe('```\n| a |');
  });
  test('§14.5 remend closes a dangling `**`, and a half link shows its text only', () => {
    expect(md('đây là **đậm', true)).toContain('<strong>đậm</strong>');
    expect(md('xem [tài liệu](https://exa', true)).toContain('tài liệu');
    expect(md('xem [tài liệu](https://exa', true)).not.toContain('<a');
  });
  test('§14.5 remend known bug: `**đậm và `code` nests the code inside the bold', () => {
    expect(closeStreaming('**đậm và `code')).toBe('**đậm và `code`**');
    expect(md('**đậm và `code', true)).toContain('<strong>đậm và <code>code</code></strong>');
  });
  test('§14.5 a finished text is not touched by the streaming fixes', () => {
    expect(md('a ** b')).toContain('a ** b');
  });
});

describe('§14.5 GFM renderer from tokens', () => {
  test('§14.5 headings 14 / 13 px classes, lists with tasks, quote, table scrolls in its own box, rule', () => {
    const h = md('# Lớn\n\n### Nhỏ\n\n- [x] xong\n- [ ] chưa\n  1. con\n\n> trích\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n---\n\n~~gạch~~ *nghiêng*');
    expect(h).toContain('<h1 class="md-h md-h1">Lớn</h1>');
    expect(h).toContain('<h3 class="md-h">Nhỏ</h3>');
    expect(h).toContain('<li class="md-task"><input type="checkbox" class="md-cb" readonly="" disabled="" checked=""/><span>xong</span></li>');
    expect(h).toContain('<ol start="1">');
    expect(h).toContain('<blockquote><p>trích</p></blockquote>');
    expect(h).toContain('<div class="md-tw"><table>');
    expect(h).toContain('<td style="text-align:right">2</td>');
    expect(h).toContain('<hr/>');
    expect(h).toContain('<del>gạch</del> <em>nghiêng</em>');
  });
  test('§14.2 raw HTML is escaped text, never run (XSS)', () => {
    const h = md('<script>alert(1)</script>\n\nchữ <img src=x onerror=alert(1)> <b>x</b>');
    expect(h).not.toContain('<script');
    expect(h).not.toContain('<img');
    expect(h).not.toContain('<b>');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  test('§14.5 C30 javascript: / data: / file: / vbscript: / relative links are plain text', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x', '/c/12', '../a', 'JaVaScRiPt:alert(1)']) {
      expect(safeHref(href)).toBeNull();
      const h = md(`[bấm](${href})`);
      expect(h).not.toContain('<a');
      expect(h).toContain('bấm');
    }
  });
  test('§14.5 C30 http / https / mailto become links with the domain on hover, opened outside', () => {
    expect(md('[docs](https://code.claude.com/docs)')).toContain('<a class="md-a" href="https://code.claude.com/docs" title="code.claude.com" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(md('[thư](mailto:po@example.com)')).toContain('title="po@example.com"');
  });
  test('§14.2 an image is a link carrying its alt text', () => {
    const h = md('![sơ đồ](https://x.dev/a.png)');
    expect(h).toContain('<a class="md-a" href="https://x.dev/a.png"');
    expect(h).toContain('>sơ đồ</a>');
    expect(h).not.toContain('<img');
  });
});

describe('§14.5 HTML entities in prose', () => {
  test('§14.5 `&amp;` `&lt;` `&gt;` `&quot;` and numeric refs in prose show as their character, once (never `&amp;amp;`)', () => {
    expect(md('c &amp; d')).toContain('<p>c &amp; d</p>');
    expect(md('x &lt;y&gt; &quot;q&quot; &#x41;&#66;')).toContain('<p>x &lt;y&gt; &quot;q&quot; AB</p>');
    expect(md('**b &amp; c**')).toContain('<strong>b &amp; c</strong>');
  });
  test('§14.5 a code span keeps its entity text literal (CommonMark)', () => {
    expect(md('`a &amp; b`')).toContain('<code>a &amp;amp; b</code>');
  });
  test('§14.5 one decoder: the highlighter unescapes with the same helper', () => {
    expect(decodeEntities('&lt;a href=&quot;x&quot;&gt; &#x27;&#39; &amp;lt;')).toBe('<a href="x"> \'\' &lt;');
  });
});

describe('§14.5 C30 a link never navigates the app window', () => {
  const realWindow = globalThis.window;
  afterEach(() => { globalThis.window = realWindow; });
  test('§14.5 C30 an app-origin link opens in the system browser and the click is cancelled', () => {
    const opened: unknown[][] = [];
    globalThis.window = { open: (...a: unknown[]) => { opened.push(a); return null; } } as unknown as typeof window;
    let prevented = false;
    const p = linkProps(safeHref('http://127.0.0.1:47800/c/12')!);
    p.onClick({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(opened).toEqual([['http://127.0.0.1:47800/c/12', '_blank', 'noopener,noreferrer']]);
    expect(p.target).toBe('_blank');
  });
});

describe('§14.5 C32 code block', () => {
  test('§14.5 C32 "Chép" is dim with "đang stream" until the fence closes, then plain "Chép"', () => {
    const open = md('```ts\nconst a', true);
    expect(open).toContain('disabled=""');
    expect(open).toContain('Chép · đang stream');
    const done = md('```ts\nconst a\n```', true);
    expect(done).not.toContain('disabled');
    expect(done).toContain('>Chép</button>');
    expect(md('```ts\nconst a', true).replace(/<[^>]+>/g, '')).toContain('const a');
  });
  test('§14.5 English labels', () => {
    expect(html(<Markdown text={'```ts\nx'} streaming />, 'en')).toContain('Copy · streaming');
  });
  test('§14.5 a block is plain mono before the highlighter loads (no colour classes in the first paint)', () => {
    expect(md('```ts\nconst a = "x";\n```')).not.toContain('hl-');
  });
  test('§14.5 highlight on close, at most every 250 ms while the block grows', () => {
    expect(hlDelay(1000, 1100, false)).toBe(150);
    expect(hlDelay(1000, 1300, false)).toBe(0);
    expect(hlDelay(1000, 1100, true)).toBe(0);
  });
  test('§14.5 the lazy highlighter colours ts, aliases sh → bash, leaves an unknown language plain', async () => {
    const h = await loadHighlighter();
    const ns = h('const a = "<x>"; // c', 'ts')!;
    const flat = JSON.stringify(ns);
    expect(flat).toContain('{"c":"hl-k","k":["const"]}');
    expect(flat).toContain('{"c":"hl-s","k":["\\"<x>\\""]}');
    expect(flat).toContain('{"c":"hl-c","k":["// c"]}');
    expect(h('ls -la', 'sh')).not.toBeNull();
    expect(h('x', 'cobol')).toBeNull();
    expect(await loadHighlighter()).toBe(h);
  });
  test('§14.5 the highlighter is a lazy chunk: nothing imports highlight.js statically but lib/hljs.ts', () => {
    expect(readFileSync('web/src/lib/highlight.ts', 'utf8')).not.toMatch(/^import .*highlight\.js/m);
    expect(readFileSync('web/src/lib/highlight.ts', 'utf8')).toContain("import('./hljs.ts')");
  });
});

describe('§14.5 "Hiệu năng": only the last block is lexed again', () => {
  test('§14.5 finished blocks keep their token objects; each call lexes only the tail', () => {
    const lexed: string[] = [];
    const s = createSplitter(src => { lexed.push(src); return Lexer.lex(src); });
    const a = s.split('Đoạn một.\n\nĐoạn hai', true);
    lexed.length = 0;
    const b = s.split('Đoạn một.\n\nĐoạn hai dài hơn.\n\n- mục', true);
    expect(b[0]).toBe(a[0]);
    expect(lexed.every(src => !src.includes('Đoạn một'))).toBe(true);
    lexed.length = 0;
    s.split('Đoạn một.\n\nĐoạn hai dài hơn.\n\n- mục một', true);
    expect(lexed.join('')).not.toContain('Đoạn hai');
  });
  test('§14.5 a replaced text (new `full`) starts over', () => {
    const s = createSplitter();
    s.split('Một.\n\nHai', true);
    const t = s.split('Khác hẳn.\n\nBa', false);
    expect(t.map(x => x.raw).join('')).toBe('Khác hẳn.\n\nBa');
  });
  test('§14.5 split + render equal a one-shot lex of the whole text', () => {
    const full = '# T\n\nĐoạn **đậm**.\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n- y\n';
    const s = createSplitter();
    for (let i = 1; i <= full.length; i += 7) s.split(full.slice(0, i), true);
    expect(s.split(full, false).map(t => t.raw).join('')).toBe(full);
    expect(md(full)).toBe(html(<Markdown text={full} />));
  });
  const shape = (toks: readonly { type: string }[]) => toks.filter(t => t.type !== 'space')
    .map(t => (t.type === 'list' ? `list[${(t as Tokens.List).items.length}${(t as Tokens.List).loose ? 'L' : ''}]` : t.type)).join(' | ');
  const SHAPES: Record<string, string> = {
    looseOl: '1. Chạy test\n\n1. Sửa lỗi\n\n1. Commit',
    fenceInList: '- a\n\n  ```ts\n  const x = 1;\n  ```\n\n- b',
    lazyQuote: '> một\n\n> hai\n\nĐoạn sau.',
    fenceInOl: '1. a\n\n   ```\n   x\n   ```\n\n2. b',
    listThenPara: '- a\n- b\n\nĐoạn sau.\n\n- c',
  };
  for (const [name, text] of Object.entries(SHAPES)) {
    test(`§14.5 incremental == Lexer.lex for ${name} (any delta cut), while streaming and when done`, () => {
      for (const step of [1, 3, 7]) {
        const s = createSplitter();
        for (let i = step; i < text.length; i += step) s.split(text.slice(0, i), true);
        expect(shape(s.split(text, true)), `step ${step} streaming`).toBe(shape(Lexer.lex(text)));
        expect(shape(s.split(text, false)), `step ${step} done`).toBe(shape(Lexer.lex(text)));
      }
    });
  }
  test('§14.5 lazy numbering renders 1. 2. 3. after streaming (one <ol>, three items)', () => {
    const text = SHAPES.looseOl!, s = createSplitter();
    for (let i = 1; i < text.length; i++) s.split(text.slice(0, i), true);
    const done = s.split(text, false).filter(t => t.type === 'list');
    expect(done.map(t => (t as Tokens.List).items.length)).toEqual([3]);
  });
  test('§14.5 a done text is lexed once: the same call again lexes nothing and returns the same tokens', () => {
    let n = 0;
    const s = createSplitter(src => { n++; return Lexer.lex(src); });
    const a = s.split('Một.\n\n- a\n- b', false);
    n = 0;
    expect(s.split('Một.\n\n- a\n- b', false)).toBe(a);
    expect(n).toBe(0);
  });
  test('§14.5 CRLF text is read as LF', () => {
    expect(createSplitter().split('a\r\n\r\nb', false).map(t => t.type)).toEqual(['paragraph', 'space', 'paragraph']);
  });
});
