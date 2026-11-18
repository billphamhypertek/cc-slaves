import { describe, expect, test } from 'bun:test';
import { isTyping, keyAction, type KeyLike } from '../src/lib/keys.ts';

const k = (key: string, over: Partial<KeyLike> = {}): KeyLike => ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
describe('§8.5 ⌘K / ⌘, / L', () => {
  test('⌘K opens the palette, also while typing', () => {
    expect(keyAction(k('k', { metaKey: true }), true)).toEqual({ t: 'palette' });
    expect(keyAction(k('K', { metaKey: true, shiftKey: true }), false)).toEqual({ t: 'palette' });
  });
  test('⌘, opens settings', () => expect(keyAction(k(',', { metaKey: true }), true)).toEqual({ t: 'settings' }));
  test('L toggles list mode, not while typing', () => {
    expect(keyAction(k('l'), false)).toEqual({ t: 'toggleList' });
    expect(keyAction(k('l'), true)).toBeNull();
  });
});

describe('v2.1 §4.11 F = fit (blocked while typing, v1 M8)', () => {
  test('§4.11 F / f → fit', () => {
    expect(keyAction(k('f'), false)).toEqual({ t: 'fit' });
    expect(keyAction(k('F', { shiftKey: true }), false)).toEqual({ t: 'fit' });
  });
  test('§4.11 F ignored while an input has focus (input, textarea, select, contenteditable)', () => {
    const el = (sel: string, editable = false) => ({ matches: (s: string) => s.split(',').includes(sel), isContentEditable: editable });
    for (const t of ['input', 'textarea', 'select']) {
      expect(isTyping(el(t))).toBe(true);
      expect(keyAction(k('f'), isTyping(el(t)))).toBeNull();
    }
    expect(isTyping(el('div', true))).toBe(true);
    expect(isTyping(el('button'))).toBe(false);
    expect(isTyping(null)).toBe(false);
    expect(keyAction(k('f'), isTyping(el('button')))).toEqual({ t: 'fit' });
  });
  test('§4.11 ⌘F is not fit (browser find stays)', () => expect(keyAction(k('f', { metaKey: true }), false)).toBeNull());
});
