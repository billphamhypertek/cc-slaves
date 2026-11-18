// LaneManager claude process: spawn, stream events, results, exit (split from lane/manager.ts).
import { endRun, insertEvent, insertRun, listUndelivered, updateLaneFields, updateSession } from '../../db.ts';
import { nextRunN, writeSessionFiles } from '../../session/files.ts';
import { PREFIX } from '../../outbox.ts';
import { exitReason, SessionProcess, type ExitInfo } from '../../session/process.ts';
import { isAuthError, isLimitError, laneCost, turnCost, type ResultEvent, type StreamEvent } from '../../stream/parser.ts';
import type { LaneEvent } from '../reducer.ts';
import { TurnFive } from '../../orchestrator/resume.ts';
import type { LaneManager } from '../manager.ts';
import { afterResult, handshake } from './model.ts';
import { LANE_RESUME_TEXT, QUIET, type Rt } from './types.ts';
import { spawnPrompt } from '../../workflow/runtime.ts';

export async function spawn(m: LaneManager, rt: Rt, mode: 'resume' | 'fresh', email: string, fallback: boolean): Promise<void> {
  if (!m.registered(rt)) return; // A-I1: dropped by a project close → no claude for it
  const { db, outbox } = m.d;
  const sid = rt.ctx.sessionId;
  const acct = m.account(email);
  if (!acct) {
    // Not usable (no registry `dir`, e.g. a v1 lane at the v2 cutover §7.1-3): switch without an error; with no account
    // at all the pick leaves the lane in waiting_quota (`no_account`).
    await m.apply(rt, { type: 'auth_error' });
    return;
  }
  // v2.9 §6.1 the lane step of the lane's pinned rev; a resumed lane whose text changed gets it once, right after the resume line.
  const prompt = spawnPrompt(db, sid, mode === 'resume');
  // A new conversation: the brief is its first message (re-queued if it was delivered to one that is gone).
  if (mode === 'fresh') outbox.ensureFirst(sid, rt.firstText);
  else if (prompt.update !== null) outbox.ensureFirst(sid, prompt.update);
  const files = writeSessionFiles(sid, { port: m.d.mcpPort, projectId: rt.projectId, ...m.d.sessionSetup?.(rt.projectId), step: prompt.step });
  m.d.onMcpToken?.(sid, { token: files.token, mcpIds: files.mcpIds, graph: files.graph, cwd: rt.cwd });
  const n = rt.runN = nextRunN(rt.projectId, rt.ctx.name, rt.runN);
  const runId = insertRun(db, { sessionId: sid, laneId: rt.laneId, n, account: email });
  const resumeText = rt.resumeNote ?? LANE_RESUME_TEXT;
  if (rt.resumeNote !== undefined && mode === 'fresh') outbox.enqueue(sid, rt.resumeNote, PREFIX.engine); // no resume line to replace
  delete rt.resumeNote; // once: a later restart resumes with the plain note
  const proc = new SessionProcess({
    ...m.d.session,
    sessionId: sid, resume: mode === 'resume', resumeText, projectId: rt.projectId, lane: rt.ctx.name, runN: n, cwd: rt.cwd,
    args: {
      settingsPath: files.settingsPath, mcpConfigPath: files.mcpPath,
      appendSystemPrompt: (m.d.appendSystemPrompt ?? (() => prompt.text))({ projectId: rt.projectId, name: rt.ctx.name }),
      agent: rt.agent, ...rt.mc.argv(), // v2.4 §5.6 tiers 1–3 (resolved now: the snapshot of this process)
    },
    beforeFirstWrite: (p) => handshake(m, rt, p, email), // v2.4 §5.2 / §5.6
    account: { email, configDir: acct.configDir, terminal: acct.terminal },
    outbox, command: m.d.command, env: () => m.d.env(acct),
    ...(m.d.caffeinate ? { caffeinate: m.d.caffeinate } : {}),
    ...(m.d.gate ? { update: { gate: m.d.gate, kind: 'lane' as const } } : {}), // v2.6 §5.4
  });
  let initSeen = false;
  rt.procExit.set(proc, new Promise<ExitInfo>((r) => proc.on('exit', r)));
  proc.on('event', (e) => {
    if (e.kind === 'init') initSeen = true;
    m.onStream(rt, proc, email, e);
  });
  proc.on('exit', (x) => {
    endRun(db, runId, x.requested ?? x.kind);
    m.emit({ type: 'session_exit', projectId: rt.projectId, name: rt.ctx.name, sessionId: sid });
    void m.job(rt, () => m.onExit(rt, proc, x));
  });
  rt.proc = proc;
  rt.lastProc = proc;
  rt.userInterrupt = false;
  rt.shaken = false;
  const r = await proc.start();
  if (r.ok && r.version !== null) m.emit({ type: 'claude_version', version: r.version, ok: true });
  if (!r.ok && r.failure.kind === 'old_version' && r.failure.version !== null) {
    m.emit({ type: 'claude_version', version: r.failure.version, ok: false, message: r.failure.message, reason: r.failure.reason });
  }
  if (rt.proc !== proc) return;
  if (r.ok) {
    updateSession(db, sid, { pid: proc.pid });
    await m.apply(rt, { type: 'init_ok' });
    return;
  }
  // §7.3 self-check failed: process killed, not a lane run error. After init the first message was replayed, so the
  // conversation exists → the next attempt resumes the same id; before init → fresh with the same id (ruling).
  rt.proc = null;
  rt.mc.settle(); // v2.4 §5.6
  endRun(db, runId, `selfcheck:${r.failure.kind}`);
  // IMPORTANT-4 §5.5: the pre-spawn check flagged this account (nothing was spawned) → leave it like a cap, no error
  // counted; the re-pick skips it (flagged = no new lane) or the lane waits (`no_account`).
  if (r.failure.kind === 'shared_cfg') {
    await m.apply(rt, { type: 'limit_or_cap' });
    return;
  }
  // IMPORTANT-1 (cc-lanes.mjs measured both): a fresh start on an id claude already has → "already in use" → resume;
  // a resume with no transcript → "No conversation found" → fresh. One switch per start, never a loop.
  if (!fallback && !m.closed) {
    if (mode === 'fresh' && r.failure.kind === 'in_use') {
      rt.ctx = { ...rt.ctx, sawAssistant: true };
      await m.spawn(rt, 'resume', email, true);
      return;
    }
    if (mode === 'resume' && r.failure.kind === 'exited_before_init' && /No conversation found/i.test(r.failure.stderr)) {
      rt.ctx = { ...rt.ctx, sawAssistant: false };
      await m.spawn(rt, 'fresh', email, true);
      return;
    }
  }
  rt.ctx = { ...rt.ctx, lastError: r.failure.message, lastErrorKeyed: r.failure.reason, sawAssistant: rt.ctx.sawAssistant || initSeen };
  await m.apply(rt, { type: 'stop_now' });
  m.notify(rt, `[cc-slaves] lane ${rt.ctx.name} không khởi động được: ${r.failure.message}`);
}

/** Stream events: cost / quota at once; lane events on the queue, dropped once the process is no longer current. */
export function onStream(m: LaneManager, rt: Rt, proc: SessionProcess, email: string, e: StreamEvent): void {
  if (e.kind === 'stream_event' || e.kind === 'assistant' || e.kind === 'user' || e.kind === 'result') { // result: v2.2 §14.4 turn end
    m.emit({ type: 'stream', projectId: rt.projectId, name: rt.ctx.name, event: e });
  }
  if (e.kind === 'assistant' || e.kind === 'stream_event') m.fiveOf(rt).start(email);
  // §4.14 session.ctx_last of the lane (resume preview of "Chạy tiếp lane")
  if (e.kind === 'assistant' && rt.proc === proc && proc.contextTokens !== null) {
    m.d.db.query('UPDATE session SET ctx_last = ? WHERE id = ? AND (ctx_last IS NULL OR ctx_last <> ?)').run(proc.contextTokens, rt.ctx.sessionId, proc.contextTokens);
  }
  if (e.kind === 'result') m.recordResult(rt, e, email);
  if (e.kind === 'result' || e.kind === 'task_started' || e.kind === 'task_progress' || e.kind === 'task_updated' || e.kind === 'task_notification') {
    m.emit({ type: 'task', projectId: rt.projectId, name: rt.ctx.name, event: e });
  }
  // §5.3 W10 tokens move within the turn (the result then replaces the provisional sum, recordResult)
  if (e.kind === 'assistant' && rt.tokens.assistant(e)) m.emit({ type: 'lane', lane: m.view(rt) });
  if ((e.kind === 'can_use_tool' || e.kind === 'control_cancel_request') && rt.proc === proc) {
    m.emit({ type: 'control', projectId: rt.projectId, name: rt.ctx.name, sessionId: rt.ctx.sessionId, event: e });
    return;
  }
  if (e.kind === 'rate_limit_event') {
    m.d.quota.applyRateLimitEvent(email, e);
    m.accountChanged(email);
    return;
  }
  // IMPORTANT-1: a replayed message of ours means claude persisted the conversation → the next start must resume
  // (the same rule as restore(): delivered > 0), even if no assistant message came before the process died.
  if (e.kind === 'user' && e.isReplay) {
    if (!rt.ctx.sawAssistant) void m.job(rt, () => m.apply(rt, { type: 'assistant_seen' }));
    return;
  }
  if (e.kind !== 'assistant' && e.kind !== 'stream_event' && e.kind !== 'result') return;
  void m.job(rt, async () => {
    if (rt.proc !== proc) return;
    if (e.kind === 'result') {
      const ev = m.classify(rt, e);
      await m.apply(rt, ev);
      // v2.4 §5.6 a change waits for `result_ok` only; cap / auth / error replace the process (`settle()` in detach)
      if (ev.type === 'result_ok' && rt.proc === proc) await afterResult(m, rt, proc, email);
      return;
    }
    // §3.3-20 self-started turn: activity while quiet with no message of ours awaiting replay.
    if (QUIET.includes(rt.ctx.state) && listUndelivered(m.d.db, rt.ctx.sessionId).length === 0) {
      await m.apply(rt, { type: 'self_started_turn' });
    }
    if (e.kind === 'assistant') await m.apply(rt, { type: 'assistant_seen' });
  });
}

export function fiveOf(m: LaneManager, rt: Rt): TurnFive {
  return rt.five ??= new TurnFive((a) => m.d.quota.get(a));
}

export function recordResult(m: LaneManager, rt: Rt, r: ResultEvent, email: string): void {
  rt.lastResult = r.result;
  const cost = laneCost(rt.cost, r);
  rt.cost = cost;
  if (cost !== null) updateLaneFields(m.d.db, rt.laneId, { costUsd: cost });
  const usage = rt.tokens.result(r);
  insertEvent(m.d.db, {
    sessionId: rt.ctx.sessionId, type: 'result',
    json: { run: rt.runN, turnCost: turnCost(r), totalCostUsd: r.totalCostUsd, isError: r.isError, subtype: r.subtype, usage, ...m.fiveOf(rt).end(email) },
  });
}

/** §5.3 a turn cut short: its provisional tokens are committed and stored (`usage` event), so restart / stats keep them. */
export function keepCutTokens(m: LaneManager, rt: Rt): void {
  const usage = rt.tokens.abandon();
  if (usage) insertEvent(m.d.db, { sessionId: rt.ctx.sessionId, type: 'usage', json: { run: rt.runN, usage } });
}

export function classify(m: LaneManager, rt: Rt, r: ResultEvent): LaneEvent {
  const interrupted = rt.userInterrupt;
  rt.userInterrupt = false;
  if (isAuthError(r)) return { type: 'auth_error' };
  if (isLimitError(r)) {
    if (rt.ctx.account !== null) m.d.quota.markLimited?.(rt.ctx.account);
    return { type: 'limit_or_cap' };
  }
  if (r.isError && !interrupted) return { type: 'abnormal_error', text: `${r.subtype ?? 'error'}: ${r.result.slice(0, 300)}` };
  return { type: 'result_ok', summary: r.result };
}

export async function onExit(m: LaneManager, rt: Rt, proc: SessionProcess, x: ExitInfo): Promise<void> {
  if (rt.proc !== proc) return;
  rt.proc = null;
  rt.mc.settle(); // v2.4 §5.6 died while a change waited: it is the pick of the next process
  m.keepCutTokens(rt); // §5.3 a turn cut short keeps the tokens it reported (no result will replace them)
  if (x.kind === 'requested') return;
  // Ruling: a quiet session that quits by itself is not an error; the next message respawns it with --resume.
  if (x.kind === 'exited_idle' && QUIET.includes(rt.ctx.state)) return;
  const { text, ...r } = exitReason(x);
  await m.apply(rt, { type: 'abnormal_error', text, reason: r });
}
