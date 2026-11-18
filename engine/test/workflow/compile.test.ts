// spec v2.9 §5.6 / §8 / §12: compile a pack into the session texts. "Quy trình PO" must equal the frozen v2.7 strings byte for
// byte (appendix ×4, deny + reasons, first messages, "xong hết mục", labels, phases); the two other built-ins compile clean.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { builtinFiles, BUILTIN_SLUGS, DEFAULT_WORKFLOW } from '../../src/workflow/builtin/index.ts';
import { compile, kickoffText, render, type Compiled } from '../../src/workflow/compile.ts';
import { validatePack, type Workflow } from '../../src/workflow/validate.ts';
import { fm, packWith } from './_packs.ts';
import { SAMPLE, type captureV27 } from './_v27.ts';

const snap = JSON.parse(readFileSync(new URL('../_fixtures/v27-parity.json', import.meta.url), 'utf8')) as ReturnType<typeof captureV27>;
const ok = (files: Record<string, string>): Workflow => {
  const r = validatePack(files);
  expect(r.errors).toEqual([]);
  return r.workflow!;
};
const step = (c: Compiled, id: string) => c.steps.find((s) => s.id === id)!;
const po = compile(ok(builtinFiles('po')));

describe('§8 / §12 Quy trình PO = v2.7, byte for byte', () => {
  test('default id', () => { expect(DEFAULT_WORKFLOW).toBe('builtin:po'); });
  for (const id of ['design', 'build', 'general', 'lane'] as const) {
    test(`${id} appendix`, () => { expect(step(po, id).appendix).toBe(snap.appendix[id]!); });
    test(`${id} permissions.deny in FORBIDDEN_SKILLS order`, () => { expect(step(po, id).deny).toEqual(snap.deny[id]!); });
    test(`${id} gate file: one line per qualified + bare name, the v2.7 hook JSON with the v2.7 reason`, () => {
      const json = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${snap.reason[id]}"}}`;
      const names = snap.deny[id]!.map((d) => d.slice('Skill('.length, -1));
      expect(step(po, id).gate).toBe(names.flatMap((n) => [`${n}\t${json}`, `${n.slice('superpowers:'.length)}\t${json}`]).join('\n') + '\n');
    });
  }
  test('step names = KIND_VI; labels = the Tasks catalog', () => {
    expect({ design: step(po, 'design').name, build: step(po, 'build').name, general: step(po, 'general').name }).toEqual(snap.labels.kind);
    expect(step(po, 'design').labels).toEqual({ group: snap.labels.group, waiting: snap.labels.waiting, start: snap.labels.start });
    expect(step(po, 'build').labels.group).toBe(snap.labels.building);
  });
  test('first messages (firstText.*)', () => {
    const p = { project: SAMPLE.project, path: SAMPLE.path };
    const d = step(po, 'design');
    const b = step(po, 'build');
    expect(kickoffText(d, 'new', p)).toBe(snap.firstText.design);
    expect(kickoffText(d, 'edit', p)).toBe(snap.firstText.edit);
    expect(kickoffText(d, 'amend', p)).toBe(snap.firstText.edit);
    expect(kickoffText(b, 'new', p)).toBe(snap.firstText.build);
    expect(kickoffText(b, 'new', p, true)).toBe(snap.firstText.buildOutside);
    expect(kickoffText(b, 'resume', p)).toBe(snap.firstText.resume);
  });
  test('"xong hết mục" (specSettled) after the engine prefix', () => {
    expect(`[cc-slaves] ${render(po.settled, { path: SAMPLE.path })}`).toBe(snap.settled);
  });
  test('lane phases = the lane_set_phase enum; docs, done/, doc label, plugin, rules', () => {
    const tool = snap.mcp.lane.find((t) => t.name === 'lane_set_phase')!;
    expect(step(po, 'lane').phases).toEqual((tool.schema as unknown as { properties: { phase: { enum: string[] } } }).properties.phase.enum);
    expect([step(po, 'design').docs, po.docsDone, po.docLabel, po.requirePlugins]).toEqual(['docs/specs', 'done', 'Spec', ['superpowers']]);
    expect(po.rules).toEqual({ priority_first: true, one_item_per_lane: true, outside_item_new_lane: true, no_recreate_cancelled: true, max_doc_sessions: 3 });
    expect(po.chain).toEqual(['design', 'build']);
    expect(step(po, 'design').next).toEqual({ to: 'build', start: 'button' });
  });
});

describe('§7 the other built-ins', () => {
  test('every built-in validates with no error and no warning', () => {
    for (const slug of BUILTIN_SLUGS) expect([slug, validatePack(builtinFiles(slug))]).toEqual([slug, expect.objectContaining({ errors: [], warnings: [] })]);
  });
  test('Spec + Plan: Thiết kế → Plan → Build; Plan may use writing-plans, Thiết kế may not', () => {
    const c = compile(ok(builtinFiles('spec-plan')));
    expect(c.chain).toEqual(['design', 'plan', 'build']);
    expect(step(c, 'plan').docs).toBe('docs/plans');
    expect(step(c, 'plan').deny).not.toContain('Skill(superpowers:writing-plans)');
    expect(step(c, 'design').deny).toContain('Skill(superpowers:writing-plans)');
    expect(step(c, 'design').labels).toEqual({ group: 'Đang thiết kế', waiting: 'Chờ plan', start: 'Bắt đầu plan' });
    expect(step(c, 'design').appendix).toContain('Skills: superpowers:writing-plans, superpowers:executing-plans');
    expect(step(c, 'lane').appendix).toContain('with phase in queue/spec/code/review/gate/merge/done —');
  });
  test('Giao thẳng: no document, four phases, no plugin, priority_first off → no priority sentence', () => {
    const c = compile(ok(builtinFiles('direct')));
    expect([c.docLabel, c.chain, c.requirePlugins, c.rules.priority_first]).toEqual(['', [], [], false]);
    expect(step(c, 'lane').phases).toEqual(['queue', 'code', 'review', 'done']);
    expect(step(c, 'lane').appendix).toContain('with phase in queue/code/review/done —');
    for (const s of c.steps) expect(s.appendix).not.toContain('{{');
  });
});

describe('§5.6 slots', () => {
  const lanePack = (body: string, rules = '') => compile(ok(packWith({
    'WORKFLOW.md': fm(`name: Thử\ndoc_label: Spec${rules}`), 'steps/lane.md': fm('type: lane\nname: L\nphases: [queue, done]\nskills_deny: [superpowers:brainstorming, { skill: mine, reason: "lý do có \\"ngoặc\\" và \\\\" }]', body),
  })));
  test('missing required slots are appended at the end in order; a rule slot off → its line is gone', () => {
    const c = lanePack('Làm brief.\n{{rule:no_recreate_cancelled}}\nHết.', '\nrules: { no_recreate_cancelled: false }');
    const lines = step(c, 'lane').appendix.split('\n');
    expect(lines[0]).toBe('Làm brief.');
    expect(lines[1]).toBe('Hết.');
    expect(lines.slice(2).map((l) => l.slice(0, 16))).toEqual(['Tools (MCP cc_sl', 'Message prefixes', 'Never use AskUse', 'Safe stop (§8.2)']);
    expect(step(c, 'lane').appendix).toContain('.local-check/handoff-<date>/<lane>.md');
  });
  test('a rule slot on → its sentence; an inline slot off → no trailing space', () => {
    expect(step(lanePack('A. {{rule:priority_first}}'), 'lane').appendix.split('\n')[0]).toMatch(/^A\. Give out priority items/);
    expect(step(lanePack('A. {{rule:priority_first}}', '\nrules: { priority_first: false }'), 'lane').appendix.split('\n')[0]).toBe('A.');
    for (const r of ['one_item_per_lane', 'outside_item_new_lane', 'no_recreate_cancelled'] as const) {
      expect(step(lanePack(`{{rule:${r}}}`), 'lane').appendix.split('\n')[0]).not.toMatch(/^Tools/);
      expect(step(lanePack(`{{rule:${r}}}`, `\nrules: { ${r}: false }`), 'lane').appendix.split('\n')[0]).toMatch(/^Tools/);
    }
  });
  test('{{phases}}, {{skills_blocked}} in file order; the WORKFLOW body comes first', () => {
    const c = compile(ok(packWith({
      'WORKFLOW.md': fm('name: Thử\ndoc_label: Spec', 'Chung cho mọi bước.'),
      'steps/lane.md': fm('type: lane\nphases: [queue, code, done]\nskills_deny: [b-skill, a-skill]', 'Pha: {{phases}}. {{skills_blocked}}'),
    })));
    expect(step(c, 'lane').appendix.split('\n').slice(0, 2)).toEqual([
      'Chung cho mọi bước.',
      'Pha: queue/code/done. Skills: b-skill, a-skill are blocked here on purpose (the reason comes back as a hook error).',
    ]);
    expect(step(c, 'general').appendix.startsWith('Chung cho mọi bước.\nViệc chung.')).toBe(true);
  });
  test('the gate reason: given verbatim (quotes, backslash JSON-escaped), else the default sentence', () => {
    const s = step(lanePack('x'), 'lane');
    const [l1, l2, l3] = s.gate.trimEnd().split('\n');
    expect(l1).toBe(`superpowers:brainstorming\t${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Bị chặn có chủ ý theo quy trình Thử, bước L' } })}`);
    expect(l2!.startsWith('brainstorming\t')).toBe(true);
    expect(JSON.parse(l3!.split('\t')[1]!).hookSpecificOutput.permissionDecisionReason).toBe('lý do có "ngoặc" và \\');
    expect(s.deny).toEqual(['Skill(superpowers:brainstorming)', 'Skill(mine)']);
  });
  test('default labels, kickoff and settled when the pack writes none', () => {
    const c = compile(ok(packWith({ 'steps/build.md': fm('type: build\nname: Build\nnext: { to: done }') })));
    expect(step(c, 'design').labels).toEqual({ group: 'Đang thiết kế', waiting: 'Chờ build', start: 'Bắt đầu build' });
    expect(step(c, 'build').labels).toEqual({ group: 'Đang build' });
    expect(kickoffText(step(c, 'design'), 'new', { project: 'p' })).toBe('Phiên Thiết kế mới cho project p: chờ anh viết ý tưởng.');
    expect(kickoffText(step(c, 'design'), 'edit', { path: 'docs/specs/a.md' })).toBe('Sửa spec docs/specs/a.md: đọc spec, hỏi anh cần sửa gì.');
    expect(kickoffText(step(c, 'build'), 'new', { path: 'a.md' }, true)).toBe('Build spec a.md: tách mục bằng issue_create (source spec), rồi giao lane.');
    expect(render(c.settled, { path: 'a.md' })).toBe('spec a.md xong hết mục. Chuyển file sang docs/specs/done/, merge, rồi spec_close {path: "a.md"}.');
  });
});
