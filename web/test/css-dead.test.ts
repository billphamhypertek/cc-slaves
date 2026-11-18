// Coding standard "no dead code" for CSS: every class / id a web stylesheet selects is set by some element in web/src.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = [...new Glob('web/src/**/*.css').scanSync()].sort();
/** The string / template literals of web/src (+ index.html): a class name has to be written in one to reach the DOM. */
const src = [...new Glob('web/src/**/*.{ts,tsx}').scanSync()]
  .flatMap(f => strip(readFileSync(f, 'utf8')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1').match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? [])
  .concat(readFileSync('web/index.html', 'utf8')).join('\n');
/** Names built at run time (`r-${role}`, `st-${state}` …) or owned by @xyflow/react (its `react-flow__*` classes and the
 *  `selected` it sets on a node / edge, v2.9 §4.2): their values are typed unions. */
const DYNAMIC = /^(r|k|s|t|g|st|br|dm|hp)-|^react-flow|^selected$/;

/** Every `.class` / `#id` in a selector (not in a value, not in an at-rule prelude). */
function selectorNames(file: string): string[] {
  const names = new Set<string>();
  for (const m of strip(readFileSync(file, 'utf8')).matchAll(/([^{}]+)\{/g)) {
    if (m[1]!.trim().startsWith('@')) continue;
    for (const x of m[1]!.matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)) names.add(x[1]!);
  }
  return [...names];
}
const used = (n: string) => new RegExp(`['"\`\\s(]${n.replace(/-/g, '\\-')}(?=['"\`\\s$])`).test(src);

describe('no dead CSS', () => {
  test('every class / id a stylesheet selects has an element in web/src (I4 list rewrite left none behind)', () => {
    const dead = css.flatMap(f => selectorNames(f).filter(n => !DYNAMIC.test(n) && !used(n)).map(n => `${f} ${n}`));
    expect(dead).toEqual([]);
  });
});
