// Single engine instance (spec §7.1): `~/.cc-slaves/engine.lock` holds the owner pid; `engine.json` (0600) holds only
// pid, port and version — never the token (NC1).
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { FILE_MODE, writeFileSecure } from './paths.ts';

export type LockResult = { ok: true; release: () => void } | { ok: false; pid: number };

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** O_EXCL create; a lock whose pid is dead is stale and taken over (one retry, so two racers cannot both win). */
export function acquireLock(file: string, o: { alive?: (pid: number) => boolean } = {}): LockResult {
  const alive = o.alive ?? pidAlive;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', FILE_MODE);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        ok: true,
        release: () => {
          try { if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file); } catch { /* gone */ }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = Number.NaN;
      try { pid = Number(readFileSync(file, 'utf8').trim()); } catch { /* vanished: retry */ }
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return { ok: false, pid };
      try { unlinkSync(file); } catch { /* someone else removed it */ }
    }
  }
  return { ok: false, pid: Number.NaN };
}

export function writeEngineJson(file: string, info: { pid: number; port: number; version: string }): void {
  writeFileSecure(file, `${JSON.stringify({ pid: info.pid, port: info.port, version: info.version })}\n`);
}
