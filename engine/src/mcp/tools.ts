// Engine MCP tool registry (spec §7.7, M2/M3/M4/I16). The caller identity comes from the bearer token only; `from`,
// `projectId` or (for a lane) `name` arguments are never trusted. Role gating: a lane may call `lane_set_phase` (on
// itself), `po_ask` and the v2.7 issue tools of its role (issue-tools.ts); every orchestrator call of a lane / issue /
// spec tool first passes §5.5-8 by the session's kind (`gateTool`).
import { existsSync } from 'node:fs';
import { CardError, ORCH_SOURCE } from '../cards/store.ts';
import { LaneError } from '../lane/manager.ts';
import { nameTakenText } from '../orchestrator/owners.ts';
import { gateTool, ISSUE_TOOLS, prepareLaneStart } from './issue-tools.ts';
import { SPEC_TOOLS } from './spec-tools.ts';
import { lanePhases, sessionRev, toolText, type ToolText } from '../workflow/runtime.ts';
import {
  BOTH, fixed, mustOwn, O, obj, opt, str, ToolError, type Args, type Identity, type McpLanes, type Role, type Schema,
  type ToolDef, type ToolDeps,
} from './tool-kit.ts';

const nameOnly = fixed(obj({ name: str('tên lane') }, ['name']));

/** Wraps a command tool's `run` with the §4.14 owner check on `a.name`. */
const owned = (run: ToolDef['run']): ToolDef['run'] => (d, who, a) => { mustOwn(d, who, a.name as string); return run(d, who, a); };

const LANE_TOOLS: readonly ToolDef[] = [
  {
    name: 'lanes_list', roles: O, schema: fixed(obj({})),
    description: 'Lane của project: trạng thái, phase, account, thẻ đang mở, số lỗi, lỗi cuối, worktree còn/không.',
    run: (d, who) => {
      const exists = d.worktreeExists ?? existsSync;
      const open = d.cards.list({ status: 'open', projectId: who.projectId });
      return {
        lanes: d.lanes.list(who.projectId).map((l) => {
          const o = d.owners?.ownerOf(who.projectId, l.name) ?? null; // §4.14 every session sees every lane + its owner
          return {
            name: l.name, state: l.state, phase: l.phase, account: l.account, failCount: l.failCount, lastError: l.lastError,
            openCards: open.filter((c) => c.sessionId === l.sessionId).map((c) => c.id), worktree: exists(l.cwd), cwd: l.cwd,
            owner: o?.seq ?? null, mine: o === null || o.sessionId === who.sessionId,
            model: l.run?.model ?? null, effort: l.run?.effort ?? null, // v2.4 §5.6 what the lane runs (null: not read yet)
          };
        }),
      };
    },
  },
  {
    name: 'lane_start', roles: O,
    description: 'Mở lane mới. Tên duy nhất trong project; account sai vai trò / đầy / đăng xuất / quá số lane → lỗi kèm lý do. ' +
      'model / effort: bỏ trống trừ khi brief hoặc PO yêu cầu; bỏ trống thì lane chạy model / effort của agent, không có thì mặc định của PO (Cài đặt › Model).',
    schema: fixed(obj({
      name: str(), cwd: str('worktree tuyệt đối'), brief_path: str(), agent: str(), model: str(), effort: str(), account: str(),
      issue: str('mã mục lane nhận, vd T-47 (v2.7 §5.3)'),
    }, ['name', 'cwd', 'brief_path'])),
    run: async (d, who, a) => {
      const o: Parameters<McpLanes['start']>[0] = { projectId: who.projectId, name: a.name as string, cwd: a.cwd as string, briefPath: a.brief_path as string, ownerSession: who.sessionId };
      for (const k of ['agent', 'model', 'effort', 'account'] as const) { const v = opt<string>(a, k); if (v !== undefined) o[k] = v; }
      const take = await prepareLaneStart(d.issues, who, opt<string>(a, 'issue'), o.cwd);
      const v = await d.lanes.start(o).catch((e: unknown) => {
        take?.release(); // R-B13 (c) the issue is free again
        // §4.14 UNIQUE(project_id, name) across sessions: name the owner so the orchestrator picks another name
        if (d.owners && e instanceof LaneError && e.code === 'name_taken') throw new ToolError(nameTakenText(o.name, d.owners.ownerOf(who.projectId, o.name)?.seq ?? null));
        throw e;
      });
      return { name: v.name, state: v.state, account: v.account, ...(take ? await take.take(d.lanes, v) : {}) };
    },
  },
  {
    name: 'lane_message', roles: O, description: 'Gửi tin cho lane qua hộp thư đi.',
    schema: fixed(obj({ name: str(), text: str() }, ['name', 'text'])),
    run: owned(async (d, who, a) => { await d.lanes.message(who.projectId, a.name as string, a.text as string, 'orchestrator'); return { ok: true }; }),
  },
  {
    name: 'lane_interrupt', roles: O, description: 'Ngắt lượt đang chạy của lane.', schema: nameOnly,
    run: owned(async (d, who, a) => { await d.lanes.interrupt(who.projectId, a.name as string); return { ok: true }; }),
  },
  {
    name: 'lane_stop', roles: O, description: 'Dừng lane: drain = dừng an toàn, now = dừng ngay.',
    schema: fixed(obj({ name: str(), mode: { type: 'string', enum: ['drain', 'now'] } }, ['name', 'mode'])),
    run: owned(async (d, who, a) => { await d.lanes.stop(who.projectId, a.name as string, a.mode as 'drain' | 'now'); return { ok: true }; }),
  },
  {
    name: 'lane_resume', roles: O, description: 'Chạy lại lane Đã dừng / Hỏng, giữ ngữ cảnh.', schema: nameOnly,
    run: owned(async (d, who, a) => { await d.lanes.resume(who.projectId, a.name as string); return { ok: true }; }),
  },
  {
    name: 'lane_finish', roles: O, description: 'Kết thúc lane (Xong), giải phóng worktree.',
    schema: fixed(obj({ name: str(), force: { type: 'boolean' } }, ['name'])),
    run: owned(async (d, who, a) => { await d.lanes.finish(who.projectId, a.name as string, a.force === true); return { ok: true }; }),
  },
  {
    name: 'lane_result', roles: O, description: 'Toàn văn `result` cuối của lane.', schema: nameOnly,
    run: (d, who, a) => ({ result: d.lanes.result(who.projectId, a.name as string) }),
  },
  {
    name: 'lane_tail', roles: O, description: 'n tin / công cụ cuối của lane.',
    schema: fixed(obj({ name: str(), n: { type: 'integer', minimum: 1, maximum: 200 } }, ['name'])),
    run: (d, who, a) => ({ lines: d.lanes.tail(who.projectId, a.name as string, opt<number>(a, 'n') ?? 20) }),
  },
  {
    name: 'lane_set_phase', roles: BOTH,
    description: 'Đặt phase ({phases}), task, note = dòng tóm tắt. Lane chỉ đặt cho chính nó.',
    schema: (role, phases) => {
      const p: Record<string, Schema> = { phase: phases.length > 0 ? { type: 'string', enum: [...phases] } : str(), task: str(), note: str('dòng tóm tắt') };
      return role === 'orchestrator' ? obj({ name: str(), ...p }, ['name', 'phase']) : obj(p, ['phase']);
    },
    run: async (d, who, a) => {
      let name: string;
      if (who.role === 'lane') {
        const me = d.lanes.bySession(who.sessionId);
        if (!me) throw new ToolError('Không tìm thấy lane của session này');
        name = me.name;
      } else { name = a.name as string; mustOwn(d, who, name); }
      const own = lanePhases(d.issues.db, who.projectId, name); // v2.9 §6.1 the phases of the lane's own rev
      if (own && !own.includes(a.phase as string)) throw new ToolError(`lane ${name} không có phase ${a.phase as string}: phase phải là một trong ${own.join('/')}`);
      const p: { phase: string; task?: string; note?: string } = { phase: a.phase as string };
      const task = opt<string>(a, 'task');
      const note = opt<string>(a, 'note');
      if (task !== undefined) p.task = task;
      if (note !== undefined) p.note = note;
      await d.lanes.setPhase(who.projectId, name, p);
      return { ok: true, name, phase: p.phase };
    },
  },
  {
    name: 'accounts_usage', roles: O, description: 'Quota từng account (5 giờ / tuần, giờ reset).', schema: fixed(obj({})),
    run: (d) => ({ accounts: d.usage() }),
  },
  {
    name: 'po_ask', roles: BOTH,
    description: 'Hỏi PO. Trả id thẻ ngay; câu trả lời đến sau qua hộp thư đi dạng "[cc-slaves] PO trả lời #<id>: …".',
    schema: fixed(obj({
      question: str(),
      options: { type: 'array', maxItems: 4, items: obj({ label: str(), description: str() }, ['label']) },
      recommended: str('nhãn phương án Đề xuất'), context: str(),
    }, ['question'])),
    run: (d, who, a) => {
      const source = who.role === 'orchestrator' ? ORCH_SOURCE : (d.lanes.bySession(who.sessionId)?.name ?? 'lane');
      const options = ((a.options as { label: string; description?: string }[] | undefined) ?? [])
        .map((o) => (o.description === undefined ? { label: o.label } : { label: o.label, description: o.description }));
      const c = d.cards.ask({
        projectId: who.projectId, sessionId: who.sessionId, source, question: a.question as string, options,
        recommended: opt<string>(a, 'recommended'), context: opt<string>(a, 'context'),
      });
      return { card_id: c.id, text: `Đã tạo thẻ #${c.id}; câu trả lời của PO sẽ đến sau qua tin nhắn.` };
    },
  },
  {
    name: 'notify', roles: O, description: 'Báo PO (macOS / Google Chat).',
    schema: fixed(obj({ level: { type: 'string', enum: ['info', 'warn', 'error'] }, text: str() }, ['level', 'text'])),
    run: (d, who, a) => { d.notify(who.projectId, a.level as 'info' | 'warn' | 'error', a.text as string); return { ok: true }; },
  },
];

export const TOOLS: readonly ToolDef[] = [...LANE_TOOLS, ...ISSUE_TOOLS, ...SPEC_TOOLS];

const TYPE_VI: Record<Schema['type'], string> = {
  object: 'đối tượng', string: 'chuỗi', integer: 'số nguyên', boolean: 'true/false', array: 'danh sách',
};

/** Validates `v` against `s`; returns a Vietnamese reason or null. Extra properties are ignored (never read). */
function validate(s: Schema, v: unknown, path = 'arguments'): string | null {
  if (v === null && s.nullable) return null;
  switch (s.type) {
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${path} phải là ${TYPE_VI.object}`;
      const o = v as Args;
      for (const k of s.required ?? []) if (o[k] === undefined || o[k] === null) return `Thiếu tham số bắt buộc ${k}`;
      for (const [k, sub] of Object.entries(s.properties ?? {})) {
        if (o[k] === undefined) continue;
        const e = validate(sub, o[k], k);
        if (e) return e;
      }
      return null;
    }
    case 'string':
      if (typeof v !== 'string') return `${path} phải là ${TYPE_VI.string}`;
      if (s.enum && !s.enum.includes(v)) return `${path} phải là một trong: ${s.enum.join(', ')}`;
      return null;
    case 'integer':
      if (typeof v !== 'number' || !Number.isInteger(v)) return `${path} phải là ${TYPE_VI.integer}`;
      if (s.minimum !== undefined && v < s.minimum) return `${path} phải ≥ ${s.minimum}`;
      if (s.maximum !== undefined && v > s.maximum) return `${path} phải ≤ ${s.maximum}`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${path} phải là ${TYPE_VI.boolean}`;
    case 'array': {
      if (!Array.isArray(v)) return `${path} phải là ${TYPE_VI.array}`;
      if (s.maxItems !== undefined && v.length > s.maxItems) return `${path} tối đa ${s.maxItems} mục`;
      for (const [i, x] of v.entries()) { const e = s.items ? validate(s.items, x, `${path}[${i}]`) : null; if (e) return e; }
      return null;
    }
  }
}

/** Keeps only the declared properties, so handlers never see an undeclared arg (`from`, `projectId`, …). */
function pickDeclared(s: Schema, a: Args): Args {
  const out: Args = {};
  for (const k of Object.keys(s.properties ?? {})) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: true }
const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** v2.9 §5.6 `{doc}` / `{docs}` / `{design}` / `{build}` / `{phases}` of a description, in every string of a schema too. */
function fill<T>(v: T, x: ToolText): T {
  if (typeof v === 'string') return v.replace(/\{(doc|docs|design|build|phases)\}/g, (_m, k: Exclude<keyof ToolText, 'phases'> | 'phases') => (k === 'phases' ? x.phases.join('/') : x[k])) as T;
  if (Array.isArray(v)) return v.map((e: unknown) => fill(e, x)) as T;
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, fill(e, x)])) as T;
  return v;
}

/** v2.9 §6.1 the tool texts of the workflow rev the session runs. */
/** Ruling 22:36 a missing rev: the default texts, a free-text phase (lane_set_phase skips its check), never a throw. */
const NO_REV: ToolText = { doc: 'tài liệu', docs: 'docs', phases: [], design: 'Thiết kế', build: 'Build' };
export const sessionToolText = (db: ToolDeps['issues']['db'], sessionId: string): ToolText => {
  const w = sessionRev(db, sessionId);
  return w ? toolText(w) : NO_REV;
};

/** `tools/list` for `role` in the words of the caller's workflow (§6.1: the lane phase enum of its rev). */
export const listTools = (role: Role, x: ToolText) =>
  TOOLS.filter((t) => t.roles.includes(role)).map((t) => ({ name: t.name, description: fill(t.description, x), inputSchema: fill(t.schema(role, x.phases), x) }));

export const findTool = (name: string): ToolDef | undefined => TOOLS.find((t) => t.name === name);

/** tools/call for a known tool: gating, schema, then the handler; every failure is an MCP tool error (isError). */
/** The tools that write specs / issues (or take one into a lane): their project's views are pushed after a success. */
const ISSUE_PUSH = /^(issue|issues|spec)_|^lane_start$/;

export async function callTool(d: ToolDeps, who: Identity, t: ToolDef, rawArgs: unknown): Promise<ToolResult> {
  if (!t.roles.includes(who.role)) {
    return fail(who.role === 'lane' ? `Lane không được gọi ${t.name} — chỉ Điều phối dùng công cụ này` : `${t.name} chỉ dành cho lane đang giữ mục`);
  }
  const schema = t.schema(who.role, sessionToolText(d.issues.db, who.sessionId).phases);
  const args = rawArgs === undefined ? {} : rawArgs;
  const bad = validate(schema, args);
  if (bad) return fail(`Tham số không hợp lệ: ${bad}`);
  try {
    const a = pickDeclared(schema, args as Args);
    gateTool(d.issues, who, t.name, a);
    const r = ok(await t.run(d, who, a));
    if (ISSUE_PUSH.test(t.name)) d.issues.changed(who.projectId);
    return r;
  } catch (e) {
    if (e instanceof LaneError || e instanceof CardError || e instanceof ToolError) return fail(e.message);
    return fail(`Lỗi engine: ${e instanceof Error ? e.message : String(e)}`);
  }
}
