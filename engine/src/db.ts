// state.db (spec §7.8): bun:sqlite, WAL, forward-only migrations keyed by PRAGMA user_version.
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SendAttachment } from './attach/store.ts';
import { FILE_MODE, ensureDir } from './paths.ts';
import { MIGRATION_V23 } from './issues/schema.ts';
import { MIGRATION_V25 } from './workflow/schema.ts';
import { MIGRATION_V26 } from './graph/schema.ts';
import { ZERO_TOKENS, type KeyedReason, type LaneBranch, type TokenCounts } from '../../shared/protocol.ts';

export type Db = Database;

/** §7.4 lane states. Only `done` (Xong) is terminal and frees the worktree; stopped/broken can still be resumed. */
export type LaneState =
  | 'starting' | 'running' | 'idle' | 'waiting_po' | 'switching' | 'waiting_quota' | 'draining'
  | 'stopped' | 'broken' | 'done'
  /** hotfix 2026-11-16: held after an app restart (in memory only — never written; the row keeps its real state). */
  | 'paused';

/** Each entry is one schema step; index i brings user_version from i to i+1. Never edit a shipped step. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE project (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    permission_mode TEXT NOT NULL DEFAULT 'default',
    orchestrator_account TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id),
    kind TEXT NOT NULL CHECK (kind IN ('orchestrator','lane')),
    account TEXT,
    state TEXT NOT NULL DEFAULT 'starting',
    pid INTEGER,
    prompt_version INTEGER,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE lane (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id),
    name TEXT NOT NULL,
    session_id TEXT REFERENCES session(id),
    cwd TEXT NOT NULL,
    brief_path TEXT,
    agent TEXT,
    model TEXT,
    effort TEXT,
    phase TEXT,
    task TEXT,
    note TEXT,
    state TEXT NOT NULL,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  CREATE UNIQUE INDEX lane_live_cwd ON lane(cwd) WHERE state <> 'done';
  CREATE TABLE run (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    lane_id INTEGER REFERENCES lane(id),
    n INTEGER NOT NULL,
    account TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT,
    UNIQUE (session_id, n)
  );
  CREATE TABLE event (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX event_session_ts ON event(session_id, ts);
  CREATE TABLE card (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ask','permission')),
    request_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled')),
    answer TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX card_open ON card(session_id) WHERE status = 'open';
  CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    prefix TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX outbox_pending ON outbox(session_id, seq) WHERE delivered_at IS NULL;
  CREATE TABLE quota (
    account TEXT PRIMARY KEY,
    five_pct REAL,
    week_pct REAL,
    five_resets_at INTEGER,
    week_resets_at INTEGER,
    source TEXT NOT NULL CHECK (source IN ('api','stream','probe')),
    fetched_at INTEGER NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE device (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cookie_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER,
    revoked_at INTEGER
  );
  `,
  // v2 (§6.4/§6.15/§6.7/§6.11/§6.16/§6.17): system card kinds, `expired`, cards without a session (account / project
  // level), AUTOINCREMENT so a card number (#12) is never reused. SQLite cannot alter a CHECK → rebuild the table.
  `
  CREATE TABLE card_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('ask','permission','broken','orchestrator_down','logged_out','cc_updated')),
    request_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled','expired')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  INSERT INTO card_v2 (id, project_id, session_id, kind, request_id, payload, status, answer, created_at)
    SELECT c.id, (SELECT s.project_id FROM session s WHERE s.id = c.session_id), c.session_id, c.kind, c.request_id,
      c.payload, c.status, c.answer, c.created_at FROM card c;
  DROP TABLE card;
  ALTER TABLE card_v2 RENAME TO card;
  CREATE INDEX card_open ON card(session_id) WHERE status = 'open';
  `,
  // v3 (§6.17 F17): small engine facts that outlive a run, e.g. the last claude version that passed the check.
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v4 (§8.3 N6 per-project Google Chat; §8.4 stream lines paged from the event table).
  `
  ALTER TABLE project ADD COLUMN gchat_webhook TEXT;
  ALTER TABLE project ADD COLUMN gchat_send_command_text INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX event_session_type ON event(session_id, type, id);
  `,
  // v5 (§7.2): single-use nonces of app-signed commands (bypassPermissions); pruned once older than the ts window.
  `
  CREATE TABLE app_nonce (
    nonce TEXT PRIMARY KEY,
    ts INTEGER NOT NULL
  );
  `,
  // v6 (v2 spec §7, §7.1, D25): the account registry, keyed by normalised email. A row with caps but no `dir` is a v1
  // account imported from caps.json that has not logged in yet. NULL caps/role = inherit the generic default.
  `
  CREATE TABLE account (
    email TEXT PRIMARY KEY,
    id TEXT UNIQUE,
    dir TEXT,
    account_uuid TEXT,
    org_uuid TEXT,
    plan TEXT,
    tier TEXT,
    role TEXT CHECK (role IN ('primary','backup','orchestrator')),
    week REAL,
    five REAL,
    hard INTEGER,
    lanes_max INTEGER,
    paused INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_auth_check INTEGER
  );
  `,
  // v7 (v2 §5.5 A9 / §5.2): shared-config system cards. SQLite cannot alter a CHECK → rebuild the table (ids kept).
  `
  CREATE TABLE card_v7 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('ask','permission','broken','orchestrator_down','logged_out','cc_updated','shared_cfg','shared_cfg_new')),
    request_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled','expired')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  INSERT INTO card_v7 SELECT id, project_id, session_id, kind, request_id, payload, status, answer, created_at, resolved_at FROM card;
  DELETE FROM sqlite_sequence WHERE name = 'card_v7';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'card_v7', seq FROM sqlite_sequence WHERE name = 'card';
  DROP TABLE card;
  ALTER TABLE card_v7 RENAME TO card;
  CREATE INDEX card_open ON card(session_id) WHERE status = 'open';
  `,
  // v8 (v2 §6 IMPORTANT-2): the "Account mồ côi" system card. Same rebuild as v7 (ids + AUTOINCREMENT kept).
  `
  CREATE TABLE card_v8 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('ask','permission','broken','orchestrator_down','logged_out','cc_updated','shared_cfg','shared_cfg_new','account_orphan')),
    request_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled','expired')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  INSERT INTO card_v8 SELECT id, project_id, session_id, kind, request_id, payload, status, answer, created_at, resolved_at FROM card;
  DELETE FROM sqlite_sequence WHERE name = 'card_v8';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'card_v8', seq FROM sqlite_sequence WHERE name = 'card';
  DROP TABLE card;
  ALTER TABLE card_v8 RENAME TO card;
  CREATE INDEX card_open ON card(session_id) WHERE status = 'open';
  `,
  // v9 (v2 §7 D18/D24): every session skips permissions, so the per-project mode and the signed-bypass nonces go.
  // DROP COLUMN needs no rebuild: permission_mode has no index, key, FK or CHECK.
  `
  ALTER TABLE project DROP COLUMN permission_mode;
  DROP TABLE app_nonce;
  `,
  // v10 (v2 §6A G5-fix): the catalog key of an engine-composed `last_error` (JSON KeyedReason), so a restart keeps it.
  `
  ALTER TABLE lane ADD COLUMN last_error_key TEXT;
  `,
  // v11 (v2 §7.1-3 I3c): the cutover system card. Same rebuild as v7 / v8 (ids + AUTOINCREMENT kept).
  `
  CREATE TABLE card_v11 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('ask','permission','broken','orchestrator_down','logged_out','cc_updated','shared_cfg','shared_cfg_new','account_orphan','cutover')),
    request_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled','expired')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  INSERT INTO card_v11 SELECT id, project_id, session_id, kind, request_id, payload, status, answer, created_at, resolved_at FROM card;
  DELETE FROM sqlite_sequence WHERE name = 'card_v11';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'card_v11', seq FROM sqlite_sequence WHERE name = 'card';
  DROP TABLE card;
  ALTER TABLE card_v11 RENAME TO card;
  CREATE INDEX card_open ON card(session_id) WHERE status = 'open';
  `,
  // v12 (v2.1 §4.15): the lane's own branch ('' = none, NULL = not resolved yet), its last measurement (JSON LaneBranch)
  // and when it entered done (newest-first done list). Lanes done before v12 sort by created_at.
  `
  ALTER TABLE lane ADD COLUMN branch TEXT;
  ALTER TABLE lane ADD COLUMN branch_json TEXT;
  ALTER TABLE lane ADD COLUMN done_at INTEGER;
  `,
  // v13 (v2.1 §4.14): parallel orchestrator sessions. `seq` = #n per project (never reused), optional `title`, how it
  // ended, its handoff file, last context tokens; a lane belongs to one running session (`owner_session`). Backfill: seq by
  // creation order; a lane goes to the newest unended orchestrator session of its project, else the newest one (the
  // first session opened afterwards adopts it, orchestrator/owners.ts adoptOrphans).
  `
  ALTER TABLE session ADD COLUMN seq INTEGER;
  ALTER TABLE session ADD COLUMN title TEXT;
  ALTER TABLE session ADD COLUMN end_reason TEXT;
  ALTER TABLE session ADD COLUMN handoff_path TEXT;
  ALTER TABLE session ADD COLUMN ctx_last INTEGER;
  ALTER TABLE lane ADD COLUMN owner_session TEXT REFERENCES session(id);
  UPDATE session SET seq = (
    SELECT COUNT(*) FROM session s2 WHERE s2.project_id = session.project_id AND s2.kind = 'orchestrator'
      AND (s2.created_at < session.created_at OR (s2.created_at = session.created_at AND s2.rowid <= session.rowid))
  ) WHERE kind = 'orchestrator';
  UPDATE lane SET owner_session = COALESCE(
    (SELECT id FROM session s WHERE s.project_id = lane.project_id AND s.kind = 'orchestrator' AND s.ended_at IS NULL
      ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1),
    (SELECT id FROM session s WHERE s.project_id = lane.project_id AND s.kind = 'orchestrator'
      ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1));
  `,
  // v14 (v2.1 §5.3): today / 5 h token + cost sums filter `event` by type and time; without this they scan the table.
  `
  CREATE INDEX event_type_ts ON event(type, ts);
  `,
  // v15 (v2.1 §4.14): a session's own home account (a parallel / resumed session may not be on the project's), so an
  // engine restart keeps each session on its account.
  `
  ALTER TABLE session ADD COLUMN account_home TEXT;
  `,
  // v16 (v2.1 §4.14 "gốc xếp cuối"): when the session was last opened (insert, resume), epoch ms; a restart restores
  // running sessions in this order. Older rows: their creation time.
  `
  ALTER TABLE session ADD COLUMN opened_at INTEGER;
  UPDATE session SET opened_at = created_at * 1000;
  `,
  // v17 (v2.1 §5.3 one time unit): `line` rows were written in epoch seconds, every other event row in ms.
  `
  UPDATE event SET ts = ts * 1000 WHERE type = 'line' AND ts < 100000000000;
  `,
  // v18 (v2.2 §6 K13): the MCP login system card. Same rebuild as v11 (ids + AUTOINCREMENT kept).
  `
  CREATE TABLE card_v18 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('ask','permission','broken','orchestrator_down','logged_out','cc_updated','shared_cfg','shared_cfg_new','account_orphan','cutover','mcp_login')),
    request_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled','expired')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  INSERT INTO card_v18 SELECT id, project_id, session_id, kind, request_id, payload, status, answer, created_at, resolved_at FROM card;
  DELETE FROM sqlite_sequence WHERE name = 'card_v18';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'card_v18', seq FROM sqlite_sequence WHERE name = 'card';
  DROP TABLE card;
  ALTER TABLE card_v18 RENAME TO card;
  CREATE INDEX card_open ON card(session_id) WHERE status = 'open';
  `,
  // v19 (v2.4 §5.1): the PO's model / effort picks of an orchestrator session (NULL = "Theo mặc định" / not set) and the
  // real values last read from Claude Code (MD11, MD12 show them when the session has no process).
  `
  ALTER TABLE session ADD COLUMN model_pick TEXT;
  ALTER TABLE session ADD COLUMN effort_pick TEXT;
  ALTER TABLE session ADD COLUMN last_model TEXT;
  ALTER TABLE session ADD COLUMN last_model_name TEXT;
  ALTER TABLE session ADD COLUMN last_effort TEXT;
  `,
  // v20 (v2.4 §10.2): a message's attachments (JSON metadata only, never bytes, A5) and whether its `po` line was written
  // at send time (`echoed`: its replay makes no second line).
  `
  ALTER TABLE outbox ADD COLUMN attachments TEXT;
  ALTER TABLE outbox ADD COLUMN echoed INTEGER NOT NULL DEFAULT 0;
  `,
  // v21 (hotfix 2026-11-16 "Đóng project"): a closed project leaves the UI, the catalog and recovery; its sessions are kept
  // (unfinished) so re-adding its folder reopens it held.
  `
  ALTER TABLE project ADD COLUMN closed_at INTEGER;
  `,
  // v22 (hotfix 2026-11-16 terminal account): 1 = the row is the terminal's own login (`~/.claude`, default Keychain item);
  // sessions on it run with CLAUDE_CONFIG_DIR unset and cc-slaves never signs it out nor deletes its files.
  `
  ALTER TABLE account ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0;
  `,
  // v23 (v2.7 §5.1, R-B1): specs, issues, `session.orch_kind`, the three v2.7 card kinds. SQL in issues/schema.ts.
  MIGRATION_V23,
  // v24 (v2.7.1 D103): 1 = the last ok usage response had a `five_hour` window (Max), 0 = it had `seven_day` only (Ultra),
  // NULL = not known yet. Only the usage API writes it.
  `
  ALTER TABLE quota ADD COLUMN five_window INTEGER;
  `,
  // v25 (v2.9 §6.1, §10.1): workflow packs — project workflow, pinned revs, steps, prompt hash. SQL in workflow/schema.ts.
  MIGRATION_V25,
  MIGRATION_V26, // v26 (v2.5 R1, §5.5): the graph index book. SQL in graph/schema.ts.
  // v27 (hf-sp): the plugin whose absence gave a new project Giao thẳng instead of the default pack (the Tasks hint);
  // NULL = not so, or a pack applied since.
  `
  ALTER TABLE project ADD COLUMN workflow_fallback TEXT;
  `,
];

const nowS = () => Math.floor(Date.now() / 1000);

function tighten(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(p)) chmodSync(p, FILE_MODE);
}

export function migrate(db: Db): void {
  const cur = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  if (cur > MIGRATIONS.length) throw new Error(`state.db schema v${cur} is newer than this engine (v${MIGRATIONS.length})`);
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export function openDb(path: string): Db {
  if (path !== ':memory:') ensureDir(dirname(path));
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  if (path !== ':memory:') tighten(path);
  return db;
}

// ---------- meta (key → value) ----------
export function getMeta(db: Db, key: string): string | null {
  return db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}
export function setMeta(db: Db, key: string, value: string): void {
  db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------- project (minimal, needed as FK parent) ----------
export function insertProject(db: Db, p: { id: string; name: string; path: string; orchestratorAccount?: string | null; workflow?: { id: string; fallback: string | null } }): void {
  db.query('INSERT INTO project (id, name, path, orchestrator_account, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(p.id, p.name, p.path, p.orchestratorAccount ?? null, nowS());
  if (p.workflow) db.query('UPDATE project SET workflow = ?, workflow_fallback = ? WHERE id = ?').run(p.workflow.id, p.workflow.fallback, p.id);
}

// ---------- lane ----------
export interface Lane {
  id: number;
  projectId: string;
  name: string;
  sessionId: string | null;
  cwd: string;
  briefPath: string | null;
  agent: string | null;
  model: string | null;
  effort: string | null;
  phase: string | null;
  task: string | null;
  note: string | null;
  state: LaneState;
  failCount: number;
  lastError: string | null;
  /** §6A catalog key of `lastError` (engine-composed reasons only). */
  lastErrorKeyed?: KeyedReason | null;
  costUsd: number;
  createdAt: number;
  /** v2.1 §4.14 the running orchestrator session that owns the lane (null = none yet). */
  ownerSession?: string | null;
}

interface LaneRow {
  id: number; project_id: string; name: string; session_id: string | null; cwd: string; brief_path: string | null;
  agent: string | null; model: string | null; effort: string | null; phase: string | null; task: string | null;
  note: string | null; state: LaneState; fail_count: number; last_error: string | null; last_error_key: string | null; cost_usd: number; created_at: number;
  owner_session?: string | null;
}

function parseReason(s: string | null): KeyedReason | null {
  if (!s) return null;
  try { const v = JSON.parse(s) as KeyedReason; return v && typeof v.key === 'string' ? v : null; } catch { return null; }
}

const toLane = (r: LaneRow): Lane => ({
  id: r.id, projectId: r.project_id, name: r.name, sessionId: r.session_id, cwd: r.cwd, briefPath: r.brief_path,
  agent: r.agent, model: r.model, effort: r.effort, phase: r.phase, task: r.task, note: r.note, state: r.state,
  failCount: r.fail_count, lastError: r.last_error, lastErrorKeyed: parseReason(r.last_error_key), costUsd: r.cost_usd, createdAt: r.created_at,
  ownerSession: r.owner_session ?? null,
});

export interface NewLane {
  projectId: string; name: string; cwd: string; sessionId?: string | null; briefPath?: string | null;
  agent?: string | null; model?: string | null; effort?: string | null; task?: string | null; state?: LaneState;
  ownerSession?: string | null;
}

export class LaneConflictError extends Error {}

/** §7.4: one live lane per worktree (`cwd`) across all projects; lane name unique per project. */
export function insertLane(db: Db, l: NewLane): Lane {
  return db.transaction(() => {
    const live = db.query<{ name: string; project_id: string }, [string]>(
      "SELECT name, project_id FROM lane WHERE cwd = ? AND state <> 'done'",
    ).get(l.cwd);
    if (live) throw new LaneConflictError(`cwd already used by live lane ${live.project_id}/${live.name}: ${l.cwd}`);
    const dup = db.query<{ id: number }, [string, string]>('SELECT id FROM lane WHERE project_id = ? AND name = ?')
      .get(l.projectId, l.name);
    if (dup) throw new LaneConflictError(`lane name already exists in project: ${l.name}`);
    const row = db.query<LaneRow, [string, string, string | null, string, string | null, string | null, string | null, string | null, string | null, string, number, string | null]>(
      `INSERT INTO lane (project_id, name, session_id, cwd, brief_path, agent, model, effort, task, state, created_at, owner_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(l.projectId, l.name, l.sessionId ?? null, l.cwd, l.briefPath ?? null, l.agent ?? null, l.model ?? null,
      l.effort ?? null, l.task ?? null, l.state ?? 'starting', nowS(), l.ownerSession ?? null);
    return toLane(row!);
  })();
}

export function getLane(db: Db, projectId: string, name: string): Lane | null {
  const r = db.query<LaneRow, [string, string]>('SELECT * FROM lane WHERE project_id = ? AND name = ?').get(projectId, name);
  return r ? toLane(r) : null;
}

export function getLaneById(db: Db, id: number): Lane | null {
  const r = db.query<LaneRow, [number]>('SELECT * FROM lane WHERE id = ?').get(id);
  return r ? toLane(r) : null;
}

/** `lastErrorKeyed` is written with `lastError` (absent → null): a new text never keeps an older text's key. */
export function updateLaneState(db: Db, id: number, state: LaneState, extra: { failCount?: number; lastError?: string | null; lastErrorKeyed?: KeyedReason | null } = {}): void {
  const setErr = 'lastError' in extra ? 1 : 0;
  const keyJson = extra.lastErrorKeyed ? JSON.stringify(extra.lastErrorKeyed) : null;
  const res = db.query(
    `UPDATE lane SET state = ?,
       fail_count = COALESCE(?, fail_count),
       last_error = CASE WHEN ? THEN ? ELSE last_error END,
       last_error_key = CASE WHEN ? THEN ? ELSE last_error_key END,
       done_at = CASE WHEN ? = 'done' AND done_at IS NULL THEN ? ELSE done_at END
     WHERE id = ?`,
  ).run(state, extra.failCount ?? null, setErr, extra.lastError ?? null, setErr, keyJson, state, nowS(), id);
  if (res.changes === 0) throw new Error(`no lane with id ${id}`);
}

// ---------- lane branch (v2.1 §4.15) ----------
/** `name`: undefined = not resolved yet, null = no own branch. `info` = the last measurement. */
export function getLaneBranch(db: Db, id: number): { name: string | null | undefined; info: LaneBranch | null } {
  const r = db.query<{ branch: string | null; branch_json: string | null }, [number]>('SELECT branch, branch_json FROM lane WHERE id = ?').get(id);
  let info: LaneBranch | null = null;
  try { info = r?.branch_json ? JSON.parse(r.branch_json) as LaneBranch : null; } catch { info = null; }
  return { name: r?.branch === null || r?.branch === undefined ? undefined : r.branch === '' ? null : r.branch, info };
}

export function setLaneBranch(db: Db, id: number, f: { name?: string | null; info?: LaneBranch }): void {
  if ('name' in f) db.query('UPDATE lane SET branch = ? WHERE id = ?').run(f.name ?? '', id);
  if (f.info) db.query('UPDATE lane SET branch_json = ? WHERE id = ?').run(JSON.stringify({ ...f.info, measuring: undefined }), id);
}

/** §4.15 "n chưa merge": lanes in done (not merely reported done) whose last measurement is `unmerged`. */
export function countUnmergedDone(db: Db, projectId: string): number {
  return db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM lane WHERE project_id = ? AND state = 'done' AND json_extract(branch_json, '$.state') = 'unmerged'",
  ).get(projectId)!.n;
}

/** Lanes whose branch is worth re-measuring when the base moves: reported done or done, measured once, not `none`. */
export function trackedBranchLanes(db: Db): Lane[] {
  return db.query<LaneRow, []>(
    `SELECT * FROM lane WHERE (state = 'done' OR phase = 'done') AND branch_json IS NOT NULL
       AND json_extract(branch_json, '$.state') <> 'none' ORDER BY id`,
  ).all().map(toLane);
}

export interface DoneLanesQuery { projectId: string; query?: string; unmerged?: boolean; session?: string; before?: string; limit?: number }
export interface DoneLanesPage { rows: Lane[]; total: number; unmerged: number; unknown: number; next: string | null }

/**
 * §4.15 N6-e done list, newest first (`done_at`, else `created_at`; ties by id). `query` matches name / task / branch
 * (case-insensitive substring); `unmerged` = the "Chưa merge" chip (unmerged + unknown rows, N6-k); `session` = owned by
 * that orchestrator session (§4.14). `before` = the `next`
 * cursor of the previous page. `total` / `unmerged` / `unknown` count every done lane of the project (no filter).
 */
export function listDoneLanes(db: Db, q: DoneLanesQuery): DoneLanesPage {
  const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
  const at = 'COALESCE(done_at, created_at)';
  const where = ["project_id = ?", "state = 'done'"];
  const args: (string | number)[] = [q.projectId];
  if (q.query && q.query.trim()) {
    const like = `%${q.query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(lower(name) LIKE ? ESCAPE '\\' OR lower(COALESCE(task, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(branch, '')) LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (q.unmerged) where.push("json_extract(branch_json, '$.state') IN ('unmerged', 'unknown')");
  if (q.session !== undefined) { where.push('owner_session = ?'); args.push(q.session); } // §4.15 lanes of one session (§4.14)
  const cur = /^(\d+):(\d+)$/.exec(q.before ?? '');
  if (cur) { where.push(`(${at} < ? OR (${at} = ? AND id < ?))`); args.push(Number(cur[1]), Number(cur[1]), Number(cur[2])); }
  const rows = db.query<LaneRow & { at: number }, (string | number)[]>(
    `SELECT *, ${at} AS at FROM lane WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`,
  ).all(...args, limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const c = db.query<{ total: number; unmerged: number; unknown: number }, [string]>(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(json_extract(branch_json, '$.state') = 'unmerged'), 0) AS unmerged,
       COALESCE(SUM(json_extract(branch_json, '$.state') = 'unknown'), 0) AS unknown
     FROM lane WHERE project_id = ? AND state = 'done'`,
  ).get(q.projectId)!;
  return { rows: page.map(toLane), ...c, next: more && last ? `${last.at}:${last.id}` : null };
}

// ---------- outbox (§7.6) ----------
export interface OutboxMsg {
  seq: number; uuid: string; sessionId: string; text: string; prefix: string | null; createdAt: number; deliveredAt: number | null;
  /** v2.4 §10.2 metadata of the message's attachments; null = none. */
  attachments: SendAttachment[] | null;
  echoed: boolean;
}
interface OutboxRow {
  seq: number; uuid: string; session_id: string; text: string; prefix: string | null; created_at: number; delivered_at: number | null;
  attachments: string | null; echoed: number;
}
const toMsg = (r: OutboxRow): OutboxMsg => ({
  seq: r.seq, uuid: r.uuid, sessionId: r.session_id, text: r.text, prefix: r.prefix, createdAt: r.created_at, deliveredAt: r.delivered_at,
  attachments: r.attachments === null ? null : (JSON.parse(r.attachments) as SendAttachment[]), echoed: r.echoed === 1,
});

export interface NewOutboxMsg {
  sessionId: string; text: string; prefix?: string | null; uuid?: string; attachments?: readonly SendAttachment[] | null; echoed?: boolean;
}
export function insertOutbox(db: Db, m: NewOutboxMsg): OutboxMsg {
  const atts = m.attachments?.length ? JSON.stringify(m.attachments) : null;
  const row = db.query<OutboxRow, [string, string, string, string | null, number, string | null, number]>(
    'INSERT INTO outbox (uuid, session_id, text, prefix, created_at, attachments, echoed) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
  ).get(m.uuid ?? randomUUID(), m.sessionId, m.text, m.prefix ?? null, nowS(), atts, m.echoed ? 1 : 0);
  return toMsg(row!);
}

/** v2.4 §10.2 every row's attachments (sweep keeps what a row names). */
export function outboxAttachments(db: Db): SendAttachment[] {
  return db.query<{ attachments: string }, []>('SELECT attachments FROM outbox WHERE attachments IS NOT NULL').all()
    .flatMap((r) => JSON.parse(r.attachments) as SendAttachment[]);
}

export function getOutbox(db: Db, uuid: string): OutboxMsg | null {
  const r = db.query<OutboxRow, [string]>('SELECT * FROM outbox WHERE uuid = ?').get(uuid);
  return r ? toMsg(r) : null;
}

export function listUndelivered(db: Db, sessionId: string): OutboxMsg[] {
  return db.query<OutboxRow, [string]>('SELECT * FROM outbox WHERE session_id = ? AND delivered_at IS NULL ORDER BY seq')
    .all(sessionId).map(toMsg);
}

export function markDelivered(db: Db, uuid: string, at: number = nowS()): void {
  db.query('UPDATE outbox SET delivered_at = ? WHERE uuid = ? AND delivered_at IS NULL').run(at, uuid);
}

// ---------- quota (§3.4 I2) ----------
export interface QuotaRow {
  account: string; fivePct: number | null; weekPct: number | null; fiveResetsAt: number | null; weekResetsAt: number | null;
  source: 'api' | 'stream' | 'probe'; fetchedAt: number; status: string;
  /** D103 has a 5-hour window (null = unknown); a write that leaves it out keeps the stored value. */
  fiveWindow?: boolean | null;
}
interface QuotaDbRow {
  account: string; five_pct: number | null; week_pct: number | null; five_resets_at: number | null; week_resets_at: number | null;
  source: QuotaRow['source']; fetched_at: number; status: string; five_window: number | null;
}

export function upsertQuota(db: Db, q: QuotaRow): void {
  db.query(
    `INSERT INTO quota (account, five_pct, week_pct, five_resets_at, week_resets_at, source, fetched_at, status, five_window)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account) DO UPDATE SET five_pct = excluded.five_pct, week_pct = excluded.week_pct,
       five_resets_at = excluded.five_resets_at, week_resets_at = excluded.week_resets_at, source = excluded.source,
       fetched_at = excluded.fetched_at, status = excluded.status, five_window = COALESCE(excluded.five_window, quota.five_window)`,
  ).run(q.account, q.fivePct, q.weekPct, q.fiveResetsAt, q.weekResetsAt, q.source, q.fetchedAt, q.status,
    q.fiveWindow === undefined || q.fiveWindow === null ? null : Number(q.fiveWindow));
}

export function getQuota(db: Db, account: string): QuotaRow | null {
  const r = db.query<QuotaDbRow, [string]>('SELECT * FROM quota WHERE account = ?').get(account);
  return r ? {
    account: r.account, fivePct: r.five_pct, weekPct: r.week_pct, fiveResetsAt: r.five_resets_at,
    weekResetsAt: r.week_resets_at, source: r.source, fetchedAt: r.fetched_at, status: r.status,
    fiveWindow: r.five_window === null ? null : r.five_window === 1,
  } : null;
}

// ---------- session / run / event (lane manager, §7.4, §8.6) ----------
export function insertSession(db: Db, s: { id: string; projectId: string; kind: 'orchestrator' | 'lane'; account: string | null }): void {
  db.query('INSERT INTO session (id, project_id, kind, account, created_at, opened_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(s.id, s.projectId, s.kind, s.account, nowS(), Date.now());
}

export function updateSession(db: Db, id: string, f: { account?: string | null; pid?: number | null; state?: string }): void {
  db.query(
    `UPDATE session SET account = CASE WHEN ? THEN ? ELSE account END, pid = CASE WHEN ? THEN ? ELSE pid END,
       state = COALESCE(?, state) WHERE id = ?`,
  ).run('account' in f ? 1 : 0, f.account ?? null, 'pid' in f ? 1 : 0, f.pid ?? null, f.state ?? null, id);
}

/** v2.4 §5.1 a session's picks and last real model / effort (`session` columns of v19). */
export interface SessionModel {
  modelPick: string | null; effortPick: string | null; lastModel: string | null; lastModelName: string | null; lastEffort: string | null;
}

export function getSessionModel(db: Db, id: string): SessionModel {
  const r = db.query<{ model_pick: string | null; effort_pick: string | null; last_model: string | null; last_model_name: string | null; last_effort: string | null }, [string]>(
    'SELECT model_pick, effort_pick, last_model, last_model_name, last_effort FROM session WHERE id = ?').get(id);
  return { modelPick: r?.model_pick ?? null, effortPick: r?.effort_pick ?? null, lastModel: r?.last_model ?? null,
    lastModelName: r?.last_model_name ?? null, lastEffort: r?.last_effort ?? null };
}

export function setSessionModel(db: Db, id: string, m: SessionModel): void {
  db.query('UPDATE session SET model_pick = ?, effort_pick = ?, last_model = ?, last_model_name = ?, last_effort = ? WHERE id = ?')
    .run(m.modelPick, m.effortPick, m.lastModel, m.lastModelName, m.lastEffort, id);
}

/** Lane fields the manager keeps current besides the state (phase/task/note from `lane_set_phase`, §8.6 cost). */
export function updateLaneFields(db: Db, id: number, f: { phase?: string | null; task?: string | null; note?: string | null; costUsd?: number }): void {
  db.query(
    `UPDATE lane SET phase = CASE WHEN ? THEN ? ELSE phase END, task = CASE WHEN ? THEN ? ELSE task END,
       note = CASE WHEN ? THEN ? ELSE note END, cost_usd = COALESCE(?, cost_usd) WHERE id = ?`,
  ).run('phase' in f ? 1 : 0, f.phase ?? null, 'task' in f ? 1 : 0, f.task ?? null, 'note' in f ? 1 : 0, f.note ?? null,
    f.costUsd ?? null, id);
}


export function insertRun(db: Db, r: { sessionId: string; laneId: number; n: number; account: string }): number {
  const row = db.query<{ id: number }, [string, number, number, string, number]>(
    'INSERT INTO run (session_id, lane_id, n, account, started_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
  ).get(r.sessionId, r.laneId, r.n, r.account, nowS());
  return row!.id;
}

export function endRun(db: Db, id: number, reason: string): void {
  db.query('UPDATE run SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(nowS(), reason, id);
}

export function insertEvent(db: Db, e: { sessionId: string; type: string; json: unknown; ts?: number }): void {
  db.query('INSERT INTO event (session_id, ts, type, json) VALUES (?, ?, ?, ?)')
    .run(e.sessionId, e.ts ?? Date.now(), e.type, JSON.stringify(e.json));
}

/** §8.6 a session's cost: `total_cost_usd` is cumulative per session across resume (S4) → the largest one recorded. */
export function sessionCost(db: Db, sessionId: string): number {
  return db.query<{ c: number | null }, [string]>(
    "SELECT MAX(json_extract(json, '$.totalCostUsd')) AS c FROM event WHERE session_id = ? AND type = 'result'",
  ).get(sessionId)?.c ?? 0;
}

/** §8.6 Σ per-turn cost of every `result` (lanes and orchestrators) recorded at/after `sinceMs` (event.ts is epoch ms). */
export function costSince(db: Db, sinceMs: number, projectId?: string): number {
  if (projectId === undefined) {
    return db.query<{ c: number | null }, [number]>(
      "SELECT SUM(json_extract(json, '$.turnCost')) AS c FROM event WHERE type = 'result' AND ts >= ?",
    ).get(sinceMs)?.c ?? 0;
  }
  return db.query<{ c: number | null }, [number, string]>(
    "SELECT SUM(json_extract(e.json, '$.turnCost')) AS c FROM event e JOIN session s ON s.id = e.session_id " +
    "WHERE e.type = 'result' AND e.ts >= ? AND s.project_id = ?",
  ).get(sinceMs, projectId)?.c ?? 0;
}

// ---------- v2.1 §5.3 tokens: each stored `result` carries `usage` {input, output, cacheWrite, cacheRead}; a turn cut
// short (process died / engine stopped) stores what it reported as a `usage` event (no cost) ----------
const TOKEN_TYPES = "('result', 'usage')";

const TOKEN_SUM = (e: string) =>
  `COALESCE(SUM(json_extract(${e}json, '$.usage.input')), 0) AS input, ` +
  `COALESCE(SUM(json_extract(${e}json, '$.usage.output')), 0) AS output, ` +
  `COALESCE(SUM(json_extract(${e}json, '$.usage.cacheWrite')), 0) AS cacheWrite, ` +
  `COALESCE(SUM(json_extract(${e}json, '$.usage.cacheRead')), 0) AS cacheRead`;
const tokensRow = (r: TokenCounts | null | undefined): TokenCounts =>
  r ? { input: r.input, output: r.output, cacheWrite: r.cacheWrite, cacheRead: r.cacheRead } : { ...ZERO_TOKENS };

/** §5.3 Σ `usage` of every `result` / `usage` event at/after `sinceMs` (epoch ms), optionally of one project only. */
export function tokensSince(db: Db, sinceMs: number, projectId?: string): TokenCounts {
  if (projectId === undefined) {
    return tokensRow(db.query<TokenCounts, [number]>(`SELECT ${TOKEN_SUM('')} FROM event WHERE type IN ${TOKEN_TYPES} AND ts >= ?`).get(sinceMs));
  }
  return tokensRow(db.query<TokenCounts, [number, string]>(
    `SELECT ${TOKEN_SUM('e.')} FROM event e JOIN session s ON s.id = e.session_id WHERE e.type IN ${TOKEN_TYPES} AND e.ts >= ? AND s.project_id = ?`,
  ).get(sinceMs, projectId));
}

/** §5.3 Σ `usage` of every `result` / `usage` event of these sessions. */
export function sessionTokens(db: Db, sessionIds: readonly string[]): TokenCounts {
  if (sessionIds.length === 0) return { ...ZERO_TOKENS };
  const qs = sessionIds.map(() => '?').join(', ');
  return tokensRow(db.query<TokenCounts, string[]>(
    `SELECT ${TOKEN_SUM('')} FROM event WHERE type IN ${TOKEN_TYPES} AND session_id IN (${qs})`,
  ).get(...sessionIds));
}

/** §5.3 W10 a lane's tokens since it was created: every session it ran (its row + its runs), across account switches. */
export function laneTokens(db: Db, laneId: number): TokenCounts {
  const ids = db.query<{ s: string }, [number, number]>(
    'SELECT session_id AS s FROM lane WHERE id = ? AND session_id IS NOT NULL UNION SELECT session_id FROM run WHERE lane_id = ?',
  ).all(laneId, laneId).map((r) => r.s);
  return sessionTokens(db, ids);
}

export function cancelCards(db: Db, ids: readonly number[]): void {
  for (const id of ids) db.query("UPDATE card SET status = 'cancelled' WHERE id = ? AND status = 'open'").run(id);
}
