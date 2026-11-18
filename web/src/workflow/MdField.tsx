// spec v2.9 §4.3 the instruction box: CodeMirror (v2.3), grows with its text, `{{slot}}` shown as a grey atomic chip with its
// Vietnamese name ("Luật: Giao mục ưu tiên trước"; the slot code on hover), a footer "40 dòng · ≈ 600 token · markdown"
// ("· chỉ đọc" when read only: a built-in, the Nhập viewer WF9c).
// A change reaches the pack after a short pause (each change is a `workflow_edit` round trip) and on blur.
import { useEffect, useRef, type ReactElement } from 'react';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, lineNumbers, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import type { Tr } from '../../../shared/i18n/core.ts';
import { SLOT_RE } from '../../../shared/workflows.ts';
import { bodySize } from '../lib/workflow.ts';

class SlotChip extends WidgetType {
  constructor(readonly code: string, readonly label: string) { super(); }
  override eq(o: SlotChip) { return o.code === this.code && o.label === this.label; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'slot';
    s.textContent = this.label;
    s.title = `{{${this.code}}}`;
    return s;
  }
}

/** The Vietnamese name of a slot (`rule:priority_first` → "Luật: Giao mục ưu tiên trước"); an unknown one shows its code. */
function slotLabel(tr: Tr, code: string): string {
  const k = `workflow.slot.${code.replace(':', '_')}`;
  const v = tr(k as Parameters<Tr>[0]);
  return v === k ? `{{${code}}}` : v;
}

function slotPlugin(tr: Tr) {
  const build = (v: EditorView): DecorationSet => {
    const b = new RangeSetBuilder<Decoration>();
    for (const { from, to } of v.visibleRanges) {
      const text = v.state.doc.sliceString(from, to);
      for (const m of text.matchAll(SLOT_RE)) {
        const at = from + m.index;
        b.add(at, at + m[0].length, Decoration.replace({ widget: new SlotChip(m[1]!, slotLabel(tr, m[1]!)) }));
      }
    }
    return b.finish();
  };
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  }, { decorations: p => p.decorations, provide: p => EditorView.atomicRanges.of(v => v.plugin(p)?.decorations ?? Decoration.none) });
}

const look = EditorView.theme({
  '&': { color: 'var(--fg-2)', backgroundColor: 'transparent', fontSize: 'var(--xs)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--f-mono)', lineHeight: '1.65' },
  '.cm-content': { padding: 'var(--s2) 0', caretColor: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--fg-3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '26px', padding: '0 var(--s3) 0 0' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-placeholder': { color: 'var(--fg-3)', fontStyle: 'italic' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--sel)' },
});

interface MdFieldProps {
  tr: Tr; value: string; readOnly: boolean; label: string;
  onChange: (text: string) => void;
}

/** A view-only empty instruction is one grey line, not an empty editor. */
export function MdField(p: MdFieldProps): ReactElement {
  return p.readOnly && !p.value.trim() ? <div className="fnote">{p.tr('workflow.node.empty')}</div> : <Editor {...p} />;
}

function Editor({ tr, value, readOnly, label, onChange }: MdFieldProps): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const timer = useRef(0);
  const sent = useRef(value);
  const cb = useRef(onChange);
  cb.current = onChange;
  const flush = () => {
    window.clearTimeout(timer.current);
    const v = view.current;
    if (v && v.state.doc.toString() !== sent.current) { sent.current = v.state.doc.toString(); cb.current(sent.current); }
  };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping, look, slotPlugin(tr),
          EditorState.readOnly.of(readOnly), placeholder(tr('workflow.f.bodyPlaceholder')), EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of(u => { if (u.docChanged) { window.clearTimeout(timer.current); timer.current = window.setTimeout(flush, 400); } }),
          EditorView.domEventHandlers({ blur: () => { flush(); } }),
        ],
      }),
    });
    view.current = v;
    return () => { flush(); window.clearTimeout(timer.current); v.destroy(); view.current = null; };
    // the editor is made once per mount; value / readOnly changes are pushed below (the panel remounts it per step)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // the pack changed under the editor (Bỏ thay đổi, reload from disk): take the new text unless a change is still pending
  useEffect(() => {
    const v = view.current;
    if (!v || value === v.state.doc.toString()) return;
    if (v.state.doc.toString() !== sent.current) return;
    sent.current = value;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  const z = bodySize(value);
  return <div className={`mde${readOnly ? ' ro' : ''}`}>
    <div ref={host} className="mdh" />
    <div className="mf2"><span>{tr('workflow.f.lines', { n: z.lines })} · ≈ {z.tokens} token</span><span>{tr(readOnly ? 'workflow.imp.readOnly' : 'workflow.f.markdown')}</span></div>
  </div>;
}
