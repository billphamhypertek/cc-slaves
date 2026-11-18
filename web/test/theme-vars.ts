// The two variable blocks of styles.css (`:root` dark, `:root[data-theme=light]` light), parsed straight from the file, and
// the value a dark / a light element computes for a token. Shared by the contrast and the banned-look tests.
import { readFileSync } from 'node:fs';

export type Vars = Record<string, string>;
const css = readFileSync('web/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function decls(body: string): Vars {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)].map(m => [m[1]!, m[2]!]));
}
function block(sel: RegExp): Vars {
  const body = css.match(sel)?.[1];
  if (body === undefined) throw new Error(`no block ${sel}`);
  return decls(body);
}
export const DARK = block(/^:root\{([^}]*)\}/m);
export const LIGHT = block(/^:root\[data-theme=light\]\{([^}]*)\}/m);

/** Resolve `var(--x)` chains in `scope`; an unknown name throws unless `lenient` (then it stays as written). */
export function resolve(v: string, scope: Vars, lenient = false, depth = 0): string {
  if (depth > 8) throw new Error(`var loop: ${v}`);
  return v.replace(/var\((--[\w-]+)\)/g, (all: string, n: string) => {
    if (!(n in scope)) {
      if (lenient) return all;
      throw new Error(`undefined ${n}`);
    }
    return resolve(scope[n]!, scope, lenient, depth + 1);
  });
}
/** Scope of a light element: a variable the light block does not redeclare keeps the dark one. */
export const LIGHT_SCOPE: Vars = { ...DARK, ...LIGHT };
/** Every later plain `:root{…}` block (motion, scrollbar tokens) holds for both themes; the light block still wins on a name
 *  it redeclares (higher specificity). */
const later: Vars = Object.assign({}, ...[...css.matchAll(/^:root\{([^}]*)\}/gm)].slice(1).map(m => decls(m[1]!)));
export const DARK_ALL: Vars = { ...DARK, ...later };
export const LIGHT_ALL: Vars = { ...DARK_ALL, ...LIGHT };
