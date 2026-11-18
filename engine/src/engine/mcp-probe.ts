// v2.2 §5.4b the engine side of "Kiểm tra": which transport one catalog entry is checked over (the proxy's in-process
// `forward`, a direct fetch for entries carrying their own Authorization header, or a spawn for local servers) and the
// env / cwd a spawn gets — the session's (stripped login env), as the lane's Claude Code would start it.
import { probeRemote, probeStdio, expandVars, type ProbeResult, type ProbeTarget } from '../mcp/probe.ts';
import type { McpProxy } from '../mcp/proxy.ts';
import { isObj } from '../../../shared/json.ts';

type Env = Record<string, string>;

/** A checkable row: a catalog entry or a K1-local one (`unused`). */
export interface ProbeEntry {
  id: string;
  source: ProbeTarget['source'];
  kind: ProbeTarget['kind'];
  config: Record<string, unknown>;
  forLanes: boolean;
  /** Project-bound entries: a spawn's default cwd is that project's root. */
  projectId?: string;
  unused: boolean;
  error: boolean;
}

const headersOf = (c: Record<string, unknown>): Record<string, unknown> => (isObj(c.headers) ? c.headers : {});
const selfAuth = (c: Record<string, unknown>): boolean => Object.keys(headersOf(c)).some((k) => k.toLowerCase() === 'authorization');

export function targetOf(e: ProbeEntry): ProbeTarget {
  return { source: e.source, kind: e.kind, forLanes: e.forLanes, unused: e.unused, error: e.error, selfAuthHelper: e.kind !== 'stdio' && e.config.headersHelper !== undefined };
}

export interface ProbeDeps {
  proxy: McpProxy;
  fetch: typeof fetch;
  /** The session env (stripped login env) `${VAR}` expands from and a spawn inherits. */
  env: Env;
  /** A spawn's cwd when the entry names none (the project root, else HOME). */
  cwd: string;
}

const strings = (v: unknown): Env => (isObj(v) ? Object.fromEntries(Object.entries(v).filter((x): x is [string, string] => typeof x[1] === 'string')) : {});

/** §5.4b one check of `e` (the caller has applied the C22 scope). */
export function runProbe(e: ProbeEntry, d: ProbeDeps): Promise<ProbeResult> {
  if (e.kind === 'stdio') {
    const c = expandVars(e.config, d.env);
    return probeStdio({
      command: typeof c.command === 'string' ? c.command : '', args: Array.isArray(c.args) ? c.args.map(String) : [],
      env: { ...d.env, ...strings(c.env) }, cwd: typeof c.cwd === 'string' && c.cwd ? c.cwd : d.cwd,
    });
  }
  const legacySse = e.kind === 'sse';
  if (selfAuth(e.config)) {
    // C9: the entry authenticates itself and never goes through the proxy — check it the way the lane reaches it.
    const c = expandVars(e.config, d.env);
    const own = strings(c.headers);
    return probeRemote({
      base: typeof c.url === 'string' ? c.url : '', legacySse,
      send: (url, init) => d.fetch(url, { ...init, headers: { ...own, ...(init.headers as Record<string, string>) }, redirect: 'manual' }),
    });
  }
  const base = `http://127.0.0.1/mcp-proxy/${encodeURIComponent(e.id)}`;
  return probeRemote({
    base, legacySse,
    send: (url, init) => d.proxy.forward(e.id, new Request(url, init), init.signal ?? AbortSignal.timeout(5000)),
    lastProxyLine: () => d.proxy.log.lines(e.id).at(-1),
  });
}
