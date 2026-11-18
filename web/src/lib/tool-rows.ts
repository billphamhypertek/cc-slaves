// spec v2.2 §14.5 "Dòng công cụ": the one-line tool row model, grouping of read-only rows and the "Ẩn công cụ" filter.
// Pure; web/src/ui/ToolRow.tsx renders it. The engine's richer `tool_use` / `tool_result` lines (G7) map onto `ToolCall`.

/** Icon family of a tool (§14.5: đọc / sửa / chạy lệnh / tìm / web / MCP / Task). */
export type ToolKind = 'read' | 'edit' | 'bash' | 'search' | 'web' | 'mcp' | 'task' | 'other';
export type ToolState = 'running' | 'ok' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  /** the main parameter: a path, a command, a pattern, a URL */
  arg: string;
  state: ToolState;
  /** run time, null while unknown */
  ms: number | null;
  /** §14.5 S4 (F-M9) a running call: when its tool_use arrived (ms), for the elapsed seconds */
  startedAt?: number;
  /** Edit / Write / MultiEdit: lines added / removed */
  diff?: { add: number; del: number };
  /** the full parameters, shown when the row opens */
  input?: string;
  /** the result (≤ 8 KB from the engine) */
  result?: string;
  /** the engine cut the result at 8 KB; `lines` = its total line count */
  truncated?: { lines: number };
  /** §14.5 S5 a failed Bash call's exit code (absent when the result does not carry one) */
  exitCode?: number;
}

const KIND: Record<string, ToolKind> = {
  Read: 'read', NotebookRead: 'read',
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Bash: 'bash', BashOutput: 'bash', KillShell: 'bash',
  Grep: 'search', Glob: 'search', LS: 'search',
  WebFetch: 'web', WebSearch: 'web',
  Task: 'task', Agent: 'task',
};
export const toolKind = (name: string): ToolKind => KIND[name] ?? (name.startsWith('mcp__') ? 'mcp' : 'other');

/** §14.5 S1 (F-M8) `mcp__<server>__<tool>` → its two parts (the row shows the tool, the server as a small label). */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** §14.5 S1 (F-M8) an MCP call's main argument when the engine had none: the first plain (string / number) input value. */
function firstPlain(input: string | undefined): string {
  const v = Object.values(inputObj(input ?? '') ?? {}).find(x => typeof x === 'string' || typeof x === 'number');
  return v === undefined ? '' : String(v);
}

/** A tool's JSON input as an object; null when it is not one. */
function inputObj(input: string): Record<string, unknown> | null {
  let o: unknown;
  try { o = JSON.parse(input); } catch { return null; }
  return typeof o === 'object' && o !== null && !Array.isArray(o) ? o as Record<string, unknown> : null;
}

// ---------------------------------------------------------------- v2.7 §4.6 cc-slaves' own tools + the blocked Skill row
/** The `cc_slaves` MCP server the engine gives every session (v2.2 §5.1). */
const CCS_SERVER = 'cc_slaves';
/** §4.6 every cc-slaves tool → its Vietnamese label key (catalog `stream.ccs.*`) and the input field naming its subject. */
const CCS_TOOLS: Record<string, { key: CcsKey; arg?: string }> = {
  issue_get: { key: 'issueGet', arg: 'key' }, issues_list: { key: 'issuesList' }, issue_create: { key: 'issueCreate' },
  issue_link: { key: 'issueLink', arg: 'key' }, issue_assign: { key: 'issueAssign', arg: 'key' }, issue_update: { key: 'issueUpdate', arg: 'key' },
  issue_drop: { key: 'issueDrop', arg: 'key' }, issue_done: { key: 'issueDone', arg: 'key' }, issue_revert_conflict: { key: 'issueRevertConflict', arg: 'key' },
  spec_draft: { key: 'specDraft' }, spec_approve: { key: 'specApprove' }, spec_amend: { key: 'specAmend' }, spec_set_branch: { key: 'specSetBranch', arg: 'branch' },
  spec_close: { key: 'specClose' }, spec_output_add: { key: 'specOutputAdd' },
  lanes_list: { key: 'lanesList' }, lane_start: { key: 'laneStart', arg: 'name' }, lane_message: { key: 'laneMessage', arg: 'name' },
  lane_interrupt: { key: 'laneInterrupt', arg: 'name' }, lane_stop: { key: 'laneStop', arg: 'name' }, lane_resume: { key: 'laneResume', arg: 'name' },
  lane_finish: { key: 'laneFinish', arg: 'name' }, lane_result: { key: 'laneResult', arg: 'name' }, lane_tail: { key: 'laneTail', arg: 'name' },
  lane_set_phase: { key: 'laneSetPhase', arg: 'phase' }, accounts_usage: { key: 'accountsUsage' }, po_ask: { key: 'poAsk' }, notify: { key: 'notify' },
};
export type CcsKey = 'issueGet' | 'issuesList' | 'issueCreate' | 'issueCreateBug' | 'issueCreateBugOut' | 'issueCreateArising' | 'issueLink' | 'issueAssign' | 'issueUpdate' | 'issueDrop' | 'issueDone'
  | 'issueRevertConflict' | 'specDraft' | 'specApprove' | 'specAmend' | 'specSetBranch' | 'specClose' | 'specOutputAdd' | 'lanesList' | 'laneStart'
  | 'laneMessage' | 'laneInterrupt' | 'laneStop' | 'laneResume' | 'laneFinish' | 'laneResult' | 'laneTail' | 'laneSetPhase' | 'accountsUsage' | 'poAsk' | 'notify';

/** §4.6 UX-I9 `issue_create` by its input: a bug is "bug" (outside every spec when it names none); work a lane / the
 *  orchestrator found (the default source) is "việc phát sinh"; spec / amend / PO / prior items are a plain "mục". */
function createKey(inp: Record<string, unknown>): CcsKey {
  if (inp.kind === 'bug') return typeof inp.spec === 'string' && inp.spec ? 'issueCreateBug' : 'issueCreateBugOut';
  const src = typeof inp.source === 'string' ? inp.source : 'orchestrator';
  return src === 'orchestrator' || src === 'lane' ? 'issueCreateArising' : 'issueCreate';
}

const KEY_RE = /\b[TB]-[1-9]\d{0,8}\b/;
/** §4.6 a cc-slaves tool's label: the catalog key + its subject (`x`: an issue key, a lane, a branch, a phase; `y`: the
 *  second key / lane). `issue_create` names the key it got from the result (none while it runs / failed). Null = not ours. */
export function ccsLabel(c: Pick<ToolCall, 'name' | 'input' | 'result' | 'state'>): { key: CcsKey; x: string; y: string } | null {
  const m = mcpParts(c.name);
  const t = m?.server === CCS_SERVER ? CCS_TOOLS[m.tool] : undefined;
  if (!t) return null;
  const inp = inputObj(c.input ?? '') ?? {}, str = (k: string) => (typeof inp[k] === 'string' ? inp[k] : '');
  if (t.key === 'issueCreate') {
    const res = c.state === 'ok' ? inputObj(c.result ?? '') : null;
    const key = c.state !== 'ok' ? '' : typeof res?.key === 'string' ? res.key : KEY_RE.exec(c.result ?? '')?.[0] ?? '';
    return { key: createKey(inp), x: key, y: '' };
  }
  const y = t.key === 'issueLink' ? str('blocked_by') : t.key === 'issueAssign' ? str('lane') : '';
  return { key: t.key, x: t.arg ? str(t.arg) : '', y };
}

const BLOCKED_HOOK = 'PreToolUse:Skill hook error:';
const BLOCKED_RULE = 'Skill execution blocked by permission rules';
/** §4.6 R-B5 a `Skill` call the cc-slaves policy refused (not a tool error): the tool_result is an error carrying the hook's
 *  text (`PreToolUse:Skill hook error: <reason>`) or the deny rule's (`Skill execution blocked by permission rules`). `reason`
 *  = the hook's Vietnamese reason without its "Bị chặn có chủ ý — " lead; null for the rule (it carries none). */
export function blockedSkill(c: Pick<ToolCall, 'name' | 'state' | 'result'>): { reason: string | null } | null {
  if (c.name !== 'Skill' || c.state !== 'error' || !c.result) return null;
  const r = c.result.trim(), at = r.indexOf(BLOCKED_HOOK);
  if (at >= 0) return { reason: r.slice(at + BLOCKED_HOOK.length).trim().replace(/^Bị chặn có chủ ý\s*[—-]\s*/, '') || null };
  return r.includes(BLOCKED_RULE) ? { reason: null } : null;
}
/** A real tool error (a refused Skill is the system doing its job, §4.6: never red, never kept by "Ẩn công cụ"). */
const isFailed = (c: ToolCall) => c.state === 'error' && !blockedSkill(c);

/** §14.5 only these are grouped; Edit / Bash / MCP / Task never are (Cursor). */
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);
const GROUP_MIN = 3;
/** §14.5 a row shows its time only past this. */
const SHOW_MS = 2000;
const CMD_MAX = 80;
const PATH_SEGS = 3;

export const showTime = (ms: number | null): boolean => ms !== null && ms > SHOW_MS;

/** §14.5 the short main parameter: `…/src/lib/store.ts` for a path, a command cut at 80 chars, an MCP call's first value. */
export function shortArg(c: Pick<ToolCall, 'name' | 'arg' | 'input'>): string {
  const k = toolKind(c.name);
  const a = (c.arg || (k === 'mcp' ? firstPlain(c.input) : '')).replace(/\s+/g, ' ').trim();
  if (k === 'bash') return a.length > CMD_MAX ? `${a.slice(0, CMD_MAX - 1)}…` : a;
  if ((k === 'read' || k === 'edit') && a.startsWith('/')) {
    const segs = a.split('/').filter(Boolean);
    return segs.length > PATH_SEGS ? `…/${segs.slice(-PATH_SEGS).join('/')}` : a;
  }
  return a;
}

/** The field that is the whole point of a tool's input (§14.5 S5), by kind. */
const MAIN_FIELD: Partial<Record<ToolKind, readonly string[]>> = {
  read: ['file_path', 'notebook_path', 'path'], edit: ['file_path', 'notebook_path', 'path'], search: ['pattern'],
};
const fieldLine = ([k, v]: [string, unknown]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;

/** §14.5 S5 the opened row's parameter line from the engine's JSON input (≤ 2 KB): Bash `$ <command>`, Read / Edit the
 *  path, Grep / Glob the pattern, any other tool `key: value` lines; input that is not a JSON object stays as it came. */
export function paramLine(name: string, input: string): string {
  const rec = inputObj(input), k = toolKind(name);
  if (!rec) return input;
  if (k === 'bash' && typeof rec.command === 'string') return `$ ${rec.command}`;
  const main = MAIN_FIELD[k]?.find(f => typeof rec[f] === 'string');
  return main ? (rec[main] as string) : Object.entries(rec).map(fieldLine).join('\n');
}

/** The list a row opens on: the first 12 lines, then "Xem hết · n dòng". */
const RESULT_HEAD = 12;
export function resultView(result: string, all: boolean): { lines: string[]; total: number; more: boolean } {
  const lines = result.replace(/\n$/, '').split('\n');
  return { lines: all ? lines : lines.slice(0, RESULT_HEAD), total: lines.length, more: !all && lines.length > RESULT_HEAD };
}

export type Row<T> =
  | { k: 'item'; item: T }
  | { k: 'group'; items: T[]; calls: ToolCall[]; state: ToolState; ms: number | null; summary: [string, number][]; open: boolean };

const groupState = (calls: ToolCall[]): ToolState =>
  calls.some(isFailed) ? 'error' : calls.some(c => c.state === 'running') ? 'running' : 'ok';

/** §14.5 ≥ 3 read-only tool rows in a row (no text between) fold into "Đã xem 5 · Read ×3, Grep ×2";
 *  an error inside opens the group. `toolOf` = the tool call of an item, null for text and every other item. */
export function groupTools<T>(items: readonly T[], toolOf: (t: T) => ToolCall | null): Row<T>[] {
  const out: Row<T>[] = [];
  let run: { item: T; call: ToolCall }[] = [];
  const flush = () => {
    if (run.length >= GROUP_MIN) {
      const calls = run.map(r => r.call), counts = new Map<string, number>();
      for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
      const state = groupState(calls);
      const ms = calls.every(c => c.ms !== null) ? calls.reduce((n, c) => n + c.ms!, 0) : null;
      out.push({ k: 'group', items: run.map(r => r.item), calls, state, ms, summary: [...counts], open: state === 'error' });
    } else for (const r of run) out.push({ k: 'item', item: r.item });
    run = [];
  };
  for (const item of items) {
    const call = toolOf(item);
    if (call && READ_ONLY.has(call.name)) { run.push({ item, call }); continue; }
    flush();
    out.push({ k: 'item', item });
  }
  flush();
  return out;
}

export type Shown<T> = { k: 'item'; item: T } | { k: 'count'; n: number };

/** §14.5 "Ẩn công cụ" (S11): each stretch of tool rows becomes one "n công cụ" line; a failed tool stays visible. */
export function hideTools<T>(items: readonly T[], toolOf: (t: T) => ToolCall | null): Shown<T>[] {
  const out: Shown<T>[] = [];
  let n = 0, kept: T[] = [];
  const flush = () => {
    if (n > 0) out.push({ k: 'count', n });
    for (const item of kept) out.push({ k: 'item', item });
    n = 0; kept = [];
  };
  for (const item of items) {
    const call = toolOf(item);
    if (!call) { flush(); out.push({ k: 'item', item }); continue; }
    if (isFailed(call)) kept.push(item); else n++;
  }
  flush();
  return out;
}
