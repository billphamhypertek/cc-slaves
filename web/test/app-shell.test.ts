// The App shell pieces split out of AppInner (lane v21-webstd): which state mounts the lazy dialog layer, and the lines
// an opened subagent shows (F25).
import { describe, expect, test } from 'bun:test';
import type { StreamLine, SubagentView } from '../../shared/protocol.ts';
import { modalLayer } from '../src/ui/shell.ts';
import { subLinesOf } from '../src/ui/useEngineFeeds.ts';

const closed = { settingsTab: null, addOpen: false, stopLane: null, moveAll: null, palette: false, menu: null, accDlg: null };
describe('§4.12 / §5.6 the lazy dialog layer mounts only while something in it is open', () => {
  test('nothing open → not mounted (first paint never fetches the chunk through render)', () => expect(modalLayer(closed)).toBe(false));
  test('each of palette, Settings, add project, stop, move-all, the "⋯" menu and an account dialog mounts it', () => {
    for (const open of [{ palette: true }, { settingsTab: 'acc' }, { addOpen: true }, { stopLane: { projectId: 'p1', name: 'D2' } },
      { moveAll: 'a@x' }, { menu: { leaving: false } }, { accDlg: { k: 'add' } }, { sm: { tab: 'mcp' } }] as const) expect({ open, on: modalLayer({ ...closed, ...open }) }).toEqual({ open, on: true });
  });
});

describe('F25 subagent lines', () => {
  const line = (seq: number, parent?: string): StreamLine => ({ seq, ts: 0, kind: 'assistant', text: `l${seq}`, ...(parent ? { parentToolUseId: parent } : {}) });
  const sub = { taskId: 't1', toolUseId: 'tu1' } as SubagentView;
  test('history + the live lane lines it owns, one per seq, oldest first; none when no subagent is open', () => {
    const got = subLinesOf(sub, { t1: [line(3, 'tu1'), line(1, 'tu1')] }, { lines: [line(3, 'tu1'), line(2), line(5, 'tu1')] } as never);
    expect(got.map(l => l.seq)).toEqual([1, 3, 5]);
    expect(subLinesOf(null, { t1: [line(1, 'tu1')] }, undefined)).toEqual([]);
  });
});
