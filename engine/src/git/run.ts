// spec v2.3 §10.2 "Runner git": the one door for every read-only git call of the engine (v2.3 and the v2.1 branch
// measure). It owns the allowlist, the global and per-subcommand flags, `--end-of-options` / `--`, full `refs/heads/<name>`
// refs from engine-known names only, the commit regex, one time budget per `Git`, and the config scan that refuses a repo
// whose local / worktree config runs a program. A git failure is a result (`unknown`), never a throw; only a programming
// error (a subcommand outside the allowlist, a bad flag) throws. The write path of `lane/continue.ts` does not come here.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Exec } from '../setup/setup.ts';

export const GIT_TIMEOUT_MS = 5_000;
const CONFIG_TTL_MS = 60_000;

/** Always first: no lock files, literal pathspecs, no fsmonitor / hooks / transports. Never `--attr-source` (V24). */
const GLOBAL = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never'];
const NO_PROG = ['--no-ext-diff', '--no-textconv'];
const SUBS = {
  'ls-files': [], 'ls-tree': [], 'cat-file': [], show: [...NO_PROG, '--no-show-signature'], diff: NO_PROG,
  log: [...NO_PROG, '--no-show-signature'], 'rev-list': [], 'rev-parse': [], 'symbolic-ref': [], 'for-each-ref': [],
  'merge-base': [], 'merge-tree': ['--write-tree'], status: ['--porcelain', '--ignore-submodules=all'], 'worktree list': [],
  'config --show-scope --list': [],
} satisfies Record<string, string[]>;
type GitSub = Exclude<keyof typeof SUBS, 'config --show-scope --list'>;

/** A revision, rendered by the runner: branches as `refs/heads/<name>`, commits checked, nothing free-form. */
type Rev =
  | { branch: string; peel?: 'commit' | 'tree' }
  | { remote: string } // refs/remotes/origin/<name>
  | { commit: string; peel?: 'commit' | 'tree'; path?: string }
  | { range: readonly [Rev, Rev]; dots: '..' | '...' }
  | { fixed: 'HEAD' | 'refs/remotes/origin/HEAD' | 'refs/heads/' };

export interface GitCall { sub: GitSub; flags?: readonly string[]; revs?: readonly Rev[]; paths?: readonly string[]; env?: Record<string, string> }
export type GitFailure = { kind: 'unknown'; reason: string; program?: string } | { kind: 'forbidden'; reason: string };
export type GitResult = { kind: 'ok'; code: number; stdout: string; stderr: string } | GitFailure;

export interface GitOpts {
  exec: Exec; timeoutMs?: number; branches?: Iterable<string>; now?: () => number;
  /** `false` skips the config scan: only for calls that never run a filter / driver (`worktree list`, `ls-files -o -i`)
   * on behalf of the `fs_*` commands, which use no program-running git (§10.2, spec review IMPORTANT-1). */
  scan?: false;
}
export interface Git {
  /** The `-C` of every call: the project dir, or the source dir for `status` of `{ dirty: src }`. */
  readonly dir: string;
  run(call: GitCall): Promise<GitResult>;
  /** Add an engine-known branch name (the base branch read from git itself). */
  know(name: string): void;
}

const COMMIT = /^[0-9a-f]{7,40}$/;
// git-check-ref-format, plus: never an option, never whitespace / control.
const BAD_NAME = /(^-)|(^\/)|(\/$)|(\.\.)|(\/\/)|(@\{)|(\.lock$)|(^@$)|[\s~^:?*[\\]/;
const badName = (n: string) => BAD_NAME.test(n) || [...n].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const FLAG = /^(-[\w-]+(=.*)?|blob|tree|commit)$/s; // flags are code literals; a value never starts a new arg

const forbidden = (reason: string): GitFailure => ({ kind: 'forbidden', reason });

function render(r: Rev, known: Set<string>): string | GitFailure {
  const peel = (s: string, p?: 'commit' | 'tree') => (p ? `${s}^{${p}}` : s);
  const name = (n: string) => !badName(n) && known.has(n);
  if ('fixed' in r) return r.fixed;
  if ('branch' in r) return name(r.branch) ? peel(`refs/heads/${r.branch}`, r.peel) : forbidden(`branch ${JSON.stringify(r.branch)}`);
  if ('remote' in r) return name(r.remote) ? `refs/remotes/origin/${r.remote}` : forbidden(`branch ${JSON.stringify(r.remote)}`);
  if ('commit' in r) {
    if (!COMMIT.test(r.commit)) return forbidden(`commit ${JSON.stringify(r.commit)}`);
    if (r.path === undefined) return peel(r.commit, r.peel);
    return badPath(r.path) ? forbidden(`path ${JSON.stringify(r.path)}`) : `${r.commit}:${r.path}`;
  }
  const a = render(r.range[0], known), b = render(r.range[1], known);
  if (typeof a !== 'string') return a;
  if (typeof b !== 'string') return b;
  return `${a}${r.dots}${b}`;
}
const badPath = (p: string) => p === '' || p.startsWith('/') || p.includes('\0');

/** Local / worktree keys that make git run a program (§10.2); `include.path` files report as `local`. */
const PROGRAM_KEY = [/^filter\..+\.(clean|smudge|process)$/, /^merge\..+\.driver$/, /^diff\..+\.(command|textconv)$/, /^diff\.external$/, /^gpg\.program$/, /^gpg\..+\.program$/];
interface Scan { at: number; program: string | null; perDir: boolean }
/** `-C` dir → realpath of its `--git-common-dir`: every worktree of a repo shares one local config (review MINOR-3). */
const commons = new Map<string, string>();
/** Keyed by the common dir; `<common>\0<dir>` per dir once the repo turns on `extensions.worktreeConfig`. */
const scans = new Map<string, Scan>();

/** Forget the config scan of `dir`'s repo, every worktree of it (all repos when omitted or unknown): `code_changed`
 * (§10.2 "cache tới khi code_changed / 60 s"). */
export function invalidateGitConfig(dir?: string): void {
  const common = dir === undefined ? undefined : commons.get(dir);
  if (common === undefined) { scans.clear(); commons.clear(); return; }
  for (const k of [...scans.keys()]) if (k === common || k.startsWith(`${common}\0`)) scans.delete(k);
}

/** `-z` output: `scope NUL key LF value NUL` … → the first program key of scope local / worktree, and whether the repo
 * reads worktree-scope config (then the result differs per worktree). */
function parseScan(out: string): { program: string | null; perDir: boolean } {
  const parts = out.split('\0');
  let program: string | null = null, perDir = false;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!, key = parts[i + 1]!.split('\n')[0]!;
    if (scope !== 'local' && scope !== 'worktree') continue;
    const k = key.toLowerCase();
    if (k === 'extensions.worktreeconfig') perDir = true;
    if (program === null && PROGRAM_KEY.some((re) => re.test(k))) program = key;
  }
  return { program, perDir };
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';
const TIMEOUT = Symbol('timeout');

/** A runner for one dir and one time budget (`timeoutMs`, default 5 s, shared by every call of this `Git`). */
export function gitAt(dir: string, o: GitOpts): Git {
  const deadline = Date.now() + (o.timeoutMs ?? GIT_TIMEOUT_MS);
  const known = new Set(o.branches ?? []);
  const now = o.now ?? Date.now;

  async function exec(argv: string[], env?: Record<string, string>): Promise<GitResult> {
    const left = deadline - Date.now();
    if (left <= 0) return { kind: 'unknown', reason: 'timeout' };
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const r = await Promise.race([
        o.exec(['git', ...GLOBAL, '-C', dir, ...argv], { timeoutMs: left, ...(env ? { env } : {}) }),
        new Promise<typeof TIMEOUT>((res) => { timer = setTimeout(() => res(TIMEOUT), left); }),
      ]);
      return r === TIMEOUT ? { kind: 'unknown', reason: 'timeout' } : { kind: 'ok', ...r };
    } catch (err) {
      return { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) };
    } finally { if (timer) clearTimeout(timer); }
  }

  const fresh = (e: Scan | undefined): e is Scan => e !== undefined && now() - e.at < CONFIG_TTL_MS;

  async function commonDir(): Promise<string | GitFailure> {
    const known = commons.get(dir);
    if (known !== undefined) return known;
    const r = okOut(await exec(['rev-parse', '--git-common-dir']));
    if (!('out' in r)) return r;
    const p = resolve(dir, r.out.trim());
    let real: string;
    try { real = realpathSync.native(p); } catch { real = p; }
    commons.set(dir, real);
    return real;
  }

  async function scan(): Promise<GitFailure | null> {
    const common = await commonDir();
    if (typeof common !== 'string') return common;
    const shared = scans.get(common);
    let hit = fresh(shared) ? (shared.perDir ? scans.get(`${common}\0${dir}`) : shared) : undefined;
    if (!fresh(hit)) {
      const r = okOut(await exec(['config', '--show-scope', '--list', '-z']));
      if (!('out' in r)) return r;
      hit = { at: now(), ...parseScan(r.out) };
      scans.set(common, hit);
      if (hit.perDir) scans.set(`${common}\0${dir}`, hit);
    }
    return hit.program === null ? null : { kind: 'unknown', reason: `repo configures a program (${hit.program})`, program: hit.program };
  }

  return {
    dir,
    know: (name) => { known.add(name); },
    async run(call) {
      const base = (SUBS as Record<string, string[]>)[call.sub];
      if (!base || call.sub === ('config --show-scope --list' as string)) throw new Error(`git ${call.sub}: not allowlisted`);
      const flags = call.flags ?? [];
      for (const fl of flags) if (!FLAG.test(fl)) throw new Error(`git ${call.sub}: bad flag ${JSON.stringify(fl)}`);
      // measured: plain `rev-parse --end-of-options X` echoes `--end-of-options` on stdout
      if (call.sub === 'rev-parse' && call.revs?.length && !flags.includes('--verify')) throw new Error('git rev-parse <rev>: needs --verify');
      if (call.sub === 'diff' && !flags.some((fl) => fl === '--name-status' || fl === '--numstat')) throw new Error('git diff: only --name-status / --numstat');
      const argv = [...call.sub.split(' '), ...base, ...flags];
      if (call.revs?.length) {
        argv.push('--end-of-options');
        for (const r of call.revs) {
          const s = render(r, known);
          if (typeof s !== 'string') return s;
          argv.push(s);
        }
      }
      if (call.paths?.length) {
        const bad = call.paths.find(badPath);
        if (bad !== undefined) return forbidden(`path ${JSON.stringify(bad)}`);
        argv.push('--', ...call.paths);
      }
      const blocked = o.scan === false ? null : await scan();
      if (blocked) return blocked;
      return exec(argv, call.env);
    },
  };
}

/** ok + exit 0 → stdout; anything else → the failure (an exit ≠ 0 becomes `unknown` with git's first stderr line). */
export function okOut(r: GitResult): { out: string } | GitFailure {
  if (r.kind !== 'ok') return r;
  return r.code === 0 ? { out: r.stdout } : { kind: 'unknown', reason: firstLine(r.stderr) || `git exit ${r.code}` };
}
