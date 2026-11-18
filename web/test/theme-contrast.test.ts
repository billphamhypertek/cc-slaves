// v2.8 §4.2 / §11 / L8: the contrast of the two variable blocks of styles.css, read straight from the file (no hand-written
// numbers). Values are the ones a light / dark element computes: a variable the light block does not redeclare keeps the
// value the dark :root computed (an alias `var(--x)` resolved against the DARK set — the mockup's 1.6–3.2:1 trap).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DARK, LIGHT, LIGHT_SCOPE, resolve } from './theme-vars';

const css = readFileSync('web/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The value a dark element / a light element (a child of :root, like the mockup's frames) computes. */
const dark = (n: string) => resolve(DARK[n] ?? '', DARK);
const light = (n: string) => n in LIGHT ? resolve(LIGHT[n]!, LIGHT_SCOPE) : dark(n);

type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
  const h = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (h) {
    const x = h.length === 3 ? [...h].map(d => d + d).join('') : h;
    return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)).concat(1) as RGBA;
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (!m) throw new Error(`not a colour: ${c}`);
  const p = m[1]!.split(',').map(Number);
  return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
}
const over = (f: RGBA, b: RGBA): RGBA => [0, 1, 2].map(i => f[i]! * f[3] + b[i]! * (1 - f[3])).concat(1) as RGBA;
const lum = (c: RGBA) => {
  const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: RGBA, b: RGBA) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/** A surface: `--bg-2`, or `--sel@--solid` = the rgba `--sel` laid on `--solid` (chains allowed: `--cd-line@--cd-bg`). */
function surface(get: (n: string) => string, s: string): RGBA {
  const parts = s.split('@');
  let b = parse(get(parts.pop()!));
  if (b[3] < 1) b = over(b, [255, 255, 255, 1]);
  for (const p of parts.reverse()) b = over(parse(get(p)), b);
  return b;
}
const measure = (get: (n: string) => string, fg: string, bg: string) => {
  const b = surface(get, bg);
  return ratio(over(parse(fg.startsWith('#') ? fg : get(fg)), b), b);
};

/** CIEDE2000 between two sRGB colours. */
function lab(c: RGBA): [number, number, number] {
  const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function de2000(c1: RGBA, c2: RGBA): number {
  const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2), rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2, G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G), ap2 = a2 * (1 + G), C1 = Math.hypot(ap1, b1), C2 = Math.hypot(ap2, b2);
  const h = (b: number, a: number) => { const v = Math.atan2(b, a) / rad; return v < 0 ? v + 360 : v; };
  const h1 = h(b1, ap1), h2 = h(b2, ap2), dL = L2 - L1, dC = C2 - C1;
  let dh = h2 - h1; if (C1 * C2 === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin(dh * rad / 2), Lb = (L1 + L2) / 2, Cp = (C1 + C2) / 2;
  let hb = h1 + h2; if (C1 * C2 !== 0) hb = Math.abs(h1 - h2) > 180 ? (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2) : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + 0.015 * (Lb - 50) ** 2 / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cp, SH = 1 + 0.015 * Cp * T;
  const RT = -2 * Math.sqrt(Cp ** 7 / (Cp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

// ---------- the pairs (§4.2 condition 1–3; LT12) ----------
const TEXT = ['--fg', '--fg-2', '--fg-3', '--accent', '--ok', '--warn', '--amber', '--bad', '--backup'];
/** every surface a text / status colour can sit on: page grounds, a white panel, the deck ground, a selected row on both */
const GROUNDS = ['--bg', '--bg-2', '--solid', '--dk-bg', '--sel@--solid', '--sel@--bg-2'];
const TEXT_PAIRS: [string, string][] = [
  ...TEXT.flatMap(t => GROUNDS.map(g => [t, g] as [string, string])),
  ['--ink', '--accent'], ['--bdg-fg', '--warn'], ['--ok', '--ok-2@--solid'], ['--warn', '--warn-2@--solid'], ['--bad', '--bad-2@--solid'],
  ['--bad-txt', '--solid'], ['--bad-txt', '--bg-2'],
  ['--dh-fg', '--dh-bg'], ['--dh-hi', '--dh-bg'], ['--dh-mid', '--dh-bg'],
  ['--dk-fg', '--dk-nd@--dk-bg'], ['--dk-tok', '--dk-nd@--dk-bg'], ['--dk-tok', '--dk-nd-on'], ['--dk-id', '--dk-nd@--dk-bg'],
  ['--dk-task', '--dk-nd@--dk-bg'], ['--dk-mut', '--dk-nd@--dk-bg'], ['--dk-mut', '--dk-nd-on'], ['--dk-wait', '--dk-nd@--dk-bg'], ['--dk-err', '--dk-nd@--dk-bg'],
  ['--dk-id', '--dk-nd-on'], ['--dk-task', '--dk-nd-on'], ['--dk-fold-fg', '--dk-nd@--dk-bg'],
  ['--dk-band-fg', '--dk-band-bg@--dk-bg'], ['--dk-fg', '--dk-tip-bg'], ['--dk-id', '--dk-tip-bg'], ['--dk-task', '--dk-tg-bg'],
  ['--ap-warn', '--ap-bg'], ['--ap-bad', '--ap-bg'], ['--ap-mut', '--ap-bg'], ['--ap-mut2', '--ap-bg'], ['--ap-fg', '--ap-bg'], ['--ap-hi', '--sel@--ap-bg'],
  ['--ap-bad', '--sel@--ap-bg'], ['--ap-warn', '--sel@--ap-bg'], ['--ap-mut2', '--sel@--ap-bg'], ['--ap-fg', '--panel-2@--ap-bg'], ['--ap-mut', '--panel-2@--ap-bg'],
  ...['--cd-kw', '--cd-str', '--cd-ty', '--cd-cm'].flatMap(t => [[t, '--cd-bg'], [t, '--cd-line@--cd-bg']] as [string, string][]),
  ...['--cd-kw', '--cd-str', '--cd-ty'].map(t => [t, '--cd-match-on@--cd-bg'] as [string, string]),
  ['--fg', '--cd-add@--cd-bg'], ['--ok', '--cd-add@--cd-bg'], ['--fg', '--cd-del@--cd-bg'], ['--bad', '--cd-del@--cd-bg'],
  ['--term-fg', '--term-bg'], ['--term-mut', '--term-bg'], ['--bad-ink', '--bad'], ['--tag-fg', '--solid'], ['--ok', '--term-bg'], ['--bad', '--term-bg'],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => [`--pal-${i}`, '--solid'] as [string, string]),
];
/** non-text UI (WCAG 1.4.11, ≥ 3): control borders, deck status rings / wires, Account panel bars, Git graph branches */
const UI_PAIRS: [string, string][] = [
  ['--fld-line', '--solid'], ['--fld-line', '--bg-2'], ['--fld-line', '--fld-bg'],
  ...['--dk-run', '--dk-wait', '--dk-err', '--dk-acc', '--dk-amb', '--dk-gry', '--dk-wire', '--dk-nd-line', '--dk-nd-off']
    .map(t => [t, '--dk-bg'] as [string, string]),
  // §4.15 §3 the Xong shelf: its focus ring on the node, at rest and on the selected row
  ['--fg-2', '--dk-nd@--dk-bg'], ['--fg-2', '--dk-nd-on'],
  ['--dk-acc', '--dk-nd-on'], ['--ap-ok', '--ap-bg'], ['--ap-use', '--ap-bg'], ['--ap-unk', '--ap-bg'], ['--ap-mut', '--ap-track'], ['--ap-ok', '--ap-track'],
  // the hf1117 keyboard focus ring (LT12) and the split button chevron, at rest and hovered
  ...['--solid', '--bg-2', '--bg', '--sel@--bg-2', '--panel-2@--bg-2', '--dk-bg', '--cd-bg', '--sel@--panel-2@--bg-2'].map(g => ['--fg-2', g] as [string, string]),
  ...['--accent', '--ok', '--warn', '--bad', '--fg-3'].map(t => [t, '--cd-bg'] as [string, string]),
];
const STATUS = ['--ok', '--warn', '--amber', '--bad', '--accent'];

/** a variable whose dark value (aliases resolved) holds a colour */
const isColour = (n: string) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(dark(n));

describe('§11 theme contrast (light), read from the two blocks of styles.css', () => {
  test('self-check: the measure catches a weak pair and the alias trap', () => {
    expect(ratio(parse('#000'), parse('#fff'))).toBeCloseTo(21, 5);
    expect(measure(() => 'rgba(0,0,0,.10)', '#0d1828', '--sel@--solid')).toBeGreaterThan(4.5);
    expect(de2000(parse('#00ff00'), parse('#00ff00'))).toBe(0);
    expect(de2000(parse('#a34100'), parse('#bc1240'))).toBeGreaterThan(15);
    // an alias declared only on :root keeps the dark value on a light element
    const d = { '--w': '#fbbf24', '--a': 'var(--w)' }, l = { '--w': '#765c00' };
    const lt = (n: string) => n in l ? resolve(l[n as '--w'], { ...d, ...l }) : resolve(d[n as keyof typeof d], d);
    expect(lt('--a')).toBe('#fbbf24');
  });

  test('text ≥ 4.5 on every ground it sits on (incl. a selected row on white and on --bg-2), pills, buttons', () => {
    const weak = TEXT_PAIRS.map(([f, b]) => [f, b, measure(light, f, b)] as const).filter(([, , r]) => r < 4.5).map(([f, b, r]) => `${f} on ${b}: ${r.toFixed(2)}`);
    expect(weak).toEqual([]);
  });

  test('control borders, status rings, wires, bars, graph branches ≥ 3', () => {
    const weak = UI_PAIRS.map(([f, b]) => [f, b, measure(light, f, b)] as const).filter(([, , r]) => r < 3).map(([f, b, r]) => `${f} on ${b}: ${r.toFixed(2)}`);
    expect(weak).toEqual([]);
  });

  test('status colours stay apart: CIEDE2000 ≥ 15 for every pair, in both themes; --backup = --warn (L9)', () => {
    for (const get of [light, dark]) {
      const near = STATUS.flatMap((a, i) => STATUS.slice(i + 1).map(b => [a, b, de2000(parse(get(a)), parse(get(b)))] as const))
        .filter(([, , d]) => d < 15).map(([a, b, d]) => `${a} ↔ ${b}: ${d.toFixed(1)}`);
      expect(near).toEqual([]);
      expect(get('--backup')).toBe(get('--warn'));
    }
  });

  test('every colour variable has a value in both blocks; every alias resolves in both', () => {
    const missingLight = Object.keys(DARK).filter(n => isColour(n) && !(n in LIGHT));
    const missingDark = Object.keys(LIGHT).filter(n => !(n in DARK));
    expect({ missingLight, missingDark }).toEqual({ missingLight: [], missingDark: [] });
    for (const n of Object.keys(LIGHT)) expect(() => light(n)).not.toThrow();
    for (const n of Object.keys(DARK)) expect(() => dark(n)).not.toThrow();
  });
});

/** v2.8 L10: a filled button (primary --accent, solid danger --bad) cannot carry the inset ring on its fill, so its ring sits
 *  outside the fill on the page ground; both themes. */
const FILLED = ['.btn.pri', '.btn.bad.solid', '#inspector .send', '.tsk .tbtn', '.tsk .idet .dok'];
const OUTER_RING = '0 0 0 1px var(--solid),0 0 0 2px var(--fg-2)';
describe('§4.2 L10 focus ring outside filled buttons', () => {
  test('the inset ring fails on the fill, the outer ring passes ≥ 3 on --solid, in both themes', () => {
    for (const get of [light, dark]) {
      expect(measure(get, '--fg-2', '--accent')).toBeLessThan(3);
      expect(measure(get, '--fg-2', '--solid')).toBeGreaterThanOrEqual(3);
    }
  });
  test('every filled button has a :focus-visible rule with the outer ring', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[2]!.replace(/\s+/g, ' ').includes(`box-shadow:${OUTER_RING}`));
    const sels = rules.flatMap(m => m[1]!.split(',').map(x => x.trim()));
    expect(FILLED.filter(f => !sels.includes(`${f}:focus-visible`))).toEqual([]);
  });
});
