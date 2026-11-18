// v2.3 §10.2 Code + Git commands (Mac only: none is in REMOTE_ALLOWED, §8). Inputs are checked here (shape), the fs
// layer checks sources / paths, the git runner names / commits; the web never sends an absolute path.
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { GitOf, Src } from '../../../shared/protocol.ts';
import { checkPath } from '../code/path.ts';
import { gitBranches } from '../code/git-log.ts';
import { laneBranches } from '../code/git-ctx.ts';
import { gitChanges, gitDiff } from '../code/git-read.ts';
import type { Engine } from '../engine.ts';
import { getLane } from '../db.ts';
import { CommandError, type Handlers } from './router.ts';
import type { Conn } from './ws.ts';

const bad = () => new CommandError('bad_input', { key: 'errors.badTarget' });
const isStr = (v: unknown): v is string => typeof v === 'string';

function src(v: unknown): Src {
  const s = v as Partial<Record<string, unknown>> | null;
  if (s?.kind === 'base') return { kind: 'base' };
  if (s?.kind === 'lane' && isStr(s.laneId)) return { kind: 'lane', laneId: s.laneId };
  throw bad();
}
function of(v: unknown): GitOf {
  const o = v as Partial<Record<string, unknown>> | null;
  if (isStr(o?.branch)) return { branch: o.branch };
  if (isStr(o?.commit)) return { commit: o.commit };
  if (o && 'dirty' in o) return { dirty: src(o.dirty) };
  throw bad();
}
const pid = (v: unknown): string => { if (!isStr(v)) throw bad(); return v; };

/** `spawn` opens VS Code on an absolute path (the v1 helper of `open_in_vscode`). */
type CodeCmd = 'fs_list' | 'fs_find' | 'fs_read' | 'fs_write' | 'git_branches' | 'git_changes' | 'git_diff' | 'git_log' | 'git_watch' | 'open_in_vscode';

export function codeHandlers(e: Engine, conn: Conn, spawn: (path: string) => Promise<void>): Pick<Handlers, CodeCmd> {
  return {
    fs_list: (c) => e.code.fs.list({ projectId: pid(c.projectId), src: src(c.src), dir: isStr(c.dir) ? c.dir : '', showIgnored: c.showIgnored === true }),
    fs_find: (c) => e.code.fs.find({ projectId: pid(c.projectId), src: src(c.src), query: isStr(c.query) ? c.query : '', showIgnored: c.showIgnored === true }),
    fs_read: (c) => { if (!isStr(c.path)) throw bad(); return e.code.fs.read({ projectId: pid(c.projectId), src: src(c.src), path: c.path }); },
    fs_write: async (c) => {
      if (!isStr(c.path) || !isStr(c.text) || !isStr(c.baseHash) || (c.eol !== 'lf' && c.eol !== 'crlf')) throw bad();
      const q = { projectId: pid(c.projectId), src: src(c.src), path: c.path, text: c.text, eol: c.eol, bom: c.bom === true, baseHash: c.baseHash, ...(c.recreate === true ? { recreate: true } : {}) };
      const r = await e.code.fs.write(q);
      if (r.ok) { // (b) fs_write done
        const root = (await e.code.resolver(q.projectId)(q.src)).root;
        e.code.changed(q.projectId, root, [checkPath(root, q.path).real]);
      }
      return r;
    },
    git_branches: async (c) => {
      const projectId = pid(c.projectId);
      return gitBranches(e.code.ctx(projectId), (lane) => {
        const row = getLane(e.db, projectId, lane);
        return row ? e.branches.info(row.id) : null;
      });
    },
    git_changes: (c) => { const projectId = pid(c.projectId); return gitChanges(e.code.ctx(projectId), of(c.of), e.code.resolver(projectId)); },
    git_diff: (c) => {
      const projectId = pid(c.projectId);
      if (!isStr(c.path)) throw bad();
      return gitDiff(e.code.ctx(projectId), c.path, of(c.of), e.code.resolver(projectId));
    },
    git_log: (c) => {
      const projectId = pid(c.projectId);
      if (!Array.isArray(c.refs) || !c.refs.every(isStr) || typeof c.limit !== 'number') throw bad();
      return e.code.log.page(projectId, e.code.ctx(projectId), { refs: c.refs, limit: c.limit, before: isStr(c.before) ? c.before : undefined }, e.hub.gitVisible(projectId));
    },
    git_watch: async (c) => {
      const projectId = pid(c.projectId);
      conn.gitWatch = c.on === true ? projectId : null;
      if (c.on === true) void laneBranches(e.code.ctx(projectId)).then((l) => e.code.measureStale(projectId, l)).catch(() => {});
    },
    open_in_vscode: async (c) => {
      if (!('src' in c)) { // v1 form: an absolute path the Mac UI picked
        if (!isStr(c.path) || !isAbsolute(c.path) || !existsSync(c.path)) throw new CommandError('not_found', { key: 'errors.notFound', params: { path: String(c.path) } });
        return spawn(c.path);
      }
      if (!isStr(c.path)) throw bad();
      const root = (await e.code.resolver(pid(c.projectId))(src(c.src))).root;
      return spawn(checkPath(root, c.path).real); // inside the root, on disk (else forbidden / gone)
    },
  };
}
