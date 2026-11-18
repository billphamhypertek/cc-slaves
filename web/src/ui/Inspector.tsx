// v2.1 §4.11b "Đang xem": one block replacing the v1 bàn lệnh (Console), F8 (UnitPanel), F25 (SubView) and F24. Header =
// breadcrumb + "×"; body by selection kind; the composer of the old Console at the bottom, its target following the
// selection (lib/inspector.ts). Send / interrupt / history flows are unchanged (VirtualHist, `history`, `subagent_history`).
import { createPortal } from 'react-dom';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from 'react';
import { displayTokens, type AccountView, type Command, type LaneView, type OrchestratorView, type ProjectView, type ResumePreview, type SessionsList, type Snapshot, type StreamLine, type SubagentView, type Target } from '../../../shared/protocol.ts';
import { accountState, isActiveLane, lanesOn, ranToday, todayLine, visibleSubs } from '../lib/accounts.ts';
import { cfgIssues, loginChip } from '../lib/account-ui.ts';
import { macOnlyLocal, parseInput, resumedTail, type StreamBuffer } from '../lib/console.ts';
import { fmtCost, fmtHm, fmtLeft, fmtResetTime, fmtTok, leftPct, resetAt, shortEmail, statLine } from '../lib/format.ts';
import { appendDraft } from '../lib/done.ts';
import { chipText, composerFrame, laneSubject, lastRunText, menuPlace, type MenuPlace, type ModelSubject } from '../lib/model.ts';
import { crumbs, factsFolded, heldBand, heldPlaceholder, ORCH, selUp, SHORT_Q, shortSubs, subRank, type Selection } from '../lib/inspector.ts';
import { useMedia } from '../lib/reduced-motion.ts';
import { projectIssues } from '../lib/issues.ts';
import { orchKindLabel } from '../lib/traces.ts';
import { accountColor, LANE_CLASS, laneRunning, laneState, orchRunning, orchState as orchStateText, phaseName, ROLE_KEY } from '../lib/labels.ts';
import { reasonText, useT, type Key, type Tr } from '../lib/i18n.tsx';
import { canRun } from '../lib/remote.ts';
import { designFresh, everMulti, laneSessionLine, orchName, rootName, sessionLabel } from '../lib/sessions.ts';
import { ConvList, Conversation, HideTools, type Live } from './Conversation.tsx';
import type { DoneProps } from './DoneViews.tsx';
import { Icon } from './icons.tsx';
import { SessionView } from './SessionView.tsx';
import { attachBadIndex, sendGate, useAttachments } from './useAttachments.ts';
import type { SendItem } from '../lib/attach-store.ts';
import type { ToastIcon } from '../lib/store.ts';
import { useAttachInput } from './useWindowHooks.ts';
import { useColumnFit } from './useColumnFit.ts';
import { tauriDrop } from '../lib/native.ts';
import { tauriGlobal } from '../lib/tauri.ts';
import { WfLine } from './WfLine.tsx';

/** §4.15 §3 the done list / done-lane view are their own chunk (bundle cap). */
const DoneBody = lazy(() => import('./DoneViews.tsx').then(m => ({ default: m.DoneBody })));
/** v2.4 §4.2 the picker is its own chunk (§10.3: nothing new in the first paint beyond the chip). */
const ModelMenu = lazy(() => import('./ModelMenu.tsx'));
/** v2.4 §6.2 the chip strip is its own chunk: it loads with the first chip (a local fetch, well inside §10.3's 100 ms). */
const AttachChips = lazy(() => import('./AttachChips.tsx'));

/** F25 subagent state words (§6A `unit.sub.*`): lower case inside a line, sentence case on a badge (F-M10). */
const subState = (tr: Tr, s: SubagentView['status']) => tr(s === 'running' ? 'unit.sub.running' : s === 'failed' ? 'unit.sub.failed' : 'unit.sub.completed');
const subBadge = (tr: Tr, s: SubagentView['status']) => tr(s === 'running' ? 'unit.subBadge.running' : s === 'failed' ? 'unit.subBadge.failed' : 'unit.subBadge.completed');
/** F8 headroom word: ĐẦY / chưa rõ / còn N % (D21). */
const headroom = (tr: Tr, a: AccountView) => (a.full ? tr('format.chip.full') : a.headroomPct === null ? tr('format.chip.unknown') : leftPct(tr, a.headroomPct));

export interface InspectorProps {
  sel: Selection;
  /** v2.3 §4.3 the composer target: the shell computes it once (`composerFor`: a "Nhờ …" override, else Đang xem). */
  target: Target;
  snap: Snapshot; project: ProjectView; now: number; offline: boolean; dataAt: number | null;
  /** §4.10 window < 1280 px (the 424 px drawer): the lane facts fold to one line (F-I8) */
  narrow?: boolean;
  /** subagents of this project's lanes, by lane name */
  subs: Record<string, SubagentView[] | undefined>;
  /** stream + v2.2 §14.5 streaming blocks of the composer target (orchestrator or lane) */
  stream: StreamBuffer | undefined; live: Live | undefined;
  /** F25 lines of the selected subagent (history + live) + v2.2 §14.5 S8 its own streaming blocks */
  subLines: StreamLine[]; subLoading: boolean; subLive: Live | undefined;
  /** v2.2 §14.5 S11 "Ẩn công cụ" */
  hideTools: boolean; onHideTools: (on: boolean) => void;
  /** account under view: `config.noNewLanes` */
  paused: boolean;
  /** composer prefill; `append` (§4.15 §3 "Nhờ … merge") goes on a new line under the draft. */
  draft: { text: string; n: number; append?: boolean } | null; inputRef: RefObject<HTMLTextAreaElement>;
  /** §4.12 the "⋯" of the lane / account head (same menu as the node / panel row), opened at that button. */
  onSel: (s: Selection) => void; onClose: () => void; onMenu: (kind: 'lane' | 'account', id: string, anchor: Element) => void;
  /** v2.4 §6.6 `raw` = a `/` line sent without the `[PO]` prefix; §6.3 / §5.5 the chips as `{ up }` / `{ path }`. */
  /** settles with the engine's answer: a send with chips clears them only once it is acked (R21 an expired copy). */
  onSend: (t: Target, text: string, raw?: true, attachments?: SendItem[]) => Promise<unknown>; onInterrupt: (t: Target) => void; onLocal: (cmd: 'lanes' | 'quota' | 'handoff' | 'new') => void;
  onStopAsk: (lane: string) => void; onOrchestrator: (cmd: 'orchestrator_restart' | 'orchestrator_new') => void;
  onOlder: () => void; onJumpEnd: () => void; onError: (text: string, icon?: ToastIcon) => void;
  onResume: (lane: string) => void;
  /** hot fix 2026-11-16 "Tiếp tục" / "Bắt đầu" of a held project (`project_resume`; an error toasts in the shell). */
  onProjectResume: () => Promise<unknown>;
  /** v2.1 §4.14 the project's running sessions (deck roots), the one Đang xem shows, the session list (ended rows). */
  sessions: OrchestratorView[]; viewed: OrchestratorView | null; sessionsList: SessionsList | null;
  /** §4.14 "Điều phối #n ▾" / H: the session list under the header; the composer chip switches the viewed session. */
  onHistory: (anchor: Element) => void; onView: (sessionId: string) => void;
  onSessionResume: (sessionId: string, from?: 'handoff' | 'tail') => void; onOpenHandoff: (path: string) => void;
  loadPreview: (sessionId: string) => Promise<ResumePreview | null>;
  onPause: (email: string, on: boolean) => void; onMoveAll: (email: string) => void; onRelogin: (email: string) => void; onEditCaps: () => void;
  /** v2.1 §4.15 §3 the done list and the done-lane view. */
  done: DoneProps;
  /** v2.4 §4.2 / §4.5 the picker's commands (`session_*` / `lane_*`); `modelReq` bumps = open it ("⋯" → "Model / effort…",
   *  ⌘K): Điều phối's, or `lane`'s. */
  modelSend: (c: Command) => Promise<unknown>; modelReq: { n: number; lane?: string };
  /** v2.4 §6.1 a dialog is open (no paste / drop lands); the `/attach*` Bearer token; focus the composer (opens the drawer). */
  modal: boolean; token: () => string | null; onFocusInput: () => void;
}

export function Inspector(p: InspectorProps): ReactElement {
  const tr = useT();
  const pid = p.project.id;
  const lanes = p.snap.lanes.filter(l => l.projectId === pid);
  const orch = p.viewed, multi = everMulti(p.sessions);
  const name = orch ? rootName(tr, orch, multi) : tr('common.role.orchestrator');
  // a selection whose lane / sub / account vanished falls back to its parent (never a blank block)
  let sel = p.sel;
  if ((sel.k === 'lane' || sel.k === 'sub') && !lanes.some(l => l.name === (sel.k === 'lane' ? sel.name : (sel as { lane: string }).lane))) sel = ORCH;
  if (sel.k === 'sub' && !(p.subs[sel.lane] ?? []).some(s => s.taskId === (sel as { taskId: string }).taskId)) sel = selUp(sel)!;
  if (sel.k === 'account' && !p.snap.accounts.some(a => a.email === (sel as { email: string }).email)) sel = ORCH;
  const isDone = sel.k === 'doneList' || sel.k === 'doneLane';
  const target = p.target; // v2.3 §4.3 one composer target, computed by the shell (`composerFor`)
  const parts = crumbs(sel, tr, p.subs, name);
  if (isDone && p.done.total !== null) parts[1] = tr('done.crumbN', { n: p.done.total });
  const toSel = (t: Target) => p.onSel(t.kind === 'lane' ? { k: 'lane', name: t.name } : ORCH);
  const crumbSel = (i: number): Selection => (i === 0 ? ORCH : isDone ? { k: 'doneList' } : { k: 'lane', name: parts[1]! });
  const box = useRef<HTMLElement>(null);
  const trayOne = useColumnFit(box, sel.k === 'orch' || sel.k === 'lane' ? sel.k : null, // §6.2 I1, v2.1 UX-I6
    `${sel.k}:${sel.k === 'lane' ? sel.name : ''}:${orch?.sessionId ?? ''}:${orch?.state ?? ''}`);
  const [mm, setMm] = useState<MenuPlace | null>(null);
  // §4.5 the picker belongs to the selection it opened on: another selection closes it
  const selKey = `${sel.k}:${sel.k === 'lane' ? sel.name : ''}`;
  useEffect(() => setMm(null), [selKey]);
  // §4.2 the picker opens under the chip and stops above the composer (its height = the room between them)
  const openModel = () => {
    const sec = box.current, chip = sec?.querySelector('button.mchip'), frame = sec?.querySelector('.inrow');
    if (!sec || !chip || !frame || (sel.k === 'orch' && !orch?.sessionId)) return;
    setMm(menuPlace(window.innerHeight, sec.getBoundingClientRect(), chip.getBoundingClientRect(), frame.getBoundingClientRect()));
  };
  // `/model` / "⋯" / ⌘K from another selection: its owner (Điều phối, or the lane, §4.5 Y45) is selected first, the picker
  // opens on the next render
  const want = useRef<string | null>(null), modelReq = useRef(p.modelReq.n);
  const isSel = (lane?: string) => (lane ? sel.k === 'lane' && sel.name === lane : sel.k === 'orch');
  const askModel = (lane?: string) => {
    if (isSel(lane)) return openModel();
    want.current = lane ?? '';
    p.onSel(lane ? { k: 'lane', name: lane } : ORCH);
  };
  useEffect(() => {
    if (p.modelReq.n !== modelReq.current) { modelReq.current = p.modelReq.n; askModel(p.modelReq.lane); }
    else if (want.current !== null && isSel(want.current || undefined)) { want.current = null; openModel(); }
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const mac = p.snap.channel === 'mac';

  if (sel.k === 'session') {
    const sid = sel.sessionId, list = p.sessionsList;
    const row = list ? [...list.ended, ...list.running].find(r => r.sessionId === sid) ?? null : null;
    const label = row ? sessionLabel(tr, row.seq, row.title) : '…';
    const escTip = orch ? tr('session.escBack', { n: orch.seq ?? 1 }) : tr('inspector.upTip');
    return (
      <section id="inspector" className="glass k-session" aria-label={tr('inspector.aria')}>
        <header className="ih">
          <nav className="crumb" aria-label={tr('inspector.crumbAria')} title={`${parts[0]} › ${label}`}>
            <span className="cr-w"><button type="button" className="cr" onClick={e => p.onHistory(e.currentTarget)}>{parts[0]}</button><i>›</i></span>
            <b>{label}</b>
          </nav>
          <span className="esc" title={escTip}>{escTip}</span>
          <button type="button" className="x" onClick={p.onClose} title={tr('unit.deselectTip')} aria-label={tr('unit.deselect')}><Icon n="x" s={14} /></button>
        </header>
        <SessionView row={row} channel={p.snap.channel} offline={p.offline} stream={p.stream} onResume={from => p.onSessionResume(sid, from)}
          onOpenHandoff={p.onOpenHandoff} loadPreview={() => p.loadPreview(sid)} onOlder={p.onOlder} onJumpEnd={p.onJumpEnd} hideTools={p.hideTools} />
      </section>
    );
  }
  let info: ReactNode = null, hist: ReactNode = null, note: ReactNode = null;
  // m-5 N5-h a resumed session still starting: its resume divider + the engine's first line, the skeleton under them
  const resumed = sel.k === 'orch' && orch?.state === 'starting' ? resumedTail(p.stream?.lines ?? []) : null;
  if (sel.k === 'orch') {
    info = <OrchInfo {...p} orch={orch} lanes={lanes} name={name} skel={!resumed} menuOpen={!!mm} onChip={() => (mm ? setMm(null) : openModel())} />;
    if (resumed) hist = <Conversation stream={{ ...p.stream!, lines: resumed, hasOlder: false }} hideTools={p.hideTools} color="var(--accent)" skel onOlder={p.onOlder} onJumpEnd={p.onJumpEnd} />;
  } else if (sel.k === 'lane') {
    const l = lanes.find(x => x.name === (sel as { name: string }).name)!;
    info = <LaneInfo {...p} lane={l} subsFirst={!!sel.subsFirst} laneSubs={p.subs[l.name] ?? []} menuOpen={!!mm} onChip={() => (mm ? setMm(null) : openModel())} />;
  } else if (sel.k === 'sub') {
    const s = sel, l = lanes.find(x => x.name === s.lane)!, sv = (p.subs[s.lane] ?? []).find(x => x.taskId === s.taskId)!;
    info = <SubInfo sub={sv} lane={l} now={p.now} />;
    hist = <SubHist lines={p.subLines} loading={p.subLoading} sub={sv} live={p.subLive} hideTools={p.hideTools} offline={p.offline} />;
    note = <div className="note"><Icon n="info" s={14} /><span>{tr('inspector.subRO', { name: s.lane })}</span></div>;
  } else if (sel.k === 'doneList' || sel.k === 'doneLane') {
    const ds = sel;
    info = <Suspense fallback={null}><DoneBody sel={ds} snap={p.snap} project={p.project} now={p.now} offline={p.offline} dataAt={p.dataAt}
      sessions={p.sessions} viewedSid={orch?.sessionId ?? null} sessionsList={p.sessionsList} subs={ds.k === 'doneLane' ? p.subs[ds.name] ?? [] : []}
      done={p.done} onSel={p.onSel} onMenu={(n, el) => p.onMenu('lane', n, el)} /></Suspense>;
    if (ds.k === 'doneLane') {
      hist = <Conversation stream={p.stream} live={p.live} hideTools={p.hideTools} offline={p.offline} color="var(--fg-3)" onOlder={p.onOlder} onJumpEnd={p.onJumpEnd} />;
      note = <div className="note"><Icon n="info" s={14} /><span>{tr('done.viewNote')}</span></div>;
    }
  } else {
    const a = p.snap.accounts.find(x => x.email === (sel as { email: string }).email)!;
    info = <AccountInfo {...p} account={a} />;
  }
  // UX-M6 N4-c a starting Điều phối shows its skeleton only, never the old transcript under it
  if ((sel.k === 'orch' && orch?.state !== 'starting') || sel.k === 'lane') {
    const lane = sel.k === 'lane' ? lanes.find(x => x.name === (sel as { name: string }).name) ?? null : null;
    // §14.5 a Task row leads to its sub (v2.1)
    const onTask = lane ? (id: string) => { const s = (p.subs[lane.name] ?? []).find(x => x.toolUseId === id); if (s) p.onSel({ k: 'sub', lane: lane.name, taskId: s.taskId }); } : undefined;
    hist = <Conversation stream={p.stream} live={p.live} hideTools={p.hideTools} offline={p.offline} color={lane ? accountColor(p.snap.accounts, lane.account) : 'var(--accent)'}
      designNew={!lane && !!p.stream && designFresh(orch, p.stream.lines)} onOlder={p.onOlder} onJumpEnd={p.onJumpEnd} onTask={onTask} />;
  }

  return (
    <section id="inspector" ref={box} className={`glass k-${sel.k}`} aria-label={tr('inspector.aria')}>
      <header className="ih">
        <nav className="crumb" aria-label={tr('inspector.crumbAria')} title={parts.join(' › ')}>
          {parts.map((c, i) => i < parts.length - 1
            ? <span key={i} className="cr-w">{sel.k === 'account' ? c : <button type="button" className="cr" onClick={() => p.onSel(crumbSel(i))}>{c}</button>}<i>›</i></span>
            : <b key={i}>{c}</b>)}
        </nav>
        {hist && sel.k !== 'orch' ? <HideTools on={p.hideTools} onChange={p.onHideTools} /> : null}
        {sel.k !== 'orch' ? <><span className="esc" title={tr('inspector.upTip')}>{tr('inspector.upTip')}</span>
          <button type="button" className="x" onClick={p.onClose} title={tr('unit.deselectTip')} aria-label={tr('unit.deselect')}><Icon n="x" s={14} /></button></> : null}
      </header>
      <div className={`iinfo ${hist ? '' : 'full'}`}>{info}</div>
      {sel.k === 'orch' && p.project.held ? <HeldBand held={p.project.held} offline={p.offline} onResume={p.onProjectResume} /> : null}
      {hist}
      {note}
      <Composer {...p} sel={sel} target={target} lanes={lanes} orch={orch} name={name} trayOne={trayOne} onTarget={toSel} onModel={askModel} />
      {mm && mac ? <Picker {...p} sel={sel} lanes={lanes} orch={orch} name={name} place={mm} onClose={() => setMm(null)} /> : null}
    </section>
  );
}

/** §4.2 / §4.5 the open picker of the selection: Điều phối's session, or the selected lane (LM2). */
function Picker(p: InspectorProps & { sel: Selection; lanes: LaneView[]; orch: OrchestratorView | null; name: string; place: MenuPlace; onClose: () => void }): ReactElement | null {
  const tr = useT();
  const ro = p.offline ? tr('model.offline', { hm: p.dataAt ? fmtHm(p.dataAt) : '—' }) : null;
  const common = { ro, place: p.place, send: p.modelSend, onClose: p.onClose, onToast: p.onError };
  const acc = (a: string | null) => (a ? shortEmail(a) : '—');
  if (p.sel.k === 'orch') {
    const o = p.orch;
    return o?.sessionId ? <Suspense fallback={null}><ModelMenu {...common} o={o} of={{ kind: 'orch', projectId: o.projectId, sessionId: o.sessionId }} name={p.name} account={acc(o.account)} /></Suspense> : null;
  }
  const name = p.sel.k === 'lane' ? p.sel.name : null, l = p.lanes.find(x => x.name === name), o = l ? laneSubject(tr, l) : null;
  return l && o ? <Suspense fallback={null}><ModelMenu {...common} o={o} of={{ kind: 'lane', projectId: l.projectId, name: l.name }} name={l.name} account={acc(l.account)} /></Suspense> : null;
}

// ---------------------------------------------------------------- bodies
function OrchInfo(p: InspectorProps & { orch: OrchestratorView | null; lanes: LaneView[]; name: string; skel: boolean; menuOpen: boolean; onChip: () => void }): ReactElement {
  const tr = useT();
  const o = p.orch, st = o?.state ?? 'stopped';
  const t: Target = { kind: 'orchestrator', projectId: p.project.id, ...(o?.sessionId ? { sessionId: o.sessionId } : {}) };
  // §4.14 "Điều phối #n ▾ · tên": opens the session list (also H / "⋯" → Lịch sử phiên…)
  const head = <button type="button" className="oname" aria-haspopup="dialog" title={tr('session.headTip')} onClick={e => p.onHistory(e.currentTarget)}>
    <h2>{p.name}</h2>{p.sessions.length > 1 && o?.title && (o.orchKind ?? 'general') === 'general' ? <span className="otitle" title={o.title}>· {o.title}</span> : null}<Icon n="chev" s={12} /></button>;
  const kindLabel = o ? orchKindLabel(tr, o, p.sessions, projectIssues(p.snap, p.project.id)) : null; // v2.7 §5.0
  const kind = kindLabel ? <span className="okind">{kindLabel}</span> : null;
  if (st === 'starting') return <div className="ohead"><div className="row">{head}{kind}<span className="st">{tr('inspector.starting')}</span></div>
    {p.skel ? <div className="skel"><i /><i /><i /></div> : null}</div>;
  // §4.14 with > 1 session: only the lanes this session owns
  const mine = p.sessions.length > 1 && o?.sessionId ? p.lanes.filter(l => l.ownerSession === o.sessionId) : p.lanes;
  const running = mine.filter(l => l.state === 'running').map(l => l.name);
  if (o?.talkingTo && running.includes(o.talkingTo)) running.sort((a, b) => (a === o.talkingTo ? -1 : b === o.talkingTo ? 1 : 0));
  const noAcc = !o?.account || p.snap.accounts.length === 0;
  const acc = p.snap.accounts.find(a => a.email === o?.account);
  // UX-I5 the status takes only the room the title leaves; clipped, it ellipsises and its title carries the full text
  const [stCls, stText] = st === 'stopped' ? ['bad', orchStateText(tr, st)]
    : st === 'paused' ? ['mute', orchStateText(tr, st)]
    : st === 'waiting_quota' ? ['mute', noAcc ? tr('inspector.waitAccount') : earliestReset(p.snap.accounts, tr)]
    : running.length ? ['ok', tr('inspector.with', { lanes: running.join(', ') })]
    : ['', orchStateText(tr, st)];
  const status = <span className={`st ${stCls}`} title={stText}>{stText}</span>;
  // N-d a titled session ("#4 · hotfix") leaves the status too little room in the head row: it opens the meta line instead
  const titled = p.sessions.length > 1 && !!o?.title;
  const tok = o?.tokens ? displayTokens(o.tokens) : null;
  const dis = p.offline;
  const stats = statLine([o?.account ? shortEmail(o.account) : '—', `ctx ${tr('format.pct', { n: o?.contextPct ?? '?' })}`,
    tok !== null ? tr('inspector.tok', { n: fmtTok(tok, tr) }) : null, fmtCost(o?.costUsd ?? 0, tr), acc?.fiveWindow ? `5h ${tr('format.pct', { n: acc.fivePct ?? '?' })}` : null]); // D103 Ultra: no 5-hour text
  return (
    <div className="ohead">
      {/* F-I7 S1: the title never clips — "Ẩn công cụ" sits on the meta line, the status takes the rest of the head row */}
      <div className="row">{head}{kind}{titled ? null : status}
        {o && orchRunning(st) ? <button type="button" className="btn sm ghost" disabled={dis} onClick={() => p.onInterrupt(t)} title={tr('console.interruptTip', { who: tr('console.whoOrch') })}><Icon n="pause" s={14} /> {tr('console.interrupt')}</button> : null}</div>
      {/* R43 I1: "Ẩn công cụ" at the chip row's right end, so the stat line stays one line (ellipsis, full text in its title) */}
      <div className="crow">{o?.modelName || o?.model ? <ModelChip o={o} name={p.name} remote={p.snap.channel !== 'mac'} offline={p.offline} open={p.menuOpen} onClick={p.onChip} /> : null}
        <span className="sp" /><HideTools on={p.hideTools} onChange={p.onHideTools} /></div>
      <div className="meta mono" title={`${titled ? `${stText} · ` : ''}${stats}`}>{titled ? <>{status} · </> : null}{stats}</div>
      <WfLine wf={o?.wf} />
      {st === 'stopped' ? <div className="down"><Icon n="alert" s={14} /><span>{tr('console.orchDown', { project: p.project.name, err: o?.lastError ? ` (${reasonText(tr, o.lastError, o.lastErrorKeyed)})` : '' })}</span>
        {canRun(p.snap.channel, 'orchestrator_restart')
          ? <div className="acts"><button type="button" className="btn sm pri" disabled={dis} onClick={() => p.onOrchestrator('orchestrator_restart')}><Icon n="refresh" s={14} /> {tr('console.restart')}</button>
            <button type="button" className="btn sm" disabled={dis} onClick={() => p.onOrchestrator('orchestrator_new')}>{tr('console.newSession')}</button></div>
          : <small>{tr('inspector.restartMac')}</small>}</div> : null}
    </div>
  );
}

/** v2.4 §4.1 MD1 / §4.5 LM1 the chip on its own line under the session / lane name: what it really runs; MD9 amber dot;
 *  MD13 dimmed (still opens, read only); remote (LM4, Y44): plain text + lock "Đổi model trên Mac", no picker (§8). */
function ModelChip({ o, name, remote, offline, open, onClick }: { o: ModelSubject; name: string; remote: boolean; offline: boolean; open: boolean; onClick: () => void }): ReactElement {
  const tr = useT();
  const label = <>{o.modelMismatch ? <i className="adot" title={tr('model.chipMismatch')} /> : null}{chipText(tr, o)}</>;
  if (remote) return <span className="mchip ro" title={tr('model.chipMac')}>{label}<Icon n="lock" s={12} /></span>;
  return <button type="button" className={['mchip', offline ? 'off' : null, o.modelMismatch ? 'mis' : null, o.pending ? 'wait' : null].filter(Boolean).join(' ')}
    aria-haspopup="dialog" aria-expanded={open} title={tr('model.chipTip', { name })} onClick={onClick}>{label}<i className="car" aria-hidden="true">▾</i></button>;
}

/** §4.10 N4-e "Chờ quota · acc07@ reset 08:00 18/11" (v2.7.1 L8): the account that resets first, by name. */
/** v2.7.1 L8 a quota row's reset: "reset 05:59 18/11", or "reset chưa rõ" when the engine has no time. */
const resetNote = (tr: Tr, at: number | null) => { const t = fmtResetTime(at); return t === null ? tr('unit.resetUnknown') : tr('unit.resetAt', { when: t }); };

function earliestReset(accs: AccountView[], tr: Tr): string {
  const r = accs.map(a => ({ at: resetAt(a), email: a.email })).filter((x): x is { at: number; email: string } => x.at !== null).sort((a, b) => a.at - b.at)[0];
  return r === undefined ? orchStateText(tr, 'waiting_quota') : tr('inspector.waitQuota', { email: shortEmail(r.email), when: fmtResetTime(r.at) });
}

function LaneInfo(p: InspectorProps & { lane: LaneView; subsFirst: boolean; laneSubs: SubagentView[]; menuOpen: boolean; onChip: () => void }): ReactElement {
  const tr = useT();
  const l = p.lane, accs = p.snap.accounts, ms = laneSubject(tr, l);
  // §4.5 a lane Xong has no chip: its last model · effort leads the facts line (MD12, Y33)
  const lastRun = lastRunText(l);
  const [allSubs, setAllSubs] = useState(p.subsFirst);
  useEffect(() => { if (p.subsFirst) setAllSubs(true); }, [p.subsFirst]);
  const a = accs.find(x => x.email === l.account);
  const can = (c: Parameters<typeof canRun>[1]) => canRun(p.snap.channel, c);
  const dis = p.offline;
  const t: Target = { kind: 'lane', projectId: l.projectId, name: l.name };
  const owner = laneSessionLine(tr, l, p.sessions); // §4.14 "Phiên #3 · <tên>"
  const tk = l.tokens;
  const tokText = tk ? tr('inspector.tok', { n: fmtTok(displayTokens(tk), tr) }) : null; // R43 M4 the in · out · cache split lives in the node tooltip
  const accLine = [lastRun, l.account ? `${shortEmail(l.account)}${a ? ' ' + headroom(tr, a) : ''}` : tr('unit.noAccount'), tokText, fmtCost(l.costUsd, tr)].filter(Boolean).join(' · ');
  const activity = l.turnStartedAt ? tr('unit.turnNow', { t: fmtLeft(p.now - l.turnStartedAt, tr) }) : tr('unit.turnLast', { t: fmtLeft(p.now - l.updatedAt, tr) });
  const active = l.state !== 'stopped' && l.state !== 'done' && l.state !== 'broken';
  const [factsOpen, setFactsOpen] = useState(false);
  const low = useMedia(SHORT_Q), short = !!p.narrow || low;
  const [subsOpen, setSubsOpen] = useState(false);
  const fold = factsFolded(!!p.narrow, l.state);
  const kvRef = useRef<HTMLDListElement>(null);
  // F-I8: opening the folded facts brings them into the short info block (1024 drawer), clear of the sticky Subagent head
  useEffect(() => { if (factsOpen) kvRef.current?.scrollIntoView({ block: 'nearest' }); }, [factsOpen]); // only a click opens them
  const wt = `${l.cwd.replace(/^\/Users\/[^/]+/, '~')}${l.worktreeExists ? '' : ` ${tr('unit.wtGone')}`}`;
  const summary = [`${tr('unit.dt.fails')} ${l.failCount} / 3`, activity, `${tr('inspector.worktree')} ${wt}`].join(' · '); // R-M2 short facts first
  const subs = visibleSubs(p.laneSubs, allSubs), runningN = p.laneSubs.filter(s => s.status === 'running').length;
  // N2-l: failed subs first, then running, then completed
  const ordered = p.subsFirst ? [...subs].sort((x, y) => subRank(x) - subRank(y)) : subs;
  const cap = shortSubs(ordered, short && !p.subsFirst, subsOpen); // R43 I3 a short column: 1 row + "+n subagent"
  const subSection = p.laneSubs.length ? <div className={`subsec ${p.subsFirst ? 'first' : ''}`}>
    <div className="log-h"><span>{tr('unit.subHead', { n: runningN })}</span>
      {cap.more ? <button type="button" className="lnk submore" onClick={() => setSubsOpen(true)}>{tr('unit.subMore', { n: cap.more })}<Icon n="chevR" s={12} /></button>
        : p.laneSubs.length > subs.length || (allSubs && !p.subsFirst) ? <button type="button" className="lnk" onClick={() => setAllSubs(x => !x)}>{allSubs ? tr('unit.collapse') : tr('unit.seeAll', { n: p.laneSubs.length })}</button> : null}</div>
    <div className={`subs${cap.more ? ' one' : ''}`}>{cap.shown.map(s => (
      <button type="button" key={s.taskId} className={`sub ${s.status}`} onClick={() => p.onSel({ k: 'sub', lane: l.name, taskId: s.taskId })}>
        <span className="sl" title={`${s.subagentType} ${s.description}`}><b>{s.subagentType}</b> {s.description}</span>
        <span className="m">{subState(tr, s.status)}{s.background ? ` · ${tr('unit.bg')}` : ''}{s.totalTokens !== null ? ` · ${tr('inspector.tok', { n: fmtTok(s.totalTokens, tr) })}` : ''}</span>
      </button>))}</div>
  </div> : null;
  return (
    <div className="lhead">
      <div className="row"><h2>{l.name}</h2><span className={`pill ${LANE_CLASS[l.state]}`}>{laneState(tr, l.state)}</span><span className="sp" />
        {laneRunning(l.state) && can('interrupt') ? <button type="button" className="btn sm ghost" disabled={dis} onClick={() => p.onInterrupt(t)}><Icon n="pause" s={14} /> {tr('console.interrupt')}</button> : null}
        {active && can('lane_stop') ? <button type="button" className="btn sm bad" disabled={dis} onClick={() => p.onStopAsk(l.name)}><Icon n="stop" s={14} /> {tr('unit.stop')}</button> : null}
        {(l.state === 'stopped' || l.state === 'broken') && can('lane_resume') ? <button type="button" className="btn sm pri" disabled={dis} onClick={() => p.onResume(l.name)}><Icon n="refresh" s={14} /> {tr('unit.resume')}</button> : null}
        <button type="button" className="more" aria-haspopup="menu" onClick={e => p.onMenu('lane', l.name, e.currentTarget)} aria-label={tr('inspector.menu', { name: l.name })} title={tr('inspector.menu', { name: l.name })}>⋯</button></div>
      {ms ? <ModelChip o={ms} name={l.name} remote={p.snap.channel !== 'mac'} offline={p.offline} open={p.menuOpen} onClick={p.onChip} /> : null}
      <div className="meta mono">{[l.phase ? phaseName(tr, l.phase) : null, l.task, l.note].filter(Boolean).join(' · ') || '—'}</div>
      {owner ? <div className="meta owner">{owner}</div> : null}
      <div className="meta mono acc" title={accLine}>{accLine}</div>
      <WfLine wf={l.wf} />
      {p.subsFirst ? subSection : null}
      {/* F-I8 S4 / S4-narrow: narrow window or a running lane → the facts fold to one line (click opens them; nothing is removed) */}
      {fold ? <button type="button" className="kvsum" aria-expanded={factsOpen} title={summary} onClick={() => setFactsOpen(x => !x)}>
        <span>{summary}</span><Icon n={factsOpen ? 'chev' : 'chevR'} s={12} /></button> : null}
      {!fold || factsOpen ? <dl className="kv" ref={kvRef}>
          <dt>{tr('inspector.worktree')}</dt><dd className="mono">{wt}</dd>
          <dt>{tr('unit.dt.fails')}</dt><dd className="num">{l.failCount} / 3 · ctx {tr('format.pct', { n: l.contextPct ?? '?' })}{l.lastError ? <small>{reasonText(tr, l.lastError, l.lastErrorKeyed)}</small> : null}</dd>
          <dt>{tr('unit.dt.account')}</dt><dd><span className="accl"><i className="dot" style={{ '--c': accountColor(accs, l.account) } as CSSProperties} />
            <b>{l.account ? shortEmail(l.account) : tr('unit.noAccount')}</b>{a ? <AccFlags a={a} /> : null}</span>
            <small>{l.switches ? tr('unit.switches', { n: l.switches }) : tr('unit.noSwitch')}</small></dd>
          <dt>{tr('unit.dt.activity')}</dt><dd>{activity}</dd>
        </dl> : null}
      {p.subsFirst ? null : subSection}
    </div>
  );
}

function SubInfo({ sub, lane, now }: { sub: SubagentView; lane: LaneView; now: number }): ReactElement {
  const tr = useT();
  const took = sub.startedAt != null ? fmtLeft((sub.endedAt ?? now) - sub.startedAt, tr) : null; // §4.11b "thời gian"
  return (
    <div className="shead">
      <div className="row"><h2 className="subn">{sub.subagentType}</h2><span className={`pill ${sub.status === 'running' ? 'ok' : sub.status === 'failed' ? 'bad' : ''}`}>{subBadge(tr, sub.status)}</span>
        {sub.background ? <span className="pill">{tr('unit.bg')}</span> : null}</div>
      <div className="meta mono">{[sub.description, `${tr('subagent.parent')} ${lane.name}`, lane.account ? shortEmail(lane.account) : null,
        sub.toolUses !== null ? tr('inspector.subTools', { n: sub.toolUses }) : null, sub.totalTokens !== null ? tr('inspector.tok', { n: fmtTok(sub.totalTokens, tr) }) : null, took].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

function SubHist({ lines, loading, sub, live, hideTools, offline }: { lines: StreamLine[]; loading: boolean; sub: SubagentView; live: Live | undefined; hideTools: boolean; offline: boolean }): ReactElement {
  const tr = useT();
  const result = sub.status !== 'running' ? [...lines].reverse().find(l => l.kind === 'assistant') : undefined;
  return (
    <ConvList lines={lines} live={live} sub hideTools={hideTools} offline={offline} color="var(--accent)"
      tail={streaming => { const empty = !lines.length && !streaming; return <>{loading && empty ? <div className="m-evt">{tr('subagent.loading')}</div> : null}
        {!loading && empty ? <div className="m-evt">{tr('subagent.empty')}</div> : null}
        {result ? <div className="res"><b>{tr('subagent.returned')}</b> {result.text}</div> : null}</>; }} />
  );
}

function AccountInfo(p: InspectorProps & { account: AccountView }): ReactElement {
  const tr = useT();
  const a = p.account, st = accountState(a, p.now), s = p.snap;
  const pill = st === 'out' ? ['bad', tr('unit.st.out')] : st === 'full' ? ['bad', tr('unit.st.full')] : st === 'stale' ? ['', tr('unit.st.stale')] : ['ok', tr('unit.st.ok')];
  const on = lanesOn(a.email, s.lanes), active = on.filter(isActiveLane), today = ranToday(a.email, s.lanes, p.now);
  const orchs = s.orchestrators.filter(o => o.account === a.email);
  const pname = (id: string) => s.projects.find(x => x.id === id)?.name ?? id;
  const r = resetAt(a), mac = s.channel === 'mac', dis = p.offline;
  const waiting = s.lanes.filter(l => l.state === 'waiting_quota').length;
  return (
    <div className="ahead">
      <div className="row"><h2><i className="dot" style={{ '--c': accountColor(s.accounts, a.email) } as CSSProperties} /> {shortEmail(a.email)}</h2>
        <span className={`pill ${pill[0]}`}>{pill[1]}</span><span className="sp" />
        <button type="button" className="more" aria-haspopup="menu" onClick={e => p.onMenu('account', a.email, e.currentTarget)} aria-label={tr('inspector.menu', { name: shortEmail(a.email) })}>⋯</button></div>
      <div className="meta"><AccFlags a={a} /> {a.email}{a.plan ? ` · ${a.plan}` : ''} · {tr(ROLE_KEY[a.role])} · {tr('unit.cap', { kind: tr(a.hard ? 'unit.kindHard' : 'unit.kindSoft'), week: a.week })}{a.fiveWindow && a.five !== null ? ` · ${tr('unit.fiveCap', { five: a.five })}` : ''}</div>
      {/* m-1 N3-l the action row sits under the identity line, above the quota rows (never cut by the composer) */}
      <div className="acts">
        {mac ? <button type="button" className="btn sm" disabled={dis} onClick={() => p.onPause(a.email, !p.paused)}><Icon n="lock" s={14} /> {p.paused ? tr('unit.resumeNew') : tr('unit.pauseNew')}</button> : null}
        {canRun(s.channel, 'lane_switch_account') ? <button type="button" className="btn sm" disabled={dis || !active.length} onClick={() => p.onMoveAll(a.email)}><Icon n="swap" s={14} /> {tr('unit.moveAll')}</button> : null}
        {mac && loginChip(tr, a).relogin ? <button type="button" className="btn sm pri" disabled={dis} onClick={() => p.onRelogin(a.email)}>{tr('unit.relogin')}</button> : null}
        {mac ? <button type="button" className="btn sm" disabled={dis} onClick={p.onEditCaps}>{tr('unit.editCaps')}</button> : null}
      </div>
      <dl className="kv">
        <dt>{tr('unit.dt.week')}</dt><dd className="num" style={a.full ? { color: 'var(--bad)' } : undefined}><b>{headroom(tr, a)}</b> · {tr('unit.pct', { pct: a.weekPct ?? '?' })} {tr('unit.used')}
          <small>{resetNote(tr, a.weekResetsAt)}</small></dd>
        {/* D103: an Ultra account has no 5-hour window — no row, no "?", no "reset chưa rõ" */}
        {a.fiveWindow ? <><dt>{tr('unit.dt.five')}</dt><dd className="num"><b>{tr('unit.pct', { pct: a.fivePct ?? '?' })}</b> {tr('unit.used')}<small>{resetNote(tr, a.fiveResetsAt)}</small></dd></> : null}
        <dt>{tr('unit.dt.today')}</dt><dd className="num">{todayLine(tr, a.email, s.lanes, orchs.length, p.now)}</dd>
        <dt>{tr('unit.dt.data')}</dt><dd>{a.fetchedAt === null ? tr('unit.noData') : st === 'stale'
          ? <span className="stale"><span className="spin" style={{ width: 12, height: 12 }} />{tr('unit.ageRefetch', { t: fmtLeft(p.now - a.fetchedAt, tr) })}</span>
          : tr('unit.age', { t: fmtLeft(p.now - a.fetchedAt, tr) })}</dd>
      </dl>
      {st === 'out' ? <div className="preview bad"><Icon n="user" /><span>{tr('unit.outNote')}</span></div>
        : st === 'full' ? <div className="preview bad"><Icon n="lock" /><span>{tr('unit.fullNote', { when: fmtResetTime(r) ?? tr('format.chip.unknown'), n: waiting })}</span></div> : null}
      {p.paused ? <div className="preview"><Icon n="lock" /><span>{tr('unit.pausedNote')}</span></div> : null}
      <div className="sh">{tr('unit.runningHere')}</div>
      {orchs.map(o => <div key={o.projectId} className="arow past"><b>{tr('unit.orchRow', { project: pname(o.projectId) })}</b><span className="foot">{orchStateText(tr, o.state)}</span><span className="m">ctx {tr('format.pct', { n: o.contextPct ?? '?' })}</span></div>)}
      {active.length ? active.map(l => {
        const subN = (l.projectId === p.project.id ? p.subs[l.name] ?? [] : []).filter(x => x.status === 'running').length;
        return <div key={`${l.projectId}:${l.name}`} className="arow" role="button" tabIndex={0} onClick={() => l.projectId === p.project.id && p.onSel({ k: 'lane', name: l.name })}>
          <b>{l.name} · {pname(l.projectId)}{l.phase ? ` · ${phaseName(tr, l.phase)}` : ''}</b><span className="foot">{tr('unit.laneFoot', { n: subN, t: fmtLeft(p.now - l.updatedAt, tr) })}</span>
          <span className="m">{[l.task, l.note].filter(Boolean).join(' — ') || laneState(tr, l.state)}</span></div>;
      }) : orchs.length ? null : <div className="gnone">{tr('unit.none')}{a.full || a.loggedOut ? '' : ` ${tr('unit.noneMovable', { n: waiting })}`}</div>}
      {today.length ? <><div className="sh">{tr('unit.ranToday')}</div>{today.map(l => <div key={`${l.projectId}:${l.name}`} className="arow past"><b>{l.name}</b><span className="foot">{laneState(tr, l.state)}</span><span className="m">{pname(l.projectId)}</span></div>)}</> : null}
    </div>
  );
}

/** v2 §6 A2 chips: login state + "cấu hình chung lỗi" (incl. §5.4 MCP). */
function AccFlags({ a }: { a: AccountView }): ReactElement {
  const tr = useT();
  const c = loginChip(tr, a), issues = cfgIssues(tr, a);
  return <>
    <span className={`pill ${c.cls}`} title={c.title}>{c.text}</span>
    {issues.length ? <span className="pill warn" title={issues.join(' · ')} aria-label={tr('unit.cfgAria', { list: issues.join(', ') })}>{tr('unit.cfgPill')}</span> : null}
  </>;
}

// ---------------------------------------------------------------- composer (v2.4 §6.2 D51: one frame)
const SLASH: [string, Key][] = [
  ['/lanes', 'console.slash.lanes'], ['/quota', 'console.slash.quota'], ['/stop D2', 'console.slash.stop'],
  ['/handoff', 'console.slash.handoff'], ['/new', 'console.slash.new'], ['/model', 'model.slashModel'], ['/effort', 'model.slashEffort'], ['/…', 'console.slash.other'],
];

/** Hot fix 2026-11-16 a held project (docs/ref/hf1116-ux.md §4): why nothing runs, and "Tiếp tục" / "Bắt đầu" (busy until
 *  the engine answers; the composer stays usable — sending resumes it too). */
function HeldBand({ held, offline, onResume }: { held: NonNullable<ProjectView['held']>; offline: boolean; onResume: () => Promise<unknown> }): ReactElement {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const b = heldBand(tr, held);
  const go = () => { setBusy(true); void onResume().catch(() => {}).finally(() => setBusy(false)); };
  return <div className="m-sys info held" role="status"><Icon n="pause" s={14} /><span>{b.text}</span>
    <button type="button" className="btn sm pri" disabled={busy || offline} aria-busy={busy || undefined} onClick={go}>{busy ? <span className="spin" aria-hidden="true" /> : null}{b.button}</button></div>;
}

/** v2.4 §6.2 D51 one frame: the chip strip → the text, full width, growing upward to its cap (3 lines with chips) → a fixed
 *  28 px bar (recipient left, send right) that never moves with the text. §6.1 paste / drop anywhere lands here (Mac only). */
function Composer(p: InspectorProps & { sel: Selection; target: Target; lanes: LaneView[]; orch: OrchestratorView | null; name: string; trayOne: boolean; onTarget: (t: Target) => void; onModel: (lane?: string) => void }): ReactElement {
  const tr = useT();
  const [value, setValue] = useState('');
  const [menu, setMenu] = useState(false);
  const [hover, setHover] = useState(false);
  const [sending, setSending] = useState(false);
  const caret = useRef(false);
  const live = useRef({ tr, token: p.token });
  live.current = { tr, token: p.token };
  const { state: { items, dropped }, run } = useAttachments(() => ({
    token: () => live.current.token(), now: () => new Date(), pasteName: t => live.current.tr('attach.pasteName', { t }),
    url: { create: b => URL.createObjectURL(b), revoke: u => URL.revokeObjectURL(u) },
    timers: { set: (f, ms) => setTimeout(f, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
  }));
  // §4.15 §3 a prefill replaces the box, or (append) goes on a new line under the draft; the caret lands at the end
  useEffect(() => {
    if (!p.draft) return;
    const d = p.draft;
    setValue(v => (d.append ? appendDraft(v, d.text) : d.text));
    caret.current = true;
  }, [p.draft?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // the text grows with its content up to 120 px (60 px = 3 lines with chips, CSS), then scrolls; the bar keeps its place
  // (v2.7 §4.1 the left column is hidden in Tasks: a hidden box measures 0, so it is measured again once it shows)
  const fitText = () => {
    const el = p.inputRef.current;
    if (!el?.clientWidth) return;
    el.style.height = 'auto';
    el.style.height = `${composerFrame(el.scrollHeight, el.offsetHeight - el.clientHeight).textH}px`;
  };
  useEffect(() => {
    fitText();
    const el = p.inputRef.current;
    if (el && caret.current) { caret.current = false; el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = p.inputRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let shown = el.clientWidth > 0;
    const ro = new ResizeObserver(() => { const now = el.clientWidth > 0; if (now && !shown) fitText(); shown = now; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const lane = p.target.kind === 'lane' ? p.lanes.find(l => l.name === (p.target as { name: string }).name) ?? null : null;
  // §2 anti-goal (W5): no purple accent — the Điều phối recipient is neutral, a lane takes its account colour
  const color = lane ? accountColor(p.snap.accounts, lane.account) : 'var(--fg-3)';
  const orchSt = p.orch?.state ?? 'stopped';
  // §4.10 offline: read only; §4.4 starting: locked with its reason; stopped / no account: still types (outbox)
  const locked = p.offline ? tr('inspector.ph.offline') : !lane && orchSt === 'starting' ? tr('inspector.ph.starting') : null;
  const placeholder = locked ?? (p.sel.k === 'sub' ? tr('inspector.ph.sub', { name: p.sel.lane })
    : lane?.pending ? tr('model.phPending') // v2.4 §4.5 LM2
    : lane ? tr(laneRunning(lane.state) ? 'console.ph.laneTurn' : 'console.ph.lane', { name: lane.name })
    : p.orch?.pending ? tr('model.phPending') // v2.4 §4.2 MD4b
    : p.project.held ? heldPlaceholder(tr, p.project.held) // hot fix 2026-11-16 sending resumes it
    : orchSt === 'stopped' ? tr('console.ph.orchStopped')
    : p.orch?.orchKind === 'design' ? tr(designFresh(p.orch, p.stream?.lines ?? []) ? 'console.ph.designNew' : 'console.ph.design') // §4.7 UX-I11
    : tr('console.ph.orch'));
  // hf1117-perf a session opened from Tasks lands `starting` (locked): the focus asked for then (App `focusInput`) comes on unlock
  useEffect(() => {
    const el = p.inputRef.current;
    if (!locked && el?.dataset.focusWanted) { delete el.dataset.focusWanted; el.focus(); }
  }, [locked]); // eslint-disable-line react-hooks/exhaustive-deps
  const slashOpen = !locked && !items.length && /^\/\S*$/.test(value); // §6.6 DK14 with chips the red line explains instead
  const who = lane ? lane.name : p.name;
  // §8 attachments are Mac only: no paste / drop / chip on the remote channel. DK11 a locked composer takes none.
  const drop = useMemo(() => tauriDrop(tauriGlobal()), []);
  useAttachInput({
    on: p.snap.channel === 'mac', modal: p.modal,
    locked: locked ? tr('attach.locked', { why: tr(p.offline ? 'attach.lockOffline' : 'attach.lockStarting') }) : null,
    files: (f, pasted) => run(a => a.addFiles(f, pasted)), paths: ps => run(a => a.addPaths(ps)), dirs: ns => run(a => a.addPaths([], ns)),
    toast: t => p.onError(t, p.offline ? 'wifi' : 'clock'), hover: setHover, focus: p.onFocusInput,
  }, drop);
  const gate = sendGate(value, items);

  const submit = () => {
    if (locked || !gate.ok || sending) return; // §6.3 DK4 / DK5 / DK14 Enter does nothing while the chips lock send
    const ups = gate.items.length ? gate.items : undefined, keys = items.map(a => a.key);
    // text only: cleared now; with chips: cleared on the ack, kept on an error (R21 the chip a send error names expires)
    const go = (t: Target, text: string, raw?: true) => {
      const sent = p.onSend(t, text, raw, ups);
      if (!ups) { setValue(''); void sent.catch(() => {}); return; }
      setSending(true);
      sent.then(() => { setValue(''); run(a => a.sent()); }, (e: unknown) => { const i = attachBadIndex(e); if (i !== null && keys[i] !== undefined) run(a => a.expire(keys[i]!)); })
        .finally(() => setSending(false));
    };
    if (!value.trim() && ups) return go(p.target, ''); // DK15 chips only
    const r = parseInput(tr, value, p.lanes.map(l => l.name));
    if (r.kind === 'none') return;
    if (r.kind === 'error') return p.onError(r.text);
    if (r.kind === 'local') {
      if (r.cmd === 'stop') p.onStopAsk(r.lane);
      else if (macOnlyLocal(r.cmd, p.snap.channel)) return p.onError(tr('console.macOnly'));
      else if (r.cmd === 'model') p.onModel(r.lane ?? lane?.name); // §6.6 Y45 the target's picker
      else p.onLocal(r.cmd);
      setValue('');
    } else if (r.lane) {
      const t: Target = { kind: 'lane', projectId: p.project.id, name: r.lane };
      p.onTarget(t);
      go(t, r.text, r.raw);
    } else go(p.target, r.text, r.raw);
  };
  const tip = gate.ok ? tr('console.sendTip') : tr(gate.why, gate.params);
  const toasts = hover ? document.getElementById('toasts') : null;

  return (<>
    {dropped ? <div className="aline" role="status">{tr('attach.tooMany', { n: dropped })}</div>
      : !gate.ok && gate.line ? <div className="aline bad" role="alert"><Icon n="alert" s={12} /><span>{tr(gate.line, gate.params)}</span></div> : null}
    <div className={`inrow${items.length ? ' att' : ''}${hover ? ' drop' : ''}`}>
      {slashOpen ? <div className="slash glass">{SLASH.map(([a, b]) => (
        <button type="button" key={a} onMouseDown={e => { e.preventDefault(); setValue(a === '/…' ? '/' : a.replace(' D2', ' ')); }}><code>{a}</code><span>{tr(b, { name: who })}</span></button>))}</div> : null}
      {menu ? <div className="slash glass" role="menu">
        {p.sessions.length > 1 ? p.sessions.map(o => <button type="button" key={o.sessionId ?? o.projectId} onClick={() => { if (o.sessionId) p.onView(o.sessionId); p.onTarget({ kind: 'orchestrator', projectId: p.project.id }); setMenu(false); }}>
          <code>{orchName(tr, o, true)}</code><span>{orchStateText(tr, o.state)}{o.title ? ` · ${o.title}` : ''}</span></button>)
          : <button type="button" onClick={() => { p.onTarget({ kind: 'orchestrator', projectId: p.project.id }); setMenu(false); }}><code>{p.name}</code><span>{p.orch ? orchStateText(tr, p.orch.state) : ''}</span></button>}
        {p.lanes.map(l => <button type="button" key={l.name} onClick={() => { p.onTarget({ kind: 'lane', projectId: p.project.id, name: l.name }); setMenu(false); }}>
          <code>{l.name}</code><span>{laneState(tr, l.state)}{l.task ? ` · ${l.task}` : ''}</span></button>)}
      </div> : null}
      {items.length ? <Suspense fallback={null}><AttachChips items={items} one={p.trayOne} onRemove={k => run(a => a.remove(k))} onRetry={k => run(a => a.retry(k))} /></Suspense> : null}
      <textarea id="cmd" ref={p.inputRef} rows={1} placeholder={placeholder} title={placeholder} aria-label={tr('console.inputAria')} value={value} disabled={!!locked}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          else if (e.key === 'Backspace' && !value && items.length) { e.preventDefault(); run(a => a.removeLast()); } // §6.2 T4
        }} />
      <div className="cbar">
        <button className="target" type="button" style={{ '--c': color } as CSSProperties} onClick={() => setMenu(!menu)} title={tr('console.targetTip')}>{who}<Icon n="chev" s={12} /></button>
        <button type="button" className={`send${gate.ok ? '' : ' dis'}`} disabled={!!locked} aria-disabled={!gate.ok || undefined} onClick={submit}
          title={gate.ok ? tip : undefined} data-tip={gate.ok ? undefined : tip} aria-label={gate.ok ? tr('console.send') : tip}><Icon n="send" s={14} /></button>
      </div>
    </div>
    {toasts ? createPortal(<div className="toast drop"><Icon n="clip" s={14} /><span>{tr('attach.dropTo', { name: who })}</span></div>, toasts) : null}
  </>);
}
