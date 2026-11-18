// Dev mock: v2.1 §4.14 session history for frame DKS (two ended sessions: #2 replaced with a handoff, #1 expired).
import type { ResumePreview, SessionRowView, SessionsList, Snapshot } from '../../shared/protocol.ts';

const H = 3_600_000, T = { input: 90_000, output: 310_000, cacheWrite: 820_000, cacheRead: 7_400_000 };
export const ENDED_ROWS: SessionRowView[] = [
  { sessionId: 's2', projectId: 'p1', seq: 2, title: 'lot-2', state: 'ended', startedAt: Date.now() - 30 * H, endedAt: Date.now() - 26 * H,
    accountFirst: 'pm@example.net', accountLast: 'acc07@example.net', lanes: 2, tokens: T, costUsd: 19.8, endReason: 'replaced',
    handoffPath: '/Users/po/.cc-slaves/handoff/s2.md', ctxLast: 142_000, resumable: true, expiresInDays: 4,
    // v2.4 §4.1 MD12 what it last ran; §4.4 MD11 the picks the resume dialog keeps
    model: 'claude-opus-5-5', modelName: 'Opus 5.5', effort: 'xhigh', modelPick: 'opus', effortPick: 'xhigh' },
  { sessionId: 's1', projectId: 'p1', seq: 1, title: null, state: 'ended', startedAt: Date.now() - 40 * 24 * H, endedAt: Date.now() - 39 * 24 * H,
    accountFirst: 'pm@example.net', accountLast: 'pm@example.net', lanes: 1, tokens: T, costUsd: 6.2, endReason: 'handoff',
    handoffPath: null, ctxLast: 61_000, resumable: false, reason: { key: 'errors.noTranscript', params: { days: 30 } } },
];

export function sessionsList(s: Snapshot, projectId: string): SessionsList {
  const running: SessionRowView[] = s.orchestrators.filter(o => o.projectId === projectId).map(o => ({
    sessionId: o.sessionId ?? o.projectId, projectId, seq: o.seq ?? 1, title: o.title ?? null, state: o.state, startedAt: Date.now() - 5 * H, endedAt: null,
    accountFirst: o.homeAccount, accountLast: o.account, lanes: s.lanes.filter(l => l.ownerSession === o.sessionId).length, tokens: T, costUsd: o.costUsd,
    endReason: null, handoffPath: null, ctxLast: null, resumable: null }));
  const live = new Set(running.map(r => r.sessionId));
  return { running, ended: ENDED_ROWS.filter(r => !live.has(r.sessionId)), max: 3, cleanupPeriodDays: 30 };
}

/** §4.14 M3 like the engine: the first logged-in account no live session orchestrates on. */
export const freeAccount = (s: Snapshot): string | null =>
  s.accounts.find(a => !a.loggedOut && !s.orchestrators.some(o => o.account === a.email))?.email ?? null;

export function resumePreview(s: Snapshot, sessionId: string): ResumePreview {
  const r = ENDED_ROWS.find(x => x.sessionId === sessionId) ?? ENDED_ROWS[0]!;
  const running = s.orchestrators.filter(o => o.projectId === r.projectId).length;
  return { sessionId, projectId: r.projectId, seq: r.seq, title: r.title, resumable: !!r.resumable, reason: r.reason ?? null, ctxLast: r.ctxLast, ctxWindow: 200_000,
    ctxPct: 71, ctxHigh: false, estimate: { tokens: 142_000, pct: 9, samples: 12 }, account: freeAccount(s), accountLast: r.accountLast,
    accountReason: null, sinceStop: [{ name: 'D7', kind: 'done', seq: null, at: Date.now() - 25 * H }, { name: 'D9', kind: 'moved', seq: 3, at: Date.now() - 24 * H }],
    parallelAllowed: running < 3, running, max: 3, handoffPath: r.handoffPath, expiresInDays: r.expiresInDays ?? null, cleanupPeriodDays: 30,
    modelPick: r.modelPick ?? null, effortPick: r.effortPick ?? null };
}
