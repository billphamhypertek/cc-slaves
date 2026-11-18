// LaneManager (spec §7.4, §3.4 I3, §7.3, §8.6): the only impure driver of lanes. It holds each lane's reducer ctx,
// feeds SessionProcess events into `reduce`, and executes the effects in order. All work for one lane runs on a
// serial queue, so the reducer never sees two events at once; feedback events (pick_result, cap_checked, init_ok)
// are applied inline by the effect that produced them.
import { randomUUID } from 'node:crypto';
import type { TokenCounts } from '../../../shared/protocol.ts';
import type { Account } from '../accounts/registry.ts';
import { pick, PICK_REASON_KEY, shouldLeave, soleUsable, type PickResult } from '../accounts/picker.ts';
import { resolveCaps } from '../config.ts';
import {
  getLane, type Lane, laneTokens, insertLane, insertSession, LaneConflictError, listUndelivered,
  updateLaneFields, updateLaneState, updateSession, type LaneState, type QuotaRow,
} from '../db.ts';
import { contentOf, PREFIX, type SendExtra } from '../outbox.ts';
import { removeSessionFiles } from '../session/files.ts';
import { SessionProcess, type ExitInfo } from '../session/process.ts';
import type { ResultEvent, StreamEvent } from '../stream/parser.ts';
import { TokenMeter } from '../stream/tokens.ts';
import { drainText, reduce, newLaneCtx, setPhaseDone, type LaneCtx, type LaneEffect, type LaneEvent } from './reducer.ts';
import { TurnFive } from '../orchestrator/resume.ts';
import { run } from './manager/effects.ts';
import { cancelModel, modelControl, modelScope, setModel } from './manager/model.ts';
import { ModelCache } from '../models.ts';
import { lanePin } from '../workflow/runtime.ts';
import type { ModelChange } from '../session/model-control.ts';
import type { SetModelResult } from '../../../shared/protocol.ts';
import { classify, fiveOf, keepCutTokens, onExit, onStream, recordResult, spawn } from './manager/process.ts';
import {
  key, LaneError, OCCUPY, ON_ACCOUNT, QUIET, realTimers, REDUCER_ERR_KEY, today, waitReasonOf,
  type LaneErrorCode, type LaneManagerDeps, type LaneUiEvent, type LaneView, type Rt, type StartInput, type Timers,
} from './manager/types.ts';

export { LaneError } from './manager/types.ts';
export type { LaneManagerDeps, LaneUiEvent, LaneView, QuotaView, StartInput, Timers } from './manager/types.ts';

export class LaneManager {
  private readonly lanes = new Map<string, Rt>();
  private readonly listeners: ((e: LaneUiEvent) => void)[] = [];
  readonly timers: Timers;
  private readonly now: () => number;
  closed = false;
  /** Processes taken off their lane (close_stdin grace / kill) but maybe not gone yet: shutdown waits for them. */
  private readonly detached = new Map<SessionProcess, Promise<ExitInfo>>();
  /** v2.4 §5.4 */
  readonly modelCache: ModelCache;

  constructor(readonly d: LaneManagerDeps) {
    this.modelCache = d.modelCache ?? new ModelCache();
    this.timers = d.timers ?? realTimers;
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ---------- public API (MCP tools, UI) ----------

  on(f: (e: LaneUiEvent) => void): void { this.listeners.push(f); }

  async start(o: StartInput): Promise<LaneView> {
    const { db } = this.d;
    if (this.lanes.has(key(o.projectId, o.name)) ||
      db.query('SELECT 1 FROM lane WHERE project_id = ? AND name = ?').get(o.projectId, o.name)) {
      throw new LaneError('name_taken', { key: 'errors.laneNameTaken', params: { name: o.name } });
    }
    const live = db.query<{ name: string }, [string]>("SELECT name FROM lane WHERE cwd = ? AND state <> 'done'").get(o.cwd);
    if (live) throw new LaneError('cwd_in_use', { key: 'errors.cwdInUse', params: { cwd: o.cwd, lane: live.name } });

    const to = this.pickForStart(o.account);
    const sessionId = (this.d.newSessionId ?? randomUUID)();
    let laneId: number;
    try {
      insertSession(db, { id: sessionId, projectId: o.projectId, kind: 'lane', account: to.email });
      laneId = insertLane(db, {
        projectId: o.projectId, name: o.name, cwd: o.cwd, sessionId, briefPath: o.briefPath, agent: o.agent ?? null,
        model: o.model ?? null, effort: o.effort ?? null, state: 'starting', ownerSession: o.ownerSession ?? null,
      }).id;
      lanePin(db, o.projectId, laneId, sessionId, o.ownerSession ?? null); // v2.9 §6.1 the rev of the session that started it
    } catch (e) {
      if (e instanceof LaneConflictError) throw new LaneError('cwd_in_use', e.message);
      throw e;
    }
    const rt = this.withModel({
      projectId: o.projectId, laneId, cwd: o.cwd, briefPath: o.briefPath, agent: o.agent, model: o.model, effort: o.effort,
      ctx: newLaneCtx({ id: String(laneId), name: o.name, sessionId, account: to.email }),
      proc: null, procExit: new WeakMap(), lastProc: null, runN: 0, chain: Promise.resolve(), retry: null, cost: null, waitReason: null,
      tokens: new TokenMeter(), lastResult: null, userInterrupt: false,
      firstText: (this.d.firstMessage ?? ((l) => contentOf({ prefix: PREFIX.orchestrator, text: `Đọc brief ${l.briefPath} và làm theo.` })))({ name: o.name, briefPath: o.briefPath }),
    });
    this.lanes.set(key(o.projectId, o.name), rt);
    this.d.outbox.enqueue(sessionId, rt.firstText, null);
    void this.job(rt, () => this.apply(rt, { type: 'pick_result', to: to.email }));
    return this.view(rt);
  }

  /** v2.4 §10.2 `o` = `send`'s uuid / attachments / echoed; `raw` (§6.6) = the text goes bare (row prefix ''). */
  async message(projectId: string, name: string, text: string, from: 'po' | 'orchestrator', o: SendExtra & { raw?: boolean } = {}): Promise<void> {
    const rt = this.rt(projectId, name);
    const { raw, ...extra } = o;
    const content = raw ? text : contentOf({ prefix: from === 'po' ? PREFIX.po : PREFIX.orchestrator, text });
    const send = raw || Object.keys(extra).length > 0 ? { send: { prefix: raw ? PREFIX.raw : null, extra } } : {};
    await this.call(rt, { type: 'message', text: content, from, ...send });
  }

  /** §3.3-6 `lane_interrupt`: end the current turn; the lane goes quiet as after a normal result. */
  async interrupt(projectId: string, name: string): Promise<void> {
    const rt = this.rt(projectId, name);
    await this.job(rt, async () => {
      if (rt.ctx.state !== 'running' || !rt.proc?.alive) throw new LaneError('not_running', { key: 'errors.notRunning', params: { name } });
      rt.userInterrupt = true;
      await rt.proc.interrupt();
    });
  }

  async stop(projectId: string, name: string, mode: 'drain' | 'now'): Promise<void> {
    const rt = this.rt(projectId, name);
    await this.call(rt, mode === 'drain' ? { type: 'stop_drain', date: today() } : { type: 'stop_now' });
  }

  async resume(projectId: string, name: string): Promise<void> {
    const rt = this.rt(projectId, name);
    if (rt.ctx.state !== 'stopped' && rt.ctx.state !== 'broken') {
      throw new LaneError('not_halted', { key: 'errors.notHalted', params: { name } });
    }
    await this.call(rt, { type: 'lane_resume' });
  }

  async finish(projectId: string, name: string, force = false): Promise<void> {
    await this.call(this.rt(projectId, name), { type: 'lane_finish', force });
  }

  /** `lane_set_phase` (§7.7): phase/task/note on the lane row; `done` parks the unit at Merge and tells the orchestrator. */
  async setPhase(projectId: string, name: string, p: { phase: string; task?: string; note?: string }): Promise<void> {
    const rt = this.rt(projectId, name);
    await this.job(rt, async () => {
      const f: { phase: string; task?: string | null; note?: string | null } = { phase: p.phase };
      if (p.task !== undefined) f.task = p.task;
      if (p.note !== undefined) f.note = p.note;
      updateLaneFields(this.d.db, rt.laneId, f);
      if (p.phase === 'done') {
        const s = setPhaseDone(rt.ctx, p.note);
        rt.ctx = s.ctx;
        for (const e of s.effects) await this.run(rt, e);
      } else {
        rt.ctx = { ...rt.ctx, phase: p.phase };
      }
      this.emit({ type: 'lane', lane: this.view(rt) });
    });
  }

  /**
   * v2.4 §5.6 `lane_set_model`: the §5.3 rules on the lane (now / pending / saved / unsupported); a done lane → `bad_state`.
   * ModelError (`model_not_found`, `timeout`, `failed`) goes to the caller.
   */
  async setModel(projectId: string, name: string, c: ModelChange): Promise<SetModelResult['applied']> {
    const rt = this.liveRt(projectId, name);
    // §5.6 starting, first turn not written yet (the spawn job runs the handshake): the handshake applies the change
    if (rt.proc?.alive && !rt.shaken && rt.proc.turnStartedAt === null) { rt.mc.wait(c); return 'pending'; }
    return this.job(rt, () => setModel(this, rt, c));
  }

  /** v2.4 §5.6 `lane_model_cancel`. */
  async cancelModel(projectId: string, name: string): Promise<void> {
    const rt = this.liveRt(projectId, name);
    return this.job(rt, () => cancelModel(this, rt));
  }

  /** v2.4 §5.4 / §5.6 what `session_models {lane}` asks: account, cwd, own process, tiers 2–4 now. */
  modelScope(projectId: string, name: string): ReturnType<typeof modelScope> { return modelScope(this, this.rt(projectId, name)); }

  /** Full text of the last `result` (`lane_result`). */
  result(projectId: string, name: string): string | null { return this.rt(projectId, name).lastResult; }

  /** Last n assistant / user / result lines (`lane_tail`), raw JSON from the RAM window (§8.4). */
  tail(projectId: string, name: string, n = 20): string[] {
    const p = this.rt(projectId, name).lastProc;
    const lines = (p?.recentLines ?? []).filter((l) => /"type":"(assistant|user|result)"/.test(l));
    return lines.slice(-n);
  }

  list(projectId: string): LaneView[] {
    return [...this.lanes.values()].filter((r) => r.projectId === projectId).map((r) => this.view(r));
  }

  /** Every lane of every project (stopAll, recovery summary). */
  listAll(): LaneView[] { return [...this.lanes.values()].map((r) => this.view(r)); }

  /** v2.1 §5.3 running turns' provisional tokens (not stored yet), for today / 5 h stats. */
  provisionalTokens(): { projectId: string; tokens: TokenCounts }[] {
    return [...this.lanes.values()].map((r) => ({ projectId: r.projectId, tokens: r.tokens.provisional }));
  }

  /**
   * §7.1 engine-start recovery: rebuild a lane's runtime from its `lane` row and its session's account. The old process
   * died with the engine (pipe EOF). A lane that was mid-work (starting/running/switching/draining), or a quiet one with
   * undelivered messages, is resumed now — the resume start sends the resume message, then every undelivered message in
   * order. A quiet lane with nothing pending stays quiet with no process (the next message respawns it with --resume);
   * waiting_quota / stopped / broken keep their state. `resumeNote` (§4.14 "Chạy tiếp lane") replaces the resume message once.
   * `hold` (hotfix 2026-11-16, engine start / reopen): a lane that would run now, or wait for quota, is `paused` instead
   * (no process, no retry) until `unpause` of its project; its row keeps the real state.
   */
  restore(l: Lane, account: string | null, resumeNote?: string, hold = false): LaneView {
    if (this.lanes.has(key(l.projectId, l.name))) return this.view(this.lanes.get(key(l.projectId, l.name))!);
    const { db } = this.d;
    const sid = l.sessionId!;
    const delivered = db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM outbox WHERE session_id = ? AND delivered_at IS NOT NULL').get(sid)!.n;
    const runN = db.query<{ n: number | null }, [number]>('SELECT MAX(n) AS n FROM run WHERE lane_id = ?').get(l.id)!.n ?? 0;
    const openCards = db.query<{ id: number }, [string]>("SELECT id FROM card WHERE session_id = ? AND kind = 'ask' AND status = 'open' ORDER BY id")
      .all(sid).map((r) => r.id);
    const ctx: LaneCtx = {
      ...newLaneCtx({ id: String(l.id), name: l.name, sessionId: sid, account }),
      state: l.state, failCount: l.failCount, lastError: l.lastError, lastErrorKeyed: l.lastErrorKeyed, phase: l.phase, openCards,
      // A delivered message means claude persisted the conversation → --resume works.
      sawAssistant: delivered > 0,
    };
    const briefPath = l.briefPath ?? '';
    const rt = this.withModel({
      projectId: l.projectId, laneId: l.id, cwd: l.cwd, briefPath, agent: l.agent ?? undefined, model: l.model ?? undefined,
      effort: l.effort ?? undefined, ctx, proc: null, procExit: new WeakMap(), lastProc: null, runN, chain: Promise.resolve(),
      retry: null, cost: l.costUsd || null, tokens: new TokenMeter(laneTokens(db, l.id)), lastResult: null, userInterrupt: false, waitReason: null,
      firstText: this.firstText(l.name, briefPath), ...(resumeNote !== undefined ? { resumeNote } : {}),
    });
    this.lanes.set(key(l.projectId, l.name), rt);
    const busy = (['starting', 'running', 'switching', 'draining'] as LaneState[]).includes(l.state);
    const pending = QUIET.includes(l.state) && (resumeNote !== undefined || listUndelivered(db, sid).length > 0);
    if (hold && (busy || pending || l.state === 'waiting_quota')) {
      rt.ctx = { ...rt.ctx, state: 'paused' };
      rt.heldFrom = l.state;
    } else this.revive(rt, l.state, busy || pending);
    return this.view(rt);
  }

  /** The §7.1 restore step for a lane in `state`: `run` = it resumes now (resume message, then its outbox). */
  private revive(rt: Rt, state: LaneState, run: boolean): void {
    const account = rt.ctx.account;
    if (run) {
      void this.job(rt, async () => {
        if (!this.registered(rt)) return; // A-I1: the project closed while this job waited
        const draining = state === 'draining';
        rt.ctx = { ...rt.ctx, state: 'starting', drainAfterResume: draining, drainText: draining ? drainText(rt.ctx.name, today()) : null };
        this.persist(rt, state);
        const a = account !== null ? this.account(account) : null;
        const ok = a !== null && 'account' in this.pickFor(rt, [], [a]);
        if (ok) await this.spawn(rt, rt.ctx.sawAssistant ? 'resume' : 'fresh', account!);
        else await this.run(rt, { type: 'pick_account', exclude: [] });
      });
    } else if (state === 'waiting_quota') {
      this.retryWaiting();
    } else if (QUIET.includes(state) && account !== null && !this.account(account) && this.d.accounts().length === 0) {
      // §7.1-3 MINOR-1: a quiet v1 lane whose account has no registry `dir`, with no usable account at all → it waits
      // `no_account` (counted on the cutover card) instead of showing idle on an account that does not exist.
      void this.job(rt, () => this.apply(rt, { type: 'auth_error' }));
    }
  }

  /** A-I1: `rt` is still this lane's runtime (a project close drops it; a queued job must not spawn for it). */
  registered(rt: Rt): boolean { return this.lanes.get(key(rt.projectId, rt.ctx.name)) === rt; }

  /** hotfix 2026-11-16 "Tiếp tục": every paused lane of the project runs the restore step of its stored state. */
  unpause(projectId: string): void {
    for (const rt of this.lanes.values()) {
      if (rt.projectId !== projectId || rt.ctx.state !== 'paused' || rt.heldFrom === undefined) continue;
      const from = rt.heldFrom;
      delete rt.heldFrom;
      if (from === 'waiting_quota') {
        rt.ctx = { ...rt.ctx, state: from };
        this.emit({ type: 'lane', lane: this.view(rt) });
      }
      this.revive(rt, from, from !== 'waiting_quota');
    }
  }

  /** hotfix 2026-11-16 "Đóng project": its lanes' processes stop and their runtimes go; the rows keep their state. */
  async closeProject(projectId: string): Promise<void> {
    const procs: Promise<unknown>[] = [];
    for (const [k, rt] of this.lanes) {
      if (rt.projectId !== projectId) continue;
      if (rt.retry !== null) this.timers.clear(rt.retry);
      if (rt.proc) { this.keepCutTokens(rt); procs.push(rt.proc.terminate(500)); }
      rt.proc = null;
      this.lanes.delete(k);
    }
    await Promise.all(procs);
  }

  /**
   * v2.1 §4.14 "Chạy tiếp lane": a done lane runs again under `ownerSession` on the same Claude session (`--resume`).
   * Its row leaves Xong (state idle, done_at cleared), `text` goes first, then the restore path spawns it.
   */
  reopen(projectId: string, name: string, o: { ownerSession: string; account: string | null; text: string }): LaneView {
    const { db } = this.d;
    const l = getLane(db, projectId, name);
    if (!l || l.state !== 'done' || !l.sessionId) throw new LaneError('not_halted', { key: 'errors.laneNotDone', params: { name } });
    db.query("UPDATE lane SET state = 'idle', done_at = NULL, owner_session = ? WHERE id = ?").run(o.ownerSession, l.id);
    db.query("UPDATE session SET state = 'idle', ended_at = NULL WHERE id = ?").run(l.sessionId);
    this.lanes.delete(key(projectId, name)); // the done runtime (no process) is rebuilt from the row
    return this.restore({ ...l, state: 'idle', ownerSession: o.ownerSession }, o.account, o.text);
  }

  get(projectId: string, name: string): LaneView | null {
    const r = this.lanes.get(key(projectId, name));
    return r ? this.view(r) : null;
  }

  alive(projectId: string, name: string): boolean { return this.rt(projectId, name).proc?.alive ?? false; }

  /** §3.4 I3: an account's numbers changed (QuotaTracker or a session's rate_limit_event) → re-check every session on it;
   *  lanes waiting for quota try again. */
  accountChanged(email: string): void {
    for (const rt of this.lanes.values()) {
      if (rt.ctx.account === email) {
        void this.job(rt, async () => {
          if (!ON_ACCOUNT.includes(rt.ctx.state) || rt.ctx.account !== email || this.capOk(rt)) return;
          await this.apply(rt, { type: 'limit_or_cap' });
        });
      }
    }
    this.retryWaiting();
  }

  /**
   * v2 §6 A8L: the account was signed out from cc-slaves → every lane on it leaves exactly as on an auth error (F16:
   * no error counted, the logged_out card, a pick that skips it). Returns the lane names that switch.
   */
  accountLoggedOut(email: string): string[] {
    const moved: string[] = [];
    for (const rt of this.lanes.values()) {
      if (rt.ctx.account !== email || !ON_ACCOUNT.includes(rt.ctx.state)) continue;
      moved.push(rt.ctx.name);
      void this.job(rt, async () => {
        if (rt.ctx.account !== email || !ON_ACCOUNT.includes(rt.ctx.state)) return;
        await this.apply(rt, { type: 'auth_error' });
      });
    }
    return moved;
  }

  // ---------- card hooks (CardStore, §7.7 po_ask, §6.15) — keyed by session id ----------

  bySession(sessionId: string): LaneView | null {
    const r = this.rtBySession(sessionId);
    return r ? this.view(r) : null;
  }

  /** po_ask card opened / answered on this lane's session (reducer ask_open / ask_close). False: not a lane session. */
  async askOpen(sessionId: string, cardId: number): Promise<boolean> {
    const rt = this.rtBySession(sessionId);
    if (!rt) return false;
    await this.job(rt, () => this.apply(rt, { type: 'ask_open', cardId }));
    return true;
  }

  async askClose(sessionId: string, cardId: number): Promise<boolean> {
    const rt = this.rtBySession(sessionId);
    if (!rt) return false;
    await this.job(rt, () => this.apply(rt, { type: 'ask_close', cardId }));
    return true;
  }

  /** An engine message (card answer) to the lane, through the same path as `message` (outbox, cap check, respawn). */
  async deliver(sessionId: string, content: string): Promise<boolean> {
    const rt = this.rtBySession(sessionId);
    if (!rt) return false;
    await this.call(rt, { type: 'message', text: content, from: 'orchestrator' });
    return true;
  }

  /** Raw control line (permission answer) to the lane's current process; false when it has none. */
  writeControl(sessionId: string, line: string): boolean {
    const p = this.rtBySession(sessionId)?.proc;
    return p?.alive ? p.writeLine(line) : false;
  }

  /** Stops timers and processes (engine shutdown / tests). Lane rows keep their state. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const procs: Promise<unknown>[] = [];
    for (const rt of this.lanes.values()) {
      if (rt.retry !== null) this.timers.clear(rt.retry);
      if (rt.proc) { this.keepCutTokens(rt); procs.push(rt.proc.terminate(500)); }
      rt.proc = null;
    }
    // MINOR-2: a detached process's exit handler writes the run row; wait for it so it never hits a closed db.
    for (const [p, exit] of this.detached) procs.push(p.terminate(500), exit);
    await Promise.all(procs);
  }

  // ---------- internals ----------

  private firstText(name: string, briefPath: string): string {
    const f = this.d.firstMessage ?? ((l) => contentOf({ prefix: PREFIX.orchestrator, text: `Đọc brief ${l.briefPath} và làm theo.` }));
    return f({ name, briefPath });
  }

  private rt(projectId: string, name: string): Rt {
    const r = this.lanes.get(key(projectId, name));
    if (!r) throw new LaneError('no_lane', { key: 'errors.noLane', params: { name } });
    return r;
  }

  /** A lane not done (§5.6 a done lane's model is final → `bad_state`). */
  private liveRt(projectId: string, name: string): Rt {
    const r = this.lanes.get(key(projectId, name));
    const done = r ? r.ctx.state === 'done' : getLane(this.d.db, projectId, name)?.state === 'done';
    if (done) throw new LaneError('bad_state', { key: 'errors.laneDoneModel', params: { name } });
    return this.rt(projectId, name);
  }

  /** v2.4 §5.6 a new runtime gets its model control (it reads the picks from the runtime). */
  private withModel(base: Omit<Rt, 'mc' | 'shaken'>): Rt {
    const rt = { ...base, shaken: false } as Rt;
    rt.mc = modelControl(this, rt);
    return rt;
  }

  private rtBySession(sessionId: string): Rt | null {
    for (const r of this.lanes.values()) if (r.ctx.sessionId === sessionId) return r;
    return null;
  }

  job<T>(rt: Rt, f: () => Promise<T>): Promise<T> {
    const p = rt.chain.then(f);
    rt.chain = p.catch(() => {});
    return p;
  }

  /** Public command: apply on the queue; reducer `error` effects (lane_running …) become a LaneError for the caller. */
  private async call(rt: Rt, e: LaneEvent): Promise<void> {
    const errs = await this.job(rt, () => this.apply(rt, e));
    const err = errs.find((x) => x.code !== 'lane_broken');
    if (err) throw new LaneError(err.code as LaneErrorCode, REDUCER_ERR_KEY[err.code] ? { key: REDUCER_ERR_KEY[err.code]! } : err.text);
  }

  async apply(rt: Rt, e: LaneEvent): Promise<Extract<LaneEffect, { type: 'error' }>[]> {
    const before = rt.ctx;
    const { ctx, effects } = reduce(rt.ctx, e);
    rt.ctx = ctx;
    const shown = ctx !== before ? this.persist(rt, before.state) : null;
    const errors: Extract<LaneEffect, { type: 'error' }>[] = [];
    for (const ef of effects) {
      if (ef.type === 'error') errors.push(ef);
      await this.run(rt, ef);
    }
    this.issueHook(rt, before.state, ctx.state, effects);
    // The state view goes out before the effects run, but `write_stdin` is what starts the turn: re-send the view
    // so the UnitPanel gets the turn's start with `running`, not only at the next state change.
    if (shown && (rt.proc?.turnStartedAt ?? null) !== shown.turnStartedAt) this.emit({ type: 'lane', lane: this.view(rt) });
    return errors;
  }

  /** v2.7 §5.3 / R15 after this step's effects (so "rảnh" / "hỏng" went out first): the held issue's follow-ups. */
  private issueHook(rt: Rt, prev: LaneState, now: LaneState, effects: readonly LaneEffect[]): void {
    const h = this.d.issues;
    if (!h) return;
    const l = { projectId: rt.projectId, laneId: rt.laneId, name: rt.ctx.name };
    if (now === 'idle' && effects.some((ef) => ef.type === 'notify_orchestrator')) h.laneIdle(l);
    if (now === prev) return;
    if (now === 'done') h.laneEnded(l, prev === 'broken' ? 'hỏng rồi kết thúc' : 'kết thúc');
    else if (now === 'broken') h.laneBroken(l);
  }

  private persist(rt: Rt, prev: LaneState): LaneView {
    const c = rt.ctx;
    const stored = (c.state === 'paused' && rt.heldFrom) || c.state; // hotfix 2026-11-16 `paused` is never written
    updateLaneState(this.d.db, rt.laneId, stored, { failCount: c.failCount, lastError: c.lastError, lastErrorKeyed: c.lastErrorKeyed ?? null });
    if (c.account !== null) updateSession(this.d.db, c.sessionId, { account: c.account, state: stored });
    if (c.state === 'done' && prev !== 'done') {
      removeSessionFiles(c.sessionId);
      this.d.outbox.discardDelivered(c.sessionId); // v2.4 §6.5 R13 the file copies delivered to it
      this.d.onSessionEnded?.(c.sessionId);
    }
    const v = this.view(rt);
    this.emit({ type: 'lane', lane: v });
    if (OCCUPY.includes(prev) && !OCCUPY.includes(c.state)) this.retryWaiting(rt);
    return v;
  }

  /** A slot or some quota came free: lanes waiting for quota pick again (`skip` = the lane that just left a slot). */
  private retryWaiting(skip?: Rt): void {
    for (const rt of this.lanes.values()) {
      if (rt === skip || rt.ctx.state !== 'waiting_quota') continue;
      void this.job(rt, async () => {
        if (rt.ctx.state !== 'waiting_quota') return;
        const r = this.pickFor(rt, []);
        rt.waitReason = waitReasonOf(r);
        if ('account' in r) await this.apply(rt, { type: 'quota_freed', account: r.account.email });
      });
    }
  }

  private run(rt: Rt, ef: LaneEffect): Promise<void> { return run(this, rt, ef); }

  detach(rt: Rt): SessionProcess | null {
    const p = rt.proc;
    if (p) this.keepCutTokens(rt); // killed for a switch / stop: no result will come for its turn
    rt.mc.settle(); // v2.4 §5.6 a waiting change becomes the pick of the next process (held rows stay queued)
    rt.proc = null;
    const exit = p ? rt.procExit.get(p) : undefined;
    if (p?.alive && exit) {
      this.detached.set(p, exit);
      void exit.then(() => this.detached.delete(p));
    }
    return p;
  }

  notify(rt: Rt, text: string): void {
    this.d.notify?.(rt.projectId, text, rt.ctx.name);
    this.emit({ type: 'notify', projectId: rt.projectId, text });
  }

  emit(e: LaneUiEvent): void { for (const f of this.listeners) f(e); }

  account(email: string): Account | null { return this.d.accounts().find((a) => a.email === email) ?? null; }

  /** Pick for `rt` (null = a lane not created yet), counting every other lane that holds a slot. */
  pickFor(rt: Rt | null, exclude: string[], only?: Account[]): PickResult {
    const laneCounts: Record<string, number> = {};
    let machine = 0;
    for (const r of this.lanes.values()) {
      if (r === rt || !OCCUPY.includes(r.ctx.state)) continue;
      machine++;
      if (r.ctx.account !== null) laneCounts[r.ctx.account] = (laneCounts[r.ctx.account] ?? 0) + 1;
    }
    const accounts = only ?? this.d.accounts();
    const quotas: Record<string, QuotaRow | null> = {};
    for (const a of this.d.accounts()) quotas[a.email] = this.d.quota.get(a.email);
    return pick({
      accounts, pool: this.d.accounts(), quotas, caps: this.d.caps(), laneCounts, machineLaneCount: machine, config: this.d.config(),
      now: this.now(), exclude, kind: 'lane', loggedOut: [...(this.d.loggedOut?.() ?? [])],
    });
  }

  private pickForStart(email: string | undefined): Account {
    if (email === undefined) {
      const r = this.pickFor(null, []);
      if ('account' in r) return r.account;
      throw new LaneError(r.reason === 'machine_full' ? 'machine_full' : 'no_account', { key: PICK_REASON_KEY[r.reason] });
    }
    const a = this.account(email);
    if (!a) throw new LaneError('bad_account', { key: 'errors.badAccountMissing', params: { email } });
    // §6 rev 2.1 N4 + D26: the orchestrator account runs lanes when its max lanes > 0, or while it is the only usable one.
    if (resolveCaps(this.d.caps(), email).role === 'orchestrator' && !((this.d.config().laneCaps?.[email] ?? 0) > 0)
      && soleUsable(this.d.accounts(), [...(this.d.loggedOut?.() ?? [])]) !== email) {
      throw new LaneError('bad_account', { key: 'errors.accountIsOrchestrator', params: { email } });
    }
    const r = this.pickFor(null, [], [a]);
    if ('account' in r) return r.account;
    if (r.reason === 'machine_full') throw new LaneError('machine_full', { key: PICK_REASON_KEY.machine_full });
    const why = r.skipped.find((s) => s.email === email)?.reason;
    if (why === 'logged_out') throw new LaneError('bad_account', { key: 'errors.accountLoggedOut', params: { email } });
    throw new LaneError('bad_account', why === 'account_lanes_full' || why === 'quota_unknown' ? { key: PICK_REASON_KEY[why] }
      : { key: 'errors.accountAtLimit', params: { email } });
  }

  /** §3.4 leave rule on the lane's current account (also the cap check before writing to a quiet session). */
  capOk(rt: Rt): boolean {
    const email = rt.ctx.account;
    if (email === null) return true;
    const a = this.account(email);
    if (!a) return false;
    const other = this.pickFor(rt, [email]);
    return shouldLeave({
      account: a, quota: this.d.quota.get(email), caps: this.d.caps(), now: this.now(), otherFree: 'account' in other,
    }) === 'stay';
  }

  /** v2.6 §5.4-3 held for an update → the spawn waits for the release (dropped if the lane moved on) or the next boot. */
  spawn(rt: Rt, mode: 'resume' | 'fresh', email: string, fallback = false): Promise<void> {
    const at = rt.ctx.state;
    const later = () => { void this.job(rt, async () => { if (!this.closed && !rt.proc && rt.ctx.state === at) await this.spawn(rt, mode, email, fallback); }); };
    return this.d.gate?.defer(rt.ctx.sessionId, later) ? Promise.resolve() : spawn(this, rt, mode, email, fallback);
  }

  /** v2.6 §5.4 the update hold ended: each live lane writes what waited (a quiet lane's turn starts). */
  writesOpened(): void {
    for (const rt of this.lanes.values()) {
      void this.job(rt, async () => { if ((rt.proc?.flush() ?? 0) > 0) await this.apply(rt, { type: 'self_started_turn' }); });
    }
  }

  onStream(rt: Rt, proc: SessionProcess, email: string, e: StreamEvent): void { onStream(this, rt, proc, email, e); }

  fiveOf(rt: Rt): TurnFive { return fiveOf(this, rt); }

  recordResult(rt: Rt, r: ResultEvent, email: string): void { recordResult(this, rt, r, email); }

  keepCutTokens(rt: Rt): void { keepCutTokens(this, rt); }

  classify(rt: Rt, r: ResultEvent): LaneEvent { return classify(this, rt, r); }

  onExit(rt: Rt, proc: SessionProcess, x: ExitInfo): Promise<void> { return onExit(this, rt, proc, x); }

  view(rt: Rt): LaneView {
    const c = rt.ctx;
    return {
      projectId: rt.projectId, name: c.name, laneId: rt.laneId, sessionId: c.sessionId, cwd: rt.cwd, state: c.state,
      account: c.account, phase: c.phase, failCount: c.failCount, lastError: c.lastError, lastErrorKeyed: c.lastErrorKeyed ?? null, openCards: [...c.openCards],
      switchPending: c.switchPending, sawAssistant: c.sawAssistant, costUsd: rt.cost, alive: rt.proc?.alive ?? false,
      tokens: rt.tokens.total,
      turnStartedAt: rt.proc?.turnStartedAt ?? null, contextPct: rt.proc?.contextPct ?? rt.lastProc?.contextPct ?? null,
      waitReason: c.state === 'waiting_quota' ? rt.waitReason : null,
      ...this.modelView(rt),
    };
  }

  /** v2.4 §5.6 LaneView model fields. */
  private modelView(rt: Rt): Pick<LaneView, 'run' | 'pending' | 'modelMismatch'> {
    const v = rt.mc.view();
    return { run: rt.mc.run, modelMismatch: v.modelMismatch, ...(v.pending ? { pending: v.pending } : {}) };
  }
}
