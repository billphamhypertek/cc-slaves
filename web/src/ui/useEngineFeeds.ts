// What the shell pulls from / reacts to in the engine feed: the watched stream + its history pages (M16, I6), new pending
// cards (toast, drawer, F14; the chime comes from the engine's `notify`, lib/chime.ts) and the unread dot / pending count per project tab.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { LaneView, Snapshot, StreamLine, SubagentView, Target } from '../../../shared/protocol.ts';
import { notifyMatrix, notifyOn } from '../../../shared/notify-prefs.ts';
import { countsOn, isPending } from '../lib/cards.ts';
import type { DrawerEvent } from '../lib/inspector.ts';
import type { Tr } from '../lib/i18n.tsx';
import type { StreamBuffer } from '../lib/console.ts';
import { targetKey, type ConnStatus, type Store } from '../lib/store.ts';
import type { EngineClient } from '../lib/ws.ts';
import type { AppState } from './useAppState.ts';

export const PAGE = 100;

/** Watch + newest history page for the current target (M16), on every switch and after every reconnect (I6). */
export function useStreamWatch(client: EngineClient, store: Store, target: Target | null, connStatus: ConnStatus, loadingOlder: AppState['loadingOlder']) {
  const tk = target ? targetKey(target) : null;
  useEffect(() => {
    if (!target || connStatus !== 'open') return;
    store.watching(target); // v2.2 §14.4 blocks the engine does not re-send as `full` closed meanwhile
    void client.send({ cmd: 'watch', target }).catch(() => {});
    // I6: always ask for the newest page — lines from while the PO looked elsewhere / was offline never came live
    client.send({ cmd: 'history', target, limit: PAGE }).then(r => store.resync(target, (r as StreamLine[]) ?? [], PAGE)).catch(() => {});
  }, [tk, connStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  return useCallback(() => {
    if (!target || loadingOlder.current) return;
    const first = store.get().streams[targetKey(target)]?.lines[0];
    if (!first) return;
    loadingOlder.current = true;
    client.send({ cmd: 'history', target, beforeSeq: Math.floor(first.seq), limit: PAGE })
      .then(r => store.history(target, (r as StreamLine[]) ?? [], PAGE)).catch(() => {}).finally(() => { loadingOlder.current = false; });
  }, [client, store, target, loadingOlder]);
}

/** New pending cards: slide-in mark, toast (Cài đặt › Thông báo "Trong app"), F14 drawer auto-open (U1: they append at the bottom). */
export function useNewCards(snap: Snapshot | null, ui: AppState, store: Store, tr: Tr, drawer: (e: DrawerEvent) => void) {
  const { seenCards, setNewIds, setFold } = ui;
  useEffect(() => {
    if (!snap) return;
    const all = snap.cards.filter(isPending);
    if (seenCards.current === null) { seenCards.current = new Set(snap.cards.map(c => c.id)); return; }
    const fresh = all.filter(c => !seenCards.current!.has(c.id));
    snap.cards.forEach(c => seenCards.current!.add(c.id));
    if (!fresh.length) return;
    setNewIds(new Set(fresh.map(c => c.id)));
    const first = fresh[0]!;
    if (notifyOn(notifyMatrix(snap.config.notify), first.kind, 'app', true)) {
      store.toast('info', tr('app.newCard', { who: first.source === 'orchestrator' ? tr('console.whoOrch') : first.source ?? 'engine' }));
    }
    setFold({ folded: false, resolvedOpen: false }); // §4.11b a new card unfolds the block (v1 F14)
    drawer('card'); // §4.10 the narrow drawer opens itself like the v1 F14 box
  }, [snap?.cards]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Unread dot per project tab + the pending count per project. */
export function useUnread(snap: Snapshot | null, pid: string | null, ui: AppState, inUndo: ReadonlySet<number>) {
  const { seenAt, setSeenAt } = ui;
  const activity = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of snap?.lanes ?? []) m[l.projectId] = Math.max(m[l.projectId] ?? 0, l.updatedAt);
    for (const c of snap?.cards ?? []) if (c.projectId) m[c.projectId] = Math.max(m[c.projectId] ?? 0, c.createdAt);
    return m;
  }, [snap]);
  useEffect(() => { if (pid) setSeenAt(s => ({ ...s, [pid]: Math.max(s[pid] ?? 0, activity[pid] ?? 0, Date.now()) })); }, [pid, activity, setSeenAt]);
  const firstSeen = useRef(Date.now());
  const unread = new Set(Object.keys(activity).filter(p => activity[p]! > (seenAt[p] ?? firstSeen.current)));
  const pendingByProject: Record<string, number> = {};
  for (const c of snap?.cards ?? []) if (isPending(c) && !inUndo.has(c.id)) for (const p of snap!.projects) if (countsOn(c, p.id)) pendingByProject[p.id] = (pendingByProject[p.id] ?? 0) + 1;
  return { unread, pendingByProject };
}

/** F25: load the subagent's history once when it is opened; live lines come with the lane stream (parentToolUseId). */
export function useSubHistory(client: EngineClient, ui: AppState, sub: SubagentView | null, selLaneV: LaneView | null) {
  const { subHist, setSubHist } = ui;
  const laneT = (projectId: string, name: string): Target => ({ kind: 'lane', projectId, name });
  useEffect(() => {
    if (!sub || !selLaneV || subHist[sub.taskId] !== undefined) return;
    setSubHist(h => ({ ...h, [sub.taskId]: null }));
    client.send({ cmd: 'subagent_history', target: laneT(selLaneV.projectId, selLaneV.name), taskId: sub.taskId })
      .then(r => setSubHist(h => ({ ...h, [sub.taskId]: (r as StreamLine[]) ?? [] }))).catch(() => setSubHist(h => ({ ...h, [sub.taskId]: [] })));
  }, [sub?.taskId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The opened subagent's lines: its loaded history + the live lane lines it owns, by seq. */
export const subLinesOf = (sub: SubagentView | null, subHist: AppState['subHist'], stream: StreamBuffer | undefined): StreamLine[] => sub ? (() => {
  const m = new Map<number, StreamLine>();
  for (const l of subHist[sub.taskId] ?? []) m.set(l.seq, l);
  for (const l of stream?.lines ?? []) if (l.parentToolUseId === sub.toolUseId) m.set(l.seq, l);
  return [...m.values()].sort((a, b) => a.seq - b.seq);
})() : [];

/** One target's stream buffer (`tk`): re-renders only when that buffer changes, never on a reveal frame (perf audit C3). */
export function useStream(store: Store, tk: string | null): StreamBuffer | undefined {
  const get = useCallback(() => (tk ? store.get().streams[tk] : undefined), [store, tk]);
  return useSyncExternalStore(store.subscribe, get, get);
}
