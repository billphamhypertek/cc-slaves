// spec v2.3 §10.2 "Nhánh gốc" (V10): the project's base branch as a LOCAL branch name (refs always `refs/heads/<name>`).
// ① `origin/HEAD` → `refs/remotes/origin/<x>`, used when `refs/heads/<x>` exists; ② else the branch checked out in the project dir;
// ③ detached / none → `none` (the web shows `baseError` "Không xác định được nhánh gốc", §6.1). Never fetches.
import { okOut, type Git, type GitFailure } from './run.ts';

export type BaseBranch = { kind: 'ok'; name: string } | { kind: 'none' } | GitFailure;

/**
 * `symbolic-ref --quiet <ref>` → the target with `prefix` cut off; null when the ref is not symbolic / missing (exit 1)
 * or points elsewhere. Not `--short`: measured, a tag `main` turns `--short HEAD` into `heads/main`.
 */
async function symbolic(git: Git, ref: 'HEAD' | 'refs/remotes/origin/HEAD', prefix: string): Promise<string | null | GitFailure> {
  const r = await git.run({ sub: 'symbolic-ref', flags: ['--quiet'], revs: [{ fixed: ref }] });
  if (r.kind !== 'ok') return r;
  if (r.code === 1) return null;
  const out = okOut(r);
  if (!('out' in out)) return out;
  const t = out.out.trim();
  return t.startsWith(prefix) && t.length > prefix.length ? t.slice(prefix.length) : null;
}

async function hasLocal(git: Git, name: string): Promise<boolean | GitFailure> {
  git.know(name);
  const r = await git.run({ sub: 'rev-parse', flags: ['--verify', '--quiet'], revs: [{ branch: name, peel: 'commit' }] });
  if (r.kind !== 'ok') return r.kind === 'forbidden' ? false : r; // a name git gave us that is not a valid branch name
  if (r.code === 1) return false;
  const out = okOut(r);
  return 'out' in out ? true : out;
}

export async function baseBranch(git: Git): Promise<BaseBranch> {
  const x = await symbolic(git, 'refs/remotes/origin/HEAD', 'refs/remotes/origin/');
  if (typeof x === 'object' && x !== null) return x;
  if (x !== null) {
    const has = await hasLocal(git, x);
    if (typeof has === 'object') return has;
    if (has) return { kind: 'ok', name: x };
  }
  const head = await symbolic(git, 'HEAD', 'refs/heads/');
  if (typeof head === 'object' && head !== null) return head;
  if (head === null) return { kind: 'none' };
  git.know(head);
  return { kind: 'ok', name: head };
}

/** Local commits of `<name>` not on `origin/<name>`; null when that remote ref does not exist (no fetch). */
export async function unpushed(git: Git, name: string): Promise<number | null | GitFailure> {
  git.know(name);
  const has = await git.run({ sub: 'rev-parse', flags: ['--verify', '--quiet'], revs: [{ remote: name }] });
  if (has.kind !== 'ok') return has;
  if (has.code === 1) return null;
  const r = okOut(await git.run({ sub: 'rev-list', flags: ['--count'], revs: [{ range: [{ remote: name }, { branch: name }], dots: '..' }] }));
  return 'out' in r ? Number(r.out.trim()) || 0 : r;
}
