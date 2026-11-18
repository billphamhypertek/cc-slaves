// v2.5 §5.5 D66 orphan indexes. Orphan = a `list_projects` row with a `root_path` whose directory is gone (gone.ts, the one
// test of A10). Never: a row with no root_path, a cc-slaves project root, the cwd of a lane not done yet. An index with ADRs
// goes with its directory (D68). Deleting only ever goes through `delete_project` of the tool (its own index files, by the
// name of the row) — never a file of ours — and only for roots the user saw that are still orphans at that moment.
import { gone } from './gone.ts';
import type { RunEnd } from './queue.ts';

export interface IndexRow { name: string; root_path?: string; size_bytes?: number }
export interface OrphanRules {
  home: string;
  /** Project roots + cwds of lanes not done (literal and real paths). */
  keep: ReadonlySet<string>;
}
export interface Orphans { rows: { root_path: string; bytes: number }[]; bytes: number; skipped: { n: number } }

export function orphans(list: readonly IndexRow[], k: OrphanRules): Orphans {
  const out: Orphans = { rows: [], bytes: 0, skipped: { n: 0 } };
  for (const r of list) {
    if (!r.root_path || k.keep.has(r.root_path)) continue;
    const g = gone(r.root_path, { home: k.home });
    if (g === 'unknown') out.skipped.n++;
    if (g !== 'gone') continue;
    const bytes = r.size_bytes ?? 0;
    out.rows.push({ root_path: r.root_path, bytes });
    out.bytes += bytes;
  }
  return out;
}

export interface CleanDeps {
  home: string;
  keep: () => ReadonlySet<string>;
  /** A fresh `list_projects` read (every page). */
  list: () => Promise<IndexRow[]>;
  /** The index queue: deletes wait behind a running index, one at a time. */
  queue: { remove: (name: string) => Promise<RunEnd> };
}
export interface CleanResult { deleted: number; bytes: number; failed: number; error?: string }

/** `graph_clean {roots}` and the automatic clean-up: delete the given roots that are orphans right now, one by one. */
export async function clean(roots: readonly string[], d: CleanDeps): Promise<CleanResult> {
  const list = await d.list();
  const now = new Set(orphans(list, { home: d.home, keep: d.keep() }).rows.map((r) => r.root_path));
  const out: CleanResult = { deleted: 0, bytes: 0, failed: 0 };
  for (const root of new Set(roots)) {
    if (!now.has(root)) continue;
    for (const r of list.filter((x) => x.root_path === root)) {
      const end = await d.queue.remove(r.name);
      if (end.ok) { out.deleted++; out.bytes += r.size_bytes ?? 0; continue; }
      out.failed++;
      out.error ??= end.line;
    }
  }
  return out;
}
