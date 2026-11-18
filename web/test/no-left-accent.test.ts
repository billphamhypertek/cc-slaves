// PO 2026-11-16 (global UX rule): no "AI-looking" accent rows — a selected / focused / highlighted row or card marked by a
// coloured left border, an inset left stripe or a left `::before` bar. Selection is a plain background change, a full 1px
// outline or text weight. A 1px left border (a panel / column divider) and the markdown quote rule are fine.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { DARK_ALL, LIGHT_ALL, resolve } from './theme-vars';

const files = [...new Glob('web/src/**/*.{css,ts,tsx}').scanSync()].sort();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** One offending declaration per hit: `<file>: <snippet>`. */
function leftAccents(name: string, text: string): string[] {
  const t = strip(text);
  const hits: string[] = [];
  const add = (m: RegExpMatchArray) => hits.push(`${name}: ${m[0]}`);
  // inset shadow with a positive x offset and no y offset = a left stripe (CSS and CodeMirror theme objects)
  for (const m of t.matchAll(/inset\s+[1-9][\d.]*px\s+0(?:px)?(?:\s+0(?:px)?)?\s+(?:var\(|#|rgb|hsl|color-mix)/g)) add(m);
  // border-left thicker than a 1px divider (a 1px left border is a panel / column divider)
  for (const m of t.matchAll(/border-left\s*:\s*([\d.]+)px\s+solid\s+([^;}'"]+)/g)) {
    const neutral = Number(m[1]) <= 1;
    if (!neutral && !/\.md blockquote/.test(t.slice(Math.max(0, m.index - 80), m.index))) add(m);
  }
  for (const m of t.matchAll(/border-left-color\s*:/g)) add(m);
  for (const m of t.matchAll(/borderLeft(?:Width|Color)?\s*:\s*['"`](?!0|none)[^'"`]+/g)) if (!/cm-cursor/.test(t.slice(Math.max(0, m.index - 40), m.index))) add(m);
  return hits;
}

/** toggle controls (switch, segmented, filter chips, icon toggles) may show "pressed" in accent; rows / cards / tabs may not */
const CONTROLS = /(?:^|[\s,])(?:button\.sw|\.ib|\.seg|\.seg2 button|\.seg button|#inspector \.dchip|\.ccg \.cign|\.gbt)\.on\b/;
/** v2.9 §4.2 also React Flow's `.selected` (a selected canvas node / edge). v2.8 §7.1 also: edit mode (`.ed`), an open row / group (`.open`), a flashed card (`.flash`), a lit level / node (`.lit`), the
 *  account-hover glow (`acc-hl`) and the pre-highlighted first item of a menu (`:first-child`). v26-fw M6: also `:focus` and
 *  `:focus-within` (the composer frame and the search fields drew an accent border on focus). */
const STATE = /:hover|:focus(?:-visible|-within)?\b|:first-child|(?<!-)\.(?:on|sel|selected|focus|alit|cur|act|ed|open|flash|lit|fresh)\b|\bacc-hl\b/;
/** A colour literal whose rgb channels spread > 60 (not a grey). */
function chroma(v: string): boolean {
  const rgb = [...v.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)].map(m => [m[1], m[2], m[3]].map(Number));
  const hex = [...v.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map(m => {
    const h = m[1]!.length === 3 ? [...m[1]!].map(c => c + c).join('') : m[1]!;
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  });
  return [...rgb, ...hex].some(c => Math.max(...c) - Math.min(...c) > 60);
}
/** A value that is not grey in either theme: every token is resolved by VALUE in every `:root` block of styles.css (no
 *  name list — `--dk-acc`, `--ap-use`, `--pal-*` and any later token count the moment they hold a colour). Fail closed
 *  (v28-rr N-1): a token declared anywhere else (a local `--c:` on a panel) cannot be judged here, so it counts as tinted. */
const NEUTRAL_LINES = /var\(--line(?:-2)?\)/g;
/** The divider lines are the one exception: dark `--line(-2)` is a faint blue-grey on purpose, the neutral border of the app. */
const tinted = (v: string) => {
  const x = v.replace(NEUTRAL_LINES, 'transparent');
  try { return chroma(resolve(x, DARK_ALL)) || chroma(resolve(x, LIGHT_ALL)); } catch { return true; }
};
/** A selected / hovered / focused row, card, tab or menu item marked by a tinted fill or a coloured border: `<file>: <rule>`.
 *  hf-fa: every state selector counts, not a short class list; a toggle control (CONTROLS) is exempt. A keyboard focus ring is
 *  a coloured border too (PO ban names "focused" and "inset shadow"): it must be neutral (`--fg-2`), never accent. */
function tintedSelections(name: string, text: string): string[] {
  const hits: string[] = [];
  for (const m of strip(text).matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const sel = m[1]!.trim(), body = m[2]!;
    const parts = sel.split(',').filter(x => STATE.test(x) && !CONTROLS.test(x));
    if (!parts.length) continue;
    const fills = body.match(/background(?:-color|-image)?\s*:[^;]*/g) ?? [];
    const lines = body.match(/(?:border(?:-[a-z]+)*|outline|box-shadow)\s*:[^;]*/g) ?? [];
    if ([...fills, ...lines].some(tinted)) hits.push(`${name}: ${sel}`);
  }
  return hits;
}

describe('no coloured left accent on rows / cards (PO 2026-11-16)', () => {
  test('web/src has none', () => {
    expect(files.flatMap(f => leftAccents(f, readFileSync(f, 'utf8')))).toEqual([]);
  });

  test('selected / hovered rows, cards and tabs use the neutral --sel background, no tint, no coloured border', () => {
    expect(files.filter(f => f.endsWith('.css')).flatMap(f => tintedSelections(f, readFileSync(f, 'utf8')))).toEqual([]);
  });

  test('v2.9 §4.2: a selected Quy trình node is the neutral --sel step; React Flow\'s own border / shadow is overridden', () => {
    const s = strip(readFileSync('web/src/workflow/workflow.css', 'utf8'));
    expect(s).toContain('.wf .react-flow__node.selected .wn{background-image:linear-gradient(var(--sel),var(--sel))}');
    const own = [...s.matchAll(/([^{}]*\.react-flow__node\.selected[^{}]*)\{([^}]*)\}/g)];
    expect(own.some(m => /box-shadow:none/.test(m[2]!) && /outline:none/.test(m[2]!))).toBe(true);
    for (const m of own) expect(m[2]).not.toMatch(/(?:border|box-shadow|outline)\s*:[^;]*var\(--(?:accent|bad|warn|ok|dk-acc)/);
  });

  test('hf-deck: the deck hover step (--dk-hov: "⋯", node buttons, shelf rows) is a grey in both themes (r = g = b), never teal', () => {
    for (const all of [DARK_ALL, LIGHT_ALL]) {
      const c = resolve('var(--dk-hov)', all).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      expect(c && c[1] === c[2] && c[2] === c[3]).toBe(true);
    }
    const css = readFileSync(new URL('../src/deck/flow/flow.css', import.meta.url), 'utf8');
    for (const sel of ['.deck .more:hover', '.deck .nb:hover', '.deck .shelf button:hover']) expect(css).toContain(`${sel}{background:var(--dk-hov)`);
  });
  test('hf-fa: the picked dialog choice is a neutral step, not an accent box', () => {
    const s = strip(readFileSync('web/src/styles.css', 'utf8'));
    expect(s).toContain('.choice.def{background:var(--sel)}');
    expect(s).not.toMatch(/\.choice\.def\{[^}]*(?:accent|border)/);
  });

  test('v2.8 §7.1: the flashed Chờ PO card is a grey step only, no box drawn around it', () => {
    const s = strip(readFileSync('web/src/ui/inbox.css', 'utf8'));
    expect(s).toContain('#inbox .card.flash{background:var(--sel)}');
  });

  test('v28-fx (ruling 21:20): the recommended answer is marked by its tag only, every option keeps the --line-2 outline', () => {
    const s = strip(readFileSync('web/src/ui/inbox.css', 'utf8'));
    expect(s).toContain('.cpm .opt{display:flex;align-items:center;gap:var(--s4);text-align:left;padding:var(--s2) var(--s4);border-radius:6px;border:1px solid var(--line-2)');
    expect([...s.matchAll(/\.cpm \.opt(?:[.:][^\s{,]+)*\{[^}]*border(?:-color)?:[^;}]*/g)].map(m => m[0]).filter(tinted)).toEqual([]);
  });

  test('the selection scanner catches tint + coloured border and lets controls and --sel through', () => {
    expect(tintedSelections('a', '.k9o.on{border-color:var(--accent);background:var(--accent-2)}')).toHaveLength(1);
    expect(tintedSelections('a', '.tab.on{background:var(--accent-2);color:var(--fg)}')).toHaveLength(1);
    expect(tintedSelections('a', '.sub:hover,.sub.on{border-color:var(--accent)}')).toHaveLength(1);
    expect(tintedSelections('a', '#inbox .card.focus{background:color-mix(in srgb,var(--accent) 8%,transparent)}')).toHaveLength(1);
    expect(tintedSelections('a', '.row.on{background:var(--sel)}.ib.on{border-color:var(--accent);background:var(--accent-2)}button.sw.on{background:var(--accent-2)}')).toEqual([]);
    // hf-fa: any hovered menu row / list row, a blue-tinted literal, a coloured node ring, a coloured keyboard focus ring
    expect(tintedSelections('a', '.rmenu button:hover{background:var(--accent-2)}')).toHaveLength(1);
    expect(tintedSelections('a', '.gfr:hover{background:rgba(125,170,235,.08)}')).toHaveLength(1);
    expect(tintedSelections('a', '.deck .nd.sel{border-color:var(--acc);box-shadow:0 0 0 1px rgba(54,214,255,.25)}')).toHaveLength(1);
    expect(tintedSelections('a', '.m:hover,.m:focus-visible{border-color:#2a6a86}')).toHaveLength(1);
    expect(tintedSelections('a', '.x:focus-visible{background:var(--accent-2)}')).toHaveLength(1);
    expect(tintedSelections('a', 'button:focus-visible{box-shadow:inset 0 0 0 1px var(--accent)}')).toHaveLength(1);
    expect(tintedSelections('a', 'button:focus-visible{box-shadow:inset 0 0 0 1px var(--fg-2)}.r:hover{background:#123040}.d:hover{background:var(--panel-2)}')).toEqual([]);
    // v2.8 §7.1: edit frame, open row / group, flashed card, lit level, account glow, pre-highlighted first menu item
    expect(tintedSelections('a', '.ccg .ccm.ed{box-shadow:inset 0 0 0 1px var(--accent)}')).toHaveLength(1);
    expect(tintedSelections('a', '.smr.open{background:var(--accent-2)}')).toHaveLength(1);
    expect(tintedSelections('a', '.skp.open>.plug{background:var(--accent-2)}')).toHaveLength(1);
    expect(tintedSelections('a', '#inbox .card.flash{box-shadow:inset 0 0 0 1px var(--accent),0 0 18px color-mix(in srgb,var(--accent) 45%,transparent)}')).toHaveLength(1);
    expect(tintedSelections('a', '.lv.lit{background:var(--accent-2);color:var(--fg);font-weight:600}')).toHaveLength(1);
    expect(tintedSelections('a', '.react-flow__node.acc-hl .nd{box-shadow:0 0 0 2px rgba(54,214,255,.4)}')).toHaveLength(1);
    expect(tintedSelections('a', '.slash button:first-child{background:var(--accent-2)}')).toHaveLength(1);
    // v28-fx: tokens are judged by value — the deck / account-panel / palette ones too, greys (--sel, --line-2) pass
    expect(tintedSelections('a', '.deck .nd.sel{border-color:var(--dk-acc)}')).toHaveLength(1);
    expect(tintedSelections('a', '.x .row:hover{background:var(--ap-use)}')).toHaveLength(1);
    expect(tintedSelections('a', '.nd.lit{border-color:var(--dk-run)}.c.on{background:color-mix(in srgb,var(--dk-err) 10%,transparent)}')).toHaveLength(2);
    expect(tintedSelections('a', '.r.sel{background:var(--sel);border-color:var(--line-2)}.n.lit{border-color:var(--dk-nd-line)}')).toEqual([]);
    // v28-rr N-1 fail closed: a locally declared token is unknown to the scanner, so it is a hit; a later :root grey passes
    expect(tintedSelections('a', '.a{--q:#f00}.a.sel{border-color:var(--q)}')).toHaveLength(1);
    expect(tintedSelections('a', '::-webkit-scrollbar-thumb:hover{background-color:var(--sb-hi)}')).toEqual([]);
    expect(tintedSelections('a', '.smr.open{background:var(--sel)}.lv.lit{background:var(--sel);font-weight:600}.slash button:first-child{background:var(--sel)}.lv:first-child{border-left:0}.x.edge{background:var(--accent-2)}')).toEqual([]);
  });

  test('the scanner catches each banned form and lets the neutral ones through', () => {
    expect(leftAccents('a', '.x.sel{background:var(--accent-2);box-shadow:inset 2px 0 0 var(--accent)}')).toHaveLength(1);
    expect(leftAccents('a', "'.ed .cm-activeLine': { boxShadow: 'inset 2px 0 var(--warn)' },")).toHaveLength(1);
    expect(leftAccents('a', '.c{border-left:2px solid transparent}.c.on{border-left-color:var(--accent)}')).toHaveLength(2);
    expect(leftAccents('a', '.q{border-left:3px solid var(--warn);background:var(--warn-2)}')).toHaveLength(1);
    expect(leftAccents('a', "const s = { borderLeft: '2px solid red' }")).toHaveLength(1);
    expect(leftAccents('a', '.p{border-left:1px solid #17303e}.d{border-left:1px solid var(--line-2)}.md blockquote{border-left:2px solid var(--line-2)}')).toEqual([]);
    expect(leftAccents('a', "'.cm-cursor': { borderLeftColor: 'var(--accent)' },")).toEqual([]);
  });
});
