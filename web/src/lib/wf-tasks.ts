// v2.9 §4.7 the Tasks tab follows the pack (pure): the rail group / waiting group / start label of each doc step (the
// pack's `labels`, else "Đang / Chờ / Bắt đầu" + the step name in lower case), the chain order of the groups, Giao thẳng
// (no doc: only "Việc"), the `{doc}` / `{design}` / `{build}` names the catalog strings take, and the effective-config
// line "Quy trình PO · Build · bản a1b2c3" with its hover (blocked skills + rules on).
import type { SpecInfo } from '../../../shared/issues.ts';
import type { Params, Tr } from '../../../shared/i18n/core.ts';
import type { WfRef, WorkflowDetail } from '../../../shared/workflows.ts';

type Step = NonNullable<WorkflowDetail['steps']>[number];
/** What the tab reads of a rev (`workflow_get {rev}` of a valid rev). */
export type WfDoc = Pick<WorkflowDetail, 'rev' | 'name' | 'docLabel'> & { steps: Step[] };
export type SlotKind = 'designing' | 'ready' | 'building';
export interface StepLabels { group: string; waiting: string | null; start: string | null }

const low = (s: string): string => s.toLocaleLowerCase('vi');
/** §4.7 a pack with no document ("Giao thẳng"): the rail is only "Việc", no "+ <doc> mới", no import. */
const docless = (w: WfDoc): boolean => w.docLabel === '';
const chain = (w: WfDoc): Step[] => w.steps.filter(s => s.type === 'design' || s.type === 'build');

/** §4.7 the three labels of a doc / build step; the waiting group + button only when its edge out is "bấm Bắt đầu". */
export function stepLabels(tr: Tr, w: WfDoc, id: string): StepLabels | null {
  const s = w.steps.find(x => x.id === id);
  if (!s) return null;
  const group = s.labels.group ?? tr('tasks.wf.group', { step: low(s.name) });
  const n = s.type === 'design' && s.next?.start === 'button' ? w.steps.find(x => x.id === s.next!.to) : undefined;
  if (!n) return { group, waiting: null, start: null };
  return { group, waiting: s.labels.waiting ?? tr('tasks.wf.waiting', { step: low(n.name) }), start: s.labels.start ?? tr('tasks.wf.start', { step: low(n.name) }) };
}

const KIND: Readonly<Record<Exclude<SpecInfo['state'], 'done'>, SlotKind>> = { draft: 'designing', approved: 'ready', active: 'building' };
interface Slot { kind: SlotKind; label: string; start: string | null }
/** How `specRail` places specs: the slot of an open spec (by its own rev), the chain order, the outside group's words. */
export interface RailSlots {
  slot: (s: SpecInfo) => Slot;
  /** group labels in chain order (each doc step: its group, then its waiting group) */
  order: readonly string[];
  outside: string; outsideRow: string; done: string; docless: boolean;
}

/** §4.7 / §6.1 the rail of the project's workflow `cur`; a spec reads the labels of its own rev (`docs`), and a rev the
 *  web has no detail for (or no `cur`: an engine without the library) falls back to the catalog words. */
export function railSlots(tr: Tr, cur: WfDoc | null, docs: ReadonlyMap<string, WfDoc>): RailSlots {
  const order: string[] = cur ? [] : (['designing', 'ready', 'building'] as const).map(k => tr(`tasks.rail.group.${k}`));
  for (const s of cur ? chain(cur) : []) {
    const l = stepLabels(tr, cur!, s.id)!;
    order.push(l.group);
    if (l.waiting) order.push(l.waiting);
  }
  const slot = (s: SpecInfo): Slot => {
    const kind = KIND[s.state as keyof typeof KIND];
    const w = docs.get(s.workflowRev);
    const step = s.step ?? w?.steps.find(x => x.type === (kind === 'building' ? 'build' : 'design'))?.id;
    const l = w && step ? stepLabels(tr, w, step) : null;
    if (!l) return { kind, label: tr(`tasks.rail.group.${kind}`), start: kind === 'ready' ? tr('tasks.rail.build') : null };
    return kind === 'ready' && l.waiting ? { kind, label: l.waiting, start: l.start } : { kind, label: l.group, start: null };
  };
  const none = cur !== null && docless(cur);
  return {
    slot, order, docless: none, done: tr('tasks.rail.group.done'),
    outside: none ? tr('tasks.wf.items') : tr('tasks.rail.group.outside', cur ? wfNames(cur) : undefined),
    outsideRow: none ? tr('tasks.wf.allItems') : tr('tasks.rail.outsideRow'),
  };
}

/** §4.7 the names the parametrised catalog strings take (a missing one = the catalog's own default, Quy trình PO). */
export function wfNames(w: WfDoc): Params {
  const doc = w.docLabel || 'Việc';
  const out: Params = { doc, docLow: low(doc) };
  const design = w.steps.find(s => s.type === 'design'), build = w.steps.find(s => s.type === 'build');
  if (design) Object.assign(out, { design: design.name, designLow: low(design.name) });
  if (build) Object.assign(out, { build: build.name, buildLow: low(build.name) });
  return out;
}

const RULES = ['priority_first', 'one_item_per_lane', 'outside_item_new_lane', 'no_recreate_cancelled'] as const;
/** §4.7 "Quy trình PO · Build · bản a1b2c3"; the hover: blocked skills + the rules on (Vietnamese names as WF4). */
export function wfLine(tr: Tr, wf: WfRef): { text: string; tip: string } {
  const rules = [...RULES.filter(k => wf.rules.includes(k)).map(k => tr(`tasks.wf.rule.${k}`)), tr('tasks.wf.rule.max', { n: wf.maxDoc })];
  return {
    text: tr('tasks.wf.line', { name: wf.name, step: wf.stepName, rev: wf.rev.slice(0, 6) }),
    tip: `${tr('tasks.wf.deny', { list: wf.deny.length ? wf.deny.join(', ') : tr('tasks.wf.none') })}\n${tr('tasks.wf.rules', { list: rules.join(' · ') })}`,
  };
}
