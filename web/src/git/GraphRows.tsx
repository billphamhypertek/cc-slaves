// spec v2.3 §6.1 "Đồ thị" + §10.1: the commit rows of the Git view — props only (GitView feeds `git_log`), one 26 px row per
// commit, newest on top, the rail drawn from `layoutGraph`, virtualised past 200 rows with the `VirtualHist` window rule.
import { useMemo, useState, type ReactElement } from 'react';
import { fmtAgo, fmtStamp } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { graphWindow, layoutGraph, railPaths, railWidth, ROW_PX, trackColor, type GraphCommit, type GraphRow } from './graph.ts';
import { useFade } from '../lib/fade.ts';
import './graph.css';

export interface GraphEntry extends GraphCommit { subject: string; author: string; time: number }
export interface GraphRowsProps {
  commits: readonly GraphEntry[];
  /** the base branch name: column 0, `--accent` */
  base: string | null;
  /** a branch's line / label colour (base → `var(--accent)`, lane → its state colour); `null` = a line no label started */
  color: (ref: string | null) => string;
  now: number;
  selected?: string | null;
  onPick?: (hash: string) => void;
  /** §6.1 < 1280 px: long branch labels hidden, rail + subject kept */
  narrow?: boolean;
}

/** §6.1 a label this long is "long" in the narrow column */
const LONG_LABEL = 10;

function Rail(p: { row: GraphRow; width: number; colorOf(track: number): string }): ReactElement {
  const g = railPaths(p.row);
  return (
    <svg className="grail" width={p.width} viewBox={`0 0 ${p.width} ${ROW_PX}`} aria-hidden>
      {g.lines.map(l => <line key={`l${l.x}`} x1={l.x} y1={l.y1} x2={l.x} y2={l.y2} strokeWidth={2} style={{ stroke: p.colorOf(l.track) }} />)}
      {g.curves.map(v => <path key={v.d} d={v.d} fill="none" strokeWidth={2} style={{ stroke: p.colorOf(v.track) }} />)}
      <circle cx={g.dot.x} cy={g.dot.y} r={4.5} strokeWidth={2} style={{ fill: 'var(--cd-dot)', stroke: p.colorOf(p.row.track) }} />
    </svg>
  );
}

export function GraphRows(p: GraphRowsProps): ReactElement {
  const tr = useT();
  const [view, setView] = useState({ top: 0, h: 20 * ROW_PX });
  const g = useMemo(() => layoutGraph(p.commits, p.base), [p.commits, p.base]);
  const colours = useMemo(() => g.tracks.map(t => trackColor(t, p.color)), [g, p.color]);
  const colorOf = (track: number) => colours[track] ?? 'var(--fg-3)';
  const width = railWidth(g.cols);
  const w = graphWindow(p.commits.length, view.top, view.h);
  const fade = useFade<HTMLDivElement>();
  return (
    <div className="grph" ref={fade.ref} onScroll={e => { setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight }); fade.onScroll(e); }}>
      {w.padTop ? <div style={{ height: w.padTop }} aria-hidden /> : null}
      {p.commits.slice(w.start, w.end).map((c, i) => {
        const labels = (c.branches ?? []).filter(b => !p.narrow || b.length <= LONG_LABEL);
        const sel = p.selected === c.hash;
        return (
          <button type="button" key={c.hash} className={sel ? 'grow sel' : 'grow'} aria-pressed={sel} onClick={() => p.onPick?.(c.hash)}
            title={`${fmtStamp(c.time, tr)} · ${c.hash.slice(0, 7)} · ${c.author}`}>
            <Rail row={g.rows[w.start + i]!} width={width} colorOf={colorOf} />
            <span className="gsub">{c.subject}</span>
            {labels.map(b => <span key={b} className="gref" style={{ color: p.color(b), borderColor: p.color(b) }}>{b}</span>)}
            <span className="gago">{fmtAgo(c.time, p.now, tr)}</span>
          </button>
        );
      })}
      {w.padBottom ? <div style={{ height: w.padBottom }} aria-hidden /> : null}
    </div>
  );
}
