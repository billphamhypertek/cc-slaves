// spec v2.9 §5.9 / §10.1 `/mcp-draft`: the author session's own MCP server (`cc_draft`), one tool `draft_save {name?}`. Its
// bearer is the draft's token (never the sessions' TokenRegistry, never `callTool`); Mac port, loopback, no Origin (like `/mcp`).

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const TOOL = {
  name: 'draft_save',
  description: 'Lưu bản nháp quy trình vào thư viện, như người dùng bấm Lưu. Chỉ gọi khi người dùng vừa nói rõ là lưu ("lưu đi", "ok lưu").',
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Tên gói mới (chỉ dùng cho gói mới).' } }, additionalProperties: false },
};

export interface DraftMcpDeps {
  draftOfToken: (token: string) => string | null;
  save: (draftId: string, name: string | undefined) => string;
}

type Id = string | number | null;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const ok = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });

function handle(d: DraftMcpDeps, draftId: string, raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return err(null, -32600, 'Invalid Request');
  const m = raw as { id?: Id; method?: unknown; params?: unknown };
  const isRequest = m.id !== undefined && m.id !== null;
  if (typeof m.method !== 'string' || !isRequest) return isRequest ? err(m.id!, -32600, 'Invalid Request') : null;
  const id = m.id!;
  const p = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>;
  switch (m.method) {
    case 'initialize': {
      const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cc-draft', version: '1.0.0' } });
    }
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: [TOOL] });
    case 'tools/call': {
      if (p.name !== TOOL.name) return err(id, -32602, `Unknown tool: ${String(p.name)}`);
      const a = (typeof p.arguments === 'object' && p.arguments !== null ? p.arguments : {}) as { name?: unknown };
      const text = d.save(draftId, typeof a.name === 'string' ? a.name : undefined);
      return ok(id, { content: [{ type: 'text', text }], isError: !text.startsWith('Đã lưu') });
    }
    default: return err(id, -32601, `Method not found: ${m.method}`);
  }
}

export function createDraftMcpHandler(d: DraftMcpDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.headers.get('origin') !== null) return json(403, { error: 'origin not allowed' });
    const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    const draftId = auth ? d.draftOfToken(auth[1]!) : null;
    if (!draftId) return json(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, { allow: 'POST' });
    let body: unknown;
    try { body = JSON.parse(await req.text()); } catch { return json(400, err(null, -32700, 'Parse error')); }
    const batch = Array.isArray(body);
    const out = ((batch ? body : [body]) as unknown[]).map((m) => handle(d, draftId, m)).filter((r) => r !== null);
    if (out.length === 0) return new Response(null, { status: 202 });
    return json(200, batch ? out : out[0]);
  };
}
