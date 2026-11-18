// v2.1 §4.15 the App side of done lanes and collapsed trees: the done total per project (`done_lanes_list`), "Thu gọn
// cây #n" / "các cây khác" / open a tree again, opening a lane from ⌘K / a notification (open its tree, open the done
// group, select, the deck glides to the selection), "Nhờ Điều phối #n merge…" (select that session, prefill, never send),
// "Chạy tiếp lane…" (the N5-o dialog), the done list pages.
import { useEffect } from 'react';
import type { Command, DoneLanesPage, LaneView, OrchestratorView, Snapshot } from '../../../shared/protocol.ts';
import { collapseNext } from '../lib/collapse.ts';
import { mergeAsk, mergeSession } from '../lib/done.ts';
import type { Tr } from '../lib/i18n.tsx';
import { focusPlan, ORCH, type DrawerEvent } from '../lib/inspector.ts';
import type { NotifyTarget } from '../lib/native.ts';
import { rootOf } from '../lib/sessions.ts';
import type { Store } from '../lib/store.ts';
import type { EngineClient } from '../lib/ws.ts';
import type { DoneProps } from './DoneViews.tsx';
import type { AppState } from './useAppState.ts';

/** what the done list asks the engine for (one page). */
export type DoneQuery = Omit<Extract<Command, { cmd: 'done_lanes_list' }>, 'cmd' | 'projectId'>;

interface DoneDeps {
  ui: AppState; store: Store; client: EngineClient; tr: Tr; snap: Snapshot | null; pid: string | null; open: boolean;
  os: OrchestratorView[]; sid: string | null; view: (sessionId: string) => void; drawer: (e: DrawerEvent) => void;
  pickProject: (id: string) => void;
}

export function useDone(d: DoneDeps) {
  const { ui, store, snap, pid } = d;
  const doneN = snap?.lanes.filter(l => l.projectId === pid && l.state === 'done').length ?? 0;
  const unmerged = snap?.projects.find(p => p.id === pid)?.unmerged ?? 0;
  // §4.15 §3 "Xong · 41": the engine's total (the snapshot only carries the last 7 days)
  useEffect(() => {
    if (!pid || !d.open) return;
    d.client.send({ cmd: 'done_lanes_list', projectId: pid, limit: 1 }).then(r => store.setDoneTotal(pid, (r as DoneLanesPage).total), () => {});
  }, [pid, doneN, unmerged, d.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const collapsedOf = (projectId: string) => store.get().deckUi.collapsed[projectId] ?? [];
  const expand = (projectId: string, root: string) => store.setCollapsed(projectId, collapsedOf(projectId).filter(r => r !== root));
  const lane = (projectId: string, name: string): LaneView | undefined => snap?.lanes.find(l => l.projectId === projectId && l.name === name);

  /** §4.15 §3 N6-g: Đang xem → the holding session's Điều phối (ended → the viewed one), the sentence under any draft. */
  const askMerge = (l: LaneView) => {
    const to = mergeSession(l, d.os, d.sid);
    if (to && to !== d.sid) d.view(to);
    ui.pick(ORCH);
    ui.setDraft(x => ({ text: mergeAsk(d.tr, l), n: (x?.n ?? 0) + 1, append: true }));
    d.drawer('focus');
  };

  const flow = (kind: 'continue' | 'merge' | 'collapse' | 'collapseOthers', id: string) => {
    if (!pid) return;
    if (kind === 'collapse' || kind === 'collapseOthers') return store.setCollapsed(pid, collapseNext(collapsedOf(pid), d.os.map(rootOf), id, kind));
    const l = lane(pid, id);
    if (kind === 'continue') ui.setSessDlg({ k: 'laneContinue', projectId: pid, name: id });
    else if (l) askMerge(l);
  };

  /** §4.15 §4 a notification click: project, node, its tree / the Xong shelf's merged rows, its card in Chờ PO. */
  const focus = (t: NotifyTarget, keepList = false) => {
    if (!snap) return;
    const p = focusPlan(t, snap);
    if (!p.projectId) return;
    if (p.projectId !== pid) d.pickProject(p.projectId);
    if (p.expand) expand(p.projectId, p.expand);
    if (p.openDone) store.toggleDone(p.projectId, true);
    if (p.sel) ui.pick(p.sel);
    if (!keepList) ui.setListOn(false);
    if (p.cardId !== null) { ui.setFocusPick(p.cardId); ui.setFold({ folded: false, resolvedOpen: false }); d.drawer('card'); } else d.drawer('node');
  };

  /** ⌘K / list / deck: the same plan as a notification without card (hidden → its tree opens, done → the Xong shelf shows it).
   *  §4.8 N4-k a click in the F9 table keeps the table (`keepList`). */
  const openLane = (projectId: string, name: string, keepList = false) => focus({ cardId: null, projectId, lane: name }, keepList);

  const loadDone = (q: DoneQuery): Promise<DoneLanesPage | null> =>
    pid ? d.client.send({ cmd: 'done_lanes_list', projectId: pid, ...q }).then(r => r as DoneLanesPage, () => null) : Promise.resolve(null);

  const send = (c: Command) => void d.client.send(c).catch(() => {});
  /** the Inspector `done` prop (list pages, Nhờ … merge, VS Code, Chạy tiếp, Thử lại = watch again, re-measured if > 60 s). */
  const props: DoneProps = {
    total: store.get().deckUi.doneTotal[pid ?? ''] ?? null, cleanupDays: ui.sessions?.cleanupPeriodDays ?? 30, load: loadDone, onMerge: askMerge,
    onContinue: name => flow('continue', name), onVscode: path => send({ cmd: 'open_in_vscode', path }),
    onRetry: name => { if (pid) send({ cmd: 'watch', target: { kind: 'lane', projectId: pid, name } }); },
  };
  return { flow, openLane, focus, expand, props };
}
