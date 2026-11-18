// v2.2 §5.2 per-server proxy log: a 200-line ring in memory, mirrored to `~/.cc-slaves/logs/mcp-<id>.log` (0600).
// A line carries method, path, status, ms and an error code — never a body, never an auth header (the caller only
// hands those four fields over). G4a / G6 read it through `lines(id)` (K2 "Xem log").
import { appendFileSync, chmodSync } from 'node:fs';
import { ensureDir, FILE_MODE, paths, writeFileSecure } from '../paths.ts';
import { dirname } from 'node:path';

/** Why a request did not reach / came back from upstream normally (the UI maps the code to text). */
export type ProxyError = 'timeout' | 'network' | 'endpoint_foreign' | 'not_allowed' | 'unknown_server' | 'needs_login' | 'insufficient_scope';

export interface ProxyLogLine { at: number; method: string; path: string; status: number; ms: number; error?: ProxyError }

export const LOG_RING = 200;

export class ProxyLog {
  private readonly rings = new Map<string, ProxyLogLine[]>();
  /** Lines appended to the file since it was last rewritten from the ring (keeps the file ≤ 2 × LOG_RING lines). */
  private readonly appended = new Map<string, number>();

  add(id: string, line: ProxyLogLine): void {
    const ring = this.rings.get(id) ?? [];
    ring.push(line);
    if (ring.length > LOG_RING) ring.splice(0, ring.length - LOG_RING);
    this.rings.set(id, ring);
    try { this.toFile(id, line, ring); } catch { /* a full / read-only disk never breaks the proxy */ }
  }

  lines(id: string): readonly ProxyLogLine[] { return this.rings.get(id) ?? []; }

  private toFile(id: string, line: ProxyLogLine, ring: readonly ProxyLogLine[]): void {
    const file = paths().mcpLog(id);
    const n = (this.appended.get(id) ?? LOG_RING) + 1;
    if (n > LOG_RING) {
      writeFileSecure(file, ring.map((l) => `${JSON.stringify(l)}\n`).join(''));
      this.appended.set(id, 0);
      return;
    }
    ensureDir(dirname(file));
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: FILE_MODE });
    chmodSync(file, FILE_MODE);
    this.appended.set(id, n);
  }
}
