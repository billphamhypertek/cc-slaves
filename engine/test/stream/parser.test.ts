import { describe, expect, test } from 'bun:test';
import { McpInitStore,
  LineSplitter, TooLong, classify, contextPct, contextTokens, contextWindow, isAuthError, isLimitError, laneCost, parseLine, turnCost,
  type ResultEvent,
} from '../../src/stream/parser.ts';

const enc = new TextEncoder();
const j = (o: unknown) => JSON.stringify(o);

describe('LineSplitter (§8.4 parse stream line by line)', () => {
  test('§8.4 joins a line split across chunks', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
    expect(s.end()).toEqual([]);
  });

  test('§8.4 strips CRLF and skips blank lines', () => {
    const s = new LineSplitter();
    expect(s.push('x\r\n\r\n\ny\r')).toEqual(['x']);
    expect(s.push('\n')).toEqual(['y']);
  });

  test('§8.4 a multi-byte UTF-8 char split across byte chunks survives', () => {
    const bytes = enc.encode('{"t":"Điều phối"}\n');
    const s = new LineSplitter();
    const out = [...s.push(bytes.slice(0, 7)), ...s.push(bytes.slice(7))];
    expect(out).toEqual(['{"t":"Điều phối"}']);
  });

  test('§8.4 trailing line without newline is flushed by end()', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}')).toEqual([]);
    expect(s.end()).toEqual(['{"a":1}']);
  });

  test('§8.4 huge line over the cap becomes TooLong, next line is intact', () => {
    const s = new LineSplitter({ maxLineChars: 100 });
    const out = [...s.push('x'.repeat(60)), ...s.push('x'.repeat(60)), ...s.push('yy\n{"ok":1}\n')];
    expect(out[0]).toBeInstanceOf(TooLong);
    expect((out[0] as TooLong).length).toBe(122);
    expect(out[1]).toBe('{"ok":1}');
  });

  test('§8.4 a 5 MB line under the default cap is kept whole', () => {
    const big = j({ type: 'user', message: { content: 'z'.repeat(5_000_000) } });
    const s = new LineSplitter();
    const out: unknown[] = [];
    for (let i = 0; i < big.length; i += 65536) out.push(...s.push(big.slice(i, i + 65536)));
    out.push(...s.push('\n'));
    expect(out).toEqual([big]);
  });
});

describe('parseLine never throws (§12 stream-json format drift)', () => {
  test('§12 invalid JSON → unknown invalid_json', () => {
    const e = parseLine('{"type":"assist');
    expect(e.kind).toBe('unknown');
    expect(e.kind === 'unknown' && e.reason).toBe('invalid_json');
  });
  test('§12 non-object JSON and unknown type → unknown', () => {
    expect(parseLine('42').kind).toBe('unknown');
    expect(parseLine('null').kind).toBe('unknown');
    expect(parseLine('[1]').kind).toBe('unknown');
    const e = parseLine(j({ type: 'brand_new_thing', x: 1 }));
    expect(e.kind === 'unknown' && e.reason).toBe('unrecognized');
  });
  test('§12 missing fields do not throw', () => {
    for (const t of ['system', 'assistant', 'user', 'result', 'stream_event', 'rate_limit_event', 'control_request',
      'control_response', 'control_cancel_request']) {
      expect(() => parseLine(j({ type: t }))).not.toThrow();
    }
    expect(() => classify({ type: 'system', subtype: 'init', mcp_servers: 'oops', tools: 7 })).not.toThrow();
    expect(() => classify({ type: 'result', model_usage_since_last_result: { m: null } })).not.toThrow();
  });
});

describe('classify every event kind (§3.3 shapes)', () => {
  test('§3.3-18 system/init', () => {
    const e = parseLine(j({
      type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku', claude_code_version: '2.1.325',
      permissionMode: 'default', tools: ['Bash', 'mcp__cc_slaves__ask'], cwd: '/x', extra: true,
      mcp_servers: [{ name: 'cc_slaves', status: 'connected', source: 'dynamic' }, { name: 'gh', status: 'needs-auth' }],
    }));
    expect(e).toMatchObject({
      kind: 'init', sessionId: 's1', model: 'claude-haiku', claudeCodeVersion: '2.1.325', permissionMode: 'default',
      tools: ['Bash', 'mcp__cc_slaves__ask'],
      mcpServers: [{ name: 'cc_slaves', status: 'connected', source: 'dynamic' }, { name: 'gh', status: 'needs-auth', source: null }],
    });
  });

  test('§3.3-17 user replay keeps uuid + isReplay; §3.3-12 parent_tool_use_id', () => {
    const e = parseLine(j({ type: 'user', uuid: 'u-1', isReplay: true, parent_tool_use_id: null, session_id: 's1',
      message: { role: 'user', content: '[PO] hi' } }));
    expect(e).toMatchObject({ kind: 'user', uuid: 'u-1', isReplay: true, parentToolUseId: null, sessionId: 's1' });
    const a = parseLine(j({ type: 'assistant', uuid: 'a-1', parent_tool_use_id: 'toolu_9', message: { content: [] } }));
    expect(a).toMatchObject({ kind: 'assistant', uuid: 'a-1', isReplay: false, parentToolUseId: 'toolu_9' });
  });

  test('§7.4 stream_event partial', () => {
    const e = parseLine(j({ type: 'stream_event', event: { type: 'content_block_delta' }, parent_tool_use_id: null }));
    expect(e).toMatchObject({ kind: 'stream_event', parentToolUseId: null, event: { type: 'content_block_delta' } });
  });

  test('§3.3-19 result fields + permission_denials + subagent_stats', () => {
    const e = parseLine(j({
      type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.00846, num_turns: 2,
      session_id: 's1', result_index: 2, permission_denials: [{ tool_name: 'Write' }], subagent_stats: { count: 1 },
      model_usage_since_last_result: { 'claude-haiku': { costUSD: 0.0004 }, 'claude-opus': { costUSD: 0.00013 } },
    }));
    expect(e).toMatchObject({
      kind: 'result', subtype: 'success', isError: false, result: 'done', totalCostUsd: 0.00846, resultIndex: 2,
      permissionDenials: [{ tool_name: 'Write' }], subagentStats: { count: 1 }, sessionId: 's1', numTurns: 2,
    });
    expect((e as ResultEvent).sinceLastCostUsd).toBeCloseTo(0.00053, 10);
  });

  test('§3.3-9 rate_limit_event (unifiedWindows and flat shapes)', () => {
    const a = parseLine(j({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1700,
      unifiedWindows: { five_hour: { utilization: 0.91, resetsAt: 1700 }, seven_day: { utilization: 0.4, resetsAt: 9000 } } } }));
    expect(a).toMatchObject({ kind: 'rate_limit_event', status: 'allowed_warning', resetsAt: 1700,
      fiveHour: { utilization: 0.91, resetsAt: 1700 }, sevenDay: { utilization: 0.4, resetsAt: 9000 } });
    const b = parseLine(j({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 5,
      rateLimitType: 'seven_day', utilization: 1 } }));
    expect(b).toMatchObject({ kind: 'rate_limit_event', status: 'rejected', fiveHour: null, sevenDay: { utilization: 1, resetsAt: 5 } });
  });

  test('§3.3-13 control_request can_use_tool', () => {
    const e = parseLine(j({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool',
      tool_name: 'Write', display_name: 'Write', input: { file_path: '/a' }, description: 's1-c.txt',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      server_policy_ask_only: true, tool_use_id: 'toolu_1' } }));
    expect(e).toMatchObject({ kind: 'can_use_tool', requestId: 'r1', toolName: 'Write', input: { file_path: '/a' },
      toolUseId: 'toolu_1', description: 's1-c.txt',
      permissionSuggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  });

  test('§3.3 other control_request subtypes → unknown, not can_use_tool', () => {
    const e = parseLine(j({ type: 'control_request', request_id: 'r', request: { subtype: 'hook_callback' } }));
    expect(e.kind).toBe('unknown');
  });

  test('§3.3-14 control_cancel_request', () => {
    expect(parseLine(j({ type: 'control_cancel_request', request_id: 'r1' })))
      .toMatchObject({ kind: 'control_cancel_request', requestId: 'r1' });
  });

  test('§3.3-14 control_response echo + interrupt still_queued', () => {
    const e = parseLine(j({ type: 'control_response', response: { subtype: 'success', request_id: 'i1',
      response: { still_queued: ['u-2', { uuid: 'u-3' }] } } }));
    expect(e).toMatchObject({ kind: 'control_response', requestId: 'i1', subtype: 'success', stillQueued: ['u-2', 'u-3'] });
    const echo = parseLine(j({ type: 'control_response', response: { subtype: 'success', request_id: 'r1',
      response: { behavior: 'allow', updatedInput: {} } } }));
    expect(echo).toMatchObject({ kind: 'control_response', requestId: 'r1', stillQueued: null, behavior: 'allow' });
    const err = parseLine(j({ type: 'control_response', response: { subtype: 'error', request_id: 'x', error: 'bad' } }));
    expect(err).toMatchObject({ subtype: 'error', error: 'bad' });
  });

  test('§3.3-13 system/status permissionMode', () => {
    expect(parseLine(j({ type: 'system', subtype: 'status', permissionMode: 'acceptEdits' })))
      .toMatchObject({ kind: 'status', permissionMode: 'acceptEdits' });
  });

  test('§3.3-12/20 task events: subagent iff subagent_type', () => {
    const st = parseLine(j({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_2',
      description: 'look', subagent_type: 'Explore', prompt: 'p', is_backgrounded: true, spawn_depth: 1 }));
    expect(st).toMatchObject({ kind: 'task_started', taskId: 't1', toolUseId: 'toolu_2', isSubagent: true,
      subagentType: 'Explore', isBackgrounded: true, description: 'look' });
    const bash = parseLine(j({ type: 'system', subtype: 'task_started', task_id: 't2', tool_use_id: 'toolu_3',
      description: 'sleep 5', owned_by_subagent: 't1' }));
    expect(bash).toMatchObject({ kind: 'task_started', isSubagent: false, subagentType: null });
    expect(parseLine(j({ type: 'system', subtype: 'task_progress', task_id: 't1',
      usage: { total_tokens: 900 }, tool_uses: 3, last_tool_name: 'Bash' })))
      .toMatchObject({ kind: 'task_progress', taskId: 't1', totalTokens: 900, toolUses: 3, lastToolName: 'Bash' });
    expect(parseLine(j({ type: 'system', subtype: 'task_updated', task_id: 't1', status: 'completed' })))
      .toMatchObject({ kind: 'task_updated', status: 'completed' });
    expect(parseLine(j({ type: 'system', subtype: 'task_notification', task_id: 't1', output_file: '/o', summary: 'ok' })))
      .toMatchObject({ kind: 'task_notification', outputFile: '/o', summary: 'ok' });
  });

  test('§12 unknown system subtype → unknown, raw kept', () => {
    const e = parseLine(j({ type: 'system', subtype: 'hook_started', x: 1 }));
    expect(e.kind).toBe('unknown');
    expect(e.raw).toEqual({ type: 'system', subtype: 'hook_started', x: 1 });
  });
});

const result = (o: Record<string, unknown>) => classify({ type: 'result', subtype: 'success', ...o }) as ResultEvent;

describe('limit / auth classification (§3.4, §7.4)', () => {
  test.each([
    'Claude AI usage limit reached|1763150400',
    "You've hit your limit · resets 3pm (Asia/Saigon)",
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    '5-hour limit reached ∙ resets 9pm',
  ])('§3.4 limit error: %s', (text) => {
    const r = result({ is_error: true, result: text });
    expect(isLimitError(r)).toBe(true);
    expect(isAuthError(r)).toBe(false);
  });

  test.each([
    'Invalid API key · Please run /login',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'Not logged in · Please run /login',
  ])('§3.4 auth error: %s', (text) => {
    const r = result({ is_error: true, result: text });
    expect(isAuthError(r)).toBe(true);
    expect(isLimitError(r)).toBe(false);
  });

  test('§3.4 non-error result mentioning limit is not a limit error', () => {
    expect(isLimitError(result({ is_error: false, result: 'I fixed the rate limit bug' }))).toBe(false);
    expect(isAuthError(result({ is_error: false, result: 'Please run /login' }))).toBe(false);
  });

  test('§3.4 text matching both tables is auth, never limit (waiting does not fix a login)', () => {
    const r = result({ is_error: true, result: 'OAuth token has expired · usage limit reached' });
    expect(isAuthError(r)).toBe(true);
    expect(isLimitError(r)).toBe(false);
  });

  test('§3.4 other errors are neither', () => {
    const r = result({ is_error: true, subtype: 'error_during_execution', result: '' });
    expect(isLimitError(r)).toBe(false);
    expect(isAuthError(r)).toBe(false);
  });
});

describe('cost (§8.6)', () => {
  test('§8.6 turnCost sums model_usage_since_last_result costUSD', () => {
    const r = result({ model_usage_since_last_result: { a: { costUSD: 0.25 }, b: { costUSD: 0.5 }, c: {} } });
    expect(turnCost(r)).toBe(0.75);
  });
  test('§8.6 turnCost is null when the field is missing (never total_cost_usd)', () => {
    expect(turnCost(result({ total_cost_usd: 9 }))).toBeNull();
  });
  test('§8.6 lane cost = max total_cost_usd seen (cumulative across resume)', () => {
    let c: number | null = null;
    for (const t of [0.00794, 0.00846, 0.0082, 0.0092]) c = laneCost(c, result({ total_cost_usd: t }));
    expect(c).toBe(0.0092);
    expect(laneCost(0.5, result({}))).toBe(0.5);
  });
});

describe('context fill (§6.3 ctx %, UnitPanel)', () => {
  const asst = (usage: unknown, parent: string | null = null) =>
    parseLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', usage, content: [] } }));

  test('contextTokens = input + cache creation + cache read of a top-level assistant message', () => {
    expect(contextTokens(asst({ input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 49_000, output_tokens: 500 }))).toBe(50_010);
    expect(contextTokens(asst({ input_tokens: 3 }))).toBe(3);
  });

  test('no usage, a sub-agent message, or a non-assistant event → null (does not move the lane gauge)', () => {
    expect(contextTokens(asst(undefined))).toBeNull();
    expect(contextTokens(asst({ input_tokens: 9 }, 'toolu_1'))).toBeNull();
    expect(contextTokens(parseLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } })))).toBeNull();
  });

  test('window: 200k by default, 1M when the model id ends in [1m]; pct rounded, capped at 100', () => {
    expect(contextWindow('claude-opus-5-5')).toBe(200_000);
    expect(contextWindow(null)).toBe(200_000);
    expect(contextWindow('claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(contextPct(50_010, 'claude-opus-5-5')).toBe(25);
    expect(contextPct(50_010, 'claude-opus-5-5[1m]')).toBe(5);
    expect(contextPct(260_000, 'sonnet')).toBe(100);
  });
});

describe('MCP state per server from system/init (v2.2 §5.1)', () => {
  const init = (servers: { name: string; status: string }[], tools: string[] = []) => {
    const e = parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: servers, tools }));
    if (e.kind !== 'init') throw new Error('not init');
    return e;
  };
  test('§5.1 / §5.4b init → one record per (project, server): state, its tool names + count, lane, time; cc_slaves skipped', () => {
    const s = new McpInitStore();
    s.record('p1', 'D1', init([{ name: 'linear', status: 'connected' }, { name: 'plugin_vercel_vercel', status: 'failed' }, { name: 'cc_slaves', status: 'connected' }],
      ['Bash', 'mcp__linear__a', 'mcp__linear__b', 'mcp__linear_x__c', 'mcp__cc_slaves__lane_list']), 1000);
    expect(s.list()).toEqual([
      { projectId: 'p1', name: 'linear', state: 'connected', tools: 2, toolNames: ['a', 'b'], lane: 'D1', at: 1000 },
      { projectId: 'p1', name: 'plugin_vercel_vercel', state: 'failed', tools: 0, toolNames: [], lane: 'D1', at: 1000 },
    ]);
  });
  test('§5.1 not per account: the last init of any lane wins; another project keeps its own record; an omitted server stays', () => {
    const s = new McpInitStore();
    s.record('p1', 'D1', init([{ name: 'linear', status: 'failed' }]), 1);
    s.record('p2', 'D9', init([{ name: 'linear', status: 'needs-auth' }]), 2);
    s.record('p1', 'D2', init([{ name: 'linear', status: 'connected' }], ['mcp__linear__a']), 3);
    s.record('p1', 'D3', init([]), 4);
    expect(s.list()).toEqual([
      { projectId: 'p1', name: 'linear', state: 'connected', tools: 1, toolNames: ['a'], lane: 'D2', at: 3 },
      { projectId: 'p2', name: 'linear', state: 'needs-auth', tools: 0, toolNames: [], lane: 'D9', at: 2 },
    ]);
  });
});
