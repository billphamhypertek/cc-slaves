// spec v2.3 §10.1 / §5.3 one shared view, one EditorState per tab: text, undo history and edit mode survive tab
// switches (W6 ⑥ debt). The repo has no DOM library, so the view is a stub over real CodeMirror states (no DOM).
import { describe, expect, test } from 'bun:test';
import { undo } from '@codemirror/commands';
import { Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { TabEditors, type TabDoc, type TabView } from '../../src/code/editor.ts';

class StubView {
  state!: EditorState;
  setState(s: EditorState): void { this.state = s; }
  dispatch(...a: (Transaction | TransactionSpec)[]): void {
    const x = a[0];
    this.state = x instanceof Transaction ? x.state : this.state.update(...(a as TransactionSpec[])).state;
  }
  destroy(): void {}
  focus(): void {}
}

const tab = (key: string, text: string, o: Partial<TabDoc> = {}): TabDoc => ({ key, v: 1, text, lang: null, wrap: false, endNote: null, ...o });
const mk = () => { const v = new StubView(); return { v, eds: new TabEditors(v as unknown as TabView) }; };
const type = (v: StubView, at: number, s: string) => v.dispatch({ changes: { from: at, insert: s }, userEvent: 'input.type' });
const doUndo = (v: StubView) => undo({ state: v.state, dispatch: tr => v.dispatch(tr) });

describe('§10.1 TabEditors: state per tab', () => {
  test('§5.3 edited text, cursor and edit mode come back after switching to another tab and back', () => {
    const { v, eds } = mk();
    eds.show(tab('a', 'alpha', { edit: true }));
    type(v, 5, '!');
    v.dispatch({ selection: { anchor: 2 } });
    eds.show(tab('b', 'beta'));
    expect(v.state.doc.toString()).toBe('beta');
    expect(v.state.readOnly).toBe(true);
    eds.show(tab('a', 'alpha', { edit: true }));
    expect(v.state.doc.toString()).toBe('alpha!');
    expect(v.state.selection.main.head).toBe(2);
    expect(v.state.readOnly).toBe(false);
  });
  test('§5.3 undo history is per tab and survives the switch (⌘Z in A after visiting B undoes A\'s edit)', () => {
    const { v, eds } = mk();
    eds.show(tab('a', 'one', { edit: true }));
    type(v, 3, ' two');
    eds.show(tab('b', 'x', { edit: true }));
    type(v, 1, 'y');
    eds.show(tab('a', 'one', { edit: true }));
    expect(doUndo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('one');
    eds.show(tab('b', 'x', { edit: true }));
    expect(v.state.doc.toString()).toBe('xy');
  });
  test('§5.3 "Huỷ" / saved: edit mode flips on the same state (text kept) when only `edit` changes', () => {
    const { v, eds } = mk();
    eds.show(tab('a', 'k', { edit: true }));
    type(v, 1, 'z');
    eds.show(tab('a', 'k', { edit: false }));
    expect(v.state.readOnly).toBe(true);
    expect(v.state.doc.toString()).toBe('kz');
  });
  test('§10.2 a new text version (reload / saved from disk) rebuilds the tab; a closed tab is forgotten', () => {
    const { v, eds } = mk();
    eds.show(tab('a', 'old', { edit: true }));
    type(v, 0, '>');
    eds.show(tab('a', 'disk', { v: 2 }));
    expect(v.state.doc.toString()).toBe('disk');
    eds.show(tab('b', 'b'));
    eds.forget(new Set(['b']));
    eds.show(tab('a', 'disk', { v: 2 }));
    expect(v.state.doc.toString()).toBe('disk'); // rebuilt from text: not the kept state
    expect(doUndo(v)).toBe(false);
  });
  test('§5.3 C19 ⌘S / "Huỷ" with the text the editor holds: same state (cursor, undo), only readOnly flips', () => {
    const { v, eds } = mk();
    eds.show(tab('a', 'l1\nl2\nl3\nl4', { edit: true }));
    type(v, 8, '!');
    v.dispatch({ selection: { anchor: 9 } });
    eds.show(tab('a', 'l1\nl2\nl3!\nl4', { v: 2 })); // saved: a new v, the text the editor holds
    expect(v.state.readOnly).toBe(true);
    expect(v.state.selection.main.head).toBe(9);
    eds.show(tab('a', 'l1\nl2\nl3!\nl4', { v: 2, edit: true })); // "Sửa" again: ⌘Z still has the edit
    expect(doUndo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('l1\nl2\nl3\nl4');
  });
  test('§5.3 a kept tab whose new version has the same text keeps its state too', () => {
    const { v, eds } = mk();
    eds.show(tab('a', 'abc', { edit: true }));
    v.dispatch({ selection: { anchor: 2 } });
    eds.show(tab('b', 'b'));
    eds.show(tab('a', 'abc', { v: 3 }));
    expect(v.state.selection.main.head).toBe(2);
    expect(v.state.readOnly).toBe(true);
  });
  test('v2.8 §4.4 a theme switch re-themes the shown tab in place (text, cursor, undo, edit mode kept) and every kept tab on its return', () => {
    const { v, eds } = mk();
    const dark = () => v.state.facet(EditorView.darkTheme);
    eds.show(tab('a', 'alpha', { edit: true }));
    type(v, 5, '!');
    v.dispatch({ selection: { anchor: 2 } });
    eds.show(tab('b', 'beta'));
    eds.show(tab('a', 'alpha', { edit: true }));
    expect(dark()).toBe(true);
    eds.setLook('light');
    expect(dark()).toBe(false);
    expect([v.state.doc.toString(), v.state.selection.main.head, v.state.readOnly]).toEqual(['alpha!', 2, false]);
    doUndo(v);
    expect(v.state.doc.toString()).toBe('alpha');
    eds.show(tab('b', 'beta'));
    expect([v.state.doc.toString(), dark()]).toEqual(['beta', false]);
    eds.setLook('dark');
    eds.show(tab('a', 'alpha', { edit: true }));
    expect([v.state.doc.toString(), dark()]).toEqual(['alpha', true]);
    eds.show(tab('c', 'gamma'));
    expect(dark()).toBe(true);
  });
});
