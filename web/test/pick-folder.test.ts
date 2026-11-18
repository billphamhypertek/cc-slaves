// Hot fix 2026-11-17: the folder panel — the app's own `pick_folder` inside the Mac app (its answer, `null` = cancelled,
// never falls back), the engine's `folder_pick` in a plain browser.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Command } from '../../shared/protocol.ts';
import { pickFolder } from '../src/lib/pick-folder.ts';

const g = globalThis as { window?: unknown };
afterEach(() => { delete g.window; });

const engine = (path: string | null) => {
  const sent: Command[] = [];
  return { sent, send: (c: Command) => { sent.push(c); return Promise.resolve({ path }); } };
};
const inApp = (answer: string | null) => {
  const calls: [string, unknown][] = [];
  g.window = { __TAURI__: { core: { invoke: (cmd: string, args: unknown) => { calls.push([cmd, args]); return Promise.resolve(answer); } } } };
  return calls;
};

describe('pickFolder', () => {
  test('Mac app: the native panel answers, with the prompt; the engine is not asked', async () => {
    const calls = inApp('/Users/po/shop');
    const e = engine('/elsewhere');
    expect(await pickFolder(e.send, 'Chọn thư mục dự án')).toBe('/Users/po/shop');
    expect(calls).toEqual([['pick_folder', { message: 'Chọn thư mục dự án' }]]);
    expect(e.sent).toEqual([]);
  });

  test('Mac app: cancel is null, not a fall back to the engine panel', async () => {
    inApp(null);
    const e = engine('/elsewhere');
    expect(await pickFolder(e.send, 'x')).toBeNull();
    expect(e.sent).toEqual([]);
  });

  test('plain browser: the engine folder_pick', async () => {
    g.window = {};
    const e = engine('/Users/po/plain');
    expect(await pickFolder(e.send, 'x')).toBe('/Users/po/plain');
    expect(e.sent).toEqual([{ cmd: 'folder_pick' }]);
  });
});
