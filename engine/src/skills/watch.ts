// v2.2 §5.5 rescan trigger: fs watch on the `skills` folders plus a cheap poll of their signature (fs.watch can stay
// silent — measured under Bun 1.3.14 — and a missing folder cannot be watched until it appears), debounced into one call.
// hf1117-perf `set` changes the folder list in place: a recursive watch start / close blocks the event loop (measured
// 110–500 ms each in e2e), so a folder still listed keeps its watcher.
import { existsSync, lstatSync, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';

type Closer = { close: () => void };
export interface SkillsWatchOpts { debounceMs?: number; pollMs?: number; watch?: (dir: string, onEvent: () => void) => Closer }
export interface SkillsWatch { set: (dirs: readonly string[]) => void; stop: () => void }

const mtime = (p: string, follow: boolean) => { try { return (follow ? statSync(p) : lstatSync(p)).mtimeMs; } catch { return -1; } };

/** Names + entry / target / SKILL.md mtimes of every folder: changes when a skill is added, removed, re-pointed or edited. */
function signature(dirs: readonly string[]): string {
  return dirs.map((d) => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return `${d}\u0001missing`; }
    return `${d}\u0001${names.map((n) => `${n}:${mtime(join(d, n), false)}:${mtime(join(d, n), true)}:${mtime(join(d, n, 'SKILL.md'), true)}`).join('\u0002')}`;
  }).join('\u0003');
}

const recursive = (dir: string, onEvent: () => void): Closer => {
  const w = watch(dir, { recursive: true }, onEvent);
  w.on('error', () => {});
  return w;
};

/** Calls `onChange` (the rescan hook) once per burst of changes; `set` replaces the folder list, `stop` ends it. */
export function watchSkillDirs(initial: readonly string[], onChange: () => void, o: SkillsWatchOpts = {}): SkillsWatch {
  let dirs: readonly string[] = [];
  let last = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watchers = new Map<string, Closer>();
  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; last = signature(dirs); onChange(); }, o.debounceMs ?? 300);
  };
  const set = (next: readonly string[]) => {
    dirs = [...next];
    for (const [d, w] of watchers) if (!dirs.includes(d)) { w.close(); watchers.delete(d); }
    for (const d of dirs) if (!watchers.has(d) && existsSync(d)) watchers.set(d, (o.watch ?? recursive)(d, bump));
    last = signature(dirs);
  };
  set(initial);
  const poll = setInterval(() => {
    const now = signature(dirs);
    if (now !== last) { last = now; bump(); }
  }, o.pollMs ?? 2000);
  return {
    set,
    stop: () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}
