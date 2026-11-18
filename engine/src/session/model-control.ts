// v2.4 §5.1–§5.3, §5.6 one session's model / effort (orchestrator or lane): the PO's picks (tier 1, behind a store port),
// the tiers 2–4 default resolved at each spawn, the values last read from Claude Code (`last*`, the session row), the
// handshake after every new process, the re-read after each turn, a change now or `pending` (the owner decides which and
// holds stdin). Control requests and their shapes: NC §8 (Claude Code 2.1.325).
import { getSessionModel, setSessionModel, type Db } from '../db.ts';
import type { SessionProcess } from './process.ts';
import { CLAUDE_DEFAULTS, defaultModelOf, findModel, parseModels, parseSettings, type Applied, type Configured, type Defaults, type ModelCache, type ModelInfo } from '../models.ts';

type Obj = Record<string, unknown>;
type Request = Parameters<SessionProcess['control']>[0];
type Reply = Awaited<ReturnType<SessionProcess['control']>>;

/** What the control needs of a process (SessionProcess; tests: a scripted port). */
export interface ControlPort {
  control(r: Request): Promise<Reply>;
  hold(): void;
  release(): number;
  readonly held: boolean;
  readonly alive: boolean;
}

/** v2.4 §4.3 model / effort as shown in the "Đổi model: … → …" line. */
export interface ModelNow { modelName: string | null; effort: string | null }

/** A change the PO asked for: `model: null` = "Theo mặc định"; effort is never null (§5.5). */
export interface ModelChange { model?: string | null; effort?: string }

/** §5.2 / §5.3 why a change or the handshake failed (`timeout`: no reply within the cap; `failed`: another error reply). */
export class ModelError extends Error {
  constructor(readonly code: 'model_not_found' | 'timeout' | 'failed', message: string) { super(message); this.name = 'ModelError'; }
}

const HANDSHAKE_MS = 5_000;
/** §5.2 both sides through `resolvedModel` (alias, value, `[1m]` dropped); one side unresolvable → same (do nothing). */
export function sameModel(models: readonly ModelInfo[], a: string | null, b: string | null): boolean {
  const x = findModel(models, a), y = findModel(models, b);
  return !x || !y || x.resolvedModel === y.resolvedModel;
}

/** §5.5 `SessionRowView` / `ResumePreview` model fields of a session row (last real values + picks). */
export function sessionModelView(db: Db, sessionId: string): { model?: string; modelName?: string; effort: string | null; modelPick: string | null; effortPick: string | null } {
  const m = getSessionModel(db, sessionId);
  return {
    ...(m.lastModel !== null ? { model: m.lastModel } : {}), ...(m.lastModelName !== null ? { modelName: m.lastModelName } : {}),
    effort: m.lastEffort, modelPick: m.modelPick, effortPick: m.effortPick,
  };
}

/** §5.6 tier 1: the PO's / Điều phối's pick (`null` = "Theo mặc định"; effort `null` = engine sets nothing). */
export interface Picks { modelPick: string | null; effortPick: string | null }
/** §5.6 where tier 1 lives: the orchestrator's `session` row, a lane's `lane` row. */
export interface PickStore { loadPick(): Picks; savePick(p: Picks): void }

/** §5.6 the orchestrator's tier 1 on its `session` row (the row follows the session id across F21). */
export function sessionPicks(db: Db, sessionId: () => string): PickStore {
  return {
    loadPick: () => { const m = getSessionModel(db, sessionId()); return { modelPick: m.modelPick, effortPick: m.effortPick }; },
    savePick: (p) => setSessionModel(db, sessionId(), { ...getSessionModel(db, sessionId()), ...p }),
  };
}

export interface ModelControlDeps {
  db: Db;
  /** The session row holding `last*`. */
  sessionId: () => string;
  /** §5.6 tier 1. */
  store: PickStore;
  /** §5.6 tiers 2–4 resolved now (read at each spawn and when the PO picks "Theo mặc định"). */
  defaults: () => Defaults;
  /** §5.2 `CC_SLAVES_MODEL_OVERRIDE` is set: no default rules, no `modelMismatch`. */
  override?: () => boolean;
  /** §5.4 the engine's one model cache (models per account, 60 s). */
  cache: ModelCache;
  /** Cap of one chain of control requests (handshake / change / re-read), default 5 s. */
  timeoutMs?: number;
  /** The view fields changed. */
  changed: () => void;
}

interface Last { lastModel: string | null; lastModelName: string | null; lastEffort: string | null }

export class ModelControl {
  private p: Picks;
  private last: Last;
  private pend: ModelChange | null = null;
  /** "Theo mặc định" clicked while busy: tiers 2–4 resolved at the click (§5.6). */
  private pendSnap: Defaults | null = null;
  /** §5.6 tiers 2–4 resolved at this process's spawn; only a "Theo mặc định" click replaces it. */
  private snap: Defaults = CLAUDE_DEFAULTS;
  private mismatch = false;
  /** The account of the last read (display names come from its list). */
  private account: string | null = null;
  private configured: string | null = null;
  private readonly resetDone = new WeakSet<ControlPort>();

  constructor(private readonly d: ModelControlDeps) {
    this.p = d.store.loadPick();
    const m = getSessionModel(d.db, d.sessionId());
    this.last = { lastModel: m.lastModel, lastModelName: m.lastModelName, lastEffort: m.lastEffort };
  }

  get pending(): ModelChange | null { return this.pend; }
  get picks(): Picks { return this.p; }
  /** §4.3 the values the "Đổi model" line shows. */
  get now(): ModelNow { return { modelName: this.last.lastModelName, effort: this.last.lastEffort }; }
  /** §5.6 `LaneView.run`: the real model last read (null until known). */
  get run(): { model: string; modelName?: string; effort: string | null } | null {
    const l = this.last;
    return l.lastModel === null ? null : { model: l.lastModel, ...(l.lastModelName !== null ? { modelName: l.lastModelName } : {}), effort: l.lastEffort };
  }

  /** §5.2 step 1 / §5.6 at each spawn: resolve tiers 2–4 now (the snapshot of this process); tiers 1–3 go on the argv. */
  argv(): { model?: string; effort?: string } {
    this.snap = this.d.defaults();
    const model = this.p.modelPick ?? this.snap.model, effort = this.p.effortPick ?? this.snap.effort;
    return { ...(model !== null ? { model } : {}), ...(effort !== null ? { effort } : {}) };
  }

  /** §5.5 the OrchestratorView fields. */
  view(): { modelName?: string; effort: string | null; modelPick: string | null; effortPick: string | null; pending?: { model?: string | null; modelName?: string; effort?: string }; modelMismatch: boolean } {
    const p = this.pend;
    const pendingName = p && 'model' in p ? this.nameOf(p.model ?? (this.pendSnap?.model ?? this.defaultModel())) : null;
    return {
      ...(this.last.lastModelName !== null ? { modelName: this.last.lastModelName } : {}), effort: this.last.lastEffort,
      modelPick: this.p.modelPick, effortPick: this.p.effortPick, modelMismatch: this.mismatch,
      ...(p ? { pending: { ...p, ...(pendingName !== null ? { modelName: pendingName } : {}) } } : {}),
    };
  }

  /** §5.2 steps 2–4 (`beforeFirstWrite`): read, reset a tier-4 session to Claude Code's default, flag a mismatch, read again. */
  async handshake(p: ControlPort, account: string, by = this.deadline()): Promise<void> {
    let s = await this.settings(p, by);
    const models = await this.models(p, account, by);
    if (!this.overridden() && this.target() === null && !sameModel(models, s.applied.model, this.defaultModel())) {
      await this.ask(p, this.defaultRequest(), by);
      s = await this.settings(p, by);
    }
    this.store(s.applied, models);
  }

  /** §5.2 after each `result`: read again; true = a tier-4 session runs off the default and this process was not reset yet. */
  async reread(p: ControlPort, account: string): Promise<boolean> {
    const by = this.deadline();
    const s = await this.settings(p, by);
    const models = await this.models(p, account, by);
    this.store(s.applied, models);
    return !this.overridden() && this.target() === null && !this.resetDone.has(p) && !sameModel(models, s.applied.model, this.defaultModel());
  }

  /** §5.2 the once-per-process `set_model {default}` (Orchestrator calls it only on an idle session). */
  async resetDefault(p: ControlPort, account: string): Promise<void> {
    this.resetDone.add(p);
    if (this.target() !== null) return; // the PO picked while the re-read was in flight: never undo it
    const by = this.deadline();
    await this.ask(p, this.defaultRequest(), by);
    this.store((await this.settings(p, by)).applied, await this.models(p, account, by));
  }

  /**
   * §5.3 send a change to an idle process: `set_model` and / or `apply_flag_settings`, then read back (the reply of
   * `apply_flag_settings` proves nothing, NC §8-5). `unsupported_request` → the pick is saved for the next spawn.
   * "Theo mặc định" (`model: null`) sends tiers 2–4 resolved at the click (§5.6), which become this process's snapshot
   * once Claude Code accepted them. `by`: the deadline of the chain this change belongs to (§5.2 handshake: one ≤ 5 s cap).
   */
  async apply(p: ControlPort, account: string, c: ModelChange, by = this.deadline()): Promise<'now' | 'unsupported'> {
    let unsupported = false;
    if ('model' in c) {
      const snap = c.model === null ? (c === this.pend && this.pendSnap ? this.pendSnap : this.d.defaults()) : null;
      const req = snap ? (this.overridden() ? null : this.defaultRequest(snap)) : { subtype: 'set_model', model: c.model };
      if (req) unsupported = (await this.ask(p, req, by)) === 'unsupported';
      if (snap && !unsupported) this.snap = snap;
    }
    if (c.effort !== undefined && !unsupported) {
      unsupported = (await this.ask(p, { subtype: 'apply_flag_settings', settings: { effortLevel: c.effort } }, by)) === 'unsupported';
    }
    this.save(c);
    if (unsupported) return 'unsupported';
    this.store((await this.settings(p, by)).applied, await this.models(p, account, by));
    return 'now';
  }

  /** §5.4 `session_models` of a running session: its own process answers (list from the cache when fresh). */
  async read(p: ControlPort, account: string): Promise<{ list: ModelInfo[] } & Configured> {
    const by = this.deadline();
    const s = await this.settings(p, by);
    return { list: await this.models(p, account, by), configured: s.configured, configuredEffort: s.configuredEffort };
  }

  /** §5.5 `session_open` / `session_resume` picks, before the first spawn (`effort: null` = engine sets nothing). */
  preset(model: string | null | undefined, effort: string | null | undefined): void {
    if (model === undefined && effort === undefined) return;
    this.setPicks({ ...this.p, ...(model !== undefined ? { modelPick: model } : {}), ...(effort !== undefined ? { effortPick: effort } : {}) });
  }

  /** §5.3 a session with no process: only the pick is saved (applied at the next spawn). */
  save(c: ModelChange): void {
    this.setPicks({ ...this.p, ...('model' in c ? { modelPick: c.model ?? null } : {}), ...(c.effort !== undefined ? { effortPick: c.effort } : {}) });
    this.d.changed();
  }

  /** §5.3 busy: remember the change (in memory only) until the turn ends. */
  wait(c: ModelChange): void {
    if (c.model === null) this.pendSnap = this.d.defaults(); // §5.6 "Theo mặc định" resolves at the click
    else if ('model' in c) this.pendSnap = null;
    this.pend = { ...this.pend, ...c };
    this.d.changed();
  }

  /** §5.3 "Bỏ thay đổi đang chờ" / a failed apply: the change is gone. */
  cancel(): void {
    if (!this.pend) return;
    this.pend = null;
    this.pendSnap = null;
    this.d.changed();
  }

  /** §5.3 the process ended or is replaced while a change waits: it becomes the pick (the next spawn gets it on argv). */
  settle(): void {
    const c = this.pend;
    if (!c) return;
    this.pend = null;
    this.pendSnap = null;
    this.save(c);
  }

  /** §5.1 a replacing session (open "Thay") inherits the replaced one's picks. */
  inherit(from: ModelControl): void { this.setPicks(from.p); }

  /** §5.1 F21: same Orchestrator, new session row → it keeps the picks; the last real values belong to the old row. */
  rebind(): void {
    this.last = { lastModel: null, lastModelName: null, lastEffort: null };
    this.mismatch = false;
    this.setPicks(this.p);
    this.saveLast();
  }

  // ---------- internals ----------

  /** §5.2 the end of a chain of control requests started now. */
  deadline(): number { return Date.now() + (this.d.timeoutMs ?? HANDSHAKE_MS); }

  private overridden(): boolean { return this.d.override?.() ?? false; }

  private setPicks(p: Picks): void { this.p = p; this.d.store.savePick(p); }
  private saveLast(): void { setSessionModel(this.d.db, this.d.sessionId(), { ...getSessionModel(this.d.db, this.d.sessionId()), ...this.last }); }

  /** §5.6 the model this process must run: the pick, else tiers 2–3 of the spawn snapshot; null = tier 4 (Claude Code). */
  private target(): string | null { return this.p.modelPick ?? this.snap.model; }

  /** §5.1 / §5.6 the default this session should run: tiers 2–3 of the snapshot, else the configured one, else the plan's. */
  private defaultModel(): string | null { return this.snap.model ?? defaultModelOf(this.list(), this.configured); }

  private defaultRequest(snap = this.snap): Request {
    const m = snap.model ?? this.configured;
    return m !== null ? { subtype: 'set_model', model: m } : { subtype: 'set_model' };
  }

  private list(): ModelInfo[] { return this.account === null ? [] : this.d.cache.lastModels(this.account); }
  private nameOf(m: string | null): string | null { return findModel(this.list(), m)?.displayName ?? null; }

  private store(a: Applied, models: readonly ModelInfo[]): void {
    const name = findModel(models, a.model)?.displayName ?? a.model;
    const target = this.target();
    const mismatch = !this.overridden() && target !== null && !sameModel(models, a.model, target); // §5.6 also tiers 2/3
    const l = this.last;
    const same = l.lastModel === a.model && l.lastEffort === a.effort && l.lastModelName === name && this.mismatch === mismatch;
    this.last = { lastModel: a.model, lastModelName: name, lastEffort: a.effort };
    this.mismatch = mismatch;
    if (same) return;
    this.saveLast();
    this.d.changed();
  }

  private async settings(p: ControlPort, by: number): Promise<{ applied: Applied } & Configured> {
    const s = parseSettings(await this.must(p, { subtype: 'get_settings' }, by));
    this.configured = s.configured;
    return s;
  }

  private async models(p: ControlPort, account: string, by: number): Promise<ModelInfo[]> {
    this.account = account;
    const known = this.d.cache.models(account);
    if (known) return known;
    const list = parseModels(await this.must(p, { subtype: 'list_models' }, by));
    this.d.cache.putModels(account, list);
    return list;
  }

  private async must(p: ControlPort, req: Request, by: number): Promise<Obj> {
    const r = await this.call(p, req, by);
    if (!r.ok) throw new ModelError('failed', `${req.subtype}: ${r.error}`);
    return r.response;
  }

  /** A change request: success → 'ok'; `unsupported_request` → 'unsupported'; `not_found` / other → ModelError. */
  private async ask(p: ControlPort, req: Request, by: number): Promise<'ok' | 'unsupported'> {
    const r = await this.call(p, req, by);
    if (r.ok) return 'ok';
    if (r.errorCode === 'unsupported_request') return 'unsupported';
    throw new ModelError(r.errorCode === 'not_found' ? 'model_not_found' : 'failed', r.error);
  }

  /** One request bounded by the chain's deadline: past it the chain stops, so nothing is sent after the cap. */
  private async call(p: ControlPort, req: Request, by: number): Promise<Reply> {
    const left = by - Date.now();
    if (left <= 0) throw new ModelError('timeout', `${req.subtype}: no reply in time`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ModelError('timeout', `${req.subtype}: no reply in time`)), left); });
    try { return await Promise.race([p.control(req), t]); } finally { clearTimeout(timer); }
  }
}
