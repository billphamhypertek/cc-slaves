import { describe, expect, test } from 'bun:test';
import type { Account } from '../../src/accounts/registry.ts';
import type { Card } from '../../src/cards/store.ts';
import type { Caps } from '../../src/config.ts';
import type { Lane, QuotaRow } from '../../src/db.ts';
import { boundaryLine } from '../../src/server/session-views.ts';
import { accountView, cardView, laneView, orchestratorView, projectView } from '../../src/server/views.ts';

const NOW = 1_000_000;
const acct: Account = { email: 'a@x', id: null, configDir: '/c/a', keychainService: 'k', planTier: 'max', terminal: false };
const caps = { default: { week: 98, five: 95 }, 'a@x': { role: 'primary', week: 90, hard: true } } as Caps;
const q = (o: Partial<QuotaRow> = {}): QuotaRow =>
  ({ account: 'a@x', fivePct: 40, weekPct: 50, fiveResetsAt: NOW + 100, weekResetsAt: NOW + 1000, source: 'api', fetchedAt: NOW - 60, status: 'ok', ...o });

describe('snapshot view builders (§7.9)', () => {
  test('projectView maps db row, never leaks the webhook URL', () => {
    const v = projectView({ id: 'p', name: 'Shop', path: '/w/shop', orchestrator_account: 'o@x', gchat_webhook: 'https://secret', gchat_send_command_text: 1 });
    expect(v).toEqual({ id: 'p', name: 'Shop', path: '/w/shop', orchestratorAccount: 'o@x', gchatWebhookSet: true, gchatSendCommandText: true });
    expect(JSON.stringify(v)).not.toContain('secret');
    expect('permissionMode' in v).toBe(false); // §7 D18: no per-project permission mode
  });

  test('accountView: hard cap headroom = leave-at − week%, fresh, role', () => {
    const v = accountView({ account: acct, caps, quota: q(), lanes: 2, now: NOW, loggedOut: false });
    expect(v).toMatchObject({ email: 'a@x', plan: 'max', role: 'primary', week: 90, five: 95, hard: true, lanes: 2, weekPct: 50, fivePct: 40, fresh: true, status: 'ok', full: false });
    expect(v.headroomPct).toBe(39); // hard: leave at 89
  });
  test('v2 §7 AccountView carries the account id and login: ok / out (F16, incl. no Keychain item)', () => {
    expect(accountView({ account: { ...acct, id: 'abcabcabcabc' }, caps, quota: q(), lanes: 0, now: NOW, loggedOut: false })).toMatchObject({ id: 'abcabcabcabc', login: 'ok' });
    expect(accountView({ account: acct, caps, quota: q(), lanes: 0, now: NOW, loggedOut: true }).login).toBe('out');
  });
  test('v2 §5.5 A9 AccountView carries sharedCfg {ok, issues} (default ok); v2.2 §5.1 no MCP field on an account', () => {
    const v = accountView({ account: acct, caps, quota: q(), lanes: 0, now: NOW, loggedOut: false });
    expect(v).toMatchObject({ sharedCfg: { ok: true, issues: [] } });
    expect(Object.keys(v).filter((k) => /mcp/i.test(k) || k === 'dir')).toEqual([]);
    const issues = [{ kind: 'real-entry' as const, name: 'plans', path: '/a/plans' }];
    expect(accountView({ account: acct, caps, quota: q(), lanes: 0, now: NOW, loggedOut: false, sharedCfg: { ok: false, issues } }))
      .toMatchObject({ sharedCfg: { ok: false, issues } });
  });
  test('§6 A2 §3.1-4 accountView login: Keychain/signed-out → out; else the `auth status` result; checking → unknown', () => {
    const login = (loggedOut: boolean, auth?: 'ok' | 'out' | 'unknown' | 'checking' | null) =>
      accountView({ account: acct, caps, quota: q(), lanes: 0, now: NOW, loggedOut, ...(auth === undefined ? {} : { auth }) }).login;
    expect(login(true, 'ok')).toBe('out'); // keychain missing / logged out wins over a stale ok
    expect(login(false, 'out')).toBe('out'); // exit ≠ 0
    expect(login(false, 'unknown')).toBe('unknown'); // timeout / spawn error
    expect(login(false, 'checking')).toBe('unknown'); // first check still running
    expect(login(false, 'ok')).toBe('ok');
    expect(login(false, null)).toBe('ok'); // no check can run (no claude path)
    expect(login(false)).toBe('ok');
  });

  test('accountView: full when week ≥ leave-at or rejected; unknown without a row', () => {
    expect(accountView({ account: acct, caps, quota: q({ weekPct: 89 }), lanes: 0, now: NOW, loggedOut: false }).full).toBe(true);
    expect(accountView({ account: acct, caps, quota: q({ status: 'rejected' }), lanes: 0, now: NOW, loggedOut: false }).full).toBe(true);
    const none = accountView({ account: acct, caps, quota: null, lanes: 0, now: NOW, loggedOut: true });
    expect(none).toMatchObject({ status: 'unknown', fresh: false, headroomPct: null, weekPct: null, full: false, loggedOut: true });
  });

  const lane: Lane = { id: 1, projectId: 'p', name: 'D2', sessionId: 's', cwd: '/w/d2', briefPath: null, agent: 'coder', model: 'opus', effort: 'medium', phase: 'code', task: 'T3', note: null, state: 'stopped', failCount: 1, lastError: 'x', costUsd: 1.5, createdAt: 1 };
  test('laneView: db row when no runtime; runtime state / account / cards win when present', () => {
    const dbOnly = laneView(lane, null, { worktreeExists: true, switches: 0, updatedAt: 5 });
    expect(dbOnly).toMatchObject({ projectId: 'p', name: 'D2', state: 'stopped', phase: 'code', task: 'T3', account: null, costUsd: 1.5, openCards: [], agent: 'coder', worktreeExists: true, updatedAt: 5 });
    const rt = { projectId: 'p', name: 'D2', laneId: 1, sessionId: 's', cwd: '/w/d2', state: 'waiting_po' as const, account: 'a@x', phase: 'review', failCount: 0, lastError: null, openCards: [7], switchPending: false, sawAssistant: true, costUsd: 2, alive: true, turnStartedAt: 1234, contextPct: 42, waitReason: null, tokens: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } };
    expect(dbOnly).toMatchObject({ turnStartedAt: null, contextPct: null, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } });
    expect(laneView(lane, null, { worktreeExists: true, switches: 0, updatedAt: 5, tokens: { input: 9, output: 0, cacheWrite: 0, cacheRead: 0 } }).tokens).toEqual({ input: 9, output: 0, cacheWrite: 0, cacheRead: 0 }); // §5.3 stored tokens
    expect(laneView(lane, rt, { worktreeExists: false, switches: 2, updatedAt: 5 })).toMatchObject({ turnStartedAt: 1234, contextPct: 42, state: 'waiting_po', account: 'a@x', phase: 'review', openCards: [7], costUsd: 2, switches: 2, worktreeExists: false, failCount: 0, tokens: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } });
  });
  test('§5.6 laneView: model / effort = tier 1 (row); run / pending / modelMismatch from the runtime; no runtime → the stored run', () => {
    const rt = { projectId: 'p', name: 'D2', laneId: 1, sessionId: 's', cwd: '/w/d2', state: 'running' as const, account: 'a@x', phase: 'code', failCount: 0, lastError: null, openCards: [], switchPending: false, sawAssistant: true, costUsd: 2, alive: true, turnStartedAt: 1, contextPct: 1, waitReason: null, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      run: { model: 'claude-opus-5-5', modelName: 'Opus 5.5', effort: 'medium' }, pending: { model: 'sonnet', modelName: 'Sonnet 5.5' }, modelMismatch: true };
    expect(laneView(lane, rt, { worktreeExists: true, switches: 0, updatedAt: 0 })).toMatchObject({ model: 'opus', effort: 'medium', run: rt.run, pending: rt.pending, modelMismatch: true });
    const quiet = laneView(lane, { ...rt, run: null, pending: undefined, modelMismatch: false }, { worktreeExists: true, switches: 0, updatedAt: 0, run: { model: 'x', effort: null } });
    expect(['run', 'pending', 'modelMismatch'].filter((k) => k in quiet)).toEqual([]); // a runtime with nothing read yet: no stored fallback
    expect(laneView(lane, null, { worktreeExists: true, switches: 0, updatedAt: 0, run: { model: 'claude-fable-5-2', modelName: 'Fable 5.2', effort: 'high' } }).run).toEqual({ model: 'claude-fable-5-2', modelName: 'Fable 5.2', effort: 'high' });
  });
  test('v2.9 §6.1 laneView: a pack\'s own phase passes through (lane_set_phase checked it against the lane\'s rev)', () => {
    expect(laneView({ ...lane, phase: 'weird' }, null, { worktreeExists: true, switches: 0, updatedAt: 0 }).phase).toBe('weird');
  });

  test('orchestratorView: done → stopped; home account', () => {
    expect(orchestratorView({ projectId: 'p', sessionId: 's', state: 'done', account: 'o@x', home: 'o@x', deaths: 0, lastError: null, alive: false, contextPct: 37, talkingTo: null, tokens: { input: 5, output: 6, cacheWrite: 7, cacheRead: 8 } }, 0.5))
      .toEqual({ projectId: 'p', state: 'stopped', account: 'o@x', homeAccount: 'o@x', lastError: null, lastErrorKeyed: null, costUsd: 0.5, contextPct: 37, talkingTo: null, tokens: { input: 5, output: 6, cacheWrite: 7, cacheRead: 8 } });
  });

  test('§4.4 N1-i orchestratorView carries the session model when known (additive)', () => {
    const rt = { projectId: 'p', sessionId: 's', state: 'idle' as const, account: 'o@x', home: 'o@x', deaths: 0, lastError: null, alive: true, contextPct: null, talkingTo: null, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
    expect(orchestratorView({ ...rt, model: 'claude-opus-5-5' }, 0).model).toBe('claude-opus-5-5');
    expect('model' in orchestratorView(rt, 0)).toBe(false);
  });

  test('v1.1 §5.2 snapshot orchestratorView carries talkingTo', () => {
    expect(orchestratorView({ projectId: 'p', sessionId: 's', state: 'running', account: 'o@x', home: 'o@x', deaths: 0, lastError: null, alive: true, contextPct: 37, talkingTo: 'D2', tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }, 0).talkingTo)
      .toBe('D2');
  });

  test('cardView: ask options with recommended, context; permission allow-always; system actions', () => {
    const askC: Card = { id: 3, kind: 'ask', projectId: 'p', sessionId: 's', requestId: null, status: 'open', createdAt: 1, resolvedAt: null, answer: null,
      payload: { source: 'D2', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }], recommended: 'B', context: 'ctx' } };
    expect(cardView(askC)).toMatchObject({ id: 3, kind: 'ask', source: 'D2', title: 'D2 hỏi: Q?', question: 'Q?', recommended: 'B', context: 'ctx' });
    expect(cardView(askC).options!.map((o) => o.label)).toEqual(['B', 'A']);
    const p: Card = { ...askC, kind: 'permission', payload: { source: 'D2', title: 'D2 xin chạy: Bash ls', toolName: 'Bash', input: { command: 'ls' }, description: null, suggestions: [{}], allowAlways: true } };
    expect(cardView(p)).toMatchObject({ title: 'D2 xin chạy: Bash ls', canAllowAlways: true, context: JSON.stringify({ command: 'ls' }, null, 2) });
    const s: Card = { ...askC, kind: 'broken', payload: { title: 'Lane D2 hỏng', body: 'b', key: 'lane:D2', actions: [{ label: 'Chạy lại', action: 'lane_resume' }] } };
    expect(cardView(s)).toMatchObject({ title: 'Lane D2 hỏng', context: 'b', actions: [{ id: 'lane_resume', label: 'Chạy lại' }], source: null });
  });
  test('v2 §6 A9 cardView: a system card carries its key (A9 `<email>/<name>` for the dry-run merge, orphan dir)', () => {
    const s: Card = { id: 9, kind: 'shared_cfg', projectId: null, sessionId: null, requestId: null, status: 'open', createdAt: 1, resolvedAt: null, answer: null,
      payload: { title: 't', body: null, key: 'ba@x/plans', actions: [] } };
    expect(cardView(s).key).toBe('ba@x/plans');
  });
  test('§5.3 every `*At` a client reads is epoch ms: card created / resolved, account quota times', () => {
    const c: Card = { id: 9, kind: 'shared_cfg', projectId: null, sessionId: null, requestId: null, status: 'answered', createdAt: 1_700_000_000, resolvedAt: 1_700_000_060, answer: null,
      payload: { title: 't', body: null, key: 'k', actions: [] } };
    expect(cardView(c)).toMatchObject({ createdAt: 1_700_000_000_000, resolvedAt: 1_700_000_060_000 });
    expect(cardView({ ...c, resolvedAt: null }).resolvedAt).toBeNull();
    const a = accountView({ account: acct, caps, quota: q(), lanes: 0, now: NOW, loggedOut: false });
    expect(a).toMatchObject({ fetchedAt: (NOW - 60) * 1000, fiveResetsAt: (NOW + 100) * 1000, weekResetsAt: (NOW + 1000) * 1000, fresh: true });
    expect(accountView({ account: acct, caps, quota: q({ fiveResetsAt: null, weekResetsAt: null }), lanes: 0, now: NOW, loggedOut: false })).toMatchObject({ fiveResetsAt: null, weekResetsAt: null });
    expect(accountView({ account: acct, caps, quota: null, lanes: 0, now: NOW, loggedOut: false }).fetchedAt).toBeNull();
  });
});

describe('§5.3 one time unit on the protocol', () => {
  test('§5.3 a boundary line `at` is epoch ms (the engine Boundary holds seconds)', () => {
    const l = boundaryLine({ type: 'start', seq: 2, at: 1_763_200_000, account: 'a@x' });
    expect(l.boundary?.at).toBe(1_763_200_000_000);
  });
  test('§4.14 m-5 a resume line\'s vi fallback reads "Chạy tiếp <dd/MM HH:mm> · <acc> · song song | thay #m"', () => {
    const at = new Date(2026, 10, 15, 15, 20).getTime() / 1000;
    expect(boundaryLine({ type: 'resume', seq: 2, at, account: 'acc33@x', mode: 'parallel', replaced: null }).text).toBe('Chạy tiếp 15/11 15:20 · acc33@x · song song');
    expect(boundaryLine({ type: 'resume', seq: 2, at, account: 'acc33@x', mode: 'replace', replaced: 3 }).text).toBe('Chạy tiếp 15/11 15:20 · acc33@x · thay #3');
  });
});
