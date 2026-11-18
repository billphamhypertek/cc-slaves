// Tiny stdio MCP server for the §5.4b probe tests (never a real server). Env knobs:
//   MARKER       file written at start (proves whether the command ran at all)
//   MCP_MODE     ok (default) · hang (never answers) · exit (exits 3 before answering) · rpc_error (initialize fails)
//   CHILD_PID    file: spawn a `sleep` grandchild in our process group and write its pid (group-kill test)
//   TOOL_PREFIX  tool names are `<prefix>a`, `<prefix>b` (proves `${VAR}` / env reach the child)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const env = process.env;
if (env.MARKER) writeFileSync(env.MARKER, `${process.pid}\n`);
if (env.CHILD_PID) {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' });
  writeFileSync(env.CHILD_PID, String(c.pid));
}
const mode = env.MCP_MODE ?? 'ok';
if (mode === 'exit') { process.stderr.write('fixture: bad config\n'); process.exit(3); }

const out = (m: unknown): void => { process.stdout.write(`${JSON.stringify(m)}\n`); };
process.stdout.write('not json: a server log line on stdout\n');
let buf = '';
process.stdin.on('data', (b: Buffer) => {
  buf += b.toString('utf8');
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const m = JSON.parse(buf.slice(0, i)) as { id?: number; method?: string; params?: { cursor?: string } };
    buf = buf.slice(i + 1);
    if (mode === 'hang' || m.id === undefined) continue;
    if (m.method === 'initialize') {
      out(mode === 'rpc_error'
        ? { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'fixture refuses' } }
        : { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'stdio-fixture', version: '1' } } });
    } else if (m.method === 'tools/list') {
      const p = env.TOOL_PREFIX ?? '';
      out(m.params?.cursor === 'page2'
        ? { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: `${p}b` }] } }
        : { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: `${p}a` }], nextCursor: 'page2' } });
    }
  }
});
setInterval(() => {}, 1 << 30);
