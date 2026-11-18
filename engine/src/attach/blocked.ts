// v2.4 §10.2 A9 blocked roots: one check shared by `send` `path` items and `POST /attach/path`.
// R4: the PO's path may sit behind a macOS TCC prompt, so it is only ever touched async; the roots are ours (sync is fine).
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { paths } from '../paths.ts';

export type PathCheck = { ok: true; real: string } | { ok: false; reason: 'blocked' | 'not_found' };

/** Real path when it exists; a missing root holds nothing, so its resolved form is enough. */
function real(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

/** APFS is case-insensitive and stores either Unicode form: compare folded. */
const fold = (p: string): string => p.normalize('NFC').toLowerCase();

function inside(child: string, root: string): boolean {
  const c = fold(child);
  const r = fold(root).replace(/\/+$/, '');
  return c === r || c.startsWith(r + sep);
}

/** Absolute, existing, and its realpath outside the cc-slaves data dir, `~/.cloudflared` and the accounts root. */
export async function checkPath(p: string): Promise<PathCheck> {
  if (typeof p !== 'string' || !isAbsolute(p)) return { ok: false, reason: 'blocked' };
  const { home, cloudflaredDir, accountsRoot } = paths();
  const roots = [home, cloudflaredDir, accountsRoot];
  const hit = (q: string): boolean => roots.some((r) => inside(q, real(r)) || inside(q, resolve(r)));
  if (hit(resolve(p))) return { ok: false, reason: 'blocked' };
  let target: string;
  try { target = await realpath(p); } catch { return { ok: false, reason: 'not_found' }; }
  return hit(target) ? { ok: false, reason: 'blocked' } : { ok: true, real: target };
}
