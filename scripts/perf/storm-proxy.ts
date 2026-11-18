// Perf audit: a WS proxy between Vite and the dev mock engine that adds a synthetic event storm (lane state changes,
// account quota events, stream lines and partial deltas on the watched target) without touching web/dev/mock-engine.ts.
// Run: MOCK_PORT=4871 bun web/dev/mock-engine.ts & PROXY_PORT=4872 UPSTREAM=ws://127.0.0.1:4871 bun scripts/perf/storm-proxy.ts
// Page URL query `storm=<lines per s>` (0 = pass-through); every injected stream line carries `⏱<epoch ms>` for latency.
import type { ServerWebSocket } from 'bun';
import type { AccountView, LaneView, ServerMsg, Snapshot, Target } from '../../shared/protocol.ts';

interface Conn { up: WebSocket | null; qs: string; rate: number; snap: Snapshot | null; watch: Target | null; timers: Timer[]; seq: number; queue: string[] }
const port = Number(process.env.PROXY_PORT ?? 4872), upstream = process.env.UPSTREAM ?? 'ws://127.0.0.1:4871';
const STATES: LaneView['state'][] = ['running', 'running', 'idle', 'running', 'waiting_quota', 'running'];

function startStorm(ws: ServerWebSocket<Conn>) {
  const c = ws.data, send = (m: ServerMsg) => ws.send(JSON.stringify(m));
  let tick = 0, text = '';
  // stream lines + partials on the watched target: `rate` lines/s, a partial every 50 ms
  c.timers.push(setInterval(() => {
    if (!c.watch) return;
    text = text.length > 600 ? '' : text + 'chữ đang chạy '.repeat(2);
    send({ type: 'event', event: { type: 'partial', target: c.watch, key: 'storm', parent: null, full: text } });
  }, 50));
  c.timers.push(setInterval(() => {
    if (!c.watch) return;
    c.seq += 1;
    send({ type: 'event', event: { type: 'stream', target: c.watch, lines: [{ seq: 1_000_000 + c.seq, ts: Date.now(), kind: 'tool', text: `⏱${Date.now()} Bash: bun test engine/test/x${c.seq}.test.ts — 12 pass` } as never] } });
  }, Math.max(10, 1000 / c.rate)));
  // a lane state change every 250 ms (process.ts:128 emits one per assistant line with tokens), every account every 10 s
  c.timers.push(setInterval(() => {
    const s = c.snap; if (!s?.lanes.length) return;
    const l = s.lanes[tick++ % s.lanes.length]!;
    const lane: LaneView = { ...l, state: l.state === 'done' ? 'done' : STATES[tick % STATES.length]!, costUsd: l.costUsd + 0.01, contextPct: ((l.contextPct ?? 0) + 1) % 100, updatedAt: Date.now() };
    Object.assign(l, lane);
    send({ type: 'event', event: { type: 'lane', lane } });
  }, 250));
  c.timers.push(setInterval(() => {
    for (const a of c.snap?.accounts ?? []) {
      const account: AccountView = { ...a, fivePct: ((a.fivePct ?? 0) + 1) % 100, fetchedAt: Date.now() };
      Object.assign(a, account);
      send({ type: 'event', event: { type: 'account', account } });
    }
  }, 10_000)); // the engine re-sends every account view after a quota refresh (engine/accounts.ts:120)
}

Bun.serve<Conn, never>({
  port,
  fetch(req, server) {
    const u = new URL(req.url);
    const rate = Number(u.searchParams.get('storm') ?? 0);
    u.searchParams.delete('storm');
    return server.upgrade(req, { data: { up: null, qs: u.search, rate, snap: null, watch: null, timers: [], seq: 0, queue: [] } }) ? undefined : new Response('no', { status: 400 });
  },
  websocket: {
    open(ws) {
      const up = new WebSocket(`${upstream}/ws${ws.data.qs}`);
      ws.data.up = up;
      up.onopen = () => { for (const m of ws.data.queue) up.send(m); ws.data.queue = []; };
      up.onmessage = e => {
        const raw = String(e.data);
        if (ws.data.rate > 0 && raw.startsWith('{"type":"snapshot"')) { ws.data.snap = (JSON.parse(raw) as { snapshot: Snapshot }).snapshot; startStorm(ws); }
        ws.send(raw);
      };
      up.onclose = () => ws.close();
    },
    message(ws, raw) {
      const s = String(raw);
      try { const m = JSON.parse(s) as { type: string; command?: { cmd: string; target?: Target } }; if (m.command?.cmd === 'watch') ws.data.watch = m.command.target ?? null; } catch { /* pass through */ }
      if (ws.data.up?.readyState === WebSocket.OPEN) ws.data.up.send(s); else ws.data.queue.push(s);
    },
    close(ws) { ws.data.timers.forEach(clearInterval); ws.data.up?.close(); },
  },
});
console.log(`storm proxy ws://127.0.0.1:${port} → ${upstream}`);
