// v2.2 §5.3 the engine as OAuth client of remote MCP servers — the proxy's `UpstreamAuth` (§5.2). One record per server
// in the Keychain (`cc-slaves-mcp` / `<id>`, split ≤ 3 900 B, written through `security -i` stdin), keyed by (id,
// normalized URL), mirrored in memory. Refresh: ahead of expiry (< 60 s) or on an upstream 401, one in flight per
// server; a rotated refresh token goes to memory first, then the Keychain (3 retries, then the yellow state). Only
// `invalid_grant` makes a server "Cần đăng nhập lại" (A3). Login: discovery → client (entry `oauth.clientId`, PO's
// Client ID, else DCR) → PKCE S256 authorize link opened in the browser → `/oauth/mcp/callback` (or a temporary
// `127.0.0.1:<oauth.callbackPort>/callback`, C10). Pending logins live in memory only: a callback after an engine
// restart, a timeout or a cancel finds no state and is refused.
import type { Server } from 'bun';
import type { McpLoginDetail, McpLoginError, McpOAuthView } from '../../../shared/protocol.ts';
import { deleteSplit, MCP_KEYCHAIN_SERVICE, readSplit, writeSplit, type SecurityCli } from '../keychain.ts';
import type { CatalogEntry } from './catalog.ts';
import { exchangeCode, pkce, randomId, refreshTokens, registerClient, revokeToken, type Client } from './oauth-client.ts';
import { canonicalResource, discover, fetchAsMeta, OAuthError, type AsMeta } from './oauth-discovery.ts';
import { callbackPage } from './oauth-page.ts';
import type { UpstreamAuth } from './proxy.ts';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** §5.3 refresh ahead when less than this is left. */
const REFRESH_AHEAD_MS = 60_000;
/** A failed (network / 5xx) refresh is not retried ahead of expiry sooner than this (the 401 path still is). */
const REFRESH_BACKOFF_MS = 30_000;
/** §5.3 Keychain write retries after the first failure. */
const SAVE_RETRY_MS: readonly number[] = [1000, 5000, 30_000];
const CALLBACK_PATH = '/oauth/mcp/callback';

/** What the OAuth client needs of a catalog entry. */
export interface OAuthServer { id: string; name: string; url: string; clientId?: string; callbackPort?: number }

/** A remote http / sse entry → its OAuth view (`oauth.clientId`, `oauth.callbackPort` are read, never written);
 *  none for an id in config `mcp.noLogin` (K4 "Đăng nhập: Không"). */
export function oauthServerOf(catalog: readonly CatalogEntry[], id: string, noLogin: readonly string[] = []): OAuthServer | undefined {
  const e = noLogin.includes(id) ? undefined : catalog.find((x) => x.id === id);
  if (!e || e.error?.code === 'bad_name' || (e.kind !== 'http' && e.kind !== 'sse') || typeof e.config.url !== 'string') return undefined;
  const o = typeof e.config.oauth === 'object' && e.config.oauth !== null ? e.config.oauth as Record<string, unknown> : {};
  return {
    id, name: e.name, url: e.config.url,
    ...(typeof o.clientId === 'string' && o.clientId ? { clientId: o.clientId } : {}),
    ...(typeof o.callbackPort === 'number' && Number.isInteger(o.callbackPort) && o.callbackPort > 0 && o.callbackPort < 65536 ? { callbackPort: o.callbackPort } : {}),
  };
}

/** §5.3 the Keychain JSON (+ `resource`, so a refresh after a restart sends the same RFC 8707 value). */
interface TokenRecord {
  url: string; issuer: string; resource: string; clientId: string; clientSecret?: string;
  accessToken: string; refreshToken?: string; expiresAt: number; scope: string;
}

interface Held { rec: TokenRecord; refreshedAt: number | null; keychainFailed: boolean }
type NeedsLogin = NonNullable<McpOAuthView['needsLogin']>;

interface Pending {
  id: string;
  phase: 'discovering' | 'waiting' | 'exchanging';
  url: string | null;
  until: number | null;
  state: string | null;
  verifier: string;
  redirectUri: string;
  as: AsMeta | null;
  resource: string;
  client: Client | null;
  scope: string;
  timer: ReturnType<typeof setTimeout> | null;
  listener: { server: Server<unknown>; busy: number } | null;
}

export interface McpOAuthDeps {
  keychain: SecurityCli;
  fetch?: typeof fetch;
  server: (id: string) => OAuthServer | undefined;
  /** `http://127.0.0.1:<Mac port>` (the DCR redirect is `<this>/oauth/mcp/callback`). */
  redirectBase: () => string;
  /** The default browser (§5.3: not a private window); tests record the URL. */
  open: (url: string) => void;
  /** Any state change of `id` (view push, K13 card). */
  onChange?: (id: string) => void;
  /** A login landed: §5.4b re-check `id` ("sau … đăng nhập"). */
  onLoggedIn?: (id: string) => void;
  retryDelaysMs?: readonly number[];
  loginTimeoutMs?: number;
  now?: () => number;
}

const isRecord = (v: unknown): v is TokenRecord => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.url === 'string' && typeof r.issuer === 'string' && typeof r.clientId === 'string' && typeof r.accessToken === 'string' && typeof r.expiresAt === 'number';
};
const parseRecord = (raw: string | null): TokenRecord | null => {
  if (raw === null) return null;
  try { const j: unknown = JSON.parse(raw); return isRecord(j) ? { ...j, resource: j.resource || canonicalResource(j.url), scope: j.scope ?? '' } : null; } catch { return null; }
};
/** Same server URL after RFC 8707 normalization (the token key, §5.3). */
export const sameUrl = (a: string, b: string): boolean => { try { return canonicalResource(a) === canonicalResource(b); } catch { return false; } };
const scopeUnion = (...s: (string | null | undefined)[]): string => [...new Set(s.flatMap((x) => (x ?? '').split(' ')).filter(Boolean))].join(' ');

export class McpOAuth implements UpstreamAuth {
  private readonly held = new Map<string, Held>();
  /** Ids whose Keychain record was read this run (a miss is remembered too). */
  private readonly loaded = new Set<string>();
  private readonly needs = new Map<string, NeedsLogin>();
  /** K3e the last login's error + its detail lines. */
  private readonly errors = new Map<string, { code: McpLoginError; detail?: McpLoginDetail }>();
  private readonly pending = new Map<string, Pending>();
  private readonly byState = new Map<string, Pending>();
  private readonly refreshing = new Map<string, Promise<'ok' | 'invalid_grant' | 'error'>>();
  private readonly refreshFailedAt = new Map<string, number>();
  private readonly meta = new Map<string, AsMeta>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly d: McpOAuthDeps) {
    this.f = d.fetch ?? fetch;
    this.now = d.now ?? Date.now;
  }

  private changed(id: string): void { if (!this.stopped) this.d.onChange?.(id); }

  /** The in-memory record (read from the Keychain once per run), only while the entry still has the same URL. */
  private hold(id: string): Held | undefined {
    const s = this.d.server(id);
    if (!s) return undefined;
    if (!this.loaded.has(id)) {
      this.loaded.add(id);
      const rec = parseRecord(readSplit(this.d.keychain, MCP_KEYCHAIN_SERVICE, id));
      if (rec && !this.held.has(id)) this.held.set(id, { rec, refreshedAt: null, keychainFailed: false });
    }
    const h = this.held.get(id);
    return h && sameUrl(h.rec.url, s.url) ? h : undefined;
  }

  // ---------- UpstreamAuth (the proxy) ----------

  token(id: string): string | undefined {
    const h = this.hold(id);
    if (!h) return undefined;
    const failed = this.refreshFailedAt.get(id);
    if (h.rec.refreshToken && h.rec.expiresAt - this.now() < REFRESH_AHEAD_MS && (failed === undefined || this.now() - failed > REFRESH_BACKOFF_MS)) {
      void this.refresh(id);
    }
    return h.rec.accessToken;
  }

  refresh(id: string): Promise<'ok' | 'invalid_grant' | 'error'> {
    let p = this.refreshing.get(id);
    if (!p) {
      p = this.doRefresh(id).catch(() => 'error' as const).finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, p);
    }
    return p;
  }

  private async doRefresh(id: string): Promise<'ok' | 'invalid_grant' | 'error'> {
    const h = this.hold(id);
    if (!h) return 'invalid_grant';
    if (!h.rec.refreshToken) { this.dropDead(id); return 'invalid_grant'; }
    let as: AsMeta;
    try { as = await this.asMeta(h.rec.issuer); } catch { this.refreshFailedAt.set(id, this.now()); return 'error'; }
    const r = await refreshTokens(this.f, as, this.clientOf(h.rec), { refreshToken: h.rec.refreshToken, scope: h.rec.scope, resource: h.rec.resource }, this.now());
    if ('fail' in r) {
      if (r.fail === 'invalid_grant') { this.dropDead(id); return 'invalid_grant'; }
      this.refreshFailedAt.set(id, this.now());
      return 'error';
    }
    this.refreshFailedAt.delete(id);
    const cur = this.held.get(id) ?? h;
    // memory first (the AS already rotated the refresh token), then the Keychain
    this.held.set(id, { rec: { ...cur.rec, ...r.ok, scope: r.ok.scope ?? cur.rec.scope }, refreshedAt: this.now(), keychainFailed: cur.keychainFailed });
    this.persist(id, 0);
    this.changed(id);
    return 'ok';
  }

  /** `invalid_grant`: the in-memory login is dead → "Cần đăng nhập lại" (the stale Keychain item is overwritten by the next login). */
  private dropDead(id: string): void {
    this.held.delete(id);
    this.needs.set(id, { reason: 'invalid_grant', scope: null });
    this.changed(id);
  }

  markNeedsLogin(id: string, scope?: string): void {
    if (!this.d.server(id)) return; // K4 "Đăng nhập: Không" (or gone): a 401 is the server's error, not a login to ask for
    const prev = this.needs.get(id);
    if (scope !== undefined) this.needs.set(id, { reason: 'insufficient_scope', scope });
    else if (this.hold(id)) this.needs.set(id, { reason: 'invalid_grant', scope: null });
    else if (prev?.reason !== 'invalid_grant' && prev?.reason !== 'insufficient_scope') this.needs.set(id, { reason: 'no_token', scope: null });
    this.changed(id);
  }

  // ---------- Keychain ----------

  /** Write `id`'s in-memory record; failures retry on SAVE_RETRY_MS, then the yellow state. True when stored now. */
  private persist(id: string, attempt: number): boolean {
    const t = this.saveTimers.get(id);
    if (t) { clearTimeout(t); this.saveTimers.delete(id); }
    const h = this.held.get(id);
    if (!h || this.stopped) return false;
    try {
      writeSplit(this.d.keychain, MCP_KEYCHAIN_SERVICE, id, JSON.stringify(h.rec));
      if (h.keychainFailed) { h.keychainFailed = false; this.changed(id); }
      return true;
    } catch {
      const delay = (this.d.retryDelaysMs ?? SAVE_RETRY_MS)[attempt];
      if (delay === undefined) {
        if (!h.keychainFailed) { h.keychainFailed = true; this.changed(id); }
      } else {
        this.saveTimers.set(id, setTimeout(() => { this.saveTimers.delete(id); this.persist(id, attempt + 1); }, delay));
      }
      return false;
    }
  }

  /** §5.3 "Thử lưu lại": one write now (no retry chain). */
  retrySave(id: string): boolean {
    return this.persist(id, Number.MAX_SAFE_INTEGER);
  }

  private clientOf(rec: Pick<TokenRecord, 'clientId' | 'clientSecret'>): Client {
    return { clientId: rec.clientId, ...(rec.clientSecret ? { clientSecret: rec.clientSecret } : {}) };
  }

  private async asMeta(issuer: string): Promise<AsMeta> {
    const m = this.meta.get(issuer);
    if (m) return m;
    const fresh = await fetchAsMeta(this.f, issuer);
    this.meta.set(issuer, fresh);
    return fresh;
  }

  // ---------- login (K3) ----------

  async login(id: string, client: { clientId?: string; clientSecret?: string } = {}): Promise<void> {
    const s = this.d.server(id);
    if (!s) return;
    this.cancelLogin(id);
    this.errors.delete(id);
    const p: Pending = {
      id, phase: 'discovering', url: null, until: null, state: null, verifier: '', redirectUri: '', as: null, resource: '',
      client: null, scope: '', timer: null, listener: null,
    };
    this.pending.set(id, p);
    this.changed(id);
    try {
      const disc = await discover(s.url, this.f);
      if (this.pending.get(id) !== p) return;
      p.redirectUri = s.callbackPort ? `http://localhost:${s.callbackPort}/callback` : `${this.d.redirectBase()}${CALLBACK_PATH}`;
      const clientId = client.clientId || s.clientId || await registerClient(this.f, disc.as, p.redirectUri);
      if (this.pending.get(id) !== p) return;
      if (s.callbackPort) p.listener = this.listen(s.callbackPort);
      const { verifier, challenge } = pkce();
      p.as = disc.as;
      p.resource = disc.resource;
      p.verifier = verifier;
      p.client = { clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}) };
      p.scope = scopeUnion(disc.scope, this.needs.get(id)?.scope, this.held.get(id)?.rec.scope);
      p.state = randomId(16);
      const u = new URL(disc.as.authorization_endpoint);
      const q: Record<string, string> = {
        response_type: 'code', client_id: clientId, redirect_uri: p.redirectUri, code_challenge: challenge,
        code_challenge_method: 'S256', state: p.state, resource: disc.resource, ...(p.scope ? { scope: p.scope } : {}),
      };
      for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
      this.meta.set(disc.as.issuer, disc.as);
      const timeout = this.d.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
      p.phase = 'waiting';
      p.url = u.toString();
      p.until = this.now() + timeout;
      p.timer = setTimeout(() => this.fail(p, 'timeout'), timeout);
      this.byState.set(p.state, p);
      this.changed(id);
      this.d.open(p.url);
    } catch (e) {
      this.fail(p, e instanceof OAuthError ? e.code : 'network', e instanceof OAuthError ? e.info : undefined);
    }
  }

  /** C10: `127.0.0.1:<port>/callback`, only while this login waits. Port taken → throws (K3e "Lỗi mạng"). */
  private listen(port: number): NonNullable<Pending['listener']> {
    const l = { server: null as unknown as Server<unknown>, busy: 0 };
    try {
      l.server = Bun.serve({
        hostname: '127.0.0.1', port,
        // `connection: close`: no keep-alive socket outlives the listener once the login ends
        fetch: async (req) => {
          l.busy++;
          try {
            const r = new URL(req.url).pathname === '/callback' ? await this.callback(req) : new Response('not found', { status: 404 });
            r.headers.set('connection', 'close');
            return r;
          } finally { l.busy--; }
        },
      });
    } catch { throw new OAuthError('network', `callback port ${port} in use`, { kind: 'network', host: `127.0.0.1:${port}`, text: 'EADDRINUSE' }); }
    return l;
  }

  private end(p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    // ended by its own callback → let that answer go out (graceful); cancel / timeout → close now
    if (p.listener) void p.listener.server.stop(p.listener.busy === 0);
    p.listener = null;
    if (this.pending.get(p.id) === p) this.pending.delete(p.id);
    if (p.state) this.byState.delete(p.state);
  }

  private fail(p: Pending, code: McpLoginError, detail?: McpLoginDetail): void {
    if (this.pending.get(p.id) !== p) return;
    this.end(p);
    this.errors.set(p.id, detail ? { code, detail } : { code });
    this.changed(p.id);
  }

  /** K3 "Huỷ". */
  cancelLogin(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.end(p);
    this.changed(id);
  }

  /** §5.3 `GET /oauth/mcp/callback`: state (this run only) → `iss` → code exchange → store. Always a static page. */
  async callback(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const p = this.byState.get(q.get('state') ?? '');
    if (!p || p.phase !== 'waiting' || !p.as || !p.client) return callbackPage(400, 'skillsMcp.oauth.page.expired');
    const name = this.d.server(p.id)?.name ?? p.id;
    const iss = q.get('iss');
    if (iss !== null ? iss !== p.as.issuer : p.as.authorization_response_iss_parameter_supported === true) {
      this.fail(p, 'issuer_mismatch', { kind: 'issuer', expected: p.as.issuer, received: iss });
      return callbackPage(400, 'skillsMcp.oauth.page.issuer');
    }
    const error = q.get('error');
    const code = q.get('code');
    if (error !== null || !code) {
      const k: McpLoginError = error === 'access_denied' ? 'denied' : error === 'unauthorized_client' || error === 'invalid_client' ? 'client_registration' : 'network';
      this.fail(p, k);
      const detail = q.get('error_description') ?? error ?? undefined;
      return callbackPage(400, k === 'denied' ? 'skillsMcp.oauth.page.denied' : 'skillsMcp.oauth.page.failed', { name }, detail);
    }
    p.phase = 'exchanging';
    if (p.state) this.byState.delete(p.state);
    let set;
    try {
      set = await exchangeCode(this.f, p.as, p.client, { code, redirectUri: p.redirectUri, verifier: p.verifier, resource: p.resource }, this.now());
    } catch (e) {
      p.phase = 'waiting';
      this.fail(p, e instanceof OAuthError ? e.code : 'network', e instanceof OAuthError ? e.info : undefined);
      return callbackPage(502, 'skillsMcp.oauth.page.failed', { name });
    }
    const s = this.d.server(p.id);
    if (this.pending.get(p.id) !== p || !s) return callbackPage(400, 'skillsMcp.oauth.page.expired');
    this.end(p);
    const rec: TokenRecord = {
      url: s.url, issuer: p.as.issuer, resource: p.resource, ...p.client, accessToken: set.accessToken,
      ...(set.refreshToken ? { refreshToken: set.refreshToken } : {}), expiresAt: set.expiresAt, scope: set.scope ?? p.scope,
    };
    this.held.set(p.id, { rec, refreshedAt: null, keychainFailed: false });
    this.loaded.add(p.id);
    this.needs.delete(p.id);
    this.errors.delete(p.id);
    this.refreshFailedAt.delete(p.id);
    this.persist(p.id, 0);
    this.changed(p.id);
    if (!this.stopped) this.d.onLoggedIn?.(p.id);
    return callbackPage(200, 'skillsMcp.oauth.page.ok', { name });
  }

  // ---------- logout / remove / rename / URL change ----------

  /** §5.3 "Đăng xuất", remove, URL change: revoke at the AS (best effort), then delete the Keychain item. */
  async logout(id: string): Promise<void> {
    this.cancelLogin(id);
    const rec = this.held.get(id)?.rec ?? parseRecord(readSplit(this.d.keychain, MCP_KEYCHAIN_SERVICE, id));
    if (rec) {
      try {
        const as = await this.asMeta(rec.issuer);
        await revokeToken(this.f, as, this.clientOf(rec), rec.refreshToken ?? rec.accessToken, rec.refreshToken ? 'refresh_token' : 'access_token');
      } catch { /* AS gone: still forget the login */ }
    }
    const t = this.saveTimers.get(id);
    if (t) { clearTimeout(t); this.saveTimers.delete(id); }
    deleteSplit(this.d.keychain, MCP_KEYCHAIN_SERVICE, id);
    this.held.delete(id);
    this.loaded.add(id);
    this.needs.delete(id);
    this.errors.delete(id);
    this.changed(id);
  }

  /** §5.3 rename: write the record under the new id, read it back, then delete the old one. */
  rename(from: string, to: string): void {
    const h = this.held.get(from);
    const raw = h ? JSON.stringify(h.rec) : readSplit(this.d.keychain, MCP_KEYCHAIN_SERVICE, from);
    this.cancelLogin(from);
    if (raw === null) return;
    const rec = parseRecord(raw);
    let ok = false;
    try {
      writeSplit(this.d.keychain, MCP_KEYCHAIN_SERVICE, to, raw);
      ok = readSplit(this.d.keychain, MCP_KEYCHAIN_SERVICE, to) === raw;
    } catch { ok = false; }
    if (ok) deleteSplit(this.d.keychain, MCP_KEYCHAIN_SERVICE, from);
    this.held.delete(from);
    if (rec) this.held.set(to, { rec, refreshedAt: h?.refreshedAt ?? null, keychainFailed: !ok });
    this.loaded.add(to);
    this.loaded.add(from);
    for (const m of [this.needs, this.errors] as Map<string, unknown>[]) { if (m.has(from)) { m.set(to, m.get(from)); m.delete(from); } }
    this.changed(to);
  }

  // ---------- view ----------

  /** §5.3 / K3 / K13 state of a remote server (null: not a remote catalog entry). Never a token. */
  view(id: string): McpOAuthView | null {
    if (!this.d.server(id)) return null;
    const h = this.hold(id);
    const p = this.pending.get(id);
    const e = this.errors.get(id);
    return {
      loggedIn: h !== undefined, expiresAt: h?.rec.expiresAt ?? null, refreshedAt: h?.refreshedAt ?? null,
      needsLogin: this.needs.get(id) ?? null, keychainFailed: h?.keychainFailed ?? false,
      login: p ? { phase: p.phase === 'discovering' ? 'discovering' : 'waiting', url: p.url, until: p.until } : null,
      error: e?.code ?? null, ...(e?.detail ? { errorDetail: e.detail } : {}),
    };
  }

  stop(): void {
    this.stopped = true;
    for (const p of [...this.pending.values()]) this.end(p);
    for (const t of this.saveTimers.values()) clearTimeout(t);
    this.saveTimers.clear();
  }
}
