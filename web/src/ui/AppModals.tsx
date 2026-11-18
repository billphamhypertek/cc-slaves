// The shell's modal layer: ⌘K palette (F22), stop / move-all lane dialogs, add project, Settings (F12), the "⋯" action
// menu (§4.12) and the v2 §6 account dialogs that stack over Settings / the wizard (G4 UX M5).
import { lazy, Suspense, type ReactElement } from 'react';
import type { Command, OrchestratorView, ResumePreview, SessionRowView, Snapshot } from '../../../shared/protocol.ts';
import { isActiveLane, lanesOn } from '../lib/accounts.ts';
import { projectIssues } from '../lib/issues.ts';
import type { MenuAct, MenuItem } from '../lib/actions.ts';
import { shortEmail } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { stopSub } from '../lib/labels.ts';
import { buildItems, laneRows, type PalAct, type PalCtx } from '../lib/palette.ts';
import { targetKey, type Store } from '../lib/store.ts';
import { hasTauri } from '../lib/tauri.ts';
import type { EngineClient } from '../lib/ws.ts';
import { ConfirmDialog, LoginDialog, MergeDialog } from './Accounts.tsx';
// the wizard's account step loads the account list through this chunk (one lazy chunk for every account screen)
export { AccountsTab } from './Accounts.tsx';
import { ActionMenu } from './ActionMenu.tsx';
import { AddProjectDialog } from './AddProjectDialog.tsx';
import { F0 } from './appEnv.ts';
import { MoveAllDialog, StopDialog } from './LaneDialogs.tsx';
import type { MenuSrc } from './menuRun.ts';
import { Palette } from './Palette.tsx';
import { Settings } from './Settings.tsx';
import type { AppState } from './useAppState.ts';
import { addSteps, useAddProject } from './useAddProject.ts';

// v2.1 §4.14 the session dialogs + history list: their own lazy chunk
const loadSess = () => import('./SessionDialogs.tsx');
const SessionDialogs = lazy(() => loadSess().then(m => ({ default: m.SessionDialogs })));
const SessionList = lazy(() => loadSess().then(m => ({ default: m.SessionList })));
// v2.2 §6 the Skills & MCP sheet: its own lazy chunk (with the `skillsMcp` catalog namespace)
const SkillsMcp = lazy(() => import('./SkillsMcp.tsx').then(m => ({ default: m.SkillsMcp })));
const WorkflowScreen = lazy(() => import('../workflow/WorkflowScreen.tsx').then(m => ({ default: m.WorkflowScreen })));

/** what App hands the §4.14 session layer. */
export interface SessionsUi {
  os: OrchestratorView[]; viewSid: string | null;
  onPick: (r: SessionRowView) => void; onStarted: (v: OrchestratorView) => void; reload: () => void;
  loadPreview: (sessionId: string) => Promise<ResumePreview | null>;
  /** v2.7.1 §4.1 SA4 "Mở bảng Account": Deck with the Account panel open */
  onAccounts: () => void;
}

export interface AppModalsProps {
  ui: AppState; snap: Snapshot; pid: string | null; selectedLane: string | null; offline: boolean; connected: boolean;
  send: (c: Command) => Promise<unknown>; client: EngineClient; store: Store;
  runPal: (a: PalAct) => void; menuItems: (src: MenuSrc) => MenuItem[]; runMenu: (m: MenuAct) => void; closeMenu: (refocus: boolean) => void;
  sessionsUi: SessionsUi;
  /** §4.12 Settings › Account row "⋯" → the same account menu as the deck / Inspector. */
  openAccMenu: (email: string, anchor: Element) => void;
}

export function AppModals({ ui, snap, pid, selectedLane, offline, connected, send, client, store, runPal, menuItems, runMenu, closeMenu, sessionsUi, openAccMenu }: AppModalsProps): ReactElement {
  const tr = useT();
  const { settingsTab, setSettingsTab, addOpen, setAddOpen, stopLane, setStopLane, moveAll, setMoveAll, palette, setPalette, accDlg, setAccDlg,
    deckKeys, deckHidden, now, sm, setSm, smEsc, wf, setWf, setWizardOpen, accInfo, menu, accEsc, sessDlg, setSessDlg, histAt, setHistAt, sessions } = ui;
  /** §4.12 N2-e "task · đang chạy n subagent" of the lane being stopped. */
  const stopSubOf = (k: { projectId: string; name: string }) => {
    const l = snap.lanes.find(x => x.projectId === k.projectId && x.name === k.name);
    const subs = store.get().subagents[targetKey({ kind: 'lane', ...k })] ?? [];
    return l ? stopSub(tr, l, subs.filter(s => s.status === 'running').length) : null;
  };
  const palCtx: PalCtx = { projectId: pid, selectedLane, keys: deckKeys.current, hidden: deckHidden.current, offline, tauri: hasTauri() };
  const add = useAddProject({ open: addOpen, done: () => setAddOpen(false), select: ui.setProjectId, snap, send: c => client.send(c), store, esc: ui.addEsc });
  return (
    <>
      {wf ? <Suspense fallback={null}><WorkflowScreen snap={snap} connected={connected} openId={wf.id} send={c => client.send(c)}
        toast={(level, text) => store.toast(level, text)} onClose={() => setWf(null)} /></Suspense> : null}
      {settingsTab || stopLane || moveAll || palette || sm ? <div id="modal" onMouseDown={e => { if (e.target === e.currentTarget && !accDlg) { setPalette(false); setStopLane(null); setMoveAll(null); } }}>
        {palette ? <Palette items={buildItems(tr, snap, palCtx)} laneRows={(p, n) => laneRows(tr, snap, palCtx, p, n)} onRun={runPal} onClose={() => setPalette(false)} initial={F0 === 'F22' ? 'd2' : ''} />
          : stopLane ? <StopDialog lane={stopLane.name} sub={stopSubOf(stopLane)} onClose={() => setStopLane(null)} onPick={mode => { void send({ cmd: 'lane_stop', projectId: stopLane.projectId, name: stopLane.name, mode }).catch(() => {}); setStopLane(null); }} />
          : moveAll ? <MoveAllDialog account={moveAll} lanes={lanesOn(moveAll, snap.lanes).filter(isActiveLane)} onClose={() => setMoveAll(null)}
            onYes={() => { lanesOn(moveAll, snap.lanes).filter(isActiveLane).forEach(l => void send({ cmd: 'lane_switch_account', projectId: l.projectId, name: l.name, account: null }).catch(() => {})); setMoveAll(null); }} />
          : settingsTab ? <Settings snap={snap} pid={pid} tab={settingsTab} connected={connected} now={now}
            onTab={t => { if (t === 'wf') { setSettingsTab(null); setWf({}); } else setSettingsTab(t); }} onClose={() => setSettingsTab(null)} send={send} onCfg={() => { setSettingsTab(null); setSm({ tab: 'shared' }); }}
            onAddProject={() => { setSettingsTab(null); setAddOpen(true); }} onSetup={() => { setSettingsTab(null); setWizardOpen(true); }}
            onAccDlg={setAccDlg} onAccMenu={openAccMenu} toast={t => store.toast('info', t)} />
          : sm ? <Suspense fallback={null}><SkillsMcp snap={snap} open={sm} connected={connected} onTab={tab => setSm({ tab })} onClose={() => setSm(null)}
            send={send} toast={t => store.toast('info', t)} escRef={smEsc}
            accInfo={accInfo} onMerge={(email, name, cardId) => setAccDlg({ k: 'merge', email, name, cardId })}
            onProjects={() => { setSm(null); setSettingsTab('proj'); }} /></Suspense> : null}
      </div> : null}
      {add.run ? <div id="modal"><AddProjectDialog steps={addSteps(add.run, tr)} onClose={add.close} /></div> : null}
      {menu ? <ActionMenu items={menuItems(menu.src)} label={menu.src.k === 'project' ? tr('menu.projectAria', { name: snap.projects.find(x => x.id === (menu.src as { id: string }).id)?.name ?? '' }) : tr('menu.aria', { name: menu.src.k === 'lane' ? menu.src.name : menu.src.k === 'account' ? shortEmail(menu.src.email) : menu.src.k === 'sub' ? menu.src.lane : tr('common.role.orchestrator') })}
        anchor={menu.anchor} area={menu.area} leaving={menu.leaving} onRun={a => { closeMenu(false); runMenu(a); }} onClose={closeMenu} /> : null}
      {/* v2.7.1 §4.1 a start (choice or steps) closes on Đóng / Huỷ / Esc only: the 2nd click of a double-click on a split button lands on
          this backdrop and must not drop the step list (R-B19) */}
      {sessDlg ? <div id="modal" onMouseDown={e => { if (e.target === e.currentTarget && sessDlg.k !== 'start') setSessDlg(null); }}><Suspense fallback={null}>
        <SessionDialogs dlg={sessDlg} os={sessionsUi.os} list={sessions} projectName={snap.projects.find(x => x.id === pid)?.name ?? ''} accounts={snap.accounts}
          lanes={snap.lanes} cards={snap.cards} offline={offline} now={now} prevSid={sessionsUi.viewSid} send={send} sendQuiet={c => client.send(c)} loadPreview={sessionsUi.loadPreview}
          loadModels={(projectId, accountId) => client.send({ cmd: 'session_models', projectId, ...(accountId ? { accountId } : {}) })}
          onStarted={v => { sessionsUi.reload(); sessionsUi.onStarted(v); }} onClose={() => { sessionsUi.reload(); setSessDlg(null); }}
          onAccounts={() => { setSessDlg(null); sessionsUi.onAccounts(); }} />
      </Suspense></div> : null}
      {histAt ? <Suspense fallback={null}><SessionList at={histAt} os={sessionsUi.os} list={sessions} viewed={sessionsUi.viewSid} pi={projectIssues(snap, pid)} onPick={sessionsUi.onPick} onClose={() => setHistAt(null)} /></Suspense> : null}
      {/* G4 UX M5: the account dialogs stack over Settings / the wizard (Settings stays mounted and dimmed behind) */}
      {accDlg ? <div id="accmodal">
        {accDlg.k === 'add' || accDlg.k === 'relogin'
          ? <LoginDialog key={JSON.stringify(accDlg)} req={accDlg} snap={snap} privateWindow={!!accInfo?.privateWindow} now={now} send={send} sendQuiet={c => client.send(c)} escRef={accEsc}
            onClose={() => { accEsc.current = null; setAccDlg(null); }} toast={t => store.toast('info', t)} />
          : accDlg.k === 'merge' ? <MergeDialog req={accDlg} send={send} onClose={() => setAccDlg(null)} />
          : <ConfirmDialog req={accDlg} snap={snap} send={send} onClose={() => setAccDlg(null)} />}
      </div> : null}
    </>
  );
}
