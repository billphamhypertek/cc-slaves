// v2.7 the engine's issues / specs area: the snapshot view per project, the coalesced `issue_changed` / `spec_changed`
// push after any store change (one per tick, only what changed), the §5.2-7 spec scan (project open + `spec_scan`, IS16
// first-import line), and the §5.2-10 / §4.10 lookups over real fs / ps / ports (prior sessions, outputs).
import { readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import type { IssueCancelPreview, IssueCancelResult, IssueRow, PriorSession, ProjectIssues, SpecOutput, SpecRow } from '../../../shared/issues.ts';
import { lanesOff } from '../config.ts';
import { getMeta, setMeta } from '../db.ts';
import { CancelRefused, cancelByPo, cancelPreview, type CancelPorts } from '../issues/cancel.ts';
import { IssueCards } from '../issues/cards.ts';
import { getIssueByKey, insertSpec, keepAfterConflict, listSpecs, updateSpec } from '../issues/store.ts';
import { projectIssues, type IssueViewPorts } from '../issues/views.ts';
import { paths } from '../paths.ts';
import { missingPlugin } from '../session/skills.ts';
import { defaultPs } from '../recovery.ts';
import { listOutputs, type PortProbe } from '../specs/outputs.ts';
import { findPriorSessions } from '../specs/prior-sessions.ts';
import { groupSummary, scanSpecs } from '../specs/scan.ts';
import { docDirs, projectWorkflow, readRev, specDocs } from '../workflow/runtime.ts';
import type { Engine } from '../engine.ts';

const HIDDEN = 'hidden';
const importKey = (projectId: string) => `spec_import:${projectId}`;

/** §4.10 the ≤ 300 ms localhost probe: does anything accept a TCP connection there. */
const tcpProbe: PortProbe = (host, port, timeoutMs) => new Promise((resolve) => {
  const s = createConnection({ host, port });
  const done = (ok: boolean) => { clearTimeout(t); s.destroy(); resolve(ok); };
  const t = setTimeout(() => done(false), timeoutMs);
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

/** v2.9 §8 the `docs` folder of a spec's rev; a missing rev (ruling 22:36): the spec file's own folder, never a throw. */
const docsOf = (spec: SpecRow): string => { const w = readRev(spec.workflowRev); return w ? specDocs(w, spec.path) : dirname(spec.path); };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

export class IssuesArea {
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Last pushed JSON per `s:<id>` / `i:<id>`: a flush sends only what differs. */
  private readonly sent = new Map<string, string>();
  private readonly groupCache = new Map<string, { mtime: number; groups: string | null }>();

  readonly cards: IssueCards;

  constructor(private readonly e: Engine, private readonly probe: PortProbe = tcpProbe) {
    this.cards = new IssueCards({ db: e.db, cards: e.cards });
  }

  /** v2.9 §5.8 the first plugin a workflow requires that is not in effect for the project's lanes (lane_start, opening a doc
   *  step), null = all are; the superpowers_off card follows it. */
  missingPlugin(projectId: string, plugins: readonly string[]): string | null {
    const missing = missingPlugin(plugins, lanesOff(this.e.config, projectId));
    this.cards.superpowers(projectId, missing === null);
    return missing;
  }

  // ---------- §5.7 cancel / revert ----------
  private cancelPorts(): CancelPorts {
    const e = this.e;
    return {
      db: e.db, exec: e.gitExec, events: e.issueEvents,
      root: (pid) => { const r = this.root(pid); if (r === null) throw new CancelRefused(`project ${pid} không còn`); return r; },
      // A4 LaneManager.stop awaits the kill / close_stdin effect, which awaits the process exit
      stopLane: async (pid, name) => { if (e.lanes.get(pid, name)) await e.lanes.stop(pid, name, 'now'); },
      finishLane: async (pid, name) => { if (e.lanes.get(pid, name)) await e.lanes.finish(pid, name, true); },
      reverting: (orig) => { this.cards.closeConflict(orig); },
    };
  }

  cancelPreview(projectId: string, key: string): Promise<IssueCancelPreview> { return cancelPreview(this.cancelPorts(), projectId, key); }

  async cancel(projectId: string, key: string, reason: string | null): Promise<IssueCancelResult> {
    try { return await cancelByPo(this.cancelPorts(), projectId, key, reason); } finally { this.changed(projectId); }
  }

  /** §5.7-5 `issue_revert_conflict` landed: the red card + the orchestrator note. */
  revertConflicted(orig: IssueRow, revert: IssueRow, detail: string): void {
    const blocker = this.cards.blocker(orig);
    this.cards.conflict(orig, revert, blocker);
    this.e.issueEvents.revertConflict(orig, revert, detail, blocker?.key ?? null);
    this.changed(orig.projectId);
  }

  /** §5.7-5 "Giữ T-46": the original stays done, nothing is reverted. */
  keep(projectId: string, key: string): void {
    const i = getIssueByKey(this.e.db, projectId, key);
    if (i?.revert !== 'conflict') return; // already answered (Huỷ cả hai confirmed): the card only closes
    this.e.issueEvents.revertKept(keepAfterConflict(this.e.db, i.id));
    this.changed(projectId);
  }

  private root(projectId: string): string | null { return this.e.projectRow(projectId)?.path ?? null; }

  private ports(projectId: string, root: string): IssueViewPorts {
    return {
      lane: (laneId) => {
        const r = this.e.db.query<{ name: string; state: string; phase: string | null }, [number]>('SELECT name, state, phase FROM lane WHERE id = ?').get(laneId);
        if (!r) return null;
        const rt = this.e.lanes.get(projectId, r.name);
        return rt ? { name: r.name, state: rt.state, phase: rt.phase } : r;
      },
      session: (sid) => {
        const r = this.e.db.query<{ title: string | null; ended_at: number | null }, [string]>('SELECT title, ended_at FROM session WHERE id = ?').get(sid);
        if (!r) return null;
        if (r.ended_at !== null || !this.e.orchestrators.bySession(sid)) return { title: r.title, state: 'closed' };
        const asks = this.e.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM card WHERE session_id = ? AND status = 'open' AND kind = 'ask'").get(sid)!.n;
        return { title: r.title, state: asks > 0 ? 'waiting_po' : 'running' };
      },
      exists: (path) => { try { return statSync(join(root, path)).isFile(); } catch { return false; } },
      groups: (path) => {
        const abs = join(root, path);
        try {
          const mtime = statSync(abs).mtimeMs;
          const hit = this.groupCache.get(abs);
          if (hit?.mtime === mtime) return hit.groups;
          const groups = groupSummary(readFileSync(abs, 'utf8'));
          this.groupCache.set(abs, { mtime, groups });
          return groups;
        } catch { return null; }
      },
    };
  }

  /** The snapshot part of one open project; null = no such project. */
  view(projectId: string): ProjectIssues | null {
    const root = this.root(projectId);
    return root === null ? null : projectIssues(this.e.db, projectId, this.ports(projectId, root));
  }

  /** Something of the project's specs / issues (or a lane holding one) may have changed: push at the end of this tick. */
  changed(projectId: string): void {
    if (this.e.stopped) return;
    this.dirty.add(projectId);
    this.timer ??= setTimeout(() => this.flush(), 0);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ids = [...this.dirty];
    this.dirty.clear();
    if (this.e.stopped) return;
    for (const id of ids) {
      const v = this.view(id);
      if (!v) continue;
      this.cards.syncUnseen(id); // §5.6 the issues_new card follows every change
      // no Mac client: forget what was sent, so the first push after a new snapshot never skips a real change
      const live = this.e.hub.macCount > 0;
      for (const spec of v.specs) this.push(`s:${spec.id}`, spec, live, () => this.e.broadcast({ type: 'spec_changed', spec }));
      for (const issue of v.issues) this.push(`i:${issue.id}`, issue, live, () => this.e.broadcast({ type: 'issue_changed', issue }));
    }
  }

  private push(k: string, v: unknown, live: boolean, send: () => void): void {
    if (!live) { this.sent.delete(k); return; }
    const sig = JSON.stringify(v);
    if (this.sent.get(k) === sig) return;
    this.sent.set(k, sig);
    send();
  }

  // ---------- §5.2-7 scan ----------
  /** §5.2-7 import new `<docs>/*.md` of the project's workflow (v2.9 §8), at the doc step owning that folder; follow moved /
   *  renamed files. The first import of a project shows IS16 once. */
  scan(projectId: string): { imported: number; moved: number } {
    const root = this.root(projectId);
    if (root === null) return { imported: 0, moved: 0 };
    const w = projectWorkflow(this.e.db, projectId);
    const r = scanSpecs(root, listSpecs(this.e.db, projectId), docDirs(w), w.docsDone);
    this.e.db.transaction(() => {
      for (const s of r.imports) {
        insertSpec(this.e.db, { projectId, path: s.path, title: s.title, origin: 'imported', state: s.state, outsideBuild: s.outsideBuild, workflowRev: w.rev, step: s.step });
      }
      for (const m of r.moves) updateSpec(this.e.db, m.id, { path: m.to });
    })();
    if (r.imports.length > 0 && getMeta(this.e.db, importKey(projectId)) === null) {
      setMeta(this.e.db, importKey(projectId), String(r.imports.length));
      this.projectChanged(projectId);
    }
    this.changed(projectId);
    return { imported: r.imports.length, moved: r.moves.length };
  }

  /** IS16 the "Đã nhập n spec có sẵn từ docs/specs" line; null = hidden ("Ẩn") or no import yet. */
  importedNotice(projectId: string): number | null {
    const v = getMeta(this.e.db, importKey(projectId));
    return v === null || v === HIDDEN ? null : Number(v);
  }

  hideImported(projectId: string): void {
    setMeta(this.e.db, importKey(projectId), HIDDEN);
    this.projectChanged(projectId);
  }

  private projectChanged(projectId: string): void {
    const pv = this.e.projectView(projectId);
    if (pv) this.e.broadcast({ type: 'project', project: pv });
  }

  // ---------- §5.2-10 / §4.10 lookups ----------
  /** §5.2-10 IS17 candidates: `~/.claude` + every account dir, worktrees of the project, ids cc-slaves owns dropped (R-B8). */
  async priorSessions(projectId: string, specPath: string): Promise<PriorSession[]> {
    const root = this.root(projectId);
    if (root === null) return [];
    const worktrees = (await this.e.code.deps().worktreeRoots(root)).filter((w) => w !== root);
    const claudeHome = paths().claudeHome;
    const owned = this.e.db.query<{ id: string }, []>('SELECT id FROM session').all().map((x) => x.id);
    const ps = this.e.o.ps ?? defaultPs;
    return findPriorSessions({
      claudeHome, projectRoot: root, worktrees, specFile: specPath, now: Date.now(),
      ps: async () => (await ps()).map((p) => p.command),
      configDirs: [...new Set([claudeHome, ...this.e.accounts.map((a) => a.configDir)])], alive, exclude: new Set(owned),
    });
  }

  /** §4.10 the spec's documents; localhost links probed (≤ 300 ms each, in parallel). */
  async outputs(projectId: string, spec: SpecRow): Promise<SpecOutput[]> {
    const root = this.root(projectId);
    if (root === null) return [];
    const rows = this.e.db.query<{ ref: string; label: string | null }, [number]>('SELECT ref, label FROM spec_output WHERE spec_id = ? ORDER BY at, ref').all(spec.id);
    return listOutputs({ root, docs: docsOf(spec), specPath: spec.path, sessionRows: rows, connect: this.probe });
  }
}
