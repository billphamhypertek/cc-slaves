// Wiring CardStore ↔ LaneManager / Orchestrators (spec §6.15, §7.7 po_ask, §6.11/§6.16/§6.17 system cards). Lane
// sessions go through the manager (reducer ask_open / ask_close, the outbox delivery path, the live process for
// control lines); any other session (the orchestrator) goes to `other`, or by default only to its outbox.
import { getMeta, setMeta, type Db } from '../db.ts';
import type { LaneManager, LaneUiEvent } from '../lane/manager.ts';
import type { OrchestratorEvent, Orchestrators } from '../orchestrator/session.ts';
import { contentOf, type Outbox } from '../outbox.ts';
import { act, ORCH_SOURCE, reasonBody, type CardSessions, type CardStore, type SystemCardKind } from './store.ts';
import type { KeyedReason } from '../../../shared/protocol.ts';

type LanePort = Pick<LaneManager, 'bySession' | 'askOpen' | 'askClose' | 'deliver' | 'writeControl'>;

export function laneCardSessions(m: LanePort, outbox: Outbox, other?: Partial<CardSessions>): CardSessions {
  const isLane = (sid: string) => m.bySession(sid) !== null;
  return {
    writeControl: (sid, line) => (isLane(sid) ? m.writeControl(sid, line) : (other?.writeControl?.(sid, line) ?? false)),
    askOpen: (sid, id) => { if (isLane(sid)) m.askOpen(sid, id).catch(() => {}); else other?.askOpen?.(sid, id); },
    askClose: (sid, id) => { if (isLane(sid)) m.askClose(sid, id).catch(() => {}); else other?.askClose?.(sid, id); },
    deliver: async (sid, draft) => {
      if (isLane(sid)) { await m.deliver(sid, contentOf(draft)); return; }
      if (other?.deliver) { await other.deliver(sid, draft); return; }
      outbox.enqueue(sid, draft.text, draft.prefix);
    },
  };
}

/** The orchestrator side of CardSessions (IMPORTANT-4): control lines to its live process, answers through `send`. */
export function orchestratorCardSessions(o: Pick<Orchestrators, 'writeControl' | 'deliver'>, outbox: Outbox): Partial<CardSessions> {
  return {
    writeControl: (sid, line) => o.writeControl(sid, line),
    deliver: async (sid, draft) => { if (!(await o.deliver(sid, draft))) outbox.enqueue(sid, draft.text, draft.prefix); },
  };
}

/** Lane events → cards: permission requests and cancels, a process exit, cards the lane cancelled itself. */
export function attachLaneCards(store: CardStore, m: Pick<LaneManager, 'on'>): void {
  m.on((e) => {
    if (e.type === 'control') {
      if (e.event.kind === 'can_use_tool') store.permission({ projectId: e.projectId, sessionId: e.sessionId, source: e.name, event: e.event });
      else store.cancelRequest(e.sessionId, e.event.requestId);
    } else if (e.type === 'session_exit') {
      store.cancelSession(e.sessionId);
    } else if (e.type === 'card' && !e.open) {
      store.sync(e.cardId);
    }
  });
}

/** Orchestrator events → permission cards (source `ORCH_SOURCE`, §6A rendered as the role name), cancelled on cancel / process exit. */
export function attachOrchestratorCards(store: CardStore, o: Pick<Orchestrators, 'on'>): void {
  o.on((e) => {
    if (e.type === 'control') {
      if (e.event.kind === 'can_use_tool') store.permission({ projectId: e.projectId, sessionId: e.sessionId, source: ORCH_SOURCE, event: e.event });
      else store.cancelRequest(e.sessionId, e.event.requestId);
    } else if (e.type === 'session_exit') {
      store.cancelSession(e.sessionId);
    } else if (e.type === 'session_ended') { // §4.14 its own pending PO asks expire on "Kết thúc phiên" (not on F21)
      store.cancelSession(e.sessionId);
      if (e.expireAsks) store.expireAsks(e.sessionId);
    }
  });
}

/** v2.1 §4.14 key of a session's "Điều phối ngừng" card (one per session, closed by that session only). */
const orchestratorDownKey = (sessionId: string): string => `orchestrator:${sessionId}`;

/** `meta` key: the last claude version that passed the start check (§6.17 F17). */
export const CLAUDE_VERSION_KEY = 'claude_version_checked';

/**
 * System cards (IMPORTANT-6): F11 orchestrator_down, lane broken, F16 logged_out, F17 cc_updated. One open card per
 * (kind, key, project) — CardStore.createSystem dedups; a card is resolved when its condition clears.
 */
export function attachSystemCards(
  store: CardStore, db: Db,
  src: { lanes?: Pick<LaneManager, 'on'>; orchestrators?: Pick<Orchestrators, 'on'> },
): void {
  const projectName = (id: string) =>
    db.query<{ name: string }, [string]>('SELECT name FROM project WHERE id = ?').get(id)?.name ?? id;
  /** §4.14 running orchestrator sessions of a project (the "#n" title when > 1). */
  const running = (id: string) => db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM session WHERE project_id = ? AND kind = 'orchestrator' AND ended_at IS NULL").get(id)?.n ?? 0;
  const seqOf = (sid: string) => db.query<{ seq: number | null }, [string]>('SELECT seq FROM session WHERE id = ?').get(sid)?.seq ?? null;
  const resolve = (kind: SystemCardKind, key: string, projectId: string | null) => {
    const c = store.findOpenSystem(kind, key, projectId);
    if (c) store.resolveSystem(c.id);
  };
  const loggedOut = (account: string) => store.createSystem({
    kind: 'logged_out', projectId: null, key: account,
    // v2 §6 F16: the button runs A6 straight away (card action `open_ccswitch` → `account_relogin`)
    titleKey: 'cards.loggedOut', params: { who: `${account.split('@')[0]}@` },
    actions: [act('cardText.act.relogin', 'account_relogin')],
  });
  const version = (e: { version: string; ok: boolean; message?: string; reason?: KeyedReason }) => {
    const checked = getMeta(db, CLAUDE_VERSION_KEY);
    if (e.ok && checked === null) { setMeta(db, CLAUDE_VERSION_KEY, e.version); return; } // first run: the baseline
    if (e.version === checked) return;
    if (e.ok) {
      setMeta(db, CLAUDE_VERSION_KEY, e.version);
      store.createSystem({
        kind: 'cc_updated', key: e.version, titleKey: 'cards.ccUpdatedOk', params: { version: e.version },
        bodyKey: 'cardText.body.ccUpdatedOk', actions: [act('cardText.act.seen', 'dismiss')],
      });
    } else {
      store.createSystem({
        kind: 'cc_updated', key: e.version, titleKey: 'cards.ccUpdatedBad', params: { version: e.version },
        ...reasonBody(e.message ?? null, e.reason), actions: [act('cardText.act.recheck', 'setup_check'), act('cardText.act.seen', 'dismiss')],
      });
    }
  };

  src.lanes?.on((e: LaneUiEvent) => {
    if (e.type === 'lane') {
      const key = `lane:${e.lane.name}`;
      if (e.lane.state === 'broken') {
        store.createSystem({
          kind: 'broken', projectId: e.lane.projectId, sessionId: e.lane.sessionId, key, titleKey: 'cards.laneBroken', params: { name: e.lane.name },
          ...reasonBody(e.lane.lastError, e.lane.lastErrorKeyed), // §6A engine-composed → keyed; Claude's text as sent
          actions: [
            act('cardText.act.resume', 'lane_resume', { projectId: e.lane.projectId, name: e.lane.name }),
            act('cardText.act.viewLog', 'view_log'), // UI-only: retargets the console
            act('cardText.act.handToOrch', 'hand_to_orchestrator', { projectId: e.lane.projectId, name: e.lane.name }),
          ],
        });
      } else {
        resolve('broken', key, e.lane.projectId);
      }
    } else if (e.type === 'account_logged_out') {
      loggedOut(e.account);
    } else if (e.type === 'claude_version') {
      version(e);
    }
  });

  src.orchestrators?.on((e: OrchestratorEvent) => {
    if (e.type === 'system_card') {
      const seq = seqOf(e.sessionId);
      const many = running(e.projectId) > 1 && seq !== null;
      const args = { sessionId: e.sessionId }; // §4.14 the buttons act on this session only
      store.createSystem({
        kind: 'orchestrator_down', projectId: e.projectId, sessionId: e.sessionId, key: orchestratorDownKey(e.sessionId),
        ...(many ? { titleKey: 'cards.orchestratorDownN' as const, params: { n: seq } } : { titleKey: 'cards.orchestratorDown' as const, params: { project: projectName(e.projectId) } }),
        ...reasonBody(e.reason, e.reasonKeyed),
        actions: [act('cardText.act.restart', 'restart_orchestrator', args), act('cardText.act.newSession', 'new_orchestrator', args)],
      });
    } else if (e.type === 'orchestrator') {
      const s = e.orchestrator.state;
      if (s === 'running' || s === 'idle') {
        resolve('orchestrator_down', orchestratorDownKey(e.orchestrator.sessionId), e.orchestrator.projectId);
        resolve('orchestrator_down', 'orchestrator', e.orchestrator.projectId); // a pre-v2.1 card (one per project)
      }
    } else if (e.type === 'session_ended') {
      resolve('orchestrator_down', orchestratorDownKey(e.sessionId), e.projectId);
    } else if (e.type === 'account_logged_out') {
      loggedOut(e.account);
    } else if (e.type === 'claude_version') {
      version(e);
    }
  });
}
