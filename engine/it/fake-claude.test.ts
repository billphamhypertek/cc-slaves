import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LineSplitter, parseLine, TooLong, type StreamEvent } from '../src/stream/parser.ts';
import { allowLine, denyLine, interruptLine, userLine } from '../src/stream/writer.ts';

const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const CLAUDE_FLAGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--setting-sources', 'user,project,local',
  '--dangerously-skip-permissions', '--settings', '/tmp/deny.json', '--mcp-config', '/tmp/mcp.json',
  '--disallowedTools', 'AskUserQuestion', '--append-system-prompt', 'role', '--session-id', 'sess-1',
  '--agent', 'a', '--model', 'haiku', '--effort', 'low',
];

let tmp: string | null = null;
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

function run(scenario: string) {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-fake-'));
  const trace = join(tmp, 'trace.json');
  const proc = Bun.spawn(['bun', FAKE, ...CLAUDE_FLAGS], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_TRACE: trace, SECRET_THING: 'hunter2' },
  });
  const events: StreamEvent[] = [];
  let wake: () => void = () => {};
  const pump = (async () => {
    const s = new LineSplitter();
    const push = (l: string | TooLong) => { events.push(l instanceof TooLong ? { kind: 'unknown', reason: 'line_too_long', line: null, raw: null } : parseLine(l)); wake(); };
    for await (const chunk of proc.stdout) for (const l of s.push(chunk)) push(l);
    for (const l of s.end()) push(l);
    wake();
  })();
  const write = (l: string) => { void proc.stdin.write(l); void proc.stdin.flush(); };
  async function until(pred: (e: StreamEvent) => boolean, ms = 5000): Promise<StreamEvent> {
    const deadline = Date.now() + ms;
    for (let seen = 0; ; ) {
      for (; seen < events.length; seen++) if (pred(events[seen]!)) return events[seen]!;
      if (Date.now() > deadline) throw new Error(`timeout; got ${events.map((e) => e.kind).join(',')}`);
      await Promise.race([new Promise<void>((r) => { wake = r; }), Bun.sleep(50)]);
    }
  }
  return { proc, events, write, until, pump, trace };
}

const isResult = (e: StreamEvent) => e.kind === 'result';

describe('fake-claude (§3.3, §12)', () => {
  test('§3.3-17/18 ok-turn: init only after first user line, replay keeps uuid, trace has argv + env keys only', async () => {
    const f = run('ok-turn');
    await Bun.sleep(300);
    expect(f.events.filter((e) => e.kind === 'init')).toEqual([]); // §3.3-18 nothing before the first user line
    f.write(userLine('[PO] làm đi', 'u-1'));
    const init = await f.until((e) => e.kind === 'init');
    expect(init).toMatchObject({ sessionId: 'sess-1', model: 'haiku', permissionMode: 'bypassPermissions' });
    expect(init.kind === 'init' && init.mcpServers.map((s) => `${s.name}:${s.status}`)).toEqual(['cc_slaves:connected']);
    const res = await f.until(isResult);
    expect(res).toMatchObject({ subtype: 'success', isError: false });
    expect(res.kind === 'result' && res.sinceLastCostUsd).toBeGreaterThan(0);
    const replay = f.events.find((e) => e.kind === 'user' && e.isReplay);
    expect(replay).toMatchObject({ uuid: 'u-1', sessionId: 'sess-1' });
    const kinds = f.events.map((e) => e.kind);
    expect(kinds.indexOf('init')).toBeLessThan(kinds.indexOf('assistant'));
    expect(kinds).toContain('stream_event');
    expect(kinds).toContain('rate_limit_event');
    void f.proc.stdin.end(); // §3.3-7 close stdin while idle → exit 0, no further result
    expect(await f.proc.exited).toBe(0);
    await f.pump;
    expect(f.events.filter(isResult).length).toBe(1);
    const trace = JSON.parse(readFileSync(f.trace, 'utf8'));
    expect(trace.argv).toEqual(CLAUDE_FLAGS);
    expect(trace.envKeys).toContain('SECRET_THING');
    expect(readFileSync(f.trace, 'utf8')).not.toContain('hunter2');
  });

  test('§3.3-13 permission-request: control_request → allow echoed → result; deny → permission_denials', async () => {
    for (const answer of ['allow', 'deny'] as const) {
      const f = run('permission-request');
      f.write(userLine('viết file', 'u-1'));
      const req = await f.until((e) => e.kind === 'can_use_tool');
      if (req.kind !== 'can_use_tool') throw new Error('unreachable');
      expect(req.toolName).toBe('Write');
      expect(req.permissionSuggestions.length).toBeGreaterThan(0);
      f.write(answer === 'allow' ? allowLine(req.requestId, req.input) : denyLine(req.requestId, 'không'));
      const echo = await f.until((e) => e.kind === 'control_response');
      expect(echo).toMatchObject({ requestId: req.requestId, behavior: answer });
      const res = await f.until(isResult);
      expect(res.kind === 'result' && res.permissionDenials.length).toBe(answer === 'allow' ? 0 : 1);
      void f.proc.stdin.end();
      expect(await f.proc.exited).toBe(0);
    }
  });

  test('§3.3-6/14/17 interrupt: still_queued lists the unreplayed message, turn ends error_during_execution, session lives', async () => {
    const f = run('interrupt');
    f.write(userLine('first', 'u-1'));
    await f.until((e) => e.kind === 'assistant');
    f.write(userLine('mid-turn', 'u-2'));
    await Bun.sleep(100);
    f.write(interruptLine('i-1'));
    const ack = await f.until((e) => e.kind === 'control_response');
    expect(ack).toMatchObject({ requestId: 'i-1', subtype: 'success', stillQueued: ['u-2'] });
    const r1 = await f.until(isResult);
    expect(r1).toMatchObject({ subtype: 'error_during_execution' });
    expect(f.events.some((e) => e.kind === 'user' && e.uuid === 'u-2')).toBe(false); // never entered the conversation
    f.write(userLine('again', 'u-3'));
    await f.until((e) => e.kind === 'result' && e.subtype === 'success');
    expect(f.events.some((e) => e.kind === 'user' && e.isReplay && e.uuid === 'u-3')).toBe(true);
    void f.proc.stdin.end();
    expect(await f.proc.exited).toBe(0);
  });

  test('hf1117-perf the engine dies during FAKE_CLAUDE_BOOT_MS with a line queued: fake-claude exits (no orphan)', async () => {
    // A parent stands in for the engine: it spawns the fake with a slow boot, queues one control line, then is SIGKILLed.
    const parent = Bun.spawn(['bun', '-e', `
      const p = Bun.spawn(['bun', ${JSON.stringify(FAKE)}, '-p'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'ok-turn', FAKE_CLAUDE_BOOT_MS: '800' } });
      p.stdin.write(${JSON.stringify(interruptLine('r-1'))}); p.stdin.flush();
      console.log(p.pid);
      await Bun.sleep(60000);`], { stdout: 'pipe', stderr: 'inherit' });
    const { value } = await parent.stdout.getReader().read();
    const pid = Number(new TextDecoder().decode(value).trim());
    expect(pid).toBeGreaterThan(0);
    parent.kill('SIGKILL');
    await parent.exited;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 800 + 2000;
    while (alive() && Date.now() < deadline) await Bun.sleep(50);
    const left = alive();
    if (left) process.kill(pid, 'SIGKILL');
    expect(left).toBe(false);
  });

  test('hf1117-perf FAKE_CLAUDE_STDIN_LOG dir removed during FAKE_CLAUDE_BOOT_MS (test teardown): fake-claude exits', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ccs-fake-'));
    const proc = Bun.spawn(['bun', FAKE, '-p'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'ok-turn', FAKE_CLAUDE_BOOT_MS: '800', FAKE_CLAUDE_STDIN_LOG: join(tmp, 'stdin.log') } });
    void proc.stdin.write(interruptLine('r-1')); void proc.stdin.flush();
    rmSync(tmp, { recursive: true, force: true });
    const r = await Promise.race([proc.exited, Bun.sleep(800 + 2000).then(() => 'alive' as const)]);
    if (r === 'alive') proc.kill('SIGKILL');
    expect(r).not.toBe('alive');
  });

  test('§3.3-7 SIGINT ends the whole process: result error_during_execution, exit 0', async () => {
    const f = run('interrupt');
    f.write(userLine('first', 'u-1'));
    await f.until((e) => e.kind === 'assistant');
    f.proc.kill('SIGINT');
    expect(await f.proc.exited).toBe(0);
    await f.pump;
    expect(f.events.filter(isResult)).toMatchObject([{ subtype: 'error_during_execution', isError: true }]);
  });

  test('§3.3-14 interrupt while a permission is pending: control_cancel_request, still_queued [], error_during_execution, session lives', async () => {
    const f = run('permission-request');
    f.write(userLine('viết file', 'u-1'));
    const req = await f.until((e) => e.kind === 'can_use_tool');
    if (req.kind !== 'can_use_tool') throw new Error('unreachable');
    f.write(interruptLine('i-1'));
    const cancel = await f.until((e) => e.kind === 'control_cancel_request');
    expect(cancel).toMatchObject({ requestId: req.requestId });
    expect(await f.until((e) => e.kind === 'control_response')).toMatchObject({ requestId: 'i-1', stillQueued: [] });
    expect(await f.until(isResult)).toMatchObject({ subtype: 'error_during_execution', isError: true });
    await Bun.sleep(200);
    expect(f.proc.exitCode).toBeNull(); // phiên sống
    void f.proc.stdin.end();
    expect(await f.proc.exited).toBe(0);
    expect(f.events.filter(isResult).length).toBe(1);
  });

  test('§7.4 die-mid-turn: partial line then non-zero exit, no result', async () => {
    const f = run('die-mid-turn');
    f.write(userLine('go', 'u-1'));
    expect(await f.proc.exited).not.toBe(0);
    await f.pump;
    expect(f.events.some(isResult)).toBe(false);
    expect(f.events.at(-1)).toMatchObject({ kind: 'unknown', reason: 'invalid_json' });
  });

  test('§3.3-12/20 every shipped scenario plays to a result or a clean death', async () => {
    for (const s of ['rate-limit-over-cap', 'limit-error-result', 'auth-error', 'self-started-turn', 'subagent']) {
      const f = run(s);
      f.write(userLine('go', 'u-1'));
      const last = s === 'self-started-turn' ? 3 : 1;
      while (f.events.filter(isResult).length < last) await f.until(isResult, 5000).then(() => Bun.sleep(20));
      void f.proc.stdin.end();
      await f.proc.exited;
      await f.pump;
      if (s === 'subagent') {
        expect(f.events.some((e) => e.kind === 'task_started' && e.isSubagent)).toBe(true);
        expect(f.events.some((e) => e.kind === 'task_started' && !e.isSubagent)).toBe(true);
        expect(f.events.some((e) => e.kind === 'assistant' && e.parentToolUseId !== null)).toBe(true);
      }
      if (s === 'self-started-turn') expect(f.events.filter(isResult).length).toBe(3);
    }
  }, 20000);
  test('v2.2 §3-15 stream step: real-shape stream_events (api_message_id, parent, index) in the measured order', async () => {
    const f = run('stream-blocks');
    f.write(userLine('[PO] nói đi', 'u-1'));
    await f.until(isResult);
    const se = f.events.filter((e) => e.kind === 'stream_event');
    const shape = (e: StreamEvent): string => {
      if (e.kind === 'assistant') { const m = e.message as { id: string; content: { type: string }[] }; return `A ${m.id} ${m.content[0]!.type}`; }
      if (e.kind !== 'stream_event') return e.kind;
      const v = e.event as { type: string; index?: number; content_block?: { type: string }; delta?: { type: string } };
      return [v.type, v.index, v.content_block?.type ?? v.delta?.type].filter((x) => x !== undefined).join(' ');
    };
    const seq = f.events.filter((e) => e.kind === 'stream_event' || e.kind === 'assistant').map(shape);
    // §3-15: start → deltas → assistant [block] → stop, one block at a time
    const msg1 = seq.slice(0, seq.indexOf('message_stop') + 1).filter((x, i, a) => x !== a[i - 1]);
    expect(msg1).toEqual([
      'message_start', 'content_block_start 0 thinking', 'content_block_delta 0 thinking_delta', 'content_block_delta 0 signature_delta', 'A msg_fake_1 thinking', 'content_block_stop 0',
      'content_block_start 1 text', 'content_block_delta 1 text_delta', 'A msg_fake_1 text', 'content_block_stop 1',
      'content_block_start 2 tool_use', 'content_block_delta 2 input_json_delta', 'A msg_fake_1 tool_use', 'content_block_stop 2',
      'message_delta', 'message_stop',
    ]);
    expect(se.every((e) => e.apiMessageId !== null)).toBe(true);
    const text = se.filter((e) => e.apiMessageId === 'msg_fake_1').map((e) => (e.event as { delta?: { text?: string } }).delta?.text ?? '').join('');
    expect(text).toBe('Xin chào, đây là **đậm** và `code`.');
    expect(se.filter((e) => e.apiMessageId === 'msg_fake_2').every((e) => e.parentToolUseId === 'toolu_fake_1')).toBe(true);
    const sub = f.events.find((e) => e.kind === 'assistant' && e.parentToolUseId === 'toolu_fake_1');
    expect(sub).toBeDefined();
    void f.proc.stdin.end();
    await f.proc.exited;
  });
});
