// F22 ⌘K command palette (spec §8.5): ↑↓ chọn · Enter chạy · Esc đóng.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { rankItems, type PalAct, type PalItem } from '../lib/palette.ts';
import { useT } from '../lib/i18n.tsx';
import { Icon } from './icons.tsx';

const MAX = 40;
export function Palette({ items, laneRows, onRun, onClose, initial = '' }: {
  items: PalItem[];
  /** §4.11 N2-k the HÀNH ĐỘNG rows of the lane a query matches by name (lib/palette.ts `laneRows`). */
  laneRows: (projectId: string, name: string) => PalItem[];
  onRun: (a: PalAct) => void; onClose: () => void; initial?: string;
}): ReactElement {
  const tr = useT();
  const [q, setQ] = useState(initial);
  const [i, setI] = useState(0);
  const list = useMemo(() => rankItems(items, q, laneRows).slice(0, MAX), [items, q, laneRows]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setI(0), [q]);
  useEffect(() => { ref.current?.querySelector('.pi.on')?.scrollIntoView({ block: 'nearest' }); }, [i]);
  // group headers in order of first appearance (rankItems keeps LANE → HÀNH ĐỘNG → PROJECT → ACCOUNT)
  const groups: { g: PalItem['group']; items: PalItem[] }[] = [];
  for (const it of list) { const x = groups.find(y => y.g === it.group); if (x) x.items.push(it); else groups.push({ g: it.group, items: [it] }); }
  const flat = groups.flatMap(x => x.items);
  const run = (it: PalItem | undefined) => { if (it && !it.disabled) { onClose(); onRun(it.act); } }; // v2.1 §4.12 dimmed = reason only
  return (
    <div className="modal glass pal" role="dialog" aria-label={tr('palette.aria')} ref={ref}>
      <input autoFocus value={q} placeholder={tr('palette.ph')} aria-label={tr('palette.phAria')} onChange={e => setQ(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setI(n => Math.min(flat.length - 1, n + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setI(n => Math.max(0, n - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); run(flat[i]); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }} />
      <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
        {groups.map(g => <div key={g.g}><h4>{tr(`labels.pal.group.${g.g}`)}</h4>{g.items.map(it => {
          const n = flat.indexOf(it);
          return <button key={it.id} className={`pi ${n === i ? 'on' : ''}${it.disabled ? ' dis' : ''}`} aria-disabled={it.disabled ? true : undefined} onMouseEnter={() => setI(n)} onClick={() => run(it)}>
            <Icon n={it.icon} s={14} /> {it.label}{it.disabled ? <small>{it.disabled}</small> : null}{it.hint ? <small className="hint">{it.hint}</small> : null}{it.kbd ? <kbd>{it.kbd}</kbd> : null}</button>;
        })}</div>)}
        {!flat.length ? <div className="pf">{tr('palette.none', { q })}</div> : null}
      </div>
      <div className="pf">{tr('palette.foot')}</div>
    </div>
  );
}
