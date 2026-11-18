// v2.1 §4.14 "Chạy tiếp lane đã xong" (N5-o, N5-l, N5-m): preview + `lane_continue`. Refused when the lane branch is
// merged / gone / cannot be measured or the lane's Claude transcript has expired; a removed worktree is rebuilt from the
// lane branch (`git worktree add <cwd> <branch>` in the project repo) before the first message.
import { existsSync } from 'node:fs';
import type { KeyedReason, LaneContinuePreview } from '../../../shared/protocol.ts';
import { getLane, getLaneBranch, type Db, type Lane } from '../db.ts';
import { estimateFirstTurn, quotaSamples, transcriptInfo } from '../orchestrator/resume.ts';
import { SessionError } from '../orchestrator/owners.ts';
import type { Exec } from '../setup/setup.ts';
import { BRANCH_TIMEOUT_MS, laneBranchName, measureBranch } from './branch.ts';
import type { Key } from '../../../shared/i18n/index.ts';

export interface ContinueDeps {
  db: Db; exec: Exec; claudeHome: string;
  repoOf: (projectId: string) => string | null;
  now?: () => number;
  /** §4.14 M3 accounts a live session orchestrates on: never the proposed lane account. */
  busy?: () => string[];
}

/** `account` = the one to continue on (null = the lane picker); `accountLast` = the lane's last one. */
interface Check { lane: Lane; reason: KeyedReason | null; branch: string | null; ahead: number; worktreeExists: boolean; account: string | null; accountLast: string | null; ctxLast: number | null }

const kr = (key: string, params?: Record<string, string | number>): KeyedReason => ({ key, ...(params ? { params } : {}) });

async function check(d: ContinueDeps, projectId: string, name: string): Promise<Check> {
  const lane = getLane(d.db, projectId, name);
  if (!lane) throw new SessionError('no_lane', { key: 'errors.noLane', params: { name } });
  const s = d.db.query<{ account: string | null; ctx_last: number | null }, [string]>('SELECT account, ctx_last FROM session WHERE id = ?').get(lane.sessionId ?? '');
  const last = s?.account ?? null, busy = d.busy?.() ?? [];
  const base = { lane, account: last !== null && busy.includes(last) ? null : last, accountLast: last, ctxLast: s?.ctx_last ?? null, worktreeExists: existsSync(lane.cwd), ahead: 0 };
  if (lane.state !== 'done') return { ...base, branch: null, reason: kr('errors.laneNotDone', { name }) };
  const repo = d.repoOf(projectId);
  let branch = getLaneBranch(d.db, lane.id).name;
  if (branch === undefined && repo) { const f = await laneBranchName(repo, lane.cwd, d.exec); branch = 'name' in f ? f.name : undefined; }
  const b = branch ?? null;
  if (!repo) return { ...base, branch: b, reason: kr('errors.laneBranchUnknown', { detail: 'project gone' }) };
  const m = (await measureBranch(repo, b, { exec: d.exec, ...(d.now ? { now: d.now } : {}) })).info;
  let reason: KeyedReason | null = null;
  if (m.state === 'merged') reason = kr('errors.laneMerged', { branch: b ?? '' });
  else if (m.state === 'gone' || (m.state === 'none' && !base.worktreeExists)) reason = kr('errors.laneNoBranch', { branch: b ?? lane.cwd });
  else if (m.state === 'unknown') reason = kr('errors.laneBranchUnknown', { detail: m.reason ?? '?' });
  else if (!lane.sessionId || !transcriptInfo(d.claudeHome, lane.cwd, lane.sessionId, Math.floor(Date.now() / 1000)).exists) reason = kr('errors.laneNoTranscript');
  return { ...base, branch: b, ahead: m.ahead, reason };
}

export async function continuePreview(d: ContinueDeps, projectId: string, name: string): Promise<LaneContinuePreview> {
  const c = await check(d, projectId, name);
  return {
    projectId, name, resumable: c.reason === null, reason: c.reason, ctxLast: c.ctxLast,
    estimate: c.account ? estimateFirstTurn(c.ctxLast, quotaSamples(d.db, c.account)) : null,
    account: c.account, accountLast: c.accountLast, worktreeExists: c.worktreeExists, branch: c.branch, ahead: c.ahead,
  };
}

/** §4.14 first engine message to a continued lane (the outbox adds `[cc-slaves]`). */
export const laneContinueText = (seq: number | null, rebuilt: string | null): string =>
  `PO chạy tiếp lane này (đã xong trước đó), giờ thuộc phiên Điều phối #${seq ?? '?'}.` +
  (rebuilt ? ` Worktree đã được dựng lại từ nhánh ${rebuilt}.` : '') + ' Kiểm tra `git status` rồi chờ tin của Điều phối.';
export const laneContinuedText = (name: string): string =>
  `PO chạy tiếp lane ${name} (đã xong) trong phiên này. Gọi \`lane_tail\` ${name} để nắm tình hình.`;

/** Checks again, rebuilds a removed worktree from the lane branch; returns the lane and the rebuilt branch (if any). */
export async function prepareContinue(d: ContinueDeps, projectId: string, name: string): Promise<{ lane: Lane; account: string | null; rebuilt: string | null }> {
  const c = await check(d, projectId, name);
  if (c.reason) throw new SessionError(c.reason.key === 'errors.laneNotDone' ? 'lane_not_done' : 'lane_not_continuable', { key: c.reason.key as Key, params: c.reason.params ?? {} });
  if (c.worktreeExists || c.branch === null) return { lane: c.lane, account: c.account, rebuilt: null };
  const repo = d.repoOf(projectId)!;
  const git = (...a: string[]) => d.exec(['git', '-C', repo, ...a], { timeoutMs: BRANCH_TIMEOUT_MS });
  await git('worktree', 'prune');
  const r = await git('worktree', 'add', c.lane.cwd, c.branch);
  if (r.code !== 0) throw new SessionError('lane_not_continuable', { key: 'errors.worktreeRebuild', params: { detail: (r.stderr || r.stdout).trim().split('\n')[0] ?? `git exit ${r.code}` } });
  return { lane: c.lane, account: c.account, rebuilt: c.branch };
}
