// v2.3 §10.2 the Code fs commands (Mac only): resolve the source, then run the guarded op. E3 wires these to
// `fs_list` / `fs_find` / `fs_read` / `fs_write` with `CodeFsDeps` built from engine state.
import type { FsFindReq, FsFindResult, FsListReq, FsListResult, FsReadReq, FsReadResult, FsWriteReq, FsWriteResult } from '../../../shared/protocol.ts';
import { findFiles, ignoredMatcher, listDir } from './list.ts';
import { checkPath } from './path.ts';
import { classify, readBytes } from './read.ts';
import { resolveSrc, type CodeFsDeps } from './src.ts';
import { writeFile } from './write.ts';

export type { CodeFsDeps, LockState } from './src.ts';

type Req<T> = Omit<T, 'cmd'>;

export function createCodeFs(deps: CodeFsDeps) {
  return {
    async list(q: Req<FsListReq>): Promise<FsListResult> {
      const r = await resolveSrc(deps, q.projectId, q.src);
      return listDir(r.root, q.dir, q.showIgnored, ignoredMatcher(await deps.ignored(r.root)));
    },
    async find(q: Req<FsFindReq>): Promise<FsFindResult> {
      const r = await resolveSrc(deps, q.projectId, q.src);
      return findFiles(r.root, q.query, q.showIgnored, ignoredMatcher(await deps.ignored(r.root)));
    },
    async read(q: Req<FsReadReq>): Promise<FsReadResult> {
      const r = await resolveSrc(deps, q.projectId, q.src);
      const { real } = checkPath(r.root, q.path);
      return classify(real, readBytes(real));
    },
    async write(q: Req<FsWriteReq>): Promise<FsWriteResult> {
      const r = await resolveSrc(deps, q.projectId, q.src);
      return writeFile(r, { cmd: 'fs_write', ...q }, () => deps.lockState(q.projectId));
    },
  };
}
