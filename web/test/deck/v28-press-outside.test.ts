// v2.8 §4.9 D98: a press outside the open Account panel collapses it; inside = the panel and a "⋯" menu layer (judged by the
// menu's root, it renders outside the panel's DOM); an overlay on top (`hold`) means no press is "outside". §4.3 / G2b: the
// open-panel shadow is a theme variable (`--shadow-panel`), dark = the v2.7.1 value.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { pressOutside, shownNow } from '../../src/deck/accounts.ts';

/** A fake element whose ancestors carry `classes` (closest() answers like the DOM's for single-class selectors). */
const el = (...classes: string[]) => ({
  closest: (sel: string) => (sel.split(',').map(s => s.trim().slice(1)).some(c => classes.includes(c)) ? {} : null),
});

describe('v28-rr N-4 shownNow: the computed visibility, no checkVisibility (WebKit < 17.4 on the macOS 13 floor lacks it)', () => {
  test('visible → shown; hidden (the Tasks tab hides the deck, it inherits) or no panel → not shown', () => {
    const cs = (v: string) => () => ({ visibility: v });
    const a = {} as Element;
    expect(shownNow(a, cs('visible'))).toBe(true);
    expect(shownNow(a, cs('hidden'))).toBe(false);
    expect(shownNow(a, cs('collapse'))).toBe(false);
    expect(shownNow(null, cs('visible'))).toBe(false);
  });
  test('web/src never calls checkVisibility', () => {
    const hits = [...new Bun.Glob('web/src/**/*.{ts,tsx}').scanSync()].filter(f => /\.checkVisibility\s*\(/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('§4.9 D98 pressOutside', () => {
  test('the deck, a node, the left column, the top bar → outside', () => {
    for (const t of [el('nd'), el('map'), el('left'), el('tbar'), el()]) expect(pressOutside(t, false, true)).toBe(true);
  });
  test('inside the panel (head ⟳, row ⟳, ⋯, Lọc, Hiện n, 429 band, tooltip, scrollbar) → not outside', () => {
    expect(pressOutside(el('accp', 'aref'), false, true)).toBe(false);
    expect(pressOutside(el('accp', 'abnr'), false, true)).toBe(false);
  });
  test('a ⋯ menu item rendered outside the panel DOM → judged by the menu root, not outside', () => {
    expect(pressOutside(el('amenu-layer', 'amenu'), false, true)).toBe(false);
  });
  test('an overlay on top (SA1 / SA3 / SA4, A6, F19, palette) → nothing is outside, even the overlay backdrop', () => {
    expect(pressOutside(el('nd'), true, true)).toBe(false);
    expect(pressOutside(el(), true, true)).toBe(false);
  });
  test('v28-fx: a panel that is open but not on screen (Tasks tab keeps it mounted, hidden) → no press is outside', () => {
    expect(pressOutside(el('tab'), false, false)).toBe(false);
    expect(pressOutside(el('nd'), false, false)).toBe(false);
  });
  test('a target with no closest() (document) → outside', () => {
    expect(pressOutside(null, false, true)).toBe(true);
    expect(pressOutside({}, false, true)).toBe(true);
  });
});

describe('§4.3 G2b open-panel shadow through --shadow-panel', () => {
  const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
  const block = (light: boolean) => new RegExp(light ? /^:root\[data-theme=light\]\{[^}]*\}/m : /^:root\{[^}]*\}/m).exec(css)![0];
  const val = (b: string) => /--shadow-panel:([^;}]+)/.exec(b)?.[1];
  test('declared in both blocks; dark = the v2.7.1 value (dark unchanged), light = the LT3 mockup look', () => {
    expect(val(block(false))).toBe('-14px 0 30px rgba(0,0,0,.45)');
    expect(val(block(true))).toBe('-14px 0 30px rgba(20,40,80,.16)');
  });
  test('the open panel uses it', () => {
    expect(readFileSync(new URL('../../src/deck/AccountPanel.css', import.meta.url), 'utf8')).toMatch(/\.accp\.open\{[^}]*box-shadow:var\(--shadow-panel\)/);
  });
});
