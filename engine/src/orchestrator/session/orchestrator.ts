// Orchestrator session (spec §7.5, §6.11 F11, §6.21 F21): one Claude Code session per project, kind 'orchestrator'.
// - Account: the project's orchestrator account ("home"). Leaving it goes only to a primary soft account, only between
//   turns unless the plan blocks outright, and it returns home at the first turn boundary after home has room
//   (lane/switcher.ts `orchestratorSwitch`). No account → waiting_quota (F6).
// - Abnormal death → one automatic restart (resume); a second death before a good turn → stopped + a typed
//   `system_card {kind: 'orchestrator_down'}` event. Lanes are not touched; messages for it stay in the outbox.
// - Versioned appendix (§7.5): `--append-system-prompt` only at creation; a resumed older session gets the new text once.
// All work for one project runs on a serial queue, like the lane manager.
import { randomUUID } from 'node:crypto';
import type { Account } from '../../accounts/registry.ts';
import { insertEvent, insertSession, listUndelivered, sessionTokens, updateSession, type OutboxMsg } from '../../db.ts';
import { TokenMeter } from '../../stream/tokens.ts';
import { orchestratorSwitch, type SwitchBase } from '../../lane/switcher.ts';
import { contentOf, echoLine, PREFIX, type Moved, type SendExtra } from '../../outbox.ts';
import { modelOverride } from '../../session/args.ts';
import { userLine } from '../../stream/writer.ts';
import { nextRunN, removeSessionFiles, writeSessionFiles } from '../../session/files.ts';
import { exitReason, SessionProcess, type ExitInfo } from '../../session/process.ts';
import { reason as keyed } from '../../../../shared/i18n/index.ts';
import type { KeyedReason, TokenCounts } from '../../../../shared/protocol.ts';
import { isAuthError, isLimitError, turnCost, type StreamEvent } from '../../stream/parser.ts';
import type { OrchKind } from '../../../../shared/issues.ts';
import { hashText, sessionStep, spawnPrompt } from '../../workflow/runtime.ts';
import { TurnFive } from '../resume.ts';
import { moveLanes, nextSeq, recordHandover, seqOf } from '../owners.ts';
import { orchAccount, orchBase } from './account.ts';
import { CLAUDE_DEFAULTS, tiered } from '../../models.ts';
import { ModelControl, ModelError, sessionPicks, type ModelChange, type ModelNow } from '../../session/model-control.ts';
import { FIRST_TEXT, handoffPathFor, handoffRequestText, MAX_AUTO_RESTARTS, newSessionText, resumeText, talkingToOf, todayIso } from './texts.ts';
import type { EndReason, OrchestratorDeps, OrchestratorEvent, OrchestratorState, OrchestratorView } from './types.ts';

/** v2.4 §5.3 after a `result` that left a written row unreplayed: no new turn within this → apply the waiting change anyway. */
const PENDING_GRACE_MS = 2_000;

export class Orchestrator {
  private state: OrchestratorState = 'starting';
  private account: string | null;
  private deaths = 0;
  private lastError: string | null = null;
  private lastErrorKeyed: KeyedReason | null = null;
  private proc: SessionProcess | null = null;
  private readonly procExit = new WeakMap<SessionProcess, Promise<ExitInfo>>();
  private runN = 0;
  private lastCtx: number | null = null;
  private model: string | null = null;
  private talkingTo: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** §4.14 set once the session has ended: a message that still names it goes to the session that took its lanes. */
  forwardTo: ((m: Moved) => Promise<unknown>) | null = null;
  /** v2.1 §5.3 W10 current session's tokens (rebuilt from its stored results after a restart). */
  private tokens: TokenMeter;
  /** v2.1 §4.14 five_pct before / after each turn (quota estimate samples). */
  private readonly five = new TurnFive((a) => this.d.quota?.get(a) ?? null);
  /** v2.1 §4.14 accounts orchestrating another session: ranked after at the first boot only. */
  private avoid: string[];
  /** v2.1 §4.14 a session id change (F21) → the owning Orchestrators re-keys. */
  onSessionId: ((from: string, to: string) => void) | null = null;
  /** v2.1 §4.14 "Chạy tiếp": the first resume message of the next spawn replaces `resumeText` once. */
  resumeNote: string | null = null;
  /** v2.4 §5.1–§5.3 picks, last real model / effort, the change waiting for the turn. */
  private readonly modelCtl: ModelControl;
  /** v2.7 §5.0 Thiết kế / Build / Chung: fixed for the session's life (appendix, `--settings` skill block, cap). */
  readonly kind: OrchKind;
  /** v2.7 §5.2-10 a Claude Code session made outside cc-slaves: its first spawn is already `--resume`. */
  private external = false;

  constructor(
    private readonly d: OrchestratorDeps,
    readonly projectId: string,
    private sessionId: string,
    private home: string | null,
    private readonly cwd: string,
    o: { account: string | null; state?: OrchestratorState; avoid?: string[]; kind?: OrchKind },
    private readonly emit: (e: OrchestratorEvent) => void,
  ) {
    this.account = o.account;
    this.kind = o.kind ?? 'general';
    if (o.state) this.state = o.state;
    this.avoid = o.avoid ?? [];
    this.tokens = new TokenMeter(sessionTokens(d.db, [sessionId]));
    this.modelCtl = new ModelControl({
      db: d.db, cache: d.modelCache, sessionId: () => this.sessionId, override: () => modelOverride() !== null,
      store: sessionPicks(d.db, () => this.sessionId), defaults: () => tiered(d.modelDefaults?.().orchestrator ?? CLAUDE_DEFAULTS), // v2.4 §5.6 tier 3
      changed: () => this.emit({ type: 'orchestrator', orchestrator: this.view() }),
    });
  }

  view(): OrchestratorView {
    return {
      projectId: this.projectId, sessionId: this.sessionId, state: this.state, account: this.account, home: this.home,
      deaths: this.deaths, lastError: this.lastError, lastErrorKeyed: this.lastErrorKeyed, alive: this.proc?.alive ?? false,
      contextPct: this.lastCtx, talkingTo: this.talkingTo, tokens: this.tokens.total,
      ...(this.model !== null ? { model: this.model } : {}), ...this.meta(), ...this.modelCtl.view(),
    };
  }

  private meta(): { seq: number | null; title: string | null } {
    const r = this.d.db.query<{ seq: number | null; title: string | null }, [string]>('SELECT seq, title FROM session WHERE id = ?').get(this.sessionId);
    return { seq: r?.seq ?? null, title: r?.title ?? null };
  }

  get currentSessionId(): string { return this.sessionId; }
  /** v2.6 §5.4-4 the running turn's start (epoch ms); null = no live process or between turns. */
  get turnStartedAt(): number | null { return this.proc?.turnStartedAt ?? null; }
  /** v2.1 §5.3 the running turn's provisional tokens (not stored yet). */
  get provisionalTokens(): TokenCounts { return this.tokens.provisional; }

  /** Raw control line (permission answer) to the current process; false when it has none. */
  writeControl(line: string): boolean {
    const p = this.proc;
    return p?.alive ? p.writeLine(line) : false;
  }

  /** Boot (new session or recovery). New → fresh with its first message; existing → resume (§7.1, §7.5). */
  boot(): Promise<void> { return this.job(() => this.bootNow()); }

  /**
   * hf1117-perf the boot after the caller's reply: a real `claude` boot (SessionStart hooks) takes seconds, the view says
   * `starting` meanwhile. A start failure is `died()`'s (restart, then the orchestrator_down card); a throw lands there too.
   */
  bootLater(): void { void this.boot().catch((err: unknown) => this.bootThrew(err)); }

  /** hotfix 2026-11-16 a held session ("Tiếp tục" / a PO message): `starting` now, boots after the reply; not held → no-op. */
  unpause(): Promise<void> { return this.wake(() => true); }

  /** v2.6 §5.5-4 (R15) after an update: nothing unsent → `idle` with no process (the next message boots it); else as `unpause`. */
  wakeAfterUpdate(): Promise<void> { return this.wake(() => listUndelivered(this.d.db, this.sessionId).length > 0); }

  private wake(boot: () => boolean): Promise<void> {
    return this.job(async () => {
      if (this.state !== 'paused') return;
      if (!boot()) { this.setState('idle'); return; }
      this.setState('starting');
      this.bootLater();
    });
  }

  /** Lane notices, PO messages, card answers: persisted first; written now when the session can take them (§7.6). */
  send(text: string, prefix: string | null = null, extra: SendExtra = {}): Promise<string | null> {
    return this.job(async () => {
      // §4.14 ended: stragglers follow its lanes, with their attachments (v2.4 §10.2)
      if (this.forwardTo) { await this.forwardTo({ text, prefix, attachments: extra.attachments ? [...extra.attachments] : null, echoed: extra.echoed ?? false }); return null; }
      return this.queued(this.d.outbox.enqueue(this.sessionId, text, prefix, extra).uuid);
    });
  }

  /** v2.4 §10.2 an undelivered row of another session moves here ("Kết thúc phiên", forwardTo), as `carryIn`. */
  carry(m: Moved): Promise<string | null> {
    return this.job(async () => {
      if (this.forwardTo) { await this.forwardTo(m); return null; }
      return this.queued(this.carryIn(m).uuid);
    });
  }

  /** v2.4 §10.2 a moved row keeps `attachments` + `echoed` (new uuid); an echoed one's `po` line is written here, once. */
  private carryIn(m: Moved): OutboxMsg {
    const row = this.d.outbox.enqueue(this.sessionId, m.text, m.prefix, { ...(m.attachments ? { attachments: m.attachments } : {}), echoed: m.echoed });
    if (row.echoed) this.emit({ type: 'po_line', projectId: this.projectId, sessionId: this.sessionId, line: echoLine(row) });
    return row;
  }

  /** A row just queued: written now when the session can take it (§7.6). */
  private async queued(uuid: string): Promise<string> {
    if (this.state === 'running') { this.proc?.flush(); return uuid; }
    if (this.state !== 'idle') return uuid; // starting/switching flush at init; waiting_quota/stopped/done/paused keep it queued
    if (!this.proc?.alive) { await this.bootNow(); return uuid; }
    await this.boundary();
    return uuid;
  }

  /**
   * v2.4 §5.3 change model and / or effort: no process → pick saved; idle → sent now (ModelError on `not_found` /
   * timeout); busy → `pending`, every outbox row held off stdin until the turn's `result`.
   */
  setModel(c: ModelChange): Promise<'now' | 'pending' | 'saved' | 'unsupported'> {
    return this.job(async () => {
      const p = this.proc;
      if (!p?.alive || this.account === null) { this.modelCtl.save(c); return 'saved'; }
      if (this.state !== 'idle' || this.d.outbox.hasUnreplayed(this.sessionId) || this.modelCtl.pending) {
        this.modelCtl.wait(c);
        p.hold();
        if (this.state === 'idle') this.graceApply(p); // §5.3 a written, unreplayed row: no result may come
        return 'pending';
      }
      const from = this.modelNow();
      p.hold();
      try {
        const r = await this.modelCtl.apply(p, this.account, c);
        if (r === 'now') this.emitModelChange(from);
        return r;
      } finally { this.releaseHeld(p); }
    });
  }

  /** v2.4 §5.4 `session_models` of this session: its own process answers; none alive → throws (the caller probes). */
  readModels(): ReturnType<ModelControl['read']> {
    const p = this.proc, a = this.account;
    if (!p?.alive || a === null) return Promise.reject(new Error('no process'));
    return this.modelCtl.read(p, a);
  }

  /** v2.4 §5.5 the account a probe for this session uses, and its project dir. */
  get modelScope(): { account: string | null; dir: string } { return { account: this.account ?? this.home, dir: this.cwd }; }

  /** v2.4 §5.5 `session_open` / `session_resume` picks (before boot). */
  presetModel(model: string | null | undefined, effort: string | null | undefined): void { this.modelCtl.preset(model, effort); }

  /** v2.4 §5.1 "Thay": this session takes the picks of the one it replaces. */
  inheritModel(from: Orchestrator): void { this.modelCtl.inherit(from.modelCtl); }

  /** v2.4 §5.3 "Bỏ thay đổi đang chờ": the change is dropped, what waited goes out now. */
  cancelModel(): Promise<void> {
    return this.job(async () => {
      if (!this.modelCtl.pending) return;
      this.modelCtl.cancel();
      if (this.proc) this.releaseHeld(this.proc);
    });
  }

  /** §3.4 I3 / §7.5: an account's numbers changed. */
  accountChanged(email: string): Promise<void> {
    return this.job(async () => {
      if (this.state === 'waiting_quota') { await this.bootNow(); return; }
      if ((email !== this.account && email !== this.home) || !this.proc?.alive) return;
      if (this.state === 'idle') { await this.boundary(); return; }
      if (this.state !== 'running') return;
      const s = this.decide(false);
      // Mid-turn only when the plan blocks outright; `defer` is handled at the turn's result.
      if (s?.kind === 'switch') {
        await this.proc.interrupt();
        await this.moveTo(s.to.email);
      } else if (s?.kind === 'waiting_quota') {
        await this.proc.interrupt();
        await this.closeProc();
        this.setState('waiting_quota');
      }
    });
  }

  /** v2 §6 A8L: its account was signed out → leave it like an auth error (v1 §7.5 handover; home is skipped). */
  accountLoggedOut(email: string): Promise<void> {
    return this.job(async () => {
      if (email !== this.account || !this.proc?.alive) return;
      this.emit({ type: 'account_logged_out', projectId: this.projectId, account: email });
      if (this.proc.alive && this.state === 'running') await this.proc.interrupt();
      await this.leave(email);
    });
  }

  /** §3.3-6 PO "Ngắt lượt": end the current turn; the session lives on. */
  async interrupt(): Promise<void> {
    if (this.proc?.alive) await this.proc.interrupt();
  }

  /** F11 "Khởi động lại": resume the same session, death count cleared. */
  restart(): Promise<void> {
    return this.job(async () => {
      await this.killProc();
      this.deaths = 0;
      this.lastError = null; this.lastErrorKeyed = null;
      this.setState('starting');
      this.bootLater();
    });
  }

  /**
   * F21 "Phiên mới": if the session is alive, ask it to write the handoff and wait for that turn's result; close it;
   * start a new session whose first message points at the handoff. Undelivered messages move to the new session after
   * the first message. Lanes are not touched, only their owner moves to the new session (§4.14: it gets a new #n).
   */
  newSession(handoffPath?: string): Promise<{ sessionId: string; handoffPath: string }> {
    return this.job(async () => {
      const handoff = handoffPath ?? handoffPathFor((this.d.today ?? todayIso)());
      const { db, outbox } = this.d;
      const old = this.sessionId;
      const { workflow, step } = sessionStep(db, old); // v2.9 §6.1 the new session keeps the old one's pin
      const { carried } = await this.closeNow(handoff, 'replaced', false);
      this.sessionId = (this.d.newSessionId ?? randomUUID)();
      this.newSessionRow({ rev: workflow.rev, step: step.id, text: step.appendix });
      this.modelCtl.rebind(); // §5.1 the replacing session inherits the picks
      recordHandover(db, old, this.sessionId, moveLanes(db, old, this.sessionId)); // §4.14 the new session takes them (F21 text says lanes_list)
      this.onSessionId?.(old, this.sessionId);
      outbox.enqueue(this.sessionId, newSessionText(handoff), PREFIX.engine);
      for (const m of carried) this.carryIn(m); // v2.4 §10.2 with attachments + echoed
      db.query('DELETE FROM outbox WHERE session_id = ? AND delivered_at IS NULL').run(old);
      this.deaths = 0;
      this.lastError = null; this.lastErrorKeyed = null;
      this.runN = 0;
      this.lastCtx = null;
      this.model = null;
      this.tokens = new TokenMeter(); // §5.3 tokens are per session, like costUsd
      this.setState('starting');
      this.bootLater();
      return { sessionId: this.sessionId, handoffPath: handoff };
    });
  }

  /**
   * §4.14 "Kết thúc phiên": a live session writes its handoff first (a stopped one cannot); then it is closed for good.
   * Returns its undelivered messages (the caller moves them) and the handoff path, null when none was written.
   */
  end(handoff: string, reason: EndReason = 'ended_by_po'): Promise<{ carried: OutboxMsg[]; handoffPath: string | null }> {
    return this.job(async () => {
      const r = await this.closeNow(handoff, reason, reason !== 'replaced'); // F21 / "Thay" keep the asks (they follow the lanes)
      this.closed = true;
      this.d.db.query('DELETE FROM outbox WHERE session_id = ? AND delivered_at IS NULL').run(this.sessionId);
      this.state = 'done';
      return r;
    });
  }

  /** Handoff (live session only), kill, mark the row ended, revoke MCP; emits the end boundary + session_ended. */
  private async closeNow(handoff: string, reason: EndReason, expireAsks: boolean) {
    const { db } = this.d;
    let requestUuid: string | null = null;
    const p = this.proc;
    const live = !!p?.alive && (this.state === 'idle' || this.state === 'running');
    if (live) {
      // v2.4 §5.3 held for a model change: only the handoff request goes past the hold (on the old model)
      const m = p.held ? this.writePastHold(p, handoffRequestText(handoff)) : p.send(handoffRequestText(handoff), PREFIX.engine);
      requestUuid = m.uuid;
      this.setState('running');
      await this.handoffWritten(p, m.uuid);
    }
    await this.killProc();
    const old = this.sessionId;
    const handoffPath = live ? handoff : null;
    const at = this.nowS();
    db.query("UPDATE session SET state = 'done', ended_at = ?, end_reason = ?, handoff_path = ? WHERE id = ?").run(at, reason, handoffPath, old);
    removeSessionFiles(old);
    this.d.outbox.discardDelivered(old); // v2.4 §6.5 the file copies delivered to it; undelivered rows keep theirs (they move)
    this.d.onSessionEnded?.(old);
    this.emit({ type: 'boundary', projectId: this.projectId, sessionId: old, boundary: { type: 'end', seq: seqOf(db, old), at, handoff: handoffPath, endReason: reason } });
    this.emit({ type: 'session_ended', projectId: this.projectId, sessionId: old, reason, expireAsks });
    const carried = listUndelivered(db, old).filter((m) => m.uuid !== requestUuid);
    return { carried, handoffPath };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const p = this.proc;
    if (p) this.keepCutTokens(); // engine stop mid-turn (§5.3)
    this.proc = null;
    if (p) await p.terminate(500);
  }

  /** §5.3 a turn cut short: commit its provisional tokens and store them (`usage` event) for restart / today / 5 h. */
  private keepCutTokens(): void {
    const usage = this.tokens.abandon();
    if (usage) insertEvent(this.d.db, { sessionId: this.sessionId, type: 'usage', json: { run: this.runN, usage } });
  }

  /**
   * v2.7 §5.2-10 the row was made for a Claude Code session started outside cc-slaves: spawn `--resume` from the start;
   * its first resume line carries its step's rules (its system prompt never had them), sent once.
   */
  adoptExternal(): void {
    this.external = true;
    const { step } = sessionStep(this.d.db, this.sessionId);
    this.resumeNote = `Quy tắc cc-slaves cho phiên này (${step.name}): ${step.appendix}`;
  }

  /** Insert the session row of a brand-new session (v2.9 §6.1 pinned rev + step, the hash of its text; next #n, optional title). */
  newSessionRow(pin: { rev: string; step: string; text: string }, title: string | null = null): void {
    const { db } = this.d;
    insertSession(db, { id: this.sessionId, projectId: this.projectId, kind: 'orchestrator', account: this.account });
    const seq = nextSeq(db, this.projectId);
    // R-B13 (a) a cwd other than the project root (a resumed Build session's) is kept, so a restart restores it there
    db.query('UPDATE session SET workflow_rev = ?, step = ?, prompt_hash = ?, seq = ?, title = ?, account_home = ?, orch_kind = ?, cwd = NULLIF(?, (SELECT path FROM project WHERE id = ?)) WHERE id = ?')
      .run(pin.rev, pin.step, hashText(pin.text), seq, title, this.home, this.kind, this.cwd, this.projectId, this.sessionId);
    this.emit({ type: 'boundary', projectId: this.projectId, sessionId: this.sessionId, boundary: { type: 'start', seq, at: this.nowS(), account: this.account } });
  }

  // ---------- internals ----------

  private job<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f);
    this.chain = p.catch(() => {});
    return p;
  }

  private nowS(): number { return (this.d.now ?? (() => Math.floor(Date.now() / 1000)))(); }

  private setState(s: OrchestratorState): void {
    this.state = s;
    updateSession(this.d.db, this.sessionId, { state: s, account: this.account });
    this.emit({ type: 'orchestrator', orchestrator: this.view() });
  }

  /** v1.1 §5.2: emit only on a change (one event per new lane name, not per tool call). */
  private setTalkingTo(t: string | null): void {
    if (this.talkingTo === t) return;
    this.talkingTo = t;
    this.emit({ type: 'orchestrator', orchestrator: this.view() });
  }

  private acct(email: string | null): Account | null {
    return email === null ? null : this.d.accounts().find((a) => a.email === email) ?? null;
  }

  private base(): SwitchBase { return orchBase(this.d, this.nowS()); }

  /** `orchestratorSwitch` on the current account; null when the current account is gone. */
  private decide(atTurnBoundary: boolean) {
    const current = this.acct(this.account);
    if (!current) return null;
    const home = this.acct(this.home) ?? current;
    return orchestratorSwitch(this.base(), { home, current, atTurnBoundary });
  }

  /** Account to (re)start on: home when it has room, else a primary soft fallback (§7.5); null = none (waiting_quota). */
  private chooseAccount(exclude: string[] = []): string | null { return orchAccount(this.d, this.home, exclude, this.nowS()); }

  /** A delivered message means claude persisted the conversation → --resume. */
  private conversationExists(): boolean {
    return this.external || this.d.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM outbox WHERE session_id = ? AND delivered_at IS NOT NULL')
      .get(this.sessionId)!.n > 0;
  }

  private async bootNow(): Promise<void> {
    if (this.closed) return;
    let to: string | null = null;
    if (this.avoid.length) {
      // §4.14 a parallel session: an account orchestrating another session ranks after; the one picked is its home
      to = this.chooseAccount(this.avoid) ?? this.chooseAccount();
      this.avoid = [];
      if (to !== null) { this.home = to; this.d.db.query('UPDATE session SET account_home = ? WHERE id = ?').run(to, this.sessionId); }
    } else to = this.chooseAccount();
    if (to === null) { await this.killProc(); this.setState('waiting_quota'); return; }
    await this.spawn(to);
  }

  /** Turn boundary: return home / leave a capped account; otherwise write anything queued. */
  private async boundary(): Promise<void> {
    const s = this.decide(true);
    if (s?.kind === 'switch') { await this.moveTo(s.to.email); return; }
    if (s?.kind === 'waiting_quota') { await this.closeProc(); this.setState('waiting_quota'); return; }
    if ((this.proc?.flush() ?? 0) > 0) this.setState('running');
  }

  private async leave(exclude: string): Promise<void> {
    const to = this.chooseAccount([exclude]);
    if (to === null) { await this.closeProc(); this.setState('waiting_quota'); return; }
    await this.moveTo(to);
  }

  private async moveTo(email: string): Promise<void> {
    this.setState('switching');
    await this.closeProc();
    await this.spawn(email);
  }

  private detach(): SessionProcess | null {
    const p = this.proc;
    if (p) this.keepCutTokens(); // killed for a switch / restart: no result will come for its turn
    this.modelCtl.settle(); // v2.4 §5.3 a waiting change becomes the pick of the next process
    this.proc = null;
    return p;
  }

  private async closeProc(): Promise<void> {
    const p = this.detach();
    if (!p?.alive) return;
    p.closeStdin();
    const exit = this.procExit.get(p)!;
    const t = await Promise.race([exit.then(() => 'exited' as const), Bun.sleep(this.d.closeGraceMs ?? 5000).then(() => 'timeout' as const)]);
    if (t === 'timeout') await p.terminate(2000);
  }

  private async killProc(): Promise<void> {
    const p = this.detach();
    if (p?.alive) await p.terminate(2000);
  }

  private async spawn(email: string): Promise<void> {
    if (this.closed) return;
    if (this.deferSpawn(email)) return;
    const { db, outbox } = this.d;
    const acct = this.acct(email);
    // the target can be removed while closeProc() waits (§7.1-3 T3): re-pick instead of wedging in `switching`.
    if (!acct) { await this.leave(email); return; }
    const resume = this.conversationExists();
    // v2.9 §6.1 the pinned step's settings + text; a resumed session whose text changed gets it once, after the resume message.
    const prompt = spawnPrompt(db, this.sessionId, resume);
    if (prompt.update !== null) outbox.enqueue(this.sessionId, prompt.update, null);
    else if (!resume && listUndelivered(db, this.sessionId).length === 0) {
      outbox.enqueue(this.sessionId, FIRST_TEXT, PREFIX.engine);
    }
    this.account = email;
    if (this.state !== 'switching') this.setState('starting');
    else updateSession(db, this.sessionId, { account: email });
    const sid = this.sessionId;
    const files = writeSessionFiles(sid, { port: this.d.mcpPort, projectId: this.projectId, ...this.d.sessionSetup?.(this.projectId), step: prompt.step });
    this.d.onMcpToken?.(sid, { token: files.token, mcpIds: files.mcpIds, graph: files.graph, cwd: this.cwd });
    const proc = new SessionProcess({
      ...this.d.session,
      sessionId: sid, resume, resumeText: this.resumeNote ?? resumeText(email), projectId: this.projectId, lane: '_orchestrator', runN: this.runN = nextRunN(this.projectId, '_orchestrator', this.runN),
      cwd: this.cwd,
      args: {
        settingsPath: files.settingsPath, mcpConfigPath: files.mcpPath,
        appendSystemPrompt: prompt.text, ...this.modelCtl.argv(),
      },
      beforeFirstWrite: (p) => this.modelCtl.handshake(p, email), // v2.4 §5.2 orchestrator only
      account: { email, configDir: acct.configDir, terminal: acct.terminal },
      outbox, command: this.d.command, env: () => this.d.env(acct),
      ...(this.d.caffeinate ? { caffeinate: this.d.caffeinate } : {}),
      ...(this.d.gate ? { update: { gate: this.d.gate, kind: 'orchestrator' as const } } : {}), // v2.6 §5.4
    });
    if (resume) this.resumeNote = null; // once: a later death resumes with the plain resume note
    this.procExit.set(proc, new Promise<ExitInfo>((r) => proc.on('exit', r)));
    proc.on('event', (e) => this.onStream(proc, email, e));
    proc.on('exit', (x) => {
      if (this.proc === proc) this.setTalkingTo(null);
      this.emit({ type: 'session_exit', projectId: this.projectId, sessionId: sid });
      void this.job(() => this.onExit(proc, x));
    });
    this.proc = proc;
    const r = await proc.start();
    if (r.ok && r.version !== null) this.emit({ type: 'claude_version', version: r.version, ok: true });
    if (!r.ok && r.failure.kind === 'old_version' && r.failure.version !== null) {
      this.emit({ type: 'claude_version', version: r.failure.version, ok: false, message: r.failure.message, reason: r.failure.reason });
    }
    if (this.proc !== proc) return;
    if (!r.ok) {
      this.proc = null;
      this.modelCtl.settle();
      await this.died(keyed('errors.orchStart', undefined, r.failure.reason));
      return;
    }
    updateSession(db, sid, { pid: proc.pid });
    this.setState('running');
    proc.flush();
  }

  /**
   * v2.6 §5.4-3 held for an update: the state reads `starting` / `switching` as usual, the spawn waits for the release
   * (gone when the session moved on meanwhile) or the next boot. False = not held, spawn now.
   */
  private deferSpawn(email: string): boolean {
    const gate = this.d.gate;
    if (!gate || gate.writes) return false;
    if (this.state !== 'switching') this.setState('starting');
    const at = this.state;
    return gate.defer(this.sessionId, () => { void this.job(async () => { if (!this.closed && !this.proc && this.state === at) await this.spawn(email); }); });
  }

  /**
   * v2.6 §5.4 the update hold ended: what waited is written now (an idle session's turn starts). Not queued on `job`: a
   * close job waiting for its held handoff request would block its own release until the handoff timeout.
   */
  writesOpened(): void {
    if ((this.proc?.flush() ?? 0) > 0 && this.state === 'idle') this.setState('running');
  }

  private onStream(proc: SessionProcess, email: string, e: StreamEvent): void {
    if ((e.kind === 'assistant' || e.kind === 'stream_event') && this.proc === proc) this.five.start(email);
    if (e.kind === 'init' && this.proc === proc && e.model !== null) this.model = e.model; // §4.4 N1-i tooltip
    if (e.kind === 'assistant' && this.proc === proc && proc.contextPct !== null) this.lastCtx = proc.contextPct;
    // §4.14 session.ctx_last: context tokens of its last assistant message (resume preview, part B)
    if (e.kind === 'assistant' && this.proc === proc && proc.contextTokens !== null) {
      this.d.db.query('UPDATE session SET ctx_last = ? WHERE id = ? AND (ctx_last IS NULL OR ctx_last <> ?)').run(proc.contextTokens, this.sessionId, proc.contextTokens);
    }
    // §5.3 W10 tokens move within the turn; the `result` below replaces the provisional sum
    if (e.kind === 'assistant' && this.proc === proc && this.tokens.assistant(e)) this.emit({ type: 'orchestrator', orchestrator: this.view() });
    if (this.proc === proc) {
      if (e.kind === 'assistant') { const t = talkingToOf(e.message); if (t !== undefined) this.setTalkingTo(t); }
      else if (e.kind === 'result') this.setTalkingTo(null);
    }
    if ((e.kind === 'stream_event' || e.kind === 'assistant' || e.kind === 'user' || e.kind === 'result') && this.proc === proc) { // result: v2.2 §14.4 turn end
      this.emit({ type: 'stream', projectId: this.projectId, sessionId: this.sessionId, event: e });
    }
    if ((e.kind === 'can_use_tool' || e.kind === 'control_cancel_request') && this.proc === proc) {
      this.emit({ type: 'control', projectId: this.projectId, sessionId: this.sessionId, event: e });
      return;
    }
    if (e.kind === 'rate_limit_event') {
      this.d.quota.applyRateLimitEvent(email, e);
      void this.accountChanged(email);
      return;
    }
    if (e.kind !== 'result' && e.kind !== 'assistant') return;
    void this.job(async () => {
      if (this.proc !== proc) return;
      if (e.kind === 'assistant') {
        if (this.state === 'idle') this.setState('running'); // self-started turn
        return;
      }
      if (e.kind !== 'result') return;
      // §8.6: same row as a lane's result → orchestrator cost in its view and in "cost today"
      const usage = this.tokens.result(e);
      insertEvent(this.d.db, {
        sessionId: this.sessionId, type: 'result',
        json: { run: this.runN, turnCost: turnCost(e), totalCostUsd: e.totalCostUsd, isError: e.isError, subtype: e.subtype, usage, ...this.five.end(email) },
      });
      if (isAuthError(e)) {
        this.emit({ type: 'account_logged_out', projectId: this.projectId, account: email });
        await this.leave(email);
        return;
      }
      if (isLimitError(e)) {
        this.d.quota.markLimited?.(email);
        await this.leave(email);
        return;
      }
      this.deaths = 0;
      this.setState('idle');
      if (this.modelCtl.pending) { await this.pendingAtResult(proc); return; }
      this.afterTurn(proc, email);
      await this.boundary();
    });
  }

  /**
   * v2.4 §5.3 a turn ended with a change waiting: a row still written and unreplayed opens the next turn right away →
   * wait for that turn's result (or PENDING_GRACE_MS without a new turn); else apply now, then write what was held.
   */
  private async pendingAtResult(proc: SessionProcess): Promise<void> {
    if (this.d.outbox.hasUnreplayed(this.sessionId)) {
      this.graceApply(proc);
      await this.boundary();
      return;
    }
    await this.applyPending(proc);
  }

  /** §5.3 still idle with the change waiting PENDING_GRACE_MS later (no new turn opened) → applied. */
  private graceApply(proc: SessionProcess): void {
    setTimeout(() => void this.job(async () => {
      if (this.proc === proc && this.state === 'idle' && this.modelCtl.pending) await this.applyPending(proc);
    }), PENDING_GRACE_MS);
  }

  private async applyPending(proc: SessionProcess): Promise<void> {
    const c = this.modelCtl.pending!;
    const from = this.modelNow();
    try {
      if ((await this.modelCtl.apply(proc, this.account ?? '', c)) === 'now') this.emitModelChange(from);
    } catch (e) { // §5.3 failed: pending dropped, the held rows go out on the old model
      const code = e instanceof ModelError ? e.code : 'failed';
      this.emit({ type: 'model_change', projectId: this.projectId, sessionId: this.sessionId, from, to: from, error: { code, message: (e as Error).message } });
    }
    this.modelCtl.cancel();
    if (this.releaseHeld(proc) === 0) await this.boundary();
  }

  /** v2.4 §5.2 read back after each turn; a null pick off the default → `set_model {default}` once, on an idle session only. */
  private afterTurn(proc: SessionProcess, email: string): void {
    void this.modelCtl.reread(proc, email).then((reset) => {
      if (!reset) return;
      void this.job(async () => {
        if (this.proc !== proc || this.state !== 'idle' || this.d.outbox.hasUnreplayed(this.sessionId) || this.modelCtl.pending) return;
        proc.hold();
        try { await this.modelCtl.resetDefault(proc, email); } catch { /* the next turn's read tries nothing more (once) */ } finally { this.releaseHeld(proc); }
      });
    }, () => { /* no reply: the view keeps the last values */ });
  }

  /** End a hold; rows written → a turn runs. Returns how many went out. */
  private releaseHeld(p: SessionProcess): number {
    if (this.proc !== p) return 0;
    const n = p.release();
    if (n > 0) this.setState('running');
    return n;
  }

  private modelNow(): ModelNow { return this.modelCtl.now; }

  private emitModelChange(from: ModelNow): void {
    this.emit({ type: 'model_change', projectId: this.projectId, sessionId: this.sessionId, from, to: this.modelNow() });
  }

  /** v2.4 §5.3 an engine row written straight to stdin past the hold (the handoff request of F21 / end). */
  private writePastHold(p: SessionProcess, text: string): { uuid: string } {
    const m = this.d.outbox.enqueue(this.sessionId, text, PREFIX.engine);
    p.writeLine(userLine(contentOf(m), m.uuid));
    return m;
  }

  private async onExit(proc: SessionProcess, x: ExitInfo): Promise<void> {
    if (this.proc !== proc) return;
    this.proc = null;
    this.modelCtl.settle(); // v2.4 §5.3 died while a change waited: it is the pick of the resumed process
    this.keepCutTokens(); // §5.3 a turn cut short keeps the tokens it reported
    if (x.kind === 'requested') return;
    if (x.kind === 'exited_idle' && this.state === 'idle') return; // quiet quit: the next message resumes it
    await this.died(exitReason(x));
  }

  /** A boot that threw: stopped + orchestrator_down card, no restart. */
  private bootThrew(err: unknown): void {
    if (this.closed) return;
    const detail = err instanceof Error ? err.message : String(err);
    const why = keyed('errors.orchStart', undefined, { key: 'errors.internal', params: { detail } });
    const { text: reason, ...reasonKeyed } = why;
    this.lastError = reason;
    this.lastErrorKeyed = reasonKeyed;
    this.setState('stopped');
    this.emit({ type: 'system_card', kind: 'orchestrator_down', projectId: this.projectId, sessionId: this.sessionId, reason, reasonKeyed });
  }

  /** §7.5 / F11: restart once (resume); the second death → stopped + system card. */
  private async died(why: KeyedReason & { text: string }): Promise<void> {
    const { text: reason, ...reasonKeyed } = why;
    this.deaths++;
    this.lastError = reason;
    this.lastErrorKeyed = reasonKeyed;
    if (this.deaths <= MAX_AUTO_RESTARTS) {
      this.setState('starting');
      await this.bootNow();
      return;
    }
    this.setState('stopped');
    this.emit({ type: 'system_card', kind: 'orchestrator_down', projectId: this.projectId, sessionId: this.sessionId, reason, reasonKeyed });
  }

  /** F21: resolves at the first result after the handoff request entered the conversation (or exit / timeout). */
  private handoffWritten(p: SessionProcess, uuid: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.d.handoffTimeoutMs ?? 600_000);
      const done = () => { clearTimeout(timer); resolve(); };
      void this.procExit.get(p)?.then(done);
      p.on('event', (e) => {
        if (e.kind !== 'result') return;
        const row = this.d.db.query<{ d: number | null }, [string]>('SELECT delivered_at AS d FROM outbox WHERE uuid = ?').get(uuid);
        if (row?.d !== null && row?.d !== undefined) done();
      });
    });
  }
}
