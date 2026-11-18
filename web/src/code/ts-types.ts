// spec v2.3 §5.2 the syntax palette gives type names `--warn`; a TS type-only import (`import { type Key }`,
// `import type { A }`) parses its names as plain definitions, so this marks them with the type colour (C1 / C2).
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';

/** the ranges of type-only imported names in [from, to) */
export function typeImports(st: EditorState, from = 0, to = st.doc.length): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  syntaxTree(st).iterate({ from, to, enter: n => {
    const grp = n.node.parent;
    if (n.name !== 'VariableDefinition' || grp?.name !== 'ImportGroup') return;
    if (n.node.prevSibling?.name === 'type' || grp.prevSibling?.name === 'type') out.push({ from: n.from, to: n.to });
  } });
  return out;
}

const mark = Decoration.mark({ class: 'cm-tyi' });
const build = (v: EditorView): DecorationSet =>
  Decoration.set(v.visibleRanges.flatMap(r => typeImports(v.state, r.from, r.to).map(x => mark.range(x.from, x.to))), true);

/** ts / tsx only (the editor host adds it with the language) */
export const typeImportMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(v: EditorView) { this.decorations = build(v); }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
  }
}, { decorations: v => v.decorations });
