// v2.3 §10.2 the engine's Code + Git area: the fs layer's deps from engine state (project dir, lane cwd, worktree list,
// ignored list, §5.3 lock input from the live lanes + orchestrators), the Git command context, the `git_log` cache, and
// `code_changed` (a) file tools / (b) fs_write / (c) new commits / (d) Bash — each invalidates the git config scan first.
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { OrchestratorState, Src } from '../../../shared/protocol.ts';
import { ToolWatch } from '../code/changed.ts';
import { createCodeFs, type CodeFsDeps, type LockState } from '../code/fs.ts';
import type { GitCtx } from '../code/git-ctx.ts';
import { GitLog } from '../code/git-log.ts';
import { resolveSrc } from '../code/src.ts';
import { getLane, type Lane } from '../db.ts';
import { KeyedError } from '../errors.ts';
import { gitAt, invalidateGitConfig } from '../git/run.ts';
import { worktrees } from '../git/worktrees.ts';
import type { StreamEvent } from '../stream/parser.ts';
import type { Engine } from '../engine.ts';

const real = (p: string) => { try { return realpathSync.native(p); } catch { return null; } };
const within = (p: string, root: string) => p === root || p.startsWith(root + sep);
const ORCH_FREE: ReadonlySet<OrchestratorState> = new Set(['idle', 'stopped']);

export class CodeArea {
  readonly fs: ReturnType<typeof createCodeFs>;
  readonly log = new GitLog();
  private readonly tools = new ToolWatch();

  constructor(private readonly eng: Engine) {
    this.fs = createCodeFs(this.deps());
  }

  deps(): CodeFsDeps {
    const exec = () => this.eng.gitExec;
    return {
      projectDir: (id) => this.eng.projectRow(id)?.path ?? null,
      laneCwd: (id, name) => getLane(this.eng.db, id, name)?.cwd ?? null,
      worktreeRoots: async (dir) => { const w = await worktrees(gitAt(dir, { exec: exec(), scan: false })); return Array.isArray(w) ? w.map((x) => x.root) : []; },
      ignored: async (root) => {
        const r = await gitAt(root, { exec: exec(), scan: false }).run({ sub: 'ls-files', flags: ['-o', '-i', '--exclude-standard', '--directory', '-z'] });
        return r.kind === 'ok' && r.code === 0 ? r.stdout.split('\0').filter((p) => p !== '') : null;
      },
      lockState: (id) => this.lockState(id),
    };
  }

  /** §5.3 lock input, read right before a write: the project's live lanes and its busiest orchestrator session. */
  lockState(projectId: string): LockState {
    const lanes = this.eng.lanes.list(projectId).map((l) => ({ name: l.name, state: l.state, cwd: l.cwd }));
    const states = this.eng.orchestrators.list(projectId).map((o) => o.view().state).filter((x): x is OrchestratorState => x !== 'done');
    return { lanes, orchestrator: states.find((s) => !ORCH_FREE.has(s)) ?? states[0] ?? null };
  }

  ctx(projectId: string): GitCtx {
    const p = this.eng.projectRow(projectId);
    if (!p) throw new KeyedError('no_project', { key: 'errors.noProject' });
    const lanes = this.eng.db.query<{ name: string; cwd: string }, [string]>('SELECT name, cwd FROM lane WHERE project_id = ? ORDER BY id').all(projectId);
    return { exec: this.eng.gitExec, projectDir: p.path, lanes };
  }

  resolver(projectId: string) { return (src: Src) => resolveSrc(this.deps(), projectId, src); }

  /** §10.2 "thêm khi mở tab Git (cũ hơn 60 s)": the project's lanes in a worktree, measured when stale. */
  async measureStale(projectId: string, lanes: readonly { lane: string }[]): Promise<void> {
    for (const l of lanes) {
      const row: Lane | null = getLane(this.eng.db, projectId, l.lane);
      if (row) await this.eng.branches.measureIfStale(row);
    }
  }

  /**
   * Something changed under `dir` (a session's cwd, a source root): `files` absolute (null = any file). Every source of
   * the project whose root holds the change gets `code_changed`, its paths root-relative.
   */
  changed(projectId: string, dir: string, files: readonly string[] | null): void {
    const p = this.eng.projectRow(projectId);
    if (!p || this.eng.stopped) return;
    const at = real(dir) ?? dir;
    const srcs: { src: Src; root: string }[] = [];
    const base = real(p.path);
    if (base) srcs.push({ src: { kind: 'base' }, root: base });
    for (const l of this.eng.lanes.list(projectId)) {
      const r = real(l.cwd);
      if (r) srcs.push({ src: { kind: 'lane', laneId: l.name }, root: r });
    }
    invalidateGitConfig(p.path);
    for (const s of srcs) {
      if (files === null) {
        if (!within(at, s.root) && !within(s.root, at)) continue;
        invalidateGitConfig(s.root);
        this.eng.broadcast({ type: 'code_changed', projectId, src: s.src });
        continue;
      }
      const paths = files.map((f) => real(f) ?? f).filter((f) => within(f, s.root) && f !== s.root).map((f) => relative(s.root, f).split(sep).join('/'));
      if (paths.length === 0) continue;
      invalidateGitConfig(s.root);
      this.eng.broadcast({ type: 'code_changed', projectId, src: s.src, paths });
    }
  }

  /** (c) a measure saw a new commit on lane `name`'s branch, or on the base (`name` null): that source, any file. */
  committed(projectId: string, name: string | null): void {
    const p = this.eng.projectRow(projectId);
    if (!p || this.eng.stopped) return;
    invalidateGitConfig(p.path);
    this.eng.broadcast({ type: 'code_changed', projectId, src: name === null ? { kind: 'base' } : { kind: 'lane', laneId: name } });
  }

  /** (a) / (d) a lane's or an orchestrator's stream event; `cwd` = the session's dir. */
  stream(projectId: string, session: string, cwd: string, ev: StreamEvent): void {
    for (const t of this.tools.event(session, ev)) this.changed(projectId, cwd, t.files);
  }
}
