// Orchestrator sessions of every project (`Orchestrators`); one session is `session/orchestrator.ts` (spec §7.5, §4.14).
import { randomUUID } from 'node:crypto';
import { listUndelivered } from '../db.ts';
import { PREFIX, type Draft } from '../outbox.ts';
import type { KeyedReason, ResumePreview, TokenCounts } from '../../../shared/protocol.ts';
import { CONTEXT_WINDOW, contextPct } from '../stream/parser.ts';
import {
  agoText, cleanupPeriodDays, contextHigh, estimateFirstTurn, quotaSamples, resumeFirstText, transcriptInfo,
} from './resume.ts';
import { paths } from '../paths.ts';
import type { Key } from '../../../shared/i18n/index.ts';
import {
  adoptOrphans, designTitle, laneCameText, laneGoneText, lanesReceivedText, moveLanes, ownerOf, parallelFirstText,
  recordHandover, renameSession, seqOf, SessionError, sessionTitle, sinceStop, sinceStopText, TITLE_MAX,
} from './owners.ts';
import { capReached, type OrchKind } from '../../../shared/issues.ts';
import { getSpec, listSpecs, moveSpecBindings, updateSpec } from '../issues/store.ts';
import { newSessionPin, projectWorkflow } from '../workflow/runtime.ts';
import { orchAccount } from './session/account.ts';
import { hasFiveWindow } from '../accounts/quota.ts';
import { sessionModelView } from '../session/model-control.ts';
import { Orchestrator } from './session/orchestrator.ts';
import { endHandoffPathFor, kr, todayIso } from './session/texts.ts';
import type { Boundary, EndedRow, EndReason, KindInput, OpenInput, OrchestratorDeps, OrchestratorEvent, OrchestratorState, ResumeInput, SessionRow } from './session/types.ts';

export { Orchestrator } from './session/orchestrator.ts';
export { newSessionText } from './session/texts.ts';
export type { Boundary, OrchestratorDeps, OrchestratorEvent, OrchestratorState, OrchestratorView } from './session/types.ts';

/**
 * Every running orchestrator session, keyed by session id (v2.1 §4.14: up to 3 per project, a stopped one included).
 * `notify` is the LaneManager notify sink (lane → owner session notices, §7.4 / §4.14).
 */
export class Orchestrators {
  private bySid = new Map<string, Orchestrator>();
  /** §4.14 sessions whose `session_end` is running (handoff turn) → the session taking their lanes. */
  private readonly closing = new Map<string, Orchestrator>();
  /**
   * §4.14 "Thay phiên": the session taking a replaced one's place, kept out of `bySid` (not counted, not listed) until the
   * replaced one has ended, so the project never shows 4 running. It already receives the replaced one's messages.
   */
  private readonly replacers = new Set<Orchestrator>();
  private readonly listeners: ((e: OrchestratorEvent) => void)[] = [];
  /** v2.7 §5.2-5 `closeWhenIdle`: sessions to end at their next idle (spec_close → handoff → end). */
  private readonly idleWaits = new Map<string, () => void>();

  constructor(private readonly d: OrchestratorDeps) {}

  on(f: (e: OrchestratorEvent) => void): void { this.listeners.push(f); }

  /** §4.14 a project's running sessions in open order. */
  list(projectId: string): Orchestrator[] { return [...this.bySid.values()].filter((o) => o.projectId === projectId); }

  /** The project's first running session that is not ending (v1 callers: PO send without a session, F2); null = none. */
  get(projectId: string): Orchestrator | null { return this.live(projectId)[0] ?? null; }

  /** §4.14 running sessions that are not ending, in open order (receivers, notices). */
  private live(projectId: string): Orchestrator[] { return this.list(projectId).filter((o) => !this.closing.has(o.currentSessionId)); }

  /**
   * §4.14 where a message that names `sessionId` goes: the session itself, or — while it ends — the session taking its
   * lanes (followed when that one ends too, else the project's first live session). Null = no such running session.
   */
  route(sessionId: string): Orchestrator | null {
    let o = this.bySid.get(sessionId) ?? null;
    for (let hops = 0; o && this.closing.has(o.currentSessionId) && hops <= this.bySid.size; hops++) o = this.settle(o, this.closing.get(o.currentSessionId)!);
    return o;
  }

  /** The receiver `to` of `from`, or, when it is gone or ending itself, the project's first live session. */
  private settle(from: Orchestrator, to: Orchestrator): Orchestrator | null {
    if (this.bySid.get(to.currentSessionId) === to || this.replacers.has(to)) return to;
    return this.get(from.projectId);
  }

  /** Every running session of every project. */
  all(): Orchestrator[] { return [...this.bySid.values()]; }
  /** §4.14 accounts a live session orchestrates on right now. */
  busyAccounts(): string[] { return [...new Set(this.all().map((o) => o.view().account).filter((a): a is string => a !== null))]; }

  /** v2.1 §5.3 running turns' provisional tokens (not stored yet), for today / 5 h stats. */
  provisionalTokens(): { projectId: string; tokens: TokenCounts }[] {
    return this.all().map((o) => ({ projectId: o.projectId, tokens: o.provisionalTokens }));
  }

  /**
   * A new orchestrator session for a project (its first message: `first`, default a start note). `hold` (hotfix
   * 2026-11-16 `project_add`): the row and its first message are written, the session waits `paused` (no process).
   */
  async start(projectId: string, first?: string, hold = false): Promise<Orchestrator> {
    this.cap(projectId, 'general');
    const p = this.project(projectId);
    const o = this.register(this.make(projectId, (this.d.newSessionId ?? randomUUID)(), p, { account: p.home, ...(hold ? { state: 'paused' as const } : {}) }));
    o.newSessionRow(newSessionPin(this.d.db, projectId, 'general', null));
    if (first !== undefined) this.d.outbox.enqueue(o.currentSessionId, first, PREFIX.engine);
    this.adopt(o);
    if (!hold) o.bootLater(); // hf1117-perf the reply goes before the claude boot
    return o;
  }

  /**
   * §4.14 "Mở phiên song song": next #n, optional title (empty → first 24 chars of `first`), first message (default
   * `parallelFirstText`), account given or auto (accounts orchestrating another session rank after). Refused at 3.
   */
  async open(projectId: string, i: OpenInput): Promise<Orchestrator> {
    const replace = i.replaceId !== undefined ? this.target(projectId, i.replaceId) : null;
    if (!replace) this.cap(projectId, 'general'); // "Thay" frees the replaced one's place
    if (i.title !== undefined && i.title.trim().length > TITLE_MAX) {
      throw new SessionError('bad_input', { key: 'errors.titleTooLong', params: { max: TITLE_MAX } });
    }
    const p = this.project(projectId);
    const explicit = i.account?.trim() || null;
    const busy = this.busyAccounts();
    const home = explicit ?? p.home;
    const o = this.make(projectId, (this.d.newSessionId ?? randomUUID)(), { ...p, home },
      { account: home, ...(explicit ? {} : { avoid: busy.length ? busy : [] }) });
    o.newSessionRow(newSessionPin(this.d.db, projectId, 'general', null), sessionTitle(i.title, i.first));
    const first = i.first?.trim() ? i.first : parallelFirstText(o.view().seq ?? 0, p.name);
    this.d.outbox.enqueue(o.currentSessionId, first, PREFIX.engine);
    if (replace) {
      try { await this.replaceWith(replace, o); } catch (err) {
        this.d.db.query('DELETE FROM outbox WHERE session_id = ?1').run(o.currentSessionId); // never started: no trace
        this.d.db.query('DELETE FROM session WHERE id = ?1').run(o.currentSessionId);
        throw err;
      }
      o.inheritModel(replace); // v2.4 §5.1 after its end: a change it had waiting is its pick by now
    }
    o.presetModel(i.model, i.effort); // v2.4 §5.5 the dialog's picks win over inherited ones
    this.register(o);
    this.adopt(o);
    o.bootLater();
    return o;
  }

  /**
   * v2.7 §5.0 open a session by kind. Chung = `open` (today's path). Thiết kế: title "Thiết kế · HH:MM" until spec_draft
   * names it; bound to `specId` when it edits one (draft / the next doc step → step_session, approved / active → edit_session). Build: bound
   * to its spec (build_session); `resume` = `claude --resume <id>` of a session made outside cc-slaves, spawned in its cwd.
   * R34 the cap counts Thiết kế + Build only. Bindings are written before the boot (R-B8: the row exists already).
   */
  async openKind(projectId: string, i: KindInput): Promise<Orchestrator> {
    if (i.kind === 'general') return this.open(projectId, { first: i.firstMessage });
    this.cap(projectId, i.kind);
    const p = this.project(projectId);
    const spec = i.specId === undefined ? null : getSpec(this.d.db, i.specId);
    if ((i.kind === 'build' && !spec) || (spec && spec.projectId !== projectId)) {
      throw new SessionError('bad_input', { key: 'errors.noSpec', params: { id: i.specId ?? '?' } });
    }
    const explicit = i.account?.trim() || null; // v2.7.1 §7.4 hand-picked (checked by the caller) = its home, like `open`
    const home = explicit ?? this.autoAccount(projectId) ?? p.home; // Tự chọn = session_pick's account (one function)
    const sid = i.resume?.sessionId ?? (this.d.newSessionId ?? randomUUID)();
    const o = this.make(projectId, sid, { home, path: i.resume?.cwd ?? p.path },
      { account: home, kind: i.kind });
    o.newSessionRow(newSessionPin(this.d.db, projectId, i.kind, spec, i.step),
      i.kind === 'design' ? designTitle(this.nowS() * 1000) : sessionTitle(`Build · ${spec!.title}`, null));
    if (i.resume) o.adoptExternal();
    o.presetModel(i.model, i.effort); // v2.4 §5.5 path, applied before the boot (hf1117: the ack still goes at once)
    this.d.outbox.enqueue(o.currentSessionId, i.firstMessage, PREFIX.engine);
    this.register(o);
    this.adopt(o);
    if (spec) {
      const bind = i.kind === 'build' ? { buildSession: sid } : spec.state === 'draft' || i.step !== undefined ? { designSession: sid } : { editSession: sid };
      updateSpec(this.d.db, spec.id, bind);
    }
    o.bootLater();
    return o;
  }

  /**
   * v2.7.1 §7.4 the account "Tự chọn" opens a Thiết kế / Build session on — the boot's own rule (`bootNow`): the project
   * home when it has room, else a primary soft fallback; accounts orchestrating another session rank after. Null = none.
   */
  autoAccount(projectId: string): string | null {
    const home = this.project(projectId).home, now = this.nowS(), busy = this.busyAccounts();
    return (busy.length ? orchAccount(this.d, home, busy, now, true) : null) ?? orchAccount(this.d, home, [], now, true);
  }

  /** v2.7 §4.7 the hook G2b calls on `spec_draft`: the Thiết kế session takes the spec title (≤ 24 chars). */
  titleFromSpec(sessionId: string, specTitle: string): string | null {
    return this.rename(sessionId, specTitle.trim().slice(0, TITLE_MAX));
  }

  /**
   * v2.7 §5.2-5 `spec_close` → the Build session ends at its next idle: "Kết thúc phiên" (handoff asked, lanes to the
   * Chung session). Resolves with the end result.
   */
  closeWhenIdle(sessionId: string): Promise<Awaited<ReturnType<Orchestrators['end']>>> {
    const o = this.bySid.get(sessionId);
    if (!o) return Promise.reject(new SessionError('no_session', { key: 'errors.noSession', params: { id: sessionId } }));
    return new Promise((resolve, reject) => {
      const go = () => { this.idleWaits.delete(sessionId); this.end(sessionId, undefined, 'handoff').then(resolve, reject); };
      if (o.view().state === 'idle') go(); else this.idleWaits.set(sessionId, go);
    });
  }

  /** §4.14 "Thay phiên": `replaced` ends (handoff) with `by` pending as its receiver. */
  private async replaceWith(replaced: Orchestrator, by: Orchestrator): Promise<void> {
    this.replacers.add(by);
    try { await this.end(replaced.currentSessionId, by, 'replaced'); } finally { this.replacers.delete(by); }
  }

  /** §4.14 a running, not ending session of the project ("Thay phiên" target). */
  private target(projectId: string, sessionId: string): Orchestrator {
    const o = this.bySid.get(sessionId);
    if (!o || o.projectId !== projectId || this.closing.has(sessionId)) throw new SessionError('no_session', { key: 'errors.noSession', params: { id: sessionId } });
    return o;
  }

  private endedRow(sessionId: string): EndedRow {
    const r = this.d.db.query<EndedRow, [string]>("SELECT * FROM session WHERE id = ? AND kind = 'orchestrator'").get(sessionId);
    if (!r) throw new SessionError('no_session', { key: 'errors.noSession', params: { id: sessionId } });
    return r;
  }

  /**
   * §4.14 the last account if it still has room and no other session orchestrates on it (M3), else the orchestrator
   * rule (project home → fallback; busy accounts rank after) + why.
   */
  private resumeAccount(r: EndedRow, explicit?: string): { account: string | null; reason: KeyedReason | null } {
    if (explicit) return { account: explicit, reason: null };
    const now = this.nowS();
    const last = r.account, busy = this.busyAccounts(), home = this.project(r.project_id).home;
    const taken = last !== null && busy.includes(last);
    if (last && !taken && orchAccount(this.d, last, [], now) === last) return { account: last, reason: null };
    const not = last ? [last] : [];
    const to = orchAccount(this.d, home, [...not, ...busy], now) ?? orchAccount(this.d, home, not, now);
    if (!last) return { account: to, reason: null };
    if (taken) return { account: to, reason: kr('console.resumeLastBusy', { account: last, n: r.seq ?? '?' }) };
    const q = this.d.quota.get(last); // D103 an Ultra account has no 5-hour window: what is left of its week
    const five = hasFiveWindow(this.d.accounts().find((a) => a.email === last)?.planTier ?? null, q);
    const left = Math.max(0, Math.round(100 - ((five ? q?.fivePct : q?.weekPct) ?? 100)));
    return { account: to, reason: kr('console.resumeLastLow', { account: last, n: r.seq ?? '?', left }) };
  }

  private nowS(): number { return (this.d.now ?? (() => Math.floor(Date.now() / 1000)))(); }

  /**
   * §4.14 "Chạy tiếp…" dialog: context, first-turn estimate, account (+ why not the last one), "Từ lúc dừng", whether
   * parallel is allowed, and whether it can be resumed at all (live process → never; never answered; transcript gone).
   */
  preview(sessionId: string): ResumePreview {
    const { db } = this.d;
    const r = this.endedRow(sessionId);
    const { reason, expiresInDays, cleanupPeriodDays: days } = this.resumability(r);
    const choice = this.resumeAccount(r);
    const running = this.list(r.project_id).length;
    const max = this.maxSessions(r.project_id);
    const capped = capReached(this.kinds(r.project_id), r.orch_kind, max);
    return {
      sessionId, projectId: r.project_id, seq: r.seq, title: r.title, resumable: reason === null, reason,
      ctxLast: r.ctx_last, ctxWindow: CONTEXT_WINDOW, ctxPct: r.ctx_last === null ? null : contextPct(r.ctx_last, null),
      ctxHigh: contextHigh(r.ctx_last, CONTEXT_WINDOW),
      estimate: choice.account ? estimateFirstTurn(r.ctx_last, quotaSamples(db, choice.account)) : null,
      account: choice.account, accountLast: r.account, accountReason: choice.reason,
      sinceStop: sinceStop(db, sessionId), parallelAllowed: !capped, running, max,
      handoffPath: r.handoff_path, expiresInDays, cleanupPeriodDays: days, ...sessionModelView(db, sessionId),
    };
  }

  /** §4.14 "Không chạy tiếp được": live process → never; never answered; transcript deleted (cleanupPeriodDays). */
  resumability(row: EndedRow | string): { reason: KeyedReason | null; expiresInDays: number | null; cleanupPeriodDays: number } {
    const r = typeof row === 'string' ? this.endedRow(row) : row;
    const home = paths().claudeHome;
    const days = cleanupPeriodDays(home);
    const tr = transcriptInfo(home, this.project(r.project_id).path, r.id, this.nowS());
    const answered = this.d.db.query("SELECT 1 FROM event WHERE session_id = ? AND type = 'result' LIMIT 1").get(r.id) !== null;
    const n = r.seq ?? '?';
    let reason: KeyedReason | null = null;
    if (this.bySid.has(r.id) || r.ended_at === null) reason = kr('errors.sessionLive', { n });
    else if (!answered) reason = kr('errors.neverAnswered', { n });
    else if (!tr.exists) reason = kr('errors.noTranscript', { days });
    return { reason, expiresInDays: tr.expiresInDays, cleanupPeriodDays: days };
  }

  /**
   * §4.14 "Chạy tiếp": `claude --resume <same id>` (no fork), same #n, its root goes last. Never while that id has a
   * process: the lock is the row's `ended_at = NULL`, written before the first await (a second resume sees it as live).
   * Parallel counts to the cap; "Thay" ends `replaceId` (handoff, its lanes move here).
   */
  async resume(sessionId: string, i: ResumeInput): Promise<Orchestrator> {
    const pv = this.preview(sessionId);
    if (!pv.resumable) {
      throw new SessionError(pv.reason!.key === 'errors.sessionLive' ? 'session_live' : 'not_resumable', { key: pv.reason!.key as Key, params: pv.reason!.params ?? {} });
    }
    const projectId = pv.projectId;
    const replace = i.mode === 'replace' ? this.target(projectId, i.replaceId ?? this.get(projectId)?.currentSessionId ?? '') : null;
    const { db } = this.d;
    const r = this.endedRow(sessionId);
    if (!replace) this.cap(projectId, r.orch_kind);
    const choice = this.resumeAccount(r, i.account?.trim() || undefined);
    const at = this.nowS();
    // opened_at: the open order a restart restores (MINOR-1 "gốc xếp cuối")
    db.query("UPDATE session SET ended_at = NULL, end_reason = NULL, state = 'starting', opened_at = ?3, account = COALESCE(?1, account), account_home = COALESCE(?1, account_home) WHERE id = ?2")
      .run(choice.account, sessionId, Date.now());
    const p = this.project(projectId);
    const o = this.make(projectId, sessionId, { path: r.cwd ?? p.path, home: choice.account ?? p.home }, { account: choice.account ?? r.account, kind: r.orch_kind });
    o.resumeNote = resumeFirstText(agoText(at - (r.ended_at ?? at)), pv.sinceStop.map(sinceStopText));
    const boundary: Boundary = { type: 'resume', seq: r.seq, at, account: choice.account, mode: i.mode, replaced: replace?.view().seq ?? null };
    for (const f of this.listeners) f({ type: 'boundary', projectId, sessionId, boundary });
    if (replace) {
      try { await this.replaceWith(replace, o); } catch (err) { // roll back: the session stays ended
        db.query("UPDATE session SET ended_at = ?, end_reason = ?, state = 'done', opened_at = ? WHERE id = ?").run(r.ended_at, r.end_reason, r.opened_at, sessionId);
        throw err;
      }
    }
    o.presetModel(i.model, i.effort); // v2.4 §5.5 (after a "Thay" that went through: a failed one leaves the row as it was)
    this.register(o);
    this.adopt(o);
    o.bootLater();
    return o;
  }

  /** §4.12 "Đổi tên…" (ended sessions too: the history list shows the name). */
  rename(sessionId: string, title: string): string | null {
    const t = renameSession(this.d.db, sessionId, title);
    const o = this.bySid.get(sessionId);
    if (o) for (const f of this.listeners) f({ type: 'orchestrator', orchestrator: o.view() });
    return t;
  }

  /**
   * §4.14 "Kết thúc phiên": not the last running one; lanes go (not stopped) to `lanesTo` (default the earliest other
   * running session), its unsent messages follow them, its pending PO asks expire (`session_ended`).
   */
  async end(sessionId: string, lanesTo?: string | Orchestrator, reason: EndReason = 'ended_by_po'): Promise<{ sessionId: string; to: string; lanes: string[]; handoffPath: string | null }> {
    const o = this.bySid.get(sessionId);
    if (!o) throw new SessionError('no_session', { key: 'errors.noSession', params: { id: sessionId } });
    const seq = o.view().seq;
    if (this.closing.has(sessionId)) throw new SessionError('session_closing', { key: 'errors.sessionClosing', params: { n: seq ?? '?' } });
    const chosen = typeof lanesTo === 'object' ? lanesTo : this.receiver(o, lanesTo); // object = the pending "Thay" replacer
    // R26 the project's one Chung is never ended by hand ("Phiên mới" / "Thay" replace it); a pre-v2.7 extra one may be
    if (o.kind === 'general' && reason === 'ended_by_po' && !this.live(o.projectId).some((x) => x !== o && x.kind === 'general')) {
      throw new SessionError('session_last', { key: 'errors.generalLast' });
    }
    this.closing.set(sessionId, chosen); // before the handoff await: overlapping commands see it as ending
    let r: Awaited<ReturnType<Orchestrator['end']>>;
    try {
      r = await o.end(endHandoffPathFor((this.d.today ?? todayIso)(), seq ?? null), reason);
    } catch (err) {
      this.closing.delete(sessionId);
      throw err;
    }
    if (o.kind === 'design') this.unbindEdits(o.projectId, sessionId);
    // The receiver may itself have ended meanwhile → follow it (route), else the first live session.
    const to = this.route(sessionId) ?? chosen;
    o.forwardTo = (m) => (this.route(sessionId) ?? to).carry(m); // v2.4 §10.2 with attachments + echoed
    const stragglers = listUndelivered(this.d.db, sessionId);
    this.d.db.query('DELETE FROM outbox WHERE session_id = ? AND delivered_at IS NULL').run(sessionId);
    this.bySid.delete(sessionId);
    this.closing.delete(sessionId);
    const lanes = moveLanes(this.d.db, sessionId, to.currentSessionId);
    recordHandover(this.d.db, sessionId, to.currentSessionId, lanes);
    if (lanes.length) await to.send(lanesReceivedText(lanes, `của #${seq ?? '?'} vừa kết thúc`), PREFIX.engine);
    for (const m of [...r.carried, ...stragglers]) await to.carry(m);
    return { sessionId, to: to.currentSessionId, lanes, handoffPath: r.handoffPath };
  }

  /** §4.14 who takes the lanes of `o` ending: `lanesTo`, default the earliest other live session; never the last one. */
  private receiver(o: Orchestrator, lanesTo: string | undefined): Orchestrator {
    const others = this.live(o.projectId).filter((x) => x !== o); // an ending session is neither a survivor nor a receiver
    if (others.length === 0) throw new SessionError('session_last', { key: 'errors.sessionLast' });
    // v2.7 R26 default: the Chung session (it always exists), else the earliest other
    const chosen = lanesTo === undefined ? others.find((x) => x.kind === 'general') ?? others[0]! : others.find((x) => x.currentSessionId === lanesTo);
    if (!chosen) throw new SessionError('bad_receiver', { key: 'errors.badReceiver' });
    return chosen;
  }

  /** v2.7 §5.2-8 a Thiết kế session ended without `spec_draft`: the approved / active spec it was editing is free again. */
  private unbindEdits(projectId: string, sessionId: string): void {
    for (const s of listSpecs(this.d.db, projectId)) {
      if (s.editSession === sessionId && s.state !== 'draft') updateSpec(this.d.db, s.id, { editSession: null });
    }
  }

  /** §4.14 the last "Đổi chủ lane" per lane and the uuids of its two notes (undo within 5 s, web timer). */
  private readonly moves = new Map<string, { from: string | null; to: string; gone: string | null; came: string | null }>();

  /**
   * §4.14 "Đổi chủ lane" (PO): the owner moves; one message to the old owner and one to the new. `undo` = "Hoàn tác" of
   * the last move of that lane: its notes still unsent are dropped, and only a session that already got one is told.
   */
  async reassign(projectId: string, name: string, toSession: string, undo = false): Promise<{ name: string; from: string | null; to: string }> {
    const { db } = this.d;
    const lane = db.query<{ state: string }, [string, string]>('SELECT state FROM lane WHERE project_id = ? AND name = ?').get(projectId, name);
    if (!lane || lane.state === 'done') throw new SessionError('no_lane', { key: 'errors.noLane', params: { name } });
    const to = this.route(toSession); // to an ending session = to the session taking its lanes
    if (!to || to.projectId !== projectId) throw new SessionError('no_session', { key: 'errors.noSession', params: { id: toSession } });
    const dest = to.currentSessionId;
    const from = ownerOf(db, projectId, name);
    if (from?.sessionId === dest) throw new SessionError('same_owner', { key: 'errors.laneSameOwner', params: { name, n: from.seq ?? '?' } });
    db.query('UPDATE lane SET owner_session = ? WHERE project_id = ? AND name = ?').run(dest, projectId, name);
    const old = from && !this.closing.has(from.sessionId) ? this.bySid.get(from.sessionId) : undefined; // an ending owner is not told
    const k = `${projectId}\0${name}`;
    const prev = this.moves.get(k);
    this.moves.delete(k);
    if (undo && prev && prev.to === from?.sessionId && prev.from === dest) {
      const cameUnsent = prev.came !== null && this.d.outbox.dropUnsent(prev.came); // the note to the owner being undone
      const goneUnsent = prev.gone !== null && this.d.outbox.dropUnsent(prev.gone); // the note to the owner coming back
      if (old && !cameUnsent) await old.send(laneGoneText(name, to.view().seq ?? null), PREFIX.engine);
      if (!goneUnsent) await to.send(laneCameText(name, from?.seq ?? null), PREFIX.engine);
      return { name, from: from?.sessionId ?? null, to: dest };
    }
    const gone = old ? await old.send(laneGoneText(name, to.view().seq ?? null), PREFIX.engine) : null;
    const came = await to.send(laneCameText(name, from?.seq ?? null), PREFIX.engine);
    this.moves.set(k, { from: from?.sessionId ?? null, to: dest, gone, came });
    return { name, from: from?.sessionId ?? null, to: dest };
  }

  /**
   * §7.1 recovery: rebuild from a session row and resume (stopped stays stopped until "Khởi động lại"). `hold` (hotfix
   * 2026-11-16, engine start / reopen): registered `paused`, no process, until `unpause` of its project.
   */
  async restore(s: SessionRow, hold = false): Promise<Orchestrator> {
    const existing = this.bySid.get(s.id);
    if (existing) return existing;
    const p = this.project(s.project_id);
    const state = s.state === 'stopped' ? 'stopped' as const : hold ? 'paused' as const : null;
    const o = this.register(this.make(s.project_id, s.id, { path: s.cwd ?? p.path, home: s.account_home ?? p.home },
      { account: s.account, kind: s.orch_kind ?? 'general', ...(state ? { state } : {}) }));
    if (state === null) await o.boot();
    return o;
  }

  /** hotfix 2026-11-16 "Tiếp tục": every paused session of the project boots (the others are untouched). */
  async unpause(projectId: string): Promise<void> { await Promise.all(this.list(projectId).map((o) => o.unpause())); }

  /** hotfix 2026-11-16 "Đóng project": its sessions' processes are closed and dropped; their rows stay unfinished. */
  async closeProject(projectId: string): Promise<void> {
    const os = this.list(projectId);
    for (const o of os) this.bySid.delete(o.currentSessionId);
    await Promise.all(os.map((o) => o.shutdown()));
  }

  /**
   * Manager notify sink: to the lane's owner session (§4.14), else the project's first running session. No runtime →
   * the message waits in the owner's / the project's live session outbox.
   */
  notify(projectId: string, text: string, lane?: string): void {
    const owner = lane !== undefined ? ownerOf(this.d.db, projectId, lane) : null;
    const o = (owner ? this.route(owner.sessionId) : null) ?? this.get(projectId); // an ending owner → its receiver
    if (o) { void o.send(text); return; }
    const s = this.d.db.query<{ id: string }, [string]>(
      "SELECT id FROM session WHERE project_id = ? AND kind = 'orchestrator' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1",
    ).get(projectId);
    if (s) this.d.outbox.enqueue(s.id, text, null);
  }

  /** §4.14 MCP owner port: who owns a lane, a session's #n. */
  ownerPort(): OwnerPort {
    return { ownerOf: (p, n) => ownerOf(this.d.db, p, n), seqOf: (sid) => seqOf(this.d.db, sid) };
  }

  accountChanged(email: string): void { for (const o of this.all()) void o.accountChanged(email); }

  /** v2 §6 A8L: sessions on a signed-out account move (v1 §7.5). */
  accountLoggedOut(email: string): Promise<void[]> { return Promise.all(this.all().map((o) => o.accountLoggedOut(email))); }

  /** Orchestrators currently running on this account (A8 "Đang là Điều phối"). */
  onAccount(email: string): boolean { return this.all().some((o) => o.view().account === email); }

  /** The orchestrator whose current session is `sessionId` (cards, MCP). */
  bySession(sessionId: string): Orchestrator | null { return this.bySid.get(sessionId) ?? null; }

  /** Permission answer to that orchestrator's live process; false when it has none. */
  writeControl(sessionId: string, line: string): boolean { return this.bySession(sessionId)?.writeControl(line) ?? false; }

  /** A card answer: persisted, and written now when the session can take it (idle → flushed / respawned). */
  async deliver(sessionId: string, d: Draft): Promise<boolean> {
    const o = this.bySession(sessionId);
    if (!o) return false;
    await o.send(d.text, d.prefix);
    return true;
  }

  async shutdown(): Promise<void> { await Promise.all(this.all().map((o) => o.shutdown())); }

  /** v2.7 R34 opening one more `kind` session: refused when it would pass the cap of doc + build sessions (the one Chung is
   *  free); v2.9 §5.7 the cap is the project workflow's `max_doc_sessions`. */
  private cap(projectId: string, kind: OrchKind): void {
    if (capReached(this.kinds(projectId), kind, this.maxSessions(projectId))) throw new SessionError('session_cap', { key: 'errors.sessionCap' });
  }

  /** v2.9 §5.7 `rules.max_doc_sessions` of the project's workflow. */
  maxSessions(projectId: string): number { return projectWorkflow(this.d.db, projectId).rules.max_doc_sessions; }

  private kinds(projectId: string): OrchKind[] { return this.list(projectId).map((o) => o.kind); }

  /** §4.14 migration rule: the first session opened afterwards adopts lanes whose owner ended, and is told so. */
  private adopt(o: Orchestrator): void {
    const names = adoptOrphans(this.d.db, o.projectId, o.currentSessionId);
    if (names.length) this.d.outbox.enqueue(o.currentSessionId, lanesReceivedText(names, 'của phiên đã kết thúc'), PREFIX.engine);
  }

  private project(id: string): { path: string; home: string | null; name: string } {
    const r = this.d.db.query<{ path: string; orchestrator_account: string | null; name: string }, [string]>(
      'SELECT path, orchestrator_account, name FROM project WHERE id = ?',
    ).get(id);
    if (!r) throw new Error(`no project ${id}`);
    return { path: r.path, home: r.orchestrator_account, name: r.name };
  }

  private make(projectId: string, sessionId: string, p: { path: string; home: string | null },
    o: { account: string | null; state?: OrchestratorState; avoid?: string[]; kind?: OrchKind }): Orchestrator {
    const orch = new Orchestrator(this.d, projectId, sessionId, p.home, p.path, o, (e) => {
      for (const f of this.listeners) f(e);
      if (e.type === 'orchestrator' && e.orchestrator.state === 'idle') { const go = this.idleWaits.get(e.orchestrator.sessionId); if (go) queueMicrotask(go); }
    });
    orch.onSessionId = (from, to) => { // F21: same place in the open order, new key
      this.bySid = new Map([...this.bySid].map(([k, v]) => (k === from ? [to, v] : [k, v])));
      moveSpecBindings(this.d.db, from, to); // R-B13 (b)
    };
    return orch;
  }

  /** Counted and listed from here on (open order = insertion order). */
  private register(o: Orchestrator): Orchestrator {
    this.bySid.set(o.currentSessionId, o);
    return o;
  }
}

/** §4.14 what the MCP tools need to know about ownership. */
export interface OwnerPort {
  ownerOf(projectId: string, name: string): { sessionId: string; seq: number | null } | null;
  seqOf(sessionId: string): number | null;
}
