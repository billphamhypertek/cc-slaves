// spec v2.3 §5.2 / §5.3 the CodeMirror 6 viewer / editor, its own lazy chunk (`cm`, §10.1 / §10.3): read-only through
// `EditorState.readOnly` ("Sửa" flips it on the same state: cursor and selection stay) (keeps focus, ⌘F, selection, copy — never `EditorView.editable(false)`, research §6), line
// numbers, ⌘F search, the "Ngắt dòng" switch, the §5.2 syntax palette. The theme reads the page's tokens as `var(--token)`
// (§10.3: tried first, works — the values are plain CSS strings in CodeMirror's style module); v2.8 §4.4 its `dark` flag
// follows `<html data-theme>` through a Compartment, so a theme switch keeps cursor, scroll and undo. A large file (§5.2) is
// plain text with a "… cắt ở 2 MB" line after the last one.
import { Compartment, EditorState, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { tags as t, type Tag } from '@lezer/highlight';
import type { LangId } from './file-view.ts';
import { loadLang } from './lang.ts';
import { typeImportMarks } from './ts-types.ts';

/** §5.2 syntax palette: highlight tags → the token they take (also used by the Git diff). */
export const SYNTAX: readonly { tags: Tag[]; color: string; bold?: boolean; italic?: boolean }[] = [
  { tags: [t.keyword, t.operatorKeyword], color: 'var(--cd-kw)' },
  { tags: [t.string, t.regexp, t.special(t.string)], color: 'var(--cd-str)' },
  { tags: [t.typeName, t.className, t.namespace, t.number, t.bool, t.null, t.atom, t.constant(t.name), t.standard(t.name)], color: 'var(--cd-ty)' },
  { tags: [t.comment], color: 'var(--cd-cm)', italic: true },
  { tags: [t.heading, t.strong], color: 'var(--fg)', bold: true },
  { tags: [t.emphasis], color: 'var(--fg)', italic: true },
];
const highlight = HighlightStyle.define(SYNTAX.map(s => ({ tag: s.tags, color: s.color, fontWeight: s.bold ? '700' : undefined, fontStyle: s.italic ? 'italic' : undefined })));

const look = {
  '&': { flex: '1', minHeight: '0', height: '100%', color: 'var(--fg-2)', backgroundColor: 'transparent', fontSize: 'var(--sm)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--f-mono)', lineHeight: '1.7', overflow: 'auto' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 14px 0 20px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--fg-3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '40px', padding: '0 0 0 12px', textAlign: 'right' },
  // v2.8 L6 the cursor line is a neutral grey step lighter than a selected row, its number bold; editing (the host gets
  // `.ed`, §5.3 C6) turns only the number yellow — no tinted line, no left stripe (PO 2026-11-16: coloured selection banned)
  '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--cd-line)', color: 'var(--fg)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLineGutter': { color: 'var(--fg)', fontWeight: '600' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.ed &.cm-focused .cm-activeLineGutter': { color: 'var(--warn)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-tyi': { color: 'var(--warn)' }, // a type-only import name (ts-types.ts)
  // §4.4 text selection and ⌘F matches mark content, not a selected row: they keep a colour
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb,var(--accent) 22%,transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb,var(--accent) 12%,transparent)' },
  '.cm-searchMatch': { backgroundColor: 'var(--cd-match)', outline: '1px solid var(--cd-match-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--cd-match-on)' },
  '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--fg)', fontFamily: 'var(--f-body)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-textfield': { backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--line-2)', borderRadius: '5px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--bg-2)', color: 'var(--fg-2)', border: '1px solid var(--line-2)', borderRadius: '5px' },
  '.cm-endnote': { padding: '0 14px 10px 20px', color: 'var(--fg-3)', fontStyle: 'italic' },
};
/** v2.8 §4.4 the page's theme (`<html data-theme>`, set by G4); the editor's `dark` flag follows it */
export type Look = 'dark' | 'light';
const THEMES: Record<Look, Extension> = { dark: EditorView.theme(look, { dark: true }), light: EditorView.theme(look, { dark: false }) };
const pageLook = (): Look => (typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark');
const themeSlot = new Compartment();
/** a state shown under `l`: re-themed in place when it was made under the other theme (text, cursor, undo kept) */
function fit(v: Pick<EditorView, 'state' | 'dispatch'>, l: Look): void {
  if (themeSlot.get(v.state) !== THEMES[l]) v.dispatch({ effects: themeSlot.reconfigure(THEMES[l]) });
}

class EndNote extends WidgetType {
  constructor(readonly text: string) { super(); }
  override eq(o: EndNote): boolean { return o.text === this.text; }
  toDOM(): HTMLElement { const d = document.createElement('div'); d.className = 'cm-endnote'; d.textContent = this.text; return d; }
}

export interface ViewerDoc {
  text: string;
  /** highlight language; null = plain text (other extensions, large files) */
  lang: LangId | null;
  /** §5.2 "Ngắt dòng" */
  wrap: boolean;
  /** §5.2 large file: the line after the last one ("… cắt ở 2 MB …") */
  endNote: string | null;
  /** §5.3 edit mode */
  edit?: boolean;
  /** C29 the cursor line of a restored buffer (1-based) */
  line?: number;
}

const langSlot = new Compartment();
const roSlot = new Compartment();
/** §5.3 "Sửa" / "Huỷ" / saved: the same state, editable or not */
export const editEffect = (on: boolean): StateEffect<unknown> => roSlot.reconfigure(EditorState.readOnly.of(!on));

/** The state of one file, read-only unless `d.edit` (the language is filled in once its chunk is in). */
export function viewerState(d: ViewerDoc, l: Look = pageLook()): EditorState {
  const ext: Extension[] = [
    roSlot.of(EditorState.readOnly.of(!d.edit)), history(), lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
    search({ top: true }), highlightSelectionMatches(), keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
    themeSlot.of(THEMES[l]), syntaxHighlighting(highlight), langSlot.of([]),
  ];
  if (d.wrap) ext.push(EditorView.lineWrapping);
  const st0 = EditorState.create({ doc: d.text, extensions: ext });
  const st = d.line && d.line <= st0.doc.lines ? st0.update({ selection: { anchor: st0.doc.line(d.line).from } }).state : st0;
  if (d.endNote === null) return st;
  // a block widget must come from a static set (CodeMirror refuses block decorations from a function / plugin)
  const end = Decoration.set([Decoration.widget({ widget: new EndNote(d.endNote), block: true, side: 1 }).range(st.doc.length)]);
  return st.update({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(end)) }).state;
}

/** Show `d` in `view`; the language chunk loads after and only applies if the view still shows this state. */
function showDoc(view: TabView, d: ViewerDoc, l: Look): void {
  const st = viewerState(d, l);
  view.setState(st);
  if (d.lang === null) return;
  const ts = d.lang === 'ts' || d.lang === 'tsx';
  void loadLang(d.lang).then(ext => { if (view.state.doc === st.doc) view.dispatch({ effects: langSlot.reconfigure(ts ? [ext, typeImportMarks] : ext) }); }, () => {});
}

/** a tab's doc: `key` = the tab, `v` = the text version (a new `v` with another text = rebuild from `text`) */
export interface TabDoc extends ViewerDoc { key: string; v: number }
/** "Sửa" / "Huỷ" flip `readOnly` on the shown state; "Sửa" also puts the focus in the text, so the PO types right after the
 *  click (§3.3 T7) instead of the keys reaching the app's one-letter shortcuts. */
export function setEdit(v: Pick<EditorView, 'state' | 'dispatch' | 'focus'>, edit: boolean): void {
  if (v.state.readOnly !== edit) return;
  v.dispatch({ effects: editEffect(edit) });
  if (edit) v.focus();
}

/** what `TabEditors` drives: the one `EditorView` (a stub over real states in unit tests, the repo has no DOM library) */
export type TabView = Pick<EditorView, 'state' | 'setState' | 'dispatch' | 'destroy' | 'focus'>;
/** §10.1 one shared `EditorView`; each open tab keeps its own `EditorState` (text, cursor, undo, edit mode) and the view
 *  swaps them on a tab switch. */
export class TabEditors {
  private kept = new Map<string, { v: number; st: EditorState }>();
  private cur: { key: string; v: number } | null = null;
  private look: Look = pageLook();
  private watch: MutationObserver | null = null;
  constructor(private readonly view: TabView) {}
  /** the view in `parent`; `onChange(text, cursorLine)` after each edit */
  static mount(parent: HTMLElement, onChange: (text: string, line: number) => void): TabEditors {
    const eds = new TabEditors(new EditorView({ parent, dispatchTransactions: (trs, view) => {
      view.update(trs);
      if (trs.some(t => t.docChanged)) onChange(view.state.doc.toString(), view.state.doc.lineAt(view.state.selection.main.head).number);
    } }));
    eds.watch = new MutationObserver(() => eds.setLook(pageLook()));
    eds.watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return eds;
  }
  /** v2.8 §4.4 the page switched theme: the shown tab now, a kept tab when it comes back (`show`) */
  setLook(l: Look): void {
    this.look = l;
    if (this.cur) fit(this.view, l);
  }
  show(d: TabDoc): void {
    const v = this.view;
    if (this.cur?.key !== d.key || this.cur.v !== d.v) {
      // C19 a new `v` whose text is what the state already holds (⌘S, "Huỷ" on clean text) keeps cursor, scroll and undo
      const same = (st: EditorState, kv: number) => kv === d.v || st.doc.toString() === d.text;
      if (this.cur?.key !== d.key) {
        if (this.cur) this.kept.set(this.cur.key, { v: this.cur.v, st: v.state });
        const k = this.kept.get(d.key);
        if (k && same(k.st, k.v)) { v.setState(k.st); fit(v, this.look); } else showDoc(v, d, this.look);
      } else if (!same(v.state, this.cur.v)) showDoc(v, d, this.look);
      this.cur = { key: d.key, v: d.v };
    }
    setEdit(v, !!d.edit);
  }
  /** a closed tab */
  forget(keep: ReadonlySet<string>): void { for (const k of this.kept.keys()) if (!keep.has(k)) this.kept.delete(k); }
  destroy(): void { this.watch?.disconnect(); this.view.destroy(); }
}
