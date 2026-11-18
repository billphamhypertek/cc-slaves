// spec v2.7 §5.5-6 (every commit of a lane since `base_sha` carries the trailer `Issue: <key>`), §5.7-3/4 (the revert target
// branch, the trailer commits on it, "not merged yet"). Pure over git (R-B3): every call goes through the read-only runner
// `git/run.ts`; no DB, no session. A git failure is a result, never a throw.
import { gitAt, okOut, type Git, type GitFailure } from '../git/run.ts';
import type { Exec } from '../setup/setup.ts';
import { parseIssueKey, type IssueCommit } from '../../../shared/issues.ts';

const MAIN = 'main';
const short = (sha: string) => sha.slice(0, 7);

function mustKey(key: string): void {
  // R-B4 one parser; the exact form also keeps the key safe inside a `--grep` pattern.
  if (parseIssueKey(key) === null || key !== key.trim()) throw new Error(`issue key ${JSON.stringify(key)}: not T-<n> / B-<n>`);
}

export type IssueCommitsResult =
  | { kind: 'ok'; commits: IssueCommit[] }
  | { kind: 'refused'; missing: string[]; message: string }
  | { kind: 'skipped'; reason: 'no_git' | 'no_base' }
  | GitFailure;

const notRepo = (f: GitFailure) => f.kind === 'unknown' && /not a git repository/i.test(f.reason);

/** The branch checked out in `git.dir`; null when detached. */
async function currentBranch(git: Git): Promise<string | null | GitFailure> {
  const r = await git.run({ sub: 'symbolic-ref', flags: ['--quiet'], revs: [{ fixed: 'HEAD' }] });
  if (r.kind !== 'ok') return r;
  if (r.code === 1) return null;
  const out = okOut(r);
  if (!('out' in out)) return out;
  const ref = out.out.trim();
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

/** R-B2 `base_sha`: HEAD of the lane's cwd when it takes the issue; null outside git (or no commit yet). */
export async function headSha(o: { cwd: string; exec: Exec }): Promise<string | null> {
  const r = okOut(await gitAt(o.cwd, { exec: o.exec }).run({ sub: 'rev-parse', flags: ['--verify', '--quiet'], revs: [{ fixed: 'HEAD' }] }));
  return 'out' in r && r.out.trim() !== '' ? r.out.trim() : null;
}

/** §5.5-6 the Vietnamese refusal: which commits, and the exact command that fixes them on the lane branch. */
function refusal(key: string, missing: string[], head: string, base: string): string {
  const fix = missing.length === 1 && missing[0] === head
    ? `git commit --amend --no-edit --trailer "Issue: ${key}"`
    : `git rebase ${short(base)} --exec 'git commit --amend --no-edit --trailer "Issue: ${key}"'`;
  return `Từ chối issue_done ${key}: ${missing.length} commit thiếu trailer "Issue: ${key}" (${missing.map(short).join(', ')}). `
    + `Sửa trên nhánh lane: \`${fix}\`, rồi gọi lại issue_done.`;
}

/** R-B7 the one trailer match (measured G0-2): a message line exactly `Issue: <key>` — anchored, case-sensitive. */
const grepKey = (key: string) => `--grep=^Issue: ${key}$`;

/**
 * §5.5-6 `git log <baseSha>..HEAD --no-merges` in the lane's cwd: every commit must carry the line `Issue: <key>`
 * (R-B7 `--grep "^Issue: <key>$"`, so `T-46` ≠ `T-460`). R-B2: null `baseSha` or a dir outside git → `skipped`.
 */
export async function checkIssueCommits(o: { cwd: string; baseSha: string | null; key: string; exec: Exec }): Promise<IssueCommitsResult> {
  mustKey(o.key);
  if (o.baseSha === null) return { kind: 'skipped', reason: 'no_base' };
  const git = gitAt(o.cwd, { exec: o.exec });
  const range = [{ range: [{ commit: o.baseSha }, { fixed: 'HEAD' }], dots: '..' }] as const;
  const all = okOut(await git.run({ sub: 'log', flags: ['--no-merges', '--format=%H'], revs: range }));
  if (!('out' in all)) return notRepo(all) ? { kind: 'skipped', reason: 'no_git' } : all;
  const tagged = okOut(await git.run({ sub: 'log', flags: ['--no-merges', '--format=%H', grepKey(o.key)], revs: range }));
  if (!('out' in tagged)) return tagged;
  const lines = (out: string) => out.split('\n').map((x) => x.trim()).filter(Boolean);
  const ok = new Set(lines(tagged.out));
  const rows = lines(all.out).map((sha) => ({ sha, tagged: ok.has(sha) }));
  const missing = rows.filter((x) => !x.tagged).map((x) => x.sha);
  if (missing.length > 0) return { kind: 'refused', missing, message: refusal(o.key, missing, rows[0]!.sha, o.baseSha) };
  const branch = await currentBranch(git);
  if (typeof branch === 'object' && branch !== null) return branch;
  return { kind: 'ok', commits: rows.map((x) => ({ sha: x.sha, branch })) };
}

/** §5.7-3 is `sha` on `branch` (`merge-base --is-ancestor`)? null = git could not tell (unknown branch, not a repo). */
export async function onTarget(o: { cwd: string; exec: Exec; sha: string; branch: string }): Promise<boolean | null> {
  const git = gitAt(o.cwd, { exec: o.exec, branches: [o.branch] });
  const r = await git.run({ sub: 'merge-base', flags: ['--is-ancestor'], revs: [{ commit: o.sha }, { branch: o.branch }] });
  if (r.kind !== 'ok') return null;
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

export type RevertTarget = { kind: 'ok'; branch: string; shas: string[] } | { kind: 'skipped'; reason: 'no_git' } | GitFailure;

/**
 * §5.7-4 the target branch = the spec branch while the spec is not done and the issue's commits are not all on `main`,
 * else `main` (an issue outside a spec: `main`); `shas` = the commits on it whose message has the line `Issue: <key>`
 * (R-B7 `git log --grep "^Issue: <key>$" --no-merges`, newest first) — the numbers IS4 shows before the PO confirms.
 */
export async function revertTarget(o: {
  cwd: string; exec: Exec; key: string; specBranch: string | null; specDone: boolean; shas: readonly string[];
}): Promise<RevertTarget> {
  mustKey(o.key);
  let branch = MAIN;
  if (o.specBranch !== null && !o.specDone) {
    for (const sha of o.shas) {
      const on = await onTarget({ cwd: o.cwd, exec: o.exec, sha, branch: MAIN });
      if (on === null) return { kind: 'unknown', reason: `merge-base ${short(sha)} ${MAIN}` };
      if (!on) { branch = o.specBranch; break; }
    }
  }
  const git = gitAt(o.cwd, { exec: o.exec, branches: [branch] });
  const r = okOut(await git.run({ sub: 'log', flags: ['--no-merges', '--format=%H', grepKey(o.key)], revs: [{ branch }] }));
  if (!('out' in r)) return notRepo(r) ? { kind: 'skipped', reason: 'no_git' } : r;
  return { kind: 'ok', branch, shas: r.out.split('\n').map((s) => s.trim()).filter(Boolean) };
}

export type LaneWork = { kind: 'ok'; branch: string | null; shas: string[] } | GitFailure;

/** §5.7-3 / §4.4 what a `doing` lane did for `key`: its branch and its trailer commits since `base_sha` (newest first).
 * No base / outside git → no commits (R-B2). */
export async function laneWork(o: { cwd: string; baseSha: string | null; key: string; exec: Exec }): Promise<LaneWork> {
  mustKey(o.key);
  if (o.baseSha === null) return { kind: 'ok', branch: null, shas: [] };
  const git = gitAt(o.cwd, { exec: o.exec });
  const range = [{ range: [{ commit: o.baseSha }, { fixed: 'HEAD' }], dots: '..' }] as const;
  const r = okOut(await git.run({ sub: 'log', flags: ['--no-merges', '--format=%H', grepKey(o.key)], revs: range }));
  if (!('out' in r)) return notRepo(r) ? { kind: 'ok', branch: null, shas: [] } : r;
  const branch = await currentBranch(git);
  if (typeof branch === 'object' && branch !== null) return branch;
  return { kind: 'ok', branch, shas: r.out.split('\n').map((s) => s.trim()).filter(Boolean) };
}
