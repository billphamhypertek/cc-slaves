// Command handlers (spec §7.9, §6.1 F1, §6.2 F2, §7.1 NC4, §8.2): one per protocol command, behind the router's
// channel gate. Errors are CommandError / LaneError / CardError with a §6A catalog key (+ Vietnamese message fallback).
import { t, type Key } from '../../../shared/i18n/index.ts';
import { randomUUID } from 'node:crypto';
import { CARD_ACTION_CMD, REMOTE_ALLOWED, type Command, type DoneLanesPage, type SessionModels, type SetModelResult, type Target } from '../../../shared/protocol.ts';
import { CardError, type SystemPayload } from '../cards/store.ts';
import { ISSUE_CARD_ACTIONS, UI_ONLY_ACTIONS } from '../issues/cards.ts';
import { MAC_ACTION_CARDS } from '../../../shared/issues.ts';
import { activeLogin } from '../accounts/login.ts';
import { writeCaps, writeLaneConfig } from '../accounts/registry.ts';
import { fillModelDefaults, saveConfig, validateCaps, validateConfig, type Caps, type Config } from '../config.ts';
import { listDoneLanes, setMeta } from '../db.ts';
import type { Engine } from '../engine.ts';
import { stopAll } from '../lane/stop-all.ts';
import { echoLine, PREFIX, type SendExtra } from '../outbox.ts';
import { matchSlash } from '../../../shared/slash.ts';
import { writePoLine } from './lines.ts';
import { LaneError } from '../lane/manager.ts';
import { findOnPath } from '../session/env.ts';
import { installClaude } from '../setup/setup.ts';
import { CommandError, type CommandCtx, type Handlers } from './router.ts';
import { skillsMcpHandlers } from './commands-skills-mcp.ts';
import { codeHandlers } from './code-commands.ts';
import { gitSetupHandlers } from './git-setup-commands.ts';
import { issueHandlers } from './issue-commands.ts';
import { checkAccount, isPick, picks } from './start-picks.ts';
import { projectHandlers } from './project-commands.ts';
import { ownerOf, SessionError, TAIL_LINES, tailFirstText } from '../orchestrator/owners.ts';
import { newSessionText } from '../orchestrator/session.ts';
import { continuePreview } from '../lane/continue.ts';
import { tiered, UNAVAILABLE, type OwnProcess } from '../models.ts';
import { ModelError } from '../session/model-control.ts';
import type { Conn } from './ws.ts';
import { workflowHandlers } from './workflow-commands.ts';
import { graphHandlers } from './graph-commands.ts';
import { toolkitHandlers } from './toolkit-commands.ts';

/** §4.14 "Phiên mới từ handoff #n" / "từ 50 dòng cuối": the new session's first message, from an ended session. */
export function fromFirst(e: Pick<Engine, 'db' | 'lines'>, projectId: string, from: { sessionId?: unknown; kind?: unknown }): string {
  const sid = typeof from?.sessionId === 'string' ? from.sessionId : '';
  const r = e.db.query<{ seq: number | null; handoff_path: string | null }, [string, string]>(
    "SELECT seq, handoff_path FROM session WHERE id = ? AND project_id = ? AND kind = 'orchestrator'").get(sid, projectId);
  if (!r) throw new SessionError('no_session', { key: 'errors.noSession', params: { id: sid } });
  if (from.kind === 'handoff') {
    if (!r.handoff_path) throw new SessionError('no_handoff', { key: 'errors.noHandoff', params: { n: r.seq ?? '?' } });
    return newSessionText(r.handoff_path);
  }
  if (from.kind !== 'tail') throw new CommandError('bad_input', { key: 'errors.badTarget' });
  return tailFirstText(r.seq, e.lines.page([sid], undefined, TAIL_LINES));
}

const notYet = (key: Key) => () => { throw new CommandError('not_supported', { key }); };
/** hotfix 2026-11-16 card actions that run a session or a lane: a held project resumes first. */
const WAKES: ReadonlySet<string> = new Set(['lane_resume', 'restart_orchestrator', 'new_orchestrator', 'new_orchestrator_session', 'hand_to_orchestrator']);

/**
 * The orchestrator session a command names (v2.1 §4.14 `sessionId`), else the project's first running one. `send`:
 * a message to a session that is ending goes to the session taking its lanes (§4.14).
 */
function orchestrator(e: Engine, projectId: string, sessionId?: string, send = false) {
  if (sessionId !== undefined) {
    const o = send ? e.orchestrators.route(sessionId) : e.orchestrators.bySession(sessionId);
    if (!o || o.projectId !== projectId) throw new CommandError('no_session', { key: 'errors.noSession', params: { id: sessionId } });
    return o;
  }
  const o = e.orchestrators.get(projectId);
  if (!o) throw new CommandError('no_orchestrator', { key: 'errors.noOrchestrator' });
  return o;
}
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** v2.2 K13 the server id a `mcp_login` / `mcp_snooze` card action is for (its args, else the card key). */
const mcpCardId = (args: Record<string, unknown> | undefined, key: string | null): string => optStr(args?.id) ?? key ?? '';


function validTarget(t: unknown): t is Target {
  if (typeof t !== 'object' || t === null) return false;
  const x = t as Record<string, unknown>;
  return typeof x.projectId === 'string' && ((x.kind === 'orchestrator' && (x.sessionId === undefined || typeof x.sessionId === 'string'))
    || (x.kind === 'lane' && typeof x.name === 'string'));
}

const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A system card's orchestrator: `args.sessionId` (v2.1 card), else the card's session, else the project's first. */
function cardOrchestrator(e: Engine, projectId: string, args: Record<string, unknown> | undefined, cardSession: string | null) {
  const sid = optStr(args?.sessionId);
  if (sid !== undefined) return orchestrator(e, projectId, sid);
  const o = cardSession ? e.orchestrators.bySession(cardSession) : null;
  return o ?? orchestrator(e, projectId);
}

/** v2.4 §10.2 where a PO message goes: its session, whether a turn runs / a model change holds it, how it is queued. */
interface Dest { sessionId: string | null; running: boolean; held: boolean; put(text: string, raw: boolean, extra: SendExtra): Promise<unknown> }

function destOf(e: Engine, t: Target, waited = false): Dest {
  if (t.kind === 'orchestrator') {
    // §4.14 a session that ended during the R4 wait left its messages to the project's live session: this one goes there too
    const gone = waited && t.sessionId !== undefined && e.orchestrators.route(t.sessionId) === null;
    const o = orchestrator(e, t.projectId, gone ? undefined : t.sessionId, true);
    const v = o.view();
    return { sessionId: o.currentSessionId, running: v.state === 'running', held: v.pending !== undefined,
      put: (text, raw, extra) => o.send(text, raw ? PREFIX.raw : PREFIX.po, extra) };
  }
  const v = e.lanes.get(t.projectId, t.name);
  if (!v) throw new LaneError('no_lane', { key: 'errors.noLane', params: { name: t.name } });
  return { sessionId: v.sessionId, running: v.state === 'running', held: false,
    put: (text, raw, extra) => e.lanes.message(t.projectId, t.name, text, 'po', { ...extra, raw }) };
}

/**
 * v2.4 §10.2 `send`: §8 attachments are Mac only; `raw` only for a `/` command Claude Code runs itself (§6.6); every `up`
 * / `path` through `take` (limits, one use, A9 blocked roots, R4 async). A row with attachments, held (§5.3) or raw gets
 * its `po` line now (`echoed`, its replay is dropped; v2.6 §4.8 so does one sent during the update hold); a plain one is shown at replay (§6.3 F3 inTurn via markInTurn).
 */
async function sendCmd(e: Engine, c: Extract<Command, { cmd: 'send' }>, ctx: CommandCtx): Promise<void> {
  const items = c.attachments;
  if (items !== undefined && ctx.channel !== 'mac') throw new CommandError('forbidden_remote', { key: 'errors.forbiddenRemote' });
  const has = Array.isArray(items) && items.length > 0;
  if (!validTarget(c.target) || typeof c.text !== 'string' || (items !== undefined && !Array.isArray(items))
    || (c.text.trim() === '' && !has)) throw new CommandError('bad_input', { key: 'errors.badTargetOrEmpty' });
  if (c.raw !== undefined && (c.raw !== true || has || matchSlash(c.text)?.kind !== 'pass')) throw new CommandError('bad_input', { key: 'errors.rawRefused' });
  const raw = c.raw === true;
  destOf(e, c.target); // no_lane / no_session before anything is taken
  await e.held.wake(c.target.projectId); // hotfix 2026-11-16 a PO message resumes a held project first
  const taken = has ? await e.attach.take(items) : null;
  const d = destOf(e, c.target, has); // after the R4 wait: session, turn and hold as they are now
  if (taken && !taken.ok) throw new CommandError('bad_input', { key: 'errors.attachBad', params: { index: taken.index, n: taken.index + 1 } });
  const attachments = taken?.ok ? taken.list : undefined;
  const kept = !e.update.gate.writes; // v2.6 §4.8 the update hold keeps it back: shown now with "giữ lại"
  const echoed = raw || d.held || kept || attachments !== undefined;
  const uuid = randomUUID();
  if (echoed && d.sessionId) {
    const line = echoLine({ text: c.text, prefix: raw ? PREFIX.raw : PREFIX.po, attachments: attachments ?? null });
    const label = kept ? { held: true as const } : d.held ? { afterModelChange: true as const } : d.running && !raw ? { inTurn: true } : {};
    const shown = writePoLine(e, c.target, d.sessionId, { ...line, ...label });
    if (kept) e.outbox.heldLine(uuid, c.target, shown.seq);
  } else if (d.running && d.sessionId) e.markInTurn(d.sessionId, c.text); // R3: the line text has no "[PO] "
  await d.put(c.text, raw, { uuid, ...(attachments ? { attachments } : {}), echoed: echoed && d.sessionId !== null });
}

export function buildHandlers(e: Engine, conn: Conn): Handlers {
  const vscode = (path: string) => {
    const code = findOnPath('code', e.login.env.PATH);
    return spawnOpen(e, code ? [code, path] : ['open', '-b', 'com.microsoft.VSCode', path]);
  };
  return {
    ...steerHandlers(e, conn), ...sessionHandlers(e), ...modelHandlers(e), ...macHandlers(e), ...projectHandlers(e), ...accountHandlers(e), ...skillsMcpHandlers(e),
    ...codeHandlers(e, conn, vscode), ...gitSetupHandlers(e), ...issueHandlers(e), ...workflowHandlers(e), ...toolkitHandlers(e), ...graphHandlers(e),
  };
}

/** Contextual types for one slice of the handler table; `buildHandlers` checks the assembled table is complete. */
const handlers = <T extends Partial<Handlers>>(h: T): T => h;

function steerHandlers(e: Engine, conn: Conn) {
  return handlers({
    send: (c, ctx) => sendCmd(e, c, ctx),
    interrupt: async (c) => {
      if (!validTarget(c.target)) throw new CommandError('bad_input', { key: 'errors.badTarget' });
      if (c.target.kind === 'orchestrator') await orchestrator(e, c.target.projectId, c.target.sessionId).interrupt();
      else await e.lanes.interrupt(c.target.projectId, c.target.name);
    },
    lane_stop: (c) => e.lanes.stop(c.projectId, c.name, c.mode === 'now' ? 'now' : 'drain'),
    lane_resume: async (c) => { // a held lane runs again with its project (it is not stopped: nothing else to resume)
      const paused = e.lanes.get(c.projectId, c.name)?.state === 'paused';
      await e.held.wake(c.projectId);
      if (!paused) await e.lanes.resume(c.projectId, c.name);
    },
    lane_finish: (c) => e.lanes.finish(c.projectId, c.name, c.force === true),
    lane_switch_account: notYet('errors.notYetLaneSwitch'),
    card_answer: async (c) => {
      const pid = e.cards.get(c.id)?.projectId;
      if (pid) await e.held.wake(pid); // the answer goes to a session of it: the project runs again first
      return e.cardViewOf(await e.cards.answer(c.id, c.answer));
    },
    card_action: async (c, ctx) => {
      const card = e.cards.get(c.id);
      if (!card) throw new CardError('no_card', { key: 'errors.noCard', params: { id: c.id } });
      if (card.kind === 'ask' || card.kind === 'permission') throw new CardError('bad_input', { key: 'errors.cardNoActions', params: { id: c.id } });
      const p = card.payload as SystemPayload;
      const a = p.actions.find((x) => x.action === c.action);
      if (!a || card.status !== 'open') throw new CardError('bad_input', { key: 'errors.cardNoAction', params: { id: c.id, action: c.action } });
      const runs = CARD_ACTION_CMD[a.action]; // I4: the router's channel gate, applied to what the action runs
      if (ctx.channel !== 'mac' && runs && !REMOTE_ALLOWED.has(runs)) throw new CommandError('forbidden_remote', { key: 'errors.forbiddenRemote' });
      if (ctx.channel !== 'mac' && MAC_ACTION_CARDS.has(card.kind)) throw new CommandError('forbidden_remote', { key: 'errors.forbiddenRemote' }); // v2.7 §8
      if (a.action === 'view_log' || UI_ONLY_ACTIONS.has(a.action)) return e.cardViewOf(card); // UI-only action: never resolves the card
      if (WAKES.has(a.action) && card.projectId) await e.held.wake(card.projectId); // runs a session of a held project
      switch (a.action) {
        case 'lane_resume': {
          const args = (a.args ?? {}) as { projectId?: string; name?: string };
          await e.lanes.resume(args.projectId ?? card.projectId ?? '', args.name ?? '');
          break;
        }
        case 'account_relogin': { // v2 §6 F16: A6 for the card's account; the card resolves when that login is done
          const args = (a.args ?? {}) as { email?: string };
          e.startAccountLogin({ accountEmail: args.email ?? p.key ?? '' });
          return e.cardViewOf(card);
        }
        // §4.14 the card's buttons act on its own session (`args.sessionId`; old cards: the card's session, then the project)
        case 'restart_orchestrator': await cardOrchestrator(e, card.projectId ?? '', a.args, card.sessionId).restart(); break;
        case 'new_orchestrator':
        case 'new_orchestrator_session': await cardOrchestrator(e, card.projectId ?? '', a.args, card.sessionId).newSession(); break;
        case 'hand_to_orchestrator': { // §6.7 F7: the orchestrator gets the event and decides
          const args = (a.args ?? {}) as { projectId?: string; name?: string };
          const pid = args.projectId ?? card.projectId ?? '';
          orchestrator(e, pid);
          e.orchestrators.notify(pid, `${PREFIX.engine} PO giao điều phối xử lý lane ${args.name ?? '?'} hỏng: ${p.body ?? 'không rõ lỗi'}. Xem lanes_tail, sửa nguyên nhân rồi lanes_resume hoặc báo PO.`);
          break;
        }
        case 'setup_check': await e.runSetupCheck(); return e.cardViewOf(card); // resolves when the version passes
        case 'mcp_login': { // v2.2 K13 → K3 (Mac only, C24); the card stays open until the login lands
          const id = mcpCardId(a.args, p.key);
          if (e.skillsMcp.oauth.view(id)) void e.skillsMcp.oauth.login(id);
          return e.cardViewOf(card);
        }
        case ISSUE_CARD_ACTIONS.keep: { // v2.7 §5.7-5 "Giữ T-46": the original stays done
          const args = (a.args ?? {}) as { key?: string };
          e.issues.keep(card.projectId ?? '', args.key ?? '');
          break;
        }
        case 'mcp_snooze': e.skillsMcp.loginCards.snooze(mcpCardId(a.args, p.key)); break; // v2.2 C26 "Để sau"
        case 'account_add': return e.cardViewOf(card); // §7.1-3 cutover: the web opens A3; resolves when an account is usable
        case 'shared_cfg_merge': { // v2 A9 "Gộp": refused on a clash (card stays open); done → the re-check resolves it
          const args = (a.args ?? {}) as { email?: string; name?: string };
          e.mergeSharedCfg(args.email ?? '', args.name ?? '', false);
          break;
        }
        case 'account_orphan_adopt': // v2 §6 "Account mồ côi": the card's dir only (re-checked by the engine)
          e.adoptOrphan(p.key ?? '');
          break;
        case 'account_orphan_delete':
          await e.deleteOrphan(p.key ?? '');
          break;
        case 'shared_cfg_toggle': { // §5.2 new unknown entry → "Dùng chung"
          const args = (a.args ?? {}) as { name?: string; shared?: boolean };
          e.toggleShared(args.name ?? '', args.shared !== false);
          break;
        }
        default: // dismiss; A9 "Để sau" keeps that card closed until the issue clears
          if (card.kind === 'shared_cfg' && p.key) e.sharedDismissed.add(p.key);
          break;
      }
      return e.cardViewOf(e.cards.resolveSystem(card.id, a.action));
    },
    watch: (c) => {
      if (c.target !== null && !validTarget(c.target)) throw new CommandError('bad_input', { key: 'errors.badTarget' });
      const t = c.target;
      // §4.14 MINOR-3: no sessionId (v2-shaped client) → the session its history shows, so live lines match it
      const live = t?.kind === 'orchestrator' && t.sessionId === undefined ? e.orchestrators.get(t.projectId) : null;
      conn.watch = live && t?.kind === 'orchestrator' ? { ...t, sessionId: live.currentSessionId } : t;
      e.sendHeld(conn); // v2.2 §14.4 a mid-stream watch gets the text so far first
      e.pushSubagents(conn); // v2.1 W9: the lists that changed before this watch
      if (c.target?.kind === 'lane') e.branchOnWatch(c.target.projectId, c.target.name); // §4.15 done-lane view, > 60 s
    },
    presence: (c) => { e.hub.setPresent(conn, c.visible === true); },
    update_hold: (c) => { // v2.6 §5.4 Mac only (router): the hold belongs to this connection (§5.4-6)
      if (typeof c.on !== 'boolean') throw new CommandError('bad_input', { key: 'errors.badMessage' });
      if (c.on) e.update.on(conn); else e.update.off(conn);
    },
    update_commit: () => { // v2.6 §5.4-9 the gate before the engine stops (E1b closes writes / spawns on `ok`)
      const r = e.update.commit(conn);
      if (r === null) throw new CommandError('not_holding', { key: 'errors.badMessage' });
      return r;
    },
    done_lanes_list: (c): DoneLanesPage => { // §4.15 N6-e, read-only (REMOTE_ALLOWED)
      if (typeof c.projectId !== 'string' || !e.projectRow(c.projectId)) throw new CommandError('no_project', { key: 'errors.noProject' });
      const r = listDoneLanes(e.db, {
        projectId: c.projectId, ...(typeof c.query === 'string' ? { query: c.query } : {}), unmerged: c.unmerged === true,
        ...(typeof c.session === 'string' ? { session: c.session } : {}),
        ...(typeof c.before === 'string' ? { before: c.before } : {}), ...(typeof c.limit === 'number' ? { limit: c.limit } : {}),
      });
      return { lanes: r.rows.map((l) => e.laneView(l.projectId, l.name)).filter((v) => v !== null), total: r.total, unmerged: r.unmerged, unknown: r.unknown, next: r.next };
    },
    history: (c) => {
      if (!validTarget(c.target)) throw new CommandError('bad_input', { key: 'errors.badTarget' });
      return e.lines.page(e.sessionsOf(c.target), c.beforeSeq, c.limit ?? 200);
    },
    // F25: ack = StreamLine[] (same as history) — the lines whose parent_tool_use_id is the subagent's Task tool use.
    subagent_history: (c) => {
      if (!validTarget(c.target) || typeof c.taskId !== 'string' || !c.taskId) throw new CommandError('bad_input', { key: 'errors.badTarget' });
      return e.lines.pageByParent(e.sessionsOf(c.target), c.taskId, c.beforeSeq);
    },
    stop_all: (c) => stopAll(e.lanes, { // §4.14 `sessionId` = "Dừng an toàn lane của #n"
      ...(c.projectId !== undefined ? { projectId: c.projectId } : {}),
      ...(typeof c.sessionId === 'string' ? { sessionId: c.sessionId, ownerOf: (p: string, n: string) => ownerOf(e.db, p, n)?.sessionId ?? null } : {}),
    }),
    orchestrator_restart: async (c) => { await e.held.wake(c.projectId); await orchestrator(e, c.projectId, optStr(c.sessionId)).restart(); },
    orchestrator_new: async (c) => { await e.held.wake(c.projectId); return orchestrator(e, c.projectId, optStr(c.sessionId)).newSession(); },
  });
}

const MODEL_ERR = { model_not_found: 'errors.modelNotFound', timeout: 'errors.modelTimeout', failed: 'errors.modelFailed' } as const;

/** v2.4 §5.5 / §5.6 a chip change (`model: null` = "Theo mặc định"; effort never null; at least one field). */
function modelChange(c: { model?: unknown; effort?: unknown }): { model?: string | null; effort?: string } {
  if (!isPick(c.model) || (c.effort !== undefined && (typeof c.effort !== 'string' || c.effort.trim() === '')) || (c.model === undefined && c.effort === undefined)) {
    throw new CommandError('bad_input', { key: 'errors.badModel' });
  }
  return { ...(c.model !== undefined ? { model: c.model } : {}), ...(c.effort !== undefined ? { effort: c.effort } : {}) };
}

/** ModelError → the keyed CommandError the web shows. */
async function applied(f: () => Promise<SetModelResult['applied']>): Promise<SetModelResult> {
  try {
    return { applied: await f() };
  } catch (err) {
    if (err instanceof ModelError) throw new CommandError(err.code, { key: MODEL_ERR[err.code], params: { detail: err.message } });
    throw err;
  }
}

/** The running orchestrator session a model command names (an ended one has no picks to change: `no_session`). */
function liveSession(e: Engine, sessionId: unknown) {
  const o = typeof sessionId === 'string' ? e.orchestrators.bySession(sessionId) : null;
  if (!o) throw new CommandError('no_session', { key: 'errors.noSession', params: { id: String(sessionId) } });
  return o;
}

/** v2.4 §5.4 / §5.5 model / effort (Mac only: none is in REMOTE_ALLOWED, §8). */
function modelHandlers(e: Engine) {
  return handlers({
    session_models: (c): Promise<SessionModels> | SessionModels => {
      const p = typeof c.projectId === 'string' ? e.projectRow(c.projectId) : null;
      if (!p) throw new CommandError('no_project', { key: 'errors.noProject' });
      if (c.lane !== undefined) { // v2.4 §5.6 a lane's chip: its account, cwd, process and tiers (agent › Cài đặt › Lane)
        const l = e.lanes.modelScope(p.id, String(c.lane));
        return l.account === null ? UNAVAILABLE : e.models.list(l.account, l.dir, l.own, l.tier);
      }
      let account = optStr(c.accountId) ?? null;
      let own: OwnProcess | undefined;
      if (c.sessionId !== undefined) {
        const sid = optStr(c.sessionId) ?? '';
        const o = e.orchestrators.bySession(sid);
        if (o && o.projectId === p.id) { account = o.modelScope.account; own = () => o.readModels(); }
        else { // §5.4 a stopped / ended session: its last account, through the probe
          const r = e.db.query<{ account: string | null }, [string, string]>("SELECT account FROM session WHERE id = ? AND project_id = ? AND kind = 'orchestrator'").get(sid, p.id);
          if (!r) throw new CommandError('no_session', { key: 'errors.noSession', params: { id: sid } });
          account = r.account;
        }
      }
      account ??= p.orchestrator_account;
      // §5.6 the orchestrator's "Theo mặc định" = Cài đặt › Điều phối, else Claude Code's
      return account === null ? UNAVAILABLE : e.models.list(account, p.path, own, tiered(e.config.modelDefaults.orchestrator));
    },
    session_set_model: (c): Promise<SetModelResult> => {
      const o = liveSession(e, c.sessionId);
      const change = modelChange(c);
      return applied(() => o.setModel(change));
    },
    session_model_cancel: (c) => liveSession(e, c.sessionId).cancelModel(),
    // v2.4 §5.6 a lane's chip: same rules; a done lane → bad_state (LaneError)
    lane_set_model: (c): Promise<SetModelResult> => {
      const change = modelChange(c);
      return applied(() => e.lanes.setModel(c.projectId, c.name, change));
    },
    lane_model_cancel: (c) => e.lanes.cancelModel(c.projectId, c.name),
  });
}

function sessionHandlers(e: Engine) {
  return handlers({
    // ---------- v2.1 §4.14 sessions (only sessions_list is remote-allowed) ----------
    sessions_list: (c) => {
      if (typeof c.projectId !== 'string' || !e.projectRow(c.projectId)) throw new CommandError('no_project', { key: 'errors.noProject' });
      return e.sessionsList(c.projectId);
    },
    session_open: async (c) => {
      if (typeof c.projectId !== 'string' || !e.projectRow(c.projectId)) throw new CommandError('no_project', { key: 'errors.noProject' });
      if (optStr(c.account)) checkAccount(e.accountViews(), c.account!); // §7.4 a hand pick that filled up meanwhile → account_unusable (UX MINOR-6)
      const first = c.from !== undefined ? fromFirst(e, c.projectId, c.from) : optStr(c.first);
      await e.held.wake(c.projectId); // a new session runs: so does the rest of a held project
      const o = await e.orchestrators.open(c.projectId, {
        ...(optStr(c.title) !== undefined ? { title: c.title! } : {}), ...(first !== undefined ? { first } : {}),
        ...(optStr(c.account) ? { account: c.account! } : {}), ...(optStr(c.replaceId) ? { replaceId: c.replaceId! } : {}),
        ...picks(c),
      });
      return e.orchView(o.view());
    },
    session_resume: async (c) => {
      if (typeof c.sessionId !== 'string' || (c.mode !== 'parallel' && c.mode !== 'replace')) throw new CommandError('bad_input', { key: 'errors.badTarget' });
      const pid = e.db.query<{ project_id: string }, [string]>('SELECT project_id FROM session WHERE id = ?').get(c.sessionId)?.project_id;
      if (pid) await e.held.wake(pid);
      const o = await e.orchestrators.resume(c.sessionId, {
        mode: c.mode, ...(optStr(c.replaceId) ? { replaceId: c.replaceId! } : {}), ...(optStr(c.account) ? { account: c.account! } : {}),
        ...picks(c),
      });
      return e.orchView(o.view());
    },
    session_resume_preview: (c) => {
      if (typeof c.sessionId !== 'string') throw new CommandError('bad_input', { key: 'errors.badTarget' });
      return e.orchestrators.preview(c.sessionId);
    },
    session_rename: (c) => {
      if (typeof c.sessionId !== 'string' || typeof c.title !== 'string') throw new CommandError('bad_input', { key: 'errors.badTarget' });
      return { title: e.orchestrators.rename(c.sessionId, c.title) };
    },
    lane_continue: async (c) => {
      if (typeof c.projectId !== 'string' || typeof c.name !== 'string' || typeof c.toSession !== 'string') throw new CommandError('bad_input', { key: 'errors.badTarget' });
      await e.held.wake(c.projectId);
      return e.continueLane(c.projectId, c.name, c.toSession, optStr(c.account));
    },
    lane_continue_preview: (c) => {
      if (typeof c.projectId !== 'string' || typeof c.name !== 'string') throw new CommandError('bad_input', { key: 'errors.badTarget' });
      return continuePreview(e.continueDeps(), c.projectId, c.name);
    },
    session_end: (c) => {
      if (typeof c.sessionId !== 'string') throw new CommandError('bad_input', { key: 'errors.noSession', params: { id: String(c.sessionId) } });
      return e.orchestrators.end(c.sessionId, optStr(c.lanesTo));
    },
    lane_reassign: async (c) => {
      if (typeof c.projectId !== 'string' || typeof c.name !== 'string' || typeof c.toSession !== 'string') throw new CommandError('bad_input', { key: 'errors.badTarget' });
      const r = await e.orchestrators.reassign(c.projectId, c.name, c.toSession, c.undo === true);
      const v = e.laneView(c.projectId, c.name);
      if (v) e.broadcast({ type: 'lane', lane: v });
      return r;
    },
    remote_off: notYet('errors.notYetRemote'),
    device_revoke_self: notYet('errors.notYetRemote'),
  });
}

function macHandlers(e: Engine) {
  return handlers({
    // ---------- Mac only ----------
    project_update: (c) => {
      const r = e.projectRow(c.id);
      if (!r) throw new CommandError('no_project', { key: 'errors.noProject' });
      const p = c.patch ?? {};
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      if (p.name !== undefined) {
        const n = String(p.name).trim();
        if (!n) throw new CommandError('bad_input', { key: 'errors.emptyName' });
        if (e.projectRows().some((x) => x.id !== c.id && x.name.toLocaleLowerCase('vi') === n.toLocaleLowerCase('vi'))) {
          throw new CommandError('duplicate_name', { key: 'errors.duplicateName', params: { name: n } });
        }
        sets.push('name = ?'); args.push(n);
      }
      if (p.orchestratorAccount !== undefined) { sets.push('orchestrator_account = ?'); args.push(p.orchestratorAccount); }
      if (p.gchatWebhook !== undefined) {
        const w = p.gchatWebhook === null || p.gchatWebhook === '' ? null : String(p.gchatWebhook);
        if (w !== null && !/^https:\/\/chat\.googleapis\.com\//.test(w)) throw new CommandError('bad_input', { key: 'errors.badWebhook' });
        sets.push('gchat_webhook = ?'); args.push(w);
      }
      if (p.gchatSendCommandText !== undefined) { sets.push('gchat_send_command_text = ?'); args.push(p.gchatSendCommandText ? 1 : 0); }
      if (sets.length) e.db.query(`UPDATE project SET ${sets.join(', ')} WHERE id = ?`).run(...args, c.id);
      const view = e.projectView(c.id)!;
      e.broadcast({ type: 'project', project: view });
      return view;
    },
    project_remove: notYet('errors.notYetProjectRemove'),
    caps_update: (c) => {
      // G1 IMPORTANT-4 (§7.1-2): before the caps.json import a table write would make the import skip that row.
      if (!e.registryImported()) throw new CommandError('bad_input', { key: 'errors.capsBroken' });
      const next = { default: e.caps.default, ...(c.caps ?? {}) } as Caps;
      const bad = validateCaps(next);
      if (bad) throw new CommandError('bad_input', bad);
      writeCaps(e.db, next); // §7.1-2: the account table, not caps.json
      e.readRegistry();
      if (typeof c.poEmail === 'string' && c.poEmail.trim()) setMeta(e.db, 'po_email', c.poEmail.trim());
      for (const a of e.accounts) e.accountChanged(a.email);
      e.broadcast({ type: 'config', config: e.configView() });
      return e.accountViews();
    },
    config_update: (c) => {
      if (c.patch && 'sharedExtra' in c.patch) throw new CommandError('bad_input', { key: 'errors.sharedViaToggle' }); // links must follow
      const patch = c.patch ?? {};
      // §6A: `ui` is merged key by key so a later UI setting never drops `lang`
      const next = { ...e.config, ...patch, ...(isPlainObj(patch.ui) ? { ui: { ...e.config.ui, ...patch.ui } } : {}) };
      const bad = validateConfig(next);
      // v2.4 §5.6 the web sends the whole `modelDefaults`; a missing row / cell is null
      if (!bad && 'modelDefaults' in patch) next.modelDefaults = fillModelDefaults(next.modelDefaults);
      if (bad) throw new CommandError('bad_input', bad);
      // §7.1-2: laneCaps / noNewLanes go to the account table, not config.json — but before the import has run they stay
      // in config.json (its only source until then) and the table is not touched (G1 IMPORTANT-1).
      const imported = e.registryImported();
      saveConfig(next, { keepRegistryKeys: !imported });
      if (imported) {
        const lanePatch: Partial<Pick<Config, 'laneCaps' | 'noNewLanes'>> = {};
        if (c.patch && 'laneCaps' in c.patch) lanePatch.laneCaps = next.laneCaps;
        if (c.patch && 'noNewLanes' in c.patch) lanePatch.noNewLanes = next.noNewLanes;
        writeLaneConfig(e.db, lanePatch);
      }
      e.config = next;
      e.readRegistry();
      e.broadcast({ type: 'config', config: e.configView() }); // the UI applies it (no snapshot round trip)
      return e.config;
    },
    quota_refresh: (c) => { // v2.7.1 §7.2: queue + answer at once; each result comes as an `account` event
      const views = e.accountViews();
      const list = c.account ? views.filter((v) => v.email === c.account) : views;
      if (c.account && list.length === 0) throw new CommandError('no_account', { key: 'errors.noAccount', params: { email: c.account } });
      // §7.1-3 "Làm mới" of every account: full ones first, then the oldest numbers
      const order = c.account ? list : [...list].sort((a, b) => Number(b.full) - Number(a.full) || (a.fetchedAt ?? -1) - (b.fetchedAt ?? -1));
      const accounts = order.map((v) => e.accounts.find((a) => a.email === v.email)).filter((a) => a !== undefined);
      const ack = e.tracker.requestRefresh(accounts, { front: !!c.account, loggedOut: e.loggedOut() });
      e.quotaTick(true); // the first ask goes out now when the gap allows (after the ack is built)
      return ack;
    },
    setup_check: () => e.runSetupCheck(),
    setup_install: (c) => {
      if (!['claude', 'claude_update'].includes(c.what)) throw new CommandError('bad_input', { key: 'errors.unknownInstall' });
      const job = c.what; // the wizard matches install_log.job against setup_install.what
      const log = (line: string) => e.broadcast({ type: 'install_log', job, line });
      void (async () => {
        let ok = false;
        try {
          ok = await installClaude(c.what, { exec: e.exec, log, claudePath: e.login.claudePath });
        } catch (err) { log(`Lỗi: ${(err as Error).message}`); }
        e.broadcast({ type: 'install_log', job, line: ok ? 'Xong' : 'Thất bại', lineKey: ok ? 'labels.installDone' : 'labels.installFailed', done: true, ok });
        await e.runSetupCheck().catch(() => {});
      })();
      return { job };
    },
  });
}

async function spawnOpen(e: Engine, argv: string[]): Promise<void> {
  const r = await e.exec(argv);
  if (r.code !== 0) throw new CommandError('open_failed', r.stderr.trim() ? { key: 'errors.openFailed', params: { detail: r.stderr.trim() } } : { key: 'errors.openFailedCode', params: { code: r.code } });
}

function accountHandlers(e: Engine) {
  return handlers({
    // ---------- v2 accounts (§6 A3–A8, Mac only) ----------
    account_add: (c) => {
      if (c.email !== undefined && (typeof c.email !== 'string' || c.email.length > 320)) throw new CommandError('bad_input', { key: 'errors.badEmail' });
      return e.startAccountLogin({ ...(c.email?.trim() ? { email: c.email.trim() } : {}), ...(c.sso === true ? { sso: true } : {}) });
    },
    account_login: (c) => {
      if (typeof c.email !== 'string' || !c.email.trim()) throw new CommandError('bad_input', { key: 'errors.needEmail' });
      return e.startAccountLogin({ accountEmail: c.email });
    },
    account_login_cancel: async () => {
      const l = activeLogin();
      if (!l) throw new CommandError('no_login', { key: 'errors.noLogin' });
      return l.cancel();
    },
    account_paste_code: (c) => {
      const l = activeLogin();
      if (!l) throw new CommandError('no_login', { key: 'errors.noLogin' });
      if (typeof c.code !== 'string' || !l.submitCode(c.code)) throw new CommandError('bad_input', { key: 'errors.badCode' });
    },
    account_login_resolve: (c) => {
      const l = activeLogin();
      if (!l || (c.choice !== 'keep' && c.choice !== 'drop') || !l.resolveMismatch(c.choice)) {
        throw new CommandError('bad_input', { key: 'errors.noLoginPending' });
      }
    },
    account_logout: (c) => {
      if (typeof c.email !== 'string' || !c.email.trim()) throw new CommandError('bad_input', { key: 'errors.needEmail' });
      return e.logoutAccount(c.email);
    },
    account_delete: (c) => {
      if (typeof c.email !== 'string' || !c.email.trim()) throw new CommandError('bad_input', { key: 'errors.needEmail' });
      return e.deleteAccount(c.email);
    },
    // ---------- v2 shared config (§5.2, §5.5, A9; Mac only, N7) ----------
    shared_cfg_merge: (c) => {
      if (typeof c.email !== 'string' || !c.email.trim() || typeof c.name !== 'string' || !c.name) throw new CommandError('bad_input', { key: 'errors.needEmailName' });
      return e.mergeSharedCfg(c.email, c.name, c.dryRun === true);
    },
    shared_cfg_toggle: (c) => {
      if (typeof c.name !== 'string' || typeof c.shared !== 'boolean') throw new CommandError('bad_input', { key: 'errors.needNameShared' });
      return e.toggleShared(c.name, c.shared);
    },
    shared_cfg_reveal: (c) => { // §6 A9C "Mở Finder": the path comes from the merge plan only (engine.clashPath)
      const p = typeof c.email === 'string' && typeof c.name === 'string' && typeof c.file === 'string' ? e.clashPath(c.email, c.name, c.file) : null;
      if (!p) throw new CommandError('no_clash', { key: 'errors.noClash' });
      return spawnOpen(e, ['open', '-R', p]);
    },
    account_open_private: async (c) => {
      if (typeof c.url !== 'string') throw new CommandError('bad_input', { key: 'errors.needUrl' });
      const r = await e.openPrivate(c.url);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
    folder_pick: async () => {
      // macOS "Choose Folder" panel, brought to the front (`activate`: the engine is a background LaunchAgent, the panel would
      // open behind the app window); the prompt is an engine-owned catalog string (quotes stripped: AppleScript literal)
      const prompt = t(e.config.ui?.lang ?? 'vi', 'labels.pickRepo').replace(/["\\]/g, '');
      const r = await e.exec(['osascript', '-e', 'activate', '-e', `POSIX path of (choose folder with prompt "${prompt}")`]);
      if (r.code === 0 && r.stdout.trim()) return { path: r.stdout.trim().replace(/(.)\/$/, '$1') };
      if (/-128|cancel/i.test(r.stderr)) return { path: null };
      throw new CommandError('open_failed', r.stderr.trim() ? { key: 'errors.openFailed', params: { detail: r.stderr.trim() } } : { key: 'errors.openFailedCode', params: { code: r.code } });
    },
    accounts_info: () => e.accountsInfo(),
    account_open_terminal: (c) => {
      const dir = typeof c.email === 'string' ? e.accountDir(c.email) : null;
      if (!dir) throw new CommandError('no_account', { key: 'errors.noAccount', params: { email: String(c.email) } });
      return spawnOpen(e, ['open', '-a', 'Terminal', dir]);
    },
    engine_shutdown: () => {
      const busy = e.busyLanes();
      if (busy.length) throw new CommandError('lanes_running', { key: 'errors.lanesRunningStop', params: { n: busy.length, lanes: busy.join(', ') } });
      setTimeout(() => e.o.onShutdownRequest?.(), 50);
      return { shuttingDown: true };
    },
  });
}
