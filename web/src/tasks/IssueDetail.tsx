// v2.7 §4.3 the issue detail (400 wide, IS2 / IS3 / IS5 / IS5b / IS6 / IS9; narrow: a 360 overlay from the right with a close
// button, IS10): head = key · kind · spec + Huỷ (red outline; hidden while a revert runs or its conflict card is open) and Cho
// làm (§5.6), title, §5.7-5 the red conflict strip with the card's two buttons, the table, "Nội dung" (the chat Markdown
// renderer), "Xong là khi", attachments (`IssueDetailFiles`), "Lịch sử". Issue keys in any text open that issue (inside Tasks).
import { Fragment, type ReactElement, type ReactNode } from 'react';
import type { IssueInfo } from '../../../shared/issues.ts';
import { useT } from '../lib/i18n.tsx';
import { Icon } from '../ui/icons.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { askCancel, CancelAction } from './CancelPop.tsx';
import { IssueFiles } from './IssueDetailFiles.tsx';
import { cancelBothKeys, canOk, conflictCard, conflictWith, detailRows, historyLines, type DetailCtx } from './IssueDetail.model.ts';
import { specShort } from '../lib/traces.ts';
import { revertIssueOf, specOfSel } from './IssueList.model.ts';
import type { TasksCtx } from './tasks-ctx.ts';
import './IssueDetail.css';

const KEY_IN_TEXT = /\b[TB]-[1-9]\d*\b/g;

/** Text with every known issue key as a link that opens it. */
function KeyText({ text, has, go }: { text: string; has: (k: string) => boolean; go: (k: string) => void }): ReactElement {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(KEY_IN_TEXT)) {
    if (!has(m[0])) continue;
    out.push(text.slice(last, m.index));
    out.push(<button key={m.index} type="button" className="tkey" onClick={() => go(m[0])}>{m[0]}</button>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

export interface IssueDetailProps {
  c: TasksCtx; issue: IssueInfo;
  onClose: () => void;
}

export function IssueDetail({ c, issue: i, onClose }: IssueDetailProps): ReactElement {
  const tr = useT();
  const spec = i.specId === null ? null : specOfSel(c.pi, { spec: i.specId });
  const x: DetailCtx = { tr, now: c.now, spec, all: c.pi.issues, quotaAt: c.live.quotaAt, lanes: c.live.lanes };
  const has = (k: string) => c.pi.issues.some(y => y.key === k);
  const go = (k: string) => c.setUi({ issue: k });
  const kt = (text: string) => <KeyText text={text} has={has} go={go} />;
  const card = conflictCard(i, c.live.cards);
  const rev = i.revert === 'pending' || i.revert === 'running' ? revertIssueOf(i, c.pi.issues) : null;
  const blocker = i.revert === 'conflict' ? conflictWith(i, card, c.pi.issues) : null;
  const lockTip = c.locked ? tr('tasks.locked') : undefined;
  const keep = card?.actions?.find(a => a.id === 'revert_keep');

  return (
    <aside className={`tdet idet${c.narrow ? ' ov' : ''}`} aria-label={tr('tasks.region.detail')}>
      <div className="dtop">
        <div className="dmeta">
          <b className="k">{i.key}</b>
          <span>· {tr(i.kind === 'bug' ? 'tasks.detail.kind.bug' : 'tasks.detail.kind.task')} · {spec ? specShort(spec.title) : tr('tasks.detail.outside')}</span>
          <span className="lgap" />
          {canOk(i, spec) ? <button type="button" className="dok" disabled={c.locked} title={lockTip ?? tr('tasks.detail.okWhy')}
            onClick={() => { c.cmds.ok(i.key).catch(() => {}); }}>{tr('tasks.detail.ok')}</button> : null}
          <CancelAction c={c} issue={i} />
          {c.narrow ? <button type="button" className="dclose" aria-label={tr('tasks.detail.close')} onClick={onClose}><Icon n="x" s={14} /></button> : null}
        </div>
        <h3>{kt(i.title)}</h3>
        {rev ? <p className="dsub">{rev.lane ? tr('tasks.detail.revertingLane', { key: rev.key, lane: rev.lane.name }) : tr('tasks.detail.reverting', { key: rev.key })}</p> : null}
      </div>
      <div className="dbody">
        {i.revert === 'conflict' ? (
          <div className="dstrip" role="alert">
            <p>{kt(blocker ? tr('tasks.detail.conflict', { key: i.key, blocker }) : tr('tasks.detail.conflictBare', { key: i.key }))}</p>
            {card ? <div className="dsb">
              <button type="button" className="dkeep" disabled={c.locked || !keep} onClick={() => { void c.send({ cmd: 'card_action', id: card.id, action: 'revert_keep' }).catch(() => {}); }}>
                {tr('tasks.detail.keep', { key: i.key })}</button>
              <button type="button" className="dcx" disabled={c.locked} onClick={() => askCancel(c.project.id, cancelBothKeys(i, blocker))}>{tr('tasks.detail.cancelBoth')}</button>
            </div> : null}
          </div>
        ) : null}
        <dl className="dtab">
          {detailRows(i, x).map(r => (
            <Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd className={r.mono ? 'mono' : undefined}>{r.keys ? r.keys.map((k, n) => <Fragment key={k}>{n ? ', ' : ''}{kt(k)}</Fragment>) : kt(r.value)}</dd>
            </Fragment>
          ))}
          {i.state === 'cancelled' && i.cancelReason ? <><dt>{tr('tasks.detail.row.reason')}</dt><dd>{kt(i.cancelReason)}</dd></> : null}
        </dl>
        {i.body ? <section className="dsec"><h4>{tr('tasks.detail.body')}</h4><div className="dmd"><Markdown text={i.body} /></div></section> : null}
        {i.doneWhen.length ? (
          <section className="dsec"><h4>{tr('tasks.detail.doneWhen')}</h4>
            <ul className="dchk">{i.doneWhen.map((w, n) => (
              <li key={n}><input type="checkbox" readOnly checked={i.state === 'done'} tabIndex={-1} aria-hidden="true" />{kt(w)}</li>
            ))}</ul>
          </section>
        ) : null}
        {i.files.length ? (
          <section className="dsec"><h4>{tr('tasks.detail.files')}</h4>
            <IssueFiles cmds={c.cmds} issue={i} />
          </section>
        ) : null}
        <section className="dsec"><h4>{tr('tasks.detail.history')}</h4>
          <ol className="dhist">{historyLines(i, x).map((h, n) => <li key={n}><time>{h.at}</time><span>{kt(h.text)}</span></li>)}</ol>
        </section>
      </div>
    </aside>
  );
}
