// v2.2 §5.3 / §3-11 OAuth metadata discovery (pure parts + an injected fetch): PRM (RFC 9728) → AS metadata in the
// well-known order, `issuer` must match, no S256 → stop.
import { describe, expect, test } from 'bun:test';
import { rejects } from '../_fixtures/rejects.ts';
import { asMetadataUrls, canonicalResource, checkAsMeta, discover, OAuthError, parseChallenge, prmUrls } from '../../src/mcp/oauth-discovery.ts';

const AS = { issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token', code_challenge_methods_supported: ['S256'] };

function fetchOf(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = input instanceof Request ? input.url : input.toString();
    seen.push(u);
    if (!(u in routes)) return new Response('nope', { status: 404 });
    const r = routes[u];
    return r instanceof Response ? r : Response.json(r);
  }) as typeof fetch;
}

describe('§3-11 parsers', () => {
  test('§3-11 WWW-Authenticate: resource_metadata + scope', () => {
    expect(parseChallenge('Bearer resource_metadata="https://m.example/.well-known/oauth-protected-resource/mcp", scope="a b"'))
      .toEqual({ resourceMetadata: 'https://m.example/.well-known/oauth-protected-resource/mcp', scope: 'a b' });
    expect(parseChallenge('')).toEqual({});
  });

  test('§3-11 PRM urls: the header first, then path-aware well-known, then root', () => {
    expect(prmUrls(new URL('https://m.example/v1/mcp'), 'https://m.example/prm')).toEqual([
      'https://m.example/prm', 'https://m.example/.well-known/oauth-protected-resource/v1/mcp', 'https://m.example/.well-known/oauth-protected-resource',
    ]);
    expect(prmUrls(new URL('https://m.example/'))).toEqual(['https://m.example/.well-known/oauth-protected-resource']);
  });

  test('§3-11 AS metadata well-known order (issuer with a path, and without)', () => {
    expect(asMetadataUrls('https://auth.example/tenant1')).toEqual([
      'https://auth.example/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example/.well-known/openid-configuration/tenant1',
      'https://auth.example/tenant1/.well-known/openid-configuration',
    ]);
    expect(asMetadataUrls('https://auth.example')).toEqual([
      'https://auth.example/.well-known/oauth-authorization-server', 'https://auth.example/.well-known/openid-configuration',
    ]);
  });

  test('§5.3 issuer must match the AS URL exactly → else issuer_mismatch', () => {
    expect(checkAsMeta(AS, 'https://auth.example').token_endpoint).toBe('https://auth.example/token');
    expect(() => checkAsMeta({ ...AS, issuer: 'https://evil.example' }, 'https://auth.example')).toThrow(expect.objectContaining({ code: 'issuer_mismatch' }));
  });

  test('§5.3 S256 missing (absent list or only plain) → no_s256', () => {
    const { code_challenge_methods_supported: _c, ...noList } = AS;
    for (const m of [noList, { ...AS, code_challenge_methods_supported: ['plain'] }]) {
      expect(() => checkAsMeta(m, 'https://auth.example')).toThrow(expect.objectContaining({ code: 'no_s256' }));
    }
  });

  test('§5.3 canonical resource: lower-case scheme + host, no fragment, no trailing slash', () => {
    expect(canonicalResource('HTTPS://M.Example/MCP/#x')).toBe('https://m.example/MCP');
    expect(canonicalResource('https://m.example/')).toBe('https://m.example');
  });
});

describe('§5.3 discover', () => {
  test('§3-11 401 challenge → PRM → AS metadata (first well-known hit); scope from the challenge', async () => {
    const seen: string[] = [];
    const f = fetchOf({
      'https://m.example/mcp': new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://m.example/.well-known/oauth-protected-resource/mcp", scope="read"' } }),
      'https://m.example/.well-known/oauth-protected-resource/mcp': { resource: 'https://m.example/mcp', authorization_servers: ['https://auth.example'], scopes_supported: ['read', 'write'] },
      'https://auth.example/.well-known/openid-configuration': AS,
    }, seen);
    const d = await discover('https://m.example/mcp', f);
    expect(d).toMatchObject({ resource: 'https://m.example/mcp', scope: 'read', as: { issuer: 'https://auth.example' } });
    expect(seen).toEqual([
      'https://m.example/mcp', 'https://m.example/.well-known/oauth-protected-resource/mcp',
      'https://auth.example/.well-known/oauth-authorization-server', 'https://auth.example/.well-known/openid-configuration',
    ]);
  });

  test('§3-11 no challenge scope → PRM scopes_supported', async () => {
    const f = fetchOf({
      'https://m.example/mcp': new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } }),
      'https://m.example/.well-known/oauth-protected-resource/mcp': { resource: 'https://m.example/mcp', authorization_servers: ['https://auth.example'], scopes_supported: ['a', 'b'] },
      'https://auth.example/.well-known/oauth-authorization-server': AS,
    });
    expect((await discover('https://m.example/mcp', f)).scope).toBe('a b');
  });

  test('§5.3 no PRM / no AS metadata → no_metadata; fetch throws → network', async () => {
    await rejects(discover('https://m.example/mcp', fetchOf({}))).toMatchObject({ code: 'no_metadata' });
    const down = (async () => { throw new TypeError('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    await rejects(discover('https://m.example/mcp', down)).toBeInstanceOf(OAuthError);
    await rejects(discover('https://m.example/mcp', down)).toMatchObject({ code: 'network', info: { kind: 'network', host: 'm.example', text: 'connect ECONNREFUSED' } });
    const coded = (async () => { throw Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' }); }) as unknown as typeof fetch;
    await rejects(discover('https://m.example/mcp?k=v', coded)).toMatchObject({ info: { kind: 'network', host: 'm.example', text: 'ConnectionRefused' } });
  });

  test('§5.3 the AS answers a different issuer → issuer_mismatch (never used)', async () => {
    const f = fetchOf({
      'https://m.example/mcp': new Response('', { status: 401 }),
      'https://m.example/.well-known/oauth-protected-resource/mcp': { resource: 'https://m.example/mcp', authorization_servers: ['https://auth.example'] },
      'https://auth.example/.well-known/oauth-authorization-server': { ...AS, issuer: 'https://auth.example/other' },
    });
    await rejects(discover('https://m.example/mcp', f)).toMatchObject({ code: 'issuer_mismatch', info: { kind: 'issuer', expected: 'https://auth.example', received: 'https://auth.example/other' } });
  });
});
