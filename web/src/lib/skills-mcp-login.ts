// v2.2 §5.3 / §6 K3 the MCP login dialog's logic (lazy chunk): which stage the engine's OAuth state shows, which errors
// a retry cannot fix, the redirect address the PO registers (K3e-client).
import type { McpLoginDetail, McpLoginError, McpOAuthView, McpRowView } from '../../../shared/protocol.ts';

export type K3Stage =
  | { s: 'find' }
  | { s: 'wait'; url: string | null; until: number | null }
  | { s: 'error'; err: McpLoginError; detail?: McpLoginDetail }
  | { s: 'done' }
  | { s: 'idle' };

/** §5.3 K3 / K3e: a login in flight (finding the AS, then the browser), its named error, done, or nothing going on. */
export function k3Stage(o: McpOAuthView | undefined): K3Stage {
  if (!o) return { s: 'idle' };
  if (o.login) return o.login.phase === 'waiting' ? { s: 'wait', url: o.login.url, until: o.login.until } : { s: 'find' };
  if (o.error) return { s: 'error', err: o.error, ...(o.errorDetail ? { detail: o.errorDetail } : {}) };
  return o.loggedIn ? { s: 'done' } : { s: 'idle' };
}

/**
 * §6 K3 the stage to draw: "find" until `mcp_login` is acked; then the ack's own state until a view pushed after the ack
 * lands (the snapshot may still hold the last login's error or logged-in state), then the live state.
 */
export function k3Live<V>(ack: { ref: V; o: McpOAuthView | undefined } | null, view: V, live: McpOAuthView | undefined): K3Stage {
  if (!ack) return { s: 'find' };
  if (view === ack.ref) return ack.o ? k3Stage(ack.o) : { s: 'find' };
  return k3Stage(live);
}

/** §5.3 errors a retry cannot help (iss wrong, no S256, no metadata): the primary button is "Đóng". */
export const K3_FATAL: ReadonlySet<McpLoginError> = new Set<McpLoginError>(['issuer_mismatch', 'no_s256', 'no_metadata']);

/** §5.3 the redirect the AS must know: the entry's pre-registered `oauth.callbackPort` (C10), else the Mac callback. */
export function redirectUri(r: Pick<McpRowView, 'config'>, origin: string): string {
  const port = (r.config.oauth as { callbackPort?: unknown } | undefined)?.callbackPort;
  return typeof port === 'number' ? `http://localhost:${port}/callback` : `${origin}/oauth/mcp/callback`;
}
