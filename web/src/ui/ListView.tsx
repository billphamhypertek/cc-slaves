// F9 list mode (spec §4.8, N4-k): the canvas becomes one lane table of the current project — LANE · VIỆC · TRẠNG THÁI · ACCOUNT ·
// CHI PHÍ — under the shell's deck header bar (v2.3 §4.1), on an opaque layer (the left column keeps Chờ PO). Row click = select the
// lane like a node click; row "⋯" = the lane's §4.12 menu. Rows in R1 order (Chờ PO / Hỏng first); done lanes stay in the deck's Xong.
import type { ReactElement } from 'react';
import { displayTokens, type LaneView, type Snapshot } from '../../../shared/protocol.ts';
import { fmtCost, fmtTok, shortEmail } from '../lib/format.ts';
import { reasonText, useT } from '../lib/i18n.tsx';
import { laneState, phaseName } from '../lib/labels.ts';
import { blockingCard, groupLanes } from '../lib/list.ts';
import './list.css';

export interface ListViewProps {
  snap: Snapshot;
  projectId: string | null;
  /** the lane shown in Đang xem (row marked). */
  selected: string | null;
  onLane(projectId: string, name: string): void;
  /** v2.1 §4.11 F9 row "⋯" = the lane's §4.12 menu, opened at that button. */
  onMenu(projectId: string, name: string, anchor: Element): void;
}

export function ListView(p: ListViewProps): ReactElement {
  const { snap } = p;
  const tr = useT();
  const rows = groupLanes(tr, snap.lanes.filter(l => l.projectId === p.projectId && l.state !== 'done')).flatMap(g => g.lanes);
  const what = (l: LaneView) => {
    const c = blockingCard(l, snap.cards);
    const why = c ? c.question ?? c.title : l.state === 'broken' && l.lastError ? reasonText(tr, l.lastError, l.lastErrorKeyed) : l.task;
    return [l.phase ? phaseName(tr, l.phase) : null, why, l.note].filter(Boolean).join(' · ');
  };
  return (
    <div id="listview">
      {rows.length ? <table className="lt"><thead><tr><th aria-hidden="true" /><th>{tr('list.th.lane')}</th><th>{tr('list.th.work')}</th><th>{tr('list.th.state')}</th>
        <th>{tr('list.th.account')}</th><th>{tr('list.th.cost')}</th><th aria-hidden="true" /></tr></thead>
        <tbody>{rows.map(l => <tr key={l.name} className={`lt-row${l.name === p.selected ? ' on' : ''}`} data-st={l.state} onClick={() => p.onLane(l.projectId, l.name)}>
          <td><i className="disc" /></td><td className="nm">{l.name}</td><td className="wk">{what(l)}</td><td className="st">{laneState(tr, l.state)}</td>
          <td className="ac">{l.account ? shortEmail(l.account) : '—'}</td><td className="co">{`${fmtTok(l.tokens ? displayTokens(l.tokens) : 0, tr)} · ${fmtCost(l.costUsd, tr)}`}</td>
          <td><button type="button" className="ib" aria-label={tr('list.actAria', { name: l.name })} aria-haspopup="menu"
            onClick={e => { e.stopPropagation(); p.onMenu(l.projectId, l.name, e.currentTarget); }}>⋯</button></td>
        </tr>)}</tbody></table>
        : <div className="lt-none">{tr('list.noLanes')}</div>}
    </div>
  );
}
