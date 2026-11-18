// Shared fixtures for the v2.3 Code fs tests: a temp project dir + fake deps (no real home, no git unless a test builds one).
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodeFs, type CodeFsDeps, type LockState } from '../../src/code/fs.ts';

export const tmp = (p = 'ccs-code-') => realpathSync.native(mkdtempSync(join(tmpdir(), p)));

export interface Fixture { dir: string; lanes: Record<string, string>; lock: LockState; ignored: string[] | null; worktrees: string[] }

/** A project `p1` at `dir`; lanes map name → cwd; `worktrees` = what `git worktree list` would say. */
export function fixture(dir = tmp()): Fixture {
  return { dir, lanes: {}, lock: { lanes: [], orchestrator: 'idle' }, ignored: [], worktrees: [dir] };
}

function depsOf(f: Fixture): CodeFsDeps {
  return {
    projectDir: (id) => (id === 'p1' ? f.dir : null),
    laneCwd: (_id, name) => f.lanes[name] ?? null,
    worktreeRoots: () => Promise.resolve(f.worktrees),
    ignored: () => Promise.resolve(f.ignored),
    lockState: () => f.lock,
  };
}

export const codeFs = (f: Fixture) => createCodeFs(depsOf(f));
export const BASE = { kind: 'base' } as const;

/** Resolves to the error code a promise rejects with ('' when it resolves). */
export async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return ''; } catch (e) { return (e as { code?: string }).code ?? String(e); }
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
