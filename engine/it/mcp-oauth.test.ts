// v2.2 §5.3 / §8 "Integration › OAuth": the engine as OAuth client of a remote MCP server, against fake-mcp + its fake
// AS (fake-mcp/src/oauth-as.ts), the real proxy + Mac HTTP server, and a fake `security` (never /usr/bin/security, never
// the real Keychain). No network outside 127.0.0.1, no browser (the "browser" follows the authorize redirect itself).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { fakeAuthServer, type FakeAs } from '../../fake-mcp/src/oauth-as.ts';
import { startFakeMcp, type FakeMcp } from '../../fake-mcp/src/server.ts';
import { MCP_KEYCHAIN_SERVICE, securityCli } from '../src/keychain.ts';
import { McpOAuth, type OAuthServer } from '../src/mcp/oauth.ts';
import { createMcpProxy, type McpProxy } from '../src/mcp/proxy.ts';
import { TokenRegistry } from '../src/mcp/server.ts';
import type { Db } from '../src/db.ts';
import { startHttp } from '../src/server/http.ts';
import type { WsHub } from '../src/server/ws.ts';
import { makeFakeSecurity, type FakeSecurity } from '../test/_fixtures/fake-security.ts';

setDefaultTimeout(20_000);
const LANE = 'lane-session-token';
const ID = 'user:vercel';

let tmp: string;
let mcp: FakeMcp;
let as: FakeAs;
let sec: FakeSecurity;
let http: Server<unknown> | null = null;
let base: string;
let oauth: McpOAuth;
let proxy: McpProxy;
let servers: Record<string, OAuthServer>;
let opened: string[];
let changed: string[];

beforeAll(() => {
  mcp = startFakeMcp({ routes: (req, url, body) => as.routes(req, url, body) });
  as = fakeAuthServer(() => mcp);
});
afterAll(() => mcp.stop());

function make(o: { retryDelaysMs?: number[]; loginTimeoutMs?: number } = {}): McpOAuth {
  return new McpOAuth({
    keychain: securityCli(sec.bin), server: (id) => servers[id], redirectBase: () => base,
    open: (u) => opened.push(u), onChange: (id) => changed.push(id), ...o,
  });
}

function setup(o: { retryDelaysMs?: number[]; loginTimeoutMs?: number } = {}): void {
  oauth = make(o);
  const tokens = new TokenRegistry({} as Db);
  tokens.register('s1', LANE, { mcpIds: new Set([ID, 'user:other']), cwd: '/w', graph: false }, { role: 'lane', projectId: 'p1' });
  proxy = createMcpProxy({ tokens, upstream: (id) => servers[id] ? { url: servers[id].url, headers: {}, legacySse: false } : undefined, auth: oauth });
  http = startHttp({
    port: 0, token: () => 'ws', staticDir: null, mcp: async () => new Response('mcp'), hub: {} as WsHub,
    mcpProxy: (r) => proxy.handle(r), oauthCallback: (r) => oauth.callback(r),
  });
  base = `http://127.0.0.1:${http.port}`;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-oauth-'));
  sec = makeFakeSecurity(tmp);
  servers = {
    [ID]: { id: ID, name: 'vercel', url: `${mcp.origin}/v3/mcp` },
    'user:other': { id: 'user:other', name: 'other', url: `${mcp.origin}/v2/mcp` },
  };
  opened = [];
  changed = [];
  Object.assign(as.knobs, { issuer: null, methods: ['S256'], noDcr: false, deny: null, responseIss: null, expiresIn: 3600, refreshFail: null, refreshDelayMs: 0 });
  mcp.knobs.requireToken = 'nobody-has-this';
  mcp.knobs.forbidScope = null;
});
afterEach(() => {
  oauth?.stop();
  void http?.stop(true);
  http = null;
  rmSync(tmp, { recursive: true, force: true });
});

const rpc = (method: string, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });
const post = (id = ID, body = rpc('tools/list')) =>
  fetch(`${base}/mcp-proxy/${encodeURIComponent(id)}`, { method: 'POST', body, headers: { authorization: `Bearer ${LANE}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });

/** The "browser": follow the AS's authorize redirect to the engine's callback. */
async function browse(url = opened.at(-1)!): Promise<Response> {
  const r = await fetch(url, { redirect: 'manual' });
  return fetch(r.headers.get('location')!);
}
async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout: ${what}`); await Bun.sleep(10); }
}
async function loggedIn(): Promise<void> {
  await oauth.login(ID);
  expect((await browse()).status).toBe(200);
}
const stored = () => JSON.parse(securityCli(sec.bin)(['find-generic-password', '-s', MCP_KEYCHAIN_SERVICE, '-a', ID, '-w']).stdout) as Record<string, unknown>;

describe('§5.3 login', () => {
  test('§5.3 full round trip: DCR native/none, PKCE S256 + state + resource + scope, callback page, Keychain record, proxy uses the token', async () => {
    setup();
    await oauth.login(ID);
    expect(oauth.view(ID)?.login).toMatchObject({ phase: 'waiting' });
    expect(as.registered.at(-1)).toMatchObject({ application_type: 'native', token_endpoint_auth_method: 'none', redirect_uris: [`${base}/oauth/mcp/callback`] });
    const q = new URL(opened.at(-1)!).searchParams;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(q.get('resource')).toBe(mcp.origin); // the PRM's `resource` (the fake's challenge names the root PRM)
    expect(q.get('scope')).toBe('read');
    const page = await browse();
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Đã đăng nhập vercel, quay lại cc-slaves');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(oauth.view(ID)).toMatchObject({ loggedIn: true, needsLogin: null, keychainFailed: false, login: null, error: null });
    expect(stored()).toMatchObject({ url: `${mcp.origin}/v3/mcp`, issuer: mcp.origin, clientId: 'dcr-' + as.registered.length, accessToken: mcp.knobs.requireToken, scope: 'read' });
    const r = await post();
    expect(r.status).toBe(200);
    expect(mcp.seen.at(-1)!.headers.authorization).toBe(`Bearer ${mcp.knobs.requireToken}`);
    expect(changed).toContain(ID);
  });

  test('§5.3 the AS metadata names another issuer → "issuer_mismatch", nothing opened, nothing stored', async () => {
    setup();
    as.knobs.issuer = 'http://evil.test';
    await oauth.login(ID);
    expect(oauth.view(ID)).toMatchObject({ error: 'issuer_mismatch', login: null, loggedIn: false });
    expect(oauth.view(ID)!.errorDetail).toEqual({ kind: 'issuer', expected: mcp.origin, received: 'http://evil.test' }); // K3e-iss
    expect(opened).toHaveLength(0);
    expect(sec.items()).toEqual({});
  });

  test('§5.3 the authorization response carries a wrong `iss` → stopped, page says so, nothing stored', async () => {
    setup();
    as.knobs.responseIss = 'http://evil.test';
    await oauth.login(ID);
    const page = await browse();
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('Máy chủ trả issuer khác');
    expect(oauth.view(ID)).toMatchObject({ error: 'issuer_mismatch', loggedIn: false });
    expect(oauth.view(ID)!.errorDetail).toEqual({ kind: 'issuer', expected: mcp.origin, received: 'http://evil.test' }); // K3e-iss
    expect(sec.items()).toEqual({});
  });

  test('§5.3 K3e-net the network error names the host and the error code, never a token; the next login clears it', async () => {
    setup();
    const good = servers[ID]!;
    servers[ID] = { ...good, url: 'http://127.0.0.1:1/mcp' };
    await oauth.login(ID);
    const v = oauth.view(ID)!;
    expect(v.error).toBe('network');
    expect(v.errorDetail).toMatchObject({ kind: 'network', host: '127.0.0.1:1' });
    expect(v.errorDetail?.kind === 'network' && v.errorDetail.text.length > 0).toBe(true);
    servers[ID] = good;
    as.knobs.methods = ['plain'];
    await oauth.login(ID);
    expect(oauth.view(ID)).toMatchObject({ error: 'no_s256' });
    expect(oauth.view(ID)!.errorDetail).toBeUndefined();
  });

  test('§5.3 no S256 → "no_s256"; no DCR → "client_registration", then a PO Client ID + secret works and lives only in the Keychain', async () => {
    setup();
    as.knobs.methods = ['plain'];
    await oauth.login(ID);
    expect(oauth.view(ID)?.error).toBe('no_s256');
    as.knobs.methods = ['S256'];
    as.knobs.noDcr = true;
    await oauth.login(ID);
    expect(oauth.view(ID)?.error).toBe('client_registration');
    await oauth.login(ID, { clientId: 'po-client', clientSecret: 'po-secret-XYZ' });
    expect(new URL(opened.at(-1)!).searchParams.get('client_id')).toBe('po-client');
    expect((await browse()).status).toBe(200);
    expect(stored()).toMatchObject({ clientId: 'po-client', clientSecret: 'po-secret-XYZ' });
  });

  test('§5.3 an entry `oauth.clientId` is the default client (no DCR)', async () => {
    setup();
    servers[ID] = { ...servers[ID]!, clientId: 'cfg-client' };
    const n = as.registered.length;
    await oauth.login(ID);
    expect(as.registered.length).toBe(n);
    expect(new URL(opened.at(-1)!).searchParams.get('client_id')).toBe('cfg-client');
  });

  test('§6 K4 "Đăng nhập: Không": a 401 of a server with no OAuth target marks nothing (no stale "Cần đăng nhập" once it is back on Tự động)', () => {
    setup();
    const s = servers[ID]!;
    delete servers[ID];
    const n = changed.length;
    oauth.markNeedsLogin(ID);
    expect(changed.length).toBe(n);
    servers[ID] = s;
    expect(oauth.view(ID)!.needsLogin).toBeNull();
  });

  test('§5.3 denied in the browser → "denied"; the page escapes error_description and has the CSP + no-store', async () => {
    setup();
    as.knobs.deny = '<script>alert(1)</script>';
    await oauth.login(ID);
    const page = await browse();
    const html = await page.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(oauth.view(ID)?.error).toBe('denied');
  });

  test('§5.3 10 min (here: 150 ms) without a callback → "timeout"; a late callback is refused', async () => {
    setup({ loginTimeoutMs: 150 });
    await oauth.login(ID);
    await until(() => oauth.view(ID)?.error === 'timeout', 'timeout');
    const page = await browse();
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('Phiên đăng nhập đã hết');
    expect(sec.items()).toEqual({});
  });

  test('§5.3 engine restarted while waiting → the late callback is refused, nothing stored', async () => {
    setup();
    await oauth.login(ID);
    oauth.stop();
    oauth = make(); // a new engine run: no pending login
    const page = await browse();
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('Phiên đăng nhập đã hết — đăng nhập lại trong cc-slaves');
    expect(sec.items()).toEqual({});
    expect(oauth.token(ID)).toBeUndefined();
  });

  test('§5.3 C10 `oauth.callbackPort` → a temporary 127.0.0.1:<port>/callback listener only while waiting (done / cancel)', async () => {
    setup();
    const port = 47000 + Math.floor(Math.random() * 900);
    servers[ID] = { ...servers[ID]!, clientId: 'pre', callbackPort: port };
    const up = () => fetch(`http://127.0.0.1:${port}/callback`).then(() => true, () => false);
    expect(await up()).toBe(false);
    await oauth.login(ID);
    expect(new URL(opened.at(-1)!).searchParams.get('redirect_uri')).toBe(`http://localhost:${port}/callback`);
    expect(await up()).toBe(true);
    const r = await fetch(opened.at(-1)!, { redirect: 'manual' });
    const back = new URL(r.headers.get('location')!);
    expect((await fetch(`http://127.0.0.1:${port}${back.pathname}${back.search}`)).status).toBe(200);
    expect(oauth.view(ID)?.loggedIn).toBe(true);
    expect(await up()).toBe(false);
    await oauth.login(ID);
    expect(await up()).toBe(true);
    oauth.cancelLogin(ID);
    expect(oauth.view(ID)?.login).toBeNull();
    expect(await up()).toBe(false);
  });

  test('§5.2 step-up: a 403 insufficient_scope → the next login asks the union of the old and new scope', async () => {
    setup();
    await loggedIn();
    oauth.markNeedsLogin(ID, 'files:write');
    expect(oauth.view(ID)?.needsLogin).toEqual({ reason: 'insufficient_scope', scope: 'files:write' });
    await oauth.login(ID);
    expect(new URL(opened.at(-1)!).searchParams.get('scope')!.split(' ').sort()).toEqual(['files:write', 'read']);
  });
});

describe('§5.3 refresh', () => {
  test('§5.2 401 → one refresh → resend; the rotated refresh token is stored', async () => {
    setup();
    await loggedIn();
    const before = stored().refreshToken;
    mcp.knobs.requireToken = 'rotated-upstream';
    as.knobs.refreshFail = null;
    const r0 = as.refreshes();
    // the next issue() sets requireToken to the new access token: the resend passes
    const r = await post();
    expect(r.status).toBe(200);
    expect(as.refreshes()).toBe(r0 + 1);
    expect(stored().refreshToken).toBe(as.refreshToken());
    expect(stored().refreshToken).not.toBe(before);
    expect(oauth.view(ID)?.refreshedAt).toBeNumber();
  });

  test('§5.3 two concurrent 401s → one refresh (single-flight)', async () => {
    setup();
    await loggedIn();
    mcp.knobs.requireToken = 'rotated-upstream';
    as.knobs.refreshDelayMs = 150;
    const r0 = as.refreshes();
    const rs = await Promise.all([post(), post(ID, rpc('initialize', 2)), post(ID, rpc('ping', 3))]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(as.refreshes()).toBe(r0 + 1);
  });

  test('§5.3 A3 refresh network error / 5xx → token kept, the lane gets 502 (not 401), no "Cần đăng nhập lại"', async () => {
    setup();
    await loggedIn();
    const token = oauth.token(ID);
    mcp.knobs.requireToken = 'rotated-upstream';
    as.knobs.refreshFail = 503;
    const r = await post();
    expect(r.status).toBe(502);
    expect(oauth.token(ID)).toBe(token);
    expect(oauth.view(ID)?.needsLogin).toBeNull();
    expect(stored().accessToken).toBe(token);
  });

  test('§5.3 invalid_grant → "Cần đăng nhập lại" (needs_relogin reason invalid_grant), the lane gets 401', async () => {
    setup();
    await loggedIn();
    mcp.knobs.requireToken = 'rotated-upstream';
    as.knobs.refreshFail = 'invalid_grant';
    const r = await post();
    expect(r.status).toBe(401);
    expect(oauth.view(ID)).toMatchObject({ loggedIn: false, needsLogin: { reason: 'invalid_grant', scope: null } });
    expect(oauth.token(ID)).toBeUndefined();
  });

  test('§5.3 < 60 s left → token() starts a refresh by itself (one)', async () => {
    setup();
    as.knobs.expiresIn = 30;
    await loggedIn();
    const r0 = as.refreshes();
    oauth.token(ID);
    oauth.token(ID);
    await until(() => as.refreshes() === r0 + 1 && oauth.view(ID)?.refreshedAt !== null, 'proactive refresh');
    await Bun.sleep(50);
    expect(as.refreshes()).toBe(r0 + 1);
  });

  test('§5.3 rotation then Keychain write fails ×4 → proxy keeps working on the in-memory token, yellow state; "Thử lưu lại" clears it', async () => {
    setup({ retryDelaysMs: [10, 10, 10] });
    await loggedIn();
    mcp.knobs.requireToken = 'rotated-upstream';
    sec.failWrites(4);
    expect((await post()).status).toBe(200);
    await until(() => oauth.view(ID)?.keychainFailed === true, 'yellow');
    expect(oauth.token(ID)).toBe(mcp.knobs.requireToken ?? '');
    expect((await post()).status).toBe(200);
    expect(stored().refreshToken).not.toBe(as.refreshToken()); // the Keychain still has the old one
    expect(oauth.retrySave(ID)).toBe(true);
    expect(oauth.view(ID)?.keychainFailed).toBe(false);
    expect(stored().refreshToken).toBe(as.refreshToken());
  });
});

describe('§5.3 keep / move / drop', () => {
  test('§5.3 a restart reads the Keychain record back (token works without a login)', async () => {
    setup();
    await loggedIn();
    const t = oauth.token(ID);
    oauth.stop();
    oauth = make();
    expect(oauth.token(ID)).toBe(t);
    expect(oauth.view(ID)?.loggedIn).toBe(true);
  });

  test('§5.3 token keyed by (id, normalized URL): the URL changed in the source → the stored token is not used', async () => {
    setup();
    await loggedIn();
    oauth.stop();
    servers[ID] = { ...servers[ID]!, url: `${mcp.origin}/v2/mcp` };
    oauth = make();
    expect(oauth.token(ID)).toBeUndefined();
  });

  test('§5.3 logout → revoke at the AS, then the Keychain item is deleted', async () => {
    setup();
    await loggedIn();
    const rt = stored().refreshToken as string;
    await oauth.logout(ID);
    expect(as.revoked).toContain(rt);
    expect(sec.items()).toEqual({});
    expect(oauth.token(ID)).toBeUndefined();
    expect(oauth.view(ID)?.loggedIn).toBe(false);
  });

  test('§5.3 rename moves the Keychain record to the new id (write, read back, delete old)', async () => {
    setup();
    await loggedIn();
    const t = oauth.token(ID);
    servers['user:vercel2'] = { ...servers[ID]!, id: 'user:vercel2', name: 'vercel2' };
    oauth.rename(ID, 'user:vercel2');
    expect(Object.keys(sec.items())).toEqual([`${MCP_KEYCHAIN_SERVICE}/user:vercel2`]);
    expect(oauth.token('user:vercel2')).toBe(t);
    expect(oauth.token(ID)).toBeUndefined();
  });

  test('§8 A2 no access / refresh token string in any `security` argv', async () => {
    setup();
    await loggedIn();
    mcp.knobs.requireToken = 'rotated-upstream';
    expect((await post()).status).toBe(200);
    const argv = sec.log().join('\n');
    const logs = JSON.stringify(proxy.log.lines(ID)) + JSON.stringify(oauth.view(ID));
    const rec = stored();
    for (const s of [rec.accessToken, rec.refreshToken, ...as.tokenCalls.map((f) => f.get('refresh_token')).filter(Boolean)]) {
      expect(argv).not.toContain(String(s));
      expect(logs).not.toContain(String(s));
    }
  });
});
