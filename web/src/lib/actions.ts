// v2.1 §4.12 "⋯" action menus — the one source per kind (lane, Điều phối session, subagent, account row). The deck node,
// the Inspector "⋯", the F9 row "⋯", the account panel row and ⌘K (N2-k) all list these items, so they never drift.
// Pure: items carry a data `act`; the App runs it (destructive ones through the existing confirm dialogs).
// Hidden = state or channel (§4.11 `canRun`); dimmed + reason = offline / lock rule / invalid account (§4.12).
import type { Tr } from '../../../shared/i18n/core.ts';
import type { AccountView, Command, LaneState, LaneView, OrchestratorState, OrchestratorView, ProjectView, Snapshot, SubagentView, Target } from '../../../shared/protocol.ts';
import { isActiveLane, lanesOn, switchOptions } from './accounts.ts';
import { deleteBlock, loginLock, refreshRecent } from './account-ui.ts';
import { laneRunning, orchRunning } from './labels.ts';
import { fmtHm } from './format.ts';
import { canRun } from './remote.ts';
import { sessionsOf } from './sessions.ts';
import type { ThemeMode } from './theme.ts';
import { capReached } from '../../../shared/issues.ts';

export type IconName = 'user' | 'msg' | 'pause' | 'stop' | 'swap' | 'code' | 'term' | 'folder' | 'gear' | 'list' | 'inbox' | 'vol' | 'plus' | 'refresh' | 'bar' | 'send' | 'lock' | 'x' | 'info' | 'clock' | 'plug' | 'workflow' | 'fileCode' | 'branch' | 'listChecks' | 'sun' | 'moon' | 'monitor' | 'wrench' | 'db';

export type SessionDialog = 'parallel' | 'history' | 'new' | 'rename' | 'end' | 'model';
export type MenuAct =
  | { t: 'lane'; a: 'msg' | 'interrupt' | 'resume' | 'stop' | 'model' | 'vscode' | 'terminal' | 'continue' | 'merge'; projectId: string; name: string }
  | { t: 'lane_switch'; projectId: string; name: string; account: string | null }
  | { t: 'lane_reassign'; projectId: string; name: string; toSession: string }
  | { t: 'orch'; a: 'msg' | 'interrupt' | 'restart' | 'stopAll' | 'collapse' | 'collapseOthers'; projectId: string; sessionId: string | null }
  | { t: 'session'; kind: SessionDialog; projectId: string; sessionId: string | null }
  | { t: 'sub'; a: 'view' | 'msg' | 'interrupt'; projectId: string; lane: string; taskId: string; name: string }
  | { t: 'acc'; a: 'view' | 'refresh' | 'relogin' | 'terminal' | 'pause' | 'unpause' | 'moveAll' | 'caps' | 'logout' | 'delete'; email: string }
  | { t: 'project'; a: 'close'; projectId: string }
  | { t: 'theme'; mode: ThemeMode };

export interface MenuItem {
  id: string; label: string;
  /** group: a rule is drawn where it changes (N2-c). */
  g: number;
  icon?: IconName; kbd?: string; danger?: boolean;
  /** dimmed, with the reason shown under the label. */
  disabled?: string;
  /** second line under the label (v2.7.1 AC4 "lần trước 08:03"). */
  hint?: string;
  /** hover text (hot fix 2026-11-16: what "Đóng project" keeps). */
  tip?: string;
  act?: MenuAct;
  submenu?: { head: string; items: MenuItem[] };
  /** v2.8 §4.1 a radio item (`menuitemradio`, ✓ when true) and its grey note on the right ("đang Sáng"). */
  checked?: boolean; note?: string;
}

export interface MenuCtx {
  tr: Tr; snap: Snapshot; offline: boolean;
  /** v2.7.1 D101 the ⋯ "Làm mới số liệu" 60 s floor reads the clock. */
  now: number;
  /** Mở Terminal exists only inside the Tauri app. */
  tauri: boolean;
  /** the composer target: Enter / ⌘. hints only on the item they hit. */
  current?: Target | null;
}

const LANE_CMD = { msg: 'send', interrupt: 'interrupt', resume: 'lane_resume', stop: 'lane_stop', model: 'lane_set_model', vscode: 'open_in_vscode', terminal: 'open_in_vscode',
  continue: 'lane_continue', merge: 'send' } as const;
const ORCH_CMD = { msg: 'send', interrupt: 'interrupt', restart: 'orchestrator_restart', stopAll: 'stop_all', collapse: null, collapseOthers: null } as const;
const SESSION_CMD = { parallel: 'session_open', history: 'sessions_list', new: 'orchestrator_new', rename: 'session_rename', end: 'session_end',
  model: 'session_open' /* v2.4 §8 Mac only, like session_open (the model commands join `Command` with G1c, R12) */ } as const;
const SUB_CMD = { view: null, msg: 'send', interrupt: 'interrupt' } as const;
const ACC_CMD = { view: null, refresh: 'quota_refresh', relogin: 'account_login', terminal: 'account_open_terminal', pause: 'config_update', unpause: 'config_update',
  moveAll: 'lane_switch_account', caps: 'config_update', logout: 'account_logout', delete: 'account_delete' } as const;

/** §4.11 the engine command an act ends in (null = UI only); the remote filter asks `canRun` about it. */
export function actCmd(a: MenuAct): Command['cmd'] | null {
  switch (a.t) {
    case 'lane': return LANE_CMD[a.a];
    case 'lane_switch': return 'lane_switch_account';
    case 'lane_reassign': return 'lane_reassign';
    case 'orch': return ORCH_CMD[a.a];
    case 'session': return SESSION_CMD[a.kind];
    case 'sub': return SUB_CMD[a.a];
    case 'acc': return ACC_CMD[a.a];
    case 'project': return 'project_close';
    case 'theme': return null; // v2.8 §5.1 this Mac's own setting, no engine command
  }
}

/** §4.11 remote hides what the engine refuses (an emptied submenu goes too); §4.12 offline dims everything. */
function finish(items: MenuItem[], c: MenuCtx): MenuItem[] {
  const out: MenuItem[] = [];
  for (const i of items) {
    if (i.act) { const cmd = actCmd(i.act); if (cmd && !canRun(c.snap.channel, cmd)) continue; }
    const it: MenuItem = i.submenu ? { ...i, submenu: { head: i.submenu.head, items: finish(i.submenu.items, c) } } : { ...i };
    if (it.submenu && !it.submenu.items.length) continue;
    if (c.offline) it.disabled = c.tr('menu.offline');
    out.push(it);
  }
  return out;
}

/** §4.12 Ngắt lượt shows while a turn runs or the lane waits for the PO. */
const turnLive = (s: LaneState) => laneRunning(s) || s === 'waiting_po';
const sid = (o: OrchestratorView) => o.sessionId ?? 'main';
const sessionLabel = (tr: Tr, o: OrchestratorView) => (o.title ? tr('menu.sessionTitled', { n: o.seq ?? 1, title: o.title }) : tr('menu.session', { n: o.seq ?? 1 }));
const paused = (snap: Snapshot) => (snap.config.noNewLanes ?? {}) as Record<string, boolean>;
const isCurrent = (c: MenuCtx, t: Target) => !!c.current && c.current.kind === t.kind && c.current.projectId === t.projectId
  && (t.kind === 'lane' ? c.current.kind === 'lane' && c.current.name === t.name
    : c.current.kind === 'orchestrator' && (!t.sessionId || !c.current.sessionId || c.current.sessionId === t.sessionId));

/** §4.12 "Chuyển account ▸": usable accounts by headroom (most first), then Tự động, then the dimmed ones with their reason. */
function switchItems(l: LaneView, c: MenuCtx): MenuItem[] {
  const off = paused(c.snap), room = new Map(c.snap.accounts.map(a => [a.email, a.headroomPct ?? -1]));
  const opts = switchOptions(c.tr, l, c.snap.accounts).map(o => (o.email && off[o.email] && !o.disabled ? { ...o, disabled: true, reason: c.tr('menu.swPaused') } : o));
  const item = (o: (typeof opts)[number]): MenuItem => ({ id: `sw:${o.email ?? 'auto'}`, label: o.pct && o.email ? `${o.label} · ${o.pct}` : o.label, g: 0,
    ...(o.disabled ? { disabled: o.reason } : {}), act: { t: 'lane_switch', projectId: l.projectId, name: l.name, account: o.email } });
  const usable = opts.filter(o => o.email && !o.disabled).sort((a, b) => room.get(b.email!)! - room.get(a.email!)!);
  return [...usable, ...opts.filter(o => !o.email), ...opts.filter(o => o.email && o.disabled)].map(item);
}

export function laneActions(l: LaneView, c: MenuCtx): MenuItem[] {
  const { tr } = c, k = { projectId: l.projectId, name: l.name }, done = l.state === 'done';
  const cur = isCurrent(c, { kind: 'lane', ...k });
  const a = (id: LaneAct, label: string, g: number, icon: IconName, extra: Partial<MenuItem> = {}): MenuItem => ({ id, label, g, icon, act: { t: 'lane', a: id, ...k }, ...extra });
  const items: MenuItem[] = [a('msg', tr('menu.msg'), 0, 'msg', cur ? { kbd: 'Enter' } : {})];
  if (turnLive(l.state)) items.push(a('interrupt', tr('menu.interrupt'), 0, 'pause', cur ? { kbd: '⌘.' } : {}));
  else if (l.state === 'stopped' || l.state === 'broken') items.push(a('resume', tr('menu.resume'), 0, 'refresh'));
  if (l.state !== 'stopped' && !done) items.push(a('stop', tr('menu.stop'), 0, 'stop', { danger: true }));
  if (!done) items.push(a('model', tr('menu.model'), 1, 'gear')); // v2.4 §4.5 "Model / effort…" (Mac only: lane_set_model)
  if (!done) items.push({ id: 'switch', label: tr('menu.switch'), g: 1, icon: 'swap', submenu: { head: tr('menu.switchHead', { name: l.name }), items: switchItems(l, c) } });
  const sessions = sessionsOf(c.snap, l.projectId);
  if (!done && sessions.length > 1) {
    items.push({ id: 'reassign', label: tr('menu.reassign'), g: 1, icon: 'swap', submenu: { head: tr('menu.reassignHead', { name: l.name }), items: sessions.map(o => ({
      id: `rs:${sid(o)}`, label: sessionLabel(tr, o), g: 0, ...(sid(o) === l.ownerSession ? { disabled: tr('menu.holding') } : {}),
      act: { t: 'lane_reassign', ...k, toSession: sid(o) } })) } });
  }
  if (done) {
    const b = l.branch?.state;
    items.push(a('continue', tr('menu.continue'), 2, 'refresh', b === 'merged' ? { disabled: tr('menu.merged') } : b === 'gone' ? { disabled: tr('menu.gone') } : {}));
    if (b !== 'merged') items.push(a('merge', sessions.length > 1 && l.ownerSeq ? tr('menu.mergeN', { n: l.ownerSeq }) : tr('menu.merge'), 2, 'send'));
  }
  items.push(a('vscode', tr('menu.vscode'), 3, 'code'));
  if (c.tauri) items.push(a('terminal', tr('menu.terminal'), 3, 'term'));
  return finish(items, c);
}
type LaneAct = Extract<MenuAct, { t: 'lane' }>['a'];

export function orchActions(o: OrchestratorView, c: MenuCtx): MenuItem[] {
  const { tr } = c, projectId = o.projectId, sessionId = o.sessionId ?? null;
  const sessions = sessionsOf(c.snap, projectId), multi = sessions.length > 1, n = o.seq ?? 1;
  const cur = isCurrent(c, { kind: 'orchestrator', projectId, ...(sessionId ? { sessionId } : {}) });
  const or = (id: Extract<MenuAct, { t: 'orch' }>['a'], label: string, g: number, icon: IconName, extra: Partial<MenuItem> = {}): MenuItem =>
    ({ id, label, g, icon, act: { t: 'orch', a: id, projectId, sessionId }, ...extra });
  const se = (kind: SessionDialog, label: string, icon: IconName, g: number, extra: Partial<MenuItem> = {}): MenuItem =>
    ({ id: kind, label, g, icon, act: { t: 'session', kind, projectId, sessionId }, ...extra });
  const items: MenuItem[] = [or('msg', tr('menu.msgOrch'), 0, 'msg', cur ? { kbd: 'Enter' } : {})];
  if (o.state === 'stopped') items.push(or('restart', tr('menu.restart'), 0, 'refresh'));
  else if (orchRunning(o.state)) items.push(or('interrupt', tr('menu.interrupt'), 0, 'pause', cur ? { kbd: '⌘.' } : {}));
  // §4.14 N5-q at the cap "Mở phiên song song…" is dimmed with the reason; v2.7 R34 the cap counts Thiết kế / Build, not the one
  // Chung (the engine's rule, from the view's `orchKind`, R-B13 e); a parallel session opens as Chung
  const capped = capReached(sessions.map(x => x.orchKind ?? 'general'), 'general');
  // v2.7.1 §5 G2c a session still `starting`: its end / model change waits the boot (ack ≈ 3–8 s), the item says so at once
  const boot: Partial<MenuItem> = o.state === 'starting' ? { hint: tr('session.bootWait') } : {};
  items.push(se('parallel', tr('menu.parallel'), 'plus', 1, capped ? { disabled: tr('errors.sessionCap') } : {}), se('history', tr('menu.history'), 'clock', 1, { kbd: 'H' }),
    ...(o.sessionId ? [se('model', tr('menu.model'), 'gear', 1, boot)] : []), // v2.4 §4.2 "Model / effort…"
    se('new', multi ? tr('menu.newSessionN', { n }) : tr('menu.newSession'), 'refresh', 1), se('rename', tr('menu.rename'), 'gear', 1),
    se('end', tr('menu.end'), 'x', 2, multi ? boot : { disabled: tr('menu.endOnly') }));
  if (!multi) items.push(or('stopAll', tr('menu.stopAll'), 2, 'stop', { danger: true }));
  else {
    const live = c.snap.lanes.filter(l => l.projectId === projectId && l.state !== 'done' && l.state !== 'stopped').length;
    items.push({ ...or('stopAll', tr('menu.stopSession', { n }), 2, 'stop', { danger: true }), id: 'stopSession' },
      { id: 'stopProject', label: tr('menu.stopProject', { n: live }), g: 2, icon: 'stop', danger: true, act: { t: 'orch', a: 'stopAll', projectId, sessionId: null } },
      or('collapse', tr('menu.collapse', { n }), 3, 'list'), or('collapseOthers', tr('menu.collapseOthers'), 3, 'list'));
  }
  return finish(items, c);
}

export function subActions(s: SubagentView, parent: LaneView, c: MenuCtx): MenuItem[] {
  const { tr } = c, k = { projectId: parent.projectId, lane: parent.name, taskId: s.taskId, name: s.subagentType };
  const items: MenuItem[] = [
    { id: 'view', label: tr('menu.subView'), g: 0, icon: 'info', act: { t: 'sub', a: 'view', ...k } },
    { id: 'msg', label: tr('menu.subMsg', { lane: parent.name }), g: 0, icon: 'msg', act: { t: 'sub', a: 'msg', ...k } },
  ];
  if (turnLive(parent.state)) items.push({ id: 'interrupt', label: tr('menu.subInterrupt', { lane: parent.name }), g: 0, icon: 'pause', act: { t: 'sub', a: 'interrupt', ...k } });
  return finish(items, c);
}

function refreshOpts(tr: Tr, a: AccountView, now: number): Partial<MenuItem> {
  const recent = refreshRecent(tr, a, now);
  return { ...(a.fetchedAt !== null ? { hint: tr('menu.refreshLast', { hm: fmtHm(a.fetchedAt) }) } : {}), ...(recent ? { disabled: recent } : {}) };
}

export function accountActions(a: AccountView, c: MenuCtx): MenuItem[] {
  const { tr, snap } = c, email = a.email;
  const ac = (id: Extract<MenuAct, { t: 'acc' }>['a'], label: string, g: number, icon: IconName, extra: Partial<MenuItem> = {}): MenuItem =>
    ({ id, label, g, icon, act: { t: 'acc', a: id, email }, ...extra });
  const active = lanesOn(email, snap.lanes).filter(isActiveLane);
  const out = a.loggedOut || a.login === 'out', lock = loginLock(tr, a, snap.login ?? null), del = deleteBlock(tr, a, snap);
  const items: MenuItem[] = [
    ac('view', tr('menu.accView'), 0, 'user'),
    // v2.7.1 §4.4 AC4 one account's numbers now (Mac only: `quota_refresh` is not in REMOTE_ALLOWED → `finish` drops it)
    // D101 floored at 60 s like the row ⟳ (review-b MINOR-2): dimmed with the same reason
    ...(out ? [] : [ac('refresh', tr('menu.refresh'), 0, 'refresh', refreshOpts(tr, a, c.now))]),
    // hf1116 B-I2: a re-login rewrites the terminal's own login → offered on that row only once it is logged out
    ...(!a.terminal || out ? [ac('relogin', tr('menu.relogin'), 0, 'refresh')] : []), ac('terminal', tr('menu.terminal'), 0, 'term'),
    paused(snap)[email] ? ac('unpause', tr('menu.unpause'), 1, 'lock') : ac('pause', tr('menu.pause'), 1, 'lock'),
    ac('moveAll', tr('menu.moveAll'), 1, 'swap', active.length ? {} : { disabled: tr('menu.noLanes') }), ac('caps', tr('menu.caps'), 1, 'gear'),
  ];
  // hf1116 T4: the terminal login is signed out in the terminal (`/logout`), never from cc-slaves
  if (!out && !a.terminal) items.push(ac('logout', tr('menu.logout'), 2, 'x', lock ? { disabled: lock } : {}));
  items.push(ac('delete', tr('menu.delete'), 2, 'stop', { danger: true, ...(del ? { disabled: del } : {}) }));
  return finish(items, c);
}

/** Hot fix 2026-11-16: why "Đóng project" is blocked (error prevention: the engine refuses `project_busy` too). */
const LANE_BUSY: ReadonlySet<LaneState> = new Set<LaneState>(['starting', 'running', 'switching', 'draining', 'waiting_quota']);
const ORCH_BUSY: ReadonlySet<OrchestratorState> = new Set<OrchestratorState>(['starting', 'running', 'switching', 'waiting_quota']);

/** "Đang chạy 2 lane · Điều phối — dừng hoặc chờ xong rồi đóng"; null = the project may close. */
export function closeBlock(tr: Tr, snap: Pick<Snapshot, 'lanes' | 'orchestrators'>, projectId: string): string | null {
  const lanes = snap.lanes.filter(l => l.projectId === projectId && LANE_BUSY.has(l.state)).length;
  const orch = snap.orchestrators.some(o => o.projectId === projectId && ORCH_BUSY.has(o.state));
  const parts = [lanes ? tr('menu.busyLanes', { n: lanes }) : null, orch ? tr('common.role.orchestrator') : null].filter(Boolean);
  return parts.length ? tr('menu.projectBusy', { what: parts.join(' · ') }) : null;
}

/** Hot fix 2026-11-16 a project tab's right-click menu: "Đóng project", dimmed with the reason while something of it runs
 *  (Mac only: `project_close` is not in REMOTE_ALLOWED, so the remote channel gets no item). */
export function projectActions(pr: Pick<ProjectView, 'id'>, c: MenuCtx): MenuItem[] {
  const { tr } = c, busy = closeBlock(tr, c.snap, pr.id);
  return finish([{ id: 'close', label: tr('menu.projectClose'), g: 0, icon: 'x', tip: tr('menu.projectCloseTip'),
    act: { t: 'project', a: 'close', projectId: pr.id }, ...(busy ? { disabled: busy } : {}) }], c);
}
