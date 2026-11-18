// v2.5 §5.3 the graph tool (codebase-memory-mcp): where it is, which version, which state. One path serves every spawn
// (A1): the login PATH, else the installer's default `~/.local/bin`. `--version` is re-read only when the file changed
// (the user updated it in a terminal). The tool itself is never run by tests (Z5): they put `fake-cbm` on the PATH.
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { below, GRAPH_NAME, MIN_GRAPH_VERSION } from '../../../shared/graph.ts';
import { findOnPath, stripEnv, type Env } from '../session/env.ts';

const VERSION_TIMEOUT_MS = 10_000;

export type ToolRead =
  | { state: 'missing' }
  | { state: 'old' | 'ready'; path: string; version: string }
  | { state: 'error'; path: string; line: string };

/** A1 the env of every graph spawn: the login env without CLAUDE_CONFIG_DIR (stripEnv) and without CBM_CACHE_DIR. */
export function graphEnv(login: Env): Env {
  const env = stripEnv(login);
  delete env.CBM_CACHE_DIR;
  return env;
}

function findTool(env: Env): string | null {
  const onPath = findOnPath(GRAPH_NAME, env.PATH);
  if (onPath) return onPath;
  if (!env.HOME) return null;
  const local = join(env.HOME, '.local', 'bin', GRAPH_NAME);
  try { accessSync(local, constants.X_OK); return local; } catch { return null; }
}

async function runVersion(path: string, env: Env): Promise<string> {
  const p = Bun.spawn([path, '--version'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env });
  const timer = setTimeout(() => p.kill('SIGKILL'), VERSION_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error((err.trim() || out.trim()).split('\n').at(-1) || `exit ${code}`);
  return out;
}

export interface GraphToolOptions {
  /** The login env (graphEnv() is applied here). */
  env: Env;
  /** @internal test seam: `<path> --version` output (default: spawns the file). */
  versionOf?: (path: string, env: Env) => Promise<string>;
}

export class GraphTool {
  readonly env: Env;
  private last: { key: string; read: ToolRead } | null = null;

  constructor(private readonly o: GraphToolOptions) { this.env = graphEnv(o.env); }

  /** §5.3 the state now; `--version` runs only when the path or the file (inode, size, mtime) changed since the last read. */
  async read(): Promise<ToolRead> {
    const path = findTool(this.env);
    if (!path) { this.last = null; return { state: 'missing' }; }
    let key: string;
    try { const s = statSync(path); key = `${path}\u0000${s.ino}\u0000${s.size}\u0000${s.mtimeMs}`; } catch { return { state: 'missing' }; }
    if (this.last?.key === key) return this.last.read;
    let read: ToolRead;
    try {
      const out = await (this.o.versionOf ?? runVersion)(path, this.env);
      const version = /\d+\.\d+\.\d+/.exec(out)?.[0];
      read = version
        ? { state: below(version, MIN_GRAPH_VERSION) ? 'old' : 'ready', path, version }
        : { state: 'error', path, line: out.trim().split('\n').at(-1) ?? '' };
    } catch (e) {
      read = { state: 'error', path, line: e instanceof Error ? e.message : String(e) };
    }
    this.last = read.state === 'error' ? null : { key, read }; // a failed `--version` is asked again next time
    return read;
  }
}
