// spec v2.3 §10.1 a tiny key-value store over the web's IndexedDB (one database, one object store). Every failure — no
// IndexedDB, blocked, quota, a broken database — resolves to "nothing stored" / a no-op: the caller only loses what it
// kept there, the app runs as usual.
export interface Kv {
  get: (k: string) => Promise<unknown>;
  put: (k: string, v: unknown) => Promise<void>;
  del: (k: string) => Promise<void>;
  /** every key starting with `prefix` */
  keys: (prefix: string) => Promise<string[]>;
}

const STORE = 'kv';
const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error ?? new Error('IndexedDB')); });

/** `factory` = `indexedDB` (absent → every call is a no-op). */
export function idbKv(factory: IDBFactory | undefined = globalThis.indexedDB, name = 'cc-slaves'): Kv {
  let db: Promise<IDBDatabase | null> | null = null;
  const open = (): Promise<IDBDatabase | null> => (db ??= new Promise<IDBDatabase | null>(ok => {
    try {
      if (!factory) { ok(null); return; }
      const r = factory.open(name, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
      r.onblocked = () => ok(null);
    } catch { ok(null); }
  }));
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>, none: T): Promise<T> => {
    try {
      const d = await open();
      return d ? await req(f(d.transaction(STORE, mode).objectStore(STORE))) : none;
    } catch { return none; }
  };
  return {
    get: k => run<unknown>('readonly', s => s.get(k), undefined),
    put: async (k, v) => { await run<IDBValidKey>('readwrite', s => s.put(v, k), ''); },
    del: async k => { await run<undefined>('readwrite', s => s.delete(k), undefined); },
    keys: async p => (await run<IDBValidKey[]>('readonly', s => s.getAllKeys(), [])).filter((k): k is string => typeof k === 'string' && k.startsWith(p)),
  };
}
