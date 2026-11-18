// Hot fix 2026-11-16 "Tất cả project (N)" (docs/ref/hf1116-ux.md §2, Firefox "List all tabs" / VS Code "Show Opened
// Editors"): every project in one list under its button. The filter has the focus (name, case / diacritics ignored);
// ↑ ↓ move, Enter picks, Esc or a click outside closes. Rows: name, Chờ PO badge, unread dot, "Tạm dừng" when held.
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type RefObject } from 'react';
import type { ProjectView } from '../../../shared/protocol.ts';
import { useT } from '../lib/i18n.tsx';
import { filterProjects, moveActive } from '../lib/tabs.ts';

export interface ProjectListProps {
  projects: ProjectView[]; projectId: string | null;
  pendingByProject: Record<string, number>; unread: Set<string>;
  /** the "Tất cả project" button: the list opens under it, right-aligned to it when it would leave the window. */
  anchor: RefObject<HTMLButtonElement | null>;
  onPick: (id: string) => void;
  /** `refocus` = Esc (focus back to the button); a click outside leaves focus where it landed. */
  onClose: (refocus: boolean) => void;
}

/** On `body`: `#top` has a backdrop filter (its own stacking context), the bar under it would paint over the list. */
export function ProjectList(p: ProjectListProps): ReactElement {
  return createPortal(<ProjectListBox {...p} />, document.body);
}

/** @internal the list itself (the unit test renders it without the portal). */
export function ProjectListBox(p: ProjectListProps): ReactElement {
  const tr = useT();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  const box = useRef<HTMLDivElement>(null), list = useRef<HTMLUListElement>(null), input = useRef<HTMLInputElement>(null);
  const rows = filterProjects(p.projects, q);
  const active = Math.min(i, Math.max(0, rows.length - 1));
  useLayoutEffect(() => {
    const a = p.anchor.current?.getBoundingClientRect(), w = box.current?.offsetWidth ?? 0;
    if (a) setPos({ top: a.bottom + 4, left: Math.max(8, Math.min(a.left, window.innerWidth - w - 8)) });
  }, [p.anchor]);
  useEffect(() => { if (pos.top !== undefined) input.current?.focus(); }, [pos.top]); // once placed: a hidden box takes no focus
  useEffect(() => { list.current?.children[active]?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    const f = (e: MouseEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !p.anchor.current?.contains(t)) close.current(false); };
    document.addEventListener('mousedown', f, true);
    return () => document.removeEventListener('mousedown', f, true);
  }, [p.anchor]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setI(moveActive(active, rows.length, e.key === 'ArrowDown' ? 1 : -1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = rows[active]; if (r) p.onPick(r.id); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.onClose(true); }
  };
  return (
    <div ref={box} className="plist glass" style={pos} onKeyDown={onKey}>
      <input ref={input} type="text" value={q} placeholder={tr('topbar.allFilter')} aria-label={tr('topbar.allFilter')} aria-controls="plist-rows"
        aria-activedescendant={rows[active] ? `pl-${rows[active].id}` : undefined} onChange={e => { setQ(e.target.value); setI(0); }} />
      {rows.length ? <ul ref={list} id="plist-rows" role="listbox" aria-label={tr('topbar.allProjects', { n: p.projects.length })}>
        {rows.map((pr, n) => {
          const badge = p.pendingByProject[pr.id] ?? 0, unread = p.unread.has(pr.id) && pr.id !== p.projectId;
          return <li key={pr.id} id={`pl-${pr.id}`} role="option" aria-selected={n === active} className={[n === active ? 'act' : '', pr.id === p.projectId ? 'cur' : ''].filter(Boolean).join(' ')}
            title={pr.name} onMouseEnter={() => setI(n)} onMouseDown={e => e.preventDefault()} onClick={() => p.onPick(pr.id)}>
            <span className="pnm">{pr.name}</span>
            {pr.held ? <span className="pill held">{tr('topbar.held')}</span> : null}
            {badge ? <span className="bdg">{badge}</span> : null}
            {unread ? <span className="unread" /> : null}
          </li>;
        })}
      </ul> : <p className="none">{tr('topbar.allNone')}</p>}
    </div>
  );
}
