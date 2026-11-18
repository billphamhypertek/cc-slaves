// v2.1 §4.14 "Chạy tiếp một phiên đã kết thúc" / §4.15 "Chạy tiếp lane": the pure parts — first-turn quota estimate,
// the ≥ 80 % context flag, the engine's first message — and the read-only probes of Claude Code's own files (the session
// transcript jsonl, `cleanupPeriodDays` of the shared settings.json; cc-slaves never writes that file).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import { displayTokens, type TokenCounts } from '../../../shared/protocol.ts';

/** One refresh interval of the account's cached `five_pct`: Σ tokens (W10 "tok") of its turns, the reading at each end. */
export interface QuotaSample { tokens: number; before: number; after: number }
export interface FirstTurnEstimate { tokens: number; pct: number | null; samples: number }

/** §4.14 fewer usable refresh intervals than this → no % (only the tokens). */
export const MIN_SAMPLES = 5;
/** §4.14 "ước từ 12 lượt gần nhất": the 12 newest refresh intervals. */
const MAX_SAMPLES = 12;
/** Newest stored turns of the account read to build the intervals (7 days of an orchestrator + lanes fit). */
const MAX_TURNS = 2000;
const SAMPLE_WINDOW_MS = 7 * 86_400_000;
/** §4.14 N5-g context ≥ 80 % → "sẽ tự nén ngay sau lượt đầu". */
const CONTEXT_HIGH_PCT = 80;
const CLEANUP_DEFAULT_DAYS = 30;
/** §4.14 the history list warns "hết hạn sau n ngày" from this many days left. */
const EXPIRY_WARN_DAYS = 5;

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

/**
 * §4.14 the first turn after a resume has no cache: it re-reads `ctxLast` tokens. % of the 5 h quota = ctxLast ×
 * median(Δfive_pct / Δtok) over the usable samples (tokens > 0, no reset in between); < 5 of them → `pct: null`.
 */
export function estimateFirstTurn(ctxLast: number | null, samples: readonly QuotaSample[]): FirstTurnEstimate | null {
  if (ctxLast === null) return null;
  const ratios = samples.filter((s) => s.tokens > 0 && s.after >= s.before).map((s) => (s.after - s.before) / s.tokens);
  if (ratios.length < MIN_SAMPLES) return { tokens: ctxLast, pct: null, samples: ratios.length };
  return { tokens: ctxLast, pct: Math.round(ctxLast * median(ratios)), samples: ratios.length };
}

export const contextHigh = (ctx: number | null, window: number): boolean => ctx !== null && ctx * 100 >= window * CONTEXT_HIGH_PCT;

/** §4.14 the engine's first message to a resumed session (the outbox adds `[cc-slaves]`). */
export const resumeFirstText = (ago: string, changes: readonly string[]): string =>
  `Phiên này được nối lại sau ${ago}. Từ lúc dừng: ${changes.length ? changes.join(', ') : 'không có lane đổi'}. Gọi \`lanes_list\` trước khi ra lệnh.`;

/** "2 giờ", "3 ngày", "5 phút" (the message to the model is Vietnamese, like every engine message). */
export function agoText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} phút`;
  if (s < 86_400) return `${Math.round(s / 3600)} giờ`;
  return `${Math.round(s / 86_400)} ngày`;
}

interface StoredTurn { usage?: TokenCounts | null; fiveBefore?: number | null; fiveAtBefore?: number | null; fiveAfter?: number | null; fiveAtAfter?: number | null }
interface Reading { pct: number; at: number }
const reading = (pct: number | null | undefined, at: number | null | undefined): Reading | null =>
  typeof pct === 'number' && typeof at === 'number' ? { pct, at } : null;

/**
 * §4.14 the account's `five_pct` is a cached value (polled, `quota.fetched_at`), so one turn rarely sees it move. A sample
 * is one refresh interval instead: from one reading to the next different one (new fetch time or value), Δfive ÷ Σ
 * tokens of the account's turns stored in between (any session). Newest 12, last 7 days.
 */
export function quotaSamples(db: Db, account: string, nowMs: number = Date.now()): QuotaSample[] {
  const rows = db.query<{ json: string }, [number, string]>(
    `SELECT json FROM event WHERE type = 'result' AND ts >= ?1 AND json_extract(json, '$.account') = ?2
     ORDER BY id DESC LIMIT ${MAX_TURNS}`,
  ).all(nowMs - SAMPLE_WINDOW_MS, account).reverse();
  const out: QuotaSample[] = [];
  let cur: Reading | null = null;
  let tokens = 0;
  const see = (r: Reading | null) => {
    if (!r || (cur && cur.pct === r.pct && cur.at === r.at)) return;
    if (cur && tokens > 0) out.push({ tokens, before: cur.pct, after: r.pct });
    cur = r;
    tokens = 0;
  };
  for (const { json } of rows) {
    const j = JSON.parse(json) as StoredTurn;
    see(reading(j.fiveBefore, j.fiveAtBefore));
    tokens += j.usage ? displayTokens(j.usage) : 0;
    see(reading(j.fiveAfter, j.fiveAtAfter));
  }
  return out.slice(-MAX_SAMPLES);
}

/** Claude Code's project dir name: the cwd with every non-alphanumeric character turned into `-`. */
export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');
/** Every account's `projects/` links into the shared `~/.claude/projects` (v2 §5.2), so one place holds them all. */
export const transcriptPath = (claudeHome: string, cwd: string, sessionId: string): string =>
  join(claudeHome, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);

/** `cleanupPeriodDays` of the shared `~/.claude/settings.json` (read only); missing / bad → 30. */
export function cleanupPeriodDays(claudeHome: string): number {
  try {
    const v = (JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8')) as { cleanupPeriodDays?: unknown }).cleanupPeriodDays;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : CLEANUP_DEFAULT_DAYS;
  } catch { return CLEANUP_DEFAULT_DAYS; }
}

/** Is the transcript still on disk; days left before Claude Code deletes it, only when ≤ 5 (list warning). */
export function transcriptInfo(claudeHome: string, cwd: string, sessionId: string, nowS: number): { exists: boolean; expiresInDays: number | null } {
  let mtimeS: number;
  try { mtimeS = Math.floor(statSync(transcriptPath(claudeHome, cwd, sessionId)).mtimeMs / 1000); } catch { return { exists: false, expiresInDays: null }; }
  const left = Math.max(0, Math.ceil((mtimeS + cleanupPeriodDays(claudeHome) * 86_400 - nowS) / 86_400));
  return { exists: true, expiresInDays: left <= EXPIRY_WARN_DAYS ? left : null };
}

/** What TurnFive reads of the account's `quota` row. */
interface FiveRow { fivePct: number | null; fetchedAt: number; status: string }
interface TurnReadings { account: string; fiveBefore: number | null; fiveAtBefore: number | null; fiveAfter: number | null; fiveAtAfter: number | null }

/**
 * §4.14 the account's cached `five_pct` and its fetch time before (first activity of the turn) and after (its result),
 * stored on the result event. A row that is not `ok` (a stream reject's 100 %, needs_probe) is no reading.
 */
export class TurnFive {
  private before: Reading | null | undefined;
  constructor(private readonly row: (email: string) => FiveRow | null) {}
  private read(email: string): Reading | null {
    const r = this.row(email);
    return r && r.status === 'ok' ? reading(r.fivePct, r.fetchedAt) : null;
  }
  start(email: string): void { if (this.before === undefined) this.before = this.read(email); }
  end(email: string): TurnReadings {
    const b = this.before ?? null;
    this.before = undefined;
    const a = this.read(email);
    return { account: email, fiveBefore: b?.pct ?? null, fiveAtBefore: b?.at ?? null, fiveAfter: a?.pct ?? null, fiveAtAfter: a?.at ?? null };
  }
}
