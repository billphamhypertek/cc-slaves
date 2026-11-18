// Fake OAuth authorization server for the v2.2 G3 tests (spec §8 "fake-mcp … AS OAuth giả"): mounts on a FakeMcp via
// `startFakeMcp({ routes: as.routes })`. Serves PRM (RFC 9728) for every MCP path, AS metadata at the root well-known
// URL (issuer = the fake's origin unless `knobs.issuer`), DCR, `/authorize` (302 straight back to `redirect_uri`, the
// "browser" approves at once unless `knobs.deny`), `/token` (code + PKCE S256 check; refresh **rotates**: the old refresh
// token dies), `/revoke`. Every token it issues becomes `mcp.knobs.requireToken`.
import { createHash, randomBytes } from 'node:crypto';
import type { FakeMcp } from './server.ts';

interface FakeAsKnobs {
  /** The `issuer` the metadata claims (default: the origin; another value = the "iss sai" case). */
  issuer: string | null;
  /** Listed challenge methods (default ['S256']). */
  methods: string[];
  /** No `registration_endpoint` (DCR unsupported → K3e-client). */
  noDcr: boolean;
  /** `/authorize` answers `error=access_denied` with this description. */
  deny: string | null;
  /** `iss` the authorization response carries (default: the issuer). */
  responseIss: string | null;
  /** `expires_in` of issued tokens (s). */
  expiresIn: number;
  /** Next refresh answers this: 'invalid_grant' (400) or an HTTP status (5xx). */
  refreshFail: 'invalid_grant' | number | null;
  /** Delay of every `/token` refresh answer (single-flight tests). */
  refreshDelayMs: number;
}

interface Grant { clientId: string; challenge: string; method: string; redirectUri: string; resource: string | null; scope: string | null }

export interface FakeAs {
  knobs: FakeAsKnobs;
  routes: (req: Request, url: URL, body: string) => Promise<Response | undefined>;
  /** Registered clients (DCR bodies). */
  registered: Record<string, unknown>[];
  /** Query of every `/authorize` request. */
  authorizes: URLSearchParams[];
  /** Form of every `/token` request. */
  tokenCalls: URLSearchParams[];
  /** Tokens sent to `/revoke`. */
  revoked: string[];
  refreshes: () => number;
  /** The live refresh token (rotated on every refresh). */
  refreshToken: () => string | null;
}

const b64url = (b: Buffer): string => b.toString('base64url');
const json = (status: number, body: unknown): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export function fakeAuthServer(mcp: () => FakeMcp): FakeAs {
  const knobs: FakeAsKnobs = { issuer: null, methods: ['S256'], noDcr: false, deny: null, responseIss: null, expiresIn: 3600, refreshFail: null, refreshDelayMs: 0 };
  const registered: Record<string, unknown>[] = [];
  const authorizes: URLSearchParams[] = [];
  const tokenCalls: URLSearchParams[] = [];
  const revoked: string[] = [];
  const codes = new Map<string, Grant>();
  let refresh: string | null = null;
  let refreshes = 0;
  let n = 0;

  const issue = (): Response => {
    n += 1;
    const access = `at-${n}-${b64url(randomBytes(6))}`;
    refresh = `rt-${n}-${b64url(randomBytes(6))}`;
    mcp().knobs.requireToken = access;
    return json(200, { access_token: access, token_type: 'Bearer', expires_in: knobs.expiresIn, refresh_token: refresh, scope: 'read' });
  };

  const token = async (form: URLSearchParams): Promise<Response> => {
    tokenCalls.push(form);
    if (form.get('grant_type') === 'authorization_code') {
      const g = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!g) return json(400, { error: 'invalid_grant' });
      const v = form.get('code_verifier') ?? '';
      const ok = g.method === 'S256' && b64url(createHash('sha256').update(v).digest()) === g.challenge;
      if (!ok || form.get('redirect_uri') !== g.redirectUri || form.get('client_id') !== g.clientId) return json(400, { error: 'invalid_grant', error_description: 'PKCE / redirect / client mismatch' });
      return issue();
    }
    if (form.get('grant_type') === 'refresh_token') {
      refreshes += 1;
      if (knobs.refreshDelayMs) await Bun.sleep(knobs.refreshDelayMs);
      const fail = knobs.refreshFail;
      if (fail !== null) { knobs.refreshFail = null; return fail === 'invalid_grant' ? json(400, { error: 'invalid_grant' }) : json(fail, { error: 'server_error' }); }
      if (!refresh || form.get('refresh_token') !== refresh) return json(400, { error: 'invalid_grant' });
      return issue();
    }
    return json(400, { error: 'unsupported_grant_type' });
  };

  const routes = async (req: Request, url: URL, body: string): Promise<Response | undefined> => {
    const origin = url.origin;
    const issuer = knobs.issuer ?? origin;
    const p = url.pathname;
    if (p.startsWith('/.well-known/oauth-protected-resource')) {
      const res = p.slice('/.well-known/oauth-protected-resource'.length) || '/';
      return json(200, { resource: `${origin}${res === '/' ? '' : res}`, authorization_servers: [origin], scopes_supported: ['read'] });
    }
    if (p === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, revocation_endpoint: `${origin}/revoke`,
        ...(knobs.noDcr ? {} : { registration_endpoint: `${origin}/register` }),
        code_challenge_methods_supported: knobs.methods, authorization_response_iss_parameter_supported: true,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    if (p === '/register' && req.method === 'POST') {
      const meta = JSON.parse(body) as Record<string, unknown>;
      registered.push(meta);
      if (meta.application_type !== 'native' || meta.token_endpoint_auth_method !== 'none') return json(400, { error: 'invalid_client_metadata' });
      return json(201, { client_id: `dcr-${registered.length}`, ...meta });
    }
    if (p === '/authorize') {
      const q = url.searchParams;
      authorizes.push(q);
      const back = new URL(q.get('redirect_uri') ?? '');
      back.searchParams.set('state', q.get('state') ?? '');
      back.searchParams.set('iss', knobs.responseIss ?? issuer);
      if (knobs.deny !== null) {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', knobs.deny);
      } else {
        const code = b64url(randomBytes(9));
        codes.set(code, { clientId: q.get('client_id') ?? '', challenge: q.get('code_challenge') ?? '', method: q.get('code_challenge_method') ?? 'plain', redirectUri: back.origin + back.pathname, resource: q.get('resource'), scope: q.get('scope') });
        back.searchParams.set('code', code);
      }
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (p === '/token' && req.method === 'POST') return token(new URLSearchParams(body));
    if (p === '/revoke' && req.method === 'POST') {
      revoked.push(new URLSearchParams(body).get('token') ?? '');
      return new Response(null, { status: 200 });
    }
    return undefined;
  };

  return { knobs, routes, registered, authorizes, tokenCalls, revoked, refreshes: () => refreshes, refreshToken: () => refresh };
}
