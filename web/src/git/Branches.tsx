// spec v2.3 §6.1 "Nhánh · n" (G1–G16): the base row, lane rows (deck order, then done not merged, then deleted), the folded
// "n nhánh đã merge ▸" line, "Lọc nhánh" past 12 branches, "đang đo lại…" (G5), "Không đo được · Thử lại" (G6).
import { useState, type ReactElement, type ReactNode } from 'react';
import type { GitBranchesResult } from '../../../shared/protocol.ts';
import { useT } from '../lib/i18n.tsx';
import { LANE_CLASS, laneState } from '../lib/labels.ts';
import { Icon } from '../ui/icons.tsx';
import { useFade } from '../lib/fade.ts';
import { onListKey } from './list-keys.ts';
import { measureOf, reasonText, type GitPick, type LaneRow } from './model.ts';

/** §6.1 past this many branches the block gets "Lọc nhánh". */
const FILTER_AFTER = 12;

/** A lane's state colour (v2.1 deck classes), base = `--accent`. */
export const laneColor = (r: Pick<LaneRow, 'state'>): string => {
  const c = r.state ? LANE_CLASS[r.state] : '';
  return c === 'ok' ? 'var(--ok)' : c === 'warn' ? 'var(--warn)' : c === 'bad' ? 'var(--bad)' : c === 'acc' ? 'var(--accent)' : 'var(--fg-2)';
};

export function Block(p: { title: ReactNode; right?: ReactNode; folded: boolean; onFold: () => void; cls: string; children: ReactNode }): ReactElement {
  return (
    <section className={`gblk ${p.cls}${p.folded ? ' folded' : ''}`}>
      <div className="gsh">
        <button type="button" className="gfold" aria-expanded={!p.folded} onClick={p.onFold}><Icon n={p.folded ? 'chevR' : 'chev'} s={12} />{p.title}</button>
        {p.right ? <span className="grr">{p.right}</span> : null}
      </div>
      {p.folded ? null : p.children}
    </section>
  );
}

export interface BranchesProps {
  res: GitBranchesResult; rows: { top: LaneRow[]; merged: LaneRow[] }; pick: GitPick; onPick: (p: GitPick) => void;
  /** the base has no commit yet (G14) */
  empty: boolean; offline: boolean; onRetry: () => void; folded: boolean; onFold: () => void;
  /** §4.2 Đang xem is a lane that runs right in the repo: "D7 chạy thẳng trong repo" */
  direct: string | null;
}

function Measured({ r, offline, onRetry }: { r: LaneRow; offline: boolean; onRetry: () => void }): ReactElement {
  const tr = useT();
  const m = measureOf(r.b);
  const b = r.b;
  const ab = b && (b.state === 'unmerged' || (b.state === 'unknown' && b.behind !== undefined)) ? <span className="mono">↑{b.ahead}{b.behind === undefined ? '' : ` ↓${b.behind}`}</span> : null;
  let v: ReactNode;
  if (m.k === 'unknown') {
    return <>{ab}<span className="gm mut" title={reasonText(tr, m.reason)}>{tr('git.unknown')} · <button type="button" className="glink" disabled={offline} onClick={onRetry}>{tr('git.retry')}</button></span></>;
  }
  if (m.k === 'clean') v = <span className="gm ok"><Icon n="circleCheck" s={12} /><span>{tr('git.clean')}</span></span>;
  else if (m.k === 'conflicts') v = <span className="gm bad"><Icon n="alert" s={12} /><span>{tr('git.conflicts', { n: m.n })}</span></span>;
  else if (m.k === 'merged') v = <span className="gm mut"><span>{tr('git.merged')}</span></span>;
  else if (m.k === 'noChange') v = <span className="gm mut"><span>{tr('git.noChange')}</span></span>;
  else if (m.k === 'pending') v = <span className="gm mut"><Icon n="loader" s={12} /><span>{tr('git.measuring')}</span></span>;
  else v = null;
  const measuring = !!b?.measuring && m.k !== 'pending';
  return <>{ab}{measuring ? <><span className="old">{v}</span><span className="gspin" aria-label={tr('git.measuring')}><Icon n="loader" s={12} /></span></> : v}</>;
}

function Row({ r, sel, onPick, offline, onRetry }: { r: LaneRow; sel: boolean; onPick: () => void; offline: boolean; onRetry: () => void }): ReactElement {
  const tr = useT();
  const gone = r.b?.state === 'gone';
  return (
    <div className={`gbrow${sel ? ' sel' : ''}${gone || r.b?.state === 'merged' ? ' dim' : ''}`} role="option" aria-selected={sel} tabIndex={-1}
      onClick={gone ? undefined : onPick} title={r.branch}>
      <Icon n="branch" s={12} />
      <span className="mono gbn" style={{ color: laneColor(r) }}>{r.branch}</span>
      <span className="mut gst">{gone ? tr('git.gone') : r.state ? laneState(tr, r.state) : laneState(tr, 'done')}</span>
      <span className="grr">{gone ? null : <Measured r={r} offline={offline} onRetry={onRetry} />}</span>
    </div>
  );
}

function BaseRow(p: BranchesProps): ReactElement {
  const tr = useT();
  const { res } = p;
  if (!res.base) {
    const e = res.baseError;
    const why = e?.kind === 'unknown' ? reasonText(tr, e.reason, e.program) : tr('git.baseNoneWhy');
    return <div className="gbrow dim" title={why}><Icon n="branch" s={12} /><span className="gbn">{tr('git.baseNone')}</span><span className="grr mut gwhy">{why}</span></div>;
  }
  const b = res.base, sel = p.pick.k === 'base';
  let right: ReactNode;
  if (p.empty) right = <span className="mut">{tr('git.noCommits')}</span>;
  else {
    const parts: ReactNode[] = [];
    if (b.dirty) parts.push(<span key="d" className="warn">{tr('git.baseDirty', { n: b.dirty })}</span>);
    if (b.unpushed) parts.push(<span key="u"><span className="mono">↑{b.unpushed}</span> {tr('git.unpushed')}</span>);
    right = parts.length ? <span className="mut">{parts.flatMap((x, i) => (i ? [' · ', x] : [x]))}</span> : <span className="mut">{tr('git.baseClean')}</span>;
  }
  return (
    <div className={`gbrow${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={-1} onClick={() => p.onPick({ k: 'base' })} title={b.name}>
      <Icon n="branch" s={12} /><span className="mono gbn" style={{ color: 'var(--accent)' }}>{b.name}</span><span className="mut gst">{tr('git.base')}</span>
      <span className="grr">{right}</span>
    </div>
  );
}

export function Branches(p: BranchesProps): ReactElement {
  const tr = useT();
  const [q, setQ] = useState('');
  const [mergedOpen, setMergedOpen] = useState(false);
  const all = p.rows.top.length + p.rows.merged.length + 1;
  const match = (r: LaneRow) => !q || `${r.branch} ${r.lane}`.toLowerCase().includes(q.toLowerCase());
  const measuring = p.rows.top.some(r => r.b?.measuring);
  const fade = useFade<HTMLDivElement>();
  const row = (r: LaneRow) => <Row key={r.lane} r={r} sel={p.pick.k === 'lane' && p.pick.lane === r.lane} onPick={() => p.onPick({ k: 'lane', lane: r.lane })} offline={p.offline} onRetry={p.onRetry} />;
  return (
    <Block cls="b1" folded={p.folded} onFold={p.onFold} title={<>{tr('git.branches')} · {all}</>}
      right={measuring ? <span className="gm mut"><Icon n="loader" s={12} /><span>{tr('git.remeasuring')}</span></span> : null}>
      {all > FILTER_AFTER ? <label className="gfz"><Icon n="search" s={12} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('git.filter')} aria-label={tr('git.filter')} /></label> : null}
      <div className="glst" role="listbox" tabIndex={0} aria-label={tr('git.branches')} onKeyDown={onListKey} ref={fade.ref} onScroll={fade.onScroll}>
        <BaseRow {...p} />
        {p.direct ? <div className="gsubl mut">{tr('git.direct', { lane: p.direct })}</div> : null}
        {p.rows.top.filter(match).map(row)}
        {p.rows.merged.length ? (
          <div className="gbrow fold" onClick={() => setMergedOpen(o => !o)} role="button" aria-expanded={mergedOpen}>
            <Icon n={mergedOpen ? 'chev' : 'chevR'} s={12} />{tr('git.mergedFold', { n: p.rows.merged.length })}
          </div>
        ) : null}
        {mergedOpen ? p.rows.merged.filter(match).map(row) : null}
      </div>
    </Block>
  );
}
