// spec v2.3 §5.2 the CodeMirror viewer state (no DOM needed): read-only through `EditorState.readOnly` while the view
// stays editable (focus, ⌘F, selection, copy — research §6), the §5.2 syntax palette in tokens (V19), "Ngắt dòng",
// the large-file end line, and one lazy language per listed extension.
import { describe, expect, test } from 'bun:test';
import type { EditorState } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { editEffect, setEdit, SYNTAX, viewerState } from '../../src/code/editor.ts';
import type { LangId } from '../../src/code/file-view.ts';
import { loadLang } from '../../src/code/lang.ts';

const doc = { text: 'const a = 1\n', lang: null, wrap: false, endNote: null };

describe('§5.2 viewer state', () => {
  test('§5.2 read-only by EditorState.readOnly, never EditorView.editable(false)', () => {
    const s = viewerState(doc);
    expect(s.readOnly).toBe(true);
    expect(s.facet(EditorView.editable)).toBe(true);
  });
  test('§5.3 "Sửa" turns the same state editable (cursor / selection kept); "Huỷ" back to read-only', () => {
    const s0 = viewerState({ ...doc, text: 'a\nbb\nccc' });
    const sel = s0.update({ selection: { anchor: 4 } }).state;
    const on = sel.update({ effects: editEffect(true) }).state;
    expect(on.readOnly).toBe(false);
    expect(on.selection.main.head).toBe(4);
    expect(on.update({ effects: editEffect(false) }).state.readOnly).toBe(true);
  });
  test('§3.3 T7 "Sửa" puts the focus in the text (typing never reaches the one-letter shortcuts); "Huỷ" / no flip leaves focus alone', () => {
    let focused = 0;
    const v = { state: viewerState(doc), dispatch(tr: { effects: unknown }) { v.state = v.state.update(tr as never).state; }, focus() { focused++; } };
    setEdit(v as never, false);
    expect(focused).toBe(0);
    setEdit(v as never, true);
    expect([v.state.readOnly, focused]).toEqual([false, 1]);
    setEdit(v as never, true);
    expect(focused).toBe(1);
    setEdit(v as never, false);
    expect([v.state.readOnly, focused]).toEqual([true, 1]);
  });
  test('§5.4 C29 a restored buffer opens editable with the cursor on its line', () => {
    const s = viewerState({ ...doc, text: 'a\nbb\nccc', edit: true, line: 3 });
    expect(s.readOnly).toBe(false);
    expect(s.doc.lineAt(s.selection.main.head).number).toBe(3);
    expect(viewerState({ ...doc, text: 'a', line: 9 }).selection.main.head).toBe(0);
  });
  test('§5.2 "Ngắt dòng" adds line wrapping only when on', () => {
    expect(viewerState(doc).facet(EditorView.contentAttributes).some(a => (a as { class?: string }).class === 'cm-lineWrapping')).toBe(false);
    expect(viewerState({ ...doc, wrap: true }).facet(EditorView.contentAttributes).some(a => (a as { class?: string }).class === 'cm-lineWrapping')).toBe(true);
  });
  test('§5.2 large: the "… cắt ở 2 MB" line is one static block widget after the last line (a function source would throw in the view)', () => {
    const statics = (st: EditorState): DecorationSet[] => st.facet(EditorView.decorations).filter((x): x is DecorationSet => typeof x !== 'function');
    expect(statics(viewerState(doc))).toEqual([]);
    const s = viewerState({ ...doc, endNote: '… cắt ở 2 MB' });
    const seen: { from: number; block: boolean }[] = [];
    for (const set of statics(s)) set.between(0, s.doc.length, (from, _to, v) => { seen.push({ from, block: v.spec.block === true }); });
    expect(seen).toEqual([{ from: s.doc.length, block: true }]);
  });
  test('§5.2 syntax palette = the spec table, in Code root tokens (V19)', () => {
    const color = (tag: unknown) => SYNTAX.find(s => s.tags.includes(tag as never))?.color;
    expect([color(t.keyword), color(t.operatorKeyword)]).toEqual(['var(--cd-kw)', 'var(--cd-kw)']);
    expect([color(t.string), color(t.regexp)]).toEqual(['var(--cd-str)', 'var(--cd-str)']);
    expect([color(t.typeName), color(t.className), color(t.number)]).toEqual(['var(--cd-ty)', 'var(--cd-ty)', 'var(--cd-ty)']);
    const cm = SYNTAX.find(s => s.tags.includes(t.comment));
    expect([cm?.color, cm?.italic]).toEqual(['var(--cd-cm)', true]);
    const h = SYNTAX.find(s => s.tags.includes(t.heading));
    expect([h?.color, h?.bold]).toEqual(['var(--fg)', true]);
    expect(SYNTAX.every(s => s.color.startsWith('var(--'))).toBe(true);
  });
  test('v2.8 §4.4 the editor theme follows the page: dark unless <html data-theme=light>', () => {
    expect(viewerState(doc).facet(EditorView.darkTheme)).toBe(true);
    expect(viewerState(doc, 'dark').facet(EditorView.darkTheme)).toBe(true);
    expect(viewerState(doc, 'light').facet(EditorView.darkTheme)).toBe(false);
  });
});

describe('§10.3 lazy languages', () => {
  test('§5.2 every listed language loads its extension', async () => {
    const ids: LangId[] = ['js', 'jsx', 'ts', 'tsx', 'json', 'md', 'css', 'html', 'py', 'rs', 'go', 'yaml', 'toml', 'sh', 'sql'];
    const exts = await Promise.all(ids.map(loadLang));
    expect(exts.every(e => e !== null && e !== undefined)).toBe(true);
  });
});
