// spec v2.9 §5 the workflow-pack vocabulary, defined once: step types, frontmatter keys, rules, slots, limits. `validate.ts`
// checks against it and (G6) the author session's appendix is generated from it (§5.9 "sinh từ cùng nguồn").
import {
  BOOL_RULES, DONE_ID, LAST_PHASE, MAX_DOC_SESSIONS, MAX_DOCS, MAX_PHASES, PHASE_RE, SLOT_RE, START_VALUES, STEP_ID_RE, STEP_TYPES,
  type BoolRule, type StartMode, type StepType,
} from '../../../shared/workflows.ts';

/** The part the canvas needs too lives in shared/workflows.ts (one definition, v29-g4); re-exported for the engine. */
export { BOOL_RULES, DONE_ID, LAST_PHASE, MAX_DOC_SESSIONS, PHASE_RE, SLOT_RE, START_VALUES, STEP_ID_RE, STEP_TYPES };
export type { BoolRule, StartMode, StepType };

/** §5.2 the type's name on the canvas when a step has no `name`. */
export const TYPE_NAME: Readonly<Record<StepType, string>> = { design: 'Soạn tài liệu', build: 'Build bằng lane', general: 'Việc chung', lane: 'Lane' };

/** §5.5 `WORKFLOW.md` keys. */
export const WORKFLOW_KEYS = ['name', 'description', 'doc_label', 'docs_done', 'require_plugins', 'rules', 'based_on', 'settled'] as const;

/** §5.5 the keys each step type takes (`id` optional, must equal the file name). */
export const STEP_KEYS: Readonly<Record<StepType, readonly string[]>> = {
  design: ['id', 'type', 'name', 'docs', 'labels', 'kickoff', 'skills_deny', 'next'],
  build: ['id', 'type', 'name', 'labels', 'kickoff', 'skills_deny', 'next'],
  general: ['id', 'type', 'name', 'skills_deny'],
  lane: ['id', 'type', 'name', 'phases', 'skills_deny'],
};

/** §4.7 / §5.5 Tasks tab labels of a doc or build step. */
export const LABEL_KEYS = ['group', 'waiting', 'start'] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];

/** §5.5 first messages (v2.7 `firstText`): design new / edit / amend, build new / resume + `outside` (the "built partly outside"
 * sentence appended to `new`). Placeholders `{project}` / `{path}`. */
export const KICKOFF_KEYS = { design: ['new', 'edit', 'amend'], build: ['new', 'resume', 'outside'] } as const;
export type KickoffKey = (typeof KICKOFF_KEYS)[keyof typeof KICKOFF_KEYS][number];

export const NEXT_KEYS = ['to', 'start'] as const;
export const SKILL_DENY_KEYS = ['skill', 'reason'] as const;


/** §5.7 rules with their "Quy trình PO" defaults. */
export interface Rules { priority_first: boolean; one_item_per_lane: boolean; outside_item_new_lane: boolean; no_recreate_cancelled: boolean; max_doc_sessions: number }
export const DEFAULT_RULES: Readonly<Rules> = { priority_first: true, one_item_per_lane: true, outside_item_new_lane: true, no_recreate_cancelled: true, max_doc_sessions: 3 };

/** §5.6 mechanism slots every step of a type carries (appended at the end when missing). */
export const REQUIRED_SLOTS: Readonly<Record<StepType, readonly string[]>> = {
  design: ['tools', 'prefixes', 'ask'],
  build: ['tools', 'prefixes', 'ask', 'drain'],
  general: ['tools', 'prefixes', 'ask', 'drain'],
  lane: ['tools', 'prefixes', 'ask', 'drain'],
};
/** §5.6 optional derived slots per type; `rule:<key>` (bool rules) and `rule:trailer` go anywhere. */
export const OPTIONAL_SLOTS: Readonly<Record<StepType, readonly string[]>> = {
  design: ['skills_blocked'], build: ['skills_blocked'], general: ['skills_blocked'], lane: ['skills_blocked', 'phases'],
};
export const RULE_SLOTS = ['trailer', ...BOOL_RULES] as const;

/** §5.1 / §5.3 / §5.4 limits. */
export const LIMITS = {
  totalBytes: 256 * 1024, bodyBytes: 16 * 1024, maxDocs: MAX_DOCS, maxBuild: 1, maxPhases: MAX_PHASES, longBodyLines: 200,
} as const;
