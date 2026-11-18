// v2.1 §4.14 parallel orchestrator sessions: numbering (#n per project, never reused), lane ownership (a lane belongs
// to one running session), and the texts the orchestrator's MCP tools return. Pure state.db helpers.
import { insertEvent, type Db } from '../db.ts';
import type { SinceStopLane } from '../../../shared/protocol.ts';
import { KeyedError, type Msg } from '../errors.ts';

export type SessionErrorCode = 'session_cap' | 'session_last' | 'session_closing' | 'no_session' | 'bad_receiver' | 'no_lane' | 'same_owner' | 'bad_input'
  | 'session_live' | 'not_resumable' | 'no_handoff' | 'lane_not_done' | 'lane_not_continuable';
/** §4.14 session commands' refusals (catalog key + vi fallback, like LaneError). */
export class SessionError extends KeyedError {
  declare readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, m: Msg) { super(code, m); this.name = 'SessionError'; }
}

/** §4.7 a new Thiết kế session's title until `spec_draft` names it: "Thiết kế · HH:MM", VN time (UTC+7). */
export function designTitle(nowMs: number): string {
  const d = new Date(nowMs + 7 * 3_600_000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `Thiết kế · ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}
/** §4.14 session title ≤ 24 chars. */
export const TITLE_MAX = 24;

/** Next #n for a project: one past the highest ever given (ended sessions keep theirs). */
export function nextSeq(db: Db, projectId: string): number {
  const r = db.query<{ m: number | null }, [string]>(
    "SELECT MAX(seq) AS m FROM session WHERE project_id = ? AND kind = 'orchestrator'",
  ).get(projectId);
  return (r?.m ?? 0) + 1;
}

export function seqOf(db: Db, sessionId: string): number | null {
  return db.query<{ seq: number | null }, [string]>('SELECT seq FROM session WHERE id = ?').get(sessionId)?.seq ?? null;
}

export function ownerOf(db: Db, projectId: string, name: string): { sessionId: string; seq: number | null } | null {
  const r = db.query<{ owner: string | null; seq: number | null }, [string, string]>(
    'SELECT l.owner_session AS owner, s.seq AS seq FROM lane l LEFT JOIN session s ON s.id = l.owner_session WHERE l.project_id = ? AND l.name = ?',
  ).get(projectId, name);
  return r?.owner ? { sessionId: r.owner, seq: r.seq } : null;
}

/** §4.14 a command tool on another session's lane. */
export const notOwnerText = (lane: string, seq: number | null): string => `${lane} thuộc #${seq ?? '?'}; nhờ PO chuyển`;
/** §4.14 `UNIQUE(project_id, name)` across sessions: the orchestrator picks another name. */
export const nameTakenText = (lane: string, seq: number | null): string =>
  seq === null ? `Tên ${lane} đã có` : `Tên ${lane} đã có (thuộc #${seq})`;
/** §4.14 default first message of a parallel session (the outbox adds `[cc-slaves]`). */
export const parallelFirstText = (n: number, project: string): string =>
  `Phiên song song #${n} của ${project}. Gọi \`lanes_list\`; chỉ ra lệnh lane của mình.`;
/** §4.14 to the session that got lanes it did not open (adoption, end of another session). */
export const lanesReceivedText = (names: readonly string[], from: string): string =>
  `Phiên này nhận lane ${names.join(', ')} (${from}). Gọi \`lanes_list\` trước khi ra lệnh.`;
/** §4.14 "Đổi chủ lane": one message to the old owner, one to the new. */
export const laneGoneText = (lane: string, to: number | null): string =>
  `PO chuyển lane ${lane} sang phiên #${to ?? '?'}. Từ giờ không ra lệnh ${lane}; vẫn xem được qua \`lanes_list\`.`;
export const laneCameText = (lane: string, from: number | null): string =>
  `PO chuyển lane ${lane} từ phiên #${from ?? '?'} sang phiên này. Gọi \`lane_tail\` ${lane} để nắm tình hình.`;

/** §4.14 typed title (trimmed, ≤ 24) wins; empty → the first 24 chars of the first message; neither → none. */
export function sessionTitle(title: string | undefined | null, first: string | undefined | null): string | null {
  const t = title?.trim();
  if (t) return t.slice(0, TITLE_MAX);
  const f = first?.trim();
  return f ? f.slice(0, TITLE_MAX) : null;
}

/** §4.14 migration rule: live lanes whose owner has ended (or that have none) go to `sessionId`. Returns their names. */
export function adoptOrphans(db: Db, projectId: string, sessionId: string): string[] {
  return db.query<{ name: string }, [string, string]>(
    `UPDATE lane SET owner_session = ?2 WHERE project_id = ?1 AND state <> 'done' AND (owner_session IS NULL OR owner_session IN
       (SELECT id FROM session WHERE ended_at IS NOT NULL)) RETURNING name`,
  ).all(projectId, sessionId).map((r) => r.name).sort();
}

/** Every live lane of `from` → `to` (end / replace). Returns their names. */
export function moveLanes(db: Db, from: string, to: string): string[] {
  return db.query<{ name: string }, [string, string]>(
    "UPDATE lane SET owner_session = ?2 WHERE owner_session = ?1 AND state <> 'done' RETURNING name",
  ).all(from, to).map((r) => r.name).sort();
}

/** §4.14 the lanes a session handed over when it ended / was replaced (read back by "Từ lúc dừng"). */
export function recordHandover(db: Db, from: string, to: string, lanes: readonly string[]): void {
  if (lanes.length) insertEvent(db, { sessionId: from, type: 'handover', json: { to, lanes } });
}

/** §4.14 "Từ lúc dừng": each lane the session handed over, now done or owned by another session (its #n). */
export function sinceStop(db: Db, sessionId: string): SinceStopLane[] {
  const pid = db.query<{ p: string }, [string]>('SELECT project_id AS p FROM session WHERE id = ?').get(sessionId)?.p;
  if (!pid) return [];
  const names = new Set<string>();
  for (const r of db.query<{ json: string }, [string]>("SELECT json FROM event WHERE session_id = ? AND type = 'handover' ORDER BY id").all(sessionId)) {
    for (const n of (JSON.parse(r.json) as { lanes?: string[] }).lanes ?? []) names.add(n);
  }
  const out: SinceStopLane[] = [];
  for (const name of [...names].sort()) {
    const l = db.query<{ state: string; done_at: number | null; owner: string | null; seq: number | null }, [string, string]>(
      'SELECT l.state, l.done_at * 1000 AS done_at, l.owner_session AS owner, s.seq FROM lane l LEFT JOIN session s ON s.id = l.owner_session WHERE l.project_id = ? AND l.name = ?',
    ).get(pid, name);
    if (!l) continue;
    if (l.state === 'done') out.push({ name, kind: 'done', seq: l.seq, at: l.done_at });
    else if (l.owner !== sessionId) out.push({ name, kind: 'moved', seq: l.seq, at: null });
  }
  return out;
}

/** "D7 xong" / "D9 → #3" (engine message to the model). */
export const sinceStopText = (l: SinceStopLane): string => (l.kind === 'done' ? `${l.name} xong` : `${l.name} → #${l.seq ?? '?'}`);

/** §4.12 "Đổi tên…": trimmed, ≤ 24, empty = none. */
export function renameSession(db: Db, sessionId: string, title: string): string | null {
  const t = title.trim();
  if (t.length > TITLE_MAX) throw new SessionError('bad_input', { key: 'errors.titleTooLong', params: { max: TITLE_MAX } });
  const r = db.query("UPDATE session SET title = ? WHERE id = ? AND kind = 'orchestrator'").run(t || null, sessionId);
  if (r.changes === 0) throw new SessionError('no_session', { key: 'errors.noSession', params: { id: sessionId } });
  return t || null;
}

/** §4.14 "Phiên mới từ 50 dòng cuối": that many of the engine's stored lines become the new session's context. */
export const TAIL_LINES = 50;
export function tailFirstText(seq: number | null, lines: readonly { kind: string; text: string }[]): string {
  const body = lines.map((l) => `${l.kind}: ${l.text.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n');
  return `Phiên điều phối mới, tiếp nối phiên #${seq ?? '?'} (không chạy tiếp được). ${lines.length} dòng cuối của #${seq ?? '?'}:\n${body}\nGọi \`lanes_list\` rồi tiếp tục.`;
}
