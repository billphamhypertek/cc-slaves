import { describe, expect, test } from 'bun:test';
import { isControl, keyAction, type KeyLike } from '../src/lib/keys.ts';

const k = (key: string, over: Partial<KeyLike> = {}): KeyLike =>
  ({ key, code: /^\d$/.test(key) ? 'Digit' + key : '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe('§8.5 keyboard map', () => {
  test('Enter focuses the console', () => expect(keyAction(k('Enter'), false)).toEqual({ t: 'focusConsole' }));
  test('§4.11 "Enter = bấm nó": Enter on a focused button / role=button (a deck node) is left to the control', () => {
    expect(keyAction(k('Enter'), false, true)).toBeNull();
    const el = (sel: string) => ({ matches: (q: string) => q.split(',').includes(sel) });
    expect(isControl(el('button'))).toBe(true);
    expect(isControl(el('[role=button]'))).toBe(true);
    expect(isControl(el('div'))).toBe(false);
    expect(isControl(null)).toBe(false);
    expect(keyAction(k('1'), false, true)).toEqual({ t: 'selectLane', n: 1 }); // other keys still work on a focused node
  });
  test('1–9 select a unit', () => {
    expect(keyAction(k('1'), false)).toEqual({ t: 'selectLane', n: 1 });
    expect(keyAction(k('9'), false)).toEqual({ t: 'selectLane', n: 9 });
  });
  test('⌥1–⌥4 answer the selected card (uses code: ⌥1 types ¡ on macOS)', () => {
    expect(keyAction(k('¡', { altKey: true, code: 'Digit1' }), false)).toEqual({ t: 'cardKey', n: 1 });
    expect(keyAction(k('¢', { altKey: true, code: 'Digit4' }), false)).toEqual({ t: 'cardKey', n: 4 });
    expect(keyAction(k('§', { altKey: true, code: 'Digit5' }), false)).toBeNull();
  });
  test('⌘1–⌘9 switch project, also while typing', () => {
    expect(keyAction(k('2', { metaKey: true }), false)).toEqual({ t: 'project', n: 2 });
    expect(keyAction(k('2', { metaKey: true }), true)).toEqual({ t: 'project', n: 2 });
  });
  test('⌘. interrupts the current target, also while typing', () => {
    expect(keyAction(k('.', { metaKey: true }), true)).toEqual({ t: 'interrupt' });
  });
  test('Esc works while typing', () => expect(keyAction(k('Escape'), true)).toEqual({ t: 'escape' }));
  test('Q toggles inbox, M toggles sound', () => {
    expect(keyAction(k('q'), false)).toEqual({ t: 'toggleInbox' });
    expect(keyAction(k('M', { shiftKey: true }), false)).toEqual({ t: 'toggleSound' });
  });
  test('plain keys do nothing while typing in an input', () => {
    expect(keyAction(k('q'), true)).toBeNull();
    expect(keyAction(k('1'), true)).toBeNull();
    expect(keyAction(k('Enter'), true)).toBeNull();
    expect(keyAction(k('¡', { altKey: true, code: 'Digit1' }), true)).toBeNull();
  });
  test('other ⌘ letters are not handled', () => expect(keyAction(k('j', { metaKey: true }), false)).toBeNull());
});
