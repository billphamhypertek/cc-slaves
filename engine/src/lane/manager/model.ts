// v2.4 §5.6 D55 a lane's model / effort: the same ModelControl as the orchestrator (picks on the `lane` row, `last*` on
// its session row), tiers agent › Settings › Claude Code resolved at each spawn, the §5.2 handshake + re-read, and the
// §5.3 change: now when the lane is idle, else `pending` with every stdin line held until the turn's `result_ok`.
import { join } from 'node:path';
import { modelOverride } from '../../session/args.ts';
import { tiered, type Defaults } from '../../models.ts';
import { ModelControl, ModelError, type ModelChange, type ModelNow, type PickStore } from '../../session/model-control.ts';
import type { SessionProcess } from '../../session/process.ts';
import type { SetModelResult } from '../../../../shared/protocol.ts';
import { readAgent } from '../agent-def.ts';
import type { LaneManager } from '../manager.ts';
import { QUIET, type Rt } from './types.ts';

/** §5.3 after a `result` that left a written row unreplayed: no new turn within this → apply the waiting change anyway. */
const PENDING_GRACE_MS = 2_000;

/** §5.6 tier 1 lives on the `lane` row (`lane_start` writes it, the chip overrides it). */
function lanePicks(m: LaneManager, rt: Rt): PickStore {
  return {
    loadPick: () => ({ modelPick: rt.model ?? null, effortPick: rt.effort ?? null }),
    savePick: (p) => {
      rt.model = p.modelPick ?? undefined;
      rt.effort = p.effortPick ?? undefined;
      m.d.db.query('UPDATE lane SET model = ?, effort = ? WHERE id = ?').run(p.modelPick, p.effortPick, rt.laneId);
    },
  };
}

/** §5.6 tiers 2–4 now: the agent (project dir, then the account's mirror of ~/.claude), then Cài đặt › Lane. */
function laneDefaults(m: LaneManager, rt: Rt): Defaults {
  const set = m.d.modelDefaults?.().lane ?? { model: null, effort: null };
  if (!rt.agent) return tiered(set);
  const dir = rt.ctx.account !== null ? m.account(rt.ctx.account)?.configDir : undefined;
  const dirs = [join(rt.cwd, '.claude', 'agents'), ...(dir ? [join(dir, 'agents')] : [])];
  return tiered(set, readAgent(rt.agent, dirs, m.d.log));
}

export function modelControl(m: LaneManager, rt: Rt): ModelControl {
  return new ModelControl({
    db: m.d.db, cache: m.modelCache, sessionId: () => rt.ctx.sessionId, store: lanePicks(m, rt), defaults: () => laneDefaults(m, rt),
    override: () => modelOverride() !== null, changed: () => m.emit({ type: 'lane', lane: m.view(rt) }),
  });
}

/** §5.4 / §5.6 `session_models {lane}`: the lane's account and cwd, its process when alive, its tiers 2–4 now. */
export function modelScope(m: LaneManager, rt: Rt): { account: string | null; dir: string; tier: Defaults; own?: () => ReturnType<ModelControl['read']> } {
  const p = rt.proc, email = rt.ctx.account;
  return { account: email, dir: rt.cwd, tier: laneDefaults(m, rt), ...(p?.alive && email !== null ? { own: () => rt.mc.read(p, email) } : {}) };
}

/**
 * §5.2 `beforeFirstWrite` of a lane: the handshake; a change made before it ended is applied here, before the first batch,
 * inside the same ≤ 5 s chain. Past the cap the first turn already runs: the change waits for that turn's `result_ok`.
 */
export async function handshake(m: LaneManager, rt: Rt, p: SessionProcess, email: string): Promise<void> {
  const by = rt.mc.deadline();
  try {
    await rt.mc.handshake(p, email, by);
    if (rt.mc.pending && p.turnStartedAt === null) await applyPending(m, rt, p, email, by);
  } finally {
    rt.shaken = true;
    if (rt.mc.pending && rt.proc === p) p.hold(); // failed or the turn started: the change waits for this turn's result
  }
}

/** §5.3 idle = a process past its handshake, between turns, nothing written and not replayed yet. */
function idle(m: LaneManager, rt: Rt, p: SessionProcess): boolean {
  return QUIET.includes(rt.ctx.state) && p.turnStartedAt === null && !m.d.outbox.hasUnreplayed(rt.ctx.sessionId);
}

/** §5.6 `lane_set_model` (on the lane's queue; a starting lane is handled by the caller): no process → saved; idle → now;
 *  busy → pending + hold. */
export async function setModel(m: LaneManager, rt: Rt, c: ModelChange): Promise<SetModelResult['applied']> {
  const p = rt.proc, email = rt.ctx.account;
  if (!p?.alive || email === null) { rt.mc.save(c); return 'saved'; }
  if (!idle(m, rt, p) || rt.mc.pending) {
    rt.mc.wait(c);
    p.hold();
    if (QUIET.includes(rt.ctx.state) && p.turnStartedAt === null) grace(m, rt, p, email); // a written row may open no turn
    return 'pending';
  }
  const from = rt.mc.now;
  p.hold();
  try {
    const r = await rt.mc.apply(p, email, c);
    if (r === 'now') changed(m, rt, from);
    return r;
  } finally { await release(m, rt, p); }
}

/** §5.3 "Bỏ thay đổi đang chờ": the change is dropped, what waited goes out now. */
export async function cancelModel(m: LaneManager, rt: Rt): Promise<void> {
  if (!rt.mc.pending) return;
  rt.mc.cancel();
  if (rt.proc) await release(m, rt, rt.proc);
}

/**
 * §5.6 a `result_ok` (the lane is idle again): a change waiting → applied (or, a written row unreplayed, at the next result
 * / PENDING_GRACE_MS); none → the §5.2 re-read. Other results (cap, auth, error) replace the process: `settle()` there.
 */
export async function afterResult(m: LaneManager, rt: Rt, p: SessionProcess, email: string): Promise<void> {
  if (!rt.mc.pending) { reread(m, rt, p, email); return; }
  if (m.d.outbox.hasUnreplayed(rt.ctx.sessionId)) { grace(m, rt, p, email); return; }
  await applyPending(m, rt, p, email);
  await release(m, rt, p);
}

function grace(m: LaneManager, rt: Rt, p: SessionProcess, email: string): void {
  m.timers.set(() => void m.job(rt, async () => {
    if (rt.proc !== p || p.turnStartedAt !== null || !rt.mc.pending) return;
    await applyPending(m, rt, p, email);
    await release(m, rt, p);
  }), PENDING_GRACE_MS);
}

async function applyPending(m: LaneManager, rt: Rt, p: SessionProcess, email: string, by?: number): Promise<void> {
  const from = rt.mc.now;
  try {
    if ((await rt.mc.apply(p, email, rt.mc.pending!, by)) === 'now') changed(m, rt, from);
  } catch (e) { // §5.3 failed: pending dropped, the held rows go out on the old model
    const code = e instanceof ModelError ? e.code : 'failed';
    m.emit({ type: 'model_change', projectId: rt.projectId, name: rt.ctx.name, sessionId: rt.ctx.sessionId, from, to: from, error: { code, message: (e as Error).message } });
  }
  rt.mc.cancel();
}

/** §5.2 read back after a turn; a tier-4 lane off Claude Code's default → `set_model {default}` once, when still idle. */
function reread(m: LaneManager, rt: Rt, p: SessionProcess, email: string): void {
  void rt.mc.reread(p, email).then((reset) => {
    if (!reset) return;
    void m.job(rt, async () => {
      if (rt.proc !== p || !idle(m, rt, p) || rt.mc.pending) return;
      p.hold();
      try { await rt.mc.resetDefault(p, email); } catch { /* once: nothing more */ } finally { await release(m, rt, p); }
    });
  }, () => { /* no reply: the view keeps the last values */ });
}

/** End a hold; rows written → a turn runs (the lane shows it at once). */
async function release(m: LaneManager, rt: Rt, p: SessionProcess): Promise<void> {
  if (rt.proc !== p) return;
  if (p.release() > 0) await m.apply(rt, { type: 'self_started_turn' });
}

function changed(m: LaneManager, rt: Rt, from: ModelNow): void {
  m.emit({ type: 'model_change', projectId: rt.projectId, name: rt.ctx.name, sessionId: rt.ctx.sessionId, from, to: rt.mc.now });
}
