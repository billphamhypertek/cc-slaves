// spec v2.3 §5.1 the tree state of the shown source: lazy dir reads, open / closed per (project, source) for the session,
// the first open shows only the path to the open file. A reply for an older source / ignore setting is dropped.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FsApi } from './fs.ts';
import { ancestors, rememberedOpen, rememberOpen, withPath, type DirState, type TreeModel } from './tree-model.ts';

export interface TreeCtl {
  model: TreeModel;
  toggle: (dir: string) => void;
  /** open the dirs down to `path` (a file opened by ⌘P / a doc link) */
  reveal: (path: string) => void;
  retry: (dir: string) => void;
}

/** `memKey` = (project, source); `fs` changes with the source and the ignore setting (→ every dir is read again). */
export function useTree(fs: FsApi, memKey: string, openPath: string | null): TreeCtl {
  const [model, setModel] = useState<TreeModel>(() => ({ dirs: new Map(), open: new Set() }));
  const gen = useRef(0);
  /** dirs read (or being read) for the current source: kept by `load`, never from a render (a sync re-render from
   *  the tab controller can come before the reset below is applied and would show the old source's dirs) */
  const asked = useRef(new Set<string>());
  const load = useCallback((dir: string) => {
    const g = gen.current;
    asked.current.add(dir);
    const put = (st: DirState) => { if (g === gen.current) setModel(m => ({ ...m, dirs: new Map(m.dirs).set(dir, st) })); };
    put({ k: 'loading' });
    fs.list(dir).then(list => put({ k: 'ok', list }), () => put({ k: 'error' }));
  }, [fs]);
  useEffect(() => {
    gen.current++;
    asked.current = new Set();
    const open = rememberedOpen(memKey) ?? new Set<string>();
    setModel({ dirs: new Map(), open });
    for (const d of ['', ...open]) load(d);
  }, [memKey, load]);
  // declared after the reset: on a source switch the reset reads the new source's remembered set first, and the old set written
  // here on that commit is overwritten once the reset's new `open` lands
  useEffect(() => { rememberOpen(memKey, model.open); }, [memKey, model.open]);
  const toggle = useCallback((dir: string) => {
    setModel(m => {
      const open = new Set(m.open);
      if (open.has(dir)) open.delete(dir); else open.add(dir);
      return { ...m, open };
    });
    if (!asked.current.has(dir)) load(dir);
  }, [load]);
  const reveal = useCallback((path: string) => {
    setModel(m => { const open = withPath(m.open, path); return open ? { ...m, open } : m; });
    for (const d of ancestors(path)) if (!asked.current.has(d)) load(d);
  }, [load]);
  // §5.1 the path to the open file is open: on the first show, after tabs come back (C29), on a source switch (C28)
  useEffect(() => { if (openPath !== null) reveal(openPath); }, [memKey, openPath, reveal]);
  return { model, toggle, reveal, retry: load };
}
