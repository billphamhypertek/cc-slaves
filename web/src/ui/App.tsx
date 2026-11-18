// App shell, v2.1 layout C (spec §4, §4.11b, §5.1): top bar; left column = Chờ PO + Đang xem (Inspector, composer at the
// bottom); deck area = the rest (never resizes); below 1280 px the column is one drawer. List (F9), settings (F12),
// first-run wizard (F1), empty state (F2), ⌘K palette (F22). Menus: appMenus.ts; palette / card / deck intents:
// appIntents.ts; left column content: LeftColumn.tsx.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { AccountsInfo, Command, Target } from '../../../shared/protocol.ts';
import type { QuotaRefreshAck } from '../../../shared/accounts.ts';
import type { PalAct } from '../lib/palette.ts';
import { composerFor, composerTarget, drawerNext, inboxToggle, ORCH, selLane, type DrawerEvent } from '../lib/inspector.ts';
import type { CodeKey, Mode } from '../lib/keys.ts';
import { boxCardOf, defaultFocus, isPending, orderCards, UndoQueue, visibleCards } from '../lib/cards.ts';
import { targetKey, type Store } from '../lib/store.ts';
import { errText, LangProvider, useT } from '../lib/i18n.tsx';
import { flashCard, type DeckIntent } from '../deck/actions.ts';
import { deckHeader } from '../lib/deckhead.ts';
import { rootOf, sessionsOf } from '../lib/sessions.ts';
import { hasUnseen, isArising, projectIssues } from '../lib/issues.ts';
import { goIssue, type TasksAsk, type TasksGo } from '../lib/traces.ts';
import { canRun } from '../lib/remote.ts';
import type { EngineClient } from '../lib/ws.ts';
// §8.4 first paint stays light: the v1.1 deck (SVG, spec §5.1) is its own chunk, loaded after the HUD renders. v2.7 (D88,
// review C IMPORTANT-2): Tasks, the first screen, has no left column, so it is a chunk too; one loader fetches both, so the
// Deck (the remote channel's first screen) and its left column land together.
const loadDeck = () => Promise.all([import('../deck/DeckView.tsx'), import('./LeftColumn.tsx')]);
const DeckView = lazy(() => loadDeck().then(([m]) => ({ default: m.DeckView })));
const LeftColumn = lazy(() => loadDeck().then(([, m]) => ({ default: m.LeftColumn })));
// §8.4 / spec v2.1 §5.6: dialogs, Settings, ⌘K and the "⋯" menu are not first paint either; fetched once the shell is up.
const loadModals = () => import('./AppModals.tsx');
const AppModals = lazy(() => loadModals().then(m => ({ default: m.AppModals })));
// v2.4 §6.7 the Chờ PO detail box: its own chunk, warmed with the modals (opens without a load gap)
const loadCardDetail = () => import('./CardDetail.tsx');
const CardDetail = lazy(() => loadCardDetail().then(m => ({ default: m.CardDetail })));
import { ListView } from './ListView.tsx';
import { HeadBar } from './HeadBar.tsx';
import { ModeRoots } from './ModeRoots.tsx';
import { tasksLive } from '../tasks/TasksRoot.tsx';
import type { GitHost } from '../git/GitView.tsx';
import { nodeMenuSrc } from './menuRun.ts';
import { appMenus } from './appMenus.ts';
import { boxAction, deckIntent, palRun } from './appIntents.ts';
import type { ShellCtx } from './shellCtx.ts';
import { Wizard } from './Wizard.tsx';
import { Banner, bannerShown, Boot, connLate } from './Screens.tsx';
import { TopBar } from './TopBar.tsx';
import { Icon } from './icons.tsx';
import { MdIssueContext, type MdIssueHooks } from './Markdown.tsx';
import { bootScreen, listOnAfter, modalLayer } from './shell.ts';
import { ACC0, F0, lsSet } from './appEnv.ts';
import { runLocal, type LocalCmd } from './localCmd.ts';
import { useAppState } from './useAppState.ts';
import { useSessions } from './useSessions.ts';
import { useNewCards, useStreamWatch, useSubHistory, useUnread } from './useEngineFeeds.ts';
import { useKeyMap, useShellEffects, useWindowEvents } from './useWindowHooks.ts';
import { useDone } from './useDone.ts';

const NARROW = 1280;
/** §6A: the whole app renders in `config.ui.lang`; a `config` event re-renders it in the new language at once. */
export function App(p: { store: Store; client: EngineClient }): ReactElement {
  const lang = useSyncExternalStore(p.store.subscribe, p.store.lang, p.store.lang);
  return <LangProvider lang={lang}><AppInner {...p} /></LangProvider>;
}

function AppInner({ store, client }: { store: Store; client: EngineClient }): ReactElement {
  const st = useSyncExternalStore(store.subscribe, store.shell, store.shell); // no stream slices (C3); 3rd arg: server render in tests
  const { snap, conn } = st;
  const ui = useAppState();
  const { projectId, setProjectId, sel, pick, setFold, drawerOpen, setDrawerOpen, listOn, setListOn, accOpen, setAccOpen, hoverAcc, setHoverAcc,
    fitReq, deckKeys, settingsTab, setSettingsTab, sm, setSm, palette, wizardOpen, setWizardOpen,
    wizardDismissed, setWizardDismissed, addOpen, setAddOpen, stopLane, moveAll, muted,
    setMuted, focusPick, setFocusPick, setWidth, width, now, setNow, accDlg, setAccDlg, setAccInfo, inputRef,
    sessDlg, moved } = ui;

  const tr = useT();
  const send = useCallback((c: Command) => client.send(c).catch((e: unknown) => {
    store.toast('error', errText(tr, e) || tr('common.cmdFailed'));
    throw e;
  }), [client, store, tr]);
  const rawSend = useCallback((c: Command) => client.send(c), [client]); // v2.3 §6 Git reads show their errors in place
  const undo = useMemo(() => new UndoQueue(a => { void send({ cmd: 'card_answer', id: a.id, answer: a.answer }).catch(() => {}); }), [send]);
  const [, bump] = useState(0);
  useEffect(() => undo.subscribe(() => bump(n => n + 1)), [undo]);
  useEffect(() => { void loadModals(); void loadCardDetail(); }, []); // warm: the first dialog / detail box opens without a load gap

  const narrow = width < NARROW;
  const project = snap?.projects.find(p => p.id === projectId) ?? snap?.projects[0] ?? null;
  const pid = project?.id ?? null;
  const lanes = useMemo(() => snap?.lanes.filter(l => l.projectId === pid) ?? [], [snap, pid]);
  const drawer = (e: DrawerEvent) => setDrawerOpen(o => drawerNext(o, e, window.innerWidth < NARROW));
  // v2.1 §4.14 the running sessions (deck roots) and the one Đang xem shows; the watch / composer target names it
  const ss = useSessions({ ui, snap, pid, client, tr, send, drawer }), { os, viewed, sid } = ss;
  const target: Target | null = pid ? composerTarget(sel, pid, sid) : null; // what Đang xem shows (watch / history)
  const composer: Target | null = pid ? composerFor(sel, pid, sid, lanes, ui.composerOverride) : null; // v2.3 §4.3
  const selectedLane = selLane(sel), subSel = sel.k === 'sub' ? sel.taskId : null;
  const cards = useMemo(() => visibleCards(snap?.cards ?? [], pid), [snap, pid]);
  const { pending } = orderCards(cards);
  const inUndo = undo.ids(), waiting = pending.filter(c => !inUndo.has(c.id)).length; // UX-M7: a card in its undo window is answered
  const focusId = focusPick !== null && pending.some(c => c.id === focusPick && !inUndo.has(c.id)) ? focusPick : defaultFocus(pending, inUndo);
  const offline = !!snap && conn.status !== 'open';
  // v2.4 §6.7 the detail box: closes when its card is answered elsewhere / enters its undo; a modal like the others
  const boxCard = boxCardOf(cards, ui.cardBox, inUndo);
  useEffect(() => { if (ui.cardBox && !boxCard) ui.setCardBox(null); }, [ui, boxCard]);
  const sessions = useMemo(() => (snap ? Object.fromEntries(snap.projects.map(x => [x.id, sessionsOf(snap, x.id).length])) : {}), [snap]);
  const booting = !snap || (snap.orchestrators.some(o => o.state === 'starting') && now - snap.engine.startedAt < 30_000 && snap.lanes.every(l => l.state === 'starting' || l.state === 'stopped'));
  const empty = !!snap && snap.projects.length === 0; // F2
  const showWizard = !!snap && snap.channel === 'mac' && (wizardOpen || (snap.engine.setupNeeded && !wizardDismissed));
  // F1/T10: once the first-run wizard opened itself, it stays until the PO closes it (deps turning OK mid-flow must not
  // yank it away before the orchestrator-account and Xong steps)
  useEffect(() => { if (showWizard && !wizardOpen) setWizardOpen(true); }, [showWizard, wizardOpen, setWizardOpen]);
  const selLaneV = selectedLane ? lanes.find(l => l.name === selectedLane) ?? null : null;
  const laneKey = selLaneV ? targetKey({ kind: 'lane', projectId: selLaneV.projectId, name: selLaneV.name }) : null;
  const laneSubs = laneKey ? st.subagents[laneKey] ?? [] : [];
  const sub = subSel ? laneSubs.find(x => x.taskId === subSel) ?? null : null;
  const list = listOn; // v2.1 §5.1: one full list, no side list
  const otherModal = palette || settingsTab !== null || !!sm || !!ui.wf || addOpen || !!stopLane || !!moveAll || showWizard || !!accDlg || !!sessDlg;
  const modalOpen = otherModal || !!boxCard;
  // v2 §6 A4 / K12: engine facts (shared entries, private window) while K12 or a login dialog is open
  const needInfo = sm?.tab === 'shared' || accDlg?.k === 'add' || accDlg?.k === 'relogin';
  const sharedExtra = JSON.stringify(snap?.config.sharedExtra ?? null);
  useEffect(() => {
    if (!needInfo || snap?.channel !== 'mac') return;
    client.send({ cmd: 'accounts_info' }).then(r => setAccInfo(r as AccountsInfo), () => {});
  }, [needInfo, sharedExtra, snap?.channel, client, setAccInfo]);

  // tick: undo countdown (1 s), offline banner, chip reset times (60 s)
  const fast = inUndo.size > 0 || conn.status !== 'open' || booting;
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 60_000); return () => clearInterval(t); }, [fast, setNow]);
  useEffect(() => { const f = () => setWidth(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, [setWidth]);

  const setTarget = useCallback((t: Target) => { pick(t.kind === 'lane' ? { k: 'lane', name: t.name } : ORCH); }, [pick]);

  const loadOlder = useStreamWatch(client, store, target, conn.status, ui.loadingOlder);

  useNewCards(snap, ui, store, tr, drawer);

  const { unread, pendingByProject } = useUnread(snap, pid, ui, inUndo);

  const pickProject = (id: string) => { setProjectId(id); lsSet('ccs.project', id); pick(ORCH); ss.reset(); };
  // v2.7 §4.1 Tasks · Deck · Code · Git per project (Tasks first, Mac only); the F9 list is a view of Deck: L elsewhere = Deck as the list
  const tasksOn = canRun(snap?.channel ?? null, 'spec_scan');
  const mode = ui.modeOf(pid, tasksOn), setMode = (m: Mode) => { if (pid && (m !== 'tasks' || tasksOn)) ui.setModeOf(pid, m); };
  // §4.1 the Deck mounts lazily like Code / Git: the first time it (or the F9 list) shows, then only hidden
  const [deckSeen, setDeckSeen] = useState(false);
  useEffect(() => { if (mode === 'deck' && !deckSeen) setDeckSeen(true); }, [mode, deckSeen]);
  // v2.7 §4.2 / §4.5 Deck → Tasks on a spec / issue (G4a / G4b read `go`); §4.7 IS13 Tasks → Deck on a session, composer focused
  const [tasksGo, setTasksGo] = useState<TasksGo | null>(null);
  const openTasks = (go: TasksAsk) => { if (!pid || !tasksOn) return; setMode('tasks'); setTasksGo(g => ({ ...go, n: (g?.n ?? 0) + 1 })); };
  const openTasksRef = useRef(openTasks);
  openTasksRef.current = openTasks;
  const pi = projectIssues(snap, pid);
  const issueLinks = useMemo<MdIssueHooks | null>(() => (pi && tasksOn ? {
    has: k => pi.issues.some(i => i.key === k), unseen: k => pi.issues.some(i => i.key === k && isArising(i)), open: k => openTasksRef.current(goIssue(pi, k)),
  } : null), [pi, tasksOn]);
  const toggleList = () => { const on = listOnAfter(mode, listOn); setMode('deck'); setListOn(on); lsSet('ccs.list', on ? '1' : '0'); };
  const codeKey = (k: CodeKey) => { if (!pid) return; if (k === 'quickOpen') setMode('code'); else if (mode !== 'code') return; ui.setCodeReq(r => ({ k, n: (r?.n ?? 0) + 1 })); };
  // §4.15 done lanes, collapsed trees, notification focus, "Nhờ … merge", "Chạy tiếp lane…"
  const done = useDone({ ui, store, client, tr, snap, pid, open: conn.status === 'open', os, sid, view: ss.view, drawer, pickProject });
  const selectLane = done.openLane; // the list choice stays session-only (L / the button)
  const openAccount = (email: string) => { pick({ k: 'account', email }); setListOn(false); drawer('node'); };
  // v2.3 §5.3 C8 "Nhắn D15…": the composer aimed at the lane (§4.3 override, Đang xem unchanged), the sentence filled in
  const askLane = (name: string, text: string) => { if (!pid) return; ui.ask({ kind: 'lane', projectId: pid, name }); ui.setDraft(x => ({ text, n: (x?.n ?? 0) + 1 })); drawer('focus'); };
  const focusInput = () => { // hf1117-perf a locked (starting) composer takes the focus once it unlocks (Inspector)
    drawer('focus');
    setTimeout(() => { const el = inputRef.current; if (el?.disabled) el.dataset.focusWanted = '1'; else el?.focus(); }, 0);
  };
  /** G5 for G4b (§4.7 IS13): + Spec mới / Bắt đầu build / Sửa spec acked → Deck, that session in Đang xem + the composer, focused. */
  const openSessionInDeck = (sessionId?: string) => { setMode('deck'); if (sessionId) ss.view(sessionId); focusInput(); };
  // v2.3 §6 / §4.3 the Git view's host: reads, "Nhờ …" (composer override + sentence, never `pick`), Code / VS Code
  const gitHost: GitHost | null = pid && project ? { projectId: pid, projectPath: project.path, send: rawSend, open: conn.status === 'open', offline, dataAt: st.dataAt, hidden: st.tabHidden,
    narrow, now, width, order: deckKeys.current, onCodeChanged: store.onCodeChanged, toCode: () => setMode('code'),
    setup: snap?.setup ?? null, mac: snap?.channel === 'mac', toast: t => store.toast('info', t), // hf1116 (b) git missing / blocked
    ask: (who, text) => { ui.ask(who.k === 'lane' ? { kind: 'lane', projectId: pid, name: who.name } : composerTarget(ORCH, pid, sid)); ui.setDraft(x => ({ text, n: (x?.n ?? 0) + 1, append: true })); focusInput(); },
    vscode: (src, path) => void send({ cmd: 'open_in_vscode', projectId: pid, src, path }).catch(() => {}) } : null;
  const toggleInbox = () => setFold(f => inboxToggle(f, cards)); // §4.11 Q: one line ↔ full
  const toggleMute = () => setMuted(m => { lsSet('ccs.muted', m ? '0' : '1'); store.toast('info', tr(m ? 'app.soundOn' : 'app.soundOff')); return !m; });
  const interruptT = (t: Target) => { void send({ cmd: 'interrupt', target: t }).then(() => store.toast('info', tr('app.interrupted', { who: t.kind === 'lane' ? t.name : tr('console.whoOrch') }))).catch(() => {}); };
  const interrupt = () => { if (target) interruptT(target); };
  // the split-out parts read this one bag (shellCtx.ts); `flash` runs on a click, after `setFlash` below is declared
  const c: ShellCtx = { ui, st, snap, pid, lanes, target, composer, modal: modalOpen, mode, setMode, codeKey, offline, narrow, now, tr, store, client, send, ss, done, pickProject, setTarget, focusInput, interruptT,
    drawer, openAccount, toggleList, toggleInbox, toggleMute, flash: () => setFlash(n => n + 1), openTasks };
  const accRefresh = useRef<((email: string) => void) | null>(null); // v2.7.1 MINOR-2 the ⋯ refresh asks through the panel
  const { menuItems, openMenu, openAccMenu, closeMenu, runMenu } = appMenus(c, accRefresh);

  const onLocal = (cmd: LocalCmd) => runLocal(cmd, { target, pid, snap, project, lanes, store, tr, send });

  useKeyMap(ui, { snap, showWizard, modalOpen, otherModal, boxId: boxCard?.id ?? null, offline, list, narrow, pid, lanes, pending, focusId, tr, undo, focusInput, setTarget, pickProject, interrupt,
    toggleList, toggleInbox, toggleMute, closeMenu, drawer, openHistory: () => ss.openHistory(), mode, setMode, codeKey,
    cardAct: (id, action) => { const card = cards.find(x => x.id === id); if (card) boxAction(card, action, c); } });

  const banner = bannerShown({ offline, listOn, projectId: pid, late: connLate(conn, now) });
  useShellEffects({ narrow, drawerOpen, offline, banner, width, accShown: accOpen && !list && mode === 'deck', leftCol: mode !== 'tasks' }, st.toasts, store);

  useSubHistory(client, ui, sub, selLaneV);
  // v2.7 G4-0 ⑥ a notification click / an external select that targets a lane, a session or a card shows the Deck (never Tasks)
  const deckFor = (id: string | null) => { if (id && ui.modeOf(id, tasksOn) === 'tasks') ui.setModeOf(id, 'deck'); };
  useWindowEvents(d => { if (d.account) openAccount(d.account); else if (d.lane && pid) { deckFor(pid); selectLane(pid, d.lane); } }, t => {
    deckFor(t.projectId ?? pid);
    if (t.projectId || t.lane) return done.focus(t); // §4.15 §4 the notification's own target
    const open = (snap?.cards ?? []).filter(isPending);
    const c = open.find(x => x.id === t.cardId) ?? [...open].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!c) return;
    setFocusPick(c.id); setFold({ folded: false, resolvedOpen: false }); drawer('card');
  });
  // v1.1 §4.4 / U6: a deck card → its Chờ anh card is focused, the box opens if closed, the card glows 1.2 s
  const [flash, setFlash] = useState(0);
  useEffect(() => { if (flash) flashCard(document); }, [flash]);
  const runPal = (a: PalAct) => palRun(a, c, runMenu);
  const onDeck = (i: DeckIntent) => deckIntent(i, c);
  // dev frames F8 / F25: select D2 (and its first subagent) once the snapshot is in
  useEffect(() => { if ((F0 === 'F8' || F0 === 'F25') && pid && !selectedLane) setTarget({ kind: 'lane', projectId: pid, name: 'D2' }); }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (F0 === 'F25' && laneSubs[0] && !subSel) pick({ k: 'sub', lane: 'D2', taskId: laneSubs[0].taskId }); }, [laneSubs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // §4.6 "Đang khởi động": with a snapshot the deck itself shows the boot (orchestrator / lanes `starting`)
  if (bootScreen(snap)) return <><div id="map" className="map" /><Boot snap={snap} conn={conn} /></>;

  // v2.1 §4.8 / v2.3 §4.1 the one deck header bar (Deck, F9 list, Code, Git): switch + stats
  const head = deckHeader({ snap, projectId: pid, roots: os.length, tr, pi, subagents: Object.fromEntries(Object.entries(st.subagents)
    .filter(([k]) => k.startsWith(`l:${pid}:`)).map(([k, v]) => [k.slice(`l:${pid}:`.length), v])) });
  const deckOff = listOn || mode !== 'deck'; // §10.1 hidden like the F9 list does: visibility hidden + paused, never unmounted

  return (
    <>
      {/* §4 layout C left column: Chờ PO on top, Đang xem below (composer at its bottom); first in the DOM = first in the
          §4.11 Tab order (position:fixed, z 12 over the deck) */}
      {/* v2.7 §4.1 (D88) the Tasks tab has no left column: hidden, never unmounted (the composer draft stays) */}
      <div id="left" hidden={mode === 'tasks' || undefined} aria-hidden={narrow && !drawerOpen ? true : undefined}>
        <MdIssueContext.Provider value={issueLinks}><Suspense fallback={null}>
          <LeftColumn c={c} project={project} empty={empty} cards={cards} focusId={focusId} undo={undo} laneKey={laneKey} sub={sub} sessions={sessions} onLocal={onLocal}
            loadOlder={loadOlder} openMenu={openMenu} />
        </Suspense></MdIssueContext.Provider>
      </div>
      <div style={{ display: 'contents', visibility: deckOff ? 'hidden' : undefined }}>
        {deckSeen ? <Suspense fallback={<div id="map" className="map" />}>
          <DeckView store={store} projectId={pid} selected={selectedLane} selectedSub={subSel} viewed={sel.k === 'session' ? null : viewed ? rootOf(viewed) : undefined} onIntent={onDeck} onKeys={(k, h) => { deckKeys.current = k; ui.deckHidden.current = h; }}
            onMenu={(id, el) => { if (pid) openMenu(nodeMenuSrc(id, pid, snap), el, true); }}
            reducedSetting={snap.config.reducedMotion === true} paused={deckOff} fitReq={fitReq}
            hoverAccount={hoverAcc?.from === 'row' ? hoverAcc.email : null} onLaneHover={email => setHoverAcc(email ? { email, from: 'lane' } : null)}
            accPanel={{ open: accOpen, onToggle: () => setAccOpen(o => !o), hold: modalOpen,
              onAdd: () => setAccDlg({ k: 'add' }), onRelogin: email => setAccDlg({ k: 'relogin', email }),
              onCfg: () => setSm({ tab: 'shared' }), // v2.2 §6 the config-error chip opens K12
              onSelectAccount: openAccount, onMenu: (email, el) => openMenu({ k: 'account', email }, el, true),
              onCancelLogin: () => void send({ cmd: 'account_login_cancel' }).catch(() => {}),
              refreshRef: accRefresh, onRefresh: email => send({ cmd: 'quota_refresh', ...(email ? { account: email } : {}) }).then(r => r as QuotaRefreshAck, () => null),
              hoverEmail: hoverAcc?.from === 'lane' ? hoverAcc.email : null, onHover: email => setHoverAcc(email ? { email, from: 'row' } : null), initialReadyOpen: ACC0 === 'ready' }} />
        </Suspense> : <div id="map" className="map" />}
      </div>
      {project && !empty ? <ModeRoots mode={mode} sel={sel} lanes={lanes} orchestrators={snap?.orchestrators ?? []} project={project} narrow={narrow} rawSend={rawSend} send={send}
        codeReq={ui.codeReq} codeApi={ui.codeApi} codeEv={st.codeEv} askLane={askLane} git={gitHost}
        offline={offline} dataAt={st.dataAt}
        tasks={tasksOn ? { project: { name: project.name }, pi: projectIssues(snap, project.id), live: tasksLive(snap, project.id), toDeck: openSessionInDeck, start: ss.start, toCode: () => setMode('code'), go: tasksGo,
          openWorkflows: id => ui.setWf(id ? { id } : {}) } : null} /> : null}
      <div id="hud">
        {banner ? <Banner conn={conn} dataAt={st.dataAt} now={now} deckShown={!deckOff && !!pid}
          onRestart={() => { const w = window as { __CC_RESTART_ENGINE__?: () => void }; if (w.__CC_RESTART_ENGINE__) w.__CC_RESTART_ENGINE__(); else client.retryNow(); }} /> : null}
        {/* v2.2 §14.4 the app updated under this open page (another protocol): no stale `partial`, one way out */}
        {st.protocolMismatch ? <div id="reloadBand" role="alert"><span>{tr('stream.reload')}</span>
          <button type="button" className="btn sm pri" onClick={() => location.reload()}>{tr('stream.reloadBtn')}</button></div> : null}
        <TopBar snap={snap} offline={offline} projectId={pid} pendingByProject={pendingByProject} unread={unread} muted={muted} listOn={listOn && mode === 'deck'}
          onProject={pickProject} onAddProject={() => setAddOpen(true)} onList={toggleList}
          onRemote={() => setSettingsTab('remote')} onMute={toggleMute} onSettings={() => setSettingsTab(t => (t ? null : 'proj'))} onSkillsMcp={tab => setSm({ tab })}
          onTabMenu={(id, el, at) => openMenu({ k: 'project', id }, el, false, at ?? undefined)} />
        {head.parts.length ? <HeadBar head={head} mode={mode} onMode={setMode} tasks={tasksOn} unseen={hasUnseen(snap, pid)} onTasks={openTasks} /> : null}
        {list && !empty && mode === 'deck' ? <ListView snap={snap} projectId={pid} selected={selectedLane} onLane={(p, n) => selectLane(p, n, true)} onMenu={(projectId, name, el) => openMenu({ k: 'lane', projectId, name }, el, false)} /> : null}
        {/* §4.10 narrow: "Chờ PO n" at the deck header bar's right end (replaces the v1 floating button); "Đóng ngăn" while open */}
        {narrow && !empty && mode !== 'tasks' ? <button id="inboxBtn" type="button" onClick={() => drawer('button')} aria-expanded={drawerOpen}>
          {drawerOpen ? tr('inspector.inbox.drawerClose') : <>{tr('inbox.title')} <span className={`cnt ${waiting ? '' : 'zero'}`}>{waiting}</span></>}</button> : null}
      </div>
      {boxCard ? <Suspense fallback={null}><CardDetail c={boxCard} channel={snap.channel} offline={offline} sessions={(boxCard.projectId ? sessions[boxCard.projectId] : undefined) ?? 1}
        projectName={snap.projects.find(x => x.id === boxCard.projectId)?.name} onClose={() => ui.setCardBox(null)} onAction={a => boxAction(boxCard, a, c)}
        onChoose={(label, answer) => { ui.setCardBox(null); undo.choose(boxCard.id, label, answer); }} /></Suspense> : null}
      {showWizard ? <div id="screen"><Wizard initialStep={F0 === 'F1d' ? 4 : F0 === 'F1e' ? 5 : undefined} setup={snap.setup} snap={snap} installs={st.installs} send={send}
        onAccDlg={setAccDlg} onAccMenu={openAccMenu} toast={t => store.toast('info', t)}
        onClose={() => { setWizardOpen(false); setWizardDismissed(true); }}
        onAddProject={() => { setWizardOpen(false); setWizardDismissed(true); setAddOpen(true); }} /></div> : null}
      {modalLayer(ui) ? <Suspense fallback={null}>
        <AppModals ui={ui} snap={snap} pid={pid} selectedLane={selectedLane} offline={offline} connected={conn.status === 'open'} send={send} client={client} store={store}
          runPal={runPal} menuItems={menuItems} runMenu={runMenu} closeMenu={closeMenu} openAccMenu={openAccMenu}
          sessionsUi={{ os, viewSid: sid, onPick: ss.pick, onStarted: ss.started, reload: ss.load, loadPreview: ss.loadPreview,
            onAccounts: () => { setMode('deck'); setListOn(false); lsSet('ccs.list', '0'); setAccOpen(true); } }} /></Suspense> : null}
      {/* R-I1 outside #hud (a fixed box = its own stacking context) and after the modals: a toast shows above every sheet */}
      <div id="toasts">{moved ? <div className="toast"><span>{moved.text}</span><button type="button" className="lnk" onClick={ss.undoMove}>{tr('session.undo')}</button></div>
        : st.toasts.slice(0, 1).map(t => <div key={t.id} className={`toast${t.icon ? ` ic ${t.level}` : ''}`}>{t.icon ? <Icon n={t.icon} s={14} /> : t.level === 'error' ? <Icon n="alert" /> : null}<span>{t.text}</span></div>)}</div>
    </>
  );
}
