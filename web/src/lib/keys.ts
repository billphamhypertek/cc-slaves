// §8.5 keyboard map. Plain keys are dead while typing (v2.3 §4.1: the code viewer `.cm-editor` counts as typing); Esc and
// ⌘… still work everywhere.
export interface KeyLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

export type KeyAction =
  | { t: 'focusConsole' } | { t: 'selectLane'; n: number } | { t: 'cardKey'; n: number } | { t: 'project'; n: number }
  | { t: 'interrupt' } | { t: 'escape' } | { t: 'toggleInbox' } | { t: 'toggleSound' }
  | { t: 'palette' } | { t: 'settings' } | { t: 'toggleList' } | { t: 'fit' } | { t: 'toggleAccounts' } | { t: 'history' }
  /** v2.7 §4.1 the Tasks · Deck · Code · Git switch (T / D / C / G). */
  | { t: 'mode'; m: Mode }
  /** v2.3 §4.1 ⌘P / ⌘S / ⌘W: Code's own keys, always `preventDefault` (no print / save page / close window). */
  | { t: 'code'; k: CodeKey }
  /** v2.3 §4.1 Esc inside `.cm-editor`: CodeMirror's first, then leave the viewer; never a step of the Esc ladder. */
  | { t: 'editorEsc' };
export type Mode = 'tasks' | 'deck' | 'code' | 'git';
export type CodeKey = 'quickOpen' | 'save' | 'closeTab';
const CODE_KEYS: Record<string, CodeKey> = { p: 'quickOpen', s: 'save', w: 'closeTab' };
const MODE_KEYS: Record<string, Mode> = { t: 'tasks', d: 'deck', c: 'code', g: 'git' };

/** `control` = the focus is on a button-like element: Enter is its own click (§4.11 "Enter = bấm nó"), not the composer.
 *  `editor` = the focus is inside the code viewer (`.cm-editor`). */
export function keyAction(e: KeyLike, typing: boolean, control = false, editor = false): KeyAction | null {
  if (e.key === 'Escape') return editor ? { t: 'editorEsc' } : { t: 'escape' };
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd) {
    const ck = CODE_KEYS[e.key.toLowerCase()];
    if (ck) return { t: 'code', k: ck };
    if (e.key === '.') return { t: 'interrupt' };
    if (e.key.toLowerCase() === 'k') return { t: 'palette' };
    if (e.key === ',') return { t: 'settings' };
    if (e.key.toLowerCase() === 'l') return { t: 'focusConsole' }; // v2.1 §4.10 ⌘L: the composer (opens the narrow drawer)
    if (/^[1-9]$/.test(e.key)) return { t: 'project', n: +e.key };
    return null;
  }
  if (typing) return null;
  if (e.altKey) {
    const m = /^Digit([1-4])$/.exec(e.code);
    return m ? { t: 'cardKey', n: +m[1]! } : null;
  }
  if (e.key === 'Enter') return control ? null : { t: 'focusConsole' };
  if (/^[1-9]$/.test(e.key)) return { t: 'selectLane', n: +e.key };
  const k = e.key.toLowerCase();
  if (k === 'q') return { t: 'toggleInbox' };
  if (k === 'm') return { t: 'toggleSound' };
  if (k === 'l') return { t: 'toggleList' };
  if (k === 'f') return { t: 'fit' }; // v2.1 §4.11 "Vừa màn hình"
  if (k === 'a') return { t: 'toggleAccounts' }; // v2.1 §4.11 open / collapse the account panel (§4.7)
  if (k === 'h') return { t: 'history' }; // v2.1 §4.14 Lịch sử phiên, from anywhere
  const m = MODE_KEYS[k];
  return m ? { t: 'mode', m } : null;
}

/** v1 M8: one-letter keys are dead while the focus is in a text field (inputs, textareas, selects, contenteditable) or
 *  anywhere in the code viewer (v2.3 §4.1 V14). */
export function isTyping(el: TypingEl | null | undefined): boolean {
  return !!el && (!!el.matches?.('textarea,input,select') || !!el.isContentEditable || inEditor(el));
}
type TypingEl = { matches?: (sel: string) => boolean; isContentEditable?: boolean; closest?: (sel: string) => unknown };
/** v2.3 §4.1 the focus is inside CodeMirror's `.cm-editor` (the Code viewer). */
export const inEditor = (el: TypingEl | null | undefined): boolean => !!el?.closest?.('.cm-editor');

/** §4.11 a focused element Enter activates natively (a deck node's select button, a row, a link). */
export function isControl(el: { matches?: (sel: string) => boolean } | null | undefined): boolean {
  return !!el?.matches?.('button,a[href],summary,[role=button],[role=menuitem],[role=tab]');
}

/** v2.1 §4.11 the ContextMenu key or ⇧F10 on a focused node opens its "⋯" menu (§4.12). */
export const isMenuKey = (e: { key: string; shiftKey: boolean }) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
