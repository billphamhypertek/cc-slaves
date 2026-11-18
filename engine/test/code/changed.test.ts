import { describe, expect, test } from 'bun:test';
import { ToolWatch } from '../../src/code/changed.ts';
import type { StreamEvent } from '../../src/stream/parser.ts';

const msg = (kind: 'assistant' | 'user', content: unknown[]): StreamEvent =>
  ({ kind, uuid: null, sessionId: 's', parentToolUseId: null, isReplay: false, message: { content }, raw: {} });
const use = (id: string, name: string, input: Record<string, unknown>) => msg('assistant', [{ type: 'tool_use', id, name, input }]);
const done = (id: string) => msg('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

describe('§10.2 code_changed (a) / (d) from the stream', () => {
  test('§10.2 (a) Edit / Write / MultiEdit / NotebookEdit → their file, only when the tool_result arrives', () => {
    const w = new ToolWatch();
    expect(w.event('s', use('t1', 'Edit', { file_path: '/r/a.ts' }))).toEqual([]);
    w.event('s', use('t2', 'Write', { file_path: '/r/b.ts' }));
    w.event('s', use('t3', 'MultiEdit', { file_path: '/r/c.ts' }));
    w.event('s', use('t4', 'NotebookEdit', { notebook_path: '/r/n.ipynb' }));
    expect(w.event('s', done('t1'))).toEqual([{ files: ['/r/a.ts'] }]);
    expect(w.event('s', msg('user', [{ type: 'tool_result', tool_use_id: 't2' }, { type: 'tool_result', tool_use_id: 't3' }, { type: 'tool_result', tool_use_id: 't4' }])))
      .toEqual([{ files: ['/r/b.ts'] }, { files: ['/r/c.ts'] }, { files: ['/r/n.ipynb'] }]);
    expect(w.event('s', done('t1'))).toEqual([]); // once
  });

  test('§10.2 (d) Bash → no paths (any file); Read / Grep → nothing', () => {
    const w = new ToolWatch();
    w.event('s', use('b', 'Bash', { command: 'git commit -am x' }));
    w.event('s', use('r', 'Read', { file_path: '/r/a.ts' }));
    expect(w.event('s', msg('user', [{ type: 'tool_result', tool_use_id: 'r' }, { type: 'tool_result', tool_use_id: 'b' }]))).toEqual([{ files: null }]);
  });

  test('§10.2 tool ids are per session; a result ends what is still open', () => {
    const w = new ToolWatch();
    w.event('s1', use('x', 'Edit', { file_path: '/a' }));
    expect(w.event('s2', done('x'))).toEqual([]);
    w.event('s1', { kind: 'result' } as StreamEvent);
    expect(w.event('s1', done('x'))).toEqual([]);
  });
});
