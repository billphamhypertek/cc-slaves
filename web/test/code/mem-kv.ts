// An in-memory `Kv` (the IndexedDB helper's shape) for the hot-exit / Code tab tests.
import type { Kv } from '../../src/lib/idb.ts';

export function memKv(): Kv {
  const m = new Map<string, unknown>();
  return {
    get: k => Promise.resolve(m.get(k)),
    put: (k, v) => { m.set(k, v); return Promise.resolve(); },
    del: k => { m.delete(k); return Promise.resolve(); },
    keys: p => Promise.resolve([...m.keys()].filter(k => k.startsWith(p))),
  };
}
