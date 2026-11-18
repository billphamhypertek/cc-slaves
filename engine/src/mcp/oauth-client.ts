// v2.2 §5.3 the OAuth HTTP calls of the engine's MCP client: PKCE, dynamic client registration (RFC 7591,
// `application_type: native`, public client), code exchange, rotating refresh (RFC 6749 §6), revoke (RFC 7009).
// Only `invalid_grant` on a refresh means "log in again" (A3); a network error / 5xx keeps the token.
import { createHash, randomBytes } from 'node:crypto';
import { netError, OAuthError, type AsMeta } from './oauth-discovery.ts';

export interface TokenSet { accessToken: string; refreshToken?: string; expiresAt: number; scope?: string }
export interface Client { clientId: string; clientSecret?: string }

/** `expires_in` missing → assume one hour (refresh then happens on the first 401). */
const DEFAULT_TTL_S = 3600;

const b64url = (b: Buffer): string => b.toString('base64url');
export const randomId = (bytes: number): string => b64url(randomBytes(bytes));

/** RFC 7636 S256: a 43-char verifier and its SHA-256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomId(32);
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/** POST a form with `client_id`; a secret goes as HTTP Basic too (RFC 6749 §2.3.1 default). */
async function postForm(f: typeof fetch, url: string, form: Record<string, string | undefined>, c: Client): Promise<Response> {
  const body = new URLSearchParams({ client_id: c.clientId });
  for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== '') body.set(k, v);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (c.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString('base64')}`;
  return f(url, { method: 'POST', headers, body: body.toString(), redirect: 'manual' });
}

function tokenSet(j: unknown, now: number, old?: Pick<TokenSet, 'refreshToken' | 'scope'>): TokenSet | null {
  if (typeof j !== 'object' || j === null) return null;
  const o = j as Record<string, unknown>;
  if (typeof o.access_token !== 'string' || !o.access_token) return null;
  const ttl = typeof o.expires_in === 'number' && o.expires_in > 0 ? o.expires_in : DEFAULT_TTL_S;
  const refresh = typeof o.refresh_token === 'string' && o.refresh_token ? o.refresh_token : old?.refreshToken;
  const scope = typeof o.scope === 'string' ? o.scope : old?.scope;
  return { accessToken: o.access_token, expiresAt: now + ttl * 1000, ...(refresh ? { refreshToken: refresh } : {}), ...(scope ? { scope } : {}) };
}

/** §5.3 DCR: no endpoint, refused or a body without `client_id` → "client_registration" (K3e-client). */
export async function registerClient(f: typeof fetch, as: AsMeta, redirectUri: string): Promise<string> {
  if (!as.registration_endpoint) throw new OAuthError('client_registration');
  let r: Response;
  try {
    r = await f(as.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'cc-slaves', application_type: 'native', token_endpoint_auth_method: 'none',
        redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      }),
    });
  } catch (e) { throw netError(as.registration_endpoint, e); }
  const j = await r.json().catch(() => null) as { client_id?: unknown } | null;
  if (!r.ok || typeof j?.client_id !== 'string' || !j.client_id) throw new OAuthError('client_registration');
  return j.client_id;
}

export interface CodeExchange { code: string; redirectUri: string; verifier: string; resource: string }

export async function exchangeCode(f: typeof fetch, as: AsMeta, c: Client, x: CodeExchange, now: number): Promise<TokenSet> {
  let r: Response;
  try {
    r = await postForm(f, as.token_endpoint, { grant_type: 'authorization_code', code: x.code, redirect_uri: x.redirectUri, code_verifier: x.verifier, resource: x.resource }, c);
  } catch (e) { throw netError(as.token_endpoint, e); }
  const t = tokenSet(await r.json().catch(() => null), now);
  if (!r.ok || !t) throw netError(as.token_endpoint, `HTTP ${r.status}`);
  return t;
}

export type RefreshResult = { ok: TokenSet } | { fail: 'invalid_grant' | 'error' };

/** §5.3 rotating refresh: a new refresh token replaces the old one; none in the answer → keep the old one. */
export async function refreshTokens(f: typeof fetch, as: AsMeta, c: Client, t: { refreshToken: string; scope?: string; resource: string }, now: number): Promise<RefreshResult> {
  let r: Response;
  try {
    r = await postForm(f, as.token_endpoint, { grant_type: 'refresh_token', refresh_token: t.refreshToken, resource: t.resource }, c);
  } catch { return { fail: 'error' }; }
  const j = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (r.status === 400 && j?.error === 'invalid_grant') return { fail: 'invalid_grant' };
  const set = r.ok ? tokenSet(j, now, t) : null;
  return set ? { ok: set } : { fail: 'error' };
}

/** RFC 7009 best effort (logout / remove / URL change must not hang on a dead AS). */
export async function revokeToken(f: typeof fetch, as: AsMeta, c: Client, token: string, hint: 'refresh_token' | 'access_token'): Promise<void> {
  if (!as.revocation_endpoint) return;
  try { const r = await postForm(f, as.revocation_endpoint, { token, token_type_hint: hint }, c); void r.body?.cancel(); } catch { /* best effort */ }
}
