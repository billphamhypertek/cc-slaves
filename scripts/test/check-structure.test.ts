import { describe, expect, test } from 'bun:test';
import { emptyBaseline, evaluate, initBaseline, rekey, seedBaseline, updateBaseline } from '../check-structure/baseline';
import { measureTree } from '../check-structure/measure';
import { existsSync, readFileSync } from 'node:fs';
import { scanScrollAnim, scanScrollbarRules } from '../check-structure/scrollbars';
import { HEIGHTS, scanBarLiterals, scanFontLiterals, scanSpaceLiterals, SPACE, TYPE_SCALE } from '../check-structure/type-scale';

const ROOT = '/fixture';
const measure = (files: Record<string, string>) => measureTree(new Map(Object.entries(files)), { root: ROOT });
const lines = (n: number): string => 'const x = 1;\n'.repeat(n);
const fn = (name: string, body: number): string => `export function ${name}() {\n${'  x();\n'.repeat(body - 2)}}\n`;
const CSS = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
/** docs/ref is not in the public snapshot (spec v2.6 §7.7): the two cases that read the standard skip when it is absent. */
const DOC_URL = new URL('../../docs/ref/coding-standard.md', import.meta.url);
const NO_DOC = !existsSync(DOC_URL);
const DOC = NO_DOC ? '' : readFileSync(DOC_URL, 'utf8');
const reds = (files: Record<string, string>) => evaluate(measure(files), emptyBaseline()).map((f) => `${f.rule} ${f.key}`);

describe('coding standard §1 limits', () => {
  test('§1 a file of 801 lines is red, 800 is not (TS, TSX and CSS)', () => {
    expect(reds({ 'engine/src/a.ts': lines(800) })).toEqual([]);
    expect(reds({ 'engine/src/a.ts': lines(801) })).toEqual(['a engine/src/a.ts']);
    expect(reds({ 'web/src/a.css': '.a{}\n'.repeat(801) })).toEqual(['a web/src/a.css']);
  });
  test('§1 a function of 251 lines is red, 250 is not; class methods count one by one', () => {
    expect(reds({ 'web/src/a.tsx': fn('A', 250) })).toEqual([]);
    expect(reds({ 'web/src/a.tsx': fn('A', 251) })).toEqual(['a web/src/a.tsx#A']);
    const cls = `class K {\n  m() {\n${'    x();\n'.repeat(250)}  }\n}\n`;
    expect(reds({ 'engine/src/k.ts': cls })).toEqual(['a engine/src/k.ts#K.m']);
  });
  test('§1 files outside the product dirs and .d.ts files are not measured', () => {
    expect(reds({ 'e2e/a.ts': lines(900), 'web/src/x.d.ts': lines(900), 'docs/a.ts': lines(900) })).toEqual([]);
  });
});

describe('coding standard §3 dependency rules', () => {
  test('§3 L1 shared imports nothing from engine / web', () => {
    expect(reds({ 'shared/p.ts': "import { a } from '../engine/src/a.ts';\n", 'engine/src/a.ts': 'export const a = 1;\n' }))
      .toEqual(['d shared/p.ts→engine/src/a.ts']);
  });
  test('§3 L2 web ↛ engine and engine ↛ web, type-only imports included', () => {
    expect(reds({ 'web/src/a.ts': "import type { E } from '../../engine/src/e.ts';\n", 'engine/src/e.ts': 'export type E = 1;\n' }))
      .toEqual(['d web/src/a.ts→engine/src/e.ts']);
    expect(reds({ 'engine/src/e.ts': "import { a } from '../../web/src/a.ts';\n", 'web/src/a.ts': 'export const a = 1;\n' }))
      .toEqual(['d engine/src/e.ts→web/src/a.ts']);
  });
  test('§3 L3 web/src/lib ↛ ui / deck (runtime)', () => {
    expect(reds({ 'web/src/lib/a.ts': "import { B } from '../ui/B.tsx';\n", 'web/src/ui/B.tsx': 'export const B = 1;\n' }))
      .toEqual(['a web/src/lib/a.ts→web/src/ui/B.tsx']);
    expect(reds({ 'web/src/lib/a.ts': "import type { B } from '../ui/B.tsx';\n", 'web/src/ui/B.tsx': 'export type B = 1;\n' }))
      .toEqual([]);
  });
  test('§3 L3 first-paint code never imports a deck value statically (lazy import and deck/actions.ts are fine)', () => {
    const base = {
      'web/src/main.tsx': "import { App } from './ui/App.tsx';\n",
      'web/src/deck/DeckView.tsx': 'export const D = 1;\n', 'web/src/deck/actions.ts': 'export const k = 1;\n',
    };
    expect(reds({ ...base, 'web/src/ui/App.tsx': "import { k } from '../deck/actions.ts';\nconst D = import('../deck/DeckView.tsx');\n" }))
      .toEqual([]);
    expect(reds({ ...base, 'web/src/ui/App.tsx': "import { k } from '../deck/actions.ts';\nimport { D } from '../deck/DeckView.tsx';\n" }))
      .toEqual(['a web/src/ui/App.tsx→web/src/deck/DeckView.tsx']);
  });
  test('§3 L4 a runtime cycle is counted per area; a type-only back edge is not a cycle', () => {
    const a = "import { b } from './b.ts';\nexport const a = 1;\n";
    expect(reds({ 'engine/src/lane/a.ts': a, 'engine/src/lane/b.ts': "import { a } from './a.ts';\nexport const b = 1;\n" }))
      .toEqual(['a cycles@engine/lane']);
    expect(reds({ 'engine/src/lane/a.ts': a, 'engine/src/lane/b.ts': "import type { a } from './a.ts';\nexport const b = 1;\n" }))
      .toEqual([]);
  });
  test('§3 L4 / L6 fragments of one assembler: a cycle between them and an import of the assembler are hard reds', () => {
    const asm = { 'engine/src/session.ts': "import { a } from './session/a.ts';\nexport const s = a;\n" };
    expect(reds({ ...asm, 'engine/src/session/a.ts': "import { b } from './b.ts';\nexport const a = 1;\n",
      'engine/src/session/b.ts': "import { a } from './a.ts';\nexport const b = 1;\n" }))
      .toEqual(['d engine/src/session/a.ts↔engine/src/session/b.ts']);
    expect(reds({ ...asm, 'engine/src/session/a.ts': "import { s } from '../session.ts';\nexport const a = 1;\n" }))
      .toContain('d engine/src/session/a.ts→engine/src/session.ts');
  });
});

describe('coding standard §4 patterns', () => {
  test('§4 a second home of a registered helper is red', () => {
    expect(reds({ 'web/src/ui/X.tsx': 'const canRun = () => true;\n' })).toEqual(['a helper-decl@web/src/ui/X.tsx']);
    expect(reds({ 'web/src/lib/remote.ts': 'export const canRun = () => true;\n' })).toEqual([]);
  });
  test('§4 isObj has one home (shared/json.ts): a local copy in engine or web is red', () => {
    expect(reds({ 'engine/src/mcp/x.ts': 'const isObj = (v: unknown): v is Obj => typeof v === "object";\n' })).toEqual(['a helper-decl@engine/src/mcp/x.ts']);
    expect(reds({ 'shared/json.ts': 'export const isObj = (v: unknown) => true;\n' })).toEqual([]);
  });
  test('§4 group into a map by push, not a spread copy', () => {
    expect(reds({ 'engine/src/a.ts': 'm.set(k, [...(m.get(k) ?? []), v]);\n' })).toEqual(['a spread-accumulate@engine/src/a.ts']);
  });
  test('§4 "Animate or not": a local prefers-reduced-motion check in code is a hit; lib/reduced-motion.ts and CSS are not', () => {
    const q = "matchMedia('(prefers-reduced-motion: reduce)')";
    expect(reds({ 'web/src/lib/a.ts': `const r = ${q};\n` })).toEqual(['a local-reduced-motion@web/src/lib/a.ts']);
    expect(reds({ 'web/src/lib/reduced-motion.ts': `const r = ${q};\n`, 'web/src/x.css': '@media (prefers-reduced-motion:reduce){.a{animation:none}}\n' })).toEqual([]);
  });
  test('§4 type scale: a literal font size is a hit; < 10 px, em, %, var(), SVG fontSize={n} and tests are not', () => {
    const css = '.a{font-size:13px}\n.b{font:600 12.5px/1 var(--m)}\n.c{font-size:9px}\n.d{font-size:1.1em}\n.e{font:var(--sm)/1 x}\n';
    expect(scanFontLiterals('web/src/x.css', css).map((h) => `${h.line} ${h.text}`)).toEqual(['1 font-size:13px', '2 font:600 12.5px']);
    expect(scanFontLiterals('web/src/X.tsx', "<p style={{ fontSize: 12 }} /><text fontSize={11} />")).toHaveLength(1);
    expect(scanFontLiterals('web/test/X.test.tsx', 'fontSize: 12')).toEqual([]);
    expect(reds({ 'web/src/x.css': '.a{font-size:13px}\n' })).toEqual(['a font-literal@web/src/x.css']);
  });
  test.skipIf(NO_DOC)('§6.7 D53 + hot fix 2026-11-16 the scale 11/12/13/14/16/19/25 (7 steps, same names) = the :root steps = lib/mono-font.ts = the standard §4 row', () => {
    expect(TYPE_SCALE).toEqual({ xxs: 11, xs: 12, sm: 13, md: 14, lg: 16, xl: 19, xxl: 25 });
    const root = Object.fromEntries([...CSS.matchAll(/--(x{0,2}s|sm|md|lg|x{1,2}l):(\d+)px/g)].map((m) => [m[1]!, Number(m[2])]));
    expect(root).toEqual(TYPE_SCALE);
    const mono = readFileSync(new URL('../../web/src/lib/mono-font.ts', import.meta.url), 'utf8');
    const steps = Object.fromEntries([...mono.match(/STEPS = \{([^}]*)\}/)![1]!.matchAll(/(\w+): (\d+)/g)].map((m) => [m[1]!, Number(m[2])]));
    expect(steps).toEqual(TYPE_SCALE);
    for (const [k, v] of Object.entries(TYPE_SCALE)) expect(DOC).toContain(`\`var(--${k})\` ${v}`);
  });
  test.skipIf(NO_DOC)('§6.7 D53 + hot fix 2026-11-16 space tokens --s1…--s6 = 2/4/7/10/14/18 and heights --h-* = 44/28/30/24/32 in :root and the standard §4', () => {
    expect(SPACE).toEqual({ s1: 2, s2: 4, s3: 7, s4: 10, s5: 14, s6: 18 });
    expect(HEIGHTS).toEqual({ 'h-bar': 44, 'h-head': 28, 'h-ctl': 30, 'h-ctl-sm': 24, 'h-row': 32 });
    const root = CSS.slice(CSS.indexOf(':root{'), CSS.indexOf('}', CSS.indexOf(':root{')));
    for (const [k, v] of Object.entries({ ...SPACE, ...HEIGHTS })) {
      expect(root).toContain(`--${k}:${v}px;`);
      expect(DOC).toContain(`\`var(--${k})\` ${v}`);
    }
  });
  test('§6.7 D53 the JS home of --h-head (lib/mono-font.ts H_HEAD, read by deck/flow/viewport.ts) = :root --h-head', () => {
    const mono = readFileSync(new URL('../../web/src/lib/mono-font.ts', import.meta.url), 'utf8');
    expect(Number(/export const H_HEAD = (\d+);/.exec(mono)?.[1])).toBe(HEIGHTS['h-head']);
  });
  test('§6.7 D53 space-literal: a bare px in padding / margin / gap is a hit, one per value (shorthand, calc, negative)', () => {
    const css = '.a{padding:0 16px}\n.b{margin:-4px 2px 0}\n.c{gap:6px;row-gap:var(--s2)}\n.d{padding-left:calc(var(--s4) + 1px)}\n'
      + '.e{scroll-margin-bottom:36px;--pad:8px;padding:0;margin:auto}\n.f{padding-block:var(--s1) var(--s2);column-gap:0px}\n';
    expect(scanSpaceLiterals('web/src/x.css', css).map((h) => h.line)).toEqual([1, 2, 2, 3, 4]);
    expect(scanSpaceLiterals('web/src/X.tsx', "<p style={{ padding: 8, marginTop: '0 6px 2px', gap: 0, rowGap: 4 }} />")).toHaveLength(4);
    expect(scanSpaceLiterals('web/src/X.tsx', 'fitView({ padding: 0.2 }); <b style={{ padding: \'50%\', margin: \'var(--s2)\' }} />')).toEqual([]);
    expect(scanSpaceLiterals('web/test/X.test.tsx', 'padding: 8')).toEqual([]);
    expect(reds({ 'web/src/x.css': '.a{gap:6px}\n' })).toEqual(['a space-literal@web/src/x.css']);
  });
  test('§6.7 D53 bar-literal: a px in a value that reads var(--bn is a bar height written out; tokens and the 0px fallback are not', () => {
    const css = '#l{top:calc(var(--bn) + 102px)}\n#m{top:calc(var(--bn,0px) + 56px)}\n#n{top:calc(var(--bn) + var(--h-bar) + var(--s4))}\n'
      + '#o{top:var(--bn,0px)}\n#p{height:56px}\n';
    expect(scanBarLiterals('web/src/x.css', css).map((h) => h.line)).toEqual([1, 2]);
    expect(reds({ 'web/src/x.css': '#l{top:calc(var(--bn) + 90px)}\n' })).toEqual(['a bar-literal@web/src/x.css']);
  });
  test('§6.7 D53 the G6b files carry no space / bar literal and no bar height in px (styles.css #left, #reloadBand, .dhead, inbox.css)', () => {
    for (const f of ['web/src/styles.css', 'web/src/ui/inbox.css']) {
      const text = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
      expect(scanBarLiterals(f, text).map((h) => h.text)).toEqual([]);
      expect(scanSpaceLiterals(f, text).map((h) => `${h.line} ${h.text}`)).toEqual(f.endsWith('styles.css') ? [expect.stringContaining('padding-right:112px')] : []);
    }
    expect(CSS.match(/(?<![\w-])(?:(?:top|inset|height):\s*(?:56|102|90)px|height:\s*34px)/g)).toBeNull(); // the old bar heights
  });
});

describe('§6.8 D54 scrollbars have one home', () => {
  test('§6.8 scrollbar-width / scrollbar-color anywhere, or ::-webkit-scrollbar outside styles.css, is a hit', () => {
    expect(reds({ 'web/src/x.css': '.a{overflow:auto;scrollbar-width:thin}\n.b{scrollbar-color:red transparent}\n' })).toEqual(['a scrollbar-rule@web/src/x.css']);
    expect(scanScrollbarRules('web/src/x.css', '.a::-webkit-scrollbar{width:3px}\n.b{scrollbar-width:none}\n').map((h) => h.line)).toEqual([1, 2]);
    expect(scanScrollbarRules('web/src/X.tsx', '<div style={{ scrollbarWidth: "thin" }} />')).toHaveLength(1);
    expect(scanScrollbarRules('web/src/styles.css', '::-webkit-scrollbar{width:var(--sb-size)}\n')).toEqual([]);
  });
  test('§6.8 R36 I1 a scroll box (overflow auto|scroll) whose class / id is animated in any rule, any file, is red', () => {
    expect(reds({ 'web/src/a.css': '.m{overflow-y:auto}\n', 'web/src/b.css': '.m{animation:drop 1s}\n' })).toEqual(['a scroll-anim@web/src']);
    expect(scanScrollAnim(new Map([['web/src/a.css', '.x .m{overflow:scroll}\n.rm :is(#q,.m){animation:f 1s}\n']]))).toHaveLength(1);
    const clean = '.m{overflow:auto}\n.m .ams{color:red}\n.n{animation:none}\n.m::after{animation:z 1s}\n.k:not(.m){animation:z 1s}\n'
      + '@media (x){[data-sb=on]{animation:sb-in 1s}}\n.m{animation-play-state:paused}\n';
    expect(scanScrollAnim(new Map([['web/src/a.css', clean]]))).toEqual([]);
  });
  test('§6.8 the product CSS today: no scroll box is animated and no scrollbar rule outside the D54 block', () => {
    const glob = new Bun.Glob('web/src/**/*.{css,ts,tsx}');
    const root = new URL('../../', import.meta.url).pathname;
    const files = new Map([...glob.scanSync(root)].map((f) => [f, readFileSync(root + f, 'utf8')]));
    expect(scanScrollAnim(files).map((h) => h.text)).toEqual([]);
    expect([...files].flatMap(([f, t]) => scanScrollbarRules(f, t)).map((h) => `${h.file}:${h.line}`)).toEqual([]);
  });
});

describe('§6.7 D53 seeding a rule added after the baseline', () => {
  const tree = { 'web/src/a.css': '.a{gap:6px;padding:2px}\n', 'web/src/b.css': '.b{top:calc(var(--bn) + 56px)}\n' };
  test('--seed enters every measured key of the rule at its value, nothing else; an unknown rule is refused', () => {
    const r = seedBaseline(measure(tree), emptyBaseline(), 'space-literal');
    expect('baseline' in r && [...r.baseline.sections.patterns]).toEqual([['space-literal@web/src/a.css', 2]]);
    expect(seedBaseline(measure(tree), emptyBaseline(), 'spread-accumulate')).toHaveProperty('error');
  });
  test('a seeded key passes the ref check while the ref has no key of its rule; once it has one, a new key is red', () => {
    const m = measure(tree);
    const seeded = (seedBaseline(m, emptyBaseline(), 'bar-literal') as { baseline: ReturnType<typeof emptyBaseline> }).baseline;
    const refReds = (x: typeof m, b: typeof seeded, r: typeof seeded) => evaluate(x, b, r).filter((f) => f.rule === 'ref').map((f) => f.key);
    expect(refReds(m, seeded, emptyBaseline())).toEqual([]);
    const ref = emptyBaseline();
    ref.sections.patterns.set('bar-literal@web/src/z.css', 1);
    seeded.sections.patterns.set('bar-literal@web/src/z.css', 1);
    const more = measure({ ...tree, 'web/src/z.css': '.z{top:calc(var(--bn) + 9px)}\n' });
    expect(refReds(more, seeded, ref)).toEqual(['bar-literal@web/src/b.css']);
  });
  test('a non-seeded rule never enters by hand, even when the ref has none of it', () => {
    const m = measure({ 'web/src/a.css': '.a{font-size:13px}\n' });
    expect(evaluate(m, initBaseline(m), emptyBaseline()).map((f) => `${f.rule} ${f.key}`)).toEqual(['ref font-literal@web/src/a.css']);
  });
});

describe('coding standard §1 baseline ratchet', () => {
  const big = { 'engine/src/a.ts': lines(900) };
  test('§1 a baselined key passes at its value, is red when it grows, and must leave once under the limit', () => {
    const b = initBaseline(measure(big));
    expect(evaluate(measure(big), b)).toEqual([]);
    expect(evaluate(measure({ 'engine/src/a.ts': lines(901) }), b).map((f) => f.rule)).toEqual(['b']);
    expect(evaluate(measure({ 'engine/src/a.ts': lines(10) }), b).map((f) => f.rule)).toEqual(['c']);
    expect(evaluate(measure({}), b).map((f) => f.rule)).toEqual(['c′']);
  });
  test('§1 --update only shrinks and drops, never adds', () => {
    const b = initBaseline(measure(big));
    expect(updateBaseline(measure({ 'engine/src/a.ts': lines(850) }), b).sections.files.get('engine/src/a.ts')).toBe(850);
    expect(updateBaseline(measure({ 'engine/src/a.ts': lines(950) }), b).sections.files.get('engine/src/a.ts')).toBe(900);
    expect(updateBaseline(measure({ ...big, 'engine/src/b.ts': lines(900) }), b).sections.files.has('engine/src/b.ts')).toBe(false);
  });
  test('§1 a baseline raised by hand against the ref is red', () => {
    const m = measure({ 'engine/src/a.ts': lines(950) });
    const ref = initBaseline(measure(big));
    const raised = initBaseline(m);
    expect(evaluate(m, raised, ref).map((f) => `${f.rule} ${f.key}`)).toEqual(['ref engine/src/a.ts']);
  });
  test('§1 --rekey moves a key to a moved file, refused when the new file measures more', () => {
    const b = initBaseline(measure(big));
    const moved = measure({ 'engine/src/b.ts': lines(890) });
    const r = rekey(moved, b, 'engine/src/a.ts', 'engine/src/b.ts');
    expect('baseline' in r && evaluate(moved, r.baseline, b)).toEqual([]);
    expect(rekey(measure({ 'engine/src/b.ts': lines(901) }), b, 'engine/src/a.ts', 'engine/src/b.ts')).toHaveProperty('error');
  });
});
