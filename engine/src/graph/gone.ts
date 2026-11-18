// v2.5 §5.5 the one "directory is gone" test, for the automatic clean-up and the "Dọn" button alike (A10). Gone ⇔ all of:
// 1. lstat(root) fails with exactly ENOENT or ENOTDIR (any other code, e.g. EACCES under a locked parent, = unknown);
// 2. the nearest existing ancestor directory can be listed;
// 3. neither the literal root nor that ancestor's real path is on external storage: under ~/Library/CloudStorage/ always
//    unknown (a Drive folder not downloaded looks deleted); under /Volumes/<name> only when <name> is a real mount point.
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

export type GoneCheck = 'gone' | 'present' | 'unknown';

export interface GoneOptions {
  home: string;
  /** @internal test seam: the volumes root (default `/Volumes`). */
  volumes?: string;
  /** @internal test seam: st_dev of a path (default statSync). */
  devOf?: (path: string) => number;
}

const code = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? '';
const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + sep);

/** The nearest existing ancestor directory of `p` (symlinks followed; walks up past a file standing where a directory was). */
function ancestor(p: string): string | null {
  for (let d = dirname(p); ; d = dirname(d)) {
    try { if (statSync(d).isDirectory()) return d; } catch (e) { if (code(e) !== 'ENOENT' && code(e) !== 'ENOTDIR') return null; }
    if (dirname(d) === d) return null;
  }
}

function external(p: string, o: GoneOptions): boolean {
  if (under(p, join(o.home, 'Library', 'CloudStorage'))) return true;
  const vols = o.volumes ?? '/Volumes';
  if (!under(p, vols) || p === vols) return false;
  const name = p.slice(vols.length + 1).split(sep)[0]!;
  const dev = o.devOf ?? ((x: string) => statSync(x).dev);
  try { return dev(join(vols, name)) === dev(vols); } catch { return true; } // a volume not mounted
}

export function gone(root: string, o: GoneOptions): GoneCheck {
  try { lstatSync(root); return 'present'; } catch (e) { if (code(e) !== 'ENOENT' && code(e) !== 'ENOTDIR') return 'unknown'; }
  const up = ancestor(root);
  if (up === null) return 'unknown';
  let real: string;
  try { readdirSync(up); real = realpathSync(up); } catch { return 'unknown'; }
  return external(root, o) || external(real, o) ? 'unknown' : 'gone';
}
