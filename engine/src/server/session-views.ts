// v2.1 §4.14 session views: `sessions_list` rows, history boundary lines, the "#n" of a card's source session.
import { t, type Lang } from '../../../shared/i18n/index.ts';
import type { KeyedReason, SessionRowView, SessionsList, Target } from '../../../shared/protocol.ts';
import { sessionCost, sessionTokens, type Db } from '../db.ts';
import { MAX_SESSIONS } from '../../../shared/issues.ts';
import { sessionModelView, type ModelNow } from '../session/model-control.ts';
import type { Boundary, OrchestratorView as RtView } from '../orchestrator/session.ts';
import type { NewLine } from './lines.ts';
import { msOf } from './views.ts';
import { sessionWf } from '../workflow/runtime.ts';

/** v2.9 §4.7 a session row's effective config (absent when the rev is gone). */
const wfOf = (db: Db, id: string) => { const wf = sessionWf(db, id); return wf ? { wf } : {}; };

const pad = (x: number) => String(x).padStart(2, '0');
/** "15/11 15:20" in the Mac's local time (the vi fallback text of a resume line). */
const dayHm = (ms: number) => { const d = new Date(ms); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** A boundary as a console line (kind 'engine'; `text` = vi fallback, the web renders `boundary` via the catalog). */
export function boundaryLine(b: Boundary): NewLine {
  const n = b.seq ?? '?', when = dayHm(b.at * 1000);
  const text = b.type === 'start' ? t('vi', 'console.boundaryStart', { n, account: b.account ?? '—' })
    : b.type === 'resume' ? (b.mode === 'replace' ? t('vi', 'console.boundaryResumeReplace', { when, account: b.account ?? '—', m: b.replaced ?? '?' })
      : t('vi', 'console.boundaryResume', { when, account: b.account ?? '—' }))
    : t('vi', b.handoff ? 'console.boundaryEndHandoff' : 'console.boundaryEnd', { n });
  return {
    kind: 'engine', text,
    boundary: {
      type: b.type, seq: b.seq, at: b.at * 1000, // §5.3 Boundary.at is seconds; the protocol carries ms
      ...(b.account !== undefined ? { account: b.account } : {}), ...(b.handoff !== undefined ? { handoff: b.handoff } : {}),
      ...(b.endReason ? { endReason: b.endReason } : {}),
      ...(b.mode ? { mode: b.mode, replaced: b.replaced ?? null } : {}),
    },
  };
}

/** v2.4 §4.3 "Đổi model: A → B", "Đổi effort: x → y" or both in one line; nothing changed → null. */
export function modelChangeLine(from: ModelNow, to: ModelNow, lang: Lang): NewLine | null {
  const d = (v: string | null) => v ?? '—';
  const m = from.modelName !== to.modelName, ef = from.effort !== to.effort;
  if (!m && !ef) return null;
  const text = m && ef ? t(lang, 'console.modelEffortChanged', { from: d(from.modelName), to: d(to.modelName), efrom: d(from.effort), eto: d(to.effort) })
    : m ? t(lang, 'console.modelChanged', { from: d(from.modelName), to: d(to.modelName) })
      : t(lang, 'console.effortChanged', { from: d(from.effort), to: d(to.effort) });
  return { kind: 'engine', text };
}

const MODEL_LINE_MERGE_MS = 2_000;

/**
 * v2.4 §4.3 changes of one session within 2 s of the first become one line (first `from` → last `to`); R14 the line is
 * written early (`flush`) when any other line is about to be appended to that session, so it precedes the new model's lines.
 */
export class ModelLines {
  private readonly open = new Map<string, { from: ModelNow; to: ModelNow; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly write: (sessionId: string, line: NewLine) => void, private readonly lang: () => Lang, private readonly ms = MODEL_LINE_MERGE_MS) {}

  change(sessionId: string, from: ModelNow, to: ModelNow): void {
    const o = this.open.get(sessionId);
    if (o) { o.to = to; return; }
    const timer = setTimeout(() => this.flush(sessionId), this.ms);
    timer.unref();
    this.open.set(sessionId, { from, to, timer });
  }

  /** Write the session's open line now (nothing open → no-op). */
  flush(sessionId: string): void {
    const x = this.open.get(sessionId);
    if (!x) return;
    this.open.delete(sessionId);
    clearTimeout(x.timer);
    const line = modelChangeLine(x.from, x.to, this.lang());
    if (line) this.write(sessionId, line);
  }
}

/** §4.14 a card's "#n": the source orchestrator session's seq, or the seq of the source lane's owner session. */
export function cardSeq(db: Db, sessionId: string): number | null {
  const r = db.query<{ kind: string; seq: number | null }, [string]>('SELECT kind, seq FROM session WHERE id = ?').get(sessionId);
  if (!r) return null;
  if (r.kind === 'orchestrator') return r.seq;
  return db.query<{ seq: number | null }, [string]>(
    'SELECT s.seq AS seq FROM lane l JOIN session s ON s.id = l.owner_session WHERE l.session_id = ?').get(sessionId)?.seq ?? null;
}

interface Row {
  id: string; project_id: string; seq: number | null; title: string | null; state: string; account: string | null;
  created_at: number; ended_at: number | null; end_reason: SessionRowView['endReason']; handoff_path: string | null; ctx_last: number | null;
}

/** The account a session started on: its start boundary line (written at creation). */
function firstAccount(db: Db, sessionId: string): string | null {
  const r = db.query<{ a: string | null }, [string]>(
    "SELECT json_extract(json, '$.boundary.account') AS a FROM event WHERE session_id = ? AND type = 'line' AND json_extract(json, '$.boundary.type') = 'start' ORDER BY id LIMIT 1",
  ).get(sessionId);
  return r?.a ?? null;
}

export type Resumability = (sessionId: string) => { reason: KeyedReason | null; expiresInDays: number | null };

/**
 * §4.14 "Lịch sử phiên": running sessions (in `live`, open order, live state) then ended ones (newest first). Lanes =
 * lanes it owns now (running) or handed over / still holds as done lanes (ended).
 */
export function listSessions(db: Db, projectId: string, live: ReadonlyMap<string, RtView>, resumability?: Resumability, cleanupPeriodDays?: number): SessionsList {
  const rows = db.query<Row, [string]>(
    "SELECT * FROM session WHERE project_id = ? AND kind = 'orchestrator' ORDER BY created_at DESC, rowid DESC").all(projectId);
  const view = (r: Row): SessionRowView => {
    const v = live.get(r.id);
    const lanes = db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM lane WHERE owner_session = ?').get(r.id)!.n;
    return {
      sessionId: r.id, projectId: r.project_id, seq: r.seq, title: r.title,
      state: v ? (v.state === 'done' ? 'stopped' : v.state) : 'ended',
      startedAt: r.created_at * 1000, endedAt: msOf(r.ended_at),
      accountFirst: firstAccount(db, r.id) ?? r.account, accountLast: v?.account ?? r.account,
      lanes, tokens: v?.tokens ?? sessionTokens(db, [r.id]), costUsd: sessionCost(db, r.id),
      endReason: r.end_reason ?? null, handoffPath: r.handoff_path, ctxLast: r.ctx_last, resumable: null, ...sessionModelView(db, r.id), ...wfOf(db, r.id),
    };
  };
  /** §4.14 ended rows: "chạy tiếp được" / "chỉ xem · hết hạn" + "hết hạn sau n ngày" (≤ 5). */
  const ended_ = (r: Row): SessionRowView => {
    const v = view(r);
    if (!resumability) return v;
    const x = resumability(r.id);
    return { ...v, resumable: x.reason === null, reason: x.reason, expiresInDays: x.expiresInDays };
  };
  const running = [...live.keys()].map((id) => rows.find((r) => r.id === id)).filter((r): r is Row => r !== undefined).map(view);
  const ended = rows.filter((r) => !live.has(r.id) && r.ended_at !== null).map(ended_);
  return { running, ended, max: MAX_SESSIONS, ...(cleanupPeriodDays !== undefined ? { cleanupPeriodDays } : {}) };
}

/**
 * §4.15 §4 R10 per node: a card's target names its session — an orchestrator card is "being viewed" only while that very
 * root is watched (watching root #3 never suppresses #4's card); a lane card only while that lane is watched.
 */
export function sessionTarget(sid: string | null, lane: (sid: string) => { projectId: string; name: string } | null,
  orch: (sid: string) => { projectId: string } | null): Target | null {
  if (!sid) return null;
  const l = lane(sid);
  if (l) return { kind: 'lane', projectId: l.projectId, name: l.name };
  const o = orch(sid);
  return o ? { kind: 'orchestrator', projectId: o.projectId, sessionId: sid } : null;
}

/** §4.15 §4 "#n" of a notification: only when the project has > 1 running session; lane → its owner's #n. */
export function notifySeq(db: Db, t: Target, running: number): number | null {
  if (running <= 1) return null;
  if (t.kind === 'lane') {
    return db.query<{ seq: number | null }, [string, string]>(
      'SELECT s.seq FROM lane l JOIN session s ON s.id = l.owner_session WHERE l.project_id = ? AND l.name = ?').get(t.projectId, t.name)?.seq ?? null;
  }
  if (!t.sessionId) return null;
  return db.query<{ seq: number | null }, [string]>('SELECT seq FROM session WHERE id = ?').get(t.sessionId)?.seq ?? null;
}
