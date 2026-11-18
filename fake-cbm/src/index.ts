#!/usr/bin/env bun
// `fake-cbm`: the codebase-memory-mcp test double (spec v2.5 §8; never the real tool, Z5). Run with no argument = a stdio
// MCP server, one JSON-RPC message per line, like the real tool. `--version` prints the version and exits.
// Env knobs:
//   FAKE_CBM_VERSION  the version (default 0.12.1)
//   FAKE_CBM_LOG      file: one JSON line per start / exit / message ({ev, pid, cwd, method?, name?, env?})
//   FAKE_CBM_SLOW     a tool name whose `tools/call` never answers (timeout tests)
//   FAKE_CBM_FAIL     file: while it exists the server exits 1 at start (a front that cannot start)
//   FAKE_CBM_TOOLS    comma list replacing the tool names (a build that dropped search_graph)
//   FAKE_CBM_STATE    dir: the "daemon" state every front shares — projects.json (the indexes) + jobs.json (root → state);
//                     without it index / list / delete keep the old stateless answers
//   FAKE_CBM_INDEX_MS how long a sync index_repository runs (default 0); `notifications/cancelled` stops it (-32800)
//   FAKE_CBM_NOCANCEL set: a cancel is answered but the job runs on (the "cancel did not take" case)
//   FAKE_CBM_INDEX_FAIL a substring: an index of a matching root fails
//   FAKE_CBM_AUTO_INDEX `true`: `config get auto_index` says so and every front indexes its cwd by itself (0.8.1 caches, R4)
//   FAKE_CBM_PAGE     list_projects page size (default 50)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const env = process.env;
const VERSION = env.FAKE_CBM_VERSION ?? '0.12.1';
const INSTRUCTIONS = 'Graph first: search_graph for symbols, trace_path for relationships, get_code_snippet for source, '
  + 'query_graph for multi-hop, and get_architecture for overview. Use search_code/grep for literals.';
const TOOLS = env.FAKE_CBM_TOOLS?.split(',') ?? ['check_index_coverage', 'delete_project', 'detect_changes', 'get_architecture', 'get_code_snippet',
  'get_graph_schema', 'index_repository', 'index_status', 'ingest_traces', 'list_projects', 'manage_adr', 'query_graph',
  'search_code', 'search_graph', 'trace_path'];

const log = (ev: Record<string, unknown>): void => {
  if (env.FAKE_CBM_LOG) appendFileSync(env.FAKE_CBM_LOG, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...ev })}\n`);
};

if (process.argv[2] === 'config') {
  log({ ev: 'config', args: process.argv.slice(3) });
  if (process.argv[3] === 'get' && process.argv[4] === 'auto_index') process.stdout.write(`${env.FAKE_CBM_AUTO_INDEX ?? 'false'}\n`);
  process.exit(0);
}
if (process.argv[2] === '--version') {
  log({ ev: 'version' });
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (env.FAKE_CBM_FAIL && existsSync(env.FAKE_CBM_FAIL)) {
  process.stderr.write('fake-cbm: conflicting CBM process is active\n');
  process.exit(1);
}
log({ ev: 'start', env: { CBM_CACHE_DIR: env.CBM_CACHE_DIR ?? null, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? null } });
process.on('exit', () => log({ ev: 'exit' }));
process.on('SIGTERM', () => process.exit(0));

interface Msg { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string; requestId?: unknown } }
const out = (m: unknown): void => { process.stdout.write(`${JSON.stringify(m)}\n`); };
const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
let initialized = false;

interface Project { name: string; root_path: string; nodes: number; edges: number; size_bytes: number; indexed_at?: string }
const STATE = env.FAKE_CBM_STATE;
const readJson = <T>(f: string, empty: T): T => { try { return JSON.parse(readFileSync(join(STATE!, f), 'utf8')) as T; } catch { return empty; } };
const writeJson = (f: string, v: unknown) => { writeFileSync(join(STATE!, f), JSON.stringify(v)); };
const projects = () => readJson<Project[]>('projects.json', []);
const setJob = (root: string, state: string) => { writeJson('jobs.json', { ...readJson<Record<string, string>>('jobs.json', {}), [root]: state }); };
const nameOf = (root: string) => `${basename(root)}-${root.length}`;
function indexed(root: string): void {
  writeJson('projects.json', [...projects().filter((p) => p.root_path !== root), { name: nameOf(root), root_path: root, nodes: 10, edges: 20, size_bytes: 1000, indexed_at: new Date().toISOString() }]);
  setJob(root, 'succeeded');
}
const running = new Map<string | number, { timer: ReturnType<typeof setTimeout>; root: string }>();

function toolResult(name: string, args: Record<string, unknown>): unknown {
  if (name === 'index_repository') {
    if (args.status === true) return text({ state: STATE ? readJson<Record<string, string>>('jobs.json', {})[String(args.repo_path)] ?? 'idle' : 'idle', repo_path: args.repo_path });
    return text(args.async === true ? { state: 'queued', async: true, repo_path: args.repo_path } : { state: 'succeeded', repo_path: args.repo_path });
  }
  if (STATE && name === 'list_projects') {
    const all = projects(); const offset = Number(args.offset ?? 0); const limit = Number(env.FAKE_CBM_PAGE ?? 50);
    const page = all.slice(offset, offset + limit);
    return text({ projects: page, total: all.length, offset, limit, returned: page.length, has_more: offset + page.length < all.length });
  }
  if (STATE && name === 'index_status') { // the 0.12.1 keys (G6-4): no stale / needs_reindex, `status` stays ready after edits
    const p = projects().find((x) => x.name === args.project);
    if (!p) return { ...text({ error: `project not found: ${String(args.project)}` }), isError: true };
    return text({ project: p.name, root_path: p.root_path, status: 'ready', nodes: p.nodes, edges: p.edges, indexed_at: p.indexed_at ?? null,
      cross_repo: [], doc_links: 0, not_indexed: 0, parse_partial: 0, parse_unusable: 0, skipped: 0,
      watch: { watched: false, reason: 'not_session_project', hint: 'Auto-sync watches only the active MCP session\'s project; re-run index_repository to refresh.' } });
  }
  if (STATE && name === 'delete_project') {
    const p = String(args.project);
    if (!projects().some((x) => x.name === p)) return { ...text({ error: `project not found: ${p}` }), isError: true };
    writeJson('projects.json', projects().filter((x) => x.name !== p));
    return text({ deleted: p });
  }
  return text({ tool: name, args, cwd: process.cwd(), pid: process.pid });
}

/** A sync index_repository with shared state: runs FAKE_CBM_INDEX_MS, cancellable by `notifications/cancelled`. */
function syncIndex(id: string | number, root: string): void {
  setJob(root, 'running');
  const timer = setTimeout(() => {
    running.delete(id);
    if (env.FAKE_CBM_INDEX_FAIL && root.includes(env.FAKE_CBM_INDEX_FAIL)) {
      setJob(root, 'failed');
      out({ jsonrpc: '2.0', id, result: { ...text({ error: `index failed: ${root}` }), isError: true } });
      return;
    }
    indexed(root);
    out({ jsonrpc: '2.0', id, result: text({ project: nameOf(root), status: 'indexed' }) });
  }, Number(env.FAKE_CBM_INDEX_MS ?? 0));
  running.set(id, { timer, root });
}
function cancel(requestId: unknown): void {
  const r = running.get(requestId as string | number);
  if (!r) return;
  out({ jsonrpc: '2.0', id: requestId, error: { code: -32800, message: 'Request cancelled' } });
  if (env.FAKE_CBM_NOCANCEL) return; // the reply came, the job goes on
  clearTimeout(r.timer);
  running.delete(requestId as string | number);
  setJob(r.root, 'cancelled');
}

function handle(m: Msg): void {
  log({ ev: 'msg', method: m.method, ...(m.params?.name ? { name: m.params.name } : {}), ...(m.params?.arguments ? { args: m.params.arguments } : {}) });
  if (m.id === undefined) { if (m.method === 'notifications/cancelled') cancel(m.params?.requestId); return; } // a notification
  const reply = (result: unknown) => out({ jsonrpc: '2.0', id: m.id, result });
  const error = (code: number, message: string) => out({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize':
      initialized = true;
      reply({ protocolVersion: m.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'codebase-memory-mcp', version: VERSION }, instructions: INSTRUCTIONS });
      return;
    case 'ping': reply({}); return;
    case 'tools/list': reply({ tools: TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })) }); return;
    case 'tools/call': {
      if (!initialized) { error(-32002, 'Server not initialized'); return; }
      const name = m.params?.name ?? '';
      if (name === env.FAKE_CBM_SLOW) return;
      if (!TOOLS.includes(name)) { error(-32602, `Unknown tool: ${name}`); return; }
      const args = m.params?.arguments ?? {};
      if (STATE && name === 'index_repository' && args.status !== true && args.async !== true) { syncIndex(m.id, String(args.repo_path)); return; }
      reply(toolResult(name, m.params?.arguments ?? {}));
      return;
    }
    default: error(-32601, 'Method not found');
  }
}

// R4 a 0.8.1 cache (auto_index=true): the front indexes its own cwd when it has no index yet
if (STATE && env.FAKE_CBM_AUTO_INDEX === 'true' && !projects().some((p) => p.root_path === process.cwd())) {
  const cwd = process.cwd();
  setJob(cwd, 'running');
  setTimeout(() => indexed(cwd), Number(env.FAKE_CBM_INDEX_MS ?? 0));
}

let buf = '';
process.stdin.on('data', (b: Buffer) => {
  buf += b.toString('utf8');
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line) as Msg);
  }
});
process.stdin.on('end', () => process.exit(0));
