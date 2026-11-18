// Hot fix 2026-11-16 (docs/ref/hf1116-ux.md): the project tab bar's pure half — which tab takes over when the active one
// closes, and the "Tất cả project (N)" filter (why "Đóng project" is blocked lives with the item, lib/actions.ts).
import type { ProjectView } from '../../../shared/protocol.ts';
import { fold } from './palette.ts';

/** The tab selected after `id` closes: its right neighbour, else its left one; null = it was the last tab. */
export function tabNeighbour(ids: readonly string[], id: string): string | null {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/** The list-all popover: projects whose name holds `q`, case- and diacritic-insensitive ("du an" finds "Dự án"). */
export function filterProjects<P extends Pick<ProjectView, 'name'>>(projects: readonly P[], q: string): P[] {
  const k = fold(q.trim());
  return k ? projects.filter(p => fold(p.name).includes(k)) : [...projects];
}

/** ↑ / ↓ in the list-all popover: wraps around; an empty list keeps 0. */
export const moveActive = (i: number, n: number, d: 1 | -1): number => (n ? (i + d + n) % n : 0);
