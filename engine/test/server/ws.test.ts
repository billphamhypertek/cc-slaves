// R10 (§8.3) + §8.1: "the PO is looking" needs a visible app window, not just an open socket (I5).
import { describe, expect, test } from 'bun:test';
import type { Snapshot, Target } from '../../../shared/protocol.ts';
import type { Handlers } from '../../src/server/router.ts';
import { WsHub, type Conn } from '../../src/server/ws.ts';

const O: Target = { kind: 'orchestrator', projectId: 'p' };
function world() {
  const counts: number[] = [];
  const hub = new WsHub({ snapshot: () => ({}) as Snapshot, handlers: () => ({}) as Handlers, onPresentMac: (n) => counts.push(n) });
  const conn: Conn = { channel: 'mac', watch: O, present: false, send: () => {} };
  hub.open(conn);
  return { hub, conn, counts };
}

describe('§8.3 R10 I5 presence', () => {
  test('a new connection is not present until it says so (one-shot Rust clients never count)', () => {
    const w = world();
    expect(w.hub.viewing(O)).toBe(false);
    expect(w.counts).toEqual([0]);
    expect(w.hub.macCount).toBe(1); // still "app connected": the web shows notifications itself
  });
  test('visible → viewing its target and UI-open polling; hidden window → neither', () => {
    const w = world();
    w.hub.setPresent(w.conn, true);
    expect(w.hub.viewing(O)).toBe(true);
    w.hub.setPresent(w.conn, false);
    expect(w.hub.viewing(O)).toBe(false);
    expect(w.counts).toEqual([0, 1, 0]);
  });
  test('closing a present connection drops the count', () => {
    const w = world();
    w.hub.setPresent(w.conn, true);
    w.hub.close(w.conn);
    expect(w.counts.at(-1)).toBe(0);
  });
  test('a remote connection never counts as viewing on the Mac', () => {
    const w = world();
    const r: Conn = { channel: 'remote', watch: O, present: true, send: () => {} };
    w.hub.open(r);
    expect(w.hub.viewing(O)).toBe(false);
  });
});

describe('§5.3 W9 subagent delivery', () => {
  const D2: Target = { kind: 'lane', projectId: 'p', name: 'D2' };
  const D3: Target = { kind: 'lane', projectId: 'p', name: 'D3' };
  const Q1: Target = { kind: 'lane', projectId: 'q', name: 'Q1' };
  function hubWith(channel: 'mac' | 'remote', watch: Target | null) {
    const hub = new WsHub({ snapshot: () => ({}) as Snapshot, handlers: () => ({}) as Handlers });
    const got: string[] = [];
    const conn: Conn = { channel, watch, present: true, send: (m) => { if (m.type === 'event' && m.event.type !== 'toast') got.push(`${m.event.type}:${(m.event as { target: { name?: string } }).target.name ?? 'O'}`); } };
    hub.open(conn);
    return { hub, got };
  }
  const subs = (target: Target) => ({ type: 'subagents' as const, target, subagents: [] });

  test('§5.3 W9 a local connection gets subagents of every lane of the project it watches, not other projects', () => {
    const w = hubWith('mac', O); // watching the orchestrator of p = project p selected
    w.hub.broadcast(subs(D2)); w.hub.broadcast(subs(D3)); w.hub.broadcast(subs(Q1));
    expect(w.got).toEqual(['subagents:D2', 'subagents:D3']);
  });

  test('§5.3 W9 a remote connection keeps the watched-only rule', () => {
    const w = hubWith('remote', D2);
    w.hub.broadcast(subs(D2)); w.hub.broadcast(subs(D3)); w.hub.broadcast(subs(Q1));
    expect(w.got).toEqual(['subagents:D2']);
  });

  test('§6 D32 the skills_mcp view (source entries, secrets) goes to Mac connections only', () => {
    const view = { type: 'skills_mcp' as const, view: {} as never };
    const mac = hubWith('mac', null);
    const remote = hubWith('remote', null);
    const seen: string[] = [];
    for (const [name, w] of [['mac', mac], ['remote', remote]] as const) {
      w.hub.open({ channel: name, watch: null, present: true, send: (m) => { if (m.type === 'event') seen.push(`${name}:${m.event.type}`); } });
      w.hub.broadcast(view);
    }
    expect(seen).toEqual(['mac:skills_mcp']);
  });

  test('v2.7 §8 issue_changed / spec_changed (the Tasks tab) go to Mac connections only', () => {
    const seen: string[] = [];
    for (const name of ['mac', 'remote'] as const) {
      const w = hubWith(name, null);
      w.hub.open({ channel: name, watch: null, present: true, send: (m) => { if (m.type === 'event') seen.push(`${name}:${m.event.type}`); } });
      w.hub.broadcast({ type: 'issue_changed', issue: {} as never });
      w.hub.broadcast({ type: 'spec_changed', spec: {} as never });
    }
    expect(seen).toEqual(['mac:issue_changed', 'mac:spec_changed']);
  });

  test('v2.9 §10.1 / N6 workflows_changed goes to Mac connections only', () => {
    const seen: string[] = [];
    for (const name of ['mac', 'remote'] as const) {
      const w = hubWith(name, null);
      w.hub.open({ channel: name, watch: null, present: true, send: (m) => { if (m.type === 'event') seen.push(`${name}:${m.event.type}`); } });
      w.hub.broadcast({ type: 'workflows_changed', rows: [] });
    }
    expect(seen).toEqual(['mac:workflows_changed']);
  });

  test('v2.5 §5.8 the toolkit view goes to Mac connections only', () => {
    const seen: string[] = [];
    for (const name of ['mac', 'remote'] as const) {
      const w = hubWith(name, null);
      w.hub.open({ channel: name, watch: null, present: true, send: (m) => { if (m.type === 'event') seen.push(`${name}:${m.event.type}`); } });
      w.hub.broadcast({ type: 'toolkit', view: { rows: [] } });
    }
    expect(seen).toEqual(['mac:toolkit']);
  });

  test('v2.9 §5.9 the author draft events (its chat, its files) go to Mac connections only', () => {
    const seen: string[] = [];
    for (const name of ['mac', 'remote'] as const) {
      const w = hubWith(name, null);
      w.hub.open({ channel: name, watch: null, present: true, send: (m) => { if (m.type === 'event') seen.push(`${name}:${m.event.type}`); } });
      w.hub.broadcast({ type: 'workflow_draft', draft: {} as never });
      w.hub.broadcast({ type: 'workflow_draft_gone', draftId: 'd' });
    }
    expect(seen).toEqual(['mac:workflow_draft', 'mac:workflow_draft_gone']);
  });

  test('v2.7 §8 a revert_conflict / issues_new / superpowers_off card reaches remote without its buttons; Mac keeps them; other cards as sent', () => {
    const got: Record<string, unknown[]> = { mac: [], remote: [] };
    const card = (kind: string) => ({ id: 1, kind, title: 't', actions: [{ id: 'revert_keep', label: 'Giữ T-1' }] }) as never;
    for (const name of ['mac', 'remote'] as const) {
      const w = hubWith(name, null);
      w.hub.open({ channel: name, watch: null, present: true, send: (m) => { if (m.type === 'event' && m.event.type === 'card') got[name]!.push(m.event.card.actions); } });
      for (const k of ['revert_conflict', 'issues_new', 'superpowers_off', 'broken']) w.hub.broadcast({ type: 'card', card: card(k) });
    }
    const btn = [{ id: 'revert_keep', label: 'Giữ T-1' }];
    expect(got.mac).toEqual([btn, btn, btn, btn]);
    expect(got.remote).toEqual([[], [], [], btn]);
  });

  test('§5.3 W9 / v2.2 §14.4 stream / partial / partial_end / thinking stay watched-only for local connections too; no watch → no subagents', () => {
    const w = hubWith('mac', D2);
    w.hub.broadcast({ type: 'partial', target: D3, key: 'm:0', parent: null, delta: 'x' });
    w.hub.broadcast({ type: 'partial_end', target: D3, key: 'm:0' });
    w.hub.broadcast({ type: 'thinking', target: D3, parent: null, on: true });
    w.hub.broadcast({ type: 'stream', target: D3, lines: [] });
    expect(w.got).toEqual([]);
    const n = hubWith('mac', null);
    n.hub.broadcast(subs(D2));
    expect(n.got).toEqual([]);
  });
});

describe('v2.6 §5.4-6 close', () => {
  test('closing a connection tells the engine which one closed (the update hold is released by its own socket)', () => {
    const closed: Conn[] = [];
    const hub = new WsHub({ snapshot: () => ({}) as Snapshot, handlers: () => ({}) as Handlers, onClose: (c) => closed.push(c) });
    const a: Conn = { channel: 'mac', watch: null, present: false, send: () => {} };
    const b: Conn = { channel: 'mac', watch: null, present: false, send: () => {} };
    hub.open(a); hub.open(b);
    hub.close(b);
    expect(closed).toEqual([b]);
    expect(hub.size).toBe(1);
  });
  test('po_written is watched-only: it reaches the connection watching that target, not the others', () => {
    const got: string[] = [];
    const hub = new WsHub({ snapshot: () => ({}) as Snapshot, handlers: () => ({}) as Handlers });
    const mk = (name: string, watch: Target | null): Conn => ({ channel: 'mac', watch, present: true, send: (m) => { if (m.type === 'event') got.push(name); } });
    hub.open(mk('watcher', O)); hub.open(mk('other', { kind: 'lane', projectId: 'p', name: 'x' }));
    hub.broadcast({ type: 'po_written', target: O, seqs: [3] });
    expect(got).toEqual(['watcher']);
  });
  test('update_ready (backup path) never reaches a remote connection', () => {
    const got: string[] = [];
    const hub = new WsHub({ snapshot: () => ({}) as Snapshot, handlers: () => ({}) as Handlers });
    for (const ch of ['mac', 'remote'] as const) hub.open({ channel: ch, watch: null, present: true, send: (m) => { if (m.type === 'event') got.push(ch); } });
    hub.broadcast({ type: 'update_ready', backup: '/tmp/b.db' });
    expect(got).toEqual(['mac']);
  });
});
