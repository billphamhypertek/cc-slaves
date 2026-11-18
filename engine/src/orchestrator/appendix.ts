// The engine's mechanism sentences of the system appendix (v2.9 §5.6): the slots `{{prefixes}}` / `{{ask}}` / `{{drain}}` /
// `{{tools}}` / `{{rule:*}}` a pack's step body is filled with (workflow/compile.ts). The pack owns the rest of the text; a
// session's prompt hash (runtime.ts spawnPrompt) replaces the v2.7 per-role version.
import type { OrchKind } from '../../../shared/issues.ts';

export type AppendixRole = OrchKind | 'lane';

export const PREFIXES = 'Message prefixes (§7.6): `[PO] …` is the PO talking to you, `[Điều phối] …` is the orchestrator ' +
  'talking to a lane, `[cc-slaves] …` is the engine (events, card answers `[cc-slaves] PO trả lời #<id>: …`).';
export const ASK = 'Never use AskUserQuestion: ask the PO with `po_ask` (returns a card id at once; the answer arrives later ' +
  'as a `[cc-slaves] PO trả lời #<id>` message). Do not wait idly for it.';
const DRAIN = 'Safe stop (§8.2): on a `[cc-slaves] Dừng an toàn` message take no new task, finish the current one, ' +
  'commit, write the handoff `.local-check/handoff-<date>/<name>.md`, then report done with `lane_set_phase` ' +
  "and note 'đã dừng an toàn'.";
/** The safe-stop sentence for an orchestrator (`orchestrator`) or a lane (`<lane>`). */
export const drainText = (name: string): string => DRAIN.replace('<name>', name);
export const TRAILER = 'Every commit for an item carries the trailer `Issue: <key>` (e.g. `git commit --trailer "Issue: T-47"`); issue_done ' +
  'refuses commits without it.';
export const CANCELLED = "Before creating an item, read the cancelled ones: issues_list {state: 'cancelled'} (title + the PO's reason) — " +
  'never recreate what the PO cancelled.';
const LANE_TOOLS = 'lanes_list, lane_start {name, cwd, brief_path, issue?, agent?, model?, effort?, account?}, ' +
  'lane_message {name, text}, lane_interrupt {name}, lane_stop {name, mode: drain|now}, lane_resume {name}, ' +
  'lane_finish {name, force?}, lane_result {name}, lane_tail {name, n?}, lane_set_phase {name, phase, task?, note?}, ' +
  'accounts_usage, po_ask {question, options, recommended?, context?}, notify {level, text}';
const ISSUE_TOOLS = 'issues_list {spec?, state?}, issue_get {key}, issue_create {title, body?, kind?, spec?, source?, blocked_by?, done_when?, files?}, ' +
  'issue_assign {key, lane} (an idle lane), issue_update {key, …}, issue_link {key, blocked_by}';
const OUTPUT = 'spec_output_add {path, ref, label?} for every mockup, image, research note or prototype you make for the spec.';

/** The "Tools (MCP cc_slaves …)" sentence of each role; the lane's lists its phases. */
export function toolsText(role: AppendixRole, phases: readonly string[]): string {
  switch (role) {
    case 'design':
      return 'Tools (MCP cc_slaves): spec_draft {path} after writing the spec and again after each big edit (the engine re-reads its title); ' +
        'spec_approve {path, after?} only when the PO clearly says it is approved ("ok duyệt") — first set the spec\'s status line, ' +
        'commit, then call it; spec_amend {path, summary} instead when the spec you are bound to is being built (commit first); ' +
        `${OUTPUT} Also issues_list, issue_get, po_ask, notify.`;
    case 'build':
      return `Tools (MCP cc_slaves, §7.7): ${LANE_TOOLS}; ${ISSUE_TOOLS}, issue_drop {key, reason} (a todo item of your spec), ` +
        'spec_set_branch {path, branch}, spec_close {path}. Item and lane tools act only on your spec\'s items.';
    case 'general':
      return `Tools (MCP cc_slaves, §7.7): ${LANE_TOOLS}; ${ISSUE_TOOLS}. Item tools act only on outside-spec items.`;
    case 'lane':
      return `Tools (MCP cc_slaves, §7.7): lane_set_phase {phase, task?, note?} with phase in ${phases.join('/')} — call lane_set_phase whenever your phase changes and with ` +
        "phase 'done' when the brief is finished; po_ask {question, options, recommended?, context?}; issue_get {key} (your item); " +
        'issue_done {key, summary} when your item is finished; issue_create {title, body?, kind?} for work you find outside your ' +
        'item; issue_revert_conflict {key, detail} when a revert item conflicts (after `git revert --abort`).';
  }
}
