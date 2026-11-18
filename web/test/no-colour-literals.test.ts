// v2.8 §4.2 / §11: every colour in web/src goes through var(--…); the only literals live in the two variable blocks of
// styles.css (`:root` dark, `:root[data-theme=light]` light). Replaces the v2.7 scan of web/src/tasks only.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

const LITERAL = /#[0-9a-fA-F]{3,8}\b(?![\w-]*=)|\brgba?\(|\bhsla?\(/g;
/** The two variable blocks of styles.css — the one place a colour literal may sit. Only the FIRST `:root{` and the first
 *  `:root[data-theme=light]{` count: a literal in any later `:root` block is a dark-only colour with no light value. */
const VAR_BLOCKS = [/^:root\{[^}]*\}/m, /^:root\[data-theme=light\]\{[^}]*\}/m];

/** Colour literals of one source text (comments dropped; styles.css without its two variable blocks). */
function literals(text: string, isStyles = false): string[] {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, '');
  if (isStyles) for (const b of VAR_BLOCKS) t = t.replace(b, '');
  return [...t.matchAll(LITERAL)].map(m => m[0]);
}

describe('§11 no colour literals outside the two variable blocks', () => {
  test('self-check: a literal is caught, var(--x) and the variable blocks pass', () => {
    expect(literals('.a{color:#1a1200}')).toEqual(['#1a1200']);
    expect(literals("style={{ color: 'rgba(0,0,0,.5)' }}")).toEqual(['rgba(']);
    expect(literals('.a{color:var(--bdg-fg);background:hsl(0 0% 0%)}')).toEqual(['hsl(']);
    expect(literals(':root{--x:#000;--y:rgba(1,2,3,.4)}\n:root[data-theme=light]{--x:#fff}\n.a{color:var(--x)}', true)).toEqual([]);
    expect(literals(':root{--x:#000}\n.b{color:#fff}', true)).toEqual(['#fff']);
    // v28-fx: a later :root block is not a variable block
    expect(literals(':root{--x:#000}\n:root[data-theme=light]{--x:#fff}\n:root{--ease:linear}\n:root{--zz-hot:#ff0000}', true)).toEqual(['#ff0000']);
  });

  test('web/src/**: none', () => {
    const found: Record<string, number> = {};
    for (const f of [...new Glob('web/src/**/*.{css,ts,tsx}').scanSync()].sort()) {
      const n = literals(readFileSync(f, 'utf8'), f === 'web/src/styles.css').length;
      if (n) found[f] = n;
    }
    expect(found).toEqual({});
  });
});
