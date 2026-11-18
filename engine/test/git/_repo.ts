// Real git repos in a temp dir for the v2.3 §10.2 runner tests. The PO's global / system git config never leaks in:
// every spawn (the fixture's and the runner's via `execIn(process.env)`) sees `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`.
import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

export function sh(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: ENV });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}
export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
export function commit(cwd: string, file: string, body: string, msg = file): void {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-q', '-m', msg);
}

export interface Fixture { root: string; repo: string; traps: string; done(): void }
/** `<root>/repo` on `main` with one commit (README); `<root>/traps` collects `hit-<name>` files. */
export function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-git-')));
  const repo = join(root, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo], { env: ENV });
  Bun.spawnSync(['mkdir', join(root, 'traps')]);
  commit(repo, 'README', 'base\n');
  return { root, repo, traps: join(root, 'traps'), done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A program that leaves `hit-<name>` in the trap dir, then behaves like `cat` (filters / textconv) or exits `code`. */
export function trap(f: Fixture, name: string, tail = 'cat "$@"'): string {
  const p = join(f.root, `prog-${name}.sh`);
  writeFileSync(p, `#!/bin/sh\ntouch '${f.traps}/hit-${name}'\n${tail}\n`);
  chmodSync(p, 0o755);
  return p;
}
export const hits = (f: Fixture): string[] => readdirSync(f.traps).filter((n) => n.startsWith('hit-'));

/** Loose objects of the repo's object store (merge-tree must not add any). */
export function looseObjects(repo: string): number {
  return Number(/count: (\d+)/.exec(git(repo, 'count-objects', '-v'))?.[1] ?? -1);
}
