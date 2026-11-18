// v2.2 §5.3 / §3-11 OAuth discovery of a remote MCP server: an unauthenticated request → `WWW-Authenticate`
// (`resource_metadata`, `scope`) → Protected Resource Metadata (RFC 9728) → Authorization Server metadata (RFC 8414 /
// OIDC, in the MCP well-known order). The AS must name the issuer we asked for and support PKCE S256, else stop.
import type { McpLoginDetail, McpLoginError } from '../../../shared/protocol.ts';
import { isObj } from '../../../shared/json.ts';

export class OAuthError extends Error {
  /** `info`: the K3e detail lines shown to the PO (McpOAuthView.errorDetail). */
  constructor(readonly code: McpLoginError, detail: string = code, readonly info?: McpLoginDetail) { super(detail); }
}

/** Text of a K3e-net line at most this long. */
const NET_TEXT_MAX = 160;

/** K3e-net a failed call to `url`: its host + the error's code (else message) — never a body, a path or a query. */
export function netError(url: string | URL, e: unknown): OAuthError {
  const code = (e as { code?: unknown } | null)?.code;
  const text = (typeof code === 'string' && code ? code : e instanceof Error ? e.message : String(e)).replace(/[\r\n]+/g, ' ').slice(0, NET_TEXT_MAX);
  let host = '';
  try { host = new URL(url).host; } catch { /* not a URL: no host line */ }
  return new OAuthError('network', text, { kind: 'network', host, text });
}

export interface AsMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

export interface Discovery { resource: string; as: AsMeta; scope?: string }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** `Bearer resource_metadata="…", scope="…"` → its two parameters we use. */
export function parseChallenge(h: string): { resourceMetadata?: string; scope?: string } {
  const out: { resourceMetadata?: string; scope?: string } = {};
  const rm = /resource_metadata="([^"]*)"/i.exec(h)?.[1];
  const sc = /(?:^|[\s,])scope="([^"]*)"/i.exec(h)?.[1];
  if (rm) out.resourceMetadata = rm;
  if (sc) out.scope = sc;
  return out;
}

const trimSlash = (p: string): string => (p === '/' ? '' : p.replace(/\/+$/, ''));

/** RFC 9728 §3.1: the challenge's URL first, then `/.well-known/oauth-protected-resource<path>`, then the root. */
export function prmUrls(server: URL, fromHeader?: string): string[] {
  const path = trimSlash(server.pathname);
  const out = [fromHeader, path ? `${server.origin}/.well-known/oauth-protected-resource${path}` : undefined, `${server.origin}/.well-known/oauth-protected-resource`];
  return [...new Set(out.filter((x): x is string => !!x))];
}

/** MCP authorization §2.3 order: OAuth AS metadata, OIDC path-inserted, OIDC path-appended (no path: the two roots). */
export function asMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = trimSlash(u.pathname);
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** RFC 8707 canonical server URI: lower-case scheme + host (URL does it), no fragment, no trailing slash. */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return `${u.origin}${trimSlash(u.pathname)}${u.search}`;
}

/** RFC 8414 §3.3 the metadata's `issuer` must be the one asked for; §5.3 S256 must be listed (absent = unsupported). */
export function checkAsMeta(j: unknown, issuer: string): AsMeta {
  if (!isObj(j) || !str(j.authorization_endpoint) || !str(j.token_endpoint)) throw new OAuthError('no_metadata');
  if (j.issuer !== issuer) {
    const received = typeof j.issuer === 'string' ? j.issuer : null;
    throw new OAuthError('issuer_mismatch', `issuer ${String(j.issuer)} ≠ ${issuer}`, { kind: 'issuer', expected: issuer, received });
  }
  const methods = Array.isArray(j.code_challenge_methods_supported) ? j.code_challenge_methods_supported.filter((m): m is string => typeof m === 'string') : [];
  if (!methods.includes('S256')) throw new OAuthError('no_s256');
  return {
    issuer, authorization_endpoint: str(j.authorization_endpoint)!, token_endpoint: str(j.token_endpoint)!,
    ...(str(j.registration_endpoint) ? { registration_endpoint: str(j.registration_endpoint)! } : {}),
    ...(str(j.revocation_endpoint) ? { revocation_endpoint: str(j.revocation_endpoint)! } : {}),
    code_challenge_methods_supported: methods,
    ...(j.authorization_response_iss_parameter_supported === true ? { authorization_response_iss_parameter_supported: true } : {}),
  };
}

/** GET as JSON; 404 / not JSON → null; a fetch that throws → OAuthError network. */
async function getJson(f: typeof fetch, url: string, signal?: AbortSignal): Promise<unknown> {
  let r: Response;
  try { r = await f(url, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) }); } catch (e) { throw netError(url, e); }
  if (!r.ok) { void r.body?.cancel(); return null; }
  try { return await r.json(); } catch { return null; }
}

/** The AS metadata of `issuer`: the first well-known URL that answers JSON, checked (§5.3); none → no_metadata. */
export async function fetchAsMeta(f: typeof fetch, issuer: string, signal?: AbortSignal): Promise<AsMeta> {
  for (const u of asMetadataUrls(issuer)) {
    const j = await getJson(f, u, signal);
    if (j !== null) return checkAsMeta(j, issuer);
  }
  throw new OAuthError('no_metadata');
}

const INIT_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cc-slaves', version: '2.2' } } });

/** §5.3 "Đăng nhập": the whole discovery for one server URL. */
export async function discover(serverUrl: string, f: typeof fetch, signal?: AbortSignal): Promise<Discovery> {
  const server = new URL(serverUrl);
  let challenge: { resourceMetadata?: string; scope?: string } = {};
  try {
    const r = await f(server, {
      method: 'POST', body: INIT_BODY, redirect: 'manual', ...(signal ? { signal } : {}),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    });
    void r.body?.cancel();
    if (r.status === 401) challenge = parseChallenge(r.headers.get('www-authenticate') ?? '');
  } catch (e) { throw netError(server, e); }
  let prm: Record<string, unknown> | null = null;
  for (const u of prmUrls(server, challenge.resourceMetadata)) {
    const j = await getJson(f, u, signal);
    if (isObj(j) && Array.isArray(j.authorization_servers) && typeof j.authorization_servers[0] === 'string') { prm = j; break; }
  }
  if (!prm) throw new OAuthError('no_metadata');
  const as = await fetchAsMeta(f, (prm.authorization_servers as string[])[0]!, signal);
  const canon = canonicalResource(serverUrl);
  const declared = str(prm.resource);
  const resource = declared && canon.startsWith(canonicalResource(declared)) ? canonicalResource(declared) : canon;
  const supported = Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((s): s is string => typeof s === 'string') : [];
  const scope = challenge.scope ?? (supported.length ? supported.join(' ') : undefined);
  return { resource, as, ...(scope ? { scope } : {}) };
}
