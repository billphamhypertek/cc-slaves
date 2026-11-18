// The "Quy trình PO" pack as the engine runs it (v2.9 §6.1): a step's appendix and the prompt hash a session stores for it.
import { kickoffText } from '../../src/workflow/compile.ts';
import { DEFAULT_WORKFLOW } from '../../src/workflow/builtin/index.ts';
import { hashText, stepOf, workflowOf } from '../../src/workflow/runtime.ts';
import type { KickoffKey, StepType } from '../../src/workflow/vocab.ts';

export const PO = workflowOf(DEFAULT_WORKFLOW);
export const appendixOf = (type: StepType): string => stepOf(PO, type)!.appendix;
export const hashOf = (type: StepType): string => hashText(appendixOf(type));
/** The first message of a step of the pack (§5.5 kickoff). */
export const kickoff = (type: StepType, which: KickoffKey, params: { project?: string; path?: string }, outside = false): string =>
  kickoffText(stepOf(PO, type)!, which, params, outside);
