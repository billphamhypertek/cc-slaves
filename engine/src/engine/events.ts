// Engine event wiring (spec §6.3, v2.1 §5.3): lane / orchestrator / card events → WS hub, notifier, stats push.
import type { LaneState, Target } from '../../../shared/protocol.ts';
import { boundaryLine, ModelLines } from '../server/session-views.ts';
import type { SystemPayload } from '../cards/store.ts';
import { getLane } from '../db.ts';
import { branchTrigger } from '../lane/branch.ts';
import { toLines, writePoLine } from '../server/lines.ts';
import { t } from '../../../shared/i18n/index.ts';
import { sameTarget, type Conn } from '../server/ws.ts';
import type { StreamEvent } from '../stream/parser.ts';
import type { Engine } from '../engine.ts';

/** v2.1 §5.3 push `stats` at most once per throttle window (a burst of assistant lines → one push). */
export function scheduleStats(eng: Engine): void {
  if (eng.statsTimer !== null || eng.stopped || eng.hub.size === 0) return; // no client → no query (a new one gets them in its snapshot)
  eng.statsTimer = setTimeout(() => {
    eng.statsTimer = null;
    if (!eng.stopped && eng.hub.size > 0) eng.hub.broadcast({ type: 'stats', stats: eng.tokenStats() });
  }, eng.o.statsThrottleMs ?? 2_000);
}

// ---------- events ----------

/** §7.1 / §4.15 §4 boot: each live lane's last known state from state.db, so a restored lane whose first event is
 *  "done" still notifies. No account (the old process is gone): the first event's account is never a "switch". */
export function seedPrevLanes(eng: Engine): void {
  const rows = eng.db.query<{ project_id: string; name: string; state: LaneState; phase: string | null }, []>(
    "SELECT project_id, name, state, phase FROM lane WHERE state <> 'done'").all();
  for (const r of rows) eng.prevLane.set(`${r.project_id}\u0000${r.name}`, { state: r.state, phase: r.phase, account: null, seeded: true });
}

export function wire(eng: Engine): void {
  eng.outbox.onAttachMissing((sid, _uuid, names) => missingLine(eng, sid, names));
  const modelLines = new ModelLines((sessionId, line) => { // v2.4 §4.3 (a failed change has no line: G2's toast)
    if (eng.stopped) return;
    const t = eng.targetOfSession(sessionId);
    const lines = eng.lines.append(sessionId, [line]);
    if (t) eng.hub.broadcast({ type: 'stream', target: t, lines });
  }, () => eng.config.ui?.lang ?? 'vi');
  eng.lanes.on((e) => {
    if (e.type === 'lane') {
      const v = eng.laneView(e.lane.projectId, e.lane.name);
      if (v) eng.hub.broadcast({ type: 'lane', lane: v });
      eng.scheduleStats();
      const k = `${e.lane.projectId}\u0000${e.lane.name}`;
      const prev = eng.prevLane.get(k);
      eng.prevLane.set(k, { state: e.lane.state, phase: e.lane.phase, account: e.lane.account });
      if (prev?.state !== e.lane.state || prev.phase !== e.lane.phase) eng.issues.changed(e.lane.projectId); // v2.7 lane cluster / hand-back
      if (v && branchTrigger(prev?.seeded ? undefined : prev, e.lane, v.branch != null)) { // seeded: the first-event rule // §4.15 reported done / entered done
        const row = getLane(eng.db, e.lane.projectId, e.lane.name);
        if (row) void eng.branches.measure(row);
      }
      if (prev && prev.state !== 'done' && e.lane.state === 'done') void eng.notifier.laneDone(e.lane.projectId, e.lane.name);
      if (prev && prev.account !== null && e.lane.account !== null && prev.account !== e.lane.account) {
        void eng.notifier.accountSwitch(e.lane.projectId, e.lane.name, e.lane.account);
      }
      if (prev?.account !== e.lane.account) for (const a of [prev?.account, e.lane.account]) if (a) eng.broadcastAccount(a);
      eng.syncCutover();
    } else if (e.type === 'task') {
      const t: Target = { kind: 'lane', projectId: e.projectId, name: e.name };
      const changed = e.event.kind === 'result' ? eng.subagents.turnEnded(t) : eng.subagents.task(t, e.event);
      if (changed) eng.hub.broadcast({ type: 'subagents', target: t, subagents: eng.subagents.list(t) });
    } else if (e.type === 'model_change') { // v2.4 §5.6 the §4.3 line in the lane's conversation
      if (!e.error) modelLines.change(e.sessionId, e.from, e.to);
    } else if (e.type === 'stream') {
      const v = eng.lanes.get(e.projectId, e.name);
      if (v) stream(eng, { kind: 'lane', projectId: e.projectId, name: e.name }, v.sessionId, e.event, () => modelLines.flush(v.sessionId));
      if (v) eng.code.stream(e.projectId, `lane\u0000${e.projectId}\u0000${e.name}`, v.cwd, e.event); // v2.3 §10.2 (a) (d)
    } else if (e.type === 'session_exit') {
      endBlocks(eng, e.sessionId);
    } else if (e.type === 'remind') {
      void eng.notifier.remind(e);
    } else if (e.type === 'claude_version') {
      eng.versionSeen(e);
    }
  });
  eng.orchestrators.on((e) => {
    if (e.type === 'model_change') { if (!e.error) modelLines.change(e.sessionId, e.from, e.to); }
    else if (e.type === 'orchestrator') {
      eng.hub.broadcast({ type: 'orchestrator', orchestrator: eng.orchView(e.orchestrator) });
      eng.scheduleStats();
    }
    else if (e.type === 'stream') {
      stream(eng, { kind: 'orchestrator', projectId: e.projectId, sessionId: e.sessionId }, e.sessionId, e.event, () => modelLines.flush(e.sessionId));
      const dir = eng.projectRow(e.projectId)?.path;
      if (dir) eng.code.stream(e.projectId, e.sessionId, dir, e.event); // v2.3 §10.2 (d) the orchestrator runs in the project dir
    }
    else if (e.type === 'boundary') { // §4.14 a session's own history starts / ends with a boundary line
      modelLines.flush(e.sessionId); // R14 a pending §4.3 line goes first
      const lines = eng.lines.append(e.sessionId, [boundaryLine(e.boundary)]);
      eng.hub.broadcast({ type: 'stream', target: { kind: 'orchestrator', projectId: e.projectId, sessionId: e.sessionId }, lines });
    }
    else if (e.type === 'po_line') { // v2.4 §10.2 a moved echoed row's `po` line, in the receiving session's conversation
      // G3d ⑥: the target names the receiving session itself, also for a replacer not yet routed (its own history)
      writePoLine(eng, { kind: 'orchestrator', projectId: e.projectId, sessionId: e.sessionId }, e.sessionId, e.line);
    }
    else if (e.type === 'session_exit') endBlocks(eng, e.sessionId);
    else if (e.type === 'session_ended') {
      endBlocks(eng, e.sessionId);
      eng.hub.broadcast({ type: 'session_ended', projectId: e.projectId, sessionId: e.sessionId });
    }
    else if (e.type === 'claude_version') eng.versionSeen(e);
  });
  eng.cards.on((e) => {
    eng.hub.broadcast({ type: 'card', card: eng.cardViewOf(e.card) });
    if (e.card.kind === 'logged_out') eng.broadcastAccount((e.card.payload as SystemPayload).key ?? '');
    if (e.type === 'card_created' && e.card.status === 'open') void eng.notifier.card(e.card);
    if (e.card.sessionId) {
      const t = eng.targetOfSession(e.card.sessionId);
      if (t?.kind === 'lane') { const v = eng.laneView(t.projectId, t.name); if (v) eng.hub.broadcast({ type: 'lane', lane: v }); }
    }
  });
}

/** §6.3 A4 / R13 one `engine` line for a message written without some of its attachments. */
function missingLine(eng: Engine, sessionId: string, names: string[]): void {
  const lines = eng.lines.append(sessionId, [{ kind: 'engine', text: t(eng.config.ui?.lang ?? 'vi', 'console.attachMissing', { names: names.join(', ') }), parentToolUseId: null }]);
  const to = eng.targetOfSession(sessionId);
  if (to) eng.hub.broadcast({ type: 'stream', target: to, lines });
}

/** `beforeAppend`: runs right before lines are appended to the session (R14 the pending §4.3 line). */
export function stream(eng: Engine, t: Target, sessionId: string, ev: StreamEvent, beforeAppend?: () => void): void {
  if (ev.kind === 'stream_event') { // v2.2 §14.4 always into the ledger; broadcast only to watchers
    const out = eng.blocks.event(sessionId, t, ev);
    if (out.length > 0 && eng.hub.watched(t)) for (const o of out) eng.hub.broadcast({ ...o, target: t });
    return;
  }
  if (ev.kind === 'result') { endBlocks(eng, sessionId); return; }
  if (ev.kind === 'user' && ev.isReplay && ev.ours && ev.uuid && eng.outbox.echoed(ev.uuid)) return; // §10.2 shown at send
  const lines = toLines(ev, eng.blocks.stamp(sessionId, ev));
  if (lines.length === 0) return;
  const pending = eng.inTurnSent.get(sessionId);
  if (pending) {
    for (const l of lines) {
      const i = l.kind === 'po' ? pending.indexOf(l.text) : -1;
      if (i >= 0) { l.inTurn = true; pending.splice(i, 1); }
    }
    if (pending.length === 0) eng.inTurnSent.delete(sessionId);
  }
  beforeAppend?.();
  eng.hub.broadcast({ type: 'stream', target: t, lines: eng.lines.append(sessionId, lines) });
}

/** v2.2 §14.4 the turn ended (`result`) or the process died (`session_exit` / `session_ended`): close what is still
 *  open for its watchers, forget the session's blocks. */
function endBlocks(eng: Engine, sessionId: string): void {
  for (const { meta, out } of eng.blocks.end(sessionId)) if (eng.hub.watched(meta)) eng.hub.broadcast({ ...out, target: meta });
}

/** v2.2 §14.4 a `watch` mid-stream: the held text of the watched target's open blocks (`full`), before any later delta. */
export function sendHeld(eng: Engine, c: Conn): void {
  const w = c.watch;
  if (w === null) return;
  for (const { meta, out } of eng.blocks.open((t) => sameTarget(w, t))) c.send({ type: 'event', event: { ...out, target: meta } });
}

export function versionSeen(eng: Engine, e: { version: string; ok: boolean; message?: string }): void {
  eng.claudeVersion = e.version;
  const before = eng.compat;
  eng.compat = e.ok ? null : { version: e.version, message: e.message ?? 'không qua kiểm tra tương thích' };
  if ((before === null) !== (eng.compat === null) || before?.version !== eng.compat?.version) {
    eng.hub.broadcast({ type: 'engine', engine: eng.engineInfo() });
  }
}
