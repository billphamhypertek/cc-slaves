// v2.1 §4.12 the shell's "⋯" menus: one source (lib/actions.ts), one component, one runner (menuRun.ts). App builds them
// each render from its state; this file owns where a menu opens, how it closes and what its actions reach in the shell.
import type { MutableRefObject } from 'react';
import type { MenuAct, MenuItem } from '../lib/actions.ts';
import { MENU_CLOSE_MS, type Rect } from '../lib/menu.ts';
import { targetKey } from '../lib/store.ts';
import { tabNeighbour } from '../lib/tabs.ts';
import { hasTauri, invoke } from '../lib/tauri.ts';
import { menuItemsFor, runMenuAct, type MenuHost, type MenuSrc } from './menuRun.ts';
import type { ShellCtx } from './shellCtx.ts';
import { rectOf } from './useSessions.ts';

/** §4.12 the menu stays inside the deck area (the deck's frame); outside the deck (Inspector, F9) inside the window. */
const menuArea = (inDeck: boolean): Rect => {
  const d = inDeck ? document.querySelector('#map .dframe') ?? document.querySelector('#map .dover') : null;
  return d ? rectOf(d) : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
};

/** `accRefresh` = the account panel's own refresh (its instant "đang làm mới"); null while the panel is not mounted. */
export function appMenus(d: ShellCtx, accRefresh: MutableRefObject<((email: string) => void) | null>) {
  const { ui, snap, tr, store, send, pid, ss } = d;
  const { menu, setMenu, pick, setDraft, setStopLane, setSettingsTab, setAccDlg, setMoveAll, setModelReq } = ui;
  const menuItems = (src: MenuSrc): MenuItem[] => (snap ? menuItemsFor(src, { tr, snap, offline: d.offline, tauri: hasTauri(), current: d.target, now: Date.now() },
    (projectId, lane) => d.st.subagents[targetKey({ kind: 'lane', projectId, name: lane })]) : []);
  /** `at` = a right-click's pointer (hot fix 2026-11-16 project tab); else the menu opens at the opener. */
  const openMenu = (src: MenuSrc | null, opener: Element, inDeck: boolean, at?: Rect) => {
    // focus goes back to what had it (the "⋯" button, or the node's button for ContextMenu / ⇧F10)
    if (src) setMenu({ src, anchor: at ?? rectOf(opener), area: menuArea(inDeck), opener: document.activeElement as HTMLElement | null, leaving: false });
  };
  const openAccMenu = (email: string, opener: Element) => openMenu({ k: 'account', email }, opener, false);
  const closeMenu = (refocus: boolean) => {
    const opener = refocus ? menu?.opener ?? null : null;
    setMenu(m => (m ? { ...m, leaving: true } : m));
    setTimeout(() => { setMenu(m => (m?.leaving ? null : m)); opener?.focus?.(); }, MENU_CLOSE_MS);
  };
  const menuHost: MenuHost = {
    t: k => tr(k), switched: (name, to) => tr('app.switching', { name, to }), subDraft: name => tr('menu.subDraft', { name }),
    send, toast: t => store.toast('info', t), confirm: t => window.confirm(t), lane: (projectId, name) => snap?.lanes.find(l => l.projectId === projectId && l.name === name),
    noNewLanes: () => (snap?.config.noNewLanes ?? {}) as Record<string, boolean>, talkTo: t => { if (t.projectId !== pid) d.pickProject(t.projectId); d.setTarget(t); d.focusInput(); },
    interrupt: t => d.interruptT(t), select: s2 => pick(s2), draft: text => { setDraft(x => ({ text, n: (x?.n ?? 0) + 1 })); d.drawer('focus'); },
    askStop: (projectId, name) => setStopLane({ projectId, name }), openTerminal: path => void invoke('open_terminal', { path }).catch(() => {}),
    openAccount: email => { setSettingsTab(null); d.openAccount(email); }, accDialog: setAccDlg, moveAll: setMoveAll, accountSettings: () => setSettingsTab('acc'),
    refreshAccount: email => { if (accRefresh.current) accRefresh.current(email); else void send({ cmd: 'quota_refresh', account: email }).catch(() => {}); },
    laneModel: name => { pick({ k: 'lane', name }); setModelReq(r => ({ n: r.n + 1, lane: name })); }, // v2.4 §4.5 the Inspector opens it
    sessionDialog: ss.dialog, laneDoneFlow: d.done.flow, moved: ss.onMoved,
    closeProject: id => { // the active tab hands over to its neighbour once the engine closed it (an error toasts in `send`)
      const next = id === pid && snap ? tabNeighbour(snap.projects.map(x => x.id), id) : null;
      void send({ cmd: 'project_close', id }).then(() => { if (next) d.pickProject(next); }, () => {});
    },
  };
  const runMenu = (m: MenuAct) => runMenuAct(m, menuHost);
  return { menuItems, openMenu, openAccMenu, closeMenu, runMenu };
}
