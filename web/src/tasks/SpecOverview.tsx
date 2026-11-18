// v2.7 §4.3 D99 (IS22 / IS22b, R-B14) the spec overview: the right pane of a spec Đang build / Xong while no issue is open.
// Head: name · state · file path; progress (bar + `8/13` + the block counts > 0); a table — Đang build: Phiên Build (+ Tới
// phiên), Bắt đầu build, Duyệt, Nhánh, Lane đang làm, Bổ sung (only after a round), Làm sau (only with `after`); Xong: Phiên
// Build, Build from → to, Duyệt, Commit, Nhánh (merged into …); then Tài liệu. No action buttons (they stay in the list head).
import type { ReactElement, ReactNode } from 'react';
import type { IssueInfo, SpecInfo } from '../../../shared/issues.ts';
import type { Tr } from '../../../shared/i18n/core.ts';
import { fmtHm, fmtHmDay } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { issueBlocks } from '../lib/issues.ts';
import { DocsBlock } from './DocsList.tsx';
import { laneCluster } from './IssueList.model.ts';
import { ProgressBar } from './ProgressBar.tsx';
import type { TasksCtx } from './tasks-ctx.ts';

const ARISEN = new Set<IssueInfo['source']>(['lane', 'orchestrator', 'po']);

/** D99 "3 đang làm · 1 sẵn sàng · 1 bị chặn · 8 xong · 1 huỷ · 2 phát sinh thêm": the list blocks, then the issues that
 *  arose while building (`lane` / `orchestrator` / `po`) and the "Bổ sung" round ones; a zero count is not written. */
export function overviewCounts(issues: readonly IssueInfo[], tr: Tr): string {
  const n = new Map(issueBlocks(issues, { doneOpen: true }).map(b => [b.block, b.issues.length]));
  const live = issues.filter(i => i.state !== 'cancelled');
  const parts: [string, number][] = [
    ['doing', n.get('doing') ?? 0], ['ready', n.get('ready') ?? 0], ['blocked', n.get('blocked') ?? 0], ['done', n.get('done') ?? 0],
    ['cancelled', n.get('cancelled') ?? 0], ['extra', live.filter(i => ARISEN.has(i.source)).length], ['amend', live.filter(i => i.source === 'amend').length],
  ];
  return parts.filter(([, v]) => v > 0).map(([k, v]) => tr(`tasks.card.ov.counts.${k}` as Parameters<Tr>[0], { n: v })).join(' · ');
}

export interface OvRow { k: string; label: string; value: ReactNode }
const when = (t: number | null, tr: Tr) => (t === null ? tr('tasks.card.ov.none') : fmtHmDay(t));

/** D99 the table rows by state (R-B14 fields). */
export function overviewRows(spec: SpecInfo, c: Pick<TasksCtx, 'toDeck' | 'live'>, tr: Tr): OvRow[] {
  const ov = spec.overview;
  const L = (k: string) => tr(`tasks.card.${k}` as Parameters<Tr>[0]);
  const bs = ov?.buildSession ?? null;
  const build: OvRow = {
    k: 'build', label: L('ov.row.build'),
    value: bs ? (<span className="sval">
      <span>{[bs.title, tr(`tasks.card.ov.build.${bs.state}`)].filter(Boolean).join(' · ')}</span>
      {bs.state === 'closed' ? null : <button type="button" className="tbtn2 sm" onClick={() => c.toDeck(bs.id)}>{L('act.goto')}</button>}
    </span>) : L('ov.none'),
  };
  const approved: OvRow = { k: 'approved', label: L('row.approved'), value: when(spec.approvedAt, tr) };
  if (spec.state === 'done') {
    return [
      build,
      { k: 'span', label: L('ov.row.span'), value: tr('tasks.card.ov.span', { from: when(spec.openedAt, tr), to: when(spec.doneAt, tr) }) },
      approved,
      { k: 'commits', label: L('ov.row.commits'), value: tr('tasks.card.ov.commits', { n: ov?.commits ?? 0 }) },
      { k: 'branch', label: L('row.branch'), value: ov?.mergedInto ? <>{L('ov.merged')} <code>{ov.mergedInto}</code></> : <code>{spec.branch ?? 'main'}</code> },
    ];
  }
  const rows: OvRow[] = [build, { k: 'opened', label: L('ov.row.opened'), value: when(spec.openedAt, tr) }, approved,
    { k: 'branch', label: L('row.branch'), value: <code>{spec.branch ?? 'main'}</code> }];
  const lanes = ov?.lanes ?? [];
  rows.push({
    k: 'lanes', label: L('ov.row.lanes'),
    value: lanes.length ? <span>{lanes.map((l, i) => { const x = laneCluster(l, { tr, quotaAt: c.live.quotaAt }); return <span key={l.name + l.key}>{i ? ', ' : ''}<span className={x.tone ?? undefined}>{x.text}</span></span>; })}</span> : L('ov.none'),
  });
  const am = ov?.lastAmend;
  if (am) rows.push({ k: 'amend', label: L('ov.row.amend'), value: am.at === null ? tr('tasks.card.ov.amendNoTime', { rev: am.rev, n: am.issueCount }) : tr('tasks.card.ov.amend', { rev: am.rev, n: am.issueCount, hm: fmtHm(am.at) }) });
  if (spec.after) rows.push({ k: 'after', label: L('row.after'), value: spec.after.title });
  return rows;
}

/** D99 the overview card (the right pane; narrow: the 360 overlay). */
export function SpecOverview({ c, spec }: { c: TasksCtx; spec: SpecInfo }): ReactElement {
  const tr = useT();
  const issues = c.pi.issues.filter(i => i.specId === spec.id);
  const p = spec.progress;
  const counts = overviewCounts(issues, tr);
  return (
    <article className="scard sov" aria-label={tr('tasks.card.ov.aria')}>
      <header>
        <h3>{spec.title}<small> · {spec.state === 'done' ? tr('tasks.card.state.done') : c.wf.slots.slot(spec).label}</small></h3>
        <p className="spath" title={spec.path}>{spec.path}</p>
      </header>
      <div className="sprog">
        <div className="sbar"><ProgressBar p={p} finished={spec.state === 'done'} /><b>{p.done}/{p.total}</b></div>
        {counts ? <p>{counts}</p> : null}
      </div>
      <dl className="stab">
        {overviewRows(spec, c, tr).map(r => <div key={r.k}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
      </dl>
      <DocsBlock c={c} spec={spec} />
    </article>
  );
}
