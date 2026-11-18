// spec v2.3 §5.2 "Đọc" + §10.1 Markdown bullet + §11 Web-unit "render `mode: 'doc'`": heading anchors, the table of
// contents threshold, relative links (resolved against the md file's dir, normalised, engine-checked), external links,
// relative images through the engine, `data:` / external images as link text, raw HTML as text; chat mode unchanged.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../shared/i18n/index.ts';
import { DocBody, DocView, type DocProps } from '../src/code/DocView.tsx';
import { checkDoc, classifyHref, docHeadings, headingSlug, showToc, tocEntries } from '../src/lib/doc-links.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { Markdown } from '../src/ui/Markdown.tsx';

const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const MD = 'docs/specs/auth.md';

const fakes = (ok: (p: string) => boolean = () => true, imgs: Record<string, string> = {}) => {
  const asked: string[] = [];
  const loaded: string[] = [];
  const props: Omit<DocProps, 'text'> = {
    path: MD, narrow: false,
    resolveLink: async rel => { asked.push(rel); return ok(rel) ? { ok: true, path: rel } : { ok: false }; },
    loadImage: async rel => { loaded.push(rel); return imgs[rel] ?? null; },
    openInCode: () => {},
    openExternal: () => {},
  };
  return { props, asked, loaded };
};

/** Render the "Đọc" body after its links / images were checked (what DocView shows once the effect settled). */
async function doc(text: string, ok?: (p: string) => boolean, imgs?: Record<string, string>, width = 1200) {
  const f = fakes(ok, imgs);
  const checked = await checkDoc(text, MD, f.props.resolveLink, f.props.loadImage);
  return { out: html(<DocBody {...f.props} text={text} checked={checked} width={width} />), ...f };
}

describe('§10.1 link rule for the "Đọc" view', () => {
  test('§10.1 a relative link resolves against the md file\'s dir and is normalised', () => {
    expect(classifyHref('../../engine/src/auth.ts', MD)).toEqual({ k: 'file', path: 'engine/src/auth.ts' });
    expect(classifyHref('./b.md#x', MD)).toEqual({ k: 'file', path: 'docs/specs/b.md' });
    expect(classifyHref('sub/./c%20d.md?raw=1', MD)).toEqual({ k: 'file', path: 'docs/specs/sub/c d.md' });
    expect(classifyHref('a/../b.md', 'top.md')).toEqual({ k: 'file', path: 'b.md' });
  });
  test('§10.1 outside the root (`../../..`) → plain text, never sent to the engine', async () => {
    expect(classifyHref('../../../etc/passwd', MD)).toEqual({ k: 'text' });
    expect(classifyHref('../x.md', 'top.md')).toEqual({ k: 'text' });
    const { out, asked } = await doc('xem [mật](../../../etc/passwd) nhé');
    expect(asked).toHaveLength(0);
    expect(out).toContain('xem mật nhé');
    expect(out).not.toContain('<a');
  });
  test('§10.1 absolute paths, backslashes, `//host` and other schemes → text', () => {
    for (const h of ['a\u0000b.md', 'a%0a.md', 'x%5c..%5cy.md', '/etc/passwd', 'a\\..\\..\\x', '//evil.com/x', 'javascript:alert(1)', 'file:///etc/passwd', 'vbscript:x', 'data:text/html,x', '', '%zz'])
      expect(classifyHref(h, MD)).toEqual({ k: 'text' });
  });
  test('§10.1 http / https / mailto → external link; `#x` → anchor', () => {
    expect(classifyHref('https://a.dev/x', MD)).toEqual({ k: 'ext', url: 'https://a.dev/x' });
    expect(classifyHref('mailto:a@b.c', MD)).toEqual({ k: 'ext', url: 'mailto:a@b.c' });
    expect(classifyHref('#2-mục-tiêu', MD)).toEqual({ k: 'anchor', id: '2-mục-tiêu' });
  });
  test('§10.1 an engine-checked relative link renders as a Code link; refused by the engine → text', async () => {
    const { out, asked } = await doc('[ok](../../engine/a.ts) và [bị chặn](./.git/config)', p => !p.includes('.git'));
    expect(asked.sort()).toEqual(['docs/specs/.git/config', 'engine/a.ts']);
    expect(out).toContain('data-path="engine/a.ts"');
    expect(out).toMatch(/<a[^>]*md-a[^>]*>ok<\/a>/);
    expect(out).toContain('và bị chặn');
    expect(out).not.toContain('.git/config"');
  });
  test('§10.1 before the engine answered, a relative link is text and the TOC waits for the pane width', () => {
    const f = fakes();
    const out = html(<DocView {...f.props} text={'## a\n\n## b\n\n## c\n\n[x](./b.md)'} />);
    expect(out).toContain('class="doc-pane"');
    expect(out).not.toContain('data-path');
    expect(out).not.toContain('Mục lục');
  });
  test('§10.1 an external link keeps the C30 rule (system browser, domain title)', async () => {
    const { out } = await doc('[web](https://a.dev/x)');
    expect(out).toContain('href="https://a.dev/x"');
    expect(out).toContain('title="a.dev"');
  });
});

describe('§10.1 images and raw HTML in "Đọc"', () => {
  test('§10.1 a relative image is drawn from the data URL the engine returned', async () => {
    const { out, loaded } = await doc('![sơ đồ](img/flow.png)', undefined, { 'docs/specs/img/flow.png': 'data:image/png;base64,AAAA' });
    expect(loaded).toEqual(['docs/specs/img/flow.png']);
    expect(out).toContain('<img');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('alt="sơ đồ"');
  });
  test('§10.1 a `data:` image in the doc → link text only, never loaded or drawn', async () => {
    const { out, loaded } = await doc('![lén](data:image/png;base64,AAAA)');
    expect(loaded).toHaveLength(0);
    expect(out).not.toContain('<img');
    expect(out).toContain('lén');
  });
  test('§10.1 an external image → a link with its alt text, not loaded', async () => {
    const { out, loaded } = await doc('![logo](https://a.dev/l.png)');
    expect(loaded).toHaveLength(0);
    expect(out).not.toContain('<img');
    expect(out).toMatch(/<a[^>]*href="https:\/\/a.dev\/l.png"[^>]*>logo<\/a>/);
  });
  test('§10.1 a relative non-image or failed image → alt text; the engine reply must be a data:image URL', async () => {
    const { out, loaded } = await doc('![a](x.exe) ![b](miss.png) ![c](bad.png)', undefined, { 'docs/specs/bad.png': 'javascript:alert(1)' });
    expect(loaded.sort()).toEqual(['docs/specs/bad.png', 'docs/specs/miss.png']);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('javascript');
  });
  test('§10.1 raw HTML (`<img>`, `<details>`) shows as text, never as elements', async () => {
    const { out, loaded } = await doc('<img src="x.png" onerror="alert(1)">\n\n<details><summary>s</summary>b</details>\n\nchữ <img src=y.png> tiếp');
    expect(loaded).toHaveLength(0);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<details');
    expect(out).toContain('&lt;img src=&quot;x.png&quot;');
    expect(out).toContain('&lt;details&gt;');
  });
});

describe('§5.2 heading anchors and the table of contents', () => {
  const SPEC = '# Auth\n\nmeta\n\n## 1. Vì sao làm\n\na\n\n## 2. Mục tiêu\n\nb\n\n### Chi tiết `x`\n\nc\n\n## 2. Mục tiêu\n\nd';
  test('§10.1 headings get unique GitHub-style anchors, the same in the body and the TOC', async () => {
    expect(headingSlug('2. Mục tiêu')).toBe('2-mục-tiêu');
    const hs = docHeadings(SPEC);
    expect(hs.map(h => h.id)).toEqual(['auth', '1-vì-sao-làm', '2-mục-tiêu', 'chi-tiết-x', '2-mục-tiêu-1']);
    const { out } = await doc(SPEC);
    for (const h of hs) expect(out).toContain(`id="${h.id}"`);
    expect(out).toContain('href="#2-mục-tiêu-1"');
  });
  test('§5.2 a single h1 is the title: the TOC lists the rest', () => {
    expect(tocEntries(docHeadings(SPEC)).map(h => h.text)).toEqual(['1. Vì sao làm', '2. Mục tiêu', 'Chi tiết x', '2. Mục tiêu']);
  });
  test('§5.2 TOC only with ≥ 3 headings and a pane ≥ 720 px (orchestrator ruling R1: mockup C3 = 736 px pane at 1440)', () => {
    expect(showToc(3, 720)).toBe(true);
    expect(showToc(2, 1400)).toBe(false);
    expect(showToc(3, 719)).toBe(false);
  });
  test('§5.2 the TOC renders at 720 px with "Mục lục", hidden at 719 px and with 2 headings', async () => {
    expect((await doc(SPEC, undefined, undefined, 720)).out).toContain('Mục lục');
    expect((await doc(SPEC, undefined, undefined, 719)).out).not.toContain('Mục lục');
    expect((await doc('# T\n\n## a\n\n## b', undefined, undefined, 1400)).out).not.toContain('Mục lục');
  });
  test('§10.1 a `#x` link inside the doc is an in-page anchor, not a Code link', async () => {
    const { out, asked } = await doc('## Hai\n\n[lên](#hai)');
    expect(asked).toHaveLength(0);
    expect(out).toContain('href="#hai"');
  });
});

describe('§10.1 chat mode is unchanged', () => {
  test('§10.1 `mode: "chat"` keeps v2.2: no heading ids, relative links and images are text', () => {
    const src = '## Hai\n\n[rel](./a.md) ![img](a.png) [w](https://a.dev)';
    const chat = html(<Markdown text={src} />);
    expect(chat).toBe(html(<Markdown text={src} mode="chat" />));
    expect(chat).not.toContain('id=');
    expect(chat).not.toContain('a.md');
    expect(chat).not.toContain('<img');
    expect(chat).toContain('class="md md-chat"');
  });
});
