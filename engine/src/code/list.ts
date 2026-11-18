// v2.3 §10.2 fs_list / fs_find + §5.1 cây / ⌘P + V21: `.git` never shows; `.gitignore`d entries carry `ignored` and are
// hidden unless `showIgnored`. A project without git counts `node_modules` / `.DS_Store` as ignored. Symlinked dirs are not
// walked by find (no loops, no escape).
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FsEntry, FsFindResult, FsListResult } from '../../../shared/protocol.ts';
import { fuzzyScore } from './fuzzy.ts';
import { checkPath, forbidden, isGitSegment, relOf } from './path.ts';

const LIST_MAX = 2_000;
const FIND_MAX = 50;
/** Walk budget of one fs_find (entries visited), so a huge tree answers instead of hanging the engine. */
const FIND_WALK_MAX = 200_000;
const NO_GIT_IGNORED = new Set(['node_modules', '.DS_Store']);

export type IsIgnored = (rel: string) => boolean;

/** From the `ls-files -o -i --directory` list (dirs end in `/`): a path is ignored if it or any parent dir is listed. */
export function ignoredMatcher(list: string[] | null): IsIgnored {
  if (list === null) return (rel) => rel.split('/').some((s) => NO_GIT_IGNORED.has(s));
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const p of list) (p.endsWith('/') ? dirs : files).add(p.replace(/\/+$/, ''));
  return (rel) => {
    if (files.has(rel) || dirs.has(rel)) return true;
    for (let i = rel.indexOf('/'); i >= 0; i = rel.indexOf('/', i + 1)) if (dirs.has(rel.slice(0, i))) return true;
    return false;
  };
}

const typeOf = (d: { isDirectory(): boolean; isSymbolicLink(): boolean }): FsEntry['type'] =>
  d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file';

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);

export function listDir(root: string, dir: string, showIgnored: boolean, isIgnored: IsIgnored): FsListResult {
  const { real } = checkPath(root, dir);
  if (!statSync(real).isDirectory()) throw forbidden();
  const at = relOf(root, real);
  const entries: FsEntry[] = [];
  for (const d of readdirSync(real, { withFileTypes: true })) {
    if (isGitSegment(d.name)) continue;
    const ignored = isIgnored(at ? `${at}/${d.name}` : d.name);
    if (ignored && !showIgnored) continue;
    entries.push({ name: d.name, type: typeOf(d), size: lstatSync(join(real, d.name)).size, ignored });
  }
  entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || byName(a.name, b.name));
  return { entries: entries.slice(0, LIST_MAX), more: Math.max(0, entries.length - LIST_MAX) };
}

export function findFiles(root: string, query: string, showIgnored: boolean, isIgnored: IsIgnored): FsFindResult {
  if (!query.trim()) return { paths: [] };
  const hits: { path: string; score: number }[] = [];
  const queue = [''];
  let seen = 0;
  for (let rel = queue.shift(); rel !== undefined && seen < FIND_WALK_MAX; rel = queue.shift()) {
    let list;
    try { list = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of list) {
      seen += 1;
      if (isGitSegment(d.name)) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (!showIgnored && isIgnored(p)) continue;
      if (d.isDirectory()) { queue.push(p); continue; }
      const score = fuzzyScore(query, p);
      if (score !== null) hits.push({ path: p, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || byName(a.path, b.path));
  return { paths: hits.slice(0, FIND_MAX).map((h) => h.path) };
}
