// Snapshot / event view builders (spec §7.9): engine rows + runtime views → the shapes in shared/protocol.ts.
// Pure functions; the WS hub calls them for the snapshot and for every domain event.
import {
  ZERO_TOKENS, type AccountView, type CardView, type LaneBranch, type LaneView, type OrchestratorView, type ProjectView, type TokenCounts,
} from '../../../shared/protocol.ts';
import type { Account } from '../accounts/registry.ts';
import { hasFiveWindow, isFresh } from '../accounts/quota.ts';
import { t } from '../../../shared/i18n/index.ts';
import { displayOptions, permissionTitleKey, sourceText, type AskPayload, type Card, type PermissionPayload, type SystemPayload } from '../cards/store.ts';
import { resolveCaps, type Caps, type ResolvedCaps } from '../config.ts';
import type { Lane, QuotaRow } from '../db.ts';
import type { LaneView as RtLane } from '../lane/manager.ts';
import type { OrchestratorView as RtOrchestrator } from '../orchestrator/session.ts';

export interface ProjectRow {
  id: string; name: string; path: string; orchestrator_account: string | null;
  gchat_webhook: string | null; gchat_send_command_text: number;
}

/** §5.3 the engine stores epoch seconds; every `*At` a client reads is epoch ms. */
export const msOf = (s: number | null | undefined): number | null => (s == null ? null : s * 1000);

/** The webhook URL is a secret: only "set or not" leaves the engine. */
export function projectView(r: ProjectRow): ProjectView {
  return {
    id: r.id, name: r.name, path: r.path, orchestratorAccount: r.orchestrator_account, gchatWebhookSet: !!r.gchat_webhook, gchatSendCommandText: r.gchat_send_command_text === 1,
  };
}

/** `o.tokens` / `o.run` = the lane's stored tokens (§5.3) / last model read (v2.4 §5.6), used when it has no runtime. */
export function laneView(l: Lane, rt: RtLane | null, o: { worktreeExists: boolean; switches: number; updatedAt: number; tokens?: TokenCounts; branch?: LaneBranch | null; run?: LaneView['run'] | null }): LaneView {
  const phase = rt?.phase ?? l.phase;
  const run = rt ? rt.run : o.run; // v2.4 §5.6 `model` / `effort` stay tier 1; `run` = what the process runs
  return {
    projectId: l.projectId, name: l.name, state: rt?.state ?? l.state,
    phase,
    task: l.task, note: l.note, account: rt?.account ?? null, cwd: l.cwd, worktreeExists: o.worktreeExists,
    agent: l.agent, model: l.model, effort: l.effort, failCount: rt?.failCount ?? l.failCount,
    lastError: rt ? rt.lastError : l.lastError, lastErrorKeyed: (rt ? rt.lastErrorKeyed : l.lastErrorKeyed) ?? null, costUsd: rt?.costUsd ?? l.costUsd, openCards: rt ? [...rt.openCards] : [],
    turnStartedAt: rt?.turnStartedAt ?? null, contextPct: rt?.contextPct ?? null, switches: o.switches, updatedAt: o.updatedAt,
    tokens: { ...(rt?.tokens ?? o.tokens ?? ZERO_TOKENS) }, branch: o.branch ?? null,
    ...(run ? { run: { ...run } } : {}), ...(rt?.pending ? { pending: { ...rt.pending } } : {}), ...(rt?.modelMismatch ? { modelMismatch: true } : {}),
  };
}

export function orchestratorView(v: RtOrchestrator, costUsd: number): OrchestratorView {
  return {
    projectId: v.projectId, state: v.state === 'done' ? 'stopped' : v.state, account: v.account, homeAccount: v.home,
    lastError: v.lastError, lastErrorKeyed: v.lastErrorKeyed ?? null, costUsd, contextPct: v.contextPct ?? null,
    talkingTo: v.talkingTo, tokens: { ...(v.tokens ?? ZERO_TOKENS) }, ...(v.model ? { model: v.model } : {}),
  };
}

/** v2 §6 A2: an account's `claude auth status` state, as the engine holds it in memory. */
export type AuthCheck = 'ok' | 'out' | 'unknown' | 'checking';
const loginOf = (a: AuthCheck | null | undefined): AccountView['login'] =>
  a === 'out' ? 'out' : a === 'unknown' || a === 'checking' ? 'unknown' : 'ok';

type FullWhy = NonNullable<AccountView['fullWhy']>;
type TrackFields = Pick<AccountView, 'refresh' | 'nextCheckAt' | 'quotaError'>;
const IDLE: TrackFields = { refresh: { state: 'idle', at: null }, nextCheckAt: null, quotaError: null };

/**
 * v2.7.1 §4.5 why the account is `full` (same conditions as `full`, null when it is not): Anthropic's `rejected` first
 * (the week when it reads 100 % or the account has no 5-hour window, else the 5 hours), then the week cap, then the
 * 5-hour cap (Max only, always soft). `leaveAt` = where the engine really stops.
 */
function fullCause(q: QuotaRow, c: ResolvedCaps, five: boolean): FullWhy | null {
  const week = (by: FullWhy['by']): FullWhy => ({
    window: 'week', by, usedPct: q.weekPct, cap: by === 'cap' ? c.week : null, leaveAt: by === 'cap' ? c.weekLeaveAt : null,
    hard: c.hard, resetsAt: msOf(q.weekResetsAt),
  });
  const fiveWhy = (by: FullWhy['by']): FullWhy => ({
    window: 'five', by, usedPct: q.fivePct, cap: by === 'cap' ? c.five : null, leaveAt: by === 'cap' ? c.fiveLeaveAt : null,
    hard: false, resetsAt: msOf(q.fiveResetsAt),
  });
  if (q.status === 'rejected') return (q.weekPct ?? 0) >= 100 || !five ? week('anthropic') : fiveWhy('anthropic');
  if (q.weekPct !== null && q.weekPct >= c.weekLeaveAt) return week('cap');
  if (five && c.fiveLeaveAt !== null && q.fivePct !== null && q.fivePct >= c.fiveLeaveAt) return fiveWhy('cap');
  return null;
}

export function accountView(i: {
  account: Account; caps: Caps; quota: QuotaRow | null; lanes: number; now: number; loggedOut: boolean;
  sharedCfg?: AccountView['sharedCfg'];
  /** v2 §6 A2 / §3.1-4: last `claude auth status` (exit code); `checking` = the first check is still running. */
  auth?: AuthCheck | null;
  /** v2.7.1 §7.3 the tracker part (`QuotaTracker.view`); absent = idle. */
  track?: TrackFields;
}): AccountView {
  const c = resolveCaps(i.caps, i.account.email);
  const q = i.quota;
  const weekPct = q?.weekPct ?? null;
  const fivePct = q?.fivePct ?? null;
  const status = (q?.status ?? 'unknown') as AccountView['status'];
  const fiveWindow = hasFiveWindow(i.account.planTier, q); // D103: Ultra is never full by 5 hours
  const cause = q ? fullCause(q, c, fiveWindow) : null;
  const full = cause !== null;
  const track = i.track ?? IDLE;
  // §4.4 the reset of the window that filled it has passed and no newer numbers came: not "Đầy" any more (`full` stays).
  const passed = cause !== null && cause.resetsAt !== null && i.now * 1000 >= cause.resetsAt;
  const admit = !full && c.hard && weekPct !== null && weekPct > c.weekAdmitMax; // picker `week_full` (§4.5, L13)
  return {
    // F16: signed out here / auth error / no Keychain item → out; else the auth status result (timeout → `?`).
    // `expiring` (⚠) is not emitted yet: no measured source for a token's expiry (open PO item).
    id: i.account.id, login: i.loggedOut ? 'out' : loginOf(i.auth),
    email: i.account.email, plan: i.account.planTier, role: c.role, week: c.week, five: c.five, hard: c.hard,
    terminal: i.account.terminal, loggedOut: i.loggedOut, lanes: i.lanes, // hf1116: the terminal login is a normal account
    weekPct, fivePct, weekResetsAt: msOf(q?.weekResetsAt), fiveResetsAt: msOf(q?.fiveResetsAt),
    fetchedAt: msOf(q?.fetchedAt), fresh: isFresh(q, i.now), status,
    headroomPct: weekPct === null ? null : Math.max(0, Math.round((c.weekLeaveAt - weekPct) * 10) / 10), full,
    sharedCfg: i.sharedCfg ?? { ok: true, issues: [] }, // v2 §5.5 A9
    ...track, fiveWindow,
    fullWhy: passed ? null : cause,
    admitBlock: admit ? { usedPct: weekPct, admitMax: c.weekAdmitMax, cap: c.week, leaveAt: c.weekLeaveAt } : null,
    pastReset: passed ? { window: cause.window, at: cause.resetsAt!, recheckAt: track.nextCheckAt } : null,
  };
}

export function cardView(c: Card): CardView {
  const base = { id: c.id, kind: c.kind, projectId: c.projectId, status: c.status, createdAt: c.createdAt * 1000, resolvedAt: msOf(c.resolvedAt), answer: c.answer ?? undefined };
  if (c.kind === 'ask') {
    const p = c.payload as AskPayload;
    return {
      ...base, source: p.source, title: t('vi', 'cards.ask', { source: sourceText('vi', p.source), question: p.question }),
      titleKey: 'cards.ask', params: { source: p.source, question: p.question }, question: p.question,
      options: displayOptions(c).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      recommended: p.recommended, context: p.context,
    };
  }
  if (c.kind === 'permission') {
    const p = c.payload as PermissionPayload;
    return {
      ...base, source: p.source, title: p.title, ...permissionTitleKey(p.source, p.toolName, p.input, p.description),
      context: JSON.stringify(p.input, null, 2), canAllowAlways: p.allowAlways,
    };
  }
  const p = c.payload as SystemPayload;
  return {
    ...base, source: null, title: p.title, ...(p.titleKey ? { titleKey: p.titleKey, ...(p.params ? { params: p.params } : {}) } : {}),
    context: p.body, ...(p.bodyKey ? { bodyKey: p.bodyKey, ...(p.bodyParams ? { bodyParams: p.bodyParams } : {}), ...(p.bodyInner ? { bodyInner: p.bodyInner } : {}) } : {}),
    actions: p.actions.map((a) => ({ id: a.action, label: a.label, ...(a.labelKey ? { labelKey: a.labelKey, ...(a.labelParams ? { labelParams: a.labelParams } : {}) } : {}) })),
    key: p.key ?? null,
    ...(c.kind === 'mcp_login' ? { projectIds: mcpLoginProjects(p) } : {}),
  };
}

/** v2.2 C26 the projects the K13 login action carries (engine/mcp-login.ts). */
function mcpLoginProjects(p: SystemPayload): string[] {
  const ids = p.actions.find((a) => a.action === 'mcp_login')?.args?.projectIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}
