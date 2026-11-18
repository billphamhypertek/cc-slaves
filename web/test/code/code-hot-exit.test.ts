// spec v2.3 §5.4 / §10.1 hot exit: the unsaved buffer `{ text, baseHash, eol, bom, line, savedAt }` per (project, source,
// path) in the web's IndexedDB, written a short beat after each change and on `pagehide`; dropped on save / discard /
// a source dropped at restore; IndexedDB failing or empty only loses the buffers.
import { describe, expect, test } from 'bun:test';
import { HotExit, type HotBuf } from '../../src/code/hot-exit.ts';
import { idbKv, type Kv } from '../../src/lib/idb.ts';
import { memKv } from './mem-kv.ts';

const buf = (text: string, savedAt = 1): HotBuf => ({ text, baseHash: 'h0', eol: 'lf', bom: false, line: 4, savedAt });
/** manual timers: `run()` fires every pending debounce */
function timers() {
  const q = new Map<number, () => void>();
  let id = 0;
  return {
    set: (fn: () => void) => { q.set(++id, fn); return id; },
    clear: (n: number) => { q.delete(n); },
    run: () => { const fs = [...q.values()]; q.clear(); for (const f of fs) f(); },
    size: () => q.size,
  };
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('§10.1 IndexedDB helper', () => {
  test('§10.1 no IndexedDB (or it fails) → reads are empty and writes are no-ops, never a throw', async () => {
    const kv = idbKv(undefined);
    await kv.put('k', 1);
    expect(await kv.get('k')).toBeUndefined();
    expect(await kv.keys('')).toEqual([]);
    await kv.del('k');
    const broken = idbKv({ open: () => { throw new Error('blocked'); } } as unknown as IDBFactory);
    expect(await broken.get('k')).toBeUndefined();
  });
});

describe('§5.4 hot exit', () => {
  const mk = (kv: Kv = memKv()) => { const t = timers(); return { kv, t, he: new HotExit(kv, { set: t.set, clear: t.clear }) }; };
  test('§5.4 a change is written a short beat later (debounced: only the last text), per (project, source, path)', async () => {
    const { kv, t, he } = mk();
    he.queue('p1', 'base', 'a.ts', buf('one'));
    he.queue('p1', 'base', 'a.ts', buf('two'));
    expect(t.size()).toBe(1);
    expect(await kv.keys('')).toEqual([]);
    t.run();
    await flush();
    expect((await he.load('p1', 'base')).get('a.ts')?.text).toBe('two');
    expect((await he.load('p1', 'lane:D15')).size).toBe(0);
  });
  test('§5.4 pagehide writes what is pending at once (no dialog on quit)', async () => {
    const { t, he } = mk();
    he.queue('p1', 'base', 'a.ts', buf('typed'));
    he.flush();
    expect(t.size()).toBe(0);
    await flush();
    expect((await he.load('p1', 'base')).get('a.ts')?.text).toBe('typed');
  });
  test('§5.4 saved / "Bỏ thay đổi" / "Bỏ" → the buffer is deleted (a pending write is cancelled too)', async () => {
    const { t, he } = mk();
    he.queue('p1', 'base', 'a.ts', buf('x'));
    t.run();
    await flush();
    he.queue('p1', 'base', 'a.ts', buf('y'));
    he.drop('p1', 'base', 'a.ts');
    t.run();
    await flush();
    expect((await he.load('p1', 'base')).size).toBe(0);
  });
  test('§5.4 a source dropped at restore → every buffer of it is deleted, silently; other sources stay', async () => {
    const { he } = mk();
    he.queue('p1', 'lane:D7', 'a.ts', buf('x'));
    he.queue('p1', 'lane:D7', 'b/c.ts', buf('y'));
    he.queue('p1', 'base', 'a.ts', buf('z'));
    he.flush();
    await flush();
    await he.dropSrc('p1', 'lane:D7');
    expect((await he.load('p1', 'lane:D7')).size).toBe(0);
    expect((await he.load('p1', 'base')).size).toBe(1);
  });
  test('§10.1 a stored value that is not a buffer is ignored', async () => {
    const kv = memKv();
    await kv.put('code\np1\nbase\nx.ts', { text: 1 });
    expect((await new HotExit(kv).load('p1', 'base')).size).toBe(0);
  });
});
