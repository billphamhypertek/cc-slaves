// v2.1 §4.12 the "⋯" menu glue kept out of the App: which menu a source opens (node id, Inspector, F9 row, account row all
// resolve to one `MenuSrc` → one item list), and what an item does. Destructive items only open the existing confirm
// dialogs (Dừng, Chuyển hết lane, Đăng xuất, Xoá account, Dừng an toàn tất cả) — never a direct command.
import type { Command, LaneView, Snapshot, SubagentView, Target } from '../../../shared/protocol.ts';
import { accountActions, laneActions, orchActions, projectActions, subActions, type MenuAct, type MenuCtx, type MenuItem, type SessionDialog } from '../lib/actions.ts';
import { shortEmail } from '../lib/format.ts';
import type { Selection } from '../lib/inspector.ts';
import type { AccDlg } from './Accounts.tsx';

export type MenuSrc = { k: 'lane'; projectId: string; name: string } | { k: 'orch'; projectId: string; sessionId: string | null }
  | { k: 'sub'; projectId: string; lane: string; taskId: string } | { k: 'account'; email: string } | { k: 'project'; id: string };

/** A deck node id (deck/layout.ts: `lane:<name>`, `orch:<root>`, `sub:<lane>:<task>`) → its menu source; rows have none. */
export function nodeMenuSrc(id: string, projectId: string, snap: Snapshot): MenuSrc | null {
  if (id.startsWith('lane:')) return { k: 'lane', projectId, name: id.slice(5) };
  if (id.startsWith('orch:')) {
    const root = id.slice(5), o = snap.orchestrators.find(x => x.projectId === projectId && x.sessionId === root);
    return { k: 'orch', projectId, sessionId: o?.sessionId ?? null };
  }
  const m = /^sub:([^:]+):(.+)$/.exec(id);
  return m ? { k: 'sub', projectId, lane: m[1]!, taskId: m[2]! } : null;
}

/** The items of a source, from the live snapshot (empty when the thing is gone). */
export function menuItemsFor(src: MenuSrc, c: MenuCtx, subsOf: (projectId: string, lane: string) => SubagentView[] | undefined): MenuItem[] {
  const { snap } = c;
  const lane = (projectId: string, name: string) => snap.lanes.find(l => l.projectId === projectId && l.name === name);
  if (src.k === 'lane') { const l = lane(src.projectId, src.name); return l ? laneActions(l, c) : []; }
  if (src.k === 'orch') {
    const all = snap.orchestrators.filter(o => o.projectId === src.projectId), o = all.find(x => (x.sessionId ?? null) === src.sessionId) ?? all[0];
    return o ? orchActions(o, c) : [];
  }
  if (src.k === 'sub') {
    const l = lane(src.projectId, src.lane), sv = subsOf(src.projectId, src.lane)?.find(x => x.taskId === src.taskId);
    return l && sv ? subActions(sv, l, c) : [];
  }
  if (src.k === 'project') { const pr = snap.projects.find(x => x.id === src.id); return pr ? projectActions(pr, c) : []; }
  const a = snap.accounts.find(x => x.email === src.email);
  return a ? accountActions(a, c) : [];
}

/** What the App lends the runner. */
export interface MenuHost {
  t(key: 'app.stopAll' | 'app.autoAcc'): string;
  switched(name: string, to: string): string;
  subDraft(name: string): string;
  send(c: Command): Promise<unknown>;
  toast(text: string): void;
  confirm(text: string): boolean;
  lane(projectId: string, name: string): LaneView | undefined;
  noNewLanes(): Record<string, boolean>;
  /** select the target and put the cursor in the composer */
  talkTo(t: Target): void;
  interrupt(t: Target): void;
  select(s: Selection): void;
  draft(text: string): void;
  askStop(projectId: string, name: string): void;
  openTerminal(path: string): void;
  openAccount(email: string): void;
  accDialog(d: AccDlg): void;
  moveAll(email: string): void;
  accountSettings(): void;
  /** v2.7.1 §4.4 ⋯ "Làm mới số liệu": through the account panel, so its "đang làm mới" shows at once (review-b MINOR-2). */
  refreshAccount(email: string): void;
  /** v2.4 §4.5 select the lane and open its model picker. */
  laneModel(name: string): void;
  /** §4.14 session dialogs / the session list. */
  sessionDialog(kind: SessionDialog, sessionId: string | null): void;
  /** §4.14 a lane changed owner: the 5 s "Hoàn tác" toast (`from` = its owner before the move). */
  moved(m: { projectId: string; name: string; from: string | null; toSession: string }): void;
  /** T11: done-lane flows and tree collapse (§4.15). */
  laneDoneFlow(kind: 'continue' | 'merge' | 'collapse' | 'collapseOthers', id: string): void;
  /** hot fix 2026-11-16 "Đóng project" (no confirm: re-adding the folder reopens it). */
  closeProject(id: string): void;
}

const quiet = (p: Promise<unknown>) => void p.catch(() => {});
const laneT = (projectId: string, name: string): Target => ({ kind: 'lane', projectId, name });

export function runMenuAct(m: MenuAct, h: MenuHost): void {
  switch (m.t) {
    case 'lane': {
      const { projectId, name } = m, l = h.lane(projectId, name);
      if (m.a === 'msg') h.talkTo(laneT(projectId, name));
      else if (m.a === 'interrupt') h.interrupt(laneT(projectId, name));
      else if (m.a === 'stop') h.askStop(projectId, name);
      else if (m.a === 'model') h.laneModel(name);
      else if (m.a === 'resume') quiet(h.send({ cmd: 'lane_resume', projectId, name }));
      else if (m.a === 'vscode') { if (l) quiet(h.send({ cmd: 'open_in_vscode', path: l.cwd })); }
      else if (m.a === 'terminal') { if (l) h.openTerminal(l.cwd); }
      else h.laneDoneFlow(m.a, name);
      return;
    }
    case 'lane_switch':
      return quiet(h.send({ cmd: 'lane_switch_account', projectId: m.projectId, name: m.name, account: m.account })
        .then(() => h.toast(h.switched(m.name, m.account ? shortEmail(m.account) : h.t('app.autoAcc')))));
    case 'lane_reassign': { // §4.14 no confirm; the toast offers "Hoàn tác" for 5 s
      const from = h.lane(m.projectId, m.name)?.ownerSession ?? null;
      return quiet(h.send({ cmd: 'lane_reassign', projectId: m.projectId, name: m.name, toSession: m.toSession }).then(() => h.moved({ ...m, from })));
    }
    case 'orch': {
      const sid = m.sessionId ? { sessionId: m.sessionId } : {};
      const t: Target = { kind: 'orchestrator', projectId: m.projectId, ...sid };
      if (m.a === 'msg') h.talkTo(t);
      else if (m.a === 'interrupt') h.interrupt(t);
      else if (m.a === 'restart') quiet(h.send({ cmd: 'orchestrator_restart', projectId: m.projectId, ...sid }));
      else if (m.a === 'stopAll') { if (h.confirm(h.t('app.stopAll'))) quiet(h.send({ cmd: 'stop_all', projectId: m.projectId, ...sid })); }
      else h.laneDoneFlow(m.a, m.sessionId ?? m.projectId);
      return;
    }
    case 'session': return h.sessionDialog(m.kind, m.sessionId);
    case 'sub':
      if (m.a === 'view') h.select({ k: 'sub', lane: m.lane, taskId: m.taskId });
      else if (m.a === 'msg') { h.select({ k: 'lane', name: m.lane }); h.draft(h.subDraft(m.name)); }
      else h.interrupt(laneT(m.projectId, m.lane));
      return;
    case 'acc': {
      const email = m.email;
      if (m.a === 'view') h.openAccount(email);
      else if (m.a === 'refresh') h.refreshAccount(email);
      else if (m.a === 'relogin') h.accDialog({ k: 'relogin', email });
      else if (m.a === 'terminal') quiet(h.send({ cmd: 'account_open_terminal', email }));
      else if (m.a === 'pause' || m.a === 'unpause') quiet(h.send({ cmd: 'config_update', patch: { noNewLanes: { ...h.noNewLanes(), [email]: m.a === 'pause' } } }));
      else if (m.a === 'moveAll') h.moveAll(email);
      else if (m.a === 'caps') h.accountSettings();
      else h.accDialog({ k: m.a, email });
      return;
    }
    case 'project': return h.closeProject(m.projectId);
  }
}
