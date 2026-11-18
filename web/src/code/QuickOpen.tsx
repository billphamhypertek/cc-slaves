// spec v2.3 §5.1 ⌘P "Tìm file" (C5): a floating box like the ⌘K palette over the Code pane; the engine ranks a fuzzy path
// match in the shown source (≤ 50, best first, following "Hiện file bị bỏ qua"); ↑↓ pick, Enter opens, Esc closes. A row
// = the name (cut in the middle, the typed part bright) + its dir (dim, cut in the middle).
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { errText, useT } from '../lib/i18n.tsx';
import { midEllipsis } from '../lib/mid-ellipsis.ts';
import { Icon } from '../ui/icons.tsx';
import { fileIcon } from './file-view.ts';
import { monoFont } from '../lib/mono-font.ts';
import type { FsApi } from './fs.ts';

const NAME_PX = 330, DIR_PX = 200;
/** `docs/specs/a.md` → ['a.md', 'docs/specs'] */
export const splitPath = (p: string): [string, string] => { const i = p.lastIndexOf('/'); return i < 0 ? [p, ''] : [p.slice(i + 1), p.slice(0, i)]; };
/** the first case-insensitive hit of `q` in `name`, bright */
export function markHit(name: string, q: string): ReactNode {
  const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? name : <>{name.slice(0, i)}<b>{name.slice(i, i + q.length)}</b>{name.slice(i + q.length)}</>;
}

export interface QuickOpenProps { fs: FsApi; src: string; onOpen: (path: string) => void; onClose: () => void }

export function QuickOpen({ fs, src, onOpen, onClose }: QuickOpenProps): ReactElement {
  const tr = useT();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ q: string; paths: string[]; err: string | null }>({ q: '', paths: [], err: null });
  const [i, setI] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const query = q.trim();
    if (!query) { setRes({ q: '', paths: [], err: null }); return; }
    let live = true;
    const t = setTimeout(() => {
      fs.find(query).then(r => { if (live) { setRes({ q: query, paths: r.paths.slice(0, 50), err: null }); setI(0); } },
        (e: unknown) => { if (live) setRes({ q: query, paths: [], err: errText(tr, e) }); });
    }, 60);
    return () => { live = false; clearTimeout(t); };
  }, [q, fs, tr]);
  useEffect(() => { list.current?.querySelector('.qr.on')?.scrollIntoView({ block: 'nearest' }); }, [i]);
  const open = (p: string | undefined) => { if (p !== undefined) { onClose(); onOpen(p); } };
  return (
    <>
      <div className="cqscrim" onMouseDown={onClose} />
      <div className="cqo" role="dialog" aria-label={tr('code.find')}>
        <div className="cqi"><Icon n="search" s={14} />
          <input autoFocus value={q} placeholder={tr('code.find.ph')} aria-label={tr('code.find')} onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI(n => Math.min(res.paths.length - 1, n + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI(n => Math.max(0, n - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); open(res.paths[i]); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="cqr" ref={list} role="listbox">
          {res.paths.map((p, n) => {
            const [name, dir] = splitPath(p);
            return <button key={p} type="button" role="option" aria-selected={n === i} className={`qr${n === i ? ' on' : ''}`} title={p}
              onMouseEnter={() => setI(n)} onClick={() => open(p)}>
              <Icon n={fileIcon(name)} s={13} /><span className="nm">{markHit(midEllipsis(name, NAME_PX, monoFont('sm')), res.q)}</span>
              {dir ? <span className="dir">{midEllipsis(dir, DIR_PX, monoFont('sm'))}</span> : null}
            </button>;
          })}
          {res.err ? <div className="cqn">{tr('code.find.err', { reason: res.err })}</div>
            : res.q && !res.paths.length ? <div className="cqn">{tr('code.find.none', { q: res.q })}</div> : null}
        </div>
        <div className="cqf">{tr('code.find.foot', { src })}</div>
      </div>
    </>
  );
}
