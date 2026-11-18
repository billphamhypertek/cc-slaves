// spec v2.4 §6.7 D53 "Đo chữ bằng JS": the size a JS text measure uses comes from the one home lib/mono-font.ts, which reads
// the type-scale token of :root — so a scale change moves the measure with the CSS (no hand-written size).
import { afterEach, describe, expect, test } from 'bun:test';
import { bodyFont, fontPx, monoFont } from '../src/lib/mono-font.ts';

const g = globalThis as Record<string, unknown>;
const root: Record<string, string> = {};
const install = () => {
  g.document = { documentElement: {} };
  g.getComputedStyle = () => ({ getPropertyValue: (k: string) => root[k] ?? '' });
};
afterEach(() => { delete g.document; delete g.getComputedStyle; for (const k of Object.keys(root)) delete root[k]; });

describe('§6.7 D53 monoFont reads the scale token', () => {
  test('§6.7 D53 changing --sm in :root changes monoFont("sm"); --xs is read on its own', () => {
    install();
    Object.assign(root, { '--f-mono': '"JetBrains Mono",monospace', '--sm': '12px', '--xs': '11px' });
    expect(monoFont('sm')).toBe('12px "JetBrains Mono",monospace');
    root['--sm'] = '17px';
    expect(monoFont('sm')).toBe('17px "JetBrains Mono",monospace');
    expect(monoFont('xs')).toBe('11px "JetBrains Mono",monospace');
  });
  test('§6.7 D53 no DOM (or an unset token): the step of the scale (11/12/13/14/16/19/25, hot fix 2026-11-16)', () => {
    expect(monoFont('sm')).toMatch(/^13px /);
    expect(monoFont('xxl')).toMatch(/^25px /);
    install();
    expect(monoFont('xs')).toMatch(/^12px /);
  });
});

describe('§6.7 D53 bodyFont + fontPx (the deck tooltip, the no-canvas fallbacks)', () => {
  test('§6.7 D53 bodyFont reads the step and --f-body, with the weight in front', () => {
    install();
    Object.assign(root, { '--f-body': '"Be Vietnam Pro",sans-serif', '--xs': '11px' });
    expect(bodyFont('xs', 500)).toBe('500 11px "Be Vietnam Pro",sans-serif');
    root['--xs'] = '14px';
    expect(bodyFont('xs', 500)).toBe('500 14px "Be Vietnam Pro",sans-serif');
  });
  test('§6.7 D53 fontPx: the px of a canvas font string; the --sm step when it has none', () => {
    expect(fontPx('11px "JetBrains Mono"')).toBe(11);
    expect(fontPx('500 12.5px x')).toBe(12.5);
    expect(fontPx('bold x')).toBe(13);
  });
});
