// spec v2.4 §6.7 D53 (G6c1): spacing tokens, control heights and the offset under the bars in attach / done / list /
// markdown / model / sessions .css.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { scanBarLiterals, scanSpaceLiterals } from '../check-structure/type-scale';

const FILES = ['attach', 'done', 'list', 'markdown', 'model', 'sessions'] as const;
const css = (f: string) => readFileSync(new URL(`../../web/src/ui/${f}.css`, import.meta.url), 'utf8');
const rule = (text: string, sel: string) => text.split(/\n/).find(l => l.startsWith(sel + '{')) ?? '';

describe('§6.7 D53 G6c1 spacing and bar offsets', () => {
  test.each(FILES)('§6.7 D53 %s.css: no bare px in padding / margin / gap, no px next to var(--bn)', f => {
    const file = `web/src/ui/${f}.css`, text = css(f);
    expect(scanSpaceLiterals(file, text).map(h => `${h.line}: ${h.text}`)).toEqual([]);
    expect(scanBarLiterals(file, text).map(h => `${h.line}: ${h.text}`)).toEqual([]);
  });
  test('§6.7 D53 #listview sits under the top bar + head bar by tokens (was bn + 90px)', () => {
    expect(rule(css('list'), '#listview')).toContain('top:calc(var(--bn) + var(--h-bar) + var(--h-head))');
  });
  test('§6.7 D53 a negative margin is calc(-1 * token) and keeps its pair (md task tick, session dialog body)', () => {
    expect(rule(css('markdown'), '.md ul,.md ol')).toContain('padding-left:var(--s5)');
    expect(rule(css('markdown'), '.md li.md-task')).toContain('margin-left:calc(-1 * var(--s5))');
    expect(rule(css('sessions'), '.sdlg .sdb')).toContain('margin:calc(-1 * var(--s2));padding:var(--s2)');
  });
});

describe('§6.7 D53 G6c1 control heights: no button under 24 × 24', () => {
  test('§6.7 M2 the chip "×" (.ax) is --h-ctl-sm 24 with a -s1 margin so the chip row keeps its height', () => {
    const ax = rule(css('attach'), '.ax');
    for (const d of ['width:var(--h-ctl-sm)', 'height:var(--h-ctl-sm)', 'margin:calc(-1 * var(--s1))']) expect(ax).toContain(d);
  });
  test('§6.7 DK5b "Thử lại" / "đính lại" in a failed chip is a 24 px target with a negative block margin', () => {
    const l = rule(css('attach'), '.fch .s .lnk');
    for (const d of ['height:var(--h-ctl-sm)', 'margin:calc(-1 * var(--s2)) 0']) expect(l).toContain(d);
  });
  test('§6.2 the strip caps at 2 chip rows (1 when short): 40 px chips + the --s2 row gap + the --s1 bottom pad', () => {
    const a = css('attach');
    expect(rule(a, '.tray')).toContain('gap:var(--s2)');
    expect(rule(a, '.tray')).toContain('max-height:calc(2 * 40px + var(--s2) + var(--s1))');
    expect(rule(a, '.tray.one')).toContain('max-height:calc(40px + var(--s1))');
  });
  test('§6.7 D53 inputs 32 → --h-ctl 28, a small select 26 → --h-ctl-sm; done filter row and the MD2 effort segment stay 28 = --h-ctl', () => {
    expect(rule(css('sessions'), '.sdlg .sfield .field')).toContain('height:var(--h-ctl)');
    expect(rule(css('sessions'), '.sdlg .schoice .rsel select.field')).toContain('height:var(--h-ctl-sm)');
    expect(rule(css('done'), '#inspector .dchip')).toContain('height:var(--h-ctl)');
    expect(rule(css('done'), '#inspector .dfil .dq .field')).toContain('height:var(--h-ctl)');
    expect(rule(css('model'), '.lv')).toContain('height:var(--h-ctl)');
  });
});
