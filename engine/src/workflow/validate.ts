// spec v2.9 §5.4 the pack check (pure): V1–V15 errors (the pack cannot be saved / applied) + warnings, and on success the
// normalised workflow §5.3 / §5.5 / §5.7 that `compile.ts` turns into session texts. Every finding is one Vietnamese sentence.
import { packRev, parsePack, type PackDoc, type PackFiles, type PackIssue, type PackStep } from './pack.ts';
import {
  BOOL_RULES, DEFAULT_RULES, DONE_ID, KICKOFF_KEYS, LABEL_KEYS, LAST_PHASE, LIMITS, MAX_DOC_SESSIONS, NEXT_KEYS, OPTIONAL_SLOTS,
  PHASE_RE, REQUIRED_SLOTS, RULE_SLOTS, SKILL_DENY_KEYS, SLOT_RE, START_VALUES, STEP_KEYS, STEP_TYPES, TYPE_NAME, WORKFLOW_KEYS,
  type KickoffKey, type LabelKey, type Rules, type StartMode, type StepType,
} from './vocab.ts';

interface DenyEntry { skill: string; reason: string | null }
export interface WorkflowStep {
  id: string; type: StepType; name: string; body: string;
  docs: string | null; labels: Partial<Record<LabelKey, string>>; kickoff: Partial<Record<KickoffKey, string>>;
  deny: DenyEntry[]; next: { to: string; start: StartMode | null } | null; phases: string[] | null;
}
export interface Workflow {
  rev: string; name: string; description: string; docLabel: string; docsDone: string; requirePlugins: string[]; rules: Rules;
  basedOn: string | null; settled: string | null; body: string;
  /** Chain order first (§5.3), then general, then lane. */
  steps: WorkflowStep[];
  /** The doc / build step ids from the first to the last before Xong. */
  chain: string[];
}
export interface ValidateEnv {
  /** Installed + enabled plugins; absent = not checked. */
  plugins?: ReadonlySet<string>;
  /** The skills the saved rev blocked (§5.6 "lời dặn còn nhắc skill đã bỏ chặn"). */
  prevDeny?: readonly string[];
}
export interface Checked { errors: PackIssue[]; warnings: PackIssue[]; workflow: Workflow | null }

type At = { file: string; step?: string };
type Push = (code: PackIssue['code'], msg: string) => void;
const at = (d: PackDoc, step?: string): At => (step === undefined ? { file: d.file } : { file: d.file, step });

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}
/** V13 "ý anh là …?" for a typo within a third of the key's length. */
function suggest(key: string, known: readonly string[]): string {
  const best = known.map((k) => ({ k, d: distance(key, k) })).sort((x, y) => x.d - y.d)[0];
  return best && best.d <= Math.max(1, Math.floor(key.length / 3)) ? ` — ý anh là \`${best.k}\`?` : '';
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isTable = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const badRel = (p: string) => p === '' || p.startsWith('/') || p.startsWith('~') || p.split('/').includes('..');

/** An optional string key: `undefined` when absent, a V12 when of another type. */
function optStr(fm: Record<string, unknown>, key: string, push: Push): string | undefined {
  const v = fm[key];
  if (v === undefined || v === null) return undefined;
  if (!isStr(v)) { push('V12', `\`${key}\` phải là chữ`); return undefined; }
  return v;
}

/** A flow / block table of strings with a closed key set (labels, kickoff, next). */
function strTable(v: unknown, key: string, known: readonly string[], push: Push): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isTable(v)) { push('V12', `\`${key}\` phải là bảng khoá`); return {}; }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!known.includes(k)) { push('V13', `Khoá \`${key}.${k}\` lạ${suggest(k, known).replace('`', `\`${key}.`)}`); continue; }
    if (!isStr(x)) { push('V12', `\`${key}.${k}\` phải là chữ`); continue; }
    out[k] = x;
  }
  return out;
}

function unknownKeys(fm: Record<string, unknown>, allowed: readonly string[], other: readonly string[], where: string, push: Push): void {
  for (const k of Object.keys(fm)) {
    if (allowed.includes(k)) continue;
    push('V13', other.includes(k) ? `Khoá \`${k}\` không dùng ở bước ${where}` : `Khoá \`${k}\` lạ${suggest(k, allowed)}`);
  }
}

function rulesOf(v: unknown, push: Push): Rules {
  const r: Rules = { ...DEFAULT_RULES };
  if (v === undefined || v === null) return r;
  if (!isTable(v)) { push('V12', '`rules` phải là bảng khoá'); return r; }
  const known = [...BOOL_RULES, 'max_doc_sessions'];
  for (const [k, x] of Object.entries(v)) {
    if (k === 'max_doc_sessions') {
      if (typeof x !== 'number' || !Number.isInteger(x) || x < MAX_DOC_SESSIONS.min || x > MAX_DOC_SESSIONS.max) {
        push('V12', `Luật \`max_doc_sessions\` phải là số nguyên ${MAX_DOC_SESSIONS.min}–${MAX_DOC_SESSIONS.max}`);
      } else r.max_doc_sessions = x;
    } else if ((BOOL_RULES as readonly string[]).includes(k)) {
      if (typeof x !== 'boolean') push('V12', `Luật \`${k}\` phải là true / false`);
      else r[k as (typeof BOOL_RULES)[number]] = x;
    } else push('V12', `Luật \`${k}\` lạ${suggest(k, known)}`);
  }
  return r;
}

type WorkflowHead = Omit<Workflow, 'rev' | 'steps' | 'chain'>;

function checkWorkflow(d: PackDoc, push: Push): WorkflowHead {
  unknownKeys(d.fm, WORKFLOW_KEYS, [], 'WORKFLOW.md', push);
  const name = optStr(d.fm, 'name', push);
  if (name === undefined || name.trim() === '') { if (d.fm.name === undefined || isStr(d.fm.name)) push('V12', 'Thiếu `name` của quy trình'); }
  const docsDone = optStr(d.fm, 'docs_done', push) ?? 'done';
  if (badRel(docsDone)) push('V15', '`docs_done` phải là đường dẫn tương đối trong project, không có `..`');
  const plugins = d.fm.require_plugins;
  if (plugins !== undefined && plugins !== null && !isStrList(plugins)) push('V12', '`require_plugins` phải là danh sách chữ');
  return {
    name: name ?? '', description: optStr(d.fm, 'description', push) ?? '', docLabel: (optStr(d.fm, 'doc_label', push) ?? '').trim(), docsDone,
    requirePlugins: isStrList(plugins) ? plugins : [], rules: rulesOf(d.fm.rules, push),
    basedOn: optStr(d.fm, 'based_on', push) ?? null, settled: optStr(d.fm, 'settled', push) ?? null, body: d.body,
  };
}

/** A skill name is written raw into the gate `.tsv` and `permissions.deny` (`Skill(name)`): `[plugin:]name`, no space / tab / newline / bracket. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

function denyOf(v: unknown, push: Push): DenyEntry[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { push('V12', '`skills_deny` phải là danh sách'); return []; }
  const out: DenyEntry[] = [];
  const add = (skill: string, reason: string | null) => {
    if (SKILL_NAME_RE.test(skill)) out.push({ skill, reason }); else push('V12', '`skills_deny`: tên skill không hợp lệ');
  };
  for (const x of v) {
    if (isStr(x) && x.trim()) { add(x.trim(), null); continue; }
    if (!isTable(x)) { push('V12', '`skills_deny` mỗi dòng là tên skill hoặc { skill, reason }'); continue; }
    const t = strTable(x, 'skills_deny', SKILL_DENY_KEYS, push);
    if (!t.skill?.trim()) { push('V12', '`skills_deny` thiếu `skill`'); continue; }
    add(t.skill.trim(), t.reason?.trim() ? t.reason : null);
  }
  return out;
}

function phasesOf(v: unknown, push: Push): string[] | null {
  if (v === undefined || v === null) { push('V9', 'Bước lane thiếu `phases`'); return null; }
  if (!isStrList(v)) { push('V9', '`phases` phải là danh sách chữ'); return null; }
  if (v.length === 0) { push('V9', 'Danh sách pha rỗng'); return null; }
  const before = v.length;
  const bad = v.find((p) => !PHASE_RE.test(p));
  if (bad !== undefined) push('V9', `Pha \`${bad}\` sai dạng: a-z, 0-9, dấu - (tối đa 16 ký tự)`);
  const dup = v.find((p, i) => v.indexOf(p) !== i);
  if (dup !== undefined) push('V9', `Pha \`${dup}\` trùng`);
  if (before > LIMITS.maxPhases) push('V9', `Quá ${LIMITS.maxPhases} pha (đang có ${before})`);
  if (v[v.length - 1] !== LAST_PHASE) push('V9', `Pha cuối phải là \`${LAST_PHASE}\``);
  return v;
}

function nextOf(v: unknown, type: StepType, push: Push): WorkflowStep['next'] {
  if (v === undefined || v === null) return type === 'build' ? { to: DONE_ID, start: null } : null;
  const t = strTable(v, 'next', NEXT_KEYS, push);
  if (!t.to) { push('V12', '`next` thiếu `to`'); return null; }
  let start: StartMode | null = null;
  if (t.start !== undefined) {
    if (!(START_VALUES as readonly string[]).includes(t.start)) push('V8', '`start` phải là button hoặc auto');
    else if (t.to === DONE_ID) push('V8', '`start` không dùng ở cạnh tới Xong');
    else start = t.start as StartMode;
  }
  return { to: t.to, start };
}

function checkStep(s: PackStep, push: Push): WorkflowStep | null {
  const type = s.fm.type;
  if (!isStr(type) || !(STEP_TYPES as readonly string[]).includes(type)) {
    push('V4', type === undefined ? 'Bước thiếu `type`' : `Loại bước \`${isStr(type) ? type : JSON.stringify(type)}\` lạ: ${STEP_TYPES.join(', ').replace(/, (?=[^,]*$)/, ' hoặc ')}`);
    return null;
  }
  const ty = type as StepType;
  const allKeys = [...new Set(Object.values(STEP_KEYS).flat())];
  unknownKeys(s.fm, STEP_KEYS[ty], allKeys, ty, push);
  const docs = ty === 'design' ? optStr(s.fm, 'docs', push) : undefined;
  if (ty === 'design' && docs === undefined && !isStr(s.fm.docs)) push('V12', 'Bước soạn tài liệu thiếu `docs`');
  if (docs !== undefined && badRel(docs)) push('V15', '`docs` phải là đường dẫn tương đối trong project, không có `..`');
  const allowed = STEP_KEYS[ty];
  return {
    id: s.id, type: ty, name: optStr(s.fm, 'name', push)?.trim() || TYPE_NAME[ty], body: s.body, docs: docs ?? null,
    labels: allowed.includes('labels') ? strTable(s.fm.labels, 'labels', LABEL_KEYS, push) : {},
    kickoff: ty === 'design' || ty === 'build' ? strTable(s.fm.kickoff, 'kickoff', KICKOFF_KEYS[ty], push) : {},
    deny: denyOf(s.fm.skills_deny, push),
    next: allowed.includes('next') ? nextOf(s.fm.next, ty, push) : null,
    phases: ty === 'lane' ? phasesOf(s.fm.phases, push) : null,
  };
}

/** §5.3 one straight chain doc₁ → … → docₙ → build → Xong; returns the order, or pushes V6 / V7. */
function checkChain(steps: readonly WorkflowStep[], push: (code: PackIssue['code'], msg: string, step?: string) => void): string[] {
  const chain = steps.filter((s) => s.type === 'design' || s.type === 'build');
  const designs = chain.filter((s) => s.type === 'design').length;
  const builds = chain.length - designs;
  if (designs > LIMITS.maxDocs) push('V7', `Quá ${LIMITS.maxDocs} bước soạn tài liệu (đang có ${designs})`);
  if (builds > LIMITS.maxBuild) push('V7', `Quá ${LIMITS.maxBuild} bước Build (đang có ${builds})`);
  const byId = new Map(steps.map((s) => [s.id, s]));
  let broken = false;
  for (const s of chain) {
    if (!s.next) { push('V7', `\`${s.id}\` chưa nối tới bước sau (hoặc Xong)`, s.id); broken = true; continue; }
    const to = s.next.to;
    if (to === DONE_ID) continue;
    const t = byId.get(to);
    if (!t) { push('V6', `\`next.to\` ${to}: không có bước này`, s.id); broken = true; continue; }
    if (s.type === 'build') { push('V7', 'Build chỉ nối tới Xong', s.id); broken = true; }
    else if (t.type !== 'design' && t.type !== 'build') { push('V7', `\`${s.id}\` chỉ nối tới bước soạn tài liệu, Build hoặc Xong`, s.id); broken = true; }
  }
  if (broken || chain.length === 0) return [];
  const into = new Map<string, string[]>();
  for (const s of chain) {
    if (s.next!.to === DONE_ID) continue;
    const l = into.get(s.next!.to) ?? [];
    l.push(s.id);
    into.set(s.next!.to, l);
  }
  for (const [to, from] of into) if (from.length > 1) push('V7', `Rẽ nhánh: ${from.map((f) => `\`${f}\``).join(', ')} cùng nối tới \`${to}\``, to);
  const starts = chain.filter((s) => !into.has(s.id));
  if (starts.length !== 1) {
    push('V7', starts.length === 0 ? 'Chuỗi có vòng: không có bước đầu' : `Chuỗi phải bắt đầu từ đúng một bước (đang có ${starts.length}: ${starts.map((s) => s.id).join(', ')})`);
    return [];
  }
  const order: string[] = [];
  for (let s: WorkflowStep | undefined = starts[0]; s && !order.includes(s.id); s = byId.get(s.next!.to)) order.push(s.id);
  for (const s of chain) if (!order.includes(s.id)) push('V7', `\`${s.id}\` không tới được từ đầu chuỗi`, s.id);
  return order.length === chain.length ? order : [];
}

/** §5.6 / V14 the slots of one step's text (WORKFLOW body + step body). */
function checkSlots(text: string, type: StepType, push: Push): void {
  const ok = new Set([...REQUIRED_SLOTS[type], ...OPTIONAL_SLOTS[type], ...RULE_SLOTS.map((r) => `rule:${r}`)]);
  const anyType = new Set(Object.values(OPTIONAL_SLOTS).flat());
  const seen = new Map<string, number>();
  for (const m of text.matchAll(SLOT_RE)) seen.set(m[1]!, (seen.get(m[1]!) ?? 0) + 1);
  for (const [slot, n] of seen) {
    if (!ok.has(slot)) push('V14', anyType.has(slot) ? `Ô \`{{${slot}}}\` không dùng ở bước ${type}` : `Ô \`{{${slot}}}\` lạ`);
    else if (n > 1 && REQUIRED_SLOTS[type].includes(slot)) push('V14', `Ô \`{{${slot}}}\` xuất hiện ${n} lần`);
  }
}

const joinBodies = (a: string, b: string) => [a, b].filter((x) => x !== '').join('\n');
const lineCount = (s: string) => (s === '' ? 0 : s.split('\n').length);

function warningsOf(head: WorkflowHead, steps: readonly WorkflowStep[], env: ValidateEnv, warn: (msg: string, step?: string) => void): void {
  if (env.plugins) for (const p of head.requirePlugins) if (!env.plugins.has(p)) warn(`Plugin \`${p}\` chưa cài: lane sẽ bị chặn tới khi cài`);
  if (lineCount(head.body) > LIMITS.longBodyLines) warn(`Lời dặn dài ${lineCount(head.body)} dòng (nên ≤ ${LIMITS.longBodyLines})`);
  for (const s of steps) {
    const blocked = new Set(s.deny.map((d) => d.skill));
    const named = (env.prevDeny ?? []).filter((k) => !blocked.has(k) && new RegExp(`(^|[^\\w:-])(${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})($|[^\\w-])`).test(s.body));
    if (named.length) warn(`Lời dặn còn nhắc skill đã bỏ chặn: ${named.join(', ')}`, s.id);
    if (lineCount(s.body) > LIMITS.longBodyLines) warn(`Lời dặn dài ${lineCount(s.body)} dòng (nên ≤ ${LIMITS.longBodyLines})`, s.id);
  }
}

/** §5.4 the whole check over a files map (save, import, a changed file on disk). */
export function validatePack(files: PackFiles, env: ValidateEnv = {}): Checked {
  const { pack, errors } = parsePack(files);
  const warnings: PackIssue[] = [];
  const pusher = (a: At): Push => (code, msg) => { errors.push({ code, ...a, msg }); };
  const total = Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0);
  if (total > LIMITS.totalBytes) errors.push({ code: 'V11', msg: `Gói quá ${LIMITS.totalBytes / 1024} KB` });
  const docs: PackDoc[] = [...(pack.workflow ? [pack.workflow] : []), ...pack.steps];
  for (const d of docs) if (Buffer.byteLength(d.body) > LIMITS.bodyBytes) errors.push({ code: 'V11', ...at(d), msg: `Lời dặn quá ${LIMITS.bodyBytes / 1024} KB` });
  const head = pack.workflow ? checkWorkflow(pack.workflow, pusher(at(pack.workflow))) : null;
  const steps = pack.steps.map((s) => checkStep(s, pusher(at(s, s.id)))).filter((s): s is WorkflowStep => s !== null);
  for (const type of ['general', 'lane'] as const) {
    const n = steps.filter((s) => s.type === type).length;
    if (n !== 1) errors.push({ code: 'V5', msg: `Gói cần đúng 1 bước ${type} (đang có ${n})` });
  }
  const chain = checkChain(steps, (code, msg, step) => { errors.push(step === undefined ? { code, msg } : { code, step, msg }); });
  if (head) {
    const hasDoc = steps.some((s) => s.type === 'design');
    const p = pusher(at(pack.workflow!));
    if (hasDoc && head.docLabel === '') p('V10', 'Có bước soạn tài liệu thì `doc_label` không được trống');
    if (!hasDoc && head.docLabel !== '') p('V10', '`doc_label` có chữ mà gói không có bước soạn tài liệu');
  }
  for (const s of steps) checkSlots(joinBodies(head?.body ?? '', s.body), s.type, pusher({ file: `steps/${s.id}.md`, step: s.id }));
  if (head) warningsOf(head, steps, env, (msg, step) => { warnings.push(step === undefined ? { code: 'W', msg } : { code: 'W', step, msg }); });
  if (errors.length || !head) return { errors, warnings, workflow: null };
  const rank = (s: WorkflowStep) => (s.type === 'general' ? 1 : s.type === 'lane' ? 2 : 0);
  const ordered = [...steps].sort((a, b) => rank(a) - rank(b) || chain.indexOf(a.id) - chain.indexOf(b.id));
  return { errors, warnings, workflow: { ...head, rev: packRev(files), steps: ordered, chain } };
}
