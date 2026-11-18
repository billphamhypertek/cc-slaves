#!/usr/bin/env bun
// fake-claude: stands in for `claude -p --input-format stream-json --output-format stream-json` in tests (spec §12).
// Never calls any API. `fake-claude auth …` → auth.ts (v2 §8); `fake-claude mcp add-json|remove` → mcp.ts (v2.2 §5.4). Behaviour:
// - accepts and ignores every real `claude` flag (reads only --session-id/--resume, --model, --permission-mode / --dangerously-skip-permissions);
// - FAKE_CLAUDE_TRACE=<file>: writes {argv, envKeys, cwd, claudeaiMcp} there (env keys only, never values, except
//   the non-secret ENABLE_CLAUDEAI_MCP_SERVERS switch);
// - FAKE_CLAUDE_BOOT_MS=<ms>: reads no stdin line (so no control answer, no init) for that long, like a slow real boot;
// - FAKE_CLAUDE_STDIN_LOG=<file>: appends every stdin line received (tests assert message texts and order);
// - FAKE_CLAUDE_SCENARIO=<name|path>: a JSON scenario (name → fake-claude/scenarios/<name>.json);
// - `system/init` only after the first user line (§3.3-18); user lines replayed with the same uuid + isReplay
//   (§3.3-17) — immediately, or on a `flushReplay` step when the scenario sets "replay": "manual";
// - interrupt control_request → control_response success {still_queued: <unreplayed uuids>} (§3.3-6/14);
// - control_response lines are echoed (§3.3-13); stdin closed while waiting → exit 0, no result (§3.3-7); an error
//   while reading stdin (EPIPE on a reply, a removed log dir) → exit 1;
// - SIGINT → result error_during_execution, exit 0 (§3.3-7); interrupt while a `permission` step waits →
//   control_cancel_request for it + result error_during_execution, allow/deny branch skipped, session lives (§3.3-14).
//
// Scenario: { "replay"?: "immediate"|"manual", "init"?: false | {tools?, mcp_servers?, model?, claude_code_version?},
//   "steps": Step[] }
// Step (one per object): {"emit": obj|obj[]} · {"sleep": ms} · {"waitUser": true} · {"waitUser": "text"} (the next
//   message containing text; every other message before it gets a short success result, like a quick reply) · {"flushReplay": true}
//   ({"flushReplay": "reverse"}: the queued lines replayed last-first, two lines merged into one turn, v2.9 §12) · {"stderr": text} ·
//   {"waitInterrupt": true} · {"permission": {tool_name,input,permission_suggestions,description?}, "allow": Step[],
//   "deny": Step[]} · {"exit": code} · {"die": {"partial"?: string}} ·
//   {"mcp": {"tool": name, "args": obj}} — calls the engine MCP server named `cc_slaves` in --mcp-config (JSON-RPC
//   tools/call, as claude does) and emits the tool_use / tool_result pair; FAKE_CLAUDE_MCP_LOG=<file> appends results. ·
//   {"stream": {...}} — one API message as real-shape stream_events + its assistant lines (stream.ts, v2.2 §3-15). ·
//   {"foreignReplay": text} — a replayed user line with a uuid that is not ours (skill text, `<command-message>`, v2.4 §6.6). ·
//   {"write": {"path", "text"}} — v2.9 §12 the author session's Write: a tool_use line, then the file written (path relative
//   to cwd, or absolute; no confinement here — the real one is `--restricted`, G0 §4). {"mcp": {..., "server"?}} picks the
//   MCP server of --mcp-config (default `cc_slaves`; the author session's is `cc_draft`).
// v2.4 §10.2 (NC §8): other control requests → control.ts (scenario "control"); a user line with image blocks is
//   replayed whole with its uuid, after "imageReplayDelayMs" when set; a user line that is exactly `/name args`
//   (no prefix) is replayed as `<command-name>/name</command-name>…` with its uuid (NC §8-16), names in "skills" add a
//   foreign-uuid replay with the skill text; `/context` also answers a `<synthetic>` assistant line + a 0-turn result,
//   `/resume`, `/exit` answer that way with no replay at all (NC §8-18). Answered commands never reach the steps.
// Strings in emitted objects: "${session}" → session id, "${uuid}" → fresh uuid, "${req}" → last permission request id.
// After the last step: idle until stdin closes, then exit 0.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runAuth } from './auth.ts';
import { makeControl } from './control.ts';
import { streamMessage } from './stream.ts';
import { runMcp } from './mcp.ts';
import { runPlugin } from './plugin.ts';

type Obj = Record<string, unknown>;
type Step = Obj;
interface Scenario {
  replay?: 'immediate' | 'manual'; init?: false | Obj; steps: Step[];
  control?: Obj; imageReplayDelayMs?: number; skills?: string[];
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (process.env.FAKE_CLAUDE_TRACE) {
  writeFileSync(process.env.FAKE_CLAUDE_TRACE, JSON.stringify({
    argv, envKeys: Object.keys(process.env).sort(), cwd: process.cwd(),
    // v2.2 §5.1 not a secret: the claude.ai connector switch the engine must set to "false".
    claudeaiMcp: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null,
  }, null, 2));
}

// `claude auth login|status|logout` (v2 §8): see auth.ts. No scenario file needed.
if (argv[0] === 'auth') await runAuth(argv.slice(1));
// `claude mcp add-json|remove -s user …` (v2.2 §5.4): see mcp.ts.
if (argv[0] === 'mcp') runMcp(argv.slice(1));
// `claude plugin marketplace add|update`, `plugin install|update --json` (v2.5 §5.2): see plugin.ts.
if (argv[0] === 'plugin') runPlugin(argv.slice(1));

function loadScenario(): Scenario {
  // FAKE_CLAUDE_SCENARIO_DIR=<dir>: `<dir>/lane-<basename of cwd>.json` wins (one scenario per lane worktree).
  const byCwd = process.env.FAKE_CLAUDE_SCENARIO_DIR ? join(process.env.FAKE_CLAUDE_SCENARIO_DIR, `lane-${process.cwd().split('/').pop()}.json`) : null;
  const ref = byCwd && existsSync(byCwd) ? byCwd : process.env.FAKE_CLAUDE_SCENARIO;
  if (!ref) {
    process.stderr.write('fake-claude: FAKE_CLAUDE_SCENARIO is not set\n');
    process.exit(2);
  }
  const path = ref.includes('/') || ref.endsWith('.json') ? resolve(ref) : join(import.meta.dir, '../scenarios', `${ref}.json`);
  if (!existsSync(path)) {
    process.stderr.write(`fake-claude: scenario not found: ${path}\n`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Scenario;
}

const scenario = loadScenario();
const manualReplay = scenario.replay === 'manual';
const session = flag('--session-id') ?? flag('--resume') ?? randomUUID();
// real claude reports `bypassPermissions` in system/init under --dangerously-skip-permissions (v2 D18)
const permissionMode = process.argv.includes('--dangerously-skip-permissions') ? 'bypassPermissions' : flag('--permission-mode') ?? 'default';
let lastReq = '';

const out = (o: unknown) => writeSync(1, `${JSON.stringify(o)}\n`);

function fill(v: unknown): unknown {
  if (typeof v === 'string') {
    return v === '${uuid}' ? randomUUID() : v.replaceAll('${session}', session).replaceAll('${req}', lastReq);
  }
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
}

function emit(o: Obj): void {
  const e = fill(o) as Obj;
  if (e.session_id === undefined && !String(e.type).startsWith('control_')) e.session_id = session;
  if ((e.type === 'assistant' || e.type === 'user') && e.uuid === undefined) e.uuid = randomUUID();
  out(e);
}

const start = (scenario.control ?? {}) as { startModel?: unknown; startEffort?: unknown };
const ctl = makeControl(scenario.control ?? {}, {
  model: flag('--model') ?? (typeof start.startModel === 'string' ? start.startModel : 'claude-fake'),
  effort: flag('--effort') ?? (typeof start.startEffort === 'string' ? start.startEffort : null),
}, { out, emit });

// ---------- stdin ----------
interface UserMsg { uuid: string; message: unknown; raw: Obj }
const userQueue: UserMsg[] = [];
const unreplayed: UserMsg[] = [];
const responses = new Map<string, Obj>();
let interrupts = 0;
let closed = false;
let sawUser = false;
let waiters: (() => void)[] = [];
const notify = () => { const w = waiters; waiters = []; for (const f of w) f(); };

function replay(m: UserMsg): void {
  emit({ type: 'user', message: m.message, uuid: m.uuid, isReplay: true, parent_tool_use_id: null });
}

const SYNTHETIC: Record<string, { replay: boolean; text: (n: string) => string }> = {
  context: { replay: true, text: () => '## Context Usage\n\nfake-claude: 0 tokens' },
  resume: { replay: false, text: (n) => `/${n} isn't available in this environment.` },
  exit: { replay: false, text: (n) => `/${n} isn't available in this environment.` },
};

function onUser(m: UserMsg): void {
  const content = (m.message as Obj | undefined)?.content;
  const slash = typeof content === 'string' ? /^\/(\S+)\s*([\s\S]*)$/.exec(content) : null;
  if (slash) {
    const [, name, args] = slash as unknown as [string, string, string];
    const synthetic = SYNTHETIC[name];
    if (!synthetic || synthetic.replay) {
      replay({ ...m, message: { role: 'user', content:
        `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>` } });
    }
    if (synthetic) {
      emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: '<synthetic>',
        content: [{ type: 'text', text: synthetic.text(name) }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
      emit({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, permission_denials: [] });
      return;
    }
    if (scenario.skills?.includes(name)) foreignReplay(`Base directory for this skill: /fake/skills/${name}\n\n# ${name}`);
    userQueue.push(m);
    return;
  }
  const delay = scenario.imageReplayDelayMs ?? 0;
  const hasImage = Array.isArray(content) && content.some((b) => (b as Obj | null)?.type === 'image');
  if (manualReplay) unreplayed.push(m);
  else if (hasImage && delay > 0) setTimeout(() => replay(m), delay);
  else replay(m);
  userQueue.push(m);
}

function foreignReplay(text: string): void {
  emit({ type: 'user', uuid: randomUUID(), isReplay: true, parent_tool_use_id: null, message: { role: 'user', content: text } });
}

function emitInit(): void {
  if (scenario.init === false) return;
  const cfg = scenario.init ?? {};
  emit({
    type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), model: cfg.model ?? ctl.model,
    claude_code_version: cfg.claude_code_version ?? '2.1.325-fake', permissionMode,
    tools: cfg.tools ?? ['Bash', 'Read', 'Write', 'Edit', 'Task', 'mcp__cc_slaves__ask'],
    mcp_servers: cfg.mcp_servers ?? configServers().map((name) => ({ name, status: 'connected', source: 'dynamic' })),
    uuid: randomUUID(),
  });
}

function onLine(line: string): void {
  let o: Obj;
  try { o = JSON.parse(line) as Obj; } catch { return; }
  if (process.env.FAKE_CLAUDE_STDIN_LOG) appendFileSync(process.env.FAKE_CLAUDE_STDIN_LOG, `${line}\n`);
  if (o.type === 'user') {
    const m: UserMsg = { uuid: typeof o.uuid === 'string' ? o.uuid : randomUUID(), message: o.message, raw: o };
    if (!sawUser) { sawUser = true; emitInit(); }
    onUser(m);
  } else if (o.type === 'control_response') {
    out(o); // echo (§3.3-13)
    const res = (o.response ?? {}) as Obj;
    if (typeof res.request_id === 'string') responses.set(res.request_id, (res.response ?? {}) as Obj);
  } else if (o.type === 'control_request' && (o.request as Obj | undefined)?.subtype !== 'interrupt') {
    ctl.handle(o.request_id, (o.request ?? {}) as Obj);
  } else if (o.type === 'control_request') {
    const dropped = unreplayed.splice(0);
    for (const d of dropped) userQueue.splice(userQueue.indexOf(d), 1);
    out({ type: 'control_response', response: {
      subtype: 'success', request_id: o.request_id, response: { still_queued: dropped.map((d) => d.uuid) },
    } });
    interrupts++;
  }
  notify();
}

// hf1117-perf a throw in this pump (stdout reader gone → EPIPE, the test's temp dir removed → FAKE_CLAUDE_STDIN_LOG
// ENOENT) would leave Bun alive, spinning on the dead stdin at 100% CPU: any pump error ends the process.
void (async () => {
  const boot = Number(process.env.FAKE_CLAUDE_BOOT_MS ?? 0); // a real claude's SessionStart hooks (hf1117-perf: ~4.5 s measured)
  if (boot > 0) await Bun.sleep(boot);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf);
  closed = true;
  notify();
})().catch(() => process.exit(1));

/** Waits until cond() holds; stdin closed first → idle exit 0 with no result (§3.3-7). */
async function waitFor(cond: () => boolean): Promise<void> {
  while (!cond()) {
    if (closed) process.exit(0);
    await new Promise<void>((r) => waiters.push(r));
  }
}

function emitResult(subtype: string): void {
  emit({ type: 'result', subtype, is_error: subtype !== 'success', result: '', num_turns: 1, permission_denials: [] });
}

// §3.3-7 SIGINT ends the whole process (not just the turn): result error_during_execution, then exit 0.
process.on('SIGINT', () => {
  emitResult('error_during_execution');
  process.exit(0);
});

// ---------- MCP (engine tools) ----------
type McpCfg = { mcpServers?: Record<string, { url: string; headers?: Record<string, string> }> };
const mcpCfg = (): McpCfg | null => { const p = flag('--mcp-config'); return p ? JSON.parse(readFileSync(p, 'utf8')) as McpCfg : null; };
/** The init line's servers: those of --mcp-config, as real claude prints them (none given → `cc_slaves`). */
function configServers(): string[] {
  let names: string[] = [];
  try { names = Object.keys(mcpCfg()?.mcpServers ?? {}); } catch { /* a test's placeholder path: the default */ }
  return names.length ? names : ['cc_slaves'];
}
let mcpId = 0;
async function callMcp(tool: string, args: Obj, server = 'cc_slaves'): Promise<string> {
  const cfg = mcpCfg();
  if (!cfg) return 'fake-claude: no --mcp-config';
  const srv = cfg.mcpServers?.[server];
  if (!srv) return `fake-claude: no ${server} server`;
  const r = await fetch(srv.url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(srv.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpId, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const text = await r.text();
  if (process.env.FAKE_CLAUDE_MCP_LOG) appendFileSync(process.env.FAKE_CLAUDE_MCP_LOG, `${JSON.stringify({ tool, status: r.status, body: text })}\n`);
  try {
    const j = JSON.parse(text) as { result?: { content?: { text?: string }[] }; error?: { message?: string } };
    return j.result?.content?.map((c) => c.text ?? '').join('') ?? j.error?.message ?? text;
  } catch { return text; }
}

// ---------- steps ----------
let interruptsSeen = 0;

async function runSteps(steps: Step[]): Promise<void> {
  for (const s of steps) {
    if ('emit' in s) {
      for (const o of Array.isArray(s.emit) ? s.emit : [s.emit]) emit(o as Obj);
    } else if ('sleep' in s) {
      await Bun.sleep(Number(s.sleep));
    } else if ('waitUser' in s && typeof s.waitUser === 'string') {
      const want = s.waitUser;
      for (;;) {
        await waitFor(() => userQueue.length > 0);
        const m = userQueue.shift()!;
        if (JSON.stringify(m.message).includes(want)) break;
        emitResult('success');
      }
    } else if ('waitUser' in s) {
      await waitFor(() => userQueue.length > 0);
      userQueue.shift();
    } else if ('flushReplay' in s) {
      const all = unreplayed.splice(0);
      for (const m of s.flushReplay === 'reverse' ? all.reverse() : all) replay(m);
    } else if ('waitInterrupt' in s) {
      await waitFor(() => interrupts > interruptsSeen);
      interruptsSeen++;
    } else if ('permission' in s) {
      lastReq = randomUUID();
      const p = s.permission as Obj;
      const req = lastReq;
      emit({ type: 'control_request', request_id: req, request: {
        subtype: 'can_use_tool', display_name: p.tool_name, server_policy_ask_only: true, tool_use_id: 'toolu_fake_perm', ...p,
      } });
      await waitFor(() => responses.has(req) || interrupts > interruptsSeen);
      if (!responses.has(req)) {
        // §3.3-14 interrupt while the permission is pending: cancel the request, end the turn, session lives on.
        interruptsSeen++;
        emit({ type: 'control_cancel_request', request_id: req });
        emitResult('error_during_execution');
        continue;
      }
      const behavior = responses.get(req)?.behavior === 'allow' ? 'allow' : 'deny';
      await runSteps((s[behavior] as Step[] | undefined) ?? []);
    } else if ('mcp' in s) {
      const m = fill(s.mcp) as { tool: string; args?: Obj; server?: string };
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: ctl.model, content: [{ type: 'tool_use', id, name: `mcp__${m.server ?? 'cc_slaves'}__${m.tool}`, input: m.args ?? {} }] } });
      const res = await callMcp(m.tool, m.args ?? {}, m.server);
      emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: res }] } });
    } else if ('stream' in s) {
      await streamMessage(s.stream as Obj, { emit, sleep: (ms) => Bun.sleep(ms), model: ctl.model });
    } else if ('write' in s) {
      const w = s.write as { path: string; text: string };
      const file = resolve(process.cwd(), w.path);
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: ctl.model, content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content: w.text } }] } });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, w.text);
      emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'File created successfully' }] } });
    } else if ('foreignReplay' in s) {
      foreignReplay(String(s.foreignReplay));
    } else if ('stderr' in s) {
      writeSync(2, String(s.stderr));
    } else if ('exit' in s) {
      process.exit(Number(s.exit));
    } else if ('die' in s) {
      const partial = (s.die as Obj | null)?.partial;
      if (typeof partial === 'string') writeSync(1, partial);
      process.kill(process.pid, 'SIGKILL');
    }
  }
}

await runSteps(scenario.steps);
await waitFor(() => false);
