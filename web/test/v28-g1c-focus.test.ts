// v2.8 §4.10 / §4.2 (LT15): the v2.7.1 split button chevron and the cancel popover's buttons carry the hf1117 focus ring —
// inset `--fg-2` on a neutral button, the L10 outer ring on a filled one — never the old 1 px offset outline.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const FILES = ['web/src/tasks/split.css', 'web/src/tasks/spec-card.css'];
const INSET = 'inset 0 0 0 1px var(--fg-2)';
const OUTER = '0 0 0 1px var(--solid),0 0 0 2px var(--fg-2)';

type Rule = { sels: string[]; body: string };
const rules = (src: string): Rule[] => [...src.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => ({ sels: m[1]!.split(',').map(s => s.trim()), body: m[2]!.replace(/\s+/g, ' ') }));
/** focus rules that draw an outline instead of the §4.2 ring */
const outlined = (src: string) => rules(src)
  .filter(r => r.sels.some(s => /:focus/.test(s)) && /outline:\s*(?!none|0)/.test(r.body)).flatMap(r => r.sels);
const ringOf = (src: string, sel: string) => rules(src).find(r => r.sels.includes(sel))?.body.match(/box-shadow:([^;]+)/)?.[1]?.trim();

const all = FILES.map(f => readFileSync(f, 'utf8')).join('\n');

describe('§4.10 v2.7.1 focus rings (LT15)', () => {
  test('self-check: an outline focus rule is caught, a box-shadow one passes', () => {
    expect(outlined('.a:focus-visible{outline:1px solid var(--fg-2)}')).toEqual(['.a:focus-visible']);
    expect(outlined(`.a:focus-visible{outline:none;box-shadow:${INSET}}`)).toEqual([]);
  });
  test('no focus rule in the v2.7.1 split / cancel CSS draws an outline', () => {
    expect(outlined(all)).toEqual([]);
  });
  test('the neutral Giữ button keeps the inset ring on focus (it takes focus when the popover opens)', () => {
    expect(ringOf(all, '.tsk .ckeep:focus')).toBe(INSET);
    expect(ringOf(all, '.tsk .ckeep:focus-visible')).toBe(INSET);
  });
  test('the filled Huỷ build button (--bad fill) carries the L10 outer ring', () => {
    expect(ringOf(all, '.tsk .cgo:focus-visible')).toBe(OUTER);
  });
  test('the split chevron has no own focus rule, so the global inset ring of styles.css applies', () => {
    expect(rules(all).flatMap(r => r.sels).filter(s => s.includes('.sdd:focus'))).toEqual([]);
    const g = readFileSync('web/src/styles.css', 'utf8');
    expect(ringOf(g, 'button:focus-visible')).toBe(INSET);
  });
});

describe('§4.10 fields on --fld-bg (LT15 / LT12: white in light, the old --panel-2 in dark)', () => {
  const g = readFileSync('web/src/styles.css', 'utf8');
  test('both blocks declare --fld-bg; dark keeps --panel-2 so the dark look does not move', () => {
    expect(g.match(/--fld-bg:([^;]+);/g)).toEqual(['--fld-bg:var(--panel-2);', '--fld-bg:#fff;']);
  });
  test('every field with the --fld-line control border sits on --fld-bg', () => {
    const fld = rules(g + all).filter(r => r.body.includes('var(--fld-line)') && /background:/.test(r.body));
    expect(fld.length).toBeGreaterThanOrEqual(2);
    expect(fld.filter(r => !r.body.includes('background:var(--fld-bg)')).map(r => r.sels[0])).toEqual([]);
    expect(rules(all).find(r => r.sels.includes('.tsk .creason input'))?.body).toContain('background:var(--fld-bg)');
  });
});
