// spec v2.9 §7 (R3) the three built-in packs, embedded in the engine (read-only, id `builtin:<slug>`).
import directWorkflow from './direct/WORKFLOW.md' with { type: 'text' };
import directGeneral from './direct/steps/general.md' with { type: 'text' };
import directLane from './direct/steps/lane.md' with { type: 'text' };
import poWorkflow from './po/WORKFLOW.md' with { type: 'text' };
import poBuild from './po/steps/build.md' with { type: 'text' };
import poDesign from './po/steps/design.md' with { type: 'text' };
import poGeneral from './po/steps/general.md' with { type: 'text' };
import poLane from './po/steps/lane.md' with { type: 'text' };
import spWorkflow from './spec-plan/WORKFLOW.md' with { type: 'text' };
import spBuild from './spec-plan/steps/build.md' with { type: 'text' };
import spDesign from './spec-plan/steps/design.md' with { type: 'text' };
import spGeneral from './spec-plan/steps/general.md' with { type: 'text' };
import spLane from './spec-plan/steps/lane.md' with { type: 'text' };
import spPlan from './spec-plan/steps/plan.md' with { type: 'text' };
import type { PackFiles } from '../pack.ts';

export const BUILTIN_SLUGS = ['po', 'spec-plan', 'direct'] as const;
export type BuiltinSlug = (typeof BUILTIN_SLUGS)[number];
/** §6.1 the default workflow of every project (and of the rows that exist before v2.9). */
export const DEFAULT_WORKFLOW = 'builtin:po';
/** hf-sp what a new project runs when the default needs a plugin that is not on (Giao thẳng needs none). */
export const DIRECT_WORKFLOW = 'builtin:direct';

const PACKS: Readonly<Record<BuiltinSlug, PackFiles>> = {
  po: { 'WORKFLOW.md': poWorkflow, 'steps/design.md': poDesign, 'steps/build.md': poBuild, 'steps/general.md': poGeneral, 'steps/lane.md': poLane },
  'spec-plan': {
    'WORKFLOW.md': spWorkflow, 'steps/design.md': spDesign, 'steps/plan.md': spPlan, 'steps/build.md': spBuild,
    'steps/general.md': spGeneral, 'steps/lane.md': spLane,
  },
  direct: { 'WORKFLOW.md': directWorkflow, 'steps/general.md': directGeneral, 'steps/lane.md': directLane },
};

/** A copy of the files of one built-in pack. */
export const builtinFiles = (slug: BuiltinSlug): PackFiles => ({ ...PACKS[slug] });

/** R9 / §7 "Trống": Chung + Lane with no instruction, copied only (never a row, never applied). */
export const blankFiles = (): PackFiles => ({
  'WORKFLOW.md': '---\nname: Trống\ndescription: Chỉ Chung và Lane, không lời dặn.\ndoc_label: ""\ndocs_done: done\n---\n',
  'steps/general.md': '---\ntype: general\nname: Chung\n---\n',
  'steps/lane.md': '---\ntype: lane\nname: Lane\nphases: [queue, code, review, done]\n---\n',
});
