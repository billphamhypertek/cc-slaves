// spec v2.9 §5.6 / §10.1 compile a validated workflow into what the engine hands each session: the appendix (WORKFLOW body +
// step body with its slots filled), `permissions.deny`, the gate file (`<skill>\t<hook JSON>` lines, §10.1), the Tasks
// labels, the first messages and the "xong hết mục" message. Pure; the mechanism sentences live in orchestrator/appendix.ts.
import { ASK, CANCELLED, PREFIXES, TRAILER, drainText, toolsText } from '../orchestrator/appendix.ts';
import type { Workflow, WorkflowStep } from './validate.ts';
import { DONE_ID, REQUIRED_SLOTS, SLOT_RE, type BoolRule, type KickoffKey, type LabelKey, type Rules } from './vocab.ts';

export interface CompiledStep extends Omit<WorkflowStep, 'deny' | 'body' | 'labels' | 'kickoff'> {
  appendix: string;
  /** `--settings` `permissions.deny` rules, file order. */
  deny: string[];
  /** `<home>/skill-deny/<sessionId>.tsv`: one `<skill>\t<hook JSON>` line per blocked name (a plugin skill also bare). */
  gate: string;
  labels: Partial<Record<LabelKey, string>>;
  kickoff: Partial<Record<KickoffKey, string>>;
}
export interface Compiled extends Omit<Workflow, 'steps' | 'body' | 'settled'> {
  steps: CompiledStep[];
  /** §5.5 the message to the Build session when every item is done (`{path}`; the engine adds `[cc-slaves] `). */
  settled: string;
}

/** §5.7 the sentence of each rule slot (`{{rule:<key>}}`), shown only while the rule is on; `trailer` always. */
const RULE_TEXT: Readonly<Record<BoolRule, string>> = {
  priority_first: 'Give out priority items (↑) first: a ready priority item goes before any other item of the same document.',
  one_item_per_lane: 'A lane holds at most one item in progress.',
  outside_item_new_lane: 'An outside-document item goes only to a new lane of its own; a lane that worked one takes no other item.',
  no_recreate_cancelled: CANCELLED,
};

/** `{project}` / `{path}` placeholders of a first message or `settled`. */
export function render(template: string, params: { project?: string; path?: string }): string {
  return template.replace(/\{(project|path)\}/g, (m, k: 'project' | 'path') => params[k] ?? m);
}

/** v2.7 `firstText.*`: `outside` adds the "built partly outside cc-slaves" sentence to a build's `new`. */
export function kickoffText(s: CompiledStep, which: KickoffKey, params: { project?: string; path?: string }, outside = false): string {
  const extra = outside && which === 'new' && s.kickoff.outside ? ` ${s.kickoff.outside}` : '';
  return render(`${s.kickoff[which] ?? ''}${extra}`, params);
}

function slotValue(w: Workflow, s: WorkflowStep, slot: string): string {
  switch (slot) {
    case 'tools': return toolsText(s.type, s.phases ?? []);
    case 'prefixes': return PREFIXES;
    case 'ask': return ASK;
    case 'drain': return drainText(s.type === 'lane' ? '<lane>' : 'orchestrator');
    case 'phases': return (s.phases ?? []).join('/');
    case 'skills_blocked':
      return s.deny.length ? `Skills: ${s.deny.map((d) => d.skill).join(', ')} are blocked here on purpose (the reason comes back as a hook error).` : '';
    case 'rule:trailer': return TRAILER;
    default: {
      const rule = slot.slice('rule:'.length) as BoolRule;
      return w.rules[rule] ? RULE_TEXT[rule] : '';
    }
  }
}

/** §5.6 WORKFLOW body + step body, missing required slots appended (one per line), slots filled; a line left empty by an
 * off rule is dropped and no line keeps trailing spaces. */
function appendixOf(w: Workflow, s: WorkflowStep): string {
  const lines = [w.body, s.body].filter((b) => b !== '').join('\n').split('\n');
  const present = new Set(lines.flatMap((l) => [...l.matchAll(SLOT_RE)].map((m) => m[1]!)));
  for (const slot of REQUIRED_SLOTS[s.type]) if (!present.has(slot)) lines.push(`{{${slot}}}`);
  const out: string[] = [];
  for (const l of lines) {
    const filled = l.replace(SLOT_RE, (_m, slot: string) => slotValue(w, s, slot)).trimEnd();
    if (filled === '' && l.trim() !== '') continue;
    out.push(filled);
  }
  return out.join('\n');
}

function gateOf(w: Workflow, s: WorkflowStep): string {
  const lines: string[] = [];
  for (const d of s.deny) {
    const reason = d.reason ?? `Bị chặn có chủ ý theo quy trình ${w.name}, bước ${s.name}`;
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
    const bare = d.skill.includes(':') ? d.skill.slice(d.skill.indexOf(':') + 1) : null;
    for (const name of bare === null ? [d.skill] : [d.skill, bare]) lines.push(`${name}\t${json}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

const lower = (s: string) => s.toLocaleLowerCase('vi');

/** §4.7 labels a pack leaves out: "Đang <bước>", "Chờ <bước sau>", "Bắt đầu <bước sau>". */
function labelsOf(s: WorkflowStep, byId: ReadonlyMap<string, WorkflowStep>): Partial<Record<LabelKey, string>> {
  if (s.type !== 'design' && s.type !== 'build') return {};
  const next = s.next && s.next.to !== DONE_ID ? byId.get(s.next.to) : undefined;
  const auto: Partial<Record<LabelKey, string>> = { group: `Đang ${lower(s.name)}` };
  if (next) { auto.waiting = `Chờ ${lower(next.name)}`; auto.start = `Bắt đầu ${lower(next.name)}`; }
  return { ...auto, ...s.labels };
}

/** §13 the first messages a pack leaves out: the v2.7 sentences without the PO-specific parts. */
function kickoffOf(w: Workflow, s: WorkflowStep): Partial<Record<KickoffKey, string>> {
  const doc = lower(w.docLabel);
  if (s.type === 'design') {
    const edit = `Sửa ${doc} {path}: đọc ${doc}, hỏi anh cần sửa gì.`;
    return { new: `Phiên ${s.name} mới cho project {project}: chờ anh viết ý tưởng.`, edit, amend: edit, ...s.kickoff };
  }
  if (s.type === 'build') {
    return {
      new: `${s.name} ${doc} {path}: tách mục bằng issue_create (source spec), rồi giao lane.`,
      resume: `Phiên này giờ là phiên ${s.name} của ${doc} {path} trong cc-slaves (đọc luật ở system prompt). Ghi phần đã xong: `
        + 'issue_create {state: done, source: prior, commits}, rồi tạo mục cho phần còn lại.',
      ...s.kickoff,
    };
  }
  return {};
}

export function compile(w: Workflow): Compiled {
  const byId = new Map(w.steps.map((s) => [s.id, s]));
  const firstDocs = w.steps.find((s) => s.type === 'design')?.docs ?? 'docs';
  const rules: Rules = { ...w.rules };
  return {
    rev: w.rev, name: w.name, description: w.description, docLabel: w.docLabel, docsDone: w.docsDone, requirePlugins: [...w.requirePlugins],
    rules, basedOn: w.basedOn, chain: [...w.chain],
    settled: w.settled ?? `${lower(w.docLabel)} {path} xong hết mục. Chuyển file sang ${firstDocs}/${w.docsDone}/, merge, rồi spec_close {path: "{path}"}.`,
    steps: w.steps.map((s) => ({
      id: s.id, type: s.type, name: s.name, docs: s.docs, next: s.next, phases: s.phases,
      appendix: appendixOf(w, s), deny: s.deny.map((d) => `Skill(${d.skill})`), gate: gateOf(w, s),
      labels: labelsOf(s, byId), kickoff: kickoffOf(w, s),
    })),
  };
}
