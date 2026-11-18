import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '../../shared/protocol.ts';
import { Store, targetKey } from '../src/lib/store.ts';
import { card, lane, snapshot } from './fixtures.ts';

const orch = { kind: 'orchestrator', projectId: 'p1' } as const;
const d2 = { kind: 'lane', projectId: 'p1', name: 'D2' } as const;

describe('§7.9 store applies snapshot then event diffs', () => {
  test('snapshot replaces state and records data time', () => {
    const s = new Store(() => 1000);
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    expect(s.get().snap?.lanes.map(l => l.name)).toEqual(['D2', 'D15']);
    expect(s.get().dataAt).toBe(1000);
  });

  test('lane event upserts by projectId+name; lane_removed deletes', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply({ type: 'event', event: { type: 'lane', lane: lane('D2', { state: 'waiting_po' }) } });
    s.apply({ type: 'event', event: { type: 'lane', lane: lane('D9') } });
    expect(s.get().snap!.lanes.map(l => `${l.name}:${l.state}`)).toEqual(['D2:waiting_po', 'D15:running', 'D9:running']);
    s.apply({ type: 'event', event: { type: 'lane_removed', projectId: 'p1', name: 'D15' } });
    expect(s.get().snap!.lanes.map(l => l.name)).toEqual(['D2', 'D9']);
  });

  test('v2 §6 A3–A8 account_login replaces the login; account_removed drops the row', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    const l = { id: 'l1', mode: 'add', email: null, state: 'waiting_browser', url: 'https://x', deadline: 1, error: null, realEmail: null } as const;
    s.apply({ type: 'event', event: { type: 'account_login', login: l } });
    expect(s.get().snap!.login).toEqual(l);
    s.apply({ type: 'event', event: { type: 'account_removed', email: 'pm@x' } });
    expect(s.get().snap!.accounts.map(a => a.email)).toEqual(['a@x']);
  });

  test('v2.7.1 §7.3 the live quota event replaces Snapshot.quota (429 band + queue end follow it)', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply({ type: 'event', event: { type: 'quota', quota: { cooldownUntil: 5000, queueEndsAt: 9000 } } });
    expect(s.get().snap!.quota).toEqual({ cooldownUntil: 5000, queueEndsAt: 9000 });
    s.apply({ type: 'event', event: { type: 'quota', quota: { cooldownUntil: null, queueEndsAt: null } } });
    expect(s.get().snap!.quota).toEqual({ cooldownUntil: null, queueEndsAt: null });
  });

  test('v2.2 §6 skills_mcp replaces the Skills & MCP view (K0 numbers follow it)', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    const view = { counts: { total: { red: 2, yellow: 5 } } } as never;
    s.apply({ type: 'event', event: { type: 'skills_mcp', view } });
    expect(s.get().snap!.skillsMcp).toBe(view);
  });

  test('v2.5 §5.8 toolkit replaces the Bộ công cụ view (Mac only event)', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    const view = { rows: [], checkedAt: 1 };
    s.apply({ type: 'event', event: { type: 'toolkit', view } });
    expect(s.get().snap!.toolkit).toBe(view);
  });

  test('v2.5 §5.8 graph replaces the Graph code view (Mac only event)', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    const view = { tool: { state: 'ready' as const, version: '0.12.1' }, projects: [] };
    s.apply({ type: 'event', event: { type: 'graph', view } });
    expect(s.get().snap!.graph).toBe(view);
  });

  test('v2.9 §10.1 workflows_changed replaces the library rows (the Tasks chip reads them)', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    const rows = [{ id: 'builtin:po' }] as never;
    s.apply({ type: 'event', event: { type: 'workflows_changed', rows } });
    expect(s.get().snap!.workflows).toBe(rows);
  });

  test('v2.9 §4.10 workflow_draft adds / replaces a draft by id; workflow_draft_gone drops it', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    const d1 = { id: 'd1', state: 'running' } as never, d1b = { id: 'd1', state: 'idle' } as never, d2 = { id: 'd2', state: 'idle' } as never;
    s.apply({ type: 'event', event: { type: 'workflow_draft', draft: d1 } });
    s.apply({ type: 'event', event: { type: 'workflow_draft', draft: d2 } });
    s.apply({ type: 'event', event: { type: 'workflow_draft', draft: d1b } });
    expect(s.get().snap!.drafts).toEqual([d1b, d2]);
    s.apply({ type: 'event', event: { type: 'workflow_draft_gone', draftId: 'd1' } });
    expect(s.get().snap!.drafts).toEqual([d2]);
  });

  test('v2.3 §10.2 code_changed reaches the Code view as a numbered event (each one counts, even the same twice)', () => {
    const s = new Store();
    expect(s.get().codeEv).toBeNull();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    const e: Extract<EngineEvent, { type: 'code_changed' }> = { type: 'code_changed', projectId: 'p1', src: { kind: 'lane', laneId: 'D15' }, paths: ['a.ts'] };
    s.apply({ type: 'event', event: e });
    expect(s.get().codeEv).toEqual({ e, n: 1 });
    s.apply({ type: 'event', event: e });
    expect(s.get().codeEv?.n).toBe(2);
  });

  test('card, account, orchestrator, project, engine events upsert', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply({ type: 'event', event: { type: 'card', card: card(7) } });
    s.apply({ type: 'event', event: { type: 'card', card: card(7, { status: 'answered' }) } });
    expect(s.get().snap!.cards).toHaveLength(1);
    expect(s.get().snap!.cards[0]!.status).toBe('answered');
    const a = { ...s.get().snap!.accounts[1]!, headroomPct: 2 };
    s.apply({ type: 'event', event: { type: 'account', account: a } });
    expect(s.get().snap!.accounts[1]!.headroomPct).toBe(2);
    s.apply({ type: 'event', event: { type: 'orchestrator', orchestrator: { ...s.get().snap!.orchestrators[0]!, state: 'stopped' } } });
    expect(s.get().snap!.orchestrators[0]!.state).toBe('stopped');
    s.apply({ type: 'event', event: { type: 'project_removed', id: 'p1' } });
    expect(s.get().snap!.projects).toHaveLength(0);
    s.apply({ type: 'event', event: { type: 'engine', engine: { ...s.get().snap!.engine, costTodayUsd: 3 } } });
    expect(s.get().snap!.engine.costTodayUsd).toBe(3);
  });

  test('hf1116 A-M4 project_removed also drops that project\'s lanes, orchestrator sessions and cards', () => {
    const s = new Store();
    const base = snapshot();
    const p2 = { ...base.projects[0]!, id: 'p2', name: 'Other' };
    s.apply({ type: 'snapshot', snapshot: { ...base, projects: [...base.projects, p2], lanes: [...base.lanes, lane('X1', { projectId: 'p2' })],
      orchestrators: [...base.orchestrators, { ...base.orchestrators[0]!, projectId: 'p2', sessionId: 'so-p2' }], cards: [...base.cards, card(99, { projectId: 'p2' })] } });
    expect(s.get().snap!.lanes.some(l => l.projectId === 'p1')).toBe(true);
    s.apply({ type: 'event', event: { type: 'project_removed', id: 'p1' } });
    const v = s.get().snap!;
    expect(v.projects.map(p => p.id)).toEqual(['p2']);
    expect(v.lanes.map(l => l.projectId)).toEqual(['p2']);
    expect(v.orchestrators.map(o => o.projectId)).toEqual(['p2']);
    expect(v.cards.map(c => c.projectId)).toEqual(['p2']);
  });

  test('events before the first snapshot are ignored (no crash)', () => {
    const s = new Store();
    s.apply({ type: 'event', event: { type: 'lane', lane: lane('D2') } });
    expect(s.get().snap).toBeNull();
  });

  test('subscribers fire on change and state identity changes (useSyncExternalStore)', () => {
    const s = new Store();
    let n = 0;
    const off = s.subscribe(() => n++);
    const before = s.get();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    expect(n).toBe(1);
    expect(s.get()).not.toBe(before);
    off();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    expect(n).toBe(1);
  });

  test('stream event appends to the target buffer; assistant line clears partial', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply({ type: 'event', event: { type: 'partial', target: orch, key: 'm:0', parent: null, delta: 'Đa' } });
    s.apply({ type: 'event', event: { type: 'partial', target: orch, key: 'm:0', parent: null, delta: 'ng ' } });
    expect(s.get().partials[targetKey(orch)]!['m:0']!.text).toBe('Đang '); // v2.2 §14.4 delta appends
    s.apply({ type: 'event', event: { type: 'partial', target: orch, key: 'm:0', parent: null, full: 'Đang c' } });
    expect(s.get().partials[targetKey(orch)]!['m:0']!.text).toBe('Đang c'); // full (mid-stream watch) replaces
    s.apply({ type: 'event', event: { type: 'stream', target: orch, lines: [{ seq: 1, ts: 1, kind: 'assistant', text: 'Đang chạy' }] } });
    expect(s.get().streams[targetKey(orch)]!.lines.map(l => l.seq)).toEqual([1]);
    expect(s.get().partials[targetKey(orch)]).toEqual({});
    s.apply({ type: 'event', event: { type: 'stream', target: d2, lines: [{ seq: 1, ts: 1, kind: 'po', text: 'x' }] } });
    expect(Object.keys(s.get().streams).sort()).toEqual(['l:p1:D2', 'o:p1']);
  });

  test('toast event queues a toast; dismiss removes it', () => {
    const s = new Store();
    s.apply({ type: 'event', event: { type: 'toast', level: 'info', text: 'D2: chuyển account' } });
    const t = s.get().toasts[0]!;
    expect(t.text).toBe('D2: chuyển account');
    s.dismissToast(t.id);
    expect(s.get().toasts).toHaveLength(0);
  });

  test('§6.10 U11 connection status keeps last data time while offline', () => {
    let now = 1000;
    const s = new Store(() => now);
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    now = 5000;
    s.setConn({ status: 'reconnecting', attempt: 2, since: 4000 });
    expect(s.get().conn).toEqual({ status: 'reconnecting', attempt: 2, since: 4000 });
    expect(s.get().dataAt).toBe(1000);
  });
});

describe('§6.3 I6 switching back to a target loads what it said meanwhile', () => {
  test('watch O (1–3) → D2 while O emits 4–6 (not delivered) → back to O: resync page, then live 7 → 1..7', () => {
    const s = new Store(() => 1);
    const l = (seq: number) => ({ seq, ts: seq, kind: 'assistant' as const, text: `o${seq}` });
    s.apply({ type: 'event', event: { type: 'stream', target: orch, lines: [l(1), l(2), l(3)] } });
    // (looking at D2: O's lines 4–6 go to nobody) — back on O, App asks for the newest page every time
    s.resync(orch, [1, 2, 3, 4, 5, 6].map(l), 200);
    s.apply({ type: 'event', event: { type: 'stream', target: orch, lines: [l(7)] } });
    expect(s.get().streams[targetKey(orch)]!.lines.map(x => x.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('v2.1 §4.14 parallel sessions in the store (T10)', () => {
  const o = (sessionId: string, seq: number) => ({ projectId: 'p1', state: 'running' as const, account: 'a@x', homeAccount: 'a@x', lastError: null, costUsd: 0,
    contextPct: 1, talkingTo: null, sessionId, seq });
  test('§4.14 an orchestrator event upserts by session id (a second session is a second root); session_ended drops it', () => {
    const s = new Store(() => 1);
    s.apply({ type: 'snapshot', snapshot: snapshot({ orchestrators: [o('s1', 1)] }) });
    s.apply({ type: 'event', event: { type: 'orchestrator', orchestrator: o('s2', 2) } });
    s.apply({ type: 'event', event: { type: 'orchestrator', orchestrator: { ...o('s1', 1), state: 'stopped' } } });
    expect(s.get().snap!.orchestrators.map(x => `${x.sessionId}:${x.state}`)).toEqual(['s1:stopped', 's2:running']);
    s.apply({ type: 'event', event: { type: 'session_ended', projectId: 'p1', sessionId: 's1' } });
    expect(s.get().snap!.orchestrators.map(x => x.sessionId)).toEqual(['s2']);
  });
  test('§4.14 each session keeps its own stream (the watch target carries sessionId)', () => {
    expect(targetKey({ kind: 'orchestrator', projectId: 'p1', sessionId: 's1' })).not.toBe(targetKey({ kind: 'orchestrator', projectId: 'p1', sessionId: 's2' }));
    expect(targetKey({ kind: 'orchestrator', projectId: 'p1' })).toBe('o:p1');
  });
});

describe('v2.3 §10.2 M3 window hidden reaches the Git view', () => {
  test('§10.2 setTabHidden is state (App passes it to the Git host): hidden → true, shown → false, starts false', () => {
    const s = new Store();
    expect(s.get().tabHidden).toBe(false);
    s.setTabHidden(true);
    expect(s.get().tabHidden).toBe(true);
    s.setTabHidden(false);
    expect(s.get().tabHidden).toBe(false);
  });
});
