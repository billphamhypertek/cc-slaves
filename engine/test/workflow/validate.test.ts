// spec v2.9 §5.4 V1–V15 (one red + the shared green per code), the warnings, and the normalised workflow §5.3 / §5.5 / §5.7.
import { describe, expect, test } from 'bun:test';
import { validatePack } from '../../src/workflow/validate.ts';
import { basePack, fm, packWith } from './_packs.ts';

const run = (over: Record<string, string | null>) => validatePack(packWith(over));
const codes = (over: Record<string, string | null>) => run(over).errors.map((e) => e.code);
const msgs = (over: Record<string, string | null>) => run(over).errors.map((e) => e.msg);
const wf = (yaml: string, body = '') => ({ 'WORKFLOW.md': fm(`name: Thử\n${yaml}`, body) });

describe('green', () => {
  test('the base pack: no error, no warning, a normalised workflow in chain order', () => {
    const r = validatePack(basePack());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.workflow?.chain).toEqual(['design', 'build']);
    expect(r.workflow?.steps.map((s) => s.id)).toEqual(['design', 'build', 'general', 'lane']);
    expect(r.workflow?.rules).toEqual({ priority_first: true, one_item_per_lane: true, outside_item_new_lane: true, no_recreate_cancelled: true, max_doc_sessions: 3 });
    const design = r.workflow!.steps[0]!;
    expect(design.next).toEqual({ to: 'build', start: 'button' });
    expect(r.workflow!.steps[3]!.name).toBe('Lane');
  });
  test('any error → no workflow', () => { expect(run({ 'steps/lane.md': fm('type: lane') }).workflow).toBeNull(); });
  test('V1 / V2 / V3 / V11 of the parse layer come through', () => {
    expect(codes({ 'WORKFLOW.md': null })).toEqual(['V2']);
    expect(codes({ 'x.txt': 'a' })).toEqual(['V11']);
  });
});

describe('§5.4 V4 V5 types and counts', () => {
  test('V4 unknown or missing type', () => {
    expect(msgs({ 'steps/general.md': fm('type: chat') })).toEqual(['Loại bước `chat` lạ: design, build, general hoặc lane', 'Gói cần đúng 1 bước general (đang có 0)']);
    expect(codes({ 'steps/general.md': fm('name: x') })).toEqual(['V4', 'V5']);
  });
  test('V5 exactly one general and one lane', () => {
    expect(msgs({ 'steps/general.md': null })).toEqual(['Gói cần đúng 1 bước general (đang có 0)']);
    expect(msgs({ 'steps/lane2.md': fm('type: lane\nphases: [done]') })).toEqual(['Gói cần đúng 1 bước lane (đang có 2)']);
  });
});

describe('§5.3 / §5.4 V6 V7 V8 chain', () => {
  test('V6 next.to names no step', () => {
    expect(msgs({ 'steps/design.md': fm('type: design\ndocs: docs/specs\nnext: { to: plan }') })).toEqual(['`next.to` plan: không có bước này']);
  });
  test('V7 build not last', () => {
    expect(msgs({ 'steps/build.md': fm('type: build\nnext: { to: design }') })).toContain('Build chỉ nối tới Xong');
  });
  test('V7 a branch (two steps into one), a cycle, an unreachable doc', () => {
    expect(msgs({ 'steps/plan.md': fm('type: design\ndocs: docs/plans\nnext: { to: build }') })).toContain('Rẽ nhánh: `design`, `plan` cùng nối tới `build`');
    expect(codes({
      'steps/design.md': fm('type: design\ndocs: docs/specs\nnext: { to: plan }'),
      'steps/plan.md': fm('type: design\ndocs: docs/plans\nnext: { to: design }'),
    })).toContain('V7');
    expect(codes({ 'steps/design.md': fm('type: design\ndocs: docs/specs') })).toContain('V7');
  });
  test('V7 more than 4 docs or 2 builds', () => {
    const docs: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) docs[`steps/d${i}.md`] = fm(`type: design\ndocs: docs/d${i}\nnext: { to: ${i === 5 ? 'build' : `d${i + 1}`} }`);
    expect(msgs({ ...docs, 'steps/design.md': null })).toEqual(['Quá 4 bước soạn tài liệu (đang có 5)']);
    expect(msgs({ 'steps/build2.md': fm('type: build\nnext: { to: done }') })).toContain('Quá 1 bước Build (đang có 2)');
  });
  test('green: no build (doc → Xong), a doc chain with auto, and no doc at all', () => {
    expect(codes({ 'steps/build.md': null, 'steps/design.md': fm('type: design\ndocs: docs/specs\nnext: { to: done }') })).toEqual([]);
    expect(codes({
      'steps/design.md': fm('type: design\ndocs: docs/specs\nnext: { to: plan, start: auto }'),
      'steps/plan.md': fm('type: design\ndocs: docs/plans\nnext: { to: build }'),
    })).toEqual([]);
    expect(codes({ ...wf('doc_label: ""'), 'steps/design.md': null, 'steps/build.md': null })).toEqual([]);
  });
  test('V8 start on an edge to Xong, or a value other than button / auto', () => {
    expect(msgs({ 'steps/build.md': fm('type: build\nnext: { to: done, start: button }') })).toEqual(['`start` không dùng ở cạnh tới Xong']);
    expect(msgs({ 'steps/design.md': fm('type: design\ndocs: docs/specs\nnext: { to: build, start: now }') })).toEqual(['`start` phải là button hoặc auto']);
  });
});

describe('§5.4 V9 phases', () => {
  const lane = (p: string) => ({ 'steps/lane.md': fm(`type: lane\nphases: ${p}`) });
  test.each([
    ['[]', 'Danh sách pha rỗng'],
    ['[queue, queue, done]', 'Pha `queue` trùng'],
    ['[a, b, c, d, e, f, g, h, done]', 'Quá 8 pha (đang có 9)'],
    ['[queue, code]', 'Pha cuối phải là `done`'],
    ['[Queue, done]', 'Pha `Queue` sai dạng: a-z, 0-9, dấu - (tối đa 16 ký tự)'],
  ])('V9 %s', (p, m) => { expect(msgs(lane(p))).toEqual([m]); });
  test('V9 phases missing on the lane', () => { expect(msgs({ 'steps/lane.md': fm('type: lane') })).toEqual(['Bước lane thiếu `phases`']); });
});

describe('§5.4 V10 V12 V13 V15 keys and values', () => {
  test('V10 a doc step with no doc_label, or a doc_label with no doc step', () => {
    expect(msgs(wf('doc_label: ""'))).toEqual(['Có bước soạn tài liệu thì `doc_label` không được trống']);
    expect(msgs({ 'steps/design.md': null, 'steps/build.md': null })).toEqual(['`doc_label` có chữ mà gói không có bước soạn tài liệu']);
  });
  test('V12 a rule unknown, of the wrong type or out of range', () => {
    expect(msgs(wf('doc_label: Spec\nrules: { priority_firts: true }'))).toEqual(['Luật `priority_firts` lạ — ý anh là `priority_first`?']);
    expect(msgs(wf('doc_label: Spec\nrules: { one_item_per_lane: "yes" }'))).toEqual(['Luật `one_item_per_lane` phải là true / false']);
    expect(msgs(wf('doc_label: Spec\nrules: { max_doc_sessions: 9 }'))).toEqual(['Luật `max_doc_sessions` phải là số nguyên 1–6']);
  });
  test('V12 a known key of the wrong type, a required name / docs missing', () => {
    expect(msgs({ 'steps/general.md': fm('type: general\nname: 12') })).toEqual(['`name` phải là chữ']);
    expect(msgs(wf('doc_label: Spec\nrequire_plugins: superpowers'))).toEqual(['`require_plugins` phải là danh sách chữ']);
    expect(msgs({ 'WORKFLOW.md': fm('doc_label: Spec') })).toEqual(['Thiếu `name` của quy trình']);
    expect(msgs({ 'steps/design.md': fm('type: design\nnext: { to: build }') })).toEqual(['Bước soạn tài liệu thiếu `docs`']);
  });
  test('V13 an unknown key, with the nearest known one', () => {
    expect(msgs({ 'steps/lane.md': fm('type: lane\nphases: [done]\nskill_deny: [x]') })).toEqual(['Khoá `skill_deny` lạ — ý anh là `skills_deny`?']);
    expect(msgs({ 'steps/general.md': fm('type: general\nnext: { to: done }') })).toEqual(['Khoá `next` không dùng ở bước general']);
    expect(msgs({ 'steps/design.md': fm('type: design\ndocs: docs/specs\nlabels: { grup: x }\nnext: { to: build }') })).toEqual(['Khoá `labels.grup` lạ — ý anh là `labels.group`?']);
    expect(msgs({ 'steps/build.md': fm('type: build\nkickoff: { edit: x }\nnext: { to: done }') })).toEqual(['Khoá `kickoff.edit` lạ']);
    expect(msgs({ 'steps/lane.md': fm('type: lane\nphases: [done]\nskills_deny: [{ skil: x }]') })).toEqual(['Khoá `skills_deny.skil` lạ — ý anh là `skills_deny.skill`?', '`skills_deny` thiếu `skill`']);
  });
  test('V15 docs absolute or with ..', () => {
    expect(msgs({ 'steps/design.md': fm('type: design\ndocs: /etc\nnext: { to: build }') })).toEqual(['`docs` phải là đường dẫn tương đối trong project, không có `..`']);
    expect(codes({ 'steps/design.md': fm('type: design\ndocs: docs/../..\nnext: { to: build }') })).toEqual(['V15']);
    expect(codes(wf('doc_label: Spec\ndocs_done: ../x'))).toEqual(['V15']);
  });
});

describe('§5.4 V11 V14 sizes and slots', () => {
  test('V11 a body over 16 KB, a pack over 256 KB', () => {
    expect(codes({ 'steps/general.md': fm('type: general', 'x'.repeat(16 * 1024 + 1)) })).toEqual(['V11']);
    const big: Record<string, string> = {};
    for (let i = 0; i < 17; i++) big[`steps/g${i}.md`] = fm('type: general', 'x'.repeat(16 * 1024 - 10));
    expect(codes(big)).toContain('V11');
  });
  test('V14 an unknown slot, a slot of another type, a required slot twice', () => {
    expect(msgs({ 'steps/general.md': fm('type: general', '{{tool}}') })).toEqual(['Ô `{{tool}}` lạ']);
    expect(msgs({ 'steps/general.md': fm('type: general', '{{phases}}') })).toEqual(['Ô `{{phases}}` không dùng ở bước general']);
    expect(msgs({ 'steps/general.md': fm('type: general', '{{ask}}\n{{ask}}') })).toEqual(['Ô `{{ask}}` xuất hiện 2 lần']);
    expect(msgs({ ...wf('doc_label: Spec', '{{ask}}'), 'steps/lane.md': fm('type: lane\nphases: [done]', '{{ask}}') })).toEqual(['Ô `{{ask}}` xuất hiện 2 lần']);
    expect(codes({ 'steps/lane.md': fm('type: lane\nphases: [done]', '{{phases}} {{rule:trailer}} {{rule:priority_first}} {{skills_blocked}}') })).toEqual([]);
    expect(msgs({ 'steps/lane.md': fm('type: lane\nphases: [done]', '{{rule:max_doc_sessions}}') })).toEqual(['Ô `{{rule:max_doc_sessions}}` lạ']);
  });
});

describe('§5.4 warnings (the pack still saves)', () => {
  const deny = { 'steps/lane.md': fm('type: lane\nphases: [done]\nskills_deny: [superpowers:brainstorming, { skill: my-skill, reason: "vì" }]', 'Không dùng superpowers:writing-plans.') };
  test('a required plugin not installed warns; a blocked skill not installed does not (ruling 01:20: that deny is a no-op)', () => {
    const r = validatePack(packWith({ ...deny, ...wf('doc_label: Spec\nrequire_plugins: [superpowers]') }), { plugins: new Set() });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.msg)).toEqual(['Plugin `superpowers` chưa cài: lane sẽ bị chặn tới khi cài']);
  });
  test('the body still names a skill that was blocked before and is not now', () => {
    const r = validatePack(packWith(deny), { prevDeny: ['superpowers:writing-plans', 'superpowers:brainstorming'] });
    expect(r.warnings.map((w) => [w.step, w.msg])).toEqual([['lane', 'Lời dặn còn nhắc skill đã bỏ chặn: superpowers:writing-plans']]);
  });
  test('instructions over 200 lines', () => {
    const r = validatePack(packWith({ 'steps/general.md': fm('type: general', 'x\n'.repeat(201)) }));
    expect(r.warnings.map((w) => w.msg)).toEqual(['Lời dặn dài 201 dòng (nên ≤ 200)']);
  });
  test('V12 a skill name with a newline / tab / bracket is refused (it lands in the gate .tsv and permissions.deny)', () => {
    const bad = '`skills_deny`: tên skill không hợp lệ';
    expect(msgs({ 'steps/lane.md': fm('type: lane\nphases: [done]\nskills_deny: [{ skill: "evil\\nfoo" }]') })).toEqual([bad]);
    expect(msgs({ 'steps/lane.md': fm('type: lane\nphases: [done]\nskills_deny: ["a\\tb"]') })).toEqual([bad]);
    expect(msgs({ 'steps/lane.md': fm('type: lane\nphases: [done]\nskills_deny: ["a), Bash(x"]') })).toEqual([bad]);
  });
  test('skills_deny entries: a bare string or {skill, reason}; reason kept verbatim', () => {
    const s = validatePack(packWith(deny)).workflow!.steps.find((x) => x.id === 'lane')!;
    expect(s.deny).toEqual([{ skill: 'superpowers:brainstorming', reason: null }, { skill: 'my-skill', reason: 'vì' }]);
  });
});
