// §4 layout C left column content: Chờ PO on top, Đang xem below (composer at its bottom); F2 "Thêm dự án" when the engine
// has no project. App renders the `#left` box around it (narrow drawer, aria-hidden) and owns every piece of state.
import { useMemo, type ReactElement } from 'react';
import type { CardView, ProjectView, StreamLine, SubagentView } from '../../../shared/protocol.ts';
import { cardSel, ORCH, selUp } from '../lib/inspector.ts';
import type { UndoQueue } from '../lib/cards.ts';
import { useT } from '../lib/i18n.tsx';
import { targetKey } from '../lib/store.ts';
import { cardAction } from './appIntents.ts';
import { Inbox } from './Inbox.tsx';
import { Inspector } from './Inspector.tsx';
import type { LocalCmd } from './localCmd.ts';
import type { MenuSrc } from './menuRun.ts';
import type { ShellCtx } from './shellCtx.ts';
import type { Live } from './Conversation.tsx';
import { PAGE, subLinesOf, useStream } from './useEngineFeeds.ts';

export interface LeftColumnProps {
  c: ShellCtx; project: ProjectView | null; empty: boolean; cards: CardView[]; focusId: number | null; undo: UndoQueue;
  laneKey: string | null; sub: SubagentView | null;
  /** v2.1 §4.14 running sessions per project id (the rows and the detail box name the session when > 1). */
  sessions: Record<string, number>; onLocal: (cmd: LocalCmd) => void; loadOlder: () => void;
  openMenu: (src: MenuSrc | null, opener: Element, inDeck: boolean) => void;
}

export function LeftColumn(p: LeftColumnProps): ReactElement {
  const { c: x, project, cards, sub } = p, { ui, st, target, pid, lanes, send, store, client } = x, snap = x.snap!, sid = x.ss.sid;
  const { sel, pick, fold, setFold, setFocusPick, subHist, setStopLane, setMoveAll, setAccDlg, setSettingsTab } = ui;
  const tr = useT();
  const onCardOpen = (id: number) => { // §4.11 the card + its lane / Điều phối; §6.7 + its detail box
    setFocusPick(id);
    const c = cards.find(x => x.id === id), to = c ? cardSel(c, lanes.map(l => l.name)) : null;
    if (to) pick(cur => (cur.k === 'sub' && to.k === 'lane' && cur.lane === to.name ? cur : to));
    if (c) ui.setCardBox({ id, status: c.status });
  };
  const cardProps = { cards, focusId: p.focusId, channel: snap.channel, offline: x.offline, sessions: p.sessions, undo: p.undo, guard: ui.guard, newIds: ui.newIds, onOpen: onCardOpen, onAction: (c: CardView, action: string) => cardAction(c, action, x) };
  // perf audit C3: the stream buffers re-render this column per line; the per-frame text is read by the list itself (`Live`),
  // and none of it while the column is hidden (v2.7 Tasks): no pacing, no frame work there
  const tk = target ? targetKey(target) : null, on = x.mode !== 'tasks', subParent = sub?.toolUseId ?? null;
  const viewed = useStream(store, tk), stream = useStream(store, p.laneKey);
  const live = useMemo<Live | undefined>(() => (on && tk ? { store, tk, parent: null } : undefined), [on, store, tk]);
  const subLive = useMemo<Live | undefined>(() => (on && p.laneKey && subParent ? { store, tk: p.laneKey, parent: subParent } : undefined), [on, store, p.laneKey, subParent]);
  const subLines = subLinesOf(sub, subHist, stream);
  const paused = (snap.config.noNewLanes ?? {}) as Record<string, boolean>;
  const subsByName = Object.fromEntries(lanes.map(l => [l.name, st.subagents[targetKey({ kind: 'lane', projectId: l.projectId, name: l.name })]]));
  return (
    <>
      <Inbox {...cardProps} folded={fold.folded} resolvedOpen={fold.resolvedOpen} onToggle={x.toggleInbox} onResolved={() => setFold({ folded: false, resolvedOpen: true })} />
      {project && target && x.composer && !p.empty ? <Inspector sel={sel} target={x.composer} snap={snap} project={project} now={x.now} offline={x.offline} narrow={x.narrow} dataAt={st.dataAt} subs={subsByName}
        stream={viewed} live={live} subLines={subLines} subLoading={!!sub && subHist[sub.taskId] === null} subLive={subLive}
        hideTools={st.hideTools} onHideTools={on => store.setHideTools(on)}
        paused={sel.k === 'account' && !!paused[sel.email]} draft={ui.draft} inputRef={ui.inputRef}
        onSel={s => pick(s)} onClose={() => pick(s => selUp(s) ?? ORCH)} onMenu={(kind, id, el) => p.openMenu(kind === 'lane' ? { k: 'lane', projectId: pid!, name: id } : { k: 'account', email: id }, el, false)}
        onSend={(t, text, raw, attachments) => { ui.ask(null); return send({ cmd: 'send', target: t, text, ...(raw ? { raw } : {}), ...(attachments?.length ? { attachments } : {}) }); }} onInterrupt={x.interruptT} onLocal={p.onLocal}
        onStopAsk={name => setStopLane({ projectId: pid!, name })}
        onOrchestrator={cmd => { void send({ cmd, projectId: pid!, ...(sid ? { sessionId: sid } : {}) }).catch(() => {}); }}
        {...x.ss.inspector}
        onOlder={p.loadOlder} onJumpEnd={() => { store.resetStream(target); client.send({ cmd: 'history', target, limit: PAGE }).then(r => store.history(target, (r as StreamLine[]) ?? [], PAGE)).catch(() => {}); }}
        onError={(t, icon) => store.toast(icon === 'wifi' ? 'error' : 'warn', t, icon)}
        onResume={name => void send({ cmd: 'lane_resume', projectId: pid!, name }).catch(() => {})}
        onProjectResume={() => send({ cmd: 'project_resume', id: pid! })}
        onPause={(email, on) => void send({ cmd: 'config_update', patch: { noNewLanes: { ...paused, [email]: on } } }).catch(() => {})}
        onMoveAll={email => setMoveAll(email)} onRelogin={email => setAccDlg({ k: 'relogin', email })} onEditCaps={() => setSettingsTab('acc')}
        done={x.done.props} modelSend={c => client.send(c)} modal={x.modal} token={() => client.token()} onFocusInput={x.focusInput} />
        : p.empty ? <section id="inspector" className="glass k-empty"><div className="iinfo full empty"><button type="button" className="btn pri" onClick={() => ui.setAddOpen(true)}>{tr('deck.addProject')}</button></div></section> : null}
    </>
  );
}
