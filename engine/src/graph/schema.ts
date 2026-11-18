// v2.5 R1 migration v26 (§5.5): the engine's index book. One row per directory the engine ever queued an index for (its
// own jobs, lane jobs through the gate, the tool's own auto-index of R4): `origin` = `project` (a project root) or `lane`
// (any other dir: a lane worktree / session cwd). Only `lane` rows are cleaned automatically. Creates a table, touches no
// old one, forward only. `db.ts` appends it to MIGRATIONS. Never edit it once shipped.
export const MIGRATION_V26 = `
  CREATE TABLE graph_index (
    root_path TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('project','lane'))
  );
`;
