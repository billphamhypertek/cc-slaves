import { describe, expect, test } from 'bun:test';
import type { Target } from '../../../shared/protocol.ts';
import { classify, type TaskEvent } from '../../src/stream/parser.ts';
import { SubagentTracker } from '../../src/server/subagents.ts';

const D2: Target = { kind: 'lane', projectId: 'p1', name: 'D2' };
const D3: Target = { kind: 'lane', projectId: 'p1', name: 'D3' };
const X1: Target = { kind: 'lane', projectId: 'p2', name: 'X1' };
const ev = (o: Record<string, unknown>) => classify({ type: 'system', ...o }) as TaskEvent;
const started = (id: string, extra: Record<string, unknown> = {}) =>
  ev({ subtype: 'task_started', task_id: id, tool_use_id: `tu-${id}`, description: `d ${id}`, subagent_type: 'Explore', ...extra });

describe('§5.3 W9 subagent tracker', () => {
  test('§5.3 task_started → running, progress fills tokens / tools / last tool, completed sets endedAt', () => {
    let now = 1000;
    const t = new SubagentTracker(() => now);
    expect(t.task(D2, started('a'))).toBe(true);
    expect(t.list(D2)).toEqual([{ taskId: 'a', toolUseId: 'tu-a', description: 'd a', subagentType: 'Explore', background: false,
      status: 'running', totalTokens: null, toolUses: null, lastTool: null, startedAt: 1000, endedAt: null }]); // §4.11b startedAt → duration
    t.task(D2, ev({ subtype: 'task_progress', task_id: 'a', usage: { total_tokens: 1234 }, tool_uses: 2, last_tool_name: 'Bash' }));
    now = 5000;
    t.task(D2, ev({ subtype: 'task_updated', task_id: 'a', status: 'completed' }));
    expect(t.list(D2)[0]).toMatchObject({ status: 'completed', totalTokens: 1234, toolUses: 2, lastTool: 'Bash', startedAt: 1000, endedAt: 5000 });
  });

  test('§5.3 background Bash tasks (no subagent_type) and unknown task ids are ignored', () => {
    const t = new SubagentTracker(() => 0);
    expect(t.task(D2, ev({ subtype: 'task_started', task_id: 'sh1', description: 'npm run watch', owned_by_subagent: 'a' }))).toBe(false);
    expect(t.task(D2, ev({ subtype: 'task_progress', task_id: 'zz', tool_uses: 1 }))).toBe(false);
    expect(t.list(D2)).toEqual([]);
  });

  test('§4.5 failed stays until the lane turn ends; completed older than 60 s is dropped then', () => {
    let now = 0;
    const t = new SubagentTracker(() => now);
    t.task(D2, started('ok')); t.task(D2, started('bad')); t.task(D2, started('bg', { is_backgrounded: true })); t.task(D2, started('late'));
    t.task(D2, ev({ subtype: 'task_updated', task_id: 'ok', status: 'completed' }));
    t.task(D2, ev({ subtype: 'task_notification', task_id: 'bad', status: 'failed' }));
    now = 61_000;
    t.task(D2, ev({ subtype: 'task_notification', task_id: 'late', summary: 'x' })); // notification while running → completed
    expect(t.turnEnded(D2)).toBe(true);
    expect(t.list(D2).map((s) => [s.taskId, s.status])).toEqual([['bg', 'running'], ['late', 'completed']]);
    expect(t.list(D2)[0]!.background).toBe(true);
  });

  test('§5.3 W9 forProject lists every lane target of that project only', () => {
    const t = new SubagentTracker(() => 0);
    t.task(D2, started('a')); t.task(D3, started('b')); t.task(X1, started('c'));
    expect(t.forProject('p1').map((x) => x.target)).toEqual([D2, D3]);
    expect(t.forProject('p2').map((x) => x.subagents.map((s) => s.taskId))).toEqual([['c']]);
  });
});
