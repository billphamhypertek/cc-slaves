// v2.5 §5.5 "Cần dựng lại" (orchestrator ruling 18/11 07:05): 0.12.1 `index_status` never says stale, so a project's index
// is stale when its git HEAD commit is newer than the index's `indexed_at`. Per refresh: one `git rev-parse` (git or not +
// the git dir); `git log -1 --format=%ct` only when the git dir's HEAD / logs/HEAD changed mtime since the last read.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec } from '../setup/setup.ts';

export interface GitHead { git: boolean; /** epoch ms of the HEAD commit (absent: no commit / unreadable). */ at?: number }

const mtime = (f: string): number => { try { return statSync(f).mtimeMs; } catch { return 0; } };

export class GitHeads {
  private readonly cache = new Map<string, { key: string; at?: number }>();

  constructor(private readonly exec: Exec) {}

  async read(root: string): Promise<GitHead> {
    try {
      const r = await this.exec(['git', '-C', root, 'rev-parse', '--is-inside-work-tree', '--absolute-git-dir'], { timeoutMs: 10_000 });
      const [inside, gitDir] = r.stdout.trim().split('\n');
      // a failed rev-parse / log prints nothing on stdout: the exit code adds nothing
      if (inside !== 'true' || !gitDir) return { git: false };
      const key = `${gitDir}:${mtime(join(gitDir, 'HEAD'))}:${mtime(join(gitDir, 'logs', 'HEAD'))}`;
      const hit = this.cache.get(root);
      if (hit?.key === key) return { git: true, ...(hit.at !== undefined ? { at: hit.at } : {}) };
      const l = await this.exec(['git', '-C', root, 'log', '-1', '--format=%ct'], { timeoutMs: 10_000 });
      const ct = l.stdout.trim();
      const at = /^\d+$/.test(ct) ? Number(ct) * 1000 : undefined;
      this.cache.set(root, { key, ...(at !== undefined ? { at } : {}) });
      return { git: true, ...(at !== undefined ? { at } : {}) };
    } catch { return { git: false }; }
  }
}
