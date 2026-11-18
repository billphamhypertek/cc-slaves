// spec v2.3 §5.1 the file tree of one Code source: dirs read lazily (on open), the engine's order (dirs first, by name),
// a dir over 2 000 entries shows its first 2 000 + "Còn n mục · dùng ⌘P", the first open has every dir closed except the
// path to the open file, and the open / closed state is kept per (project, source) for the session. Pure: the hook
// (`useTree.ts`) feeds it engine replies and renders `treeRows`.
import type { FsEntry, FsListResult } from '../../../shared/protocol.ts';
import { isImagePath } from '../lib/doc-links.ts';

/** a dir's contents: read, being read, or the read failed */
export type DirState = { k: 'ok'; list: FsListResult } | { k: 'loading' } | { k: 'error' };

export interface TreeModel {
  /** dir path ('' = root) → its contents */
  dirs: ReadonlyMap<string, DirState>;
  /** open dirs (root is always open) */
  open: ReadonlySet<string>;
}

export type TreeRow =
  | { k: 'entry'; path: string; name: string; depth: number; dir: boolean; open: boolean; ignored: boolean }
  | { k: 'more'; depth: number; n: number }
  | { k: 'loading'; depth: number }
  | { k: 'error'; depth: number; dir: string };

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
/** `a/b/c.ts` → ['a', 'a/b'] (the dirs to open so the file shows) */
export function ancestors(path: string): string[] {
  const seg = path.split('/');
  return seg.slice(0, -1).map((_, i) => seg.slice(0, i + 1).join('/'));
}
const isDir = (e: FsEntry) => e.type === 'dir';

/** The visible rows, depth-first, in the engine's order. */
/** §5.1 `open` plus the dirs down to `path`; null when they are all open already */
export function withPath(open: ReadonlySet<string>, path: string | null): Set<string> | null {
  const need = path === null ? [] : ancestors(path).filter(d => !open.has(d));
  return need.length ? new Set([...open, ...need]) : null;
}

export function treeRows(m: TreeModel): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const st = m.dirs.get(dir);
    if (!st || st.k === 'loading') { out.push({ k: 'loading', depth }); return; }
    if (st.k === 'error') { out.push({ k: 'error', depth, dir }); return; }
    for (const e of st.list.entries) {
      const path = join(dir, e.name), dir2 = isDir(e), open = dir2 && m.open.has(path);
      out.push({ k: 'entry', path, name: e.name, depth, dir: dir2, open, ignored: e.ignored });
      if (open) walk(path, depth + 1);
    }
    if (st.list.more > 0) out.push({ k: 'more', depth, n: st.list.more });
  };
  walk('', 0);
  return out;
}

/** ↑ / ↓ over the entry rows (other rows are skipped); no selection yet → the first / last entry. */
export function stepSel(rows: readonly TreeRow[], cur: string | null, delta: 1 | -1): string | null {
  const paths = rows.flatMap(r => (r.k === 'entry' ? [r.path] : []));
  if (!paths.length) return null;
  const i = cur === null ? -1 : paths.indexOf(cur);
  if (i < 0) return delta > 0 ? paths[0]! : paths[paths.length - 1]!;
  return paths[Math.min(paths.length - 1, Math.max(0, i + delta))]!;
}

/** what a tree key reaches: the preview tab, a dir's open state, the row to focus */
export interface RowHandlers { open: (path: string) => void; toggle: (dir: string) => void; focus: (path: string | null) => void }
/** §5.1 / §10.1 a key on a focused entry row: Enter opens a file (preview tab) or toggles a dir; ↑↓ step over `rows`;
 *  → opens / ← closes a dir (a file, or a dir already so: taken, nothing done). true = taken (the caller prevents the
 *  default so Enter never reaches the composer); false = not a tree key (typing, ⌘P fall through). */
export function rowKey(key: string, row: Extract<TreeRow, { k: 'entry' }>, rows: readonly TreeRow[], h: RowHandlers): boolean {
  if (key === 'ArrowDown' || key === 'ArrowUp') h.focus(stepSel(rows, row.path, key === 'ArrowDown' ? 1 : -1));
  else if (key === 'Enter') { if (row.dir) h.toggle(row.path); else h.open(row.path); }
  else if (key === 'ArrowRight' || key === 'ArrowLeft') { if (row.dir && (key === 'ArrowRight') !== row.open) h.toggle(row.path); }
  else return false;
  return true;
}

/** v2.7 §4.10 ← / → on an image open in Code: the previous / next image of its folder (`entries` of that folder, engine order);
 *  null at either end or when `cur` is not one of them. */
export function stepImage(dir: string, entries: readonly FsEntry[], cur: string, delta: 1 | -1): string | null {
  const imgs = entries.filter(e => !isDir(e) && isImagePath(e.name)).map(e => join(dir, e.name));
  const i = imgs.indexOf(cur);
  return i < 0 ? null : imgs[i + delta] ?? null;
}

/** §5.1 the open / closed dirs per (project, source), for the session only (module memory, not storage). */
const SESSION_OPEN = new Map<string, Set<string>>();
/** the remembered open set of `key`, or `null` the first time (→ open only the path to the open file). */
export const rememberedOpen = (key: string): Set<string> | null => SESSION_OPEN.get(key) ?? null;
export const rememberOpen = (key: string, open: ReadonlySet<string>): void => { SESSION_OPEN.set(key, new Set(open)); };
