// WS client (spec §7.9): connect to /ws, reconnect with backoff, `command` id → promise settled by `ack` / `error`.
import { t } from '../../../shared/i18n/core.ts';
import type { ClientMsg, Command, ServerMsg } from '../../../shared/protocol.ts';
import type { Conn } from './store.ts';

export class CommandError extends Error {
  /** §6A `key` (+ `params`): the catalog text the UI shows instead of the Vietnamese `message` (lib/i18n errText). */
  constructor(public code: string, message: string, public key?: string, public params?: Record<string, string | number>) { super(message); }
}

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
}
type WsCtor = new (url: string) => WsLike;
interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void; now(): number }

export const backoffMs = (attempt: number) => Math.min(10_000, 500 * 2 ** (attempt - 1));

/** Token: Tauri injects `window.__CC_TOKEN__`; dev passes `?token=`. Remote (phone) rides on cookies, no token. */
export function wsUrl(loc: { protocol: string; host: string; search: string }, injected: string | undefined): string {
  const token = injected ?? new URLSearchParams(loc.search).get('token');
  const base = `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export interface ClientOpts {
  url: string;
  WebSocketImpl?: WsCtor;
  timers?: Timers;
  onMessage: (m: ServerMsg) => void;
  onStatus: (c: Conn) => void;
}

export class EngineClient {
  private ws: WsLike | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: CommandError) => void }>();
  private attempt = 0;
  private since: number | null = null;
  private timer: unknown = null;
  private disposed = false;
  private seq = 0;
  private readonly Ws: WsCtor;
  private readonly t: Timers;

  constructor(private o: ClientOpts) {
    this.Ws = o.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsCtor);
    this.t = o.timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: id => clearTimeout(id as never), now: () => Date.now() };
  }

  connect(): void {
    if (this.disposed) return;
    if (!this.attempt) this.o.onStatus({ status: 'connecting', attempt: 0, since: null }); // retries: onclose already reported
    const ws = new this.Ws(this.o.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.since = null;
      this.o.onStatus({ status: 'open', attempt: 0, since: null });
    };
    ws.onmessage = e => this.onData(e.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new CommandError('disconnected', t('vi', 'labels.wsDisconnected'), 'labels.wsDisconnected'));
      this.pending.clear();
      if (this.disposed) return;
      this.attempt++;
      this.since ??= this.t.now();
      this.o.onStatus({ status: 'reconnecting', attempt: this.attempt, since: this.since });
      this.timer = this.t.setTimeout(() => this.connect(), backoffMs(this.attempt));
    };
  }

  private onData(data: unknown) {
    let m: ServerMsg;
    try { m = JSON.parse(String(data)) as ServerMsg; } catch { return; }
    if (m.type === 'ack' || m.type === 'error') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'ack') p.resolve(m.result);
      else p.reject(new CommandError(m.code, m.message, m.key, m.params));
      return;
    }
    this.o.onMessage(m);
  }

  send(command: Command): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new CommandError('offline', t('vi', 'labels.wsOffline'), 'labels.wsOffline'));
    const id = `c${++this.seq}-${this.t.now().toString(36)}`;
    const msg: ClientMsg = { type: 'command', id, command };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(msg));
    });
  }

  /** v2.4 §10.1 the localhost token of the current URL: the `/attach*` Bearer header (none on the remote channel). */
  token(): string | null { try { return new URL(this.o.url).searchParams.get('token'); } catch { return null; } }

  /** A new engine start has a new token (§7.1): the next connect uses this URL. */
  setUrl(url: string): void { this.o = { ...this.o, url }; }

  /** F10 "Thử lại ngay": skip the remaining backoff. */
  retryNow(): void {
    if (this.ws || this.disposed) return;
    this.t.clearTimeout(this.timer);
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.t.clearTimeout(this.timer);
    this.ws?.close();
  }
}
