// v2.7 migration v23 (spec §5.1, ruling R-B1): specs, issues and their side tables, `session.orch_kind` + `cwd` (R-B13 a: a
// session running outside the project root, null = the root), and the card
// rebuild that adds the three v2.7 card kinds. `db.ts` appends it to MIGRATIONS. Never edit it once shipped.

export const MIGRATION_V23 = `
  ALTER TABLE session ADD COLUMN orch_kind TEXT NOT NULL DEFAULT 'general' CHECK (orch_kind IN ('design','build','general'));
  ALTER TABLE session ADD COLUMN cwd TEXT;
  CREATE TABLE spec (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES project(id),
    path TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','active','done')),
    after_id INTEGER REFERENCES spec(id),
    branch TEXT,
    design_session TEXT REFERENCES session(id),
    build_session TEXT REFERENCES session(id),
    edit_session TEXT REFERENCES session(id),
    origin TEXT NOT NULL CHECK (origin IN ('app','imported')),
    outside_build INTEGER NOT NULL DEFAULT 0 CHECK (outside_build IN (0,1)),
    resumed INTEGER NOT NULL DEFAULT 0 CHECK (resumed IN (0,1)),
    amend_rev INTEGER NOT NULL DEFAULT 0 CHECK (amend_rev >= 0),
    approved_at INTEGER,
    opened_at INTEGER,
    done_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (project_id, path),
    CHECK (after_id IS NULL OR after_id <> id)
  );
  CREATE TABLE issue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES project(id),
    num INTEGER NOT NULL CHECK (num > 0),
    kind TEXT NOT NULL CHECK (kind IN ('task','bug')),
    spec_id INTEGER REFERENCES spec(id),
    source TEXT NOT NULL CHECK (source IN ('spec','amend','po','lane','orchestrator','prior')),
    source_lane INTEGER REFERENCES lane(id),
    source_issue INTEGER REFERENCES issue(id),
    reverts INTEGER REFERENCES issue(id),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    body TEXT NOT NULL DEFAULT '',
    done_when TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(done_when) AND json_type(done_when) = 'array'),
    state TEXT NOT NULL DEFAULT 'todo' CHECK (state IN ('todo','doing','done','cancelled')),
    revert TEXT NOT NULL DEFAULT 'none' CHECK (revert IN ('none','pending','running','conflict','done')),
    lane_id INTEGER REFERENCES lane(id),
    base_sha TEXT,
    po_seen INTEGER NOT NULL DEFAULT 1 CHECK (po_seen IN (0,1)),
    po_ok INTEGER NOT NULL DEFAULT 0 CHECK (po_ok IN (0,1)),
    cancel_reason TEXT,
    created_by_session TEXT REFERENCES session(id),
    created_at INTEGER NOT NULL,
    done_at INTEGER,
    UNIQUE (project_id, num),
    CHECK (state <> 'doing' OR lane_id IS NOT NULL)
  );
  CREATE INDEX issue_spec ON issue(spec_id, state);
  CREATE UNIQUE INDEX issue_lane_doing ON issue(lane_id) WHERE state = 'doing';
  CREATE TABLE issue_dep (
    issue_id INTEGER NOT NULL REFERENCES issue(id),
    blocked_by_id INTEGER NOT NULL REFERENCES issue(id),
    PRIMARY KEY (issue_id, blocked_by_id),
    CHECK (issue_id <> blocked_by_id)
  );
  CREATE INDEX issue_dep_blocker ON issue_dep(blocked_by_id);
  CREATE TABLE issue_commit (
    issue_id INTEGER NOT NULL REFERENCES issue(id),
    sha TEXT NOT NULL,
    branch TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (issue_id, sha)
  );
  CREATE TABLE issue_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL REFERENCES issue(id),
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    json TEXT NOT NULL CHECK (json_valid(json) AND json_type(json) = 'object')
  );
  CREATE INDEX issue_event_issue ON issue_event(issue_id, id);
  CREATE TABLE issue_file (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL REFERENCES issue(id),
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    at INTEGER NOT NULL
  );
  CREATE INDEX issue_file_issue ON issue_file(issue_id);
  CREATE TABLE spec_output (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_id INTEGER NOT NULL REFERENCES spec(id),
    kind TEXT NOT NULL CHECK (kind IN ('md','image','html','link','other')),
    ref TEXT NOT NULL,
    label TEXT,
    added_by TEXT NOT NULL CHECK (added_by IN ('auto','session')),
    at INTEGER NOT NULL,
    UNIQUE (spec_id, ref)
  );
  CREATE TABLE card_v23 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('ask','permission','broken','orchestrator_down','logged_out','cc_updated','shared_cfg','shared_cfg_new','account_orphan','cutover','mcp_login','issues_new','superpowers_off','revert_conflict')),
    request_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled','expired')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  INSERT INTO card_v23 SELECT id, project_id, session_id, kind, request_id, payload, status, answer, created_at, resolved_at FROM card;
  DELETE FROM sqlite_sequence WHERE name = 'card_v23';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'card_v23', seq FROM sqlite_sequence WHERE name = 'card';
  DROP TABLE card;
  ALTER TABLE card_v23 RENAME TO card;
  CREATE INDEX card_open ON card(session_id) WHERE status = 'open';
`;
