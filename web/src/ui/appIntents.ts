// What the shell does with the three intent sources it does not render itself: a ⌘K palette pick (F22), a Chờ PO row /
// detail-box button (v2 §6, v2.4 §6.7) and a deck click (§4.11). App passes its state and actions; nothing here keeps state.
import type { CardView } from '../../../shared/protocol.ts';
import type { MenuAct } from '../lib/actions.ts';
import { laneSel, ORCH } from '../lib/inspector.ts';
import type { PalAct } from '../lib/palette.ts';
import { parseA9Key } from '../lib/account-ui.ts';
import { firstLoginId } from '../lib/skills-mcp.ts';
import type { DeckIntent } from '../deck/actions.ts';
import { projectIssues } from '../lib/issues.ts';
import { goArising, goIssue } from '../lib/traces.ts';
import { askCancel } from '../tasks/CancelPop.tsx';
import type { ShellCtx } from './shellCtx.ts';

export function palRun(a: PalAct, h: ShellCtx, runMenu: (m: MenuAct) => void): void {
  const { pid } = h;
  switch (a.t) {
    case 'lane': return h.done.openLane(a.projectId, a.name);
    case 'project': return h.pickProject(a.id);
    case 'account': return h.openAccount(a.email);
    case 'menu': return runMenu(a.act);
    case 'settings': return h.ui.setSettingsTab('proj');
    case 'list': return h.toggleList();
    case 'inbox': return h.toggleInbox();
    case 'sound': return h.toggleMute();
    case 'mode': return h.setMode(a.m);
    case 'quickOpen': return h.codeKey('quickOpen');
    case 'console': if (pid) h.setTarget({ kind: 'orchestrator', projectId: pid }); return h.focusInput();
    case 'addProject': return h.ui.setAddOpen(true);
    case 'setup': return h.ui.setWizardOpen(true);
    case 'skillsMcp': return h.ui.setSm({ tab: 'mcp' }); // v2.2 §6 C17
    case 'mcpAdd': return h.ui.setSm({ tab: 'mcp', add: true });
    case 'toolkit': case 'graph': return h.ui.setSm({ tab: a.t }); // v2.5 §6 ⌘K opens that tab
    case 'mcpLogin': { const id = firstLoginId(h.snap?.skillsMcp?.mcp.rows ?? []); return h.ui.setSm(id ? { tab: 'mcp', login: id } : { tab: 'mcp' }); }
  }
}

export function cardAction(c: CardView, action: string, h: ShellCtx): void {
  const { setAccDlg } = h.ui, { send, pid } = h;
  // v2 §6 F16 → A6 at once; A9 "Gộp" shows the move list first; orphan "Xoá" confirms (A8 text)
  if (action === 'account_relogin' && c.key) { setAccDlg({ k: 'relogin', email: c.key, started: true }); void send({ cmd: 'card_action', id: c.id, action }).catch(() => setAccDlg(null)); return; }
  if (action === 'shared_cfg_merge') { const t = parseA9Key(c.key); if (t) return setAccDlg({ k: 'merge', ...t, cardId: c.id }); }
  if (action === 'account_orphan_delete') return setAccDlg({ k: 'orphan_delete', cardId: c.id, title: c.title });
  if (action === 'account_add') return setAccDlg({ k: 'add' }); // §7.1-3 cutover → A3; the engine resolves the card
  if (action === 'mcp_login' && c.key) return h.ui.setSm({ tab: 'mcp', login: c.key }); // v2.2 K13 → K3 (it starts the login)
  if (action === 'view_log' && c.source && c.source !== 'orchestrator' && pid) return h.setTarget({ kind: 'lane', projectId: c.projectId ?? pid, name: c.source });
  // v2.7 §4.2-4 / §7.3 / §5.7-5 the UI-only actions of the issue cards (the engine runs only `revert_keep`)
  const pi = projectIssues(h.snap, c.projectId ?? pid), key = typeof c.params?.key === 'string' ? c.params.key : null;
  if (action === 'issues_view') return h.openTasks(goArising(pi, key));
  if (action === 'open_skills') return h.ui.setSm({ tab: 'skills' });
  if (action === 'revert_cancel_both' && key) {
    const b = c.params?.blocker;
    h.openTasks(goIssue(pi, key));
    return askCancel(c.projectId ?? pid ?? '', typeof b === 'string' ? [b, key] : [key]); // IS5b IS4 for both, the blocker first
  }
  void send({ cmd: 'card_action', id: c.id, action }).catch(() => {});
}

/** §6.7 a button in the detail box: the box closes first (an account dialog never stacks on it), then as on the row. */
export function boxAction(c: CardView, action: string, h: ShellCtx): void {
  h.ui.setCardBox(null);
  cardAction(c, action, h);
}

/** §4.11 deck clicks → Đang xem; below 1280 px a node click also opens the drawer (N4-j) */
export function deckIntent(i: DeckIntent, h: ShellCtx): void {
  const { pick, setFocusPick, setFold, setAddOpen } = h.ui, { pid, drawer } = h;
  if (i.t === 'lane') { const l = h.lanes.find(x => x.name === i.name); pick(l ? laneSel(l) : { k: 'lane', name: i.name }); drawer('node'); }
  else if (i.t === 'expand') { if (pid) h.done.expand(pid, i.root); }
  else if (i.t === 'done_list') { pick({ k: 'doneList' }); drawer('node'); }
  else if (i.t === 'account') h.openAccount(i.email);
  else if (i.t === 'orch') { if (i.root) h.ss.view(i.root); else pick(ORCH); drawer('node'); } // §4.14 click a root = view that session
  else if (i.t === 'card') {
    pick(i.lane ? { k: 'lane', name: i.lane } : ORCH); // the card's lane / Điều phối is selected too (§4.11, N2-b)
    drawer('card');
    if (i.cardId === null) return;
    setFocusPick(i.cardId);
    h.ui.setCardBox({ id: i.cardId, status: 'open' }); // §6.7 the badge selects the card and opens its box
    setFold({ folded: false, resolvedOpen: false });
    h.flash();
  } else if (i.t === 'sub') { pick(i.taskId ? { k: 'sub', lane: i.lane, taskId: i.taskId } : { k: 'lane', name: i.lane }); drawer('node'); }
  else if (i.t === 'more') { pick({ k: 'lane', name: i.lane, subsFirst: true }); drawer('node'); } // N2-l: Subagent section first
  else if (i.t === 'orch_restart') { if (pid) void h.send({ cmd: 'orchestrator_restart', projectId: pid, ...(i.root && i.root !== pid ? { sessionId: i.root } : {}) }).catch(() => {}); }
  else if (i.t === 'add_project') setAddOpen(true);
  else if (i.t === 'issue') h.openTasks(goIssue(projectIssues(h.snap, pid), i.key));
}
