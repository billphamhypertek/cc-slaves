// spec v2.3 §10.2 "Đo trước merge": `merge-tree --write-tree --name-only --no-messages -z` of `refs/heads/<base>` and
// `refs/heads/<branch>`, `-C <project dir>` (attributes read like the real `git merge` there, V24, research §7). Exit 0 →
// clean, exit 1 → the conflicted files; anything else (error, timeout, exit > 1, unparsable, repo running a program) →
// `unknown`, never clean. New objects (merged tree, blobs with markers) go into a temp `GIT_OBJECT_DIRECTORY` with the
// repo's store as alternate; `readMerged` reads merged blobs with the same env, sized first by `ls-tree -l` (a blob over
// `maxBytes` bytes is never read: `null`); the temp dir is always removed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { okOut, type Git, type GitFailure } from './run.ts';

export type MergeTree =
  | { kind: 'clean'; tree: string }
  | { kind: 'conflict'; tree: string; files: string[]; merged?: Record<string, string | null> }
  | GitFailure;

const SHA = /^[0-9a-f]{40}$/;

export async function mergeTree(git: Git, base: string, branch: string, o: { readMerged?: readonly string[]; maxBytes?: number } = {}): Promise<MergeTree> {
  const common = okOut(await git.run({ sub: 'rev-parse', flags: ['--path-format=absolute', '--git-common-dir'] }));
  if (!('out' in common)) return common;
  const objects = join(common.out.trim(), 'objects');
  if (!isAbsolute(objects)) return { kind: 'unknown', reason: 'no object store' };
  const tmp = mkdtempSync(join(tmpdir(), 'ccs-mt-'));
  const env = { GIT_OBJECT_DIRECTORY: tmp, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
  try {
    const r = await git.run({ sub: 'merge-tree', flags: ['--name-only', '--no-messages', '-z'], revs: [{ branch: base }, { branch }], env });
    if (r.kind !== 'ok') return r;
    if (r.code !== 0 && r.code !== 1) return { kind: 'unknown', reason: r.stderr.trim().split('\n')[0] || `git exit ${r.code}` };
    const [tree = '', ...rest] = r.stdout.split('\0');
    if (!SHA.test(tree)) return { kind: 'unknown', reason: 'merge-tree: no tree' };
    if (r.code === 0) return { kind: 'clean', tree };
    const files = [...new Set(rest.filter((p) => p !== ''))];
    const want = (o.readMerged ?? []).filter((p) => files.includes(p));
    if (want.length === 0) return { kind: 'conflict', tree, files };
    const merged: Record<string, string | null> = {};
    for (const path of want) {
      const ls = okOut(await git.run({ sub: 'ls-tree', flags: ['-l', '-z', '--full-tree'], revs: [{ commit: tree }], paths: [path], env }));
      if (!('out' in ls)) return ls;
      const size = /^\d+ blob [0-9a-f]{40} +(\d+)\t/.exec(ls.out)?.[1];
      if (size !== undefined && o.maxBytes !== undefined && Number(size) > o.maxBytes) { merged[path] = null; continue; }
      const b = okOut(await git.run({ sub: 'cat-file', flags: ['blob'], revs: [{ commit: tree, path }], env }));
      if (!('out' in b)) return b;
      merged[path] = b.out;
    }
    return { kind: 'conflict', tree, files, merged };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
