// v2.9 migration v25 (spec §6.1, §10.1): every project runs "Quy trình PO" (`project.workflow`), every spec / session / lane
// is pinned to its first rev, `spec.step` + `session.step` name the step, `spec.design_session` becomes `step_session`, and
// `session.prompt_hash` replaces `prompt_version`. The rev and the hashes are literals (SQL has no sha256): a session that
// had the v2.7 text of its role gets that text's hash, an older one 'v27-older' (unequal to every hash: the new text is sent once on
// resume, as v2.7's upgradeMessage did), a NULL one stays NULL (= unknown, nothing sent — as v2.7 did). A test
// keeps them equal to the built-in pack. `db.ts` appends it to MIGRATIONS. Never edit it once shipped.

/** The rev of `builtin:po` when v2.9 shipped (= the v2.7 behaviour, byte for byte). */
const PO_REV = '69de439a7dc60d9ce79e2a973e5a2f8f765d99d77f51a19299cb820aab146b30';
/** sha256 of each role's v2.7 appendix, and the v2.7 `prompt_version` it went with. */
const V27 = {
  design: { version: 1, hash: 'c3fc8f784527f9c4f559d4f69a076044038f061386c3bb8cdbecfd8f925984e5' },
  build: { version: 1, hash: '84b88ef73f7f4aedf3ab590de70795ddc125e9784689658f110edaaa91622b43' },
  general: { version: 6, hash: '898c01f9323058f2d7e98ed4a8639288f0d8d6bc08ca3261952cc24e72e40731' },
  lane: { version: 3, hash: '3fb504177d4b0461e06e3a155dca09adb74a4aa409d58d17178dd34b9bb517b1' },
} as const;

const hashCase = (Object.keys(V27) as (keyof typeof V27)[])
  .map((r) => `WHEN ${r === 'lane' ? "kind = 'lane'" : `kind = 'orchestrator' AND orch_kind = '${r}'`} AND prompt_version = ${V27[r].version} THEN '${V27[r].hash}'`)
  .concat("WHEN prompt_version IS NOT NULL THEN 'v27-older'")
  .join(' ');

export const MIGRATION_V25 = `
  ALTER TABLE project ADD COLUMN workflow TEXT NOT NULL DEFAULT 'builtin:po';
  ALTER TABLE spec ADD COLUMN workflow_rev TEXT NOT NULL DEFAULT '${PO_REV}';
  ALTER TABLE spec ADD COLUMN step TEXT;
  UPDATE spec SET step = CASE state WHEN 'active' THEN 'build' WHEN 'done' THEN NULL ELSE 'design' END;
  ALTER TABLE spec RENAME COLUMN design_session TO step_session;
  ALTER TABLE session ADD COLUMN step TEXT;
  UPDATE session SET step = CASE kind WHEN 'lane' THEN 'lane' ELSE orch_kind END;
  ALTER TABLE session ADD COLUMN workflow_rev TEXT NOT NULL DEFAULT '${PO_REV}';
  ALTER TABLE session ADD COLUMN prompt_hash TEXT;
  UPDATE session SET prompt_hash = CASE ${hashCase} ELSE NULL END;
  ALTER TABLE session DROP COLUMN prompt_version;
  ALTER TABLE lane ADD COLUMN workflow_rev TEXT NOT NULL DEFAULT '${PO_REV}';
`;
