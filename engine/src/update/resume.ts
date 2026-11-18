// v2.6 §5.5-4 (R22) `~/.cc-slaves/update-resume.json`: a successful `update_commit` records the projects not held at
// that moment; the next boot wakes exactly those (`held.wakeAfterUpdate`) when the file is ≤ 10 min old, then deletes
// it. Any other restart (crash, Thử lại) finds no file and keeps every project held as usual.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export const RESUME_MAX_AGE_MS = 10 * 60_000;

export interface UpdateResume { from: string; at: number; projects: string[] }

/** Temp file + rename: a reader never sees half a file. */
export function writeResume(path: string, r: UpdateResume): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
  renameSync(tmp, path);
}

/** The projects to wake (fresh, well-formed file) or []; the file is gone afterwards either way. */
export function takeResume(path: string, nowMs: number): string[] {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  rmSync(path, { force: true });
  try {
    const r = JSON.parse(raw) as Partial<UpdateResume>;
    const ok = typeof r.at === 'number' && Array.isArray(r.projects) && r.projects.every((p) => typeof p === 'string');
    return ok && Math.abs(nowMs - r.at!) <= RESUME_MAX_AGE_MS ? r.projects! : [];
  } catch { return []; }
}
