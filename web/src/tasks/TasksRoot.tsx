// v2.7 §4.3 the Tasks tab root (D87 layout B, D88 no left column, D91 the first screen): the three regions — spec rail 240 ·
// issue list · detail 400 (only while an issue is open) — and the states of §6: IS8 nothing yet, IS8b loading (the first
// `spec_scan` of the project not answered and no data), IS8c engine unreachable (band, dimmed, engine buttons locked, the
// last data readable). Mounted at once by ModeRoots (Mac channel only, §8); hidden (`visibility`), never unmounted.
// The regions: the rail (`SpecRail`), the list (`IssueList`) or the spec card (`SpecCard`, draft / approved), the issue
// detail (`IssueDetail`) or the spec overview (`SpecOverview`, active / done with no issue open; narrow: overlay on the spec
// name). §5.6 seen-on-leave, the narrow window (< 1100 px, IS10: rail → menu, detail → overlay), the D99 Esc ladder (an open
// popover first), IS5b `askCancel` from the Deck card, the Deck traces (`go`). Every region reads `TasksCtx` (tasks-ctx.ts).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { capReached, type ProjectIssues } from '../../../shared/issues.ts';
import type { Command, OrchestratorView, Snapshot } from '../../../shared/protocol.ts';
import { fmtHm } from '../lib/format.ts';
import { useT, WfNames } from '../lib/i18n.tsx';
import { railSlots, wfNames } from '../lib/wf-tasks.ts';
import { issueCmds, readTasksUi, writeTasksUi, type SpecSel, type TasksUi } from '../lib/issues.ts';
import type { StartReq } from '../lib/start.ts';
import { goPatch, type TasksGo } from '../lib/traces.ts';
import { Icon } from '../ui/icons.tsx';
import { onAskCancel } from './CancelPop.tsx';
import { EmptyStart } from './EmptyStart.tsx';
import { quotaAtOf, seenOnLeave } from './IssueDetail.model.ts';
import { IssueDetail } from './IssueDetail.tsx';
import { effectiveSel, isNarrowTasks, specOfSel } from './IssueList.model.ts';
import { IssueList } from './IssueList.tsx';
import { SpecCard } from './SpecCard.tsx';
import { SpecOverview } from './SpecOverview.tsx';
import { SpecRail } from './SpecRail.tsx';
import type { TasksCtx, TasksLive, TasksLiveIn } from './tasks-ctx.ts';
import { useWfDocs } from './useWfDocs.ts';
import './tasks.css';
import './spec-card.css';

export interface TasksRootProps {
  shown: boolean;
  /** `path` = the project root (absolute) */
  project: { id: string; name: string; path: string };
  /** the project's running orchestrator sessions (R34 cap, Tới phiên / Mở phiên) */
  sessions: readonly OrchestratorView[];
  /** the project's specs + issues (`Snapshot.issues`); null = none in this snapshot */
  pi: ProjectIssues | null;
  /** the engine is unreachable (IS8c) and the time of the data on screen */
  offline: boolean; dataAt: number | null;
  /** the toasting `send` (engine refusals show as a toast) */
  send: (c: Command) => Promise<unknown>;
  /** §4.1 to Deck, Đang xem on that orchestrator session when given (+ Spec mới, Bắt đầu build, Xem trên Deck) */
  toDeck: (sessionId?: string) => void;
  /** v2.7.1 §4.1 the start dialog / step list (`useSessions().start`) */
  start: (req: StartReq) => void;
  /** §4.10 to the Code tab (Tài liệu `.md` / images) */
  toCode: () => void;
  /** the live rows the list / detail read beyond issues (`tasksLive`) */
  live: TasksLiveIn;
  /** a Deck trace asked for this (§4.2 strip / chip / card, §4.5 chat key): spec, issue, `arising` (IS3b) applied here */
  go?: TasksGo | null;
  /** v2.9 §4.1 the chip's "Sửa / Xem quy trình này", "Quản lý quy trình…": the Quy trình screen on that id (null = the library) */
  openWorkflows: (id: string | null) => void;
}

/** The snapshot parts the regions read: the project's lanes (account, quota), accounts, open cards and the IS16 import notice. */
export function tasksLive(snap: Snapshot | null, pid: string): TasksLiveIn {
  const proj = snap?.projects.find(p => p.id === pid);
  return {
    lanes: snap?.lanes.filter(l => l.projectId === pid) ?? [], accounts: snap?.accounts ?? [],
    cards: snap?.cards.filter(c => c.projectId === pid && c.status === 'open') ?? [],
    importNotice: proj?.specsImported ?? null,
    wf: { id: proj?.workflow ?? null, rows: snap?.workflows ?? [], fallback: fallbackOf(proj?.workflowFallback ?? null, snap) },
  };
}
/** hf-sp the reason line shows until the plugin is installed and on for lanes, like the engine's firstOff (an unknown
 *  plugin list keeps it). */
function fallbackOf(plugin: string | null, snap: Snapshot | null): string | null {
  const installed = snap?.skillsMcp?.skills.plugins.filter(x => x.forLanes).map(x => x.key.split('@')[0]) ?? [];
  return plugin !== null && !installed.includes(plugin) ? plugin : null;
}
/** §6 IS10 the window width class, live. */
function useNarrow(): boolean {
  const [n, setN] = useState(() => typeof window !== 'undefined' && isNarrowTasks(window.innerWidth));
  useEffect(() => {
    const on = () => setN(isNarrowTasks(window.innerWidth));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return n;
}

const seen = (send: (c: Command) => Promise<unknown>, pid: string, k: string | null) => { if (k) void issueCmds(send, pid).seen(k).catch(() => {}); };
/** §5.6 R19 `issue_seen` when the PO leaves an issue he opened (another issue, another project, the tab hidden, the app
 *  closing) — never when it opens. */
function useSeenOnLeave(open: { pid: string; key: string | null }, pi: ProjectIssues | null, send: (c: Command) => Promise<unknown>): void {
  const prev = useRef<{ pid: string; key: string | null; issues: ProjectIssues['issues'] }>({ pid: open.pid, key: null, issues: [] });
  useEffect(() => {
    const was = prev.current;
    const k = seenOnLeave(was.key, was.pid === open.pid ? open.key : null, was.pid === open.pid ? pi?.issues ?? was.issues : was.issues);
    seen(send, was.pid, k);
    prev.current = { pid: open.pid, key: open.key, issues: pi?.issues ?? [] };
  }, [open.pid, open.key, pi, send]);
  useEffect(() => {
    const bye = () => { const w = prev.current; seen(send, w.pid, seenOnLeave(w.key, null, w.issues)); };
    window.addEventListener('beforeunload', bye);
    return () => window.removeEventListener('beforeunload', bye);
  }, [send]);
}

const store = (): Pick<Storage, 'getItem' | 'setItem'> | null => globalThis.localStorage ?? null;

export function TasksRoot(p: TasksRootProps): ReactElement {
  const tr = useT();
  const pid = p.project.id;
  const cmds = useMemo(() => issueCmds(p.send, pid), [p.send, pid]);
  const [scanned, setScanned] = useState<Readonly<Record<string, boolean>>>({});
  const [ui, setUiState] = useState<{ pid: string; v: TasksUi }>(() => ({ pid, v: readTasksUi(store(), pid) }));
  const cur = ui.pid === pid ? ui.v : readTasksUi(store(), pid);
  const setUi = (patch: Partial<TasksUi>) => {
    const v = { ...cur, ...patch };
    writeTasksUi(store(), pid, v);
    setUiState({ pid, v });
  };
  // a Deck trace: its spec / issue becomes the tab's choice (remembered like a click); the issues_new card with ≥ 2 unseen
  // filters the list to Phát sinh (IS3b, `arising`), any other trace clears that filter
  const goN = p.go?.n;
  useEffect(() => {
    const g = p.go;
    if (!g) return;
    setUi(goPatch(g));
  }, [goN]); // eslint-disable-line react-hooks/exhaustive-deps
  // R-B12 every time the tab opens (and on reconnect while open): the engine looks for new / moved spec files
  useEffect(() => {
    if (!p.shown || p.offline) return;
    const done = () => setScanned(s => (s[pid] ? s : { ...s, [pid]: true }));
    cmds.specScan().then(done, done);
  }, [p.shown, p.offline, pid, cmds]);

  // v2.9 §4.7 the revs the tab reads: the project's workflow now + the rev each open spec is pinned to
  const curRev = p.live.wf.rows.find(r => r.id === p.live.wf.id)?.rev ?? null;
  const revs = [...(curRev ? [curRev] : []), ...(p.pi?.specs.filter(s => s.state !== 'done').map(s => s.workflowRev) ?? [])];
  const wfRead = useWfDocs(p.send, revs, !p.offline);
  const wfCur = curRev ? wfRead.docs.get(curRev) ?? null : null;
  const names = useMemo(() => (wfCur ? wfNames(wfCur) : null), [wfCur]);
  // hf1117-perf a project with nothing to list shows IS8 at once; only its pack button / hint wait for the rev read
  const wfWait = curRev !== null && !wfCur && wfRead.loading;
  const noItems = !p.pi || (!p.pi.specs.length && !p.pi.issues.length);
  const loading = (!p.pi && !scanned[pid]) || (wfWait && !noItems);
  const empty = !loading && noItems;
  const start: TasksCtx['start'] = (r, direct) => p.start({ ...r, projectId: pid, direct, opened: sid => p.toDeck(sid) });
  const narrow = useNarrow();
  const [overlay, setOverlay] = useState(false);
  const [ask, setAsk] = useState<TasksCtx['ask']>(null);
  const pop = useRef<(() => void) | null>(null);
  const setPop = useCallback((f: (() => void) | null) => { pop.current = f; }, []);
  // IS5b "Huỷ cả hai…" (the Deck card, the detail's conflict strip): open the last key's detail with IS4 for every key
  const setUiRef = useRef(setUi);
  setUiRef.current = setUi;
  useEffect(() => onAskCancel((to, keys) => {
    if (to !== pid || !keys.length) return;
    setUiRef.current({ issue: keys[keys.length - 1]! });
    setAsk(a => ({ keys, n: (a?.n ?? 0) + 1 }));
  }), [pid]);
  // D99 Esc: an open popover first, then the open issue / overlay → the spec overview (narrow: closed; the shell's Esc never sees it)
  const escRef = useRef<() => boolean>(() => false);
  escRef.current = () => {
    if (pop.current) { pop.current(); return true; }
    if (cur.issue !== null || overlay) { setUi({ issue: null }); setOverlay(false); return true; }
    return false;
  };
  useEffect(() => {
    if (!p.shown) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && escRef.current()) { e.preventDefault(); e.stopImmediatePropagation(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [p.shown]);
  const capFull = capReached(p.sessions.map(o => o.orchKind ?? 'general'), 'design');
  const live = useMemo<TasksLive>(() => ({ ...p.live, quotaAt: quotaAtOf(p.live.lanes, p.live.accounts) }), [p.live]);
  const ctx: TasksCtx | null = p.pi ? {
    project: p.project, pi: p.pi, ui: cur, setUi, cmds, locked: p.offline, capFull, sessions: p.sessions, narrow, toDeck: p.toDeck, toCode: p.toCode,
    start, ask, setPop, live, send: p.send, now: Date.now(),
    wf: { id: p.live.wf.id, rows: p.live.wf.rows, cur: wfCur, docs: wfRead.docs, slots: railSlots(tr, wfCur, wfRead.docs), openWorkflows: p.openWorkflows, fallback: p.live.wf.fallback },
  } : null;
  useSeenOnLeave({ pid, key: p.shown && p.pi ? cur.issue : null }, p.pi, p.send);

  return (<WfNames names={names}>
    <div id="tasks" className={`tsk${p.offline ? ' dim' : ''}`} role="region" aria-label={tr('tasks.aria')}
      style={{ visibility: p.shown ? undefined : 'hidden' }} aria-hidden={p.shown ? undefined : true} aria-busy={loading || undefined}>
      {p.offline ? <div className="toff" role="status"><Icon n="wifi" s={13} />{tr('tasks.offline', { hm: p.dataAt ? fmtHm(p.dataAt) : '—' })}</div> : null}
      {loading ? <Skeleton label={tr('tasks.loading')} />
        : empty || !ctx ? (
          <EmptyStart c={ctx} wait={wfWait} off={p.offline ? tr('tasks.locked') : null}
            onStart={() => start({ kind: 'new' }, true)} onPick={() => start({ kind: 'new' }, false)} />
        ) : <Regions c={ctx} overlay={overlay} setOverlay={setOverlay} />}
    </div>
  </WfNames>);
}

/** §4.3 the three regions. Middle: the issue list (building / done spec, Ngoài spec) or the spec card (draft / approved).
 *  Right: the open issue, else the overview of a building / done spec (none for Ngoài spec). Narrow: no rail (menu in the
 *  list head), the right side is an overlay only while an issue (or, on the spec name, the overview) is open. */
function Regions({ c, overlay, setOverlay }: { c: TasksCtx; overlay: boolean; setOverlay: (o: boolean) => void }): ReactElement {
  const tr = useT();
  const sel: SpecSel | null = effectiveSel(c.pi, c.ui.sel);
  const spec = sel ? specOfSel(c.pi, sel) : null;
  const card = spec !== null && (spec.state === 'draft' || spec.state === 'approved') ? spec : null;
  const issue = c.ui.issue ? c.pi.issues.find(i => i.key === c.ui.issue) ?? null : null;
  // IS3b the Phát sinh filter: no issue picked yet, the list takes the detail's room (no overview)
  const overview = !issue && !card && spec !== null && !c.ui.arising && (!c.narrow || overlay);
  const pick = (s: SpecSel) => { setOverlay(false); c.setUi({ sel: s, issue: null, arising: false }); };
  const back = () => { setOverlay(c.narrow); c.setUi({ issue: null }); };
  const close = () => { setOverlay(false); c.setUi({ issue: null }); };
  const side = issue !== null || overview;
  const specDoc = spec ? c.wf.docs.get(spec.workflowRev) : undefined; // v2.9 §6.1 the words of the spec's own rev
  const specNames = useMemo(() => (specDoc ? wfNames(specDoc) : null), [specDoc]);
  const curNames = useMemo(() => (c.wf.cur ? wfNames(c.wf.cur) : null), [c.wf.cur]); // the rail: the project's workflow now
  return (<WfNames names={specNames}>
    <div className={`tgrid${c.narrow ? ' nw' : side ? '' : ' nod'}`}>
      {c.narrow ? null : <WfNames names={curNames}><aside className="trail" aria-label={tr('tasks.region.rail')}><SpecRail c={c} sel={sel} pick={pick} /></aside></WfNames>}
      {sel === null ? <section className="tlist" aria-label={tr('tasks.region.list')} />
        : card ? <section className="tmid" aria-label={tr('tasks.region.list')}><SpecCard key={card.id} c={c} spec={card} /></section>
          : <IssueList c={c} sel={sel} open={issue?.key ?? null} side={side} onSpecName={back} />}
      {issue ? <IssueDetail c={c} issue={issue} onClose={close} />
        : overview && spec ? <aside className={`tdet${c.narrow ? ' ov' : ''}`} aria-label={tr('tasks.region.detail')}><SpecOverview c={c} spec={spec} /></aside> : null}
    </div>
  </WfNames>);
}

const RAIL = [1, 2, 1, 3], LIST = [3, 1, 5];
/** IS8b the three regions at their real size, bars only. */
function Skeleton({ label }: { label: string }): ReactElement {
  const bar = (w: number | string, k?: string | number) => <span key={k} className="sk" style={{ width: w }} />;
  return (
    <div className="tgrid" role="status" aria-label={label}>
      <div className="trail">
        <div className="skh">{bar(70)}<span className="sk" style={{ width: 80, height: 24, borderRadius: 6 }} /></div>
        {RAIL.map((n, g) => <div key={g}><div className="skg">{bar(70)}</div>
          {Array.from({ length: n }, (_, i) => <div key={i} className="skr">{bar(130)}{bar(28)}</div>)}</div>)}
      </div>
      <div className="tlist">
        <div className="skh">{bar(150)}<span className="sk" style={{ width: 140, height: 5, marginRight: 'auto' }} /></div>
        {LIST.map((n, g) => <div key={g}><div className="skb">{bar(80)}</div>
          {Array.from({ length: n }, (_, i) => <div key={i} className="ski">{bar(14)}{bar(36)}<span className="sk" style={{ flex: 1, maxWidth: 320 - (i % 3) * 60 }} />{bar(70)}</div>)}</div>)}
      </div>
      <div className="tdet skd">
        <div className="skg">{bar(120)}</div>
        {bar('85%')}
        {Array.from({ length: 5 }, (_, i) => <div key={i} className="skp">{bar(80)}{bar(150)}</div>)}
        {bar('90%')}{bar('70%')}
      </div>
    </div>
  );
}
