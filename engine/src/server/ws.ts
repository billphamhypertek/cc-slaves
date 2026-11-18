// WS hub (spec §7.9, M16, R10): every connection gets `snapshot` once, then `event` diffs. `stream` and `partial` (+ v2.2 `partial_end` / `thinking`) go
// only to connections watching that target; `subagents` too for remote ones, while a local (mac) connection gets them
// for every lane of the project it watches (v2.1 W9). Commands go through the router with the connection's
// channel (fixed by the server, §7.2 N2).
import type { Channel, EngineEvent, ServerMsg, Snapshot, Target } from '../../../shared/protocol.ts';
import { remoteCard } from '../../../shared/issues.ts';
import { route, type Handlers } from './router.ts';

export interface Conn {
  readonly channel: Channel; watch: Target | null;
  /** R10/§8.1 (I5): the app window is visible. False until the web says so (`presence`); one-shot clients never do. */
  present: boolean;
  /** v2.3 §10.2 the project whose Git tab this connection shows (`git_watch`); null / absent = none. */
  gitWatch?: string | null;
  send(m: ServerMsg): void;
}

/** v2.1 §4.14 an orchestrator target with a `sessionId` on both sides must name the same session; one without = any. */
export const sameTarget = (a: Target | null, b: Target): boolean => {
  if (a === null || a.kind !== b.kind || a.projectId !== b.projectId) return false;
  if (a.kind === 'lane') return a.name === (b as { name: string }).name;
  const bs = (b as { sessionId?: string }).sessionId;
  return a.sessionId === undefined || bs === undefined || a.sessionId === bs;
};

const WATCHED_ONLY: ReadonlySet<EngineEvent['type']> = new Set(['stream', 'partial', 'partial_end', 'thinking', 'subagents', 'po_written']);
/** v2.2 §6 the Skills & MCP view holds source entries (env / header secrets) and setup only: Mac connections only (D32).
 *  v2.3 §8 Code / Git are Mac only: `code_changed` (file paths) never reaches a remote connection. */
const MAC_ONLY: ReadonlySet<EngineEvent['type']> = new Set(['skills_mcp', 'code_changed', 'issue_changed', 'spec_changed', 'workflows_changed', 'workflow_draft', 'workflow_draft_gone', 'toolkit', 'graph', 'update_ready']); // + v2.7 §8 Tasks, v2.9 N6, v2.5 §5.8 / N7, v2.6 §5.4-5 (holder only)

/** v2.1 W9: does connection `c` get this target-gated event? */
export function delivers(c: Pick<Conn, 'channel' | 'watch'>, type: EngineEvent['type'], target: Target): boolean {
  if (type === 'subagents' && c.channel === 'mac') return c.watch !== null && c.watch.projectId === target.projectId;
  return sameTarget(c.watch, target);
}

export interface HubDeps {
  snapshot: (channel: Channel) => Snapshot;
  /** Command handlers for one connection (`watch` sets that connection's target). */
  handlers: (c: Conn) => Handlers;
  /** Number of present (visible) Mac connections changed (QuotaTracker UI-open polling, §8.1). */
  onPresentMac?: (n: number) => void;
  /** v2.6 §5.4-6 a connection closed (the update hold of that connection is released). */
  onClose?: (c: Conn) => void;
}

export class WsHub {
  private readonly conns = new Set<Conn>();

  constructor(private readonly d: HubDeps) {}

  open(c: Conn): void {
    this.conns.add(c);
    c.send({ type: 'snapshot', snapshot: this.d.snapshot(c.channel) });
    this.d.onPresentMac?.(this.presentMac);
  }

  close(c: Conn): void {
    this.conns.delete(c);
    this.d.onPresentMac?.(this.presentMac);
    this.d.onClose?.(c);
  }

  /** `presence` command: the window was shown / hidden (I5). */
  setPresent(c: Conn, visible: boolean): void {
    c.present = visible;
    this.d.onPresentMac?.(this.presentMac);
  }

  async message(c: Conn, raw: string): Promise<void> {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { c.send({ type: 'error', id: '', code: 'bad_message', message: 'Tin không phải JSON' }); return; }
    c.send(await route(this.d.handlers(c), { channel: c.channel }, msg));
  }

  broadcast(e: EngineEvent): void {
    const gated = WATCHED_ONLY.has(e.type);
    const target = gated ? (e as { target: Target }).target : null;
    for (const c of this.conns) {
      if (target !== null && !delivers(c, e.type, target)) continue;
      if (c.channel !== 'mac' && MAC_ONLY.has(e.type)) continue;
      const ev = e.type === 'card' && c.channel !== 'mac' ? { ...e, card: remoteCard(e.card) } : e; // v2.7 §8 buttons on the Mac only
      try { c.send({ type: 'event', event: ev }); } catch { /* a dead socket is removed on close */ }
    }
  }

  /** R10: a visible Mac connection is looking at this target. */
  viewing(t: Target): boolean {
    for (const c of this.conns) if (c.channel === 'mac' && c.present && sameTarget(c.watch, t)) return true;
    return false;
  }

  /** v2.3 §10.2 a visible Mac connection shows the Git tab of this project (else the engine runs no `git_log`). */
  gitVisible(projectId: string): boolean {
    for (const c of this.conns) if (c.channel === 'mac' && c.present && c.gitWatch === projectId) return true;
    return false;
  }

  /** Every open connection (mac + remote). */
  get size(): number { return this.conns.size; }
  get macCount(): number { let n = 0; for (const c of this.conns) if (c.channel === 'mac') n++; return n; }
  get presentMac(): number { let n = 0; for (const c of this.conns) if (c.channel === 'mac' && c.present) n++; return n; }

  /** Is anyone watching this target (skip building partials nobody sees). */
  watched(t: Target): boolean { for (const c of this.conns) if (sameTarget(c.watch, t)) return true; return false; }
}
