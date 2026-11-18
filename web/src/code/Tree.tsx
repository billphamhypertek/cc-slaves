// spec v2.3 §5.1 the file tree (C1, C2, C24): dirs first, names cut in the middle to the column (full path on hover),
// ignored files dimmed, "Còn n mục · dùng ⌘P" under a cut dir, the C13 skeleton while the root loads. Rows take ↑↓ / ←→ /
// Enter while focused and prevent the default, so Enter never falls through to the composer (§10.1).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { useT } from '../lib/i18n.tsx';
import { midEllipsis } from '../lib/mid-ellipsis.ts';
import { Icon } from '../ui/icons.tsx';
import { fileIcon } from './file-view.ts';
import { monoFont } from '../lib/mono-font.ts';
import { rowKey, treeRows, type RowHandlers, type TreeModel, type TreeRow } from './tree-model.ts';

export interface TreeProps {
  model: TreeModel;
  /** the file shown in the viewer (row highlight) */
  selected: string | null;
  /** column width (280, 240 under 1280 px) */
  width: number;
  onToggle: (dir: string) => void;
  /** one click / Enter: the preview tab (§5.4 1a) */
  onOpen: (path: string) => void;
  /** double click: a pinned tab */
  onPin: (path: string) => void;
  onRetry: (dir: string) => void;
  onFind: () => void;
}

/** v2.4 §6.7 D53 the row's space tokens (styles.css :root): indent --s4 + --s5 a level, `.tr` gap --s2, right pad --s4 */
const S2 = 4, S4 = 10, S5 = 14; // hot fix 2026-11-16 values
/** px left for the name of a row at `depth` (border 1, indent, chevron + icon 26 + gap, right pad) */
export const nameRoom = (width: number, depth: number): number => width - 1 - S4 - depth * S5 - 26 - S2 - S4;
const pad = (depth: number) => ({ paddingLeft: `calc(var(--s4) + ${depth} * var(--s5))` });

export function Tree(p: TreeProps): ReactElement {
  const tr = useT();
  const rows = useMemo(() => treeRows(p.model), [p.model]);
  const [cur, setCur] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const focusCur = useRef(false);
  useEffect(() => {
    if (!focusCur.current || cur === null) return;
    focusCur.current = false;
    box.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(cur)}"]`)?.focus();
  }, [cur]);
  const keys: RowHandlers = { open: p.onOpen, toggle: p.onToggle, focus: path => { focusCur.current = true; setCur(path); } };
  const onKey = (e: KeyboardEvent, r: Extract<TreeRow, { k: 'entry' }>) => {
    if (!rowKey(e.key, r, rows, keys)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const root = p.model.dirs.get('');
  if (!root || root.k === 'loading') {
    return <div className="cskel" aria-label={tr('deck.mode.loading')}>{[0, 1, 2, 1, 0, 1, 2, 2, 0].map((d, i) => <i key={i} style={{ marginLeft: `calc(${d} * var(--s5))` }} />)}</div>;
  }
  const tab = cur ?? p.selected ?? rows.find(r => r.k === 'entry')?.path ?? null;
  return (
    <div className="ctree" role="tree" aria-label={tr('code.tree.aria')} ref={box}>
      {rows.map((r, i) => {
        if (r.k === 'loading') return <div key={`l${i}`} className="tr skl" style={pad(r.depth)}><i /></div>;
        if (r.k === 'more') return <button key={`m${i}`} type="button" className="tr more" style={pad(r.depth)} onClick={p.onFind}>{tr('code.tree.more', { n: r.n })}</button>;
        if (r.k === 'error') return <button key={`e${i}`} type="button" className="tr err" style={pad(r.depth)} onClick={() => p.onRetry(r.dir)}>{tr('code.tree.err')} · {tr('code.retry')}</button>;
        const sel = r.path === p.selected;
        return (
          <button key={r.path} type="button" role="treeitem" data-path={r.path} aria-expanded={r.dir ? r.open : undefined} aria-selected={sel}
            className={`tr${sel ? ' sel' : ''}${r.ignored ? ' ign' : ''}`} style={pad(r.depth)} title={r.path} tabIndex={r.path === tab ? 0 : -1}
            onFocus={() => setCur(r.path)} onKeyDown={e => onKey(e, r)} onClick={() => (r.dir ? p.onToggle(r.path) : p.onOpen(r.path))}
            onDoubleClick={r.dir ? undefined : () => p.onPin(r.path)}>
            <span className="ics">{r.dir ? <><span className={`chv${r.open ? ' on' : ''}`}><Icon n="chevR" s={12} /></span><Icon n="folder" s={13} /></>
              : <><span className="chv" /><Icon n={fileIcon(r.name)} s={13} /></>}</span>
            <span className="fnm">{midEllipsis(r.name, nameRoom(p.width, r.depth), monoFont('xs'))}</span>
          </button>
        );
      })}
    </div>
  );
}
