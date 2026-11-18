// v2.1 §4.15 §3 Đang xem bodies of done lanes (own lazy chunk): the done list "Điều phối #n › Xong · 41" (N6-e, N6-k) and
// the read-only done-lane block (N6-f): branch, merge state as measured, worktree, session, transcript, subagents,
// "Nhờ Điều phối #n merge…" / "Mở VS Code" / "Chạy tiếp lane…". Remote: VS Code and continue hidden (canRun). Offline:
// the loaded rows, filtered on the spot, "lúc hh:mm"; "Nhờ … merge" locked.
import { useEffect, useState, type ReactElement } from 'react';
import { displayTokens, ZERO_TOKENS, type DoneLanesPage, type LaneView, type OrchestratorView, type ProjectView, type SessionsList, type Snapshot, type SubagentView } from '../../../shared/protocol.ts';
import { branchText, doneWhen, filterDone, groupDone, mergeSession, transcriptLeft } from '../lib/done.ts';
import { fmtCost, fmtHm, fmtTok, shortEmail } from '../lib/format.ts';
import type { Selection } from '../lib/inspector.ts';
import { laneState, phaseName } from '../lib/labels.ts';
import { lastRunText } from '../lib/model.ts';
import { useT, type Tr } from '../lib/i18n.tsx';
import { canRun } from '../lib/remote.ts';
import type { DoneQuery } from './useDone.ts';
import { Icon } from './icons.tsx';
import './done.css';

/** What the App hands the done views (Inspector `done` prop). */
export interface DoneProps {
  /** every done lane of the project (engine total), null before the first answer. */
  total: number | null; cleanupDays: number;
  load: (q: DoneQuery) => Promise<DoneLanesPage | null>;
  onMerge: (l: LaneView) => void; onContinue: (name: string) => void; onVscode: (path: string) => void;
  /** re-send the lane watch: the engine measures again when the last measurement is > 60 s old ("Thử lại"). */
  onRetry: (name: string) => void;
}
interface BodyProps {
  sel: Extract<Selection, { k: 'doneList' } | { k: 'doneLane' }>; snap: Snapshot; project: ProjectView; now: number; offline: boolean; dataAt: number | null;
  sessions: OrchestratorView[]; viewedSid: string | null; sessionsList: SessionsList | null; subs: SubagentView[];
  done: DoneProps; onSel: (s: Selection) => void; onMenu: (name: string, anchor: Element) => void;
}

/** rows the list loaded (lanes older than the snapshot's 7 days are only known from here). */
const seen = new Map<string, LaneView>();
let lastQuery: { q: string; unmerged: boolean; session: string | null } = { q: '', unmerged: false, session: null };

export function DoneBody(p: BodyProps): ReactElement {
  const tr = useT();
  if (p.sel.k === 'doneList') return <DoneList {...p} />;
  const name = p.sel.name, l = p.snap.lanes.find(x => x.projectId === p.project.id && x.name === name) ?? seen.get(`${p.project.id}:${name}`);
  return l ? <DoneLane {...p} lane={l} /> : <div className="dnone">{tr('done.loading')}</div>;
}

const seqName = (tr: Tr, seq: number | null | undefined, running: boolean) => (seq ? (running ? `#${seq}` : tr('done.sessEnded', { n: seq })) : '—');

function DoneList(p: BodyProps): ReactElement {
  const tr = useT();
  const [q, setQ] = useState(lastQuery.q), [unmerged, setUnmerged] = useState(lastQuery.unmerged), [session, setSession] = useState(lastQuery.session);
  const [page, setPage] = useState<DoneLanesPage | null>(null), [rows, setRows] = useState<LaneView[]>([]), [closed, setClosed] = useState<Record<string, boolean>>({});
  lastQuery = { q, unmerged, session };
  const query: DoneQuery = { ...(q.trim() ? { query: q.trim() } : {}), ...(unmerged ? { unmerged: true } : {}), ...(session ? { session } : {}), limit: 50 };
  const key = JSON.stringify(query);
  useEffect(() => {
    if (p.offline) return; // §4.15 offline: keep what is loaded, filter on the spot
    let live = true;
    const t = setTimeout(() => void p.done.load(query).then(r => {
      if (!live || !r) return;
      for (const l of r.lanes) seen.set(`${l.projectId}:${l.name}`, l);
      setPage(r); setRows(r.lanes);
    }), q ? 200 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [key, p.offline]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = () => { if (page?.next) void p.done.load({ ...query, before: page.next }).then(r => { if (r) { setPage({ ...r, total: page.total }); setRows(x => [...x, ...r.lanes]); } }); };
  // live rows: the snapshot's newer view of a lane wins (measuring → measured)
  // before the first page (or offline) the snapshot's done lanes (last 7 days), filtered on the spot
  const local = !page || p.offline;
  const base = page ? rows : p.snap.lanes.filter(l => l.projectId === p.project.id && l.state === 'done');
  const fresh = base.map(l => p.snap.lanes.find(x => x.projectId === l.projectId && x.name === l.name) ?? l);
  const shown = local ? filterDone(fresh, q).filter(l => (!unmerged || l.branch?.state === 'unmerged' || l.branch?.state === 'unknown') && (!session || l.ownerSession === session)) : fresh;
  const groups = groupDone(tr, shown, p.now, unmerged);
  const total = page?.total ?? p.done.total ?? 0, ses = p.sessionsList ? [...p.sessionsList.running, ...p.sessionsList.ended] : [];
  const clear = () => { setQ(''); setSession(null); setUnmerged(false); };
  return (
    <div className="dlist">
      <div className="dfil">
        <label className="dq"><input className="field" value={q} placeholder={tr('done.filterPh')} aria-label={tr('done.filterAria')} onChange={e => setQ(e.target.value)} /></label>
        <button type="button" className={`dchip${unmerged ? '' : ' on'}`} aria-pressed={!unmerged} onClick={() => setUnmerged(false)}>{tr('done.chipAll', { n: total })}</button>
        <button type="button" className={`dchip${unmerged ? ' on' : ''}`} aria-pressed={unmerged} onClick={() => setUnmerged(true)}>{tr('done.chipUnmerged', { n: page?.unmerged ?? p.project.unmerged ?? 0 })}</button>
        <label className="dchip sel">{tr('done.chipSession', { s: '' })}<select value={session ?? ''} onChange={e => setSession(e.target.value || null)}>
          <option value="">{tr('done.sessAll')}</option>
          {ses.map(r => <option key={r.sessionId} value={r.sessionId}>{`#${r.seq ?? '?'}${r.title ? ` · ${r.title}` : ''}`}</option>)}</select></label>
        {p.offline && p.dataAt ? <span className="dat">{tr('done.offlineAt', { hm: fmtHm(p.dataAt) })}</span> : null}
      </div>
      {!groups.length ? (q.trim() || session || unmerged
        ? <div className="dnone">{tr('done.noMatch', { q: q.trim() })} <button type="button" className="lnk" onClick={clear}>{tr('done.clear')}</button></div>
        : <div className="dnone">{page || p.offline ? tr('done.empty') : tr('done.loading')}</div>) : null}
      {groups.map(g => {
        const shut = closed[g.id] ?? g.closed;
        return <section key={g.id} className="dgrp">
          <button type="button" className="dgh" aria-expanded={!shut} onClick={() => setClosed(c => ({ ...c, [g.id]: !shut }))}>{g.label} · {g.n}<i>{shut ? '▸' : '▾'}</i></button>
          {shut ? null : g.lanes.map(l => <DoneRow key={l.name} l={l} {...p} />)}
        </section>;
      })}
      {page?.next && !p.offline ? <button type="button" className="lnk dmore" onClick={more}>{tr('done.more')}</button> : null}
      <div className="note"><Icon n="info" s={14} /><span>{tr('done.listNote')}</span></div>
    </div>
  );
}

function DoneRow({ l, ...p }: BodyProps & { l: LaneView }): ReactElement {
  const tr = useT(), b = l.branch, bt = branchText(tr, b), running = p.sessions.some(o => o.sessionId === l.ownerSession);
  const head = b?.state === 'unknown'
    ? <span className="d2"><span className="bad">{b.reason ?? tr('done.b.unknown')}</span> · {tr('done.notCounted')} · <span className="lnk">{tr('done.retry')}</span></span>
    : <span className="d2">{[seqName(tr, l.ownerSeq, running), tr('done.doneAt', { t: doneWhen(tr, l.updatedAt, p.now) }), b?.name, b?.state === 'unmerged' ? tr('done.b.ahead', { n: b.ahead }) : null,
      b?.pr && b.state === 'merged' ? `#${b.pr.number}` : null, `${fmtTok(displayTokens(l.tokens ?? ZERO_TOKENS), tr)} tok`, fmtCost(l.costUsd, tr)].filter(Boolean).join(' · ')}
      {bt.measuring ? <span className="acc"> · {tr('done.b.measuring')}</span> : null}</span>;
  return (
    <button type="button" className="drow" onClick={() => p.onSel({ k: 'doneLane', name: l.name })}>
      <b className="mono">{l.name}</b><span className="d1">{l.task ?? l.note ?? ''}</span>
      <span className={`dst ${bt.tone}`}>{b?.state === 'unmerged' ? tr('done.b.unmerged') : b?.state === 'unknown' ? '?' : bt.text}</span>{head}
    </button>
  );
}

function DoneLane(p: BodyProps & { lane: LaneView }): ReactElement {
  const tr = useT(), l = p.lane, b = l.branch, bt = branchText(tr, b), ch = p.snap.channel;
  const holder = mergeSession(l, p.sessions, p.viewedSid), hs = p.sessions.find(o => o.sessionId === holder);
  const running = p.sessions.some(o => o.sessionId === l.ownerSession), multi = p.sessions.length > 1;
  const canMerge = !b || b.state === 'unmerged' || b.state === 'unknown';
  const left = transcriptLeft(l.updatedAt, p.now, p.done.cleanupDays);
  // §4.14 N5-m dimmed button + reason band + "nhắn Điều phối mở lane mới": branch merged / gone, transcript expired
  const cantContinue = b?.state === 'merged' ? tr('menu.merged') : b?.state === 'gone' ? tr('menu.gone')
    : left <= 0 ? tr('done.whyTranscript', { days: p.done.cleanupDays }) : null;
  const merge = !b ? bt.text : b.state === 'unmerged'
    ? <><span className="warn">{tr('done.b.unmerged')}</span> · {tr('done.b.mergeLine', { ahead: b.ahead, base: b.base ?? 'main', files: b.files })}
      <small><span className="ok">+{b.add}</span> <span className="bad">−{b.del}</span> ({tr('done.b.measuredAt', { hm: fmtHm(b.measuredAt) })}){bt.measuring ? ` · ${tr('done.b.measuring')}` : ''}</small></>
    : b.state === 'unknown' ? <><span className="bad">{bt.text}</span> · {b.reason ?? '—'} · <button type="button" className="lnk" disabled={p.offline} onClick={() => p.done.onRetry(l.name)}>{tr('done.retry')}</button></>
    : <>{bt.text}{bt.measuring ? <small>{tr('done.b.measuring')}</small> : null}</>;
  return (
    <div className="lhead dlane">
      <div className="row"><h2>{l.name}</h2><span className="pill">{laneState(tr, 'done')}</span><span className="sp" />
        <button type="button" className="more" aria-haspopup="menu" onClick={e => p.onMenu(l.name, e.currentTarget)} aria-label={tr('inspector.menu', { name: l.name })}>⋯</button></div>
      {/* §4.5 no chip: the last model · effort leads the facts line (MD12, Y33) */}
      <div className="meta mono">{[lastRunText(l), l.phase ? phaseName(tr, l.phase) : null, l.task, tr('done.doneAt', { t: doneWhen(tr, l.updatedAt, p.now) }), l.account ? shortEmail(l.account) : null,
        l.tokens ? `${fmtTok(displayTokens(l.tokens), tr)} tok` : null, fmtCost(l.costUsd, tr)].filter(Boolean).join(' · ')}</div>
      <div className="acts">
        {canMerge ? <button type="button" className="btn sm pri" disabled={p.offline} onClick={() => p.done.onMerge(l)}><Icon n="send" s={14} /> {multi && hs?.seq ? tr('menu.mergeN', { n: hs.seq }) : tr('menu.merge')}</button> : null}
        {canRun(ch, 'open_in_vscode') ? <button type="button" className="btn sm" onClick={() => p.done.onVscode(l.worktreeExists ? l.cwd : p.project.path)}><Icon n="code" s={14} /> {tr('menu.vscode')}</button> : null}
        {canRun(ch, 'lane_continue') ? <button type="button" className="btn sm" disabled={p.offline || !!cantContinue} title={cantContinue ?? undefined} onClick={() => p.done.onContinue(l.name)}><Icon n="refresh" s={14} /> {tr('menu.continue')}</button> : null}
      </div>
      {/* UX-I8 N5-m the reason box right under the dimmed button: the info block scrolls, so below the facts it can sit off screen */}
      {cantContinue && canRun(ch, 'lane_continue') ? <div className="preview bad" role="note"><Icon n="alert" s={14} /><span>{tr('done.cantContinue', { reason: cantContinue })} {tr('done.contAlt')}</span></div> : null}
      <dl className="kv">
        <dt>{tr('done.dt.branch')}</dt><dd className="mono">{b?.name ? `${b.name} → ${b.base ?? 'main'}` : tr('done.b.none')}</dd>
        <dt>{tr('done.dt.merge')}</dt><dd>{merge}</dd>
        <dt>{tr('done.dt.worktree')}</dt><dd className="mono">{l.cwd.replace(/^\/Users\/[^/]+/, '~')} ({tr(l.worktreeExists ? 'done.wtYes' : 'done.wtNo')})</dd>
        <dt>{tr('done.dt.session')}</dt><dd className="mono">{seqName(tr, l.ownerSeq, running)}</dd>
        <dt>{tr('done.dt.transcript')}</dt><dd className="mono">{left > 0 ? tr('done.trLeft', { n: left }) : tr('done.trGone')}</dd>
      </dl>
      {p.subs.length ? <div className="subsec"><div className="log-h"><span>{tr('unit.subHead', { n: p.subs.filter(s => s.status === 'running').length })}</span></div>
        <div className="subs">{p.subs.map(s => <button type="button" key={s.taskId} className={`sub ${s.status}`} onClick={() => p.onSel({ k: 'sub', lane: l.name, taskId: s.taskId })}>
          <span className="sl"><b>{s.subagentType}</b> {s.description}</span><span className="m">{s.totalTokens !== null ? tr('inspector.tok', { n: fmtTok(s.totalTokens, tr) }) : ''}</span></button>)}</div></div> : null}
    </div>
  );
}
