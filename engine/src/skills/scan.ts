// v2.2 §5.5 the disk side of the skills catalog: reads the three `skills` folders into a `SkillScan` (catalog.ts is pure).
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ScanEntry, SkillScan, SkillScope } from './catalog.ts';

/** Every skills fs op takes these roots (tests pass temp dirs): the user's home and the Claude config dir. */
export interface SkillRoots { home: string; claudeHome: string }

export interface ScanInput {
  /** Every added project (id, display name, root). */
  projects: readonly { id: string; name: string; path: string }[];
  /** Enabled plugins: `<plugin>@<marketplace>` + its `installPath` (installed_plugins.json, §3-8). */
  plugins: readonly { id: string; installPath: string }[];
}

export const userSkillsDir = (r: SkillRoots): string => join(r.claudeHome, 'skills');

const realOrNull = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

function readEntry(scope: SkillScope, owner: string | null, folder: string, dir: string): ScanEntry | null {
  const path = join(folder, dir);
  const st = lstatSync(path);
  const isLink = st.isSymbolicLink();
  if (!isLink && !st.isDirectory()) return null;
  const real = realOrNull(path);
  const link = isLink ? { target: resolve(dirname(path), readlinkSync(path)), broken: real === null } : null;
  if (real !== null && !lstatSync(real).isDirectory()) return null;
  const md = real === null ? null : join(real, 'SKILL.md');
  const skillMd = md !== null && existsSync(md) ? readFileSync(md, 'utf8') : null;
  return { scope, owner, dir, path, link, real, skillMd };
}

function readFolder(scope: SkillScope, owner: string | null, folder: string): ScanEntry[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).sort().filter((d) => !d.startsWith('.')).flatMap((d) => readEntry(scope, owner, folder, d) ?? []);
}

/** §5.5 one scan (boot, fs watch of the `skills` folders, after a Claude Code update). */
export function scanSkills(r: SkillRoots, input: ScanInput): SkillScan {
  const user = userSkillsDir(r);
  const userReal = realOrNull(user);
  // A project whose `.claude/skills` is the user folder itself (project `~`) lists nothing twice: #109687 flags it.
  const projectFolder = (p: { path: string }) => join(p.path, '.claude', 'skills');
  return {
    home: realOrNull(r.home) ?? r.home,
    userSkillsReal: userReal,
    projects: input.projects.flatMap((p) => { const real = realOrNull(p.path); return real ? [{ id: p.id, name: p.name, real }] : []; }),
    entries: [
      ...readFolder('user', null, user),
      ...input.projects.filter((p) => userReal === null || realOrNull(projectFolder(p)) !== userReal)
        .flatMap((p) => readFolder('project', p.id, projectFolder(p))),
      ...input.plugins.flatMap((p) => readFolder('plugin', p.id, join(p.installPath, 'skills'))),
    ],
  };
}
