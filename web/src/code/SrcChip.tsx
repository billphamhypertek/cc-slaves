// spec v2.3 §5.1 the source chip (C1, C2, C12) and its list: the project folder (`--accent`) and the worktree of every lane
// that still has one (lane name in its v2.1 §4.3 state colour, state, short path on hover). A pick changes only the Code
// source, never Đang xem (V3). Many lanes (§7 last row) → a filter field on top.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { LaneView } from '../../../shared/protocol.ts';
import { useT } from '../lib/i18n.tsx';
import { LANE_CLASS, laneState } from '../lib/labels.ts';
import { Icon } from '../ui/icons.tsx';

export type SrcLane = Pick<LaneView, 'name' | 'state' | 'cwd' | 'worktreeExists' | 'branch'>;
/** the lanes the chip lists: a worktree of their own (a lane running in the repo is the project folder) */
export const srcLanes = <L extends SrcLane>(lanes: readonly L[]): L[] => lanes.filter(l => l.worktreeExists && l.branch?.state !== 'none');
/** the filter shows from this many lanes */
export const FILTER_FROM = 8;
const tone = (l: SrcLane | undefined): string => (l ? LANE_CLASS[l.state] || 'mut' : 'acc');
/** `/Users/x/Projects/hagenta-d15` → `…/Projects/hagenta-d15` */
const shortPath = (p: string): string => { const s = p.split('/').filter(Boolean); return s.length > 2 ? `…/${s.slice(-2).join('/')}` : p; };

export function SrcChip({ lane, lanes, onPick }: { lane: string | null; lanes: readonly SrcLane[]; onPick: (lane: string | null) => void }): ReactElement {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const list = useMemo(() => srcLanes(lanes), [lanes]);
  const shown = useMemo(() => list.filter(l => l.name.toLowerCase().includes(q.trim().toLowerCase())), [list, q]);
  const cur = lane === null ? undefined : lanes.find(l => l.name === lane);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [open]);
  const pick = (l: string | null) => { setOpen(false); setQ(''); onPick(l); };
  return (
    <div className="csrcw" ref={box} onKeyDown={e => { if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); } }}>
      <button type="button" className={`csrc ${tone(cur)}`} aria-haspopup="listbox" aria-expanded={open} title={tr('code.src.pick')} onClick={() => setOpen(o => !o)}>
        <Icon n="folder" s={13} /><span>{lane === null ? tr('code.src.base') : tr('code.src.lane', { lane })}</span><Icon n="chev" s={12} />
      </button>
      {open ? <div className="csrcl" role="listbox" aria-label={tr('code.src.list')}>
        {list.length >= FILTER_FROM ? <input autoFocus className="csrcf" value={q} placeholder={tr('code.src.filter')} aria-label={tr('code.src.filter')} onChange={e => setQ(e.target.value)} /> : null}
        <button type="button" role="option" aria-selected={lane === null} className={`csrco acc${lane === null ? ' on' : ''}`} onClick={() => pick(null)}>
          <Icon n="folder" s={13} /><span className="nm">{tr('code.src.base')}</span>
        </button>
        {shown.map(l => <button key={l.name} type="button" role="option" aria-selected={lane === l.name} title={l.cwd}
          className={`csrco ${tone(l)}${lane === l.name ? ' on' : ''}`} onClick={() => pick(l.name)}>
          <Icon n="folder" s={13} /><span className="nm">{l.name}</span><span className="st">{laneState(tr, l.state)}</span><span className="pth">{shortPath(l.cwd)}</span>
        </button>)}
        {list.length && !shown.length ? <div className="csrcn">{tr('code.src.none')}</div> : null}
      </div> : null}
    </div>
  );
}
